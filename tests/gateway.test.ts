import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockMailAdapter } from '../src/adapters/mockMail.js';
import { createDefaultQuoteReader } from '../src/adapters/quoteReader.js';
import { ControlledAdapterWiring } from '../src/adapters/wiring.js';
import { sendClarificationEmailArgsSchema } from '../src/contracts/schemas.js';
import type { CanonicalEmail, Decision, Receipt, SecurityDependencies, TaskGrant, ToolCall } from '../src/contracts/types.js';
import { GatewayBlockedError, GatewayDispatcher, GatewayPreflightError, GatewayUncertainOutcomeError, DuplicateGatewayCallError } from '../src/gateway/dispatch.js';
import { InMemoryGrantStore } from '../src/gateway/grants.js';
import { createDefaultCapabilityRegistry } from '../src/gateway/toolRegistry.js';

const grant: TaskGrant = {
  taskId: 'task-1', version: 'v1', confirmed: true,
  approvedFileIds: ['quote-A'], permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};

const readCall = (fileId = 'quote-A'): ToolCall => ({ callId: `read-${fileId}`, taskId: 'task-1', tool: 'read_quote', args: { fileId } });
const emailCall = (approvalId?: string, body = 'Please confirm lead time.'): ToolCall => ({
  callId: 'email-1', taskId: 'task-1', tool: 'send_clarification_email', args: {
    recipient: 'supplier@example.test', subject: 'Clarification', body
  },
  ...(approvalId === undefined ? {} : { approvalId })
});

type HarnessOptions = {
  mailMode?: 'succeed' | 'fail';
  recordDecisionFails?: boolean;
  beginDispatchFails?: boolean;
  recordOutcomeFails?: boolean;
  afterApprovalValidation?: () => void;
};

async function createHarness(options: HarnessOptions = {}) {
  const store = new InMemoryGrantStore(() => new Date('2026-10-22T00:00:00.000Z'));
  store.create(grant);
  const mail = new MockMailAdapter(options.mailMode ?? 'succeed', () => new Date('2026-10-22T00:00:00.000Z'));
  const wiring = new ControlledAdapterWiring(await createDefaultQuoteReader(), mail);
  const approvals = new Map<string, string>();
  const counts = { registerPending: 0, validateAndConsume: 0, recordDecision: 0, beginDispatch: 0, recordOutcome: 0 };
  let receiptSequence = 0;

  const hash = (email: CanonicalEmail) => createHash('sha256').update(JSON.stringify([
    'taskgate:canonical-email:v1', email.taskId, email.grantVersion, email.callId, email.tool, email.recipient, email.subject, email.body
  ])).digest('hex');
  const canonicalizeEmail = (call: ToolCall, activeGrant: TaskGrant): CanonicalEmail => {
    const args = sendClarificationEmailArgsSchema.parse(call.args);
    return {
      taskId: call.taskId, grantVersion: activeGrant.version, callId: call.callId, tool: 'send_clarification_email',
      recipient: args.recipient.trim().toLowerCase(), subject: args.subject.replace(/\r\n/g, '\n'), body: args.body.replace(/\r\n/g, '\n')
    };
  };
  const makeReceipt = (decision: Decision): Receipt => ({
    receiptId: `receipt-${++receiptSequence}`, taskId: 'task-1', callId: decision.callId, tool: decision.callId.startsWith('read') ? 'read_quote' : 'send_clarification_email',
    argsDigest: 'a'.repeat(64), grantVersion: decision.grantVersion, policyVersion: 'test', decision: decision.decision,
    ruleId: decision.ruleId, executionStatus: 'not_executed', adapterOutcome: 'not_executed', timestamp: '2026-10-22T00:00:00.000Z'
  });
  const deps: SecurityDependencies = {
    canonicalizeEmail,
    hashEmailAction: hash,
    approvalService: {
      async registerPending(email, digest) { counts.registerPending += 1; approvals.set(`pending:${email.callId}`, digest); },
      async approvePending() { throw new Error('Not used by dispatcher tests.'); },
      async validateAndConsume(input) {
        counts.validateAndConsume += 1;
        options.afterApprovalValidation?.();
        const expected = approvals.get(input.approvalId);
        if (expected !== input.digest) return false;
        approvals.delete(input.approvalId);
        return true;
      },
      async listPending() { return []; }
    },
    audit: {
      async recordDecision(input) {
        counts.recordDecision += 1;
        if (options.recordDecisionFails) throw new Error('audit decision failure');
        return makeReceipt(input.decision);
      },
      async beginDispatch() {
        counts.beginDispatch += 1;
        if (options.beginDispatchFails) throw new Error('audit preflight failure');
      },
      async recordOutcome(input) {
        counts.recordOutcome += 1;
        if (options.recordOutcomeFails) throw new Error('audit outcome failure');
        return { ...input.preliminaryReceipt, executionStatus: input.status, adapterOutcome: input.adapterOutcome };
      },
      async listReceipts() { return []; }
    }
  };
  const dispatcher = new GatewayDispatcher(deps, { grantStore: store, capabilityRegistry: createDefaultCapabilityRegistry(), adapters: wiring });
  const authorize = (call: ToolCall, approvalId = 'approval-1') => approvals.set(approvalId, hash(canonicalizeEmail(call, grant)));
  return { dispatcher, deps, store, mail, counts, authorize, approvals };
}

describe('GatewayDispatcher with typed security dependency mocks', () => {
  it('executes one authorized quote read after audit preflight and returns untrusted document data', async () => {
    const harness = await createHarness();
    const response = await harness.dispatcher.dispatchToolCall(readCall());

    expect(response.decision).toMatchObject({ decision: 'allow', ruleId: 'TG-P001' });
    expect(response.receipt.executionStatus).toBe('succeeded');
    expect(response.data).toMatchObject({ fileId: 'quote-A' });
    expect(harness.counts).toMatchObject({ recordDecision: 1, beginDispatch: 1, recordOutcome: 1 });
  });

  it('blocks unauthorized, path-like, unknown, and destructive calls with zero adapter attempts', async () => {
    const harness = await createHarness();
    const denied = [readCall('quote-B'), readCall('../quote-A'), { ...readCall(), tool: 'shell' }, { ...readCall(), tool: 'delete_quote' }];

    for (const call of denied) {
      const response = await harness.dispatcher.dispatchToolCall(call);
      expect(response.decision.decision).toBe('block');
      expect(response.receipt.executionStatus).toBe('not_executed');
    }
    expect(harness.mail.listAttempts()).toEqual([]);
    expect(harness.counts.beginDispatch).toBe(0);
  });

  it('fails closed for missing, expired, and revoked grants', async () => {
    const missing = await createHarness();
    const missingStore = new InMemoryGrantStore();
    const missingDispatcher = new GatewayDispatcher(missing.deps, {
      grantStore: missingStore, capabilityRegistry: createDefaultCapabilityRegistry(), adapters: new ControlledAdapterWiring(await createDefaultQuoteReader(), new MockMailAdapter())
    });
    await expect(missingDispatcher.dispatchToolCall(readCall())).rejects.toBeInstanceOf(GatewayBlockedError);

    let now = new Date('2026-10-22T00:00:00.000Z');
    const expiredStore = new InMemoryGrantStore(() => now);
    expiredStore.create(grant, { expiresAt: '2026-10-22T00:01:00.000Z' });
    now = new Date('2026-10-22T00:01:00.000Z');
    const expired = await createHarness();
    const expiredDispatcher = new GatewayDispatcher(expired.deps, {
      grantStore: expiredStore, capabilityRegistry: createDefaultCapabilityRegistry(), adapters: new ControlledAdapterWiring(await createDefaultQuoteReader(), new MockMailAdapter())
    });
    await expect(expiredDispatcher.dispatchToolCall(readCall())).resolves.toMatchObject({
      decision: { decision: 'block', ruleId: 'TG-G001' },
      receipt: { executionStatus: 'not_executed' }
    });

    const revoked = await createHarness();
    revoked.store.revoke('task-1');
    await expect(revoked.dispatcher.dispatchToolCall(readCall())).rejects.toBeInstanceOf(GatewayBlockedError);
  });

  it('registers pending emails, consumes exact approval once, and dispatches successful mail', async () => {
    const harness = await createHarness();
    const pending = await harness.dispatcher.dispatchToolCall(emailCall());
    expect(pending.decision).toMatchObject({ decision: 'request_approval', ruleId: 'TG-A001' });
    expect(harness.counts.registerPending).toBe(1);

    const approved = emailCall('approval-1');
    harness.authorize(approved);
    const response = await harness.dispatcher.dispatchToolCall(approved);
    expect(response.decision).toMatchObject({ decision: 'allow', ruleId: 'TG-P002' });
    expect(response.receipt.executionStatus).toBe('succeeded');
    expect(harness.mail.listEvidence()).toHaveLength(1);
  });

  it('blocks invalid, altered, and replayed approvals without a false successful send', async () => {
    const invalid = await createHarness();
    const invalidResponse = await invalid.dispatcher.dispatchToolCall(emailCall('missing-approval'));
    expect(invalidResponse.decision).toMatchObject({ decision: 'block', ruleId: 'TG-A002' });
    expect(invalid.mail.listEvidence()).toEqual([]);

    const altered = await createHarness();
    const original = emailCall('approval-1');
    altered.authorize(original);
    const alteredResponse = await altered.dispatcher.dispatchToolCall(emailCall('approval-1', 'Changed body'));
    expect(alteredResponse.decision.ruleId).toBe('TG-A002');
    expect(altered.mail.listEvidence()).toEqual([]);

    const replay = await createHarness();
    const replayCall = emailCall('approval-1');
    replay.authorize(replayCall);
    await replay.dispatcher.dispatchToolCall(replayCall);
    await expect(replay.dispatcher.dispatchToolCall(replayCall)).rejects.toBeInstanceOf(DuplicateGatewayCallError);
    expect(replay.mail.listEvidence()).toHaveLength(1);
  });

  it('does not invoke adapters when audit decision or preflight persistence fails', async () => {
    const decisionFailure = await createHarness({ recordDecisionFails: true });
    await expect(decisionFailure.dispatcher.dispatchToolCall(readCall())).rejects.toThrow('audit decision failure');
    expect(decisionFailure.counts.beginDispatch).toBe(0);

    const preflightFailure = await createHarness({ beginDispatchFails: true });
    const approvedCall = emailCall('approval-1');
    preflightFailure.authorize(approvedCall);
    await expect(preflightFailure.dispatcher.dispatchToolCall(approvedCall)).rejects.toBeInstanceOf(GatewayPreflightError);
    expect(preflightFailure.counts.recordOutcome).toBe(0);
    expect(preflightFailure.mail.listAttempts()).toEqual([]);
  });

  it('reports definite adapter failure and preserves uncertainty when outcome persistence fails', async () => {
    const failed = await createHarness({ mailMode: 'fail' });
    const failedCall = emailCall('approval-1');
    failed.authorize(failedCall);
    const failedResponse = await failed.dispatcher.dispatchToolCall(failedCall);
    expect(failedResponse.decision.decision).toBe('allow');
    expect(failedResponse.receipt.executionStatus).toBe('failed');
    expect(failedResponse.data).toBeUndefined();

    const uncertain = await createHarness({ recordOutcomeFails: true });
    const uncertainCall = emailCall('approval-1');
    uncertain.authorize(uncertainCall);
    await expect(uncertain.dispatcher.dispatchToolCall(uncertainCall)).rejects.toBeInstanceOf(GatewayUncertainOutcomeError);
    expect(uncertain.mail.listEvidence()).toHaveLength(1);
    await expect(uncertain.dispatcher.dispatchToolCall(uncertainCall)).rejects.toBeInstanceOf(DuplicateGatewayCallError);
  });

  it('prevents concurrent duplicate authorized email calls from invoking mock mail twice', async () => {
    const harness = await createHarness();
    const call = emailCall('approval-1');
    harness.authorize(call);
    const results = await Promise.allSettled([harness.dispatcher.dispatchToolCall(call), harness.dispatcher.dispatchToolCall(call)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(harness.mail.listAttempts()).toHaveLength(1);
  });

  it('blocks dispatch when the active grant changes after approval validation', async () => {
    let harnessStore: InMemoryGrantStore | undefined;
    const harness = await createHarness({
      afterApprovalValidation: () => {
        harnessStore?.replace({ ...grant, version: 'v2' });
      }
    });
    harnessStore = harness.store;
    const call = emailCall('approval-1');
    harness.authorize(call);

    const response = await harness.dispatcher.dispatchToolCall(call);
    expect(response.decision).toMatchObject({ decision: 'block', ruleId: 'TG-G002' });
    expect(harness.mail.listAttempts()).toEqual([]);
  });
});
