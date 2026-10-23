import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskGateServer } from '../server.js';
import type { TaskGrant } from '../contracts/types.js';
import { listScenarios } from './agentCases.js';
import { collectExecution } from './collector.js';
import { snapshotCoordinatorRun } from './coordinatorEvidence.js';
import { evaluateExecution } from './evaluator.js';
import { buildEvaluationReport } from './report.js';
import { emptyExecution } from './types.js';

const grant: TaskGrant = { taskId: 'evaluation-task', version: 'evaluation-v1', confirmed: true, approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote'], prohibitedOperations: ['delete'], eligibleRecipients: [], approvalEligibleTools: [] };
const now = () => new Date().toISOString();

/** Offline-only runner. It records unavailable service-level evidence as not_run; it never invents it. */
export async function runDeterministicEvaluation(outputDirectory = 'evaluation-results') {
  const root = await mkdtemp(join(tmpdir(), 'taskgate-evaluation-'));
  const server = await createTaskGateServer({ auditPath: join(root, 'audit.jsonl'), operatorPin: 'evaluation-pin', grantTemplate: grant, llmClient: {
    async invoke(request) { return { ok: true as const, text: JSON.stringify({ state: 'finish', summary: 'offline fixture complete' }), trace: { invocationId: crypto.randomUUID(), provider: 'offline-fixture', model: 'offline-fixture', requestedModel: 'offline-fixture', promptVersion: request.promptVersion, role: request.role, runMode: 'scripted_gateway' as const, attempts: 1, status: 'succeeded' as const, durationMs: 0, startedAt: now(), endedAt: now() } }; }
  } });
  try {
    server.grantStore.create(grant);
    const run = await server.workflows.start('compare quote A and quote B');
    const m1 = await collectExecution({ scenarioId: 'M1', executionId: crypto.randomUUID(), environment: 'observed', provenance: { gateway: 'integrated_gateway', receipts: 'trusted_store' }, modelOrigin: 'model_fixture' }, {
      readWorkflow: async () => snapshotCoordinatorRun(run, server.workflows.evaluationEvents(run.runId)),
      readReceipts: () => server.auditStore.audit.listReceipts()
    });
    const records = [evaluateExecution(m1), ...listScenarios().filter((scenario) => scenario.id !== 'M1').map((scenario) => evaluateExecution(emptyExecution(scenario.id, crypto.randomUUID())))];
    const report = buildEvaluationReport(records, { generatedAt: now() });
    await mkdir(outputDirectory, { recursive: true });
    const path = join(outputDirectory, `deterministic-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return { path, report };
  } finally { await server.close(); }
}

if (process.argv[1]?.endsWith('runDeterministic.ts')) {
  const result = await runDeterministicEvaluation();
  process.stdout.write(`Wrote privacy-safe evaluation report: ${result.path}\n`);
}
