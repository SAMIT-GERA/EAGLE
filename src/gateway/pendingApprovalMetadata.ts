import type { CanonicalEmail } from '../contracts/types.js';

export type PendingApprovalLifecycle = 'pending' | 'consumed' | 'invalidated';

export type PendingApprovalMetadata = Readonly<{
  taskId: string;
  callId: string;
  grantVersion: string;
  digest: string;
  email: Readonly<CanonicalEmail>;
  state: PendingApprovalLifecycle;
}>;

function key(taskId: string, callId: string): string {
  return JSON.stringify([taskId, callId]);
}

function cloneEmail(email: CanonicalEmail): CanonicalEmail {
  return { ...email };
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

function snapshot(entry: PendingApprovalMetadata): PendingApprovalMetadata {
  return Object.freeze({
    ...entry,
    email: Object.freeze(cloneEmail(entry.email))
  });
}

/**
 * Server-only correlation state for a pending approval. It is intentionally
 * separate from the frozen approval port: Eeshaan's approval service remains
 * the sole issuer and consumer of approvals. This in-memory bridge is lost at
 * restart, so old pending approvals fail closed rather than being reconstructed
 * from operator-visible fields.
 */
export class PendingApprovalMetadataStore {
  private readonly entries = new Map<string, PendingApprovalMetadata>();

  register(email: CanonicalEmail, digest: string): void {
    const entry = snapshot({
      taskId: email.taskId,
      callId: email.callId,
      grantVersion: email.grantVersion,
      digest,
      email,
      state: 'pending'
    });
    const existing = this.entries.get(key(entry.taskId, entry.callId));
    if (existing === undefined) {
      this.entries.set(key(entry.taskId, entry.callId), entry);
      return;
    }
    if (existing.state !== 'pending' || existing.digest !== entry.digest || !sameEmail(existing.email, entry.email)) {
      throw new Error('Pending approval metadata conflicts with the existing trusted action.');
    }
  }

  get(taskId: string, callId: string): PendingApprovalMetadata | undefined {
    const entry = this.entries.get(key(taskId, callId));
    return entry === undefined ? undefined : snapshot(entry);
  }

  matchesPending(email: CanonicalEmail, digest: string): boolean {
    const entry = this.entries.get(key(email.taskId, email.callId));
    return entry !== undefined && entry.state === 'pending' && entry.digest === digest && sameEmail(entry.email, email);
  }

  markConsumed(email: CanonicalEmail, digest: string): void {
    const entry = this.entries.get(key(email.taskId, email.callId));
    if (entry === undefined || entry.state !== 'pending' || entry.digest !== digest || !sameEmail(entry.email, email)) {
      throw new Error('Pending approval metadata is missing or changed.');
    }
    this.entries.set(key(email.taskId, email.callId), snapshot({ ...entry, state: 'consumed' }));
  }

  invalidate(taskId: string, callId: string): void {
    const entry = this.entries.get(key(taskId, callId));
    if (entry !== undefined && entry.state === 'pending') {
      this.entries.set(key(taskId, callId), snapshot({ ...entry, state: 'invalidated' }));
    }
  }
}
