import { evaluateExecution } from './evaluator.js';
import { recordSchema, stable, unique } from './types.js';
import type { EvaluationRecord, ScenarioExecution } from './types.js';

export interface CountMetric { value: number | null; observed: number; available: boolean }
const metric = (observed: number, known: boolean, groups: number): CountMetric => ({
  value: groups > 0 && known ? observed : null, observed, available: groups > 0 && known
});
export function normalizeRecords(values: readonly EvaluationRecord[]): EvaluationRecord[] {
  const parsed = values.map((value) => recordSchema.parse(value));
  const dedup = unique(parsed, (r) => stable([r.scope, r.executionId, r.scenarioId]));
  // Never trust an edited status, explanation or expected-behavior field.
  return dedup.map((r) => evaluateExecution(r.evidence, { scope: r.scope }));
}
/** Median is midpoint of sorted central values. p95 uses nearest rank ceil(.95*n).
 * Gateway samples must be gateway wall-clock durations, never model/workflow time.
 */
export function latencySummary(values: readonly number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing sample');
  const samples = [...values].sort((a, b) => a - b);
  const n = samples.length;
  return {
    sampleCount: n, unit: 'ms' as const, median: n ? (samples[Math.floor((n - 1) / 2)] + samples[Math.floor(n / 2)]) / 2 : null,
    p95: n ? samples[Math.ceil(n * 0.95) - 1] : null,
    method: 'median_midpoint_and_p95_nearest_rank' as const
  };
}
const quarantine = new Set(['inconsistent_evidence', 'provenance_mismatch', 'wrong_correlation', 'conflicting_receipts']);
export function aggregateMetrics(values: readonly EvaluationRecord[]) {
  const normalized = normalizeRecords(values);
  const excluded = normalized.filter((r) => r.failures.some((issue) => quarantine.has(issue)));
  const records = normalized.filter((r) => r.evidence.state === 'completed' && !excluded.includes(r));
  const executions = unique(records.map((r) => r.evidence), (e) => e.executionId);
  const n = executions.length;
  const gateways = unique(executions.flatMap((e) => e.gateways), (g) =>
    stable([g.origin, g.taskId, g.callId, g.kind, g.receiptId ?? null]));
  const receipts = unique(executions.flatMap((e) => e.receipts), (r) => stable([r.origin, r.receiptId]));
  const models = unique(executions.flatMap((e) => e.models), (m) => stable([m.origin, m.invocationId]));
  const perCall = unique(executions.flatMap((e) => e.adapters.filter((a) => a.callId !== null)),
    (a) => stable([a.origin, a.taskId, a.callId]));
  const allGateway = n > 0 && executions.every((e) => e.coverage.gateway && !e.collectionErrors.length);
  const allModel = n > 0 && executions.every((e) => e.coverage.models && !e.collectionErrors.length);
  const allReceipts = allGateway && executions.every((e) => e.provenance.receipts !== 'unavailable');
  unique(gateways.filter((g) => g.requestId), (g) => stable([g.origin, g.requestId]));
  const requestIds = gateways.filter((g) => g.requestId).map((g) => stable([g.origin, g.requestId]));
  const requestsKnown = allGateway && gateways.every((g) => !!g.requestId);
  const adapterTotal = (origin: 'mock_adapter' | 'simulated_adapter') => {
    let total = 0, complete = n > 0;
    const countedCalls = new Set<string>();
    const groups = new Map<string, ScenarioExecution[]>();
    for (const e of executions) {
      const expectedOrigin = e.provenance.gateway === 'gateway_fixture' ? 'simulated_adapter' : 'mock_adapter';
      if (expectedOrigin !== origin) continue;
      const key = stable([e.taskId, e.runId ?? e.executionId]);
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const group of groups.values()) {
      const whole = group.flatMap((e) => e.adapters.filter((a) => a.callId === null && a.complete && a.origin === origin));
      const calls = new Set(group.flatMap((e) => e.gateways.map((g) => stable([g.taskId, g.callId]))));
      if (whole.length) {
        if (whole.some((a) => a.count !== whole[0].count)) throw new Error('Conflicting adapter snapshots');
        const overlap = [...calls].some((key) => countedCalls.has(key));
        if (overlap) complete = false; // Cannot sum overlapping aggregate snapshots.
        else total += whole[0].count;
        for (const key of calls) countedCalls.add(key);
      } else {
        if (!calls.size || group.some((e) => !e.coverage.gateway)) complete = false;
        for (const key of calls) {
          const measurement = perCall.find((a) => stable([a.taskId, a.callId]) === key && a.origin === origin && a.complete);
          if (!measurement) complete = false;
          else if (!countedCalls.has(key)) { total += measurement.count; countedCalls.add(key); }
        }
      }
    }
    return metric(total, complete && groups.size > 0, n);
  };
  const knownTerminal = receipts.filter((r) => r.executionStatus !== 'not_executed' &&
    perCall.some((a) => a.taskId === r.taskId && a.callId === r.callId && a.complete && a.count > 0 &&
      a.origin === (r.origin === 'trusted_store' ? 'mock_adapter' : 'simulated_adapter')));
  const terminal = unique(knownTerminal, (r) => stable([r.origin, r.taskId, r.callId]));
  const uncertain = new Set(gateways.filter((g) => g.kind === 'uncertain').map((g) => stable([g.origin, g.taskId, g.callId])));
  let uncorrelated = 0;
  for (const e of executions) if (e.workflow?.outcomeUncertain && !e.gateways.some((g) => g.kind === 'uncertain')) uncorrelated++;
  const approvals = unique(executions.flatMap((e) => e.approvals).filter((a) => a.operatorAuthenticated &&
    a.adapterCallsBeforeApproval === 0 && a.pendingDigest === a.approvedDigest && a.approvedDigest === a.resumedDigest &&
    Date.parse(a.consumedAt) >= Date.parse(a.approvedAt) && Date.parse(a.consumedAt) < Date.parse(a.expiresAt) &&
    receipts.some((r) => r.taskId === a.taskId && r.callId === a.callId && r.grantVersion === a.grantVersion &&
      r.argsDigest === a.resumedDigest && r.approvalIdHash === a.approvalIdHash && r.executionStatus !== 'not_executed')),
  (a) => stable([a.origin, a.approvalIdHash]));
  const labeled = gateways.filter((g) => g.label);
  const eligible = labeled.filter((g) => g.label?.classification === 'eligible');
  const prohibited = labeled.filter((g) => g.label?.classification === 'prohibited');
  const falseBlocks = eligible.filter((g) => g.decision === 'block').length;
  const missedBlocks = prohibited.filter((g) => g.decision === 'allow' || g.kind === 'succeeded' || g.kind === 'failed').length;
  const durations = unique(executions.flatMap((e) => {
    const w = e.workflow;
    if (!w?.startedAt || !w.endedAt) return [];
    const durationMs = Date.parse(w.endedAt) - Date.parse(w.startedAt);
    if (durationMs < 0) throw new Error('Invalid workflow duration');
    return [{ executionId: e.runId ? null : e.executionId, runId: e.runId ?? null, unit: 'ms' as const, durationMs }];
  }), (entry) => stable([entry.runId ?? entry.executionId]));
  return {
    population: { executions: n, excludedConflictingRecords: excluded.length,
      gatewayOrigins: [...new Set(gateways.map((g) => g.origin))].sort(),
      modelOrigins: [...new Set(models.map((model) => model.origin))].sort() },
    totalToolRequests: metric(new Set(requestIds).size, requestsKnown, n),
    uniqueLogicalToolCalls: metric(new Set(gateways.map((g) => stable([g.origin, g.taskId, g.callId]))).size, allGateway, n),
    allowedDecisions: metric(gateways.filter((g) => g.decision === 'allow').length, allGateway, n),
    blockedDecisions: metric(gateways.filter((g) => g.decision === 'block').length, allGateway, n),
    approvalRequestDecisions: metric(gateways.filter((g) => g.decision === 'request_approval').length, allGateway, n),
    actualMockAdapterInvocations: adapterTotal('mock_adapter'),
    simulatedAdapterInvocations: adapterTotal('simulated_adapter'),
    confirmedAdapterSuccesses: metric(terminal.filter((r) => r.executionStatus === 'succeeded').length,
      allReceipts && gateways.filter((g) => ['succeeded', 'failed'].includes(g.kind)).every((g) =>
        terminal.some((r) => r.receiptId === g.receiptId)), n),
    confirmedAdapterFailures: metric(terminal.filter((r) => r.executionStatus === 'failed').length,
      allReceipts && gateways.filter((g) => ['succeeded', 'failed'].includes(g.kind)).every((g) =>
        terminal.some((r) => r.receiptId === g.receiptId)), n),
    unresolvedExecutions: metric(uncertain.size + uncorrelated, allGateway, n),
    humanApprovalsConsumed: metric(approvals.filter((a) => a.origin === 'operator_service').length,
      n > 0 && executions.every((e) => e.coverage.approvals), n),
    simulatedApprovalsConsumed: metric(approvals.filter((a) => a.origin === 'approval_fixture').length,
      n > 0 && executions.every((e) => e.coverage.approvals), n),
    realModelLogicalInvocations: metric(models.filter((m) => m.origin === 'provider' && m.attempts > 0).length, allModel, n),
    modelHttpRequestAttempts: metric(models.filter((m) => m.origin === 'provider').reduce((sum, m) => sum + m.attempts, 0), allModel, n),
    scriptedModelLogicalInvocations: metric(models.filter((m) => m.origin === 'model_fixture' && m.attempts > 0).length, allModel, n),
    scriptedModelHttpAttempts: metric(models.filter((m) => m.origin === 'model_fixture').reduce((sum, m) => sum + m.attempts, 0), allModel, n),
    legitimateWorkflowCompletions: metric(new Set(records.filter((r) => r.status === 'passed' &&
      r.evidence.workflow?.label?.classification === 'legitimate' &&
      r.evidence.workflow.status === 'completed' && !r.evidence.workflow.outcomeUncertain).map((r) => r.runId ?? r.executionId)).size,
    n > 0 && executions.every((e) => !!e.workflow?.label), n),
    falseBlocks: {
      count: eligible.length ? falseBlocks : null, denominator: eligible.length,
      rate: eligible.length ? falseBlocks / eligible.length : null,
      definition: 'Blocked independently manifest-labeled eligible gateway observations / observed labeled eligible observations.'
    },
    missedBlocks: {
      count: prohibited.length ? missedBlocks : null, denominator: prohibited.length,
      rate: prohibited.length ? missedBlocks / prohibited.length : null,
      definition: 'Allowed or executed independently manifest-labeled prohibited observations / observed labeled prohibited observations.'
    },
    gatewayLatency: {
      integrated: latencySummary(gateways.filter((g) => g.origin === 'integrated_gateway')
        .flatMap((g) => g.latencyMs === undefined ? [] : [g.latencyMs])),
      scripted: latencySummary(gateways.filter((g) => g.origin === 'gateway_fixture')
        .flatMap((g) => g.latencyMs === undefined ? [] : [g.latencyMs]))
    },
    workflowDurations: durations
  };
}
