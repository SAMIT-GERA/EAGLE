import { IncomingMessage, ServerResponse } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import express from 'express';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimCheck, CompletionClaim, Receipt, TaskGrant } from '../src/contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../src/security/canonical.js';
import { createApprovalService } from '../src/security/approvalService.js';
import { registerSecurityRoutes, resetSecurityState } from '../src/security/operatorRoutes.js';
import type { SecurityRouteDependencies } from '../src/security/operatorRoutes.js';

const PIN = 'synthetic-demo-pin-8472';
const BODY_SECRET = 'SYNTHETIC_RAW_MAIL_BODY_API_KEY';
const grant: TaskGrant = {
  taskId: 'demo-task-1', version: 'v1', confirmed: true,
  approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};
const claim: CompletionClaim = {
  claimId: 'claim-1', taskId: grant.taskId, callId: 'email-1', kind: 'email_sent',
  recipient: 'supplier@example.test', subjectDigest: 'a'.repeat(64), bodyDigest: 'b'.repeat(64)
};
const check: ClaimCheck = {
  claimId: claim.claimId, verdict: 'missing_evidence',
  matchingReceiptIds: [], explanation: 'No exact evidence exists.'
};
function pending(callId = 'email-1') {
  return {
    taskId: grant.taskId, callId, recipient: 'supplier@example.test',
    subject: 'SYNTHETIC_PRIVATE_SUBJECT', body: BODY_SECRET
  };
}
function receipt(): Receipt {
  return {
    receiptId: '00000000-0000-4000-8000-000000000001', taskId: grant.taskId,
    callId: 'email-1', tool: 'send_clarification_email', argsDigest: 'c'.repeat(64),
    grantVersion: 'v1', policyVersion: 'policy-v1', decision: 'allow',
    ruleId: 'RULE_EMAIL', approvalId: 'private-approval-id', executionStatus: 'succeeded',
    adapterOutcome: BODY_SECRET, timestamp: '2026-10-22T12:00:00.000Z'
  };
}

// Exercise Express and its real JSON parser in-process using Node request/
// response objects. Socket is unconnected: no server, listener or network port.
function request(
  app: Express, method: string, url: string,
  options: { body?: unknown; raw?: string; headers?: Record<string, string | undefined> } = {}
): Promise<{ status: number; body: unknown; text: string; headers: OutgoingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = url;
    const raw = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
    req.headers = {
      ...(raw ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) } : {}),
      ...options.headers
    };
    const res = new ServerResponse(req);
    res.end = ((chunk?: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      resolve({ status: res.statusCode, body, text, headers: res.getHeaders() });
      res.emit('finish');
      socket.destroy();
      return res;
    }) as typeof res.end;
    req.on('error', reject);
    try {
      app(req, res);
      if (raw) req.push(Buffer.from(raw));
      req.push(null);
    } catch (error) {
      socket.destroy();
      reject(error);
    }
  });
}

describe('secure operator route registration', () => {
  let app: Express;
  let deps: SecurityRouteDependencies;
  const header = { 'x-operator-pin': PIN };
  const approve = { taskId: grant.taskId, callId: 'email-1', operatorPin: PIN };

  beforeEach(() => {
    app = express();
    deps = {
      getOperatorPin: () => PIN,
      approvalService: {
        listPending: vi.fn(async () => [pending()]),
        approvePending: vi.fn(async () => ({
          approvalId: 'approval-1', expiresAt: '2026-10-22T12:03:00.000Z'
        }))
      },
      audit: { listReceipts: vi.fn(async () => [receipt()]) },
      claimVerifier: { verifyClaim: vi.fn(async () => ({ ...check, matchingReceiptIds: [] })) },
      confirmDemoGrant: vi.fn(() => structuredClone(grant)),
      setMockMailMode: vi.fn(),
      checkApprovalEligibility: vi.fn(() => true),
      authorizeClaimRequest: vi.fn(() => true)
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function mount() { registerSecurityRoutes(app, deps); }

  it('mounts on an existing Express app without starting a listener', async () => {
    const listen = vi.spyOn(app, 'listen');
    mount();
    expect(listen).not.toHaveBeenCalled();
    const result = await request(app, 'GET', '/api/receipts', { headers: header });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('rejects accidental duplicate route registration', () => {
    mount();
    expect(() => registerSecurityRoutes(app, deps)).toThrow('already registered');
  });

  it.each([undefined, '', 'wrong-pin'])('rejects grant confirmation with PIN %j', async (operatorPin) => {
    mount();
    const result = await request(app, 'POST', '/api/grant/confirm', { body: { operatorPin } });
    expect(result.status).toBe(401);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
    expect(result.text).not.toContain(PIN);
  });

  it('confirms the grant through the frozen injected callback only after authentication', async () => {
    mount();
    const result = await request(app, 'POST', '/api/grant/confirm', { body: { operatorPin: PIN } });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ grant });
    expect(deps.confirmDemoGrant).toHaveBeenCalledExactlyOnceWith(PIN);
    expect(result.text).not.toContain(PIN);
  });

  it.each([undefined, '', 'wrong-pin'])('rejects approval with PIN %j without reading pending state', async (operatorPin) => {
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: { ...approve, operatorPin } });
    expect(result.status).toBe(401);
    expect(deps.approvalService.listPending).not.toHaveBeenCalled();
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
    expect(deps.checkApprovalEligibility).not.toHaveBeenCalled();
  });

  it('approves only an existing eligible pending action with server-owned attribution', async () => {
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: approve });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ approvalId: 'approval-1', expiresAt: '2026-10-22T12:03:00.000Z' });
    expect(deps.checkApprovalEligibility).toHaveBeenCalledExactlyOnceWith(pending());
    expect(deps.approvalService.approvePending).toHaveBeenCalledExactlyOnceWith({
      taskId: grant.taskId, callId: 'email-1', approvedBy: 'local_operator'
    });
    expect(result.text).not.toContain(PIN);
  });

  it.each([{ taskId: 'unknown-task' }, { callId: 'unknown-call' }])('returns 404 for unknown pending identity %j', async (change) => {
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: { ...approve, ...change } });
    expect(result.status).toBe(404);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
    expect(deps.checkApprovalEligibility).not.toHaveBeenCalled();
  });

  it('does not override a hard deny from the trusted eligibility check', async () => {
    deps.checkApprovalEligibility = vi.fn(() => false);
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: approve });
    expect(result.status).toBe(403);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted eligibility callback is absent', async () => {
    delete deps.checkApprovalEligibility;
    mount();
    expect((await request(app, 'POST', '/api/approve', { body: approve })).status).toBe(503);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it('requires a literal true eligibility result, not truthy runtime data', async () => {
    deps.checkApprovalEligibility = vi.fn().mockResolvedValue('allow');
    mount();
    expect((await request(app, 'POST', '/api/approve', { body: approve })).status).toBe(403);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it.each(['/api/receipts', '/api/pending-approvals'])('rejects unauthenticated sensitive GET %s', async (path) => {
    mount();
    for (const headers of [{}, { 'x-operator-pin': 'wrong' }]) {
      expect((await request(app, 'GET', path, { headers })).status).toBe(401);
    }
    expect(deps.audit.listReceipts).not.toHaveBeenCalled();
    expect(deps.approvalService.listPending).not.toHaveBeenCalled();
  });

  it('returns only redacted receipt metadata, never approval credentials or adapter text', async () => {
    const row = { ...receipt(), body: BODY_SECRET, operatorPin: PIN, stack: 'private-stack' };
    deps.audit.listReceipts = vi.fn(async () => [row]);
    mount();
    const result = await request(app, 'GET', '/api/receipts', { headers: header });
    expect(result.status).toBe(200);
    const { approvalId: _approvalId, ...expected } = receipt();
    expect(result.body).toEqual([{ ...expected, adapterOutcome: 'adapter_succeeded' }]);
    for (const secret of [BODY_SECRET, PIN, 'private-approval-id', 'private-stack']) {
      expect(result.text).not.toContain(secret);
    }
  });

  it('passes a validated optional receipt task filter to the trusted audit reader', async () => {
    mount();
    expect((await request(app, 'GET', '/api/receipts?taskId=demo-task-1', { headers: header })).status).toBe(200);
    expect(deps.audit.listReceipts).toHaveBeenCalledWith(grant.taskId);
  });

  it('redacts recipient, subject and body from the pending list while preserving row keys', async () => {
    mount();
    const result = await request(app, 'GET', '/api/pending-approvals', { headers: header });
    expect(result.status).toBe(200);
    expect(result.body).toEqual([{
      taskId: grant.taskId, callId: 'email-1',
      recipient: '[redacted]', subject: '[redacted]', body: '[redacted]'
    }]);
    for (const secret of [BODY_SECRET, PIN, 'supplier@example.test', pending().subject, 'approval-1']) {
      expect(result.text).not.toContain(secret);
    }
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it('rejects duplicate pending identities rather than choosing an arbitrary one', async () => {
    deps.approvalService.listPending = vi.fn(async () => [pending(), pending()]);
    mount();
    expect((await request(app, 'POST', '/api/approve', { body: approve })).status).toBe(500);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it.each(['invalid', '', 'SUCCEED', null])('rejects invalid mock-mail mode %j', async (mode) => {
    mount();
    expect((await request(app, 'POST', '/api/mock-mail-mode', { body: { mode, operatorPin: PIN } })).status).toBe(400);
    expect(deps.setMockMailMode).not.toHaveBeenCalled();
  });

  it.each(['succeed', 'fail'] as const)('changes mock-mail mode to %s through the injected callback', async (mode) => {
    mount();
    const result = await request(app, 'POST', '/api/mock-mail-mode', { body: { mode, operatorPin: PIN } });
    expect(result.status).toBe(204);
    expect(result.text).toBe('');
    expect(deps.setMockMailMode).toHaveBeenCalledExactlyOnceWith(mode);
  });

  it.each([undefined, 'wrong'])('does not change mock mode with PIN %j', async (operatorPin) => {
    mount();
    expect((await request(app, 'POST', '/api/mock-mail-mode', {
      body: { mode: 'fail', operatorPin }
    })).status).toBe(401);
    expect(deps.setMockMailMode).not.toHaveBeenCalled();
  });

  it('requires a trusted-UI authorizer for claim verification without changing the claim body', async () => {
    delete deps.authorizeClaimRequest;
    mount();
    expect((await request(app, 'POST', '/api/claims/verify', { body: claim })).status).toBe(503);
    expect(deps.claimVerifier.verifyClaim).not.toHaveBeenCalled();
  });

  it('denies claim access when the injected trusted-UI boundary rejects it', async () => {
    deps.authorizeClaimRequest = vi.fn(() => false);
    mount();
    expect((await request(app, 'POST', '/api/claims/verify', { body: claim })).status).toBe(403);
    expect(deps.claimVerifier.verifyClaim).not.toHaveBeenCalled();
  });

  it.each(['supported', 'contradiction', 'missing_evidence'] as const)('returns the exact real verifier %s result', async (verdict) => {
    const result: ClaimCheck = { ...check, verdict };
    deps.claimVerifier.verifyClaim = vi.fn(async () => result);
    mount();
    const response = await request(app, 'POST', '/api/claims/verify', { body: claim });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(deps.claimVerifier.verifyClaim).toHaveBeenCalledExactlyOnceWith(claim);
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
    expect(deps.setMockMailMode).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'other' }, { subjectDigest: 'bad' }, { recipient: 'bad-email' },
    { extra: true }, { operatorPin: PIN }, { receiptId: 'forged' }
  ])('rejects malformed or extra-field claim %j', async (change) => {
    mount();
    expect((await request(app, 'POST', '/api/claims/verify', { body: { ...claim, ...change } })).status).toBe(400);
    expect(deps.claimVerifier.verifyClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/grant/confirm', { operatorPin: PIN, extra: true }],
    ['/api/approve', { ...approve, approvedBy: 'model' }],
    ['/api/approve', { ...approve, body: 'changed payload' }],
    ['/api/mock-mail-mode', { mode: 'fail', operatorPin: PIN, extra: true }]
  ])('rejects unexpected POST fields at %s', async (path, body) => {
    mount();
    expect((await request(app, 'POST', path as string, { body })).status).toBe(400);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
    expect(deps.setMockMailMode).not.toHaveBeenCalled();
  });

  it.each(['/api/grant/confirm', '/api/approve', '/api/mock-mail-mode', '/api/claims/verify'])(
    'sanitizes malformed JSON at %s without reaching callbacks', async (path) => {
      mount();
      const result = await request(app, 'POST', path, { raw: '{"operatorPin":"' + PIN + '",' });
      expect(result.status).toBe(400);
      expect(result.text).not.toContain(PIN);
      expect(result.text).not.toContain('SyntaxError');
      expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
      expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
      expect(deps.setMockMailMode).not.toHaveBeenCalled();
      expect(deps.claimVerifier.verifyClaim).not.toHaveBeenCalled();
    }
  );

  it('rejects oversized JSON bodies with a sanitized 413 response', async () => {
    mount();
    const result = await request(app, 'POST', '/api/grant/confirm', {
      body: { operatorPin: PIN, large: 'x'.repeat(20_000) }
    });
    expect(result.status).toBe(413);
    expect(result.text).not.toContain(PIN);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/grant/confirm', 'confirmDemoGrant'],
    ['/api/mock-mail-mode', 'setMockMailMode'],
    ['/api/approve', 'eligibility'],
    ['/api/claims/verify', 'verifier']
  ])('sanitizes dependency errors for %s', async (path, dependency) => {
    const failure = new Error(PIN + ':' + BODY_SECRET);
    if (dependency === 'confirmDemoGrant') deps.confirmDemoGrant = vi.fn(() => { throw failure; });
    if (dependency === 'setMockMailMode') deps.setMockMailMode = vi.fn(() => { throw failure; });
    if (dependency === 'eligibility') deps.checkApprovalEligibility = vi.fn().mockRejectedValue(failure);
    if (dependency === 'verifier') deps.claimVerifier.verifyClaim = vi.fn().mockRejectedValue(failure);
    mount();
    const body = dependency === 'verifier' ? claim : dependency === 'eligibility' ? approve :
      dependency === 'setMockMailMode' ? { mode: 'fail', operatorPin: PIN } : { operatorPin: PIN };
    const result = await request(app, 'POST', path, { body });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Security service failed' });
    expect(result.text).not.toContain(PIN);
    expect(result.text).not.toContain(BODY_SECRET);
  });

  it.each(['/api/receipts', '/api/pending-approvals'])('sanitizes GET dependency errors at %s', async (path) => {
    const failure = new Error(BODY_SECRET);
    deps.audit.listReceipts = vi.fn().mockRejectedValue(failure);
    deps.approvalService.listPending = vi.fn().mockRejectedValue(failure);
    mount();
    const result = await request(app, 'GET', path, { headers: header });
    expect(result.status).toBe(500);
    expect(result.text).not.toContain(BODY_SECRET);
  });

  it.each([undefined, '', '   '])('fails closed for missing/empty PIN configuration %j', async (value) => {
    deps.getOperatorPin = () => value;
    mount();
    expect((await request(app, 'POST', '/api/grant/confirm', { body: { operatorPin: PIN } })).status).toBe(503);
    expect((await request(app, 'GET', '/api/receipts', { headers: header })).status).toBe(503);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
    expect(deps.audit.listReceipts).not.toHaveBeenCalled();
  });

  it('reads OPERATOR_PIN from the environment when no configuration getter is injected', async () => {
    delete deps.getOperatorPin;
    vi.stubEnv('OPERATOR_PIN', PIN);
    mount();
    expect((await request(app, 'GET', '/api/receipts', { headers: header })).status).toBe(200);
    vi.stubEnv('OPERATOR_PIN', '');
    expect((await request(app, 'GET', '/api/receipts', { headers: header })).status).toBe(503);
  });

  it('does not accept query-string PINs or POST credentials from a header', async () => {
    mount();
    expect((await request(app, 'GET', '/api/receipts?operatorPin=' + PIN)).status).toBe(401);
    expect((await request(app, 'POST', '/api/grant/confirm', {
      headers: header, body: {}
    })).status).toBe(401);
    expect((await request(app, 'GET', '/api/receipts?operatorPin=' + PIN, { headers: header })).status).toBe(400);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
    expect(deps.audit.listReceipts).not.toHaveBeenCalled();
  });

  it('does not share credentials between requests or registered app instances', async () => {
    mount();
    expect((await request(app, 'GET', '/api/receipts', { headers: header })).status).toBe(200);
    expect((await request(app, 'GET', '/api/receipts')).status).toBe(401);
    const other = express();
    registerSecurityRoutes(other, { ...deps, getOperatorPin: () => 'different-pin' });
    expect((await request(other, 'GET', '/api/receipts', { headers: header })).status).toBe(401);
  });

  it('uses the injected shared real approval service and never resets consumed state', async () => {
    const shared = createApprovalService();
    const email = canonicalizeEmail({
      taskId: grant.taskId, callId: 'email-1', tool: 'send_clarification_email',
      args: { recipient: 'supplier@example.test', subject: 'Question', body: BODY_SECRET }
    }, grant);
    const digest = hashEmailAction(email);
    await shared.registerPending(email, digest);
    deps.approvalService = shared;
    mount();
    const first = await request(app, 'POST', '/api/approve', { body: approve });
    const second = await request(app, 'POST', '/api/approve', { body: approve });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const issued = first.body as { approvalId: string; expiresAt: string };
    expect(await shared.validateAndConsume({ email, digest, approvalId: issued.approvalId })).toBe(true);
    await expect(resetSecurityState()).rejects.toThrow('unavailable');
    expect(await shared.validateAndConsume({ email, digest, approvalId: issued.approvalId })).toBe(false);
    expect((await request(app, 'POST', '/api/approve', { body: approve })).status).toBe(404);
  });

  it('does not mutate injected audit state, invoke adapters or register model tools', async () => {
    const original = receipt();
    deps.audit.listReceipts = vi.fn(async () => [Object.freeze(original)]);
    const before = structuredClone(original);
    const external = { recordDecision: vi.fn(), recordOutcome: vi.fn(), adapter: vi.fn(), registerTool: vi.fn() };
    registerSecurityRoutes(app, { ...deps, ...external });
    expect((await request(app, 'GET', '/api/receipts', { headers: header })).status).toBe(200);
    expect(original).toEqual(before);
    for (const operation of Object.values(external)) expect(operation).not.toHaveBeenCalled();
  });

  it('exports an explicit unavailable reset and registers no reset route', async () => {
    mount();
    await expect(resetSecurityState()).rejects.toThrow('Safe coordinated security reset is unavailable');
    expect((await request(app, 'POST', '/api/demo-reset', { body: { operatorPin: PIN } })).status).toBe(404);
    expect(deps.confirmDemoGrant).not.toHaveBeenCalled();
    expect(deps.approvalService.approvePending).not.toHaveBeenCalled();
  });

  it('sanitizes approval issuance errors without returning credentials', async () => {
    deps.approvalService.approvePending = vi.fn().mockRejectedValue(new Error(PIN + BODY_SECRET));
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: approve });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Security service failed' });
    expect(result.text).not.toContain(PIN);
    expect(result.text).not.toContain('approval-1');
  });

  it('sanitizes trusted-UI authorizer errors before invoking the verifier', async () => {
    deps.authorizeClaimRequest = vi.fn().mockRejectedValue(new Error(PIN));
    mount();
    const result = await request(app, 'POST', '/api/claims/verify', { body: claim });
    expect(result.status).toBe(500);
    expect(result.text).not.toContain(PIN);
    expect(deps.claimVerifier.verifyClaim).not.toHaveBeenCalled();
  });

  it('rejects a verifier response for another claim instead of returning it', async () => {
    deps.claimVerifier.verifyClaim = vi.fn(async () => ({ ...check, claimId: 'another-claim' }));
    mount();
    const result = await request(app, 'POST', '/api/claims/verify', { body: claim });
    expect(result.status).toBe(500);
    expect(result.text).not.toContain('another-claim');
  });

  it('rejects unexpected credential response fields instead of serializing secrets', async () => {
    deps.approvalService.approvePending = vi.fn(async () => ({
      approvalId: 'approval-1', expiresAt: '2026-10-22T12:03:00.000Z', operatorPin: PIN
    }));
    mount();
    const result = await request(app, 'POST', '/api/approve', { body: approve });
    expect(result.status).toBe(500);
    expect(result.text).not.toContain(PIN);
    expect(result.text).not.toContain('approval-1');
  });

  it('fails safely when operator PIN configuration retrieval throws', async () => {
    deps.getOperatorPin = () => { throw new Error(PIN); };
    mount();
    const result = await request(app, 'GET', '/api/receipts', { headers: header });
    expect(result.status).toBe(500);
    expect(result.text).not.toContain(PIN);
    expect(deps.audit.listReceipts).not.toHaveBeenCalled();
  });
});
