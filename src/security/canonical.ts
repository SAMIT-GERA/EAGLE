import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  callIdSchema,
  sendClarificationEmailArgsSchema,
  sendClarificationEmailToolCallSchema,
  taskGrantSchema,
  taskIdSchema
} from '../contracts/schemas.js';
import type { CanonicalEmail, TaskGrant, ToolCall } from '../contracts/types.js';

const HASH_DOMAIN = 'taskgate:canonical-email:v1';

// Reuse frozen validators without adding or changing any shared contract.
const canonicalEmailSchema = z.object({
  taskId: taskIdSchema,
  grantVersion: taskGrantSchema.shape.version,
  callId: callIdSchema,
  tool: sendClarificationEmailToolCallSchema.shape.tool,
  ...sendClarificationEmailArgsSchema.shape
}).strict();

function normalizeMessage(value: string): string {
  // Preserve spaces, tabs, lone CR characters and ALL trailing LF characters.
  return value.replace(/\r\n/g, '\n');
}

/**
 * Validate structure and bind the email to the supplied grant's task/version.
 * This does not authorize the recipient or check whether the grant is active.
 * Frozen identifier schemas trim surrounding whitespace before binding.
 */
export function canonicalizeEmail(call: ToolCall, grant: TaskGrant): CanonicalEmail {
  const parsedCall = sendClarificationEmailToolCallSchema.parse(call);
  const taskId = taskIdSchema.parse(grant.taskId);
  const grantVersion = taskGrantSchema.shape.version.parse(grant.version);

  if (parsedCall.taskId !== taskId) {
    throw new Error('Email call taskId does not match grant taskId');
  }

  return {
    taskId,
    grantVersion,
    callId: parsedCall.callId,
    tool: parsedCall.tool,
    recipient: parsedCall.args.recipient.toLowerCase(),
    subject: normalizeMessage(parsedCall.args.subject),
    body: normalizeMessage(parsedCall.args.body)
  };
}

/**
 * Hash an already canonical email. Reject noncanonical input instead of
 * silently applying different normalization during approval/evidence checks.
 */
export function hashEmailAction(email: CanonicalEmail): string {
  const parsed = canonicalEmailSchema.parse(email);
  const changedByValidation = Object.entries(parsed).some(
    ([key, value]) => email[key as keyof CanonicalEmail] !== value
  );

  if (
    changedByValidation ||
    parsed.recipient !== parsed.recipient.toLowerCase() ||
    parsed.subject !== normalizeMessage(parsed.subject) ||
    parsed.body !== normalizeMessage(parsed.body)
  ) {
    throw new Error('Email must be canonicalized before hashing');
  }

  // JSON escaping and array boundaries prevent concatenation/delimiter ambiguity.
  // The domain versions this format without extending the public email type.
  const serialized = JSON.stringify([
    HASH_DOMAIN,
    parsed.taskId,
    parsed.grantVersion,
    parsed.callId,
    parsed.tool,
    parsed.recipient,
    parsed.subject,
    parsed.body
  ]);

  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
