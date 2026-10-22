import { z } from 'zod';
import {
  approvalIdSchema, callIdSchema, completionClaimSchema, taskGrantSchema, taskIdSchema
} from '../contracts/schemas.js';
import type { ClaimCheck, CompletionClaim, Receipt, SecurityDependencies } from '../contracts/types.js';
import { matchesEmailEvidence } from './emailEvidence.js';
import type { EmailEvidenceQuery } from './emailEvidence.js';
import type { createReceiptStore } from './receiptStore.js';

type Store = Awaited<ReturnType<typeof createReceiptStore>>;
export type ClaimVerifierDependencies =
  Pick<Store, 'findEmailEvidence' | 'listUnresolvedDispatches'> & {
    audit: Pick<SecurityDependencies['audit'], 'listReceipts'>;
  };

// Internal read-boundary validation only; no new domain types or public DTOs.
const receiptSchema = z.object({
  receiptId: z.string().uuid(), taskId: taskIdSchema, callId: callIdSchema,
  tool: z.string().min(1), argsDigest: completionClaimSchema.shape.bodyDigest,
  grantVersion: taskGrantSchema.shape.version, policyVersion: z.string().min(1),
  decision: z.enum(['allow', 'block', 'request_approval']), ruleId: z.string().min(1),
  approvalId: approvalIdSchema.optional(),
  executionStatus: z.enum(['not_executed', 'succeeded', 'failed']),
  adapterOutcome: z.string(), timestamp: z.string().datetime()
}).strict();
const evidenceSchema = z.object({
  taskId: taskIdSchema, callId: callIdSchema, receiptId: z.string().uuid(),
  canonicalRecipient: completionClaimSchema.shape.recipient.refine(
    (value) => value === value.toLowerCase()
  ),
  subjectDigest: completionClaimSchema.shape.subjectDigest,
  bodyDigest: completionClaimSchema.shape.bodyDigest
}).strict();

function parseRows<T extends z.ZodRawShape>(schema: z.ZodObject<T>, input: unknown) {
  const rows = z.array(schema).parse(input);
  // Trusted stored identifiers must already be canonical. Never repair malformed
  // evidence into a match using the input schemas' trimming transformations.
  const originals = input as Array<Record<string, unknown>>;
  for (let index = 0; index < rows.length; index++) {
    if (Object.entries(rows[index]).some(([field, value]) => originals[index][field] !== value)) {
      throw new Error('Noncanonical stored evidence');
    }
  }
  return rows;
}

function receiptSnapshot(receipts: Receipt[]): string {
  return JSON.stringify([...receipts].sort((left, right) =>
    left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0
  ));
}

/**
 * Read-only verification for TaskGate-controlled email actions. Dependencies
 * must come from ONE trusted append-only store, never model-provided records.
 * Input validation rejects malformed claims; read failures return missing_evidence.
 */
export function createClaimVerifier(dependencies: ClaimVerifierDependencies) {
  return {
    async verifyClaim(input: unknown): Promise<ClaimCheck> {
      const claim: CompletionClaim = completionClaimSchema.parse(input);
      const query: EmailEvidenceQuery = {
        taskId: claim.taskId, callId: claim.callId,
        canonicalRecipient: claim.recipient.toLowerCase(),
        subjectDigest: claim.subjectDigest, bodyDigest: claim.bodyDigest
      };
      const result = (
        verdict: ClaimCheck['verdict'], explanation: string, matchingReceiptIds: string[] = []
      ): ClaimCheck => ({ claimId: claim.claimId, verdict, matchingReceiptIds, explanation });

      try {
        // These reads are deliberately sequential. Receipt scans bracket the
        // evidence/intent reads; changes yield uncertainty, not a stale verdict.
        const before = parseRows(receiptSchema, await dependencies.audit.listReceipts(claim.taskId));
        const evidence = parseRows(evidenceSchema, await dependencies.findEmailEvidence({ ...query }));
        const unresolved = parseRows(receiptSchema, await dependencies.listUnresolvedDispatches());
        const after = parseRows(receiptSchema, await dependencies.audit.listReceipts(claim.taskId));
        if (receiptSnapshot(before) !== receiptSnapshot(after)) {
          return result('missing_evidence', 'Audit records changed during verification; verify again when stable.');
        }
        if (new Set(after.map((receipt) => receipt.receiptId)).size !== after.length) {
          return result('missing_evidence', 'Stored receipt identifiers are inconsistent.');
        }

        const sameCall = (receipt: Receipt) =>
          receipt.taskId === claim.taskId && receipt.callId === claim.callId &&
          receipt.tool === 'send_clarification_email';
        const callReceipts = after.filter(sameCall);
        const exactEvidence = evidence.filter((item) => matchesEmailEvidence(item, query));
        const evidenceIds = new Set(exactEvidence.map((item) => item.receiptId));
        const matching = callReceipts.filter((receipt) => evidenceIds.has(receipt.receiptId));
        const ids = matching.map((receipt) => receipt.receiptId).sort();

        if (exactEvidence.some((item) => !matching.some((receipt) => receipt.receiptId === item.receiptId))) {
          return result('missing_evidence', 'Exact email evidence lacks a matching trusted receipt.', ids);
        }
        if (matching.length === 0) {
          return result('missing_evidence', 'No exact email evidence and matching receipt were found.');
        }

        // An intent can lack an exact evidence row; conservatively check the whole
        // task/call before using an earlier blocked/pending record as a non-send.
        if (unresolved.some(sameCall)) {
          return result('missing_evidence', 'Dispatch began without a durably confirmed terminal outcome; delivery is uncertain.', ids);
        }
        if (callReceipts.some((receipt) =>
          receipt.executionStatus !== 'not_executed' && receipt.decision !== 'allow'
        )) {
          return result('missing_evidence', 'Stored decision and execution evidence are inconsistent.', ids);
        }

        const terminal = matching.filter((receipt) => receipt.executionStatus !== 'not_executed');
        if (terminal.length > 1) {
          return result('missing_evidence', 'Multiple terminal receipts make the exact execution outcome ambiguous.', ids);
        }
        if (terminal.length === 1) {
          if (terminal[0].executionStatus === 'succeeded') {
            return result('supported', 'A matching durably recorded successful execution supports this email_sent claim.', ids);
          }
          return result('contradiction', 'A matching durably recorded failed execution contradicts this email_sent claim within TaskGate.', ids);
        }

        // Authorization is not execution evidence. This also covers a later
        // allowed attempt whose canonical evidence is absent from the lookup.
        if (callReceipts.some((receipt) => receipt.decision === 'allow')) {
          return result('missing_evidence', 'Authorization exists without a matching confirmed terminal outcome.', ids);
        }
        return result(
          'contradiction',
          'The exact action was blocked or pending approval with no recorded dispatch; this contradicts email_sent within TaskGate.',
          ids
        );
      } catch {
        // Never copy exception messages: storage errors may contain sensitive data.
        return result('missing_evidence', 'Trusted audit or email evidence could not be read consistently.');
      }
    }
  };
}
