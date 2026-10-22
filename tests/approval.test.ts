import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_APPROVAL_ID_LENGTH,
  MAX_CALL_ID_LENGTH,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_RECIPIENT_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_TASK_ID_LENGTH
} from '../src/contracts/schemas.js';
import type { CanonicalEmail, TaskGrant, ToolCall } from '../src/contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../src/security/canonical.js';
import { createApprovalService } from '../src/security/approvalService.js';

function makeGrant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    taskId: 'demo-task-1',
    version: 'v1',
    confirmed: true,
    approvedFileIds: ['quote-A', 'quote-B'],
    permittedTools: ['read_quote', 'send_clarification_email'],
    prohibitedOperations: ['delete', 'modify'],
    eligibleRecipients: ['supplier@example.test'],
    approvalEligibleTools: ['send_clarification_email'],
    ...overrides
  };
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    callId: 'call-email-1',
    taskId: 'demo-task-1',
    tool: 'send_clarification_email',
    args: {
      recipient: 'supplier@example.test',
      subject: 'Clarification',
      body: 'Please confirm lead time.'
    },
    ...overrides
  };
}

function makeEmail(): CanonicalEmail {
  return canonicalizeEmail(makeCall(), makeGrant());
}

describe('canonical email action', () => {
  it('returns exactly the frozen seven-field shape using the actual grant version', () => {
    expect(canonicalizeEmail(makeCall(), makeGrant({ version: 'v42' }))).toEqual({
      taskId: 'demo-task-1',
      grantVersion: 'v42',
      callId: 'call-email-1',
      tool: 'send_clarification_email',
      recipient: 'supplier@example.test',
      subject: 'Clarification',
      body: 'Please confirm lead time.'
    });
  });

  it.each([
    ['casing', 'Supplier@Example.Test'],
    ['surrounding whitespace', ' \t supplier@example.test \r\n'],
    ['both', ' Supplier@Example.Test ']
  ])('normalizes recipient %s consistently', (_label, recipient) => {
    const email = canonicalizeEmail(makeCall({
      args: { recipient, subject: 'Clarification', body: 'Please confirm lead time.' }
    }), makeGrant());
    expect(email.recipient).toBe('supplier@example.test');
    expect(hashEmailAction(email)).toBe(hashEmailAction(makeEmail()));
  });

  it('normalizes CRLF to LF in both message fields without removing trailing lines', () => {
    const from = (subject: string, body: string) => canonicalizeEmail(makeCall({
      args: { recipient: 'supplier@example.test', subject, body }
    }), makeGrant());
    const crlf = from('Question\r\nDetails\r\n', 'First\r\nSecond\r\n\r\n');
    const lf = from('Question\nDetails\n', 'First\nSecond\n\n');
    expect(crlf).toEqual(lf);
    expect(crlf.subject).toBe('Question\nDetails\n');
    expect(crlf.body).toBe('First\nSecond\n\n');
    expect(hashEmailAction(crlf)).toBe(hashEmailAction(lf));
  });

  it('preserves leading/trailing spaces, internal whitespace and lone CR characters', () => {
    const subject = '  Question\t with  spaces \r ';
    const body = ' \tFirst\rSecond\n  Third  \n\n';
    const email = canonicalizeEmail(makeCall({
      args: { recipient: 'supplier@example.test', subject, body }
    }), makeGrant());
    expect(email.subject).toBe(subject);
    expect(email.body).toBe(body);
  });

  it('follows frozen min(1) rules: whitespace-only subject/body are not empty strings', () => {
    const email = canonicalizeEmail(makeCall({
      args: { recipient: 'supplier@example.test', subject: ' ', body: '\r\n' }
    }), makeGrant());
    expect(email.subject).toBe(' ');
    expect(email.body).toBe('\n');
  });

  it('uses the frozen surrounding-whitespace normalization for authority identifiers', () => {
    const email = canonicalizeEmail(makeCall({
      taskId: ' demo-task-1 ', callId: ' call-email-1 '
    }), makeGrant({ taskId: ' demo-task-1 ', version: ' v1 ' }));
    expect(email).toEqual(makeEmail());
  });

  it('does not mutate the call or grant, or share their mutable argument object', () => {
    const call = makeCall();
    const grant = makeGrant();
    const beforeCall = structuredClone(call);
    const beforeGrant = structuredClone(grant);
    const email = canonicalizeEmail(call, grant);
    expect(call).toEqual(beforeCall);
    expect(grant).toEqual(beforeGrant);
    email.body = 'Changed output';
    expect(call).toEqual(beforeCall);
  });

  it('does not authorize recipients or enforce grant policy', () => {
    const email = canonicalizeEmail(makeCall({
      args: { recipient: 'outside@example.test', subject: 'Question', body: 'Details' }
    }), makeGrant({ confirmed: false, permittedTools: [], eligibleRecipients: [] }));
    expect(email.recipient).toBe('outside@example.test');
  });

  it('does not bind approvalId into the canonical action or its hash', () => {
    const first = canonicalizeEmail(makeCall({ approvalId: 'approval-1' }), makeGrant());
    const second = canonicalizeEmail(makeCall({ approvalId: 'approval-2' }), makeGrant());
    expect(first).toEqual(makeEmail());
    expect(hashEmailAction(first)).toBe(hashEmailAction(second));
  });

  it('produces a deterministic lowercase SHA-256 hexadecimal digest', () => {
    expect(hashEmailAction(makeEmail())).toMatch(/^[a-f0-9]{64}$/);
    expect(hashEmailAction(makeEmail())).toBe(hashEmailAction(makeEmail()));
  });

  it('is independent of object property insertion order', () => {
    const email = makeEmail();
    const reversed: CanonicalEmail = {
      body: email.body, subject: email.subject, recipient: email.recipient,
      tool: email.tool, callId: email.callId,
      grantVersion: email.grantVersion, taskId: email.taskId
    };
    expect(hashEmailAction(reversed)).toBe(hashEmailAction(email));
  });

  it('matches the documented domain/version and fixed JSON field order', () => {
    const serialized = JSON.stringify([
      'taskgate:canonical-email:v1', 'demo-task-1', 'v1', 'call-email-1',
      'send_clarification_email', 'supplier@example.test',
      'Clarification', 'Please confirm lead time.'
    ]);
    const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');
    expect(hashEmailAction(makeEmail())).toBe(expected);
  });

  it.each<[keyof CanonicalEmail, string]>([
    ['recipient', 'other@example.test'],
    ['subject', 'Clarification!'],
    ['body', 'Please confirm lead time!'],
    ['callId', 'call-email-2'],
    ['taskId', 'demo-task-2'],
    ['grantVersion', 'v2']
  ])('binds %s into the digest', (field, value) => {
    const email = makeEmail();
    expect(hashEmailAction({ ...email, [field]: value })).not.toBe(hashEmailAction(email));
  });

  it('binds trailing newlines rather than silently discarding them', () => {
    const email = makeEmail();
    expect(hashEmailAction({ ...email, body: email.body + '\n' })).not.toBe(hashEmailAction(email));
  });

  it.each([
    ['ab', 'c', 'a', 'bc'],
    ['a|b', 'c', 'a', 'b|c'],
    ['a","b', 'c', 'a', 'b","c'],
    ['a\\b\n', 'c', 'a', '\\b\nc']
  ])('separates ambiguous field boundaries for %j and %j', (s1, b1, s2, b2) => {
    const email = makeEmail();
    expect(hashEmailAction({ ...email, subject: s1, body: b1 }))
      .not.toBe(hashEmailAction({ ...email, subject: s2, body: b2 }));
  });

  it('hashes Unicode deterministically and preserves distinct Unicode representations', () => {
    const email = { ...makeEmail(), subject: 'Caf\u00e9', body: 'Confirm \u20b9 price \u{1f600}' };
    expect(hashEmailAction(email)).toBe(hashEmailAction({ ...email }));
    expect(hashEmailAction(email)).not.toBe(hashEmailAction({ ...email, subject: 'Cafe\u0301' }));
  });

  it.each(['read_quote', 'delete_quote', 'shell', ''])('rejects unsupported tool %j', (tool) => {
    expect(() => canonicalizeEmail(makeCall({ tool }), makeGrant())).toThrow();
  });

  it.each(['recipient', 'subject', 'body'])('rejects missing %s', (field) => {
    const args: Record<string, unknown> = {
      recipient: 'supplier@example.test', subject: 'Question', body: 'Details'
    };
    delete args[field];
    expect(() => canonicalizeEmail(makeCall({ args }), makeGrant())).toThrow();
  });

  it('rejects unexpected email argument properties', () => {
    expect(() => canonicalizeEmail(makeCall({
      args: { recipient: 'supplier@example.test', subject: 'Q', body: 'B', cc: 'other@example.test' }
    }), makeGrant())).toThrow();
  });

  it('rejects unexpected top-level call properties', () => {
    const call = { ...makeCall(), bypass: true };
    expect(() => canonicalizeEmail(call, makeGrant())).toThrow();
  });

  it.each(['recipient', 'subject', 'body'])('rejects incorrect %s types', (field) => {
    for (const value of [null, undefined, 42, true, [], {}]) {
      const args = { recipient: 'supplier@example.test', subject: 'Q', body: 'B', [field]: value };
      expect(() => canonicalizeEmail(makeCall({ args }), makeGrant())).toThrow();
    }
  });

  it.each([null, undefined, 'email', [], 42])('rejects non-object args %j', (args) => {
    expect(() => canonicalizeEmail(makeCall({ args }), makeGrant())).toThrow();
  });

  it.each(['recipient', 'subject', 'body'])('rejects an empty %s', (field) => {
    const args = { recipient: 'supplier@example.test', subject: 'Q', body: 'B', [field]: '' };
    expect(() => canonicalizeEmail(makeCall({ args }), makeGrant())).toThrow();
  });

  it.each(['not-an-email', 'a@', ' ', 'a@example.test\r\nBcc:b@example.test'])(
    'rejects malformed recipient %j', (recipient) => {
      expect(() => canonicalizeEmail(makeCall({
        args: { recipient, subject: 'Q', body: 'B' }
      }), makeGrant())).toThrow();
    }
  );

  it.each([
    ['recipient', 'a'.repeat(MAX_EMAIL_RECIPIENT_LENGTH) + '@example.test'],
    ['subject', 's'.repeat(MAX_EMAIL_SUBJECT_LENGTH + 1)],
    ['body', 'b'.repeat(MAX_EMAIL_BODY_LENGTH + 1)]
  ])('rejects an oversized %s before normalization', (field, value) => {
    const args = { recipient: 'supplier@example.test', subject: 'Q', body: 'B', [field]: value };
    expect(() => canonicalizeEmail(makeCall({ args }), makeGrant())).toThrow();
  });

  it('accepts subject/body exactly at their frozen length limits', () => {
    const subject = 's'.repeat(MAX_EMAIL_SUBJECT_LENGTH);
    const body = 'b'.repeat(MAX_EMAIL_BODY_LENGTH);
    expect(canonicalizeEmail(makeCall({
      args: { recipient: 'supplier@example.test', subject, body }
    }), makeGrant())).toMatchObject({ subject, body });
  });

  it('rejects mismatched call and grant task IDs', () => {
    expect(() => canonicalizeEmail(makeCall(), makeGrant({ taskId: 'another-task' }))).toThrow();
  });

  it.each([
    ['taskId', ''], ['taskId', '../task'], ['taskId', 'https://example.test'],
    ['taskId', 'x'.repeat(MAX_TASK_ID_LENGTH + 1)],
    ['callId', ''], ['callId', 'bad id'], ['callId', '../call'],
    ['callId', 'x'.repeat(MAX_CALL_ID_LENGTH + 1)],
    ['approvalId', ''], ['approvalId', 'bad id'],
    ['approvalId', 'x'.repeat(MAX_APPROVAL_ID_LENGTH + 1)]
  ])('rejects invalid call %s = %j', (field, value) => {
    expect(() => canonicalizeEmail(makeCall({ [field]: value }), makeGrant())).toThrow();
  });

  it.each([
    ['taskId', ''], ['taskId', '../task'],
    ['version', ''], ['version', '   '],
    ['version', 'v'.repeat(MAX_TASK_ID_LENGTH + 1)]
  ])('rejects invalid grant %s = %j', (field, value) => {
    expect(() => canonicalizeEmail(makeCall(), makeGrant({ [field]: value }))).toThrow();
  });

  it.each<Partial<CanonicalEmail>>([
    { recipient: 'Supplier@example.test' },
    { recipient: ' supplier@example.test ' },
    { taskId: ' demo-task-1 ' },
    { grantVersion: ' v1 ' },
    { callId: ' call-email-1 ' },
    { subject: 'Question\r\n' },
    { body: 'Details\r\n' }
  ])('rejects noncanonical hash input %j instead of silently normalizing', (change) => {
    expect(() => hashEmailAction({ ...makeEmail(), ...change })).toThrow();
  });

  it('rejects invalid runtime hash values even if a caller bypasses TypeScript', () => {
    for (const input of [
      { ...makeEmail(), body: undefined },
      { ...makeEmail(), body: null },
      { ...makeEmail(), tool: 'read_quote' },
      { ...makeEmail(), extra: true }
    ]) {
      expect(() => hashEmailAction(input as unknown as CanonicalEmail)).toThrow();
    }
  });
});

describe('atomic single-use approval service', () => {
  let service: ReturnType<typeof createApprovalService>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
    service = createApprovalService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function registerAndApprove(email: CanonicalEmail = makeEmail()) {
    const digest = hashEmailAction(email);
    await service.registerPending(email, digest);
    const credential = await service.approvePending({
      taskId: email.taskId, callId: email.callId, approvedBy: 'local_operator'
    });
    return { email, digest, ...credential };
  }

  it('registers an exact action and issues only the frozen credential response', async () => {
    const result = await registerAndApprove();
    expect(result.approvalId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const response = await service.approvePending({
      taskId: result.email.taskId, callId: result.email.callId, approvedBy: 'local_operator'
    });
    expect(Object.keys(response).sort()).toEqual(['approvalId', 'expiresAt']);
    expect(response).toEqual({ approvalId: result.approvalId, expiresAt: result.expiresAt });
  });

  it('consumes the matching action once and rejects a second consume', async () => {
    const input = await registerAndApprove();
    expect(await service.validateAndConsume(input)).toBe(true);
    expect(await service.validateAndConsume(input)).toBe(false);
  });

  it('allows exactly one of 50 concurrent consumers', async () => {
    const input = await registerAndApprove();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.validateAndConsume(input))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(49);
  });

  it.each<Partial<CanonicalEmail>>([
    { recipient: 'other@example.test' }, { subject: 'Changed' }, { body: 'Changed' },
    { taskId: 'another-task' }, { callId: 'another-call' }, { grantVersion: 'v2' }
  ])('rejects changed action %j with either old or recomputed digest', async (change) => {
    const input = await registerAndApprove();
    const email = { ...input.email, ...change };
    expect(await service.validateAndConsume({ ...input, email })).toBe(false);
    expect(await service.validateAndConsume({
      ...input, email, digest: hashEmailAction(email)
    })).toBe(false);
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it.each(['', 'forged', '0'.repeat(64), 'A'.repeat(64)])(
    'rejects forged supplied digest %j without spending the valid approval', async (digest) => {
      const input = await registerAndApprove();
      expect(await service.validateAndConsume({ ...input, digest })).toBe(false);
      expect(await service.validateAndConsume(input)).toBe(true);
    }
  );

  it.each(['', 'unknown-approval', '../approval'])('rejects invalid approval ID %j', async (approvalId) => {
    const input = await registerAndApprove();
    expect(await service.validateAndConsume({ ...input, approvalId })).toBe(false);
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it('rejects a valid credential belonging to another pending action', async () => {
    const first = await registerAndApprove();
    const second = await registerAndApprove({ ...makeEmail(), callId: 'call-email-2' });
    expect(await service.validateAndConsume({ ...first, approvalId: second.approvalId })).toBe(false);
    expect(await service.validateAndConsume(first)).toBe(true);
    expect(await service.validateAndConsume(second)).toBe(true);
  });

  it('accepts immediately before the three-minute expiry', async () => {
    const input = await registerAndApprove();
    expect(Date.parse(input.expiresAt) - Date.now()).toBe(180_000);
    vi.advanceTimersByTime(179_999);
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it.each([180_000, 180_001])('rejects at/after expiry (%i ms)', async (elapsed) => {
    const input = await registerAndApprove();
    vi.advanceTimersByTime(elapsed);
    expect(await service.validateAndConsume(input)).toBe(false);
  });

  it('never reactivates a credential after expiry is observed, even after clock rollback', async () => {
    const input = await registerAndApprove();
    const initialTime = Date.now();
    vi.advanceTimersByTime(180_000);
    expect(await service.validateAndConsume(input)).toBe(false);
    vi.setSystemTime(initialTime);
    expect(await service.validateAndConsume(input)).toBe(false);
  });

  it('requires explicit new approval after expiry and permanently invalidates the old ID', async () => {
    const old = await registerAndApprove();
    vi.advanceTimersByTime(180_000);
    const renewed = await service.approvePending({
      taskId: old.email.taskId, callId: old.email.callId, approvedBy: 'local_operator'
    });
    expect(renewed.approvalId).not.toBe(old.approvalId);
    expect(Date.parse(renewed.expiresAt) - Date.now()).toBe(180_000);
    expect(await service.validateAndConsume(old)).toBe(false);
    expect(await service.validateAndConsume({ ...old, ...renewed })).toBe(true);
  });

  it('can explicitly approve after an expired consume was rejected', async () => {
    const old = await registerAndApprove();
    vi.advanceTimersByTime(180_001);
    expect(await service.validateAndConsume(old)).toBe(false);
    const renewed = await service.approvePending({
      taskId: old.email.taskId, callId: old.email.callId, approvedBy: 'local_operator'
    });
    expect(await service.validateAndConsume(old)).toBe(false);
    expect(await service.validateAndConsume({ ...old, ...renewed })).toBe(true);
  });

  it('rejects approval for an unknown pending call', async () => {
    await expect(service.approvePending({
      taskId: 'demo-task-1', callId: 'missing', approvedBy: 'local_operator'
    })).rejects.toThrow('No pending action');
  });

  it.each(['', '   '])('rejects empty operator attribution %j', async (approvedBy) => {
    const email = makeEmail();
    await service.registerPending(email, hashEmailAction(email));
    await expect(service.approvePending({
      taskId: email.taskId, callId: email.callId, approvedBy
    })).rejects.toThrow();
  });

  it.each(['', 'forged', '0'.repeat(64)])('rejects registration digest %j without creating state', async (digest) => {
    await expect(service.registerPending(makeEmail(), digest)).rejects.toThrow('digest');
    expect(await service.listPending()).toEqual([]);
  });

  it('rejects noncanonical registration rather than applying new normalization', async () => {
    await expect(service.registerPending(
      { ...makeEmail(), recipient: 'Supplier@example.test' }, hashEmailAction(makeEmail())
    )).rejects.toThrow();
    expect(await service.listPending()).toEqual([]);
  });

  it.each<Partial<CanonicalEmail>>([
    { recipient: 'other@example.test' }, { subject: 'Changed' },
    { body: 'Changed' }, { grantVersion: 'v2' }
  ])('rejects conflicting re-registration %j and preserves original authorization', async (change) => {
    const input = await registerAndApprove();
    const modified = { ...input.email, ...change };
    await expect(service.registerPending(modified, hashEmailAction(modified))).rejects.toThrow('Conflicting');
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it('makes identical pending registration idempotent', async () => {
    const email = makeEmail();
    const digest = hashEmailAction(email);
    await Promise.all(Array.from({ length: 10 }, () => service.registerPending(email, digest)));
    expect(await service.listPending()).toHaveLength(1);
  });

  it('does not extend approval TTL when identical action is re-registered', async () => {
    const input = await registerAndApprove();
    vi.advanceTimersByTime(60_000);
    await service.registerPending(input.email, input.digest);
    const duplicate = await service.approvePending({
      taskId: input.email.taskId, callId: input.email.callId, approvedBy: 'another_operator'
    });
    expect(duplicate).toEqual({ approvalId: input.approvalId, expiresAt: input.expiresAt });
  });

  it('cannot restore consumed approval by re-registering the same call', async () => {
    const input = await registerAndApprove();
    expect(await service.validateAndConsume(input)).toBe(true);
    await expect(service.registerPending(input.email, input.digest)).rejects.toThrow('consumed');
    expect(await service.validateAndConsume(input)).toBe(false);
  });

  it('cannot re-register a consumed call with changed payload or grant version', async () => {
    const input = await registerAndApprove();
    await service.validateAndConsume(input);
    const changed = { ...input.email, body: 'New content', grantVersion: 'v2' };
    await expect(service.registerPending(changed, hashEmailAction(changed))).rejects.toThrow('consumed');
  });

  it('deduplicates concurrent approval issuance into one usable credential', async () => {
    const email = makeEmail();
    const digest = hashEmailAction(email);
    await service.registerPending(email, digest);
    const approvals = await Promise.all(Array.from({ length: 20 }, () => service.approvePending({
      taskId: email.taskId, callId: email.callId, approvedBy: 'local_operator'
    })));
    expect(new Set(approvals.map((approval) => approval.approvalId)).size).toBe(1);
    const results = await Promise.all(approvals.map((approval) =>
      service.validateAndConsume({ email, digest, ...approval })
    ));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects fresh approval of a consumed call, including after its expiry', async () => {
    const input = await registerAndApprove();
    await service.validateAndConsume(input);
    for (const elapsed of [0, 180_001]) {
      vi.advanceTimersByTime(elapsed);
      await expect(service.approvePending({
        taskId: input.email.taskId, callId: input.email.callId, approvedBy: 'local_operator'
      })).rejects.toThrow('consumed');
      expect(await service.validateAndConsume(input)).toBe(false);
    }
  });

  it('does not reset consumption if a later gateway step fails or is uncertain', async () => {
    const input = await registerAndApprove();
    expect(await service.validateAndConsume(input)).toBe(true);
    // No rollback hook: the caller must not restore authorization after dispatch/preflight errors.
    expect(await service.validateAndConsume(input)).toBe(false);
    await expect(service.registerPending(input.email, input.digest)).rejects.toThrow('consumed');
  });

  it('uses fresh cryptographic UUIDs, not a deterministic ID derived from payload', async () => {
    const input = await registerAndApprove();
    const other = createApprovalService();
    await other.registerPending(input.email, input.digest);
    const second = await other.approvePending({
      taskId: input.email.taskId, callId: input.email.callId, approvedBy: 'local_operator'
    });
    expect(second.approvalId).not.toBe(input.approvalId);
    const ids = [input.approvalId];
    for (let index = 0; index < 10; index++) {
      const result = await registerAndApprove({ ...makeEmail(), callId: 'unique-' + index });
      ids.push(result.approvalId);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(id).not.toContain(input.email.callId);
    }
  });

  it('lists pending/approved/expired actions and excludes consumed calls', async () => {
    const input = await registerAndApprove();
    const row = {
      taskId: input.email.taskId, callId: input.email.callId,
      recipient: input.email.recipient, subject: input.email.subject, body: input.email.body
    };
    expect(await service.listPending()).toEqual([row]);
    vi.advanceTimersByTime(180_000);
    expect(await service.listPending()).toEqual([row]);
    const renewed = await service.approvePending({
      taskId: input.email.taskId, callId: input.email.callId, approvedBy: 'local_operator'
    });
    await service.validateAndConsume({ ...input, ...renewed });
    expect(await service.listPending()).toEqual([]);
  });

  it('stores defensive copies and returns defensive pending rows and arrays', async () => {
    const email = makeEmail();
    const original = { ...email };
    const digest = hashEmailAction(email);
    await service.registerPending(email, digest);
    email.body = 'Caller mutation';
    const rows = await service.listPending();
    expect(rows[0].body).toBe(original.body);
    rows[0].body = 'List mutation';
    rows.splice(0, rows.length);
    expect((await service.listPending())[0].body).toBe(original.body);
    const credential = await service.approvePending({
      taskId: original.taskId, callId: original.callId, approvedBy: 'local_operator'
    });
    expect(await service.validateAndConsume({ email: original, digest, ...credential })).toBe(true);
  });

  it('returns defensive approval responses', async () => {
    const input = await registerAndApprove();
    const response = await service.approvePending({
      taskId: input.email.taskId, callId: input.email.callId, approvedBy: 'local_operator'
    });
    response.approvalId = 'caller-mutation';
    response.expiresAt = '2000-01-01T00:00:00.000Z';
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it('starts each test with empty isolated state', async () => {
    expect(await service.listPending()).toEqual([]);
    const input = await registerAndApprove();
    const other = createApprovalService();
    expect(await other.listPending()).toEqual([]);
    expect(await other.validateAndConsume(input)).toBe(false);
    expect(await service.validateAndConsume(input)).toBe(true);
  });

  it('separates task/call key boundaries without delimiter collisions', async () => {
    const first = await registerAndApprove({ ...makeEmail(), taskId: 'a:b', callId: 'c' });
    const second = await registerAndApprove({ ...makeEmail(), taskId: 'a', callId: 'b:c' });
    expect(await service.listPending()).toHaveLength(2);
    expect(await service.validateAndConsume(first)).toBe(true);
    expect(await service.validateAndConsume(second)).toBe(true);
  });

  it('returns false for malformed runtime input without spending a valid credential', async () => {
    const input = await registerAndApprove();
    for (const malformed of [
      null, undefined, {}, { ...input, email: null },
      { ...input, email: { ...input.email, body: null } },
      { ...input, email: { ...input.email, recipient: 'Supplier@example.test' } }
    ]) {
      expect(await service.validateAndConsume(
        malformed as unknown as Parameters<typeof service.validateAndConsume>[0]
      )).toBe(false);
    }
    expect(await service.validateAndConsume(input)).toBe(true);
  });
});
