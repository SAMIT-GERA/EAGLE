import { randomUUID } from 'node:crypto';
import type { ClaimCheck, DispatchResponse, ToolCall } from '../contracts/types.js';
import type { LLMClient, InvocationTrace } from '../agents/llmClient.js';
import { runPlanner } from '../agents/planner.js';
import { runRecovery } from '../agents/recovery.js';
import { runReviewer } from '../agents/reviewer.js';
import type { GatewayDispatcher } from '../gateway/dispatch.js';
import { GatewayUncertainOutcomeError } from '../gateway/dispatch.js';
import type { InMemoryGrantStore } from '../gateway/grants.js';

export type WorkflowState = 'running' | 'waiting_for_approval' | 'completed' | 'blocked' | 'failed' | 'uncertain';
export type WorkflowTrace = Readonly<{ kind: 'gateway' | 'planner' | 'reviewer' | 'recovery' | 'claim'; summary: string; trace?: InvocationTrace; decision?: string; ruleId?: string }>;
export type WorkflowRun = Readonly<{ runId: string; goal: string; taskId: string; state: WorkflowState; pendingCall?: ToolCall; lastResponse?: DispatchResponse; traces: readonly WorkflowTrace[]; claim?: ClaimCheck }>;

type ClaimVerifier = { verifyClaim(input: unknown): Promise<ClaimCheck> };
type Dependencies = { client: LLMClient; gateway: GatewayDispatcher; grantStore: InMemoryGrantStore; claimVerifier: ClaimVerifier; taskId: string };

function cloneCall(call: ToolCall): ToolCall { return { ...call, args: structuredClone(call.args) }; }
function snapshot(run: WorkflowRun): WorkflowRun { return Object.freeze({ ...run, ...(run.pendingCall ? { pendingCall: cloneCall(run.pendingCall) } : {}), ...(run.lastResponse ? { lastResponse: structuredClone(run.lastResponse) } : {}), traces: Object.freeze(run.traces.map((entry) => Object.freeze({ ...entry }))) }); }
function emailEvidence(value: unknown): { taskId: string; callId: string; canonicalRecipient: string; subjectDigest: string; bodyDigest: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.taskId === 'string' && typeof item.callId === 'string' && typeof item.canonicalRecipient === 'string' && typeof item.subjectDigest === 'string' && typeof item.bodyDigest === 'string'
    ? { taskId: item.taskId, callId: item.callId, canonicalRecipient: item.canonicalRecipient, subjectDigest: item.subjectDigest, bodyDigest: item.bodyDigest } : undefined;
}

/** In-memory, server-owned workflow state. Losing this state on restart fails closed for pending resumes. */
export class AgentWorkflowCoordinator {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly resuming = new Set<string>();
  constructor(private readonly deps: Dependencies) {}

  get(runId: string): WorkflowRun | undefined { const run = this.runs.get(runId); return run && snapshot(run); }
  list(): readonly WorkflowRun[] { return Object.freeze([...this.runs.values()].map(snapshot)); }

  async start(goal: unknown): Promise<WorkflowRun> {
    if (typeof goal !== 'string' || goal.trim().length === 0 || goal.length > 1_000) throw new Error('Invalid workflow goal');
    const active = this.deps.grantStore.resolve(this.deps.taskId).record?.grant;
    if (active === undefined || !active.confirmed) throw new Error('No active confirmed grant is available');
    const runId = randomUUID();
    let run: WorkflowRun = { runId, goal: goal.trim(), taskId: active.taskId, state: 'running', traces: [] };
    const add = (entry: WorkflowTrace) => { run = { ...run, traces: [...run.traces, entry] }; this.runs.set(runId, run); };
    this.runs.set(runId, run);
    let quote: DispatchResponse;
    try { quote = await this.deps.gateway.dispatchToolCall({ taskId: active.taskId, callId: `run-${runId}-quote`, tool: 'read_quote', args: { fileId: 'quote-A' } }); }
    catch { run = { ...run, state: 'blocked' }; add({ kind: 'gateway', summary: 'Initial quote read was denied.' }); return snapshot(run); }
    add({ kind: 'gateway', summary: 'Read quote through TaskGate gateway.', decision: quote.decision.decision, ruleId: quote.decision.ruleId });
    const text = typeof (quote.data as { documentText?: unknown } | undefined)?.documentText === 'string' ? (quote.data as { documentText: string }).documentText.slice(0, 2_000) : '';
    const planner = await runPlanner(this.deps.client, { goal: run.goal, observedQuoteText: [`UNTRUSTED QUOTE TEXT:\n${text}`] });
    add({ kind: 'planner', summary: planner.ok ? 'Planner returned a validated proposal.' : 'Planner failed safely.', trace: planner.trace });
    if (!planner.ok) { run = { ...run, state: 'failed' }; this.runs.set(runId, run); return snapshot(run); }
    if (planner.output.state === 'finish') { run = { ...run, state: 'completed' }; this.runs.set(runId, run); return snapshot(run); }
    const proposal = planner.output.action;
    const call: ToolCall = { taskId: active.taskId, callId: `run-${runId}-action`, tool: proposal.tool, args: structuredClone(proposal.args) };
    const reviewer = await runReviewer(this.deps.client, { goal: run.goal, proposal, untrustedExcerpt: text });
    add({ kind: 'reviewer', summary: reviewer.ok ? reviewer.output.explanation : 'Reviewer failed safely; gateway remains authoritative.', trace: reviewer.trace });
    return this.dispatch(run, call, add);
  }

  async resume(runId: string, approvalId: unknown): Promise<WorkflowRun> {
    const existing = this.runs.get(runId);
    if (existing === undefined || existing.state !== 'waiting_for_approval' || existing.pendingCall === undefined || typeof approvalId !== 'string') throw new Error('Pending workflow run was not found');
    if (this.resuming.has(runId)) throw new Error('Workflow resume is already in progress');
    this.resuming.add(runId);
    try {
      const add = (entry: WorkflowTrace) => { const current = this.runs.get(runId)!; this.runs.set(runId, { ...current, traces: [...current.traces, entry] }); };
      const call = { ...cloneCall(existing.pendingCall), approvalId };
      return await this.dispatch(existing, call, add);
    } finally { this.resuming.delete(runId); }
  }

  private async dispatch(run: WorkflowRun, call: ToolCall, add: (entry: WorkflowTrace) => void): Promise<WorkflowRun> {
    let response: DispatchResponse;
    try { response = await this.deps.gateway.dispatchToolCall(call); }
    catch (error) {
      const uncertain = error instanceof GatewayUncertainOutcomeError;
      const recovery = await runRecovery(this.deps.client, { outcome: uncertain ? 'uncertain' : 'blocked', description: uncertain ? 'Execution outcome is uncertain; do not resend.' : 'Gateway denied the action.' });
      add({ kind: 'recovery', summary: recovery.ok ? recovery.output.reason : 'Recovery failed safely.', trace: recovery.trace });
      const next = { ...this.runs.get(run.runId)!, state: uncertain ? 'uncertain' as const : 'blocked' as const };
      this.runs.set(run.runId, next); return snapshot(next);
    }
    add({ kind: 'gateway', summary: response.decision.reason, decision: response.decision.decision, ruleId: response.decision.ruleId });
    if (response.decision.decision === 'request_approval' && call.approvalId === undefined) {
      const next = { ...this.runs.get(run.runId)!, state: 'waiting_for_approval' as const, pendingCall: cloneCall(call), lastResponse: response };
      this.runs.set(run.runId, next); return snapshot(next);
    }
    let next: WorkflowRun = { ...this.runs.get(run.runId)!, lastResponse: response, state: response.receipt.executionStatus === 'failed' ? 'failed' : response.decision.decision === 'block' ? 'blocked' : 'completed' };
    this.runs.set(run.runId, next);
    if (next.state === 'failed' || next.state === 'blocked') {
      const outcome = next.state === 'failed' ? 'failed' : 'blocked';
      const recovery = await runRecovery(this.deps.client, { outcome, description: response.decision.reason });
      add({ kind: 'recovery', summary: recovery.ok ? recovery.output.reason : 'Recovery failed safely.', trace: recovery.trace });
      next = { ...this.runs.get(run.runId)!, state: outcome };
    }
    const evidence = response.receipt.executionStatus === 'succeeded' ? emailEvidence(response.data) : undefined;
    if (evidence !== undefined) {
      const claim = await this.deps.claimVerifier.verifyClaim({ claimId: `claim-${run.runId}`, taskId: evidence.taskId, callId: evidence.callId, kind: 'email_sent', recipient: evidence.canonicalRecipient, subjectDigest: evidence.subjectDigest, bodyDigest: evidence.bodyDigest });
      add({ kind: 'claim', summary: claim.explanation }); next = { ...this.runs.get(run.runId)!, claim };
    }
    this.runs.set(run.runId, next); return snapshot(next);
  }
}
