import { z } from 'zod';
import { listScenarios } from './agentCases.js';
import type { ScenarioId } from './agentCases.js';
import { normalizeRecords, aggregateMetrics } from './metrics.js';
import type { EvaluationRecord, EvaluationStatus } from './types.js';

const statuses: EvaluationStatus[] = ['passed', 'failed', 'not_run', 'not_implemented', 'insufficient_evidence'];
function counts(values: readonly EvaluationStatus[]): Record<EvaluationStatus, number> {
  return Object.fromEntries(statuses.map((status) => [status, values.filter((value) => value === status).length])) as Record<EvaluationStatus, number>;
}
function caseStatus(values: EvaluationRecord[]): EvaluationStatus {
  if (!values.length) return 'not_run';
  // Conservative historical summary: a later pass never erases recorded failures.
  for (const status of ['failed', 'insufficient_evidence', 'not_implemented', 'not_run'] as const) {
    if (values.some((value) => value.status === status)) return status;
  }
  return 'passed';
}

/** Returns a privacy projection, never internal records, provider text or quote bodies.
 * Caller supplies generation time explicitly for deterministic snapshots.
 */
export function buildEvaluationReport(
  values: readonly EvaluationRecord[], options: { generatedAt: string }
) {
  const generatedAt = z.string().datetime().parse(options.generatedAt);
  const records = normalizeRecords(values);
  const integrated = records.filter((r) => r.scope === 'integrated');
  const synthetic = records.filter((r) => r.scope === 'synthetic_logic');
  const scenarios = listScenarios().map((definition) => {
    const actual = integrated.filter((r) => r.scenarioId === definition.id);
    const fixtures = synthetic.filter((r) => r.scenarioId === definition.id);
    return {
      scenarioId: definition.id, description: definition.description, category: definition.category,
      integratedStatus: caseStatus(actual), syntheticLogicStatus: caseStatus(fixtures),
      integratedExecutionCounts: counts(actual.map((r) => r.status)),
      syntheticExecutionCounts: counts(fixtures.map((r) => r.status)),
      requiredEvidence: definition.requiredEvidence,
      missingEvidence: [...new Set(actual.flatMap((r) => r.missingEvidence))].sort()
    };
  });
  return {
    generatedAt,
    limitations: [
      'Synthetic evaluator tests are not integrated M1–M8 execution proof.',
      'Metadata consistency cannot authenticate a dishonest evidence provider.',
      'Mock-adapter receipts do not prove external mail delivery.',
      'Source availability links are traceability, not causal or isolation proof.',
      'Unknown counters/timings remain unavailable; no security score or ROI is inferred.'
    ],
    scenarioSummary: scenarios,
    counts: {
      integrated: counts(scenarios.map((s) => s.integratedStatus)),
      syntheticLogic: counts(scenarios.map((s) => s.syntheticLogicStatus))
    },
    agentCaseCounts: {
      integrated: counts(scenarios.filter((s) => s.category === 'agent').map((s) => s.integratedStatus)),
      syntheticLogic: counts(scenarios.filter((s) => s.category === 'agent').map((s) => s.syntheticLogicStatus))
    },
    metrics: { integrated: aggregateMetrics(integrated), syntheticLogic: aggregateMetrics(synthetic) },
    executions: records.map((r) => ({
      scenarioId: r.scenarioId, executionId: r.executionId, runId: r.runId ?? null,
      scope: r.scope, status: r.status, integratedQualified: r.integratedQualified, runMode: r.runMode,
      provenance: {
        environment: r.evidence.environment, gateway: r.evidence.provenance.gateway,
        receipts: r.evidence.provenance.receipts,
        models: [...new Set(r.evidence.models.map((m) => m.origin))].sort(),
        adapters: [...new Set(r.evidence.adapters.map((a) => a.origin))].sort()
      },
      observedBehavior: r.observedBehavior, missingEvidence: r.missingEvidence, failures: r.failures,
      unsafeAction: r.unsafeAction,
      modelInvocations: r.evidence.models.map((m) => ({
        invocationId: m.invocationId, runId: m.runId ?? null, role: m.role, origin: m.origin,

        attempts: m.attempts, durationMs: m.durationMs, status: m.status, runMode: m.runMode
      })),
      proposals: r.evidence.proposals,
      decisions: r.evidence.gateways.map((g) => ({
        taskId: g.taskId, callId: g.callId, receiptId: g.receiptId ?? null,
        decision: g.decision, ruleId: g.ruleId, outcome: g.kind, origin: g.origin
      })),
      receiptIds: r.evidence.receipts.map((receipt) => receipt.receiptId),
      sources: r.evidence.sources.map((s) => ({
        sourceId: s.sourceId, sha256: s.sha256, trustLabel: s.trustLabel,
        fileId: s.fileId, callId: s.callId, receiptId: s.receiptId, invocationIds: s.invocationIds
      })),
      claimChecks: r.evidence.claims.map((c) => ({
        claimId: c.check.claimId, verdict: c.check.verdict, matchingReceiptIds: c.check.matchingReceiptIds
      }))
    }))
  };
}
/** UI can ask for one family without inventing executions for the others. */
export const scenarioFamily = (id: ScenarioId) => id.startsWith('M') ? 'agent' : id.startsWith('P') ? 'gateway' : 'v2';
