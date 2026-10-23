import { createHash } from 'node:crypto';
import type { WorkflowResult } from '../agents/supervisor.js';
import type { Receipt } from '../contracts/types.js';
import { approvalIdSchema } from '../contracts/schemas.js';
import { validateInvocation } from '../agents/workflowTrace.js';
import { emptyExecution, executionSchema, gatewaySchema, receiptSchema, sourceLinkSchema } from './types.js';
import type { ScenarioExecution } from './types.js';
import { evidenceDigest, gatewayKey } from './evaluator.js';

export type SupplementalEvidence = Partial<Pick<ScenarioExecution,
  'taskId' | 'gateways' | 'adapters' | 'approvals' | 'claims' | 'injection' | 'coverage'>>;
export interface EvaluationReadDependencies {
  /** Read-only snapshots. No dispatch, approval, adapter or model capabilities. */
  readWorkflow(): Promise<WorkflowResult | undefined>;
  readReceipts(): Promise<Receipt[]>;
  readSupplement?(): Promise<SupplementalEvidence>;
}
export interface CollectionOptions {
  scenarioId: ScenarioExecution['scenarioId']; executionId: string;
  environment: ScenarioExecution['environment'];
  provenance: ScenarioExecution['provenance'];
  modelOrigin: 'provider' | 'model_fixture';
  implementation?: 'available' | 'not_implemented';
}

/** Privacy projection: raw adapterOutcome and approval credential are never kept. */
export function projectReceipt(receipt: Receipt, origin: ScenarioExecution['provenance']['receipts']) {
  if (origin === 'unavailable') throw new Error('Receipt provenance unavailable');
  const { adapterOutcome: _outcome, approvalId, ...safe } = receipt;
  return receiptSchema.parse({
    ...safe, origin,
    ...(approvalId ? { approvalIdHash: createHash('sha256')
      .update(approvalIdSchema.parse(approvalId), 'utf8').digest('hex') } : {})
  });
}

export async function collectExecution(
  options: CollectionOptions, deps: EvaluationReadDependencies
): Promise<ScenarioExecution> {
  const e = emptyExecution(options.scenarioId, options.executionId);
  e.environment = options.environment;
  e.provenance = options.provenance;
  if (options.implementation === 'not_implemented') { e.state = 'not_implemented'; return executionSchema.parse(e); }
  // Independent reads run together; each error remains visible and sanitized.
  const reads = await Promise.allSettled([
    deps.readWorkflow(), deps.readReceipts(), deps.readSupplement?.() ?? Promise.resolve({})
  ]);
  let workflow: WorkflowResult | undefined;
  if (reads[0].status === 'rejected') e.collectionErrors.push('workflow_read_failed');
  else workflow = reads[0].value as WorkflowResult | undefined;
  if (reads[1].status === 'rejected') e.collectionErrors.push('receipt_read_failed');
  else for (const receipt of reads[1].value as Receipt[]) {
    try { e.receipts.push(projectReceipt(receipt, options.provenance.receipts)); }
    catch { e.collectionErrors.push('invalid_receipt_evidence'); break; }
  }
  let supplement: SupplementalEvidence = {};
  if (reads[2].status === 'rejected') e.collectionErrors.push('measurement_read_failed');
  else supplement = reads[2].value as SupplementalEvidence;
  try {
    const raw = { ...e, ...supplement, state: 'completed', environment: e.environment,
      scenarioId: e.scenarioId, executionId: e.executionId, provenance: e.provenance };
    const parsed = executionSchema.parse(raw);
    e.taskId = parsed.taskId;
    e.gateways = parsed.gateways;
    e.adapters = parsed.adapters;
    e.approvals = parsed.approvals;
    e.claims = parsed.claims;
    e.injection = parsed.injection;
    e.coverage = parsed.coverage;
  } catch { e.collectionErrors.push('measurement_read_failed'); }
  if (workflow) {
    e.state = 'completed';
    try {
      e.runId = workflow.runId; e.runMode = workflow.mode;
      const start = workflow.trace.find((event) => event.eventType === 'workflow_started');
      const end = workflow.trace.find((event) => event.eventType === 'workflow_finished');
      e.workflow = {
        status: workflow.status, outcomeUncertain: workflow.outcomeUncertain,
        ...(start ? { startedAt: start.timestamp } : {}),
        ...(end ? { endedAt: end.timestamp } : {})
      };
      e.quotations = structuredClone(workflow.quotations);
      e.comparisonDigest = evidenceDigest(workflow.comparison);
      e.taskId ??= workflow.observations[0]?.taskId;
      const origin = workflow.gatewayKind === 'scripted_gateway' ? 'gateway_fixture' : 'integrated_gateway';
      const discovered = workflow.observations.map((g) => {
        const event = workflow.trace.find((event) => event.source === 'gateway' &&
          event.callId === g.callId && event.receiptId === g.receiptId && event.eventType === 'gateway_observation');
        return gatewaySchema.parse({
          origin, taskId: g.taskId, callId: g.callId, grantVersion: g.grantVersion,
          tool: g.tool, kind: g.kind, decision: g.decision, ruleId: g.ruleId,
          ...(g.receiptId ? { receiptId: g.receiptId } : {}),
          ...(event ? { observedAt: event.timestamp } : {})
        });
      });
      for (const gateway of discovered) {
        const enriched = e.gateways.find((g) => gatewayKey(g) === gatewayKey(gateway));
        if (enriched && ['origin', 'taskId', 'callId', 'grantVersion', 'tool', 'kind', 'decision', 'ruleId', 'receiptId']
          .some((key) => enriched[key as keyof typeof enriched] !== gateway[key as keyof typeof gateway])) {
          throw new Error('Conflicting gateway projection');
        }
        if (!enriched) e.gateways.push(gateway);
      }
      let lastPlanner: string | undefined, lastReviewer: string | undefined;
      let lastProposal: ScenarioExecution['proposals'][number] | undefined;
      for (const event of workflow.trace) {
        if (event.runId !== workflow.runId) throw new Error('Wrong trace run');
        if (event.invocation) {
          if (!['planner', 'reviewer', 'recovery'].includes(event.role)) throw new Error('Wrong model role');
          const m = validateInvocation(event.invocation, event.invocation.role);
          if (event.role !== m.role) throw new Error('Wrong model role');
          const { invocationId, role, provider, model, promptVersion, runMode, attempts,
            status, errorCategory, startedAt, endedAt, durationMs } = m;
          e.models.push({
            origin: options.modelOrigin, runId: event.runId, invocationId, role, provider, model,
            promptVersion, runMode, attempts, status, startedAt, endedAt, durationMs,
            ...(errorCategory ? { errorCategory } : {})
          });
          if (m.role === 'planner') lastPlanner = m.invocationId;
          if (m.role === 'reviewer') lastReviewer = m.invocationId;
          if (m.attempts > 0) for (const s of event.sources ?? []) {
            if (!s.evidence.sourceId || !s.evidence.computedSha256 || !s.callId || !s.receiptId) continue;
            const link = sourceLinkSchema.parse({
              fileId: s.fileId, sourceId: s.evidence.sourceId, sha256: s.evidence.computedSha256,
              trustLabel: s.evidence.trustLabel, callId: s.callId, receiptId: s.receiptId,
              invocationIds: [m.invocationId]
            });
            const previous = e.sources.find((x) => x.sourceId === link.sourceId && x.sha256 === link.sha256 &&
              x.callId === link.callId && x.receiptId === link.receiptId);
            if (previous) {
              if (!previous.invocationIds.includes(m.invocationId)) previous.invocationIds.push(m.invocationId);
            } else e.sources.push(link);
          }
        }
        if (event.eventType === 'tool_proposal' && event.proposal && lastPlanner) {
          lastProposal = { invocationId: lastPlanner, tool: event.proposal.tool, argsDigest: event.proposal.argsDigest };
          e.proposals.push(lastProposal);
        }
        if (event.eventType === 'review_advice' && lastProposal && lastReviewer &&
          ['proceed_to_gateway', 'revise_action', 'request_human_review'].includes(event.summary)) {
          // Tie the actual Reviewer advice to the pending proposal, not to a receipt invented by us.
          lastProposal.recommendation = event.summary as 'proceed_to_gateway' | 'revise_action' | 'request_human_review';
          lastProposal.reviewerInvocationId = lastReviewer;
        }
        if (event.eventType === 'gateway_observation' && event.callId && lastProposal) {
          const gateway = e.gateways.find((g) => g.callId === event.callId && g.receiptId === event.receiptId);
          if (!gateway || gateway.tool !== lastProposal.tool) throw new Error('Invalid proposal/gateway correlation');
          lastProposal.callId = gateway.callId;
          lastProposal = undefined;
        }
      }
    } catch { e.collectionErrors.push('invalid_workflow_evidence'); }
  } else if (e.gateways.length || e.receipts.length || e.collectionErrors.length) e.state = 'completed';
  return executionSchema.parse(e);
}
