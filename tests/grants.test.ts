import { describe, expect, it } from 'vitest';
import { DuplicateGrantError, GrantValidationError, InMemoryGrantStore } from '../src/gateway/grants.js';

const grant = (version = 'v1') => ({
  taskId: 'task-1',
  version,
  confirmed: true,
  approvedFileIds: ['quote-A'],
  permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'],
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
});

describe('InMemoryGrantStore', () => {
  it('creates and retrieves a schema-valid server-owned grant', () => {
    const store = new InMemoryGrantStore(() => new Date('2026-10-22T00:00:00.000Z'));
    const created = store.create(grant());

    expect(created.status).toBe('active');
    expect(store.get('task-1')).toEqual(created);
  });

  it('rejects malformed grants and duplicate task/version identifiers', () => {
    const store = new InMemoryGrantStore();
    expect(() => store.create({ taskId: 'task-1' })).toThrow(GrantValidationError);
    store.create(grant());
    expect(() => store.create(grant())).toThrow(DuplicateGrantError);
  });

  it('reports expired grants using the injected clock', () => {
    let now = new Date('2026-10-22T00:00:00.000Z');
    const store = new InMemoryGrantStore(() => now);
    store.create(grant(), { expiresAt: '2026-10-22T00:05:00.000Z' });

    now = new Date('2026-10-22T00:05:00.000Z');
    expect(store.resolve('task-1').status).toBe('expired');
  });

  it('revokes active grants safely and fails closed after revocation', () => {
    const store = new InMemoryGrantStore(() => new Date('2026-10-22T00:00:00.000Z'));
    store.create(grant());

    expect(store.revoke('task-1')).toBe(true);
    expect(store.revoke('task-1')).toBe(false);
    expect(store.resolve('task-1').status).toBe('missing');
    expect(store.get('task-1', 'v1')?.status).toBe('revoked');
  });

  it('revokes the prior active version when replacing a grant', () => {
    const store = new InMemoryGrantStore(() => new Date('2026-10-22T00:00:00.000Z'));
    store.create(grant('v1'));
    const replacement = store.replace(grant('v2'));

    expect(replacement.grant.version).toBe('v2');
    expect(store.get('task-1', 'v1')?.status).toBe('revoked');
    expect(store.resolve('task-1', 'v1').status).toBe('version_mismatch');
    expect(store.resolve('task-1', 'v2').status).toBe('active');
  });

  it('returns clones so callers cannot expand a stored grant in memory', () => {
    const store = new InMemoryGrantStore();
    const created = store.create(grant());
    created.grant.approvedFileIds.push('quote-B');

    expect(store.get('task-1')?.grant.approvedFileIds).toEqual(['quote-A']);
  });
});
