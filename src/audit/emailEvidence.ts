import { createHash } from 'node:crypto';
import { completionClaimSchema } from '../contracts/schemas.js';
import type { CanonicalEmail, EmailDispatchEvidence, Receipt } from '../contracts/types.js';
import { hashEmailAction } from '../security/canonical.js';

export type EmailEvidenceQuery = Omit<EmailDispatchEvidence, 'receiptId'>;

/** Derive evidence only from canonical email bound to a server-owned receipt.
 * Caller remains responsible for keeping this helper inside the trusted server.
 */
export function createEmailEvidence(
  email: CanonicalEmail, receipt: Receipt
): EmailDispatchEvidence {
  const digest = hashEmailAction(email); // Also rejects malformed/noncanonical input.
  if (
    receipt.tool !== email.tool || receipt.taskId !== email.taskId ||
    receipt.callId !== email.callId || receipt.grantVersion !== email.grantVersion ||
    receipt.argsDigest !== digest
  ) {
    throw new Error('Canonical email does not match receipt');
  }
  return {
    taskId: email.taskId,
    callId: email.callId,
    receiptId: receipt.receiptId,
    canonicalRecipient: email.recipient,
    subjectDigest: createHash('sha256').update(email.subject, 'utf8').digest('hex'),
    bodyDigest: createHash('sha256').update(email.body, 'utf8').digest('hex')
  };
}

/** Exact evidence lookup, not a claim-verdict algorithm. */
export function matchesEmailEvidence(
  evidence: EmailDispatchEvidence, query: EmailEvidenceQuery
): boolean {
  const parsed = completionClaimSchema.safeParse({
    claimId: 'evidence-query', kind: 'email_sent',
    taskId: query.taskId, callId: query.callId,
    recipient: query.canonicalRecipient,
    subjectDigest: query.subjectDigest, bodyDigest: query.bodyDigest
  });
  return parsed.success &&
    evidence.taskId === parsed.data.taskId &&
    evidence.callId === parsed.data.callId &&
    evidence.canonicalRecipient === parsed.data.recipient.toLowerCase() &&
    evidence.subjectDigest === parsed.data.subjectDigest &&
    evidence.bodyDigest === parsed.data.bodyDigest;
}
