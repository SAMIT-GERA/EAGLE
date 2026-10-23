import { createHash } from 'node:crypto';
import type { Receipt } from '../contracts/types.js';
import { approvalIdSchema } from '../contracts/schemas.js';
import type { CoordinatorEvidenceSnapshot } from './coordinatorEvidence.js';
import { emptyExecution, executionSchema, receiptSchema } from './types.js';
import type { ScenarioExecution } from './types.js';

export type SupplementalEvidence = Partial<Pick<ScenarioExecution,
  'taskId' | 'gateways' | 'adapters' | 'approvals' | 'claims' | 'injection' | 'coverage'>>;
export interface EvaluationReadDependencies {
  /** Read-only server snapshots. No dispatch, approval, adapter or model capabilities. */
  readWorkflow(): Promise<CoordinatorEvidenceSnapshot | undefined>;
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

export function projectReceipt(receipt: Receipt, origin: ScenarioExecution['provenance']['receipts']) {
  if (origin === 'unavailable') throw new Error('Receipt provenance unavailable');
  const { adapterOutcome: _outcome, approvalId, ...safe } = receipt;
  return receiptSchema.parse({ ...safe, origin, ...(approvalId ? { approvalIdHash: createHash('sha256')
    .update(approvalIdSchema.parse(approvalId), 'utf8').digest('hex') } : {}) });
}

/** Collects only trusted snapshots; it never invokes models, adapters, dispatch, approval, or claim verification. */
export async function collectExecution(options: CollectionOptions, deps: EvaluationReadDependencies): Promise<ScenarioExecution> {
  const e = emptyExecution(options.scenarioId, options.executionId);
  e.environment = options.environment; e.provenance = options.provenance;
  if (options.implementation === 'not_implemented') { e.state = 'not_implemented'; return executionSchema.parse(e); }
  const reads = await Promise.allSettled([deps.readWorkflow(), deps.readReceipts(), deps.readSupplement?.() ?? Promise.resolve({})]);
  const snapshot = reads[0].status === 'fulfilled' ? reads[0].value : undefined;
  if (reads[0].status === 'rejected') e.collectionErrors.push('workflow_read_failed');
  if (reads[1].status === 'rejected') e.collectionErrors.push('receipt_read_failed');
  else for (const receipt of reads[1].value) {
    try { e.receipts.push(projectReceipt(receipt, options.provenance.receipts)); }
    catch { e.collectionErrors.push('invalid_receipt_evidence'); break; }
  }
  const supplement = reads[2].status === 'fulfilled' ? reads[2].value : undefined;
  if (reads[2].status === 'rejected') e.collectionErrors.push('measurement_read_failed');
  const run = snapshot?.run;
  if (run) {
    e.state = 'completed'; e.runId = run.runId; e.taskId = run.taskId;
    e.workflow = { status: run.state === 'completed' ? 'completed' : run.state === 'waiting_for_approval' ? 'awaiting_human' : 'stopped', outcomeUncertain: run.state === 'uncertain' };
    for (const entry of run.traces) if (entry.trace) {
      const trace = entry.trace;
      e.models.push({ origin: options.modelOrigin, runId: run.runId, invocationId: trace.invocationId, role: trace.role,
        provider: trace.provider, model: trace.model, promptVersion: trace.promptVersion, runMode: trace.runMode,
        attempts: trace.attempts, status: trace.status, startedAt: trace.startedAt, endedAt: trace.endedAt, durationMs: trace.durationMs,
        ...(trace.errorCategory ? { errorCategory: trace.errorCategory } : {}) });
    }
  }
  const supplied = { ...(snapshot ?? {}), ...(supplement ?? {}) };
  if (supplied.gateways) e.gateways = structuredClone(supplied.gateways);
  if (supplied.adapters) e.adapters = structuredClone(supplied.adapters);
  if (supplied.approvals) e.approvals = structuredClone(supplied.approvals);
  if (supplied.claims) e.claims = structuredClone(supplied.claims);
  if (supplied.injection) e.injection = structuredClone(supplied.injection);
  if (supplied.coverage) e.coverage = structuredClone(supplied.coverage);
  if (!run && (e.gateways.length || e.receipts.length || e.collectionErrors.length)) e.state = 'completed';
  return executionSchema.parse(e);
}
