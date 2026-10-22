import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEmail, Receipt, SecurityDependencies, TaskGrant, ToolCall } from '../src/contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../src/security/canonical.js';
import { createEmailEvidence, matchesEmailEvidence } from '../src/audit/emailEvidence.js';
import type { EmailEvidenceQuery } from '../src/audit/emailEvidence.js';
import { createReceiptStore, OutcomePersistenceError } from '../src/audit/receiptStore.js';

type Store = Awaited<ReturnType<typeof createReceiptStore>>;
type DecisionInput = Parameters<SecurityDependencies['audit']['recordDecision']>[0];

const grant: TaskGrant = {
  taskId: 'demo-task-1', version: 'v1', confirmed: true,
  approvedFileIds: ['quote-A', 'quote-B'],
  permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'],
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};
function input(kind: 'allow' | 'block' | 'request_approval' = 'allow', callId = 'mail-1'): DecisionInput {
  const call: ToolCall = {
    taskId: grant.taskId, callId, tool: 'send_clarification_email',
    args: { recipient: 'supplier@example.test', subject: 'Question', body: 'Please confirm.\n' }
  };
  const email = canonicalizeEmail(call, grant);
  return {
    call, grant: structuredClone(grant),
    decision: { callId, decision: kind, ruleId: 'RULE_EMAIL', reason: 'Trusted policy result', grantVersion: grant.version },
    email, argsDigest: hashEmailAction(email)
  };
}
function dispatch(receipt: Receipt) {
  return { taskId: receipt.taskId, callId: receipt.callId, tool: receipt.tool };
}
function query(email: CanonicalEmail): EmailEvidenceQuery {
  return {
    taskId: email.taskId, callId: email.callId, canonicalRecipient: email.recipient,
    subjectDigest: createHash('sha256').update(email.subject, 'utf8').digest('hex'),
    bodyDigest: createHash('sha256').update(email.body, 'utf8').digest('hex')
  };
}

describe('durable audit and trusted email evidence', () => {
  let root: string;
  let store: Store;
  let file: FileHandle;
  let path: string;
  const stores = new Set<Store>();

  async function setup(name = 'audit.jsonl') {
    let handle!: FileHandle;
    const filePath = join(root, name);
    const created = await createReceiptStore({
      path: filePath, policyVersion: 'policy-v1',
      openFile: async (name) => {
        handle = await open(name, 'a+', 0o600);
        return handle;
      }
    });
    stores.add(created);
    return { store: created, file: handle, path: filePath };
  }

  async function close(target: Store) {
    await target.close();
    stores.delete(target);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'taskgate-audit-test-'));
    ({ store, file, path } = await setup());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const target of stores) await target.close();
    stores.clear();
    // Guard recursive cleanup: delete only this test's direct temporary child.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('taskgate-audit-test-')) {
      throw new Error('Refusing unsafe temporary-directory cleanup');
    }
    await rm(root, { recursive: true, force: true });
  });

  async function events() {
    const content = await readFile(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    return content.trimEnd().split('\n').map((line) => JSON.parse(line));
  }

  it.each(['block', 'request_approval', 'allow'] as const)(
    'records %s as not_executed without claiming adapter success', async (kind) => {
      const receipt = await store.audit.recordDecision(input(kind));
      expect(receipt).toMatchObject({
        taskId: grant.taskId, callId: 'mail-1', tool: 'send_clarification_email',
        grantVersion: 'v1', policyVersion: 'policy-v1', ruleId: 'RULE_EMAIL',
        decision: kind, executionStatus: 'not_executed', adapterOutcome: 'not_invoked'
      });
      expect(await store.audit.listReceipts()).toEqual([receipt]);
      expect((await events())[0].receipt).toEqual(receipt);
    }
  );

  it.each(['succeeded', 'failed'] as const)('records and links the actual %s outcome', async (status) => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    const terminal = await store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status, adapterOutcome: 'Raw adapter details'
    });
    expect(terminal).toEqual({
      ...preliminary, receiptId: terminal.receiptId, timestamp: terminal.timestamp,
      executionStatus: status, adapterOutcome: 'adapter_' + status
    });
    expect(terminal.receiptId).not.toBe(preliminary.receiptId);
    const log = await events();
    expect(log.map((event) => event.kind)).toEqual(['decision', 'preflight', 'outcome']);
    expect(log[1].preliminaryReceiptId).toBe(preliminary.receiptId);
    expect(log[2].preliminaryReceiptId).toBe(preliminary.receiptId);
    expect(await store.listUnresolvedDispatches()).toEqual([]);
    expect(await store.audit.listReceipts()).toEqual([preliminary, terminal]);
    const evidence = await store.findEmailEvidence(query(input().email!));
    expect(evidence.map((item) => item.receiptId)).toEqual([preliminary.receiptId, terminal.receiptId]);
  });

  it('uses stable server UUIDs and UTC timestamps for receipts and events', async () => {
    const receipt = await store.audit.recordDecision(input('block'));
    expect(receipt.receiptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Date(receipt.timestamp).toISOString()).toBe(receipt.timestamp);
    expect((await store.audit.listReceipts())[0].receiptId).toBe(receipt.receiptId);
    const [event] = await events();
    expect(event.eventId).not.toBe(receipt.receiptId);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('serializes 30 concurrent writes into complete unique JSONL events', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      store.audit.recordDecision(input('block', 'concurrent-' + index))
    ));
    const log = await events();
    expect(log).toHaveLength(30);
    expect(new Set(log.map((event) => event.eventId)).size).toBe(30);
    expect(new Set(results.map((receipt) => receipt.receiptId)).size).toBe(30);
    expect(log.map((event) => event.receipt)).toEqual(results);
  });

  it('does not resolve preflight until its flush completes', async () => {
    const receipt = await store.audit.recordDecision(input());
    const realSync = file.sync.bind(file);
    let release!: () => void;
    let entered!: () => void;
    const syncEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
      entered();
      await barrier;
      await realSync();
    });
    let resolved = false;
    const preflight = store.audit.beginDispatch(dispatch(receipt)).then(() => { resolved = true; });
    await syncEntered;
    expect(resolved).toBe(false);
    release();
    await preflight;
    expect(resolved).toBe(true);
  });

  it.each(['writeFile', 'sync'] as const)('rejects preflight %s failure and never calls the test adapter', async (method) => {
    const preliminary = await store.audit.recordDecision(input());
    vi.spyOn(file, method).mockRejectedValueOnce(new Error('Synthetic storage failure'));
    const adapter = vi.fn();
    async function dispatchFixture() {
      await store.audit.beginDispatch(dispatch(preliminary));
      adapter();
    }
    await expect(dispatchFixture()).rejects.toThrow('Audit persistence failed');
    expect(adapter).not.toHaveBeenCalled();
    expect(await store.audit.listReceipts()).toEqual([preliminary]);
    await expect(store.audit.beginDispatch(dispatch(preliminary))).rejects.toThrow('faulted');
  });

  it('does not publish a decision when its write fails', async () => {
    vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('Disk full'));
    await expect(store.audit.recordDecision(input('block'))).rejects.toThrow('persistence');
    expect(await store.audit.listReceipts()).toEqual([]);
    expect(await store.findEmailEvidence(query(input().email!))).toEqual([]);
  });

  it('rejects repeated and concurrent preflight for the same authorized attempt', async () => {
    const preliminary = await store.audit.recordDecision(input());
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () =>
      store.audit.beginDispatch(dispatch(preliminary))
    ));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await events()).filter((event) => event.kind === 'preflight')).toHaveLength(1);
  });

  it.each([
    { callId: 'unrelated-call' }, { taskId: 'unrelated-task' }, { tool: 'read_quote' }
  ])('rejects mismatched dispatch %j', async (change) => {
    const receipt = await store.audit.recordDecision(input());
    await expect(store.audit.beginDispatch({ ...dispatch(receipt), ...change })).rejects.toThrow();
    expect(await events()).toHaveLength(1);
  });

  it.each(['block', 'request_approval'] as const)('rejects preflight for a %s decision', async (kind) => {
    const receipt = await store.audit.recordDecision(input(kind));
    await expect(store.audit.beginDispatch(dispatch(receipt))).rejects.toThrow();
  });

  it('rejects an unknown preflight without writing an event', async () => {
    await expect(store.audit.beginDispatch({
      taskId: grant.taskId, callId: 'unknown', tool: 'send_clarification_email'
    })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('permits pending then authorized decision for the same exact call', async () => {
    const pending = await store.audit.recordDecision(input('request_approval'));
    const authorized = await store.audit.recordDecision(input('allow'));
    await store.audit.beginDispatch(dispatch(authorized));
    expect((await events())[2].preliminaryReceiptId).toBe(authorized.receiptId);
    expect(pending.executionStatus).toBe('not_executed');
  });

  it('rejects a second allowed attempt even after the first completed', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    await store.audit.recordOutcome({ preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'done' });
    await expect(store.audit.recordDecision(input())).rejects.toThrow('already');
    await expect(store.audit.beginDispatch(dispatch(preliminary))).rejects.toThrow();
  });

  it('requires preflight before a side-effect outcome', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await expect(store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'sent'
    })).rejects.toThrow('unfinished authorized receipt');
  });

  it('supports read-only outcomes without requiring a side-effect preflight', async () => {
    const request = input();
    request.call = { taskId: grant.taskId, callId: 'mail-1', tool: 'read_quote', args: { fileId: 'quote-A' } };
    delete request.email;
    const preliminary = await store.audit.recordDecision(request);
    const terminal = await store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'quote_read'
    });
    expect(terminal.executionStatus).toBe('succeeded');
  });

  it.each(['writeFile', 'sync'] as const)('surfaces uncertain outcome on terminal %s failure', async (method) => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    vi.spyOn(file, method).mockRejectedValueOnce(new Error('Synthetic write failure'));
    const outcome = store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'sent'
    });
    await expect(outcome).rejects.toBeInstanceOf(OutcomePersistenceError);
    await expect(outcome).rejects.toMatchObject({
      code: 'OUTCOME_NOT_DURABLY_CONFIRMED', preliminaryReceiptId: preliminary.receiptId
    });
    expect(await store.audit.listReceipts()).toEqual([preliminary]);
    expect(await store.listUnresolvedDispatches()).toEqual([preliminary]);
    expect(await store.findEmailEvidence(query(input().email!))).toHaveLength(1);
    await expect(store.audit.beginDispatch(dispatch(preliminary))).rejects.toThrow();
  });

  it('rejects forged preliminary receipts', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    for (const change of [
      { receiptId: '00000000-0000-4000-8000-000000000000' },
      { taskId: 'another-task' }, { callId: 'another-call' },
      { argsDigest: 'f'.repeat(64) }, { ruleId: 'FORGED_RULE' },
      { policyVersion: 'forged' }, { tool: 'read_quote' },
      { grantVersion: 'v99' }, { timestamp: '2020-01-01T00:00:00.000Z' }
    ]) {
      await expect(store.audit.recordOutcome({
        preliminaryReceipt: { ...preliminary, ...change }, status: 'succeeded', adapterOutcome: 'sent'
      })).rejects.toThrow();
    }
    expect(await store.audit.listReceipts()).toHaveLength(1);
  });

  it('rejects outcomes for blocked or pending receipts', async () => {
    for (const kind of ['block', 'request_approval'] as const) {
      const receipt = await store.audit.recordDecision(input(kind));
      await expect(store.audit.recordOutcome({
        preliminaryReceipt: receipt, status: 'succeeded', adapterOutcome: 'sent'
      })).rejects.toThrow();
    }
  });

  it('accepts only one concurrent terminal outcome', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () =>
      store.audit.recordOutcome({ preliminaryReceipt: preliminary, status: 'succeeded', adapterOutcome: 'sent' })
    ));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.audit.listReceipts()).toHaveLength(2);
  });

  it('derives deterministic SHA-256 email evidence with exact frozen fields', async () => {
    const request = input('block');
    const receipt = await store.audit.recordDecision(request);
    const expected = { ...query(request.email!), receiptId: receipt.receiptId };
    expect(createEmailEvidence(request.email!, receipt)).toEqual(expected);
    expect(await store.findEmailEvidence(query(request.email!))).toEqual([expected]);
    expect(expected.subjectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(expected.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each<Partial<EmailEvidenceQuery>>([
    { canonicalRecipient: 'other@example.test' }, { taskId: 'another-task' },
    { callId: 'another-call' }, { subjectDigest: 'f'.repeat(64) }, { bodyDigest: 'f'.repeat(64) }
  ])('does not borrow evidence for changed key %j', async (change) => {
    const request = input('block');
    await store.audit.recordDecision(request);
    expect(await store.findEmailEvidence({ ...query(request.email!), ...change })).toEqual([]);
  });

  it('normalizes query recipient casing and surrounding whitespace', async () => {
    const request = input('block');
    await store.audit.recordDecision(request);
    expect(await store.findEmailEvidence({
      ...query(request.email!), canonicalRecipient: ' Supplier@Example.Test '
    })).toHaveLength(1);
  });

  it.each(['block', 'request_approval'] as const)('retains valid %s email evidence without dispatch', async (kind) => {
    const request = input(kind);
    if (kind === 'block') {
      request.call.args = { recipient: 'outside@example.test', subject: 'Question', body: 'Details' };
      request.email = canonicalizeEmail(request.call, request.grant);
      request.argsDigest = hashEmailAction(request.email);
    }
    await store.audit.recordDecision(request);
    expect(await store.findEmailEvidence(query(request.email!))).toHaveLength(1);
    expect((await events()).map((event) => event.kind)).toEqual(['decision']);
  });

  it('records malformed blocked actions without inventing canonical evidence', async () => {
    const request = input('block');
    request.call.args = { recipient: 'invalid-email', body: null };
    delete request.email;
    const receipt = await store.audit.recordDecision(request);
    expect(receipt.executionStatus).toBe('not_executed');
    expect(await store.findEmailEvidence(query(input().email!))).toEqual([]);
  });

  it('rejects fabricated canonical evidence for a malformed call', async () => {
    const request = input('block');
    request.call.args = { recipient: 'invalid-email', subject: 'Q', body: 'B' };
    await expect(store.audit.recordDecision(request)).rejects.toThrow();
    expect(await store.audit.listReceipts()).toEqual([]);
  });

  it('rejects canonical evidence that does not match call, grant or digest', async () => {
    for (const request of [
      { ...input('block'), email: { ...input().email!, body: 'Changed' } },
      { ...input('block'), argsDigest: 'f'.repeat(64) },
      { ...input('block'), email: { ...input().email!, grantVersion: 'v2' } }
    ]) await expect(store.audit.recordDecision(request)).rejects.toThrow();
  });

  it('does not persist raw message text, policy reasons, PINs or adapter secrets', async () => {
    const secret = 'SYNTHETIC_SECRET_PIN_94857_API_KEY';
    const request = input();
    request.call.args = { recipient: 'supplier@example.test', subject: secret, body: 'RAW_BODY_' + secret };
    request.email = canonicalizeEmail(request.call, request.grant);
    request.argsDigest = hashEmailAction(request.email);
    request.decision.reason = secret;
    const preliminary = await store.audit.recordDecision(request);
    await store.audit.beginDispatch(dispatch(preliminary));
    await store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'failed', adapterOutcome: secret
    });
    expect(await readFile(path, 'utf8')).not.toContain(secret);
    expect(JSON.stringify(await store.audit.listReceipts())).not.toContain(secret);
    expect(await readFile(path, 'utf8')).not.toContain('RAW_BODY_');
  });

  it('returns defensive receipts, evidence and unresolved-dispatch collections', async () => {
    const request = input();
    const preliminary = await store.audit.recordDecision(request);
    const original = { ...preliminary };
    await store.audit.beginDispatch(dispatch(preliminary));
    preliminary.ruleId = 'MUTATED';
    const rows = await store.audit.listReceipts();
    rows[0].ruleId = 'MUTATED';
    rows.length = 0;
    const evidence = await store.findEmailEvidence(query(request.email!));
    evidence[0].canonicalRecipient = 'mutated@example.test';
    evidence.length = 0;
    const unresolved = await store.listUnresolvedDispatches();
    unresolved[0].ruleId = 'MUTATED';
    expect(await store.audit.listReceipts()).toEqual([original]);
    expect(await store.findEmailEvidence(query(request.email!))).toHaveLength(1);
    expect(await store.listUnresolvedDispatches()).toEqual([original]);
  });

  it('snapshots caller input before queued asynchronous writes', async () => {
    const request = input('block');
    const result = store.audit.recordDecision(request);
    request.email!.body = 'Changed after call';
    request.call.callId = 'changed-call';
    request.decision.ruleId = 'CHANGED_RULE';
    const receipt = await result;
    expect(receipt.callId).toBe('mail-1');
    expect(receipt.ruleId).toBe('RULE_EMAIL');
  });

  it('filters receipt lists by task and isolates different stores', async () => {
    const second = await setup('other.jsonl');
    await store.audit.recordDecision(input('block'));
    expect(await second.store.audit.listReceipts()).toEqual([]);
    expect(await store.audit.listReceipts('different-task')).toEqual([]);
    expect(await store.audit.listReceipts(grant.taskId)).toHaveLength(1);
  });

  it('reopens valid JSONL with receipts, evidence and spent dispatch protection', async () => {
    const request = input();
    const preliminary = await store.audit.recordDecision(request);
    await store.audit.beginDispatch(dispatch(preliminary));
    const terminal = await store.audit.recordOutcome({
      preliminaryReceipt: preliminary, status: 'failed', adapterOutcome: 'failed'
    });
    await close(store);
    ({ store } = await setup());
    expect(await store.audit.listReceipts()).toEqual([preliminary, terminal]);
    expect(await store.findEmailEvidence(query(request.email!))).toHaveLength(2);
    await expect(store.audit.beginDispatch(dispatch(preliminary))).rejects.toThrow();
    await expect(store.audit.recordDecision(request)).rejects.toThrow('already');
  });

  it('reopens unresolved preflight without enabling a second dispatch', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    await close(store);
    ({ store } = await setup());
    expect(await store.listUnresolvedDispatches()).toEqual([preliminary]);
    await expect(store.audit.beginDispatch(dispatch(preliminary))).rejects.toThrow();
  });

  it.each(['{"partial":', '{}\n', 'not-json\n'])('fails closed on malformed recovery data %j', async (content) => {
    await close(store);
    await writeFile(path, content);
    await expect(createReceiptStore({ path, policyVersion: 'policy-v1' })).rejects.toThrow();
  });

  it('rejects inconsistent recovered outcome linkage', async () => {
    await store.audit.recordDecision(input('block'));
    const [event] = await events();
    event.kind = 'outcome';
    event.preliminaryReceiptId = '00000000-0000-4000-8000-000000000000';
    await close(store);
    await writeFile(path, JSON.stringify(event) + '\n');
    await expect(createReceiptStore({ path, policyVersion: 'policy-v1' })).rejects.toThrow();
  });

  it('rejects two active stores for the same path', async () => {
    await expect(createReceiptStore({ path, policyVersion: 'policy-v1' })).rejects.toThrow('active store');
  });

  it('supports TASKGATE_AUDIT_PATH without using the application audit file', async () => {
    const environmentPath = join(root, 'environment', 'audit.jsonl');
    vi.stubEnv('TASKGATE_AUDIT_PATH', environmentPath);
    const target = await createReceiptStore({ policyVersion: 'policy-v1' });
    stores.add(target);
    await target.audit.recordDecision(input('block'));
    expect(await readFile(environmentPath, 'utf8')).toContain('"kind":"decision"');
  });

  it('rejects storage inside public directories', async () => {
    await expect(createReceiptStore({
      path: join(root, 'public', 'audit.jsonl'), policyVersion: 'policy-v1'
    })).rejects.toThrow('outside public');
  });

  it('surfaces directory creation failure', async () => {
    const blocker = join(root, 'regular-file');
    await writeFile(blocker, 'not a directory');
    await expect(createReceiptStore({
      path: join(blocker, 'audit.jsonl'), policyVersion: 'policy-v1'
    })).rejects.toThrow();
  });

  it('rejects invalid decision bindings and field formats', async () => {
    const original = input('block');
    for (const request of [
      { ...original, decision: { ...original.decision, callId: 'wrong' } },
      { ...original, decision: { ...original.decision, grantVersion: 'v99' } },
      { ...original, grant: { ...original.grant, taskId: 'wrong' } },
      { ...original, argsDigest: 'invalid' },
      { ...original, decision: { ...original.decision, ruleId: 'unsafe\nrule' } }
    ]) await expect(store.audit.recordDecision(request)).rejects.toThrow();
    expect(await store.audit.listReceipts()).toEqual([]);
  });

  it('rejects unsupported runtime terminal status without recording an outcome', async () => {
    const preliminary = await store.audit.recordDecision(input());
    await store.audit.beginDispatch(dispatch(preliminary));
    await expect(store.audit.recordOutcome({
      preliminaryReceipt: preliminary,
      status: 'unknown_outcome' as 'failed', adapterOutcome: 'unknown'
    })).rejects.toThrow();
    expect(await store.audit.listReceipts()).toHaveLength(1);
  });

  it('rejects mismatched helper evidence and malformed lookup digests', async () => {
    const receipt = await store.audit.recordDecision(input('block'));
    expect(() => createEmailEvidence({ ...input().email!, callId: 'wrong' }, receipt)).toThrow();
    const item = createEmailEvidence(input().email!, receipt);
    expect(matchesEmailEvidence(item, { ...query(input().email!), bodyDigest: 'bad' })).toBe(false);
  });

  it('does not allow operations on a closed store', async () => {
    await close(store);
    await expect(store.audit.listReceipts()).rejects.toThrow('closed');
  });
});

describe('interrupted audit append recovery', () => {
  it('rejects a partial preflight append, prevents dispatch, and requires recovery on reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskgate-audit-test-'));
    const path = join(root, 'audit.jsonl');
    let file!: FileHandle;
    const store = await createReceiptStore({
      path, policyVersion: 'policy-v1',
      openFile: async (name) => { file = await open(name, 'a+', 0o600); return file; }
    });
    try {
      const preliminary = await store.audit.recordDecision(input());
      const realWrite = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (data) => {
        await realWrite(String(data).slice(0, 20), 'utf8');
        throw new Error('Synthetic partial append');
      });
      const adapter = vi.fn();
      await expect((async () => {
        await store.audit.beginDispatch(dispatch(preliminary));
        adapter();
      })()).rejects.toThrow('persistence');
      expect(adapter).not.toHaveBeenCalled();
      expect(await store.audit.listReceipts()).toEqual([preliminary]);
      await expect(store.audit.recordDecision(input('block', 'another-call'))).rejects.toThrow('faulted');
    } finally {
      vi.restoreAllMocks();
      await store.close();
    }
    try {
      const before = await readFile(path, 'utf8');
      await expect(createReceiptStore({ path, policyVersion: 'policy-v1' })).rejects.toThrow('Incomplete audit tail');
      expect(await readFile(path, 'utf8')).toBe(before);
    } finally {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('taskgate-audit-test-')) {
        throw new Error('Refusing unsafe temporary-directory cleanup');
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
