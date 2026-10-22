import { z } from 'zod';
import { taskGrantSchema } from '../contracts/schemas.js';
import type { RunMode } from '../contracts/types.js';
import type { LLMClient, RoleOptions, RoleResult } from './llmClient.js';
import { runPlanner } from './planner.js';
import { runReviewer } from './reviewer.js';
import { runRecovery } from './recovery.js';
import { proposedActionSchema, runModeSchema, agentWorkflowContextSchema } from './schemas.js';
import type { AgentRole, ProposedAction } from './schemas.js';
import { validateGatewayObservation } from './gatewayBridge.js';
import type { GatewayBridge, GatewayObservation, TrustedGatewayContext } from './gatewayBridge.js';
import { createWorkflowTrace, validateInvocation } from './workflowTrace.js';
import type { AgentTraceEvent, WorkflowStatus } from './workflowTrace.js';

export const WORKFLOW_LIMITS = Object.freeze({ llmInvocations: 12, toolProposals: 6, revisions: 2 });
const limitsSchema = z.object({
  llmInvocations: z.number().int().min(1).max(WORKFLOW_LIMITS.llmInvocations).default(12),
  toolProposals: z.number().int().min(0).max(WORKFLOW_LIMITS.toolProposals).default(6),
  revisions: z.number().int().min(0).max(WORKFLOW_LIMITS.revisions).default(2)
}).strict();
const inputSchema = z.object({
  goal: z.string().min(1).max(1_000), mode: runModeSchema,
  context: z.object({ grant: taskGrantSchema }).strict()
}).strict();
export interface WorkflowInput { goal: string; mode: RunMode; context: TrustedGatewayContext }
export interface WorkflowDependencies { llm: LLMClient; gateway: GatewayBridge }
export interface WorkflowOptions extends RoleOptions {
  limits?: Partial<{ llmInvocations: number; toolProposals: number; revisions: number }>;
}
export type WorkflowReason =
  'planner_finished' | 'human_review_requested' | 'approval_required' |
  'llm_limit' | 'proposal_limit' | 'revision_limit' | 'non_progressing_action' |
  'model_failed' | 'model_metadata_invalid' | 'model_mode_mismatch' |
  'invalid_gateway_observation' | 'gateway_error' | 'uncertain_outcome' |
  'adapter_failed' | 'not_executed' | 'recovery_stopped' | 'recovery_requires_human' | 'aborted';
export interface WorkflowResult {
  runId: string;
  mode: RunMode;
  gatewayKind: GatewayBridge['kind'];
  status: Extract<WorkflowStatus, 'awaiting_human' | 'completed' | 'stopped'>;
  reason: WorkflowReason;
  counts: {
    llmInvocations: number; toolProposals: number; revisions: number;
    gatewaySubmissions: number; reportedHttpAttempts: number | null;
  };
  trace: AgentTraceEvent[];
  observations: GatewayObservation[];
  /** Internal only: contains exact canonical payload. Never serialize to a public route. */
  pending?: Extract<GatewayObservation, { kind: 'request_approval' }>;
  humanReviewProposal?: ProposedAction;
  /** Untrusted planner text, NOT a receipt-backed completion claim. */
  completion?: { summary: string; source: 'untrusted_planner' };
  outcomeUncertain: boolean;
}

// Purpose text is not action identity. Normalize the email fields consistently
// for the replay guard; actual approvals still use canonical.ts and trusted IDs.
function actionKey(action: ProposedAction): string {
  return action.tool === 'read_quote' ?
    JSON.stringify([action.tool, action.args.fileId]) :
    JSON.stringify([action.tool, action.args.recipient.trim().toLowerCase(),
      action.args.subject.replace(/\r\n/g, '\n'), action.args.body.replace(/\r\n/g, '\n')]);
}

/** In-memory bounded orchestration only. No approval resume, authorization,
 * direct adapter calls, runtime fallback or persistent workflow state.
 */
export async function runAgentWorkflow(
  deps: WorkflowDependencies, input: WorkflowInput, options: WorkflowOptions = {}
): Promise<WorkflowResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid workflow input');
  const parsedLimits = limitsSchema.safeParse(options.limits ?? {});
  if (!parsedLimits.success) throw new Error('Invalid workflow limits');
  const limits = parsedLimits.data;
  const kind = z.enum(['taskgate', 'scripted_gateway']).safeParse(deps.gateway.kind);
  if (!kind.success) throw new Error('Invalid gateway bridge kind');
  const { goal, mode, context } = parsed.data;
  const gatewayKind = kind.data;
  const run = createWorkflowTrace(mode);
  const counts = { llmInvocations: 0, toolProposals: 0, revisions: 0,
    gatewaySubmissions: 0, reportedHttpAttempts: 0 as number | null };
  const observations: GatewayObservation[] = [];
  const attemptedActions = new Set<string>();
  const revisedActions = new Set<string>();
  const invocationIds = new Set<string>();
  const receiptIds = new Set<string>();
  const callIds = new Set<string>();
  const quoteTexts = new Map<string, string>();
  let pending: WorkflowResult['pending'];
  let previousAction: ProposedAction | undefined;
  let advice: string | undefined;
  let lastOutcome: GatewayObservation['kind'] | undefined;
  let humanReviewProposal: ProposedAction | undefined;
  let outcomeUncertain = false;
  let modelFailure: WorkflowReason = 'model_failed';
  let feedback: z.infer<typeof agentWorkflowContextSchema>['feedback'] = 'initial';
  // Never send the full grant or authority-bearing IDs to a model.
  const grantSummary = {
    confirmed: context.grant.confirmed,
    approvedFileIds: [...new Set(context.grant.approvedFileIds)].slice(0, 2),
    permittedTools: [...new Set(context.grant.permittedTools)].slice(0, 2),
    eligibleRecipients: [...new Set(context.grant.eligibleRecipients)].slice(0, 4)
  };
  const roleOptions: RoleOptions = {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
  };
  const finish = (
    status: WorkflowResult['status'], reason: WorkflowReason, summary?: string
  ): WorkflowResult => {
    run.transition(status);
    run.add({ role: 'taskgate', source: 'supervisor', eventType: 'workflow_finished',
      summary: reason, runMode: mode });
    return {
      runId: run.runId, mode, gatewayKind, status, reason,
      counts: { ...counts }, trace: run.snapshot(), observations: structuredClone(observations),
      ...(pending ? { pending: structuredClone(pending) } : {}),
      ...(humanReviewProposal ? { humanReviewProposal: structuredClone(humanReviewProposal) } : {}),
      ...(summary === undefined ? {} : { completion: { summary, source: 'untrusted_planner' } }),
      outcomeUncertain
    };
  };
  async function invoke<T>(role: AgentRole, operation: () => Promise<RoleResult<T>>): Promise<T | undefined> {
    if (options.signal?.aborted) { modelFailure = 'aborted'; return; }
    if (counts.llmInvocations >= limits.llmInvocations) { modelFailure = 'llm_limit'; return; }
    counts.llmInvocations++;
    let result: RoleResult<T>;
    try { result = await operation(); }
    catch {
      counts.reportedHttpAttempts = null; // No trustworthy metadata was returned.
      modelFailure = 'model_failed';
      run.add({ role, eventType: 'model_error', source: 'model',
        summary: 'Role failed without invocation metadata.', runMode: mode });
      return;
    }
    try {
      const trace = validateInvocation(result.trace, role);
      if (invocationIds.has(trace.invocationId)) throw new Error('Reused invocation ID');
      invocationIds.add(trace.invocationId);
      if (counts.reportedHttpAttempts !== null) counts.reportedHttpAttempts += trace.attempts;
      const matchingMode = trace.runMode === null || trace.runMode === mode;
      run.add({ role, eventType: trace.attempts === 0 ? 'model_not_sent' : 'model_invocation',
        source: 'model', summary: role + ': ' + trace.status,
        runMode: trace.runMode ?? mode, invocation: trace });
      if (!matchingMode) { modelFailure = 'model_mode_mismatch'; return; }
      if (!result.ok || trace.status !== 'succeeded') { modelFailure = 'model_failed'; return; }
      return result.output;
    } catch {
      counts.reportedHttpAttempts = null;
      modelFailure = 'model_metadata_invalid';
      run.add({ role, eventType: 'model_metadata_invalid', source: 'model',
        summary: 'Invocation metadata rejected.', runMode: mode });
      return;
    }
  }
  const stoppedByModelLimit = (): boolean => modelFailure === 'llm_limit';
  const revise = (): boolean => {
    if (counts.revisions >= limits.revisions) return false;
    counts.revisions++;
    feedback = 'recovery_requested_revision';
    run.transition('planning');
    return true;
  };
  const recover = (outcome: 'blocked' | 'pending' | 'failed' | 'uncertain') =>
    invoke('recovery', () => runRecovery(deps.llm, {
      outcome, description: {
        blocked: 'TaskGate blocked the proposed action. Do not repeat it or evade the deny.',
        pending: 'The exact action awaits human approval. Do not submit it again.',
        failed: 'TaskGate recorded adapter failure. Success is not established.',
        uncertain: 'Dispatch outcome is unconfirmed. Stop; never retry or resend.'
      }[outcome]
    }, roleOptions));

  // Every loop consumes a role invocation; dispatch is separately budgeted.
  while (true) {
    if (options.signal?.aborted) return finish('stopped', 'aborted');
    if (counts.llmInvocations >= limits.llmInvocations) return finish('stopped', 'llm_limit');
    // Do not spend another Planner call that could create an over-budget proposal.
    if (counts.toolProposals >= limits.toolProposals) return finish('stopped', 'proposal_limit');
    const plan = await invoke('planner', () => runPlanner(deps.llm, {
      goal, observedQuoteText: [...quoteTexts.values()].map((text) => text.slice(0, 500)),
      workflowContext: { grantSummary, feedback, previousAction, advice, lastOutcome }
    }, roleOptions));
    if (!plan) return finish('stopped', modelFailure);
    if (plan.state === 'finish') return finish('completed', 'planner_finished', plan.summary);
    if (counts.toolProposals >= limits.toolProposals) return finish('stopped', 'proposal_limit');
    counts.toolProposals++;
    const action = proposedActionSchema.parse(plan.action);
    const key = actionKey(action);
    previousAction = action;
    if (attemptedActions.has(key) || revisedActions.has(key)) return finish('stopped', 'non_progressing_action');

    run.transition('reviewing');
    const review = await invoke('reviewer', () => runReviewer(deps.llm, {
      goal, proposal: action, untrustedExcerpt: [...quoteTexts.values()].join('\n').slice(0, 2_000),
      workflowContext: { grantSummary, feedback }
    }, roleOptions));
    if (!review) return finish('stopped', modelFailure);
    run.add({ role: 'reviewer', source: 'supervisor', eventType: 'review_advice',
      summary: review.recommendation, runMode: mode });
    if (review.recommendation === 'request_human_review') {
      humanReviewProposal = action;
      return finish('awaiting_human', 'human_review_requested');
    }
    if (review.recommendation === 'revise_action') {
      revisedActions.add(key);
      if (!revise()) return finish('stopped', 'revision_limit');
      feedback = 'reviewer_requested_revision';
      advice = review.explanation;
      continue;
    }
    if (options.signal?.aborted) return finish('stopped', 'aborted');
    run.transition('dispatching');
    attemptedActions.add(key);
    counts.gatewaySubmissions++;
    let observation: GatewayObservation;
    let invalid: WorkflowReason = 'gateway_error';
    try {
      const value = await deps.gateway.dispatch(
        structuredClone(action), structuredClone(context), { signal: options.signal }
      );
      invalid = 'invalid_gateway_observation';
      observation = validateGatewayObservation(value, action, context);
      if (callIds.has(observation.callId)) throw new Error('Reused gateway call ID');
      if (observation.receiptId && receiptIds.has(observation.receiptId)) {
        throw new Error('Reused gateway receipt ID');
      }
    } catch {
      // A throwing/invalid bridge may have dispatched already. Never infer failure.
      outcomeUncertain = true;
      run.add({ role: 'taskgate', source: 'gateway', eventType: 'gateway_unconfirmed',
        summary: 'Gateway result unconfirmed; no automatic retry.',
        runMode: gatewayKind === 'scripted_gateway' ? 'scripted_gateway' : mode });
      run.transition('recovering');
      await recover('uncertain');
      return finish('stopped', invalid);
    }
    callIds.add(observation.callId);
    if (observation.receiptId) receiptIds.add(observation.receiptId);
    observations.push(observation);
    lastOutcome = observation.kind;
    run.add({
      role: 'taskgate', source: 'gateway', eventType: 'gateway_observation',
      summary: observation.kind, decision: observation.decision, ruleId: observation.ruleId, callId: observation.callId,
      ...(observation.receiptId ? { receiptId: observation.receiptId } : {}),
      runMode: gatewayKind === 'scripted_gateway' ? 'scripted_gateway' : mode
    });
    if (observation.kind === 'succeeded') {
      if (observation.quote) quoteTexts.set(observation.quote.fileId, observation.quote.documentText);
      feedback = action.tool === 'read_quote' ? 'gateway_read_succeeded' : 'gateway_email_succeeded';
      run.transition('planning');
      continue;
    }
    run.transition('recovering');
    if (observation.kind === 'request_approval') pending = observation;
    if (observation.kind === 'uncertain') outcomeUncertain = true;
    const recovery = await recover(
      observation.kind === 'block' ? 'blocked' :
      observation.kind === 'request_approval' ? 'pending' :
      observation.kind === 'failed' ? 'failed' : 'uncertain'
    );
    // Approval pause and uncertain/failed outcomes cannot be reversed by model text.
    if (!recovery && stoppedByModelLimit()) return finish('stopped', 'llm_limit');
    if (pending) return finish('awaiting_human', 'approval_required');
    if (observation.kind === 'uncertain') return finish('stopped', 'uncertain_outcome');
    if (observation.kind === 'failed') return finish('stopped', 'adapter_failed');
    if (observation.kind === 'not_executed') return finish('stopped', 'not_executed');
    if (!recovery) return finish('stopped', modelFailure);
    if (options.signal?.aborted) return finish('stopped', 'aborted');
    // Conservative MVP: a denied mail proposal is never revised into another send.
    if (action.tool === 'send_clarification_email' || recovery.nextStep === 'stop') {
      return finish('stopped', 'recovery_stopped');
    }
    if (recovery.nextStep === 'wait_for_approval') return finish('awaiting_human', 'recovery_requires_human');
    // Suggested actions are advisory only; a new Planner and Reviewer must run.
    advice = recovery.reason;
    if (!revise()) return finish('stopped', 'revision_limit');
  }
}
