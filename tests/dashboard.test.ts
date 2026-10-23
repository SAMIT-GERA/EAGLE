import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGuidedEmailCall, createGuidedEmailCallId, normalizePendingApprovals, statusClass, statusLabel } from '../public/app.js';
import { createTaskGateServer } from '../src/server.js';

describe('security operations dashboard', () => {
  it('uses accurate user-facing status labels without relabeling pending or uncertain execution', () => {
    expect(statusLabel('request_approval')).toBe('Approval required');
    expect(statusLabel('not_executed')).toBe('Not executed');
    expect(statusLabel('succeeded')).toBe('Executed successfully');
    expect(statusLabel('failed')).toBe('Definite failure');
    expect(statusLabel('uncertain')).toBe('Outcome uncertain');
    expect(statusClass('block')).toBe('block');
  });

  it('does not persist the PIN and uses escaped text rendering for untrusted quote content', async () => {
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('innerHTML');
    expect(source).toContain("$('#quote-output').textContent = result.body.data.documentText");
    expect(source).toContain('Network request failed');
    expect(source).toContain('Outcome is uncertain. Do not resend automatically.');
    expect(source).toContain('response.status === 204');
    expect(source).toContain("api('/api/pending-approvals', { headers: headers(true) })");
    expect(source).toContain("$('#operator-pin').addEventListener('change'");
  });

  it('normalizes the authenticated redacted pending-approval response without exposing email content', () => {
    const row = { taskId: 'demo-task', callId: 'demo-email-1', recipient: '[redacted]', subject: '[redacted]', body: '[redacted]' };
    expect(normalizePendingApprovals([row])).toEqual([row]);
    expect(normalizePendingApprovals(row)).toEqual([row]);
    expect(normalizePendingApprovals({ pending: [row] })).toBeUndefined();
    expect(normalizePendingApprovals([{ taskId: 'demo-task', callId: 'demo-email-1' }])).toBeUndefined();
  });

  it('creates a fresh valid ID for every guided email workflow and preserves it through approval execution', () => {
    const firstId = createGuidedEmailCallId(() => '11111111-1111-4111-8111-111111111111');
    const secondId = createGuidedEmailCallId(() => '22222222-2222-4222-8222-222222222222');
    expect(firstId).toMatch(/^email-[a-f0-9-]{36}$/);
    expect(secondId).not.toBe(firstId);

    const pending = createGuidedEmailCall('demo-task', firstId);
    const approved = createGuidedEmailCall('demo-task', firstId, 'approval-1');
    expect(approved).toMatchObject({ taskId: pending.taskId, callId: pending.callId, tool: pending.tool, approvalId: 'approval-1' });
    expect(() => createGuidedEmailCallId(() => 'model-controlled-id')).toThrow('secure browser-generated call ID');
  });

  it('serves the dashboard assets from the real Express composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskgate-dashboard-'));
    const composed = await createTaskGateServer({
      auditPath: join(root, 'audit.jsonl'),
      operatorPin: 'dashboard-test-pin',
      grantTemplate: {
        taskId: 'dashboard-task', version: 'v1', confirmed: false,
        approvedFileIds: ['quote-A'], permittedTools: ['read_quote', 'send_clarification_email'],
        prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'],
        approvalEligibleTools: ['send_clarification_email']
      }
    });
    const listener = createServer(composed.app);
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      const page = await fetch(url + '/');
      const app = await fetch(url + '/app.js');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Agent Execution Security Protocol');
      expect(app.status).toBe(200);
      expect(await app.text()).toContain('verifyClaim');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
      await composed.close();
    }
  });
});
