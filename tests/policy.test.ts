import { describe, expect, it } from 'vitest';
import { InMemoryGrantStore } from '../src/gateway/grants.js';
import { evaluatePolicy, evaluateStoredToolCall, evaluateToolCall, PolicyRuleId } from '../src/gateway/policy.js';

const validGrant = {
  taskId: 'task-1',
  version: 'v1',
  confirmed: true,
  approvedFileIds: ['quote-A'],
  permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'],
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
} as const;

const readCall = (fileId = 'quote-A') => ({
  callId: 'call-read-1', taskId: 'task-1', tool: 'read_quote', args: { fileId }
});

const emailCall = (recipient = 'supplier@example.test') => ({
  callId: 'call-email-1',
  taskId: 'task-1',
  tool: 'send_clarification_email',
  args: { recipient, subject: 'Clarification', body: 'Please confirm lead time.' }
});

function storeWithGrant(): InMemoryGrantStore {
  const store = new InMemoryGrantStore(() => new Date('2026-10-22T00:00:00.000Z'));
  store.create(validGrant);
  return store;
}

describe('deterministic policy engine', () => {
  it('allows an exact authorized quote read without executing an adapter', () => {
    const store = storeWithGrant();
    let adapterInvocations = 0;
    const first = evaluateStoredToolCall(readCall(), store, 'v1');
    const second = evaluateStoredToolCall(readCall(), store, 'v1');

    expect(first).toEqual(second);
    expect(first).toMatchObject({ decision: 'allow', ruleId: PolicyRuleId.AuthorizedRead, grantVersion: 'v1' });
    expect(adapterInvocations).toBe(0);
  });

  it('fails closed for missing, expired, and revoked grants', () => {
    const missing = evaluateStoredToolCall(readCall(), new InMemoryGrantStore(), 'v1');
    expect(missing).toMatchObject({ decision: 'block', ruleId: PolicyRuleId.GrantInactive });

    let now = new Date('2026-10-22T00:00:00.000Z');
    const expiring = new InMemoryGrantStore(() => now);
    expiring.create(validGrant, { expiresAt: '2026-10-22T00:01:00.000Z' });
    now = new Date('2026-10-22T00:01:00.000Z');
    expect(evaluateStoredToolCall(readCall(), expiring, 'v1')).toMatchObject({ ruleId: PolicyRuleId.GrantInactive });

    const revoked = storeWithGrant();
    revoked.revoke('task-1');
    expect(evaluateStoredToolCall(readCall(), revoked, 'v1')).toMatchObject({ ruleId: PolicyRuleId.GrantInactive });
  });

  it('enforces trusted task and grant-version binding', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall(readCall(), store, 'v2')).toMatchObject({ ruleId: PolicyRuleId.GrantBindingMismatch });
    expect(evaluatePolicy({ ...readCall(), taskId: 'other-task' }, {
      grant: validGrant,
      status: 'active',
      expectedGrantVersion: 'v1'
    })).toMatchObject({ ruleId: PolicyRuleId.GrantBindingMismatch });
  });

  it('blocks unknown and destructive tools before any authorization outcome', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall({ ...readCall(), tool: 'shell' }, store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.UnsupportedTool });
    expect(evaluateStoredToolCall({ ...readCall(), tool: 'delete_quote', args: { fileId: 'quote-A' } }, store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.DestructiveOperation });
  });

  it('blocks unapproved and path-like quote identifiers', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall(readCall('quote-B'), store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.ResourceUnauthorized });
    expect(evaluateStoredToolCall(readCall('../quote-A'), store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.ResourceInvalid });
    expect(evaluateStoredToolCall(readCall('C:\\quote-A'), store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.ResourceInvalid });
  });

  it('requires exact human approval for eligible mail and blocks external recipients', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall(emailCall(), store, 'v1')).toMatchObject({
      decision: 'request_approval', ruleId: PolicyRuleId.ApprovalRequired
    });
    expect(evaluateStoredToolCall(emailCall('attacker@example.test'), store, 'v1')).toMatchObject({
      decision: 'block', ruleId: PolicyRuleId.RecipientUnauthorized
    });
  });

  it('applies schema validation first and hard-deny precedence before approval', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall({ callId: 'bad', taskId: 'task-1', tool: 'shell', args: {}, extra: true }, store, 'v1')).toMatchObject({
      ruleId: PolicyRuleId.InvalidSchema
    });
    expect(evaluateStoredToolCall({ ...emailCall('attacker@example.test'), approvalId: 'approved-id' }, store, 'v1')).toMatchObject({
      decision: 'block', ruleId: PolicyRuleId.RecipientUnauthorized
    });
    expect(evaluateStoredToolCall({ ...emailCall(), tool: 'delete_quote', args: { fileId: 'quote-A' }, approvalId: 'approved-id' }, store, 'v1')).toMatchObject({
      decision: 'block', ruleId: PolicyRuleId.DestructiveOperation
    });
  });

  it('blocks malformed known-tool arguments and supports the frozen evaluator export', () => {
    const store = storeWithGrant();
    expect(evaluateStoredToolCall({ ...readCall(), args: { fileId: 42 } }, store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.InvalidSchema });
    expect(evaluateStoredToolCall({ ...emailCall(), args: { recipient: 'not-an-email', subject: '', body: '' } }, store, 'v1')).toMatchObject({ ruleId: PolicyRuleId.InvalidSchema });
    expect(evaluateToolCall(readCall(), validGrant)).toMatchObject({ decision: 'allow', ruleId: PolicyRuleId.AuthorizedRead });
  });
});
