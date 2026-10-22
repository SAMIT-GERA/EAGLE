import { createHash } from 'node:crypto';
import { readQuoteArgsSchema, sendClarificationEmailArgsSchema } from '../contracts/schemas.js';
import type { CanonicalEmail, Decision, DispatchResponse, SecurityDependencies, TaskGrant, ToolCall } from '../contracts/types.js';
import { ControlledAdapterWiring } from '../adapters/wiring.js';
import { InMemoryGrantStore } from './grants.js';
import { PendingApprovalMetadataStore } from './pendingApprovalMetadata.js';
import { evaluateStoredToolCall, PolicyRuleId } from './policy.js';
import { CapabilityRegistry } from './toolRegistry.js';

export type GatewayRuntime = {
  grantStore: InMemoryGrantStore;
  capabilityRegistry: CapabilityRegistry;
  adapters: ControlledAdapterWiring;
  pendingApprovalMetadata?: PendingApprovalMetadataStore;
};

export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigurationError';
  }
}

export class GatewayBlockedError extends Error {
  constructor(readonly decision: Decision) {
    super(decision.reason);
    this.name = 'GatewayBlockedError';
  }
}

export class GatewayPreflightError extends Error {
  constructor(readonly callId: string) {
    super(`Audit preflight failed for ${callId}; no adapter was invoked.`);
    this.name = 'GatewayPreflightError';
  }
}

export class GatewayUncertainOutcomeError extends Error {
  constructor(readonly callId: string) {
    super(`The adapter may have executed for ${callId}, but its outcome could not be persisted.`);
    this.name = 'GatewayUncertainOutcomeError';
  }
}

export class DuplicateGatewayCallError extends Error {
  constructor(readonly callId: string) {
    super(`Gateway call ${callId} is already in progress, completed, or uncertain.`);
    this.name = 'DuplicateGatewayCallError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${value.length}:${value}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `array:${value.length}:[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `object:${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${canonicalJson(key)}=${canonicalJson(entry)}`).join(',')}`;
  }
  return `${typeof value}:${String(value)}`;
}

function digestArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function makeDecision(callId: string, grant: TaskGrant, decision: Decision['decision'], ruleId: string, reason: string): Decision {
  return { callId, decision, ruleId, reason, grantVersion: grant.version };
}

function assertCanonicalEmail(email: CanonicalEmail, call: ToolCall, grant: TaskGrant): void {
  const args = sendClarificationEmailArgsSchema.parse(call.args);
  if (
    email.taskId !== call.taskId ||
    email.grantVersion !== grant.version ||
    email.callId !== call.callId ||
    email.tool !== 'send_clarification_email' ||
    email.recipient !== args.recipient.trim().toLowerCase() ||
    email.subject !== normalizeLineEndings(args.subject) ||
    email.body !== normalizeLineEndings(args.body)
  ) {
    throw new GatewayConfigurationError('Canonical email dependency returned an action that is not bound to the trusted call and grant.');
  }
}

/**
 * Gateway-only dispatcher. It is deliberately not an HTTP handler and owns no
 * approval or audit implementation; those are injected through frozen ports.
 */
export class GatewayDispatcher {
  private readonly inFlightCallIds = new Set<string>();
  private readonly terminalOrUncertainCallIds = new Set<string>();

  constructor(
    private readonly deps: SecurityDependencies,
    private readonly runtime: GatewayRuntime
  ) {}

  async dispatchToolCall(call: ToolCall): Promise<DispatchResponse> {
    const initial = evaluateStoredToolCall(call, this.runtime.grantStore);
    const resolution = this.runtime.grantStore.resolve(call.taskId);
    const grant = resolution.record?.grant;

    if (grant === undefined) {
      throw new GatewayBlockedError(initial);
    }

    if (initial.decision === 'block') {
      return this.recordNonExecution(call, grant, initial);
    }

    if (call.tool === 'read_quote') {
      return this.dispatchRead(call, grant, initial);
    }
    if (call.tool === 'send_clarification_email') {
      return this.dispatchEmail(call, grant, initial);
    }

    return this.recordNonExecution(call, grant, initial);
  }

  private async dispatchRead(call: ToolCall, grant: TaskGrant, policyDecision: Decision): Promise<DispatchResponse> {
    if (policyDecision.decision !== 'allow') {
      return this.recordNonExecution(call, grant, policyDecision);
    }
    const parsedRead = readQuoteArgsSchema.safeParse(call.args);
    if (!parsedRead.success) {
      const invalid = makeDecision(call.callId, grant, 'block', PolicyRuleId.InvalidSchema, 'The quote-read arguments are malformed.');
      return this.recordNonExecution(call, grant, invalid);
    }
    this.reserve(call.taskId, call.callId);
    try {
      const capability = this.runtime.capabilityRegistry.get('read_quote');
      if (capability.sideEffecting || capability.adapter.adapterId !== 'quote-reader') {
        throw new GatewayConfigurationError('The quote-reader capability is misconfigured.');
      }
      const preliminaryReceipt = await this.deps.audit.recordDecision({
        call,
        decision: policyDecision,
        grant,
        argsDigest: digestArgs(call.args)
      });
      try {
        await this.deps.audit.beginDispatch({ callId: call.callId, taskId: call.taskId, tool: call.tool });
      } catch {
        throw new GatewayPreflightError(call.callId);
      }

      let data;
      try {
        data = this.runtime.adapters.resolveQuoteReader(capability.adapter.adapterId).read(parsedRead.data.fileId);
      } catch {
        try {
          const receipt = await this.deps.audit.recordOutcome({ preliminaryReceipt, status: 'failed', adapterOutcome: 'quote_reader_failed' });
          this.markTerminal(call.taskId, call.callId);
          return { decision: policyDecision, receipt };
        } catch {
          this.markTerminal(call.taskId, call.callId);
          throw new GatewayUncertainOutcomeError(call.callId);
        }
      }
      try {
        const receipt = await this.deps.audit.recordOutcome({ preliminaryReceipt, status: 'succeeded', adapterOutcome: 'quote_read' });
        this.markTerminal(call.taskId, call.callId);
        return { decision: policyDecision, receipt, data };
      } catch {
        this.markTerminal(call.taskId, call.callId);
        throw new GatewayUncertainOutcomeError(call.callId);
      }
    } finally {
      this.inFlightCallIds.delete(this.callKey(call.taskId, call.callId));
    }
  }

  private async dispatchEmail(call: ToolCall, grant: TaskGrant, policyDecision: Decision): Promise<DispatchResponse> {
    const parsedEmail = sendClarificationEmailArgsSchema.safeParse(call.args);
    if (!parsedEmail.success || policyDecision.decision === 'block') {
      return this.recordNonExecution(call, grant, policyDecision);
    }

    let canonicalEmail: CanonicalEmail;
    try {
      canonicalEmail = this.deps.canonicalizeEmail(call, grant);
      assertCanonicalEmail(canonicalEmail, call, grant);
    } catch {
      const invalidCanonicalDecision = makeDecision(call.callId, grant, 'block', PolicyRuleId.InvalidSchema, 'Canonical email payload is invalid or does not match the trusted grant.');
      return this.recordNonExecution(call, grant, invalidCanonicalDecision);
    }

    if (call.approvalId === undefined) {
      const digest = this.deps.hashEmailAction(canonicalEmail);
      await this.deps.approvalService.registerPending(canonicalEmail, digest);
      this.runtime.pendingApprovalMetadata?.register(canonicalEmail, digest);
      return this.recordNonExecution(call, grant, policyDecision, canonicalEmail);
    }

    this.reserve(call.taskId, call.callId);
    try {
      const capability = this.runtime.capabilityRegistry.get('send_clarification_email');
      if (!capability.sideEffecting || !capability.requiresApproval || capability.adapter.adapterId !== 'mock-mail') {
        throw new GatewayConfigurationError('The mock-mail capability is misconfigured.');
      }
      const digest = this.deps.hashEmailAction(canonicalEmail);
      if (this.runtime.pendingApprovalMetadata !== undefined &&
        !this.runtime.pendingApprovalMetadata.matchesPending(canonicalEmail, digest)) {
        const rejected = makeDecision(call.callId, grant, 'block', PolicyRuleId.ApprovalInvalid, 'Pending approval metadata is missing, stale, or altered.');
        return this.recordNonExecution(call, grant, rejected, canonicalEmail);
      }
      const approved = await this.deps.approvalService.validateAndConsume({ email: canonicalEmail, approvalId: call.approvalId, digest });
      if (!approved) {
        const rejected = makeDecision(call.callId, grant, 'block', PolicyRuleId.ApprovalInvalid, 'Approval is invalid, expired, altered, or already consumed.');
        return this.recordNonExecution(call, grant, rejected, canonicalEmail);
      }
      this.runtime.pendingApprovalMetadata?.markConsumed(canonicalEmail, digest);

      const rechecked = evaluateStoredToolCall(call, this.runtime.grantStore);
      if (rechecked.decision !== 'request_approval') {
        return this.recordNonExecution(call, grant, rechecked, canonicalEmail);
      }
      const recheckedGrant = this.runtime.grantStore.resolve(call.taskId).record?.grant;
      if (recheckedGrant === undefined || recheckedGrant.version !== grant.version) {
        const changedGrant = makeDecision(call.callId, grant, 'block', PolicyRuleId.GrantBindingMismatch, 'The active grant changed before dispatch.');
        return this.recordNonExecution(call, grant, changedGrant, canonicalEmail);
      }

      const allowDecision = makeDecision(call.callId, recheckedGrant, 'allow', PolicyRuleId.AuthorizedApprovedAction, 'The exact email action has valid human approval.');
      const preliminaryReceipt = await this.deps.audit.recordDecision({
        call,
        decision: allowDecision,
        grant: recheckedGrant,
        argsDigest: digest,
        email: canonicalEmail
      });
      try {
        await this.deps.audit.beginDispatch({ callId: call.callId, taskId: call.taskId, tool: call.tool });
      } catch {
        throw new GatewayPreflightError(call.callId);
      }

      const result = this.runtime.adapters.resolveMockMail(capability.adapter.adapterId).send(canonicalEmail);
      try {
        const receipt = await this.deps.audit.recordOutcome({
          preliminaryReceipt,
          status: result.outcome === 'succeeded' ? 'succeeded' : 'failed',
          adapterOutcome: result.outcome === 'succeeded' ? 'mock_mail_sent' : 'mock_mail_failed'
        });
        this.markTerminal(call.taskId, call.callId);
        return result.outcome === 'succeeded'
          ? { decision: allowDecision, receipt, data: result.evidence }
          : { decision: allowDecision, receipt };
      } catch {
        this.markTerminal(call.taskId, call.callId);
        throw new GatewayUncertainOutcomeError(call.callId);
      }
    } finally {
      this.inFlightCallIds.delete(this.callKey(call.taskId, call.callId));
    }
  }

  private async recordNonExecution(call: ToolCall, grant: TaskGrant, policyDecision: Decision, email?: CanonicalEmail): Promise<DispatchResponse> {
    const receipt = await this.deps.audit.recordDecision({
      call,
      decision: policyDecision,
      grant,
      argsDigest: email === undefined ? digestArgs(call.args) : this.deps.hashEmailAction(email),
      ...(email === undefined ? {} : { email })
    });
    return { decision: policyDecision, receipt };
  }

  private reserve(taskId: string, callId: string): void {
    const key = this.callKey(taskId, callId);
    if (this.inFlightCallIds.has(key) || this.terminalOrUncertainCallIds.has(key)) {
      throw new DuplicateGatewayCallError(callId);
    }
    this.inFlightCallIds.add(key);
  }

  private markTerminal(taskId: string, callId: string): void {
    this.terminalOrUncertainCallIds.add(this.callKey(taskId, callId));
  }

  private callKey(taskId: string, callId: string): string {
    return JSON.stringify([taskId, callId]);
  }
}

/**
 * Backwards-compatible frozen export. Runtime dependencies are supplied by
 * trusted server composition; no approval or audit service is constructed here.
 */
export function makeGateway(deps: SecurityDependencies, runtime?: GatewayRuntime): { dispatchToolCall(call: ToolCall): Promise<DispatchResponse> } {
  if (runtime === undefined) {
    throw new GatewayConfigurationError('Gateway runtime must be supplied by trusted server composition.');
  }
  const dispatcher = new GatewayDispatcher(deps, runtime);
  return { dispatchToolCall: (call) => dispatcher.dispatchToolCall(call) };
}
