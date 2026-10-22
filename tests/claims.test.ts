import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEmail, CompletionClaim, EmailDispatchEvidence, Receipt, SecurityDependencies, TaskGrant, ToolCall } from '../src/contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../src/security/canonical.js';
import { createReceiptStore } from '../src/audit/receiptStore.js';
import { createClaimVerifier } from '../src/audit/claimVerifier.js';
import type { ClaimVerifierDependencies } from '../src/audit/claimVerifier.js';

type Store = Awaited<ReturnType<typeof createReceiptStore>>;
type DecisionInput = Parameters<SecurityDependencies['audit']['recordDecision']>[0];

const grant: TaskGrant = {
  taskId: 'demo-task-1', version: 'v1', confirmed: true,
  approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};
function decision(kind: 'allow' | 'block' | 'request_approval' = 'allow', callId = 'email-1'): DecisionInput {
  const call: ToolCall = {
    callId, taskId: grant.taskId, tool: 'send_clarification_email',
    args: { recipient: 'supplier@example.test', subject: 'Question', body: 'SYNTHETIC_BODY_SECRET\n' }
  };
  const email = canonicalizeEmail(call, grant);
  return {
    call, grant: structuredClone(grant), email, argsDigest: hashEmailAction(email),
    decision: { callId, grantVersion: grant.version, decision: kind, ruleId: 'RULE_EMAIL', reason: 'Policy result' }
  };
}
function claimFor(email: CanonicalEmail = decision().email!): CompletionClaim {
  return {
    claimId: 'claim-1', taskId: email.taskId, callId: email.callId,
    kind: 'email_sent', recipient: email.recipient,
    subjectDigest: createHash('sha256').update(email.subject, 'utf8').digest('hex'),
    bodyDigest: createHash('sha256').update(email.body, 'utf8').digest('hex')
  };
}
function dispatch(receipt: Receipt) {
  return { callId: receipt.callId, taskId: receipt.taskId, tool: receipt.tool };
}

describe('structured email completion claims', () => {
  let root: string;
  let path: string;
  let store: Store;
  let file: FileHandle;
  let verify: ReturnType<typeof createClaimVerifier>['verifyClaim'];
  let closed: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'taskgate-claims-test-'));
    path = join(root, 'audit.jsonl');
    store = await createReceiptStore({
      path, policyVersion: 'policy-v1',
      openFile: async (name) => { file = await open(name, 'a+', 0o600); return file; }
    });
    closed = false;
    verify = createClaimVerifier(store).verifyClaim;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!closed) await store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('taskgate-claims-test-')) {
      throw new Error('Refusing unsafe temporary-directory cleanup');
    }
    await rm(root, { recursive: true, force: true });
  });

  function dependencies(overrides: Partial<ClaimVerifierDependencies> = {}): ClaimVerifierDependencies {
    return {
      audit: { listReceipts: store.audit.listReceipts },
      findEmailEvidence: store.findEmailEvidence,
      listUnresolvedDispatches: store.listUnresolvedDispatches,
      ...overrides
    };
  }

  async function terminal(status: 'succeeded' | 'failed', callId = 'email-1', pending = false) {
    const request = decision('allow', callId);
    if (pending) await store.audit.recordDecision(decision('request_approval', callId));
    const preliminary = await store.audit.recordDecision(request);
    await store.audit.beginDispatch(dispatch(preliminary));
    const receipt = await store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status, adapterOutcome: 'Trusted adapter observation'
    });
    return { request, preliminary, receipt, claim: claimFor(request.email!) };
  }

  it.each(['succeeded', 'failed'] as const)('verifies an exact terminal %s outcome', async (status) => {
    const { claim, preliminary, receipt } = await terminal(status);
    const result = await verify(claim);
    expect(result).toEqual({
      claimId: claim.claimId, verdict: status === 'succeeded' ? 'supported' : 'contradiction',
      matchingReceiptIds: [preliminary.receiptId, receipt.receiptId].sort(),
      explanation: expect.any(String)
    });
    expect(Object.keys(result).sort()).toEqual(['claimId', 'explanation', 'matchingReceiptIds', 'verdict']);
  });

  it.each(['block', 'request_approval'] as const)('contradicts an exact %s action without dispatch', async (kind) => {
    const receipt = await store.audit.recordDecision(decision(kind));
    const result = await verify(claimFor());
    expect(result.verdict).toBe('contradiction');
    expect(result.matchingReceiptIds).toEqual([receipt.receiptId]);
    expect(result.explanation).toContain('within TaskGate');
  });

  it('returns missing_evidence for a valid unknown claim', async () => {
    expect(await verify(claimFor())).toMatchObject({ verdict: 'missing_evidence', matchingReceiptIds: [] });
  });

  it.each<Partial<CompletionClaim>>([
    { recipient: 'other@example.test' }, { subjectDigest: 'a'.repeat(64) },
    { bodyDigest: 'b'.repeat(64) }, { taskId: 'another-task' }, { callId: 'another-call' }
  ])('does not borrow successful evidence for changed claim %j', async (change) => {
    const { claim } = await terminal('succeeded');
    expect(await verify({ ...claim, ...change })).toMatchObject({ verdict: 'missing_evidence', matchingReceiptIds: [] });
  });

  it('does not borrow an earlier successful call for a later failed call', async () => {
    const first = await terminal('succeeded', 'email-1');
    const second = await terminal('failed', 'email-2');
    expect((await verify(first.claim)).verdict).toBe('supported');
    const result = await verify(second.claim);
    expect(result.verdict).toBe('contradiction');
    expect(result.matchingReceiptIds).not.toContain(first.receipt.receiptId);
    expect(result.matchingReceiptIds).not.toContain(first.preliminary.receiptId);
  });

  it.each(['succeeded', 'failed'] as const)('gives terminal %s precedence over earlier pending records', async (status) => {
    const { claim, receipt } = await terminal(status, 'email-1', true);
    const result = await verify(claim);
    expect(result.verdict).toBe(status === 'succeeded' ? 'supported' : 'contradiction');
    expect(result.matchingReceiptIds).toContain(receipt.receiptId);
    expect(result.matchingReceiptIds).toHaveLength(3);
  });

  it('never supports preliminary allow without a terminal outcome', async () => {
    await store.audit.recordDecision(decision('request_approval'));
    await store.audit.recordDecision(decision('allow'));
    expect(await verify(claimFor())).toMatchObject({ verdict: 'missing_evidence' });
  });

  it('returns missing evidence for unresolved dispatch despite an earlier pending receipt', async () => {
    await store.audit.recordDecision(decision('request_approval'));
    const preliminary = await store.audit.recordDecision(decision('allow'));
    await store.audit.beginDispatch(dispatch(preliminary));
    const result = await verify(claimFor());
    expect(result.verdict).toBe('missing_evidence');
    expect(result.explanation).toContain('uncertain');
  });

  it('does not convert a terminal persistence failure into supported or contradiction', async () => {
    await store.audit.recordDecision(decision('request_approval'));
    const preliminary = await store.audit.recordDecision(decision('allow'));
    await store.audit.beginDispatch(dispatch(preliminary));
    vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('SYNTHETIC_STORAGE_SECRET'));
    await expect(store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'sent'
    })).rejects.toThrow('not durably confirmed');
    const result = await verify(claimFor());
    expect(result.verdict).toBe('missing_evidence');
    expect(result.explanation).not.toContain('SYNTHETIC_STORAGE_SECRET');
  });

  it('preserves unresolved uncertainty after reopening the real store', async () => {
    const preliminary = await store.audit.recordDecision(decision());
    await store.audit.beginDispatch(dispatch(preliminary));
    await store.close();
    closed = true;
    store = await createReceiptStore({ path, policyVersion: 'policy-v1' });
    closed = false;
    const result = await createClaimVerifier(store).verifyClaim(claimFor());
    expect(result.verdict).toBe('missing_evidence');
  });

  it('uses no cross-test state or unrelated verifier instance', async () => {
    const empty: ClaimVerifierDependencies = {
      audit: { listReceipts: vi.fn(async () => []) },
      findEmailEvidence: vi.fn(async () => []),
      listUnresolvedDispatches: vi.fn(async () => [])
    };
    await terminal('succeeded');
    expect((await verify(claimFor())).verdict).toBe('supported');
    expect((await createClaimVerifier(empty).verifyClaim(claimFor())).verdict).toBe('missing_evidence');
  });

  it.each(['claimId', 'taskId', 'callId', 'kind', 'recipient', 'subjectDigest', 'bodyDigest'])(
    'rejects a missing %s field', async (field) => {
      const value: Record<string, unknown> = { ...claimFor() };
      delete value[field];
      await expect(verify(value)).rejects.toThrow();
    }
  );

  it.each(['email_delivered', 'quote_compared', '', null])('rejects unsupported claim kind %j', async (kind) => {
    await expect(verify({ ...claimFor(), kind })).rejects.toThrow();
  });

  it.each([
    { receiptId: 'user-chosen-receipt' }, { matchingReceiptIds: ['forged'] },
    { explanation: 'The model says this was sent' }, { operatorPin: 'secret' }
  ])('rejects extra claim fields %j', async (extra) => {
    await expect(verify({ ...claimFor(), ...extra })).rejects.toThrow();
  });

  it.each(['claimId', 'taskId', 'callId', 'recipient', 'subjectDigest', 'bodyDigest'])(
    'rejects incorrect types for %s', async (field) => {
      for (const value of [null, 42, true, [], {}]) {
        await expect(verify({ ...claimFor(), [field]: value })).rejects.toThrow();
      }
    }
  );

  it.each(['subjectDigest', 'bodyDigest'])('rejects invalid SHA-256 encodings for %s', async (field) => {
    for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' ' + 'a'.repeat(64)]) {
      await expect(verify({ ...claimFor(), [field]: value })).rejects.toThrow();
    }
  });

  it.each(['bad-email', 'a@', ' ', 'a@example.test\r\nBcc:b@example.test'])(
    'rejects malformed recipient %j', async (recipient) => {
      await expect(verify({ ...claimFor(), recipient })).rejects.toThrow();
    }
  );

  it.each(['claimId', 'taskId', 'callId'])('rejects invalid frozen identifier %s', async (field) => {
    for (const value of ['', '../path', 'bad id', 'x'.repeat(129)]) {
      await expect(verify({ ...claimFor(), [field]: value })).rejects.toThrow();
    }
  });

  it.each([null, undefined, 'I definitely sent the email.', [], 42])('rejects unstructured claim %j', async (value) => {
    await expect(verify(value)).rejects.toThrow();
  });

  it('rejects malformed claims before reading any dependency', async () => {
    const reads = {
      audit: { listReceipts: vi.fn(async () => []) },
      findEmailEvidence: vi.fn(async () => []),
      listUnresolvedDispatches: vi.fn(async () => [])
    };
    await expect(createClaimVerifier(reads).verifyClaim('email sent')).rejects.toThrow();
    expect(reads.audit.listReceipts).not.toHaveBeenCalled();
    expect(reads.findEmailEvidence).not.toHaveBeenCalled();
    expect(reads.listUnresolvedDispatches).not.toHaveBeenCalled();
  });

  it('normalizes recipient casing and whitespace consistently with canonicalization', async () => {
    const { claim } = await terminal('succeeded');
    expect((await verify({ ...claim, recipient: ' Supplier@Example.Test ' })).verdict).toBe('supported');
  });

  it('uses canonical CRLF normalization but preserves exact trailing-newline digests', async () => {
    const request = decision();
    request.call.args = { recipient: 'supplier@example.test', subject: 'Q\r\nDetails', body: 'First\r\nLast\r\n' };
    request.email = canonicalizeEmail(request.call, request.grant);
    request.argsDigest = hashEmailAction(request.email);
    const receipt = await store.audit.recordDecision(request);
    await store.audit.beginDispatch(dispatch(receipt));
    await store.audit.recordOutcome({ preliminaryReceipt: receipt, status: 'succeeded', adapterOutcome: 'sent' });
    const claim = claimFor(request.email);
    expect((await verify(claim)).verdict).toBe('supported');
    const changed = claimFor({ ...request.email, body: request.email.body.slice(0, -1) });
    expect((await verify(changed)).verdict).toBe('missing_evidence');
  });

  it('returns only actual exact-matching receipt IDs', async () => {
    const one = await terminal('succeeded', 'one');
    const two = await terminal('failed', 'two');
    const result = await verify(two.claim);
    expect(result.matchingReceiptIds).toEqual([two.preliminary.receiptId, two.receipt.receiptId].sort());
    expect(result.matchingReceiptIds).not.toContain(one.receipt.receiptId);
    const realIds = (await store.audit.listReceipts()).map((receipt) => receipt.receiptId);
    expect(result.matchingReceiptIds.every((id) => realIds.includes(id))).toBe(true);
  });

  it('does not mutate the claim, trusted store, log file or call mutation methods', async () => {
    const { claim } = await terminal('succeeded');
    const before = await readFile(path, 'utf8');
    const original = structuredClone(claim);
    const mutationMethods = [
      vi.spyOn(store.audit, 'recordDecision'), vi.spyOn(store.audit, 'beginDispatch'),
      vi.spyOn(store.audit, 'recordOutcome')
    ];
    const beforeReceipts = await store.audit.listReceipts();
    const result = await verify(Object.freeze(claim));
    result.matchingReceiptIds.length = 0;
    expect(claim).toEqual(original);
    expect(await store.audit.listReceipts()).toEqual(beforeReceipts);
    expect(await readFile(path, 'utf8')).toBe(before);
    for (const spy of mutationMethods) expect(spy).not.toHaveBeenCalled();
  });

  it('does not invoke any adapter, approval or grant operation', async () => {
    await terminal('succeeded');
    const extras = {
      adapter: vi.fn(), approvePending: vi.fn(), validateAndConsume: vi.fn(), changeGrant: vi.fn()
    };
    const supplied = { ...dependencies(), ...extras };
    expect((await createClaimVerifier(supplied).verifyClaim(claimFor())).verdict).toBe('supported');
    for (const operation of Object.values(extras)) expect(operation).not.toHaveBeenCalled();
  });

  it('does not expose mail text or secrets in explanations', async () => {
    const request = decision('block');
    request.decision.reason = 'SYNTHETIC_POLICY_SECRET';
    await store.audit.recordDecision(request);
    const result = await verify(claimFor());
    expect(result.explanation).not.toContain('SYNTHETIC_BODY_SECRET');
    expect(result.explanation).not.toContain('SYNTHETIC_POLICY_SECRET');
    expect(result.explanation).not.toContain('supplier@example.test');
  });

  it.each(['receipts', 'evidence', 'unresolved', 'final-scan'])('returns missing evidence on %s read errors', async (stage) => {
    await terminal('succeeded');
    const reads = dependencies();
    const error = new Error('SYNTHETIC_STORAGE_SECRET');
    if (stage === 'receipts') reads.audit.listReceipts = vi.fn().mockRejectedValue(error);
    if (stage === 'evidence') reads.findEmailEvidence = vi.fn().mockRejectedValue(error);
    if (stage === 'unresolved') reads.listUnresolvedDispatches = vi.fn().mockRejectedValue(error);
    if (stage === 'final-scan') {
      reads.audit.listReceipts = vi.fn().mockResolvedValueOnce(await store.audit.listReceipts()).mockRejectedValueOnce(error);
    }
    const result = await createClaimVerifier(reads).verifyClaim(claimFor());
    expect(result.verdict).toBe('missing_evidence');
    expect(result.matchingReceiptIds).toEqual([]);
    expect(result.explanation).not.toContain(error.message);
  });

  it('rejects malformed runtime evidence without falling back to a receipt-only success', async () => {
    await terminal('succeeded');
    const reads = dependencies({
      findEmailEvidence: vi.fn().mockResolvedValue([{ ...claimFor(), receiptId: 'forged' }])
    });
    expect((await createClaimVerifier(reads).verifyClaim(claimFor())).verdict).toBe('missing_evidence');
  });

  it('requires exact email evidence even when a successful receipt exists', async () => {
    await terminal('succeeded');
    const reads = dependencies({ findEmailEvidence: vi.fn(async () => []) });
    const result = await createClaimVerifier(reads).verifyClaim(claimFor());
    expect(result.verdict).toBe('missing_evidence');
    expect(result.matchingReceiptIds).toEqual([]);
  });

  it('does not trust an overly broad evidence lookup or unrelated receipt tool', async () => {
    const { claim } = await terminal('succeeded');
    const rows = await store.findEmailEvidence({
      taskId: claim.taskId, callId: claim.callId, canonicalRecipient: claim.recipient,
      subjectDigest: claim.subjectDigest, bodyDigest: claim.bodyDigest
    });
    const wrong = rows.map((item) => ({ ...item, canonicalRecipient: 'other@example.test' }));
    expect((await createClaimVerifier(dependencies({
      findEmailEvidence: vi.fn(async () => wrong)
    })).verifyClaim(claim)).verdict).toBe('missing_evidence');
    const receipts = (await store.audit.listReceipts()).map((receipt) => ({ ...receipt, tool: 'read_quote' }));
    expect((await createClaimVerifier(dependencies({
      audit: { listReceipts: vi.fn(async () => receipts) }
    })).verifyClaim(claim)).verdict).toBe('missing_evidence');
  });

  it('does not return an orphan evidence receipt ID as a real matching receipt', async () => {
    const request = decision('block');
    await store.audit.recordDecision(request);
    const evidence = await store.findEmailEvidence({
      taskId: request.email!.taskId, callId: request.email!.callId,
      canonicalRecipient: request.email!.recipient,
      subjectDigest: claimFor().subjectDigest, bodyDigest: claimFor().bodyDigest
    });
    const orphan = '00000000-0000-4000-8000-000000000000';
    const reads = dependencies({ findEmailEvidence: vi.fn(async () => [{ ...evidence[0], receiptId: orphan }]) });
    const result = await createClaimVerifier(reads).verifyClaim(claimFor());
    expect(result).toMatchObject({ verdict: 'missing_evidence', matchingReceiptIds: [] });
  });

  it('uses complete state rather than receipt ordering or timestamp guesses', async () => {
    const { claim } = await terminal('succeeded', 'email-1', true);
    const receipts = (await store.audit.listReceipts()).reverse();
    const reads = dependencies({ audit: { listReceipts: vi.fn(async () => receipts) } });
    expect((await createClaimVerifier(reads).verifyClaim(claim)).verdict).toBe('supported');
  });

  it('conservatively returns missing evidence if receipts change during the separate reads', async () => {
    await store.audit.recordDecision(decision('request_approval'));
    const reads = dependencies({
      listUnresolvedDispatches: async () => {
        const old = await store.listUnresolvedDispatches();
        await terminal('succeeded');
        return old;
      }
    });
    const result = await createClaimVerifier(reads).verifyClaim(claimFor());
    expect(result.verdict).toBe('missing_evidence');
    expect(result.explanation).toContain('changed');
    expect((await verify(claimFor())).verdict).toBe('supported');
  });

  it('does not mutate frozen dependency results while comparing snapshots', async () => {
    const { claim } = await terminal('succeeded');
    const receipts = (await store.audit.listReceipts()).map((row) => Object.freeze(row));
    Object.freeze(receipts);
    const reads = dependencies({ audit: { listReceipts: vi.fn(async () => receipts) } });
    expect((await createClaimVerifier(reads).verifyClaim(claim)).verdict).toBe('supported');
  });

  it('does not repair noncanonical trusted evidence into a match', async () => {
    await terminal('succeeded');
    const evidence = await store.findEmailEvidence({
      taskId: claimFor().taskId, callId: claimFor().callId,
      canonicalRecipient: claimFor().recipient,
      subjectDigest: claimFor().subjectDigest, bodyDigest: claimFor().bodyDigest
    });
    const reads = dependencies({ findEmailEvidence: vi.fn(async () =>
      evidence.map((row) => ({ ...row, taskId: ' ' + row.taskId }))
    ) });
    expect((await createClaimVerifier(reads).verifyClaim(claimFor())).verdict).toBe('missing_evidence');
  });

  it('does not accept duplicate or conflicting stored terminal outcomes', async () => {
    const { claim, receipt } = await terminal('succeeded');
    const receipts = await store.audit.listReceipts();
    const duplicate = dependencies({ audit: { listReceipts: vi.fn(async () => [...receipts, receipt]) } });
    expect((await createClaimVerifier(duplicate).verifyClaim(claim)).verdict).toBe('missing_evidence');

    const conflicting: Receipt = {
      ...receipt, receiptId: '00000000-0000-4000-8000-000000000000',
      executionStatus: 'failed', adapterOutcome: 'adapter_failed'
    };
    const evidence = await store.findEmailEvidence({
      taskId: claim.taskId, callId: claim.callId, canonicalRecipient: claim.recipient,
      subjectDigest: claim.subjectDigest, bodyDigest: claim.bodyDigest
    });
    const terminalEvidence = evidence.find((row) => row.receiptId === receipt.receiptId)!;
    const reads = dependencies({
      audit: { listReceipts: vi.fn(async () => [...receipts, conflicting]) },
      findEmailEvidence: vi.fn(async () => [...evidence, { ...terminalEvidence, receiptId: conflicting.receiptId }])
    });
    expect((await createClaimVerifier(reads).verifyClaim(claim)).verdict).toBe('missing_evidence');
  });

  it('does not accept success on a blocked receipt', async () => {
    const { claim } = await terminal('succeeded');
    const receipts = (await store.audit.listReceipts()).map((receipt) => ({
      ...receipt, decision: 'block' as const
    }));
    expect((await createClaimVerifier(dependencies({
      audit: { listReceipts: vi.fn(async () => receipts) }
    })).verifyClaim(claim)).verdict).toBe('missing_evidence');
  });

  it('returns missing evidence when the trusted store is closed', async () => {
    await terminal('succeeded');
    await store.close();
    closed = true;
    expect((await verify(claimFor())).verdict).toBe('missing_evidence');
  });
});
