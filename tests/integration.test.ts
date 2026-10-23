import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { TaskGrant, ToolCall } from '../src/contracts/types.js';
import { createTaskGateServer, type ComposedTaskGateServer } from '../src/server.js';

const PIN = 'integration-operator-pin';
const grant: TaskGrant = {
  taskId: 'demo-task', version: 'v1', confirmed: false,
  approvedFileIds: ['quote-A', 'quote-B'],
  permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'],
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};

type Running = { server: ComposedTaskGateServer; url: string; stop(): Promise<void> };

async function start(path?: string): Promise<Running> {
  const root = path === undefined ? await mkdtemp(join(tmpdir(), 'taskgate-integration-')) : undefined;
  const server = await createTaskGateServer({
    grantTemplate: grant,
    operatorPin: PIN,
    auditPath: path ?? join(root!, 'audit.jsonl')
  });
  const listener = createServer(server.app);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
      await server.close();
    }
  };
}

async function request(running: Running, method: string, path: string, body?: unknown, operator = false) {
  const response = await fetch(running.url + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(operator ? { 'x-operator-pin': PIN } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown> };
}

async function confirm(running: Running) {
  expect((await request(running, 'POST', '/api/grant/confirm', { operatorPin: PIN })).status).toBe(200);
}

function email(callId: string, approvalId?: string, body = 'Please confirm the lead time.'): ToolCall {
  return {
    taskId: grant.taskId,
    callId,
    tool: 'send_clarification_email',
    args: { recipient: 'supplier@example.test', subject: 'Clarification', body },
    ...(approvalId === undefined ? {} : { approvalId })
  };
}

async function approve(running: Running, callId: string): Promise<string> {
  const result = await request(running, 'POST', '/api/approve', { taskId: grant.taskId, callId, operatorPin: PIN });
  expect(result.status).toBe(200);
  return result.body!.approvalId as string;
}

describe('real security integration and Express composition', () => {
  it('requires confirmation, then reads the trusted manifest quote and records a durable receipt', async () => {
    const running = await start();
    try {
      expect((await request(running, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: 'quote-1', tool: 'read_quote', args: { fileId: 'quote-A' } })).status).toBe(403);
      await confirm(running);
      const result = await request(running, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: 'quote-1', tool: 'read_quote', args: { fileId: 'quote-A' } });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ decision: { decision: 'allow', ruleId: 'TG-P001' }, receipt: { executionStatus: 'succeeded' }, data: { fileId: 'quote-A' } });
      expect((await request(running, 'GET', '/api/receipts', undefined, true)).body).toHaveLength(2);
    } finally { await running.stop(); }
  });

  it('keeps malicious quote text as untrusted data and cannot change the grant', async () => {
    const running = await start();
    try {
      await confirm(running);
      const result = await request(running, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: 'quote-injection', tool: 'read_quote', args: { fileId: 'quote-B' } });
      expect((result.body!.data as { documentText: string }).documentText).toMatch(/ignore|email|instruction/i);
      expect((await request(running, 'GET', '/api/grant')).body!.grant).toMatchObject({ version: 'v1', approvedFileIds: ['quote-A', 'quote-B'] });
    } finally { await running.stop(); }
  });

  it('permits repeated guided quote reads with fresh IDs and preserves quote-B as untrusted data', async () => {
    const running = await start();
    try {
      await confirm(running);
      const reads = [
        { fileId: 'quote-A', callId: 'quote-a-11111111-1111-4111-8111-111111111111' },
        { fileId: 'quote-B', callId: 'quote-b-22222222-2222-4222-8222-222222222222' },
        { fileId: 'quote-A', callId: 'quote-a-33333333-3333-4333-8333-333333333333' },
        { fileId: 'quote-B', callId: 'quote-b-44444444-4444-4444-8444-444444444444' }
      ] as const;
      for (const read of reads) {
        const result = await request(running, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: read.callId, tool: 'read_quote', args: { fileId: read.fileId } });
        expect(result.body).toMatchObject({ decision: { decision: 'allow', ruleId: 'TG-P001' }, receipt: { executionStatus: 'succeeded' }, data: { fileId: read.fileId } });
        if (read.fileId === 'quote-B') expect((result.body!.data as { documentText: string }).documentText).toMatch(/ignore|email|instruction/i);
      }
    } finally { await running.stop(); }
  });

  it('creates a pending email, approves the exact action, sends once, and verifies the real audit evidence', async () => {
    const running = await start();
    try {
      await confirm(running);
      const pending = await request(running, 'POST', '/api/tool-call', email('mail-success'));
      expect(pending.body).toMatchObject({ decision: { decision: 'request_approval', ruleId: 'TG-A001' }, receipt: { executionStatus: 'not_executed' } });
      expect((await request(running, 'GET', '/api/pending-approvals', undefined, true)).body).toEqual([{ taskId: grant.taskId, callId: 'mail-success', recipient: '[redacted]', subject: '[redacted]', body: '[redacted]' }]);
      const approvalId = await approve(running, 'mail-success');
      const sent = await request(running, 'POST', '/api/tool-call', email('mail-success', approvalId));
      expect(sent.body).toMatchObject({ decision: { decision: 'allow', ruleId: 'TG-P002' }, receipt: { executionStatus: 'succeeded' } });
      expect(running.server.adapters.mockMail.listEvidence()).toHaveLength(1);
      const evidence = running.server.adapters.mockMail.listEvidence()[0];
      const claim = await request(running, 'POST', '/api/claims/verify', {
        claimId: 'claim-success', taskId: grant.taskId, callId: 'mail-success', kind: 'email_sent',
        recipient: evidence.canonicalRecipient, subjectDigest: evidence.subjectDigest, bodyDigest: evidence.bodyDigest
      }, true);
      expect(claim.body).toMatchObject({ verdict: 'supported' });
    } finally { await running.stop(); }
  });

  it('supports repeated guided email workflows with fresh call IDs while retaining replay protection', async () => {
    const running = await start();
    try {
      await confirm(running);
      const first = 'email-11111111-1111-4111-8111-111111111111';
      const second = 'email-22222222-2222-4222-8222-222222222222';

      for (const callId of [first, second]) {
        expect((await request(running, 'POST', '/api/tool-call', email(callId))).body).toMatchObject({
          decision: { decision: 'request_approval', ruleId: 'TG-A001' }, receipt: { executionStatus: 'not_executed' }
        });
        const approvalId = await approve(running, callId);
        expect((await request(running, 'POST', '/api/tool-call', email(callId, approvalId))).body).toMatchObject({
          decision: { decision: 'allow', ruleId: 'TG-P002' }, receipt: { executionStatus: 'succeeded' }
        });
      }

      expect(running.server.adapters.mockMail.listEvidence()).toHaveLength(2);
      const replay = await request(running, 'POST', '/api/tool-call', email(first));
      expect(replay).toMatchObject({ status: 500, body: { error: 'Gateway dispatch failed' } });
      expect((await request(running, 'GET', '/api/pending-approvals', undefined, true)).body).toEqual([]);
    } finally { await running.stop(); }
  });

  it('rejects altered, replayed, stale, and metadata-invalidated approved calls without another send', async () => {
    const running = await start();
    try {
      await confirm(running);
      await request(running, 'POST', '/api/tool-call', email('mail-altered'));
      const approvalId = await approve(running, 'mail-altered');
      const altered = await request(running, 'POST', '/api/tool-call', email('mail-altered', approvalId, 'Altered body'));
      expect(altered.body).toMatchObject({ decision: { decision: 'block', ruleId: 'TG-A002' } });
      expect(running.server.adapters.mockMail.listAttempts()).toHaveLength(0);

      await request(running, 'POST', '/api/tool-call', email('mail-replay'));
      const replayApproval = await approve(running, 'mail-replay');
      expect((await request(running, 'POST', '/api/tool-call', email('mail-replay', replayApproval))).status).toBe(200);
      expect((await request(running, 'POST', '/api/tool-call', email('mail-replay', replayApproval))).status).toBe(409);
      expect(running.server.adapters.mockMail.listAttempts()).toHaveLength(1);

      await request(running, 'POST', '/api/tool-call', email('mail-metadata'));
      running.server.pendingApprovalMetadata.invalidate(grant.taskId, 'mail-metadata');
      expect((await request(running, 'POST', '/api/approve', { taskId: grant.taskId, callId: 'mail-metadata', operatorPin: PIN })).status).toBe(403);
    } finally { await running.stop(); }
  });

  it('fails closed when a grant changes before approval or between approval and dispatch', async () => {
    const before = await start();
    try {
      await confirm(before);
      await request(before, 'POST', '/api/tool-call', email('mail-before-replace'));
      before.server.grantStore.replace({ ...grant, version: 'v2', confirmed: true });
      expect((await request(before, 'POST', '/api/approve', { taskId: grant.taskId, callId: 'mail-before-replace', operatorPin: PIN })).status).toBe(403);
      expect(before.server.adapters.mockMail.listAttempts()).toEqual([]);
    } finally { await before.stop(); }

    const after = await start();
    try {
      await confirm(after);
      await request(after, 'POST', '/api/tool-call', email('mail-after-replace'));
      const approvalId = await approve(after, 'mail-after-replace');
      after.server.grantStore.replace({ ...grant, version: 'v2', confirmed: true });
      const result = await request(after, 'POST', '/api/tool-call', email('mail-after-replace', approvalId));
      expect(result.body).toMatchObject({ decision: { decision: 'block', ruleId: 'TG-A002' } });
      expect(after.server.adapters.mockMail.listAttempts()).toEqual([]);
    } finally { await after.stop(); }
  });

  it('uses task-plus-call duplicate keys while preserving same-task single dispatch', async () => {
    const running = await start();
    try {
      await confirm(running);
      running.server.grantStore.create({ ...grant, taskId: 'other-task', version: 'v1', confirmed: true });
      const sameId = 'shared-call';
      const first = { taskId: grant.taskId, callId: sameId, tool: 'read_quote', args: { fileId: 'quote-A' } };
      const second = { taskId: 'other-task', callId: sameId, tool: 'read_quote', args: { fileId: 'quote-A' } };
      expect((await request(running, 'POST', '/api/tool-call', first)).status).toBe(200);
      expect((await request(running, 'POST', '/api/tool-call', second)).status).toBe(200);
      expect((await request(running, 'POST', '/api/tool-call', first)).status).toBe(409);
    } finally { await running.stop(); }
  });

  it('records definite adapter failures without fabricating success and protects operator endpoints', async () => {
    const running = await start();
    try {
      expect((await request(running, 'GET', '/api/receipts')).status).toBe(401);
      expect((await request(running, 'POST', '/api/claims/verify', { claimId: 'claim-no-auth', taskId: grant.taskId, callId: 'mail-none', kind: 'email_sent', recipient: 'supplier@example.test', subjectDigest: 'a'.repeat(64), bodyDigest: 'b'.repeat(64) })).status).toBe(403);
      await confirm(running);
      expect((await request(running, 'POST', '/api/mock-mail-mode', { mode: 'fail', operatorPin: PIN })).status).toBe(204);
      await request(running, 'POST', '/api/tool-call', email('mail-fail'));
      const approvalId = await approve(running, 'mail-fail');
      const failed = await request(running, 'POST', '/api/tool-call', email('mail-fail', approvalId));
      expect(failed.body).toMatchObject({ decision: { decision: 'allow' }, receipt: { executionStatus: 'failed' } });
      expect(running.server.adapters.mockMail.listEvidence()).toEqual([]);
    } finally { await running.stop(); }
  });

  it('does not execute before audit preflight and reports post-send outcome persistence as uncertain', async () => {
    const preflight = await start();
    try {
      await confirm(preflight);
      await request(preflight, 'POST', '/api/tool-call', email('mail-preflight'));
      const approvalId = await approve(preflight, 'mail-preflight');
      vi.spyOn(preflight.server.auditStore.audit, 'beginDispatch').mockRejectedValueOnce(new Error('synthetic preflight fault'));
      expect((await request(preflight, 'POST', '/api/tool-call', email('mail-preflight', approvalId))).status).toBe(503);
      expect(preflight.server.adapters.mockMail.listAttempts()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await preflight.stop();
    }

    const uncertain = await start();
    try {
      await confirm(uncertain);
      await request(uncertain, 'POST', '/api/tool-call', email('mail-uncertain'));
      const approvalId = await approve(uncertain, 'mail-uncertain');
      vi.spyOn(uncertain.server.auditStore.audit, 'recordOutcome').mockRejectedValueOnce(new Error('synthetic outcome fault'));
      expect((await request(uncertain, 'POST', '/api/tool-call', email('mail-uncertain', approvalId))).status).toBe(503);
      expect(uncertain.server.adapters.mockMail.listEvidence()).toHaveLength(1);
      expect((await request(uncertain, 'POST', '/api/tool-call', email('mail-uncertain', approvalId))).status).toBe(409);
    } finally {
      vi.restoreAllMocks();
      await uncertain.stop();
    }
  });

  it('reproduces the sanitized quote-B failure when a dashboard-refresh-reused call ID conflicts with durable history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskgate-restart-'));
    const path = join(root, 'audit.jsonl');
    const first = await start(path);
    try {
      await confirm(first);
      const firstRead = await request(first, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: 'quote-b-1', tool: 'read_quote', args: { fileId: 'quote-B' } });
      expect(firstRead.status).toBe(200);
      expect((firstRead.body!.data as { documentText: string }).documentText).toMatch(/ignore|email|instruction/i);
    } finally { await first.stop(); }
    const second = await start(path);
    try {
      await confirm(second);
      expect(await request(second, 'POST', '/api/tool-call', { taskId: grant.taskId, callId: 'quote-b-1', tool: 'read_quote', args: { fileId: 'quote-B' } })).toMatchObject({
        status: 500, body: { error: 'Gateway dispatch failed' }
      });
      expect(second.server.adapters.mockMail.listAttempts()).toEqual([]);
      expect((await request(second, 'GET', '/api/receipts', undefined, true)).body).toHaveLength(2);
    } finally { await second.stop(); }
  });
});
