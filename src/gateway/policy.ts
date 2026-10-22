import { approvalIdSchema, callIdSchema, deleteQuoteArgsSchema, readQuoteArgsSchema, sendClarificationEmailArgsSchema, taskIdSchema } from '../contracts/schemas.js';
import type { Decision, TaskGrant, ToolCall } from '../contracts/types.js';
import type { GrantLifecycleStatus, InMemoryGrantStore } from './grants.js';

export const POLICY_VERSION = 'taskgate-v2-policy-1';

export const PolicyRuleId = {
  GrantInactive: 'TG-G001',
  GrantBindingMismatch: 'TG-G002',
  UnsupportedTool: 'TG-T001',
  DestructiveOperation: 'TG-T002',
  ResourceUnauthorized: 'TG-R001',
  ResourceInvalid: 'TG-R002',
  RecipientUnauthorized: 'TG-E001',
  ApprovalRequired: 'TG-A001',
  ApprovalInvalid: 'TG-A002',
  InvalidSchema: 'TG-S001',
  AuthorizedRead: 'TG-P001',
  AuthorizedApprovedAction: 'TG-P002',
  AuditPreflightFailed: 'TG-X001'
} as const;

export type PolicyRuleId = (typeof PolicyRuleId)[keyof typeof PolicyRuleId];

export type PolicyGrantContext = {
  grant?: TaskGrant;
  status: GrantLifecycleStatus | 'missing' | 'version_mismatch';
  expectedGrantVersion?: string;
};

type ToolCallEnvelope = {
  callId: string;
  taskId: string;
  tool: string;
  args: unknown;
  approvalId?: string;
};

const TOOL_CALL_KEYS = new Set(['callId', 'taskId', 'tool', 'args', 'approvalId']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown): ToolCallEnvelope | undefined {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !TOOL_CALL_KEYS.has(key))) {
    return undefined;
  }
  if (!Object.hasOwn(value, 'callId') || !Object.hasOwn(value, 'taskId') || !Object.hasOwn(value, 'tool') || !Object.hasOwn(value, 'args')) {
    return undefined;
  }
  const callId = typeof value.callId === 'string' ? value.callId : undefined;
  const taskId = typeof value.taskId === 'string' ? value.taskId : undefined;
  if (typeof value.tool !== 'string' || callId === undefined || taskId === undefined || !callIdSchema.safeParse(callId).success || !taskIdSchema.safeParse(taskId).success) {
    return undefined;
  }
  const approvalId = typeof value.approvalId === 'string' ? value.approvalId : undefined;
  if (value.approvalId !== undefined && (approvalId === undefined || !approvalIdSchema.safeParse(approvalId).success)) {
    return undefined;
  }

  return {
    callId,
    taskId,
    tool: value.tool,
    args: value.args,
    ...(approvalId === undefined ? {} : { approvalId })
  };
}

function decision(callId: string, decisionKind: Decision['decision'], ruleId: PolicyRuleId, reason: string, grantVersion: string): Decision {
  return { callId, decision: decisionKind, ruleId, reason, grantVersion };
}

function failureContext(input: unknown): { callId: string; grantVersion: string } {
  if (!isPlainObject(input)) {
    return { callId: 'invalid-call', grantVersion: 'unknown' };
  }
  return {
    callId: typeof input.callId === 'string' ? input.callId : 'invalid-call',
    grantVersion: 'unknown'
  };
}

function isPathLike(fileId: string): boolean {
  return fileId.includes('/') || fileId.includes('\\') || fileId.includes('..') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(fileId);
}

function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function validReadArgs(args: unknown): args is { fileId: string } {
  return hasOnlyKeys(args, ['fileId']) && typeof args.fileId === 'string';
}

export function getPolicyVersion(): string {
  return POLICY_VERSION;
}

/**
 * Pure, deterministic evaluation against trusted lifecycle context. It has no
 * adapter, network, approval-write, audit-write, or filesystem side effects.
 */
export function evaluatePolicy(input: unknown, context: PolicyGrantContext): Decision {
  const envelope = parseEnvelope(input);
  if (envelope === undefined) {
    const fallback = failureContext(input);
    return decision(fallback.callId, 'block', PolicyRuleId.InvalidSchema, 'Tool call does not match the strict request envelope.', fallback.grantVersion);
  }

  if (context.status === 'missing' || context.status === 'expired' || context.status === 'revoked' || context.grant === undefined || !context.grant.confirmed) {
    return decision(envelope.callId, 'block', PolicyRuleId.GrantInactive, 'No active, confirmed grant is available for this action.', context.grant?.version ?? 'unknown');
  }

  if (context.status === 'version_mismatch' || context.expectedGrantVersion !== undefined && context.expectedGrantVersion !== context.grant.version || envelope.taskId !== context.grant.taskId) {
    return decision(envelope.callId, 'block', PolicyRuleId.GrantBindingMismatch, 'Task ID or trusted grant version does not match the active grant.', context.grant.version);
  }

  if (envelope.tool !== 'read_quote' && envelope.tool !== 'send_clarification_email' && envelope.tool !== 'delete_quote') {
    return decision(envelope.callId, 'block', PolicyRuleId.UnsupportedTool, 'The requested tool is unsupported.', context.grant.version);
  }

  if (envelope.tool === 'delete_quote') {
    if (!deleteQuoteArgsSchema.safeParse(envelope.args).success) {
      return decision(envelope.callId, 'block', PolicyRuleId.InvalidSchema, 'The delete request arguments are malformed.', context.grant.version);
    }
    return decision(envelope.callId, 'block', PolicyRuleId.DestructiveOperation, 'Destructive operations are prohibited.', context.grant.version);
  }

  if (envelope.tool === 'read_quote') {
    if (!validReadArgs(envelope.args)) {
      return decision(envelope.callId, 'block', PolicyRuleId.InvalidSchema, 'The quote-read arguments are malformed.', context.grant.version);
    }
    if (isPathLike(envelope.args.fileId)) {
      return decision(envelope.callId, 'block', PolicyRuleId.ResourceInvalid, 'The quote identifier is path-like or malformed.', context.grant.version);
    }
    if (!context.grant.permittedTools.includes('read_quote')) {
      return decision(envelope.callId, 'block', PolicyRuleId.UnsupportedTool, 'Quote reading is not permitted by the active grant.', context.grant.version);
    }
    if (!context.grant.approvedFileIds.includes(envelope.args.fileId)) {
      return decision(envelope.callId, 'block', PolicyRuleId.ResourceUnauthorized, 'The quote identifier is not authorized by the active grant.', context.grant.version);
    }
    if (!readQuoteArgsSchema.safeParse(envelope.args).success) {
      return decision(envelope.callId, 'block', PolicyRuleId.ResourceUnauthorized, 'The quote identifier is outside the supported manifest.', context.grant.version);
    }
    return decision(envelope.callId, 'allow', PolicyRuleId.AuthorizedRead, 'The quote read is authorized by the active grant.', context.grant.version);
  }

  const parsedEmailArgs = sendClarificationEmailArgsSchema.safeParse(envelope.args);
  if (!parsedEmailArgs.success) {
    return decision(envelope.callId, 'block', PolicyRuleId.InvalidSchema, 'The clarification-email arguments are malformed.', context.grant.version);
  }
  if (!context.grant.permittedTools.includes('send_clarification_email')) {
    return decision(envelope.callId, 'block', PolicyRuleId.UnsupportedTool, 'Clarification email is not permitted by the active grant.', context.grant.version);
  }

  const recipient = normalizeRecipient(parsedEmailArgs.data.recipient);
  const eligibleRecipients = context.grant.eligibleRecipients.map(normalizeRecipient);
  if (!eligibleRecipients.includes(recipient)) {
    return decision(envelope.callId, 'block', PolicyRuleId.RecipientUnauthorized, 'The recipient is not authorized by the active grant.', context.grant.version);
  }
  if (!context.grant.approvalEligibleTools.includes('send_clarification_email')) {
    return decision(envelope.callId, 'block', PolicyRuleId.UnsupportedTool, 'Clarification email is not approval-eligible for this grant.', context.grant.version);
  }
  return decision(envelope.callId, 'request_approval', PolicyRuleId.ApprovalRequired, 'Exact human approval is required before email dispatch.', context.grant.version);
}

/**
 * Frozen v1-compatible export. Callers with lifecycle state should use
 * evaluateStoredToolCall so the grant is resolved from server-owned storage.
 */
export function evaluateToolCall(call: ToolCall, grant: TaskGrant): Decision {
  return evaluatePolicy(call, { grant, status: 'active' });
}

export function evaluateStoredToolCall(input: unknown, store: InMemoryGrantStore, expectedGrantVersion?: string): Decision {
  const envelope = parseEnvelope(input);
  if (envelope === undefined) {
    return evaluatePolicy(input, { status: 'missing', expectedGrantVersion });
  }
  const resolution = store.resolve(envelope.taskId, expectedGrantVersion);
  return evaluatePolicy(input, {
    grant: resolution.record?.grant,
    status: resolution.status,
    expectedGrantVersion
  });
}
