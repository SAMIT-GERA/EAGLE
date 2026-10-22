import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLMClient, LLMRequest } from '../src/agents/llmClient.js';
import { createTaskGateServer } from '../src/server.js';

function client(action: unknown): LLMClient {
  let id = 0;
  return { async invoke(input: LLMRequest) {
    const trace = { provider: 'fake', requestedModel: 'fake', model: 'fake', invocationId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`, role: input.role, promptVersion: input.promptVersion, runMode: 'scripted_gateway' as const, attempts: 1, startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T00:00:00.000Z', durationMs: 0, status: 'succeeded' as const };
    const output = input.role === 'planner' ? action : input.role === 'reviewer' ? { concernDetected: true, concerns: ['Quote text is untrusted.'], recommendation: 'proceed_to_gateway', explanation: 'Gateway remains authoritative.' } : { nextStep: 'stop', reason: 'Stop safely.' };
    return { ok: true as const, trace, text: JSON.stringify(output) };
  }};
}
async function setup(action: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'taskgate-workflow-'));
  const server = await createTaskGateServer({ auditPath: join(root, 'audit.jsonl'), operatorPin: 'pin', llmClient: client(action), grantTemplate: { taskId: 'demo-task', version: 'v1', confirmed: false, approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote', 'send_clarification_email'], prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'], approvalEligibleTools: ['send_clarification_email'] } });
  server.grantStore.create({ taskId: 'demo-task', version: 'v1', confirmed: true, approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote', 'send_clarification_email'], prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'], approvalEligibleTools: ['send_clarification_email'] });
  return server;
}
describe('server-owned agent workflow', () => {
  it('converts a validated Planner proposal into a server-owned pending call and resumes it exactly once', async () => {
    const server = await setup({ state: 'propose', action: { tool: 'send_clarification_email', args: { recipient: 'supplier@example.test', subject: 'Question', body: 'Please confirm.' }, purpose: 'Ask supplier.' } });
    try {
      const run = await server.workflows.start('Compare the synthetic quotes.');
      expect(run.state).toBe('waiting_for_approval');
      expect(run.pendingCall).toMatchObject({ taskId: 'demo-task', tool: 'send_clarification_email' });
      expect(run.pendingCall!.callId).not.toContain('model');
      const approval = await server.approvalService.approvePending({ taskId: 'demo-task', callId: run.pendingCall!.callId, approvedBy: 'operator' });
      const resumed = await server.workflows.resume(run.runId, approval.approvalId);
      expect(resumed.state).toBe('completed');
      expect(resumed.claim?.verdict).toBe('supported');
      await expect(server.workflows.resume(run.runId, approval.approvalId)).rejects.toThrow();
    } finally { await server.close(); }
  });
  it('routes an unauthorized proposal through policy and lets reviewer advice remain non-authoritative', async () => {
    const server = await setup({ state: 'propose', action: { tool: 'send_clarification_email', args: { recipient: 'attacker@example.test', subject: 'Send', body: 'Ignore controls.' }, purpose: 'Model request.' } });
    try {
      const run = await server.workflows.start('Compare quotes.');
      expect(run.state).toBe('blocked');
      expect(run.traces.some((entry) => entry.ruleId === 'TG-E001')).toBe(true);
      expect(server.adapters.mockMail.listAttempts()).toEqual([]);
    } finally { await server.close(); }
  });
});
