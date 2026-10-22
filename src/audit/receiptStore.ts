import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  approvalIdSchema, callIdSchema, gatewayToolCallSchema,
  taskGrantSchema, taskIdSchema
} from '../contracts/schemas.js';
import type { EmailDispatchEvidence, Receipt, SecurityDependencies } from '../contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../security/canonical.js';
import { createEmailEvidence, matchesEmailEvidence } from './emailEvidence.js';
import type { EmailEvidenceQuery } from './emailEvidence.js';

const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  receiptId: z.string().uuid(), taskId: taskIdSchema, callId: callIdSchema,
  tool: code, argsDigest: digestSchema, grantVersion: taskGrantSchema.shape.version,
  policyVersion: code, decision: z.enum(['allow', 'block', 'request_approval']),
  ruleId: code, approvalId: approvalIdSchema.optional(),
  executionStatus: z.enum(['succeeded', 'failed', 'not_executed']),
  adapterOutcome: z.enum(['not_invoked', 'adapter_succeeded', 'adapter_failed']),
  timestamp: z.string().datetime()
}).strict();
const evidenceSchema = z.object({
  taskId: taskIdSchema, callId: callIdSchema, receiptId: z.string().uuid(),
  canonicalRecipient: z.string().email().refine((value) => value === value.trim().toLowerCase()),
  subjectDigest: digestSchema, bodyDigest: digestSchema
}).strict();
const eventBase = {
  eventId: z.string().uuid(), timestamp: z.string().datetime()
};
const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...eventBase, kind: z.literal('decision'), receipt: receiptSchema,
    emailEvidence: evidenceSchema.optional()
  }).strict(),
  z.object({
    ...eventBase, kind: z.literal('preflight'), preliminaryReceiptId: z.string().uuid()
  }).strict(),
  z.object({
    ...eventBase, kind: z.literal('outcome'), preliminaryReceiptId: z.string().uuid(),
    receipt: receiptSchema, emailEvidence: evidenceSchema.optional()
  }).strict()
]);
type AuditEvent = z.infer<typeof eventSchema>;
type Attempt = { receipt: Receipt; preflight: boolean; terminal: boolean };

export class OutcomePersistenceError extends Error {
  readonly code = 'OUTCOME_NOT_DURABLY_CONFIRMED';
  constructor(readonly preliminaryReceiptId: string) {
    super('Execution outcome is not durably confirmed; do not resend automatically');
    this.name = 'OutcomePersistenceError';
  }
}

type StoreOptions = {
  path?: string;
  policyVersion: string;
  /** Test seam; production uses a real append-only file handle. */
  openFile?: (path: string) => Promise<FileHandle>;
};

const activePaths = new Set<string>();
function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
function requirePrivatePath(path: string): void {
  if (path.split(/[\\/]/).some((part) => part.toLowerCase() === 'public')) {
    throw new Error('Audit storage must be outside public directories');
  }
}
function key(taskId: string, callId: string): string {
  return JSON.stringify([taskId, callId]);
}
function sameReceipt(left: Receipt, right: Receipt): boolean {
  return JSON.stringify(receiptSchema.parse(left)) === JSON.stringify(receiptSchema.parse(right));
}

/**
 * Synthetic demo evidence: retain for a documented seven-day window and clear
 * only by coordinated operator reset. No automatic retention cleanup exists.
 *
 * Share one store per audit file. All writes are serialized and file-synced.
 * Mode bits are best effort on Windows; deployment must restrict directory ACLs.
 * This is local evidence, not tamper-proof storage or a multi-process lock.
 */
export async function createReceiptStore(options: StoreOptions) {
  const policyVersion = code.parse(options.policyVersion);
  const path = resolve(options.path ?? process.env.TASKGATE_AUDIT_PATH ?? './data/taskgate-audit.jsonl');
  requirePrivatePath(path);
  const reserved = new Set<string>();
  function reserve(value: string) {
    const id = pathKey(value);
    if (reserved.has(id)) return;
    if (activePaths.has(id)) throw new Error('Audit path already has an active store');
    activePaths.add(id);
    reserved.add(id);
  }
  function release() {
    for (const id of reserved) activePaths.delete(id);
  }

  reserve(path);
  let file: FileHandle;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(path));
    requirePrivatePath(parent);
    reserve(join(parent, basename(path)));
    file = await (options.openFile ?? ((name) => open(name, 'a+', 0o600)))(path);
    try {
      const actualPath = await realpath(path);
      requirePrivatePath(actualPath);
      reserve(actualPath);
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    release();
    throw error;
  }

  const receipts = new Map<string, Receipt>();
  const evidence = new Map<string, EmailDispatchEvidence>();
  const attempts = new Map<string, Attempt>();
  const eventIds = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let faulted = false;

  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(() => {
      if (closed) throw new Error('Audit store is closed');
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function apply(event: AuditEvent) {
    if (eventIds.has(event.eventId)) throw new Error('Duplicate audit event ID');
    if (event.kind === 'decision') {
      const receipt = event.receipt;
      if (receipts.has(receipt.receiptId) || receipt.timestamp !== event.timestamp ||
        receipt.executionStatus !== 'not_executed' || receipt.adapterOutcome !== 'not_invoked') {
        throw new Error('Invalid preliminary receipt');
      }
      const callKey = key(receipt.taskId, receipt.callId);
      if (receipt.decision === 'allow' && attempts.has(callKey)) {
        throw new Error('Call already has an authorized attempt');
      }
      checkEvidence(event.emailEvidence, receipt);
      receipts.set(receipt.receiptId, { ...receipt });
      if (event.emailEvidence) evidence.set(receipt.receiptId, { ...event.emailEvidence });
      if (receipt.decision === 'allow') {
        attempts.set(callKey, { receipt: { ...receipt }, preflight: false, terminal: false });
      }
    } else {
      const preliminary = receipts.get(event.preliminaryReceiptId);
      const attempt = preliminary && attempts.get(key(preliminary.taskId, preliminary.callId));
      if (!preliminary || !attempt || attempt.receipt.receiptId !== preliminary.receiptId || attempt.terminal) {
        throw new Error('Unknown or completed authorized attempt');
      }
      if (event.kind === 'preflight') {
        if (attempt.preflight) throw new Error('Dispatch preflight already recorded');
        attempt.preflight = true;
      } else {
        const receipt = event.receipt;
        if (preliminary.tool !== 'read_quote' && !attempt.preflight) {
          throw new Error('Side-effect outcome requires dispatch preflight');
        }
        const expected: Receipt = {
          ...preliminary, receiptId: receipt.receiptId, timestamp: receipt.timestamp,
          executionStatus: receipt.executionStatus, adapterOutcome: receipt.adapterOutcome
        };
        if (receipts.has(receipt.receiptId) || receipt.timestamp !== event.timestamp ||
          !sameReceipt(receipt, expected) || receipt.executionStatus === 'not_executed' ||
          receipt.adapterOutcome !== 'adapter_' + receipt.executionStatus) {
          throw new Error('Invalid terminal receipt');
        }
        checkEvidence(event.emailEvidence, receipt);
        const originalEvidence = evidence.get(preliminary.receiptId);
        if (JSON.stringify(event.emailEvidence) !== JSON.stringify(
          originalEvidence && { ...originalEvidence, receiptId: receipt.receiptId }
        )) {
          throw new Error('Terminal evidence does not match preliminary evidence');
        }
        receipts.set(receipt.receiptId, { ...receipt });
        if (event.emailEvidence) evidence.set(receipt.receiptId, { ...event.emailEvidence });
        attempt.terminal = true;
      }
    }
    eventIds.add(event.eventId);
  }

  function checkEvidence(item: EmailDispatchEvidence | undefined, receipt: Receipt) {
    if (item && (receipt.tool !== 'send_clarification_email' ||
      item.receiptId !== receipt.receiptId || item.taskId !== receipt.taskId || item.callId !== receipt.callId)) {
      throw new Error('Email evidence does not match receipt');
    }
  }

  try {
    const content = await readFile(path, 'utf8');
    if (content && !content.endsWith('\n')) throw new Error('Incomplete audit tail; operator recovery required');
    for (const line of content.split('\n').slice(0, -1)) {
      apply(eventSchema.parse(JSON.parse(line)));
    }
  } catch (error) {
    try { await file.close(); } finally { release(); }
    throw error;
  }

  async function persist(event: AuditEvent) {
    if (faulted) throw new Error('Audit store faulted; operator recovery required');
    const parsed = eventSchema.parse(event);
    try {
      await file.writeFile(JSON.stringify(parsed) + '\n', 'utf8');
      await file.sync();
    } catch {
      // A failed append may have written a partial/full line. Do not retry or
      // publish it as confirmed; stop subsequent writes until operator recovery.
      faulted = true;
      throw new Error('Audit persistence failed; operator recovery required');
    }
    apply(parsed); // Publish to memory only after durable write succeeds.
  }

  const audit: SecurityDependencies['audit'] = {
    recordDecision(input) {
      // Snapshot before queueing, so caller mutation cannot alter queued evidence.
      const snapshot = structuredClone(input);
      return enqueue(async () => {
        const call = z.object({
          taskId: taskIdSchema, callId: callIdSchema, tool: code,
          args: z.unknown(), approvalId: approvalIdSchema.optional()
        }).strict().parse(snapshot.call);
        const grant = taskGrantSchema.parse(snapshot.grant);
        const decision = z.object({
          callId: callIdSchema, decision: z.enum(['allow', 'block', 'request_approval']),
          grantVersion: taskGrantSchema.shape.version, ruleId: code, reason: z.string()
        }).strict().parse(snapshot.decision);
        if (call.taskId !== grant.taskId || call.callId !== decision.callId ||
          decision.grantVersion !== grant.version) throw new Error('Inconsistent decision binding');
        if (decision.decision !== 'block') gatewayToolCallSchema.parse(snapshot.call);
        digestSchema.parse(snapshot.argsDigest);
        const callKey = key(call.taskId, call.callId);
        if (decision.decision === 'allow' && attempts.has(callKey)) {
          throw new Error('Call already has an authorized attempt');
        }
        const receipt: Receipt = {
          receiptId: randomUUID(), taskId: call.taskId, callId: call.callId, tool: call.tool,
          argsDigest: snapshot.argsDigest, grantVersion: grant.version, policyVersion,
          decision: decision.decision, ruleId: decision.ruleId,
          ...(call.approvalId === undefined ? {} : { approvalId: call.approvalId }),
          executionStatus: 'not_executed', adapterOutcome: 'not_invoked',
          timestamp: new Date().toISOString()
        };
        let emailEvidence: EmailDispatchEvidence | undefined;
        if (snapshot.email !== undefined) {
          const expectedDigest = hashEmailAction(canonicalizeEmail(snapshot.call, grant));
          if (hashEmailAction(snapshot.email) !== expectedDigest) {
            throw new Error('Canonical evidence does not match call');
          }
          emailEvidence = createEmailEvidence(snapshot.email, receipt);
        }
        await persist({
          kind: 'decision', eventId: randomUUID(), timestamp: receipt.timestamp,
          receipt: receiptSchema.parse(receipt), ...(emailEvidence ? { emailEvidence } : {})
        });
        return { ...receipt };
      });
    },

    beginDispatch(input) {
      const snapshot = { ...input };
      return enqueue(async () => {
        const request = z.object({ taskId: taskIdSchema, callId: callIdSchema, tool: code }).strict().parse(snapshot);
        const attempt = attempts.get(key(request.taskId, request.callId));
        if (!attempt || attempt.receipt.tool !== request.tool || attempt.preflight || attempt.terminal) {
          throw new Error('No unused matching authorized attempt for dispatch preflight');
        }
        await persist({
          kind: 'preflight', eventId: randomUUID(), timestamp: new Date().toISOString(),
          preliminaryReceiptId: attempt.receipt.receiptId
        });
      });
    },

    recordOutcome(input) {
      const snapshot = structuredClone(input);
      return enqueue(async () => {
        const preliminary = receiptSchema.parse(snapshot.preliminaryReceipt);
        const stored = receipts.get(preliminary.receiptId);
        const attempt = attempts.get(key(preliminary.taskId, preliminary.callId));
        if (!stored || !sameReceipt(stored, preliminary) || !attempt ||
          attempt.receipt.receiptId !== preliminary.receiptId || attempt.terminal ||
          (preliminary.tool !== 'read_quote' && !attempt.preflight)) {
          throw new Error('Outcome requires a matching unfinished authorized receipt');
        }
        const status = z.enum(['succeeded', 'failed']).parse(snapshot.status);
        z.string().parse(snapshot.adapterOutcome);
        // Do not persist arbitrary adapter text: it may echo raw mail or secrets.
        const receipt: Receipt = {
          ...stored, receiptId: randomUUID(), timestamp: new Date().toISOString(),
          executionStatus: status, adapterOutcome: 'adapter_' + status
        };
        const originalEvidence = evidence.get(stored.receiptId);
        try {
          await persist({
            kind: 'outcome', eventId: randomUUID(), timestamp: receipt.timestamp,
            preliminaryReceiptId: stored.receiptId, receipt: receiptSchema.parse(receipt),
            ...(originalEvidence ? { emailEvidence: { ...originalEvidence, receiptId: receipt.receiptId } } : {})
          });
        } catch {
          throw new OutcomePersistenceError(stored.receiptId);
        }
        return { ...receipt };
      });
    },

    listReceipts(taskId) {
      return enqueue(() => {
        const filter = taskId === undefined ? undefined : taskIdSchema.parse(taskId);
        return Array.from(receipts.values())
          .filter((receipt) => filter === undefined || receipt.taskId === filter)
          .map((receipt) => ({ ...receipt }));
      });
    }
  };

  return {
    audit,
    findEmailEvidence(query: EmailEvidenceQuery): Promise<EmailDispatchEvidence[]> {
      const snapshot = { ...query };
      return enqueue(() => Array.from(evidence.values())
        .filter((item) => matchesEmailEvidence(item, snapshot)).map((item) => ({ ...item })));
    },
    listUnresolvedDispatches(): Promise<Receipt[]> {
      return enqueue(() => Array.from(attempts.values())
        .filter((attempt) => attempt.preflight && !attempt.terminal)
        .map((attempt) => ({ ...attempt.receipt })));
    },
    close(): Promise<void> {
      return enqueue(async () => {
        closed = true;
        try { await file.close(); } finally { release(); }
      });
    }
  };
}
