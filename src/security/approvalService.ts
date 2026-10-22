import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { callIdSchema, taskIdSchema } from '../contracts/schemas.js';
import type { Approval, CanonicalEmail, SecurityDependencies } from '../contracts/types.js';
import { hashEmailAction } from './canonical.js';

const APPROVAL_TTL_MS = 3 * 60 * 1_000;
const approvalRequestSchema = z.object({
  taskId: taskIdSchema,
  callId: callIdSchema,
  approvedBy: z.string().trim().min(1)
}).strict();

type PendingEntry = {
  email: CanonicalEmail;
  digest: string;
  approval?: Approval;
};

function pendingKey(taskId: string, callId: string): string {
  return JSON.stringify([taskId, callId]);
}

function sameEmail(left: CanonicalEmail, right: CanonicalEmail): boolean {
  return left.taskId === right.taskId &&
    left.grantVersion === right.grantVersion &&
    left.callId === right.callId &&
    left.tool === right.tool &&
    left.recipient === right.recipient &&
    left.subject === right.subject &&
    left.body === right.body;
}

/**
 * One private, in-memory state store per instance. Production must share ONE
 * instance between operator routes and gateway dispatch; tests use fresh ones.
 * No persistence, cross-process locking, policy decisions or operator auth.
 */
export function createApprovalService(): SecurityDependencies['approvalService'] {
  const pending = new Map<string, PendingEntry>();
  const issuedIds = new Set<string>();

  return {
    async registerPending(email, digest) {
      const snapshot = { ...email };
      const calculatedDigest = hashEmailAction(snapshot);
      if (digest !== calculatedDigest) {
        throw new Error('Pending email digest does not match canonical action');
      }

      const key = pendingKey(snapshot.taskId, snapshot.callId);
      const existing = pending.get(key);
      if (existing) {
        if (existing.approval?.used) {
          throw new Error('Call authorization has already been consumed');
        }
        if (existing.digest !== digest || !sameEmail(existing.email, snapshot)) {
          throw new Error('Conflicting pending action for taskId/callId');
        }
        return; // Idempotent; never replace the action or extend an approval.
      }

      pending.set(key, { email: snapshot, digest });
    },

    async approvePending(input) {
      // Trusted operator route must authenticate before calling this method.
      const request = approvalRequestSchema.parse(input);
      const entry = pending.get(pendingKey(request.taskId, request.callId));
      if (!entry) {
        throw new Error('No pending action for taskId/callId');
      }
      if (entry.approval?.used) {
        throw new Error('Call authorization has already been consumed');
      }

      const now = Date.now();
      if (entry.approval && now < Date.parse(entry.approval.expiresAt)) {
        // A duplicate human request does not mint another credential or extend TTL.
        return {
          approvalId: entry.approval.approvalId,
          expiresAt: entry.approval.expiresAt
        };
      }

      const approvalId = randomUUID();
      if (issuedIds.has(approvalId)) {
        throw new Error('Approval ID collision');
      }
      const approval: Approval = {
        approvalId,
        taskId: entry.email.taskId,
        callId: entry.email.callId,
        grantVersion: entry.email.grantVersion,
        callDigest: entry.digest,
        expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
        used: false,
        approvedBy: request.approvedBy
      };
      issuedIds.add(approvalId);
      entry.approval = approval; // Replaces an expired credential, never reactivates it.
      return { approvalId: approval.approvalId, expiresAt: approval.expiresAt };
    },

    async validateAndConsume(input) {
      // Invalid/noncanonical runtime input is a denial, not an execution permit.
      try {
        const email = { ...input.email };
        const calculatedDigest = hashEmailAction(email);
        const entry = pending.get(pendingKey(email.taskId, email.callId));
        const approval = entry?.approval;
        if (!entry || !approval || approval.approvalId !== input.approvalId || approval.used) {
          return false;
        }
        if (Date.now() >= Date.parse(approval.expiresAt)) {
          // Once observed expired, this credential stays invalid even if the
          // wall clock later moves backward. Explicit approval can issue a new one.
          entry.approval = undefined;
          return false;
        }
        if (
          approval.taskId !== email.taskId ||
          approval.callId !== email.callId ||
          approval.grantVersion !== email.grantVersion ||
          input.digest !== calculatedDigest ||
          input.digest !== approval.callDigest ||
          input.digest !== entry.digest ||
          !sameEmail(entry.email, email)
        ) {
          return false;
        }

        // Atomic within this instance on one Node event loop: NO await before
        // marking used. Keep the spent record to prevent re-registration/reissue.
        approval.used = true;
        return true;
      } catch {
        return false;
      }
    },

    async listPending() {
      // Trusted internal method: body/subject redaction belongs at the HTTP boundary.
      // Include awaiting/approved/expired-unconsumed calls, exclude spent calls.
      return Array.from(pending.values())
        .filter((entry) => !entry.approval?.used)
        .map(({ email }) => ({
          taskId: email.taskId,
          callId: email.callId,
          recipient: email.recipient,
          subject: email.subject,
          body: email.body
        }));
    }
  };
}

// Shared default instance for future dependency injection. Never expose its
// approval methods as model tools or create a new instance per HTTP request.
export const approvalService = createApprovalService();
