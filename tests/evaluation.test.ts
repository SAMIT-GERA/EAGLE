import { describe, expect, it, vi } from 'vitest';
import { createTaskGateServer } from '../src/server.js';
import { collectExecution, projectReceipt } from '../src/evaluation/collector.js';
import { snapshotCoordinatorRun } from '../src/evaluation/coordinatorEvidence.js';
import { evaluateExecution } from '../src/evaluation/evaluator.js';
import { emptyExecution } from '../src/evaluation/types.js';

const grant = { taskId: 'evaluation-task', version: 'v1', confirmed: true, approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote'] as Array<'read_quote'>, prohibitedOperations: ['delete'], eligibleRecipients: [], approvalEligibleTools: [] };
const options = { scenarioId: 'M1' as const, executionId: 'evaluation-run', environment: 'observed' as const, provenance: { gateway: 'integrated_gateway' as const, receipts: 'trusted_store' as const }, modelOrigin: 'model_fixture' as const };

describe('evaluation library with the authoritative coordinator', () => {
  it('collects a real coordinator snapshot without dispatching, emailing, or networking', async () => {
    const server = await createTaskGateServer({ grantTemplate: grant, operatorPin: 'pin', llmClient: { invoke: vi.fn(async (request) => ({ ok: true, text: JSON.stringify({ state: 'finish', summary: 'done' }), trace: { invocationId: '00000000-0000-4000-8000-000000000002', provider: 'fixture', model: 'fixture', requestedModel: 'fixture', promptVersion: request.promptVersion, role: request.role, runMode: 'scripted_gateway', attempts: 1, status: 'succeeded', durationMs: 0, startedAt: '2026-10-24T00:00:00.000Z', endedAt: '2026-10-24T00:00:00.000Z' } })) } });
    try {
      server.grantStore.create(grant);
      const run = await server.workflows.start('compare quote A and quote B');
      const dispatch = vi.spyOn(server.dispatcher, 'dispatchToolCall');
      const collected = await collectExecution(options, {
        readWorkflow: async () => snapshotCoordinatorRun(run),
        readReceipts: () => server.auditStore.audit.listReceipts()
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(server.adapters.mockMail.listAttempts()).toEqual([]);
      expect(collected.runId).toBe(run.runId);
      expect(evaluateExecution(collected).integratedQualified).toBe(false);
    } finally { await server.close(); }
  });

  it('projects receipts without credentials or adapter outcomes and rejects absent evidence conservatively', async () => {
    const receipt = { receiptId: '00000000-0000-4000-8000-000000000001', taskId: 'task', callId: 'call', tool: 'read_quote', argsDigest: 'a'.repeat(64), grantVersion: 'v1', policyVersion: 'v1', ruleId: 'TG-P001', decision: 'allow' as const, executionStatus: 'succeeded' as const, adapterOutcome: 'secret', timestamp: '2026-10-24T00:00:00.000Z' };
    expect(JSON.stringify(projectReceipt(receipt, 'trusted_store'))).not.toContain('secret');
    const value = emptyExecution('M4', 'missing'); value.state = 'completed'; value.taskId = 'task'; value.provenance = { gateway: 'integrated_gateway', receipts: 'trusted_store' }; value.coverage = { gateway: true, models: true, proposals: true, approvals: false };
    expect(evaluateExecution(value).status).toBe('insufficient_evidence');
  });
});
