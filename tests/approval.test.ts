import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
