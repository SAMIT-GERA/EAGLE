import { taskGrantSchema } from '../contracts/schemas.js';
import type { TaskGrant } from '../contracts/types.js';

export type Clock = () => Date;
export type GrantLifecycleStatus = 'active' | 'expired' | 'revoked';

export type GrantRecord = {
  grant: TaskGrant;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  status: GrantLifecycleStatus;
};

export type GrantResolution = {
  status: GrantLifecycleStatus | 'missing' | 'version_mismatch';
  record?: GrantRecord;
};

export type CreateGrantOptions = {
  expiresAt?: Date | string;
};

export class GrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantValidationError';
  }
}

export class DuplicateGrantError extends Error {
  constructor(taskId: string, version: string) {
    super(`Grant ${taskId}@${version} already exists.`);
    this.name = 'DuplicateGrantError';
  }
}

type StoredGrant = Omit<GrantRecord, 'status'> & { revokedAt?: string };

function cloneGrant(grant: TaskGrant): TaskGrant {
  return {
    ...grant,
    approvedFileIds: [...grant.approvedFileIds],
    permittedTools: [...grant.permittedTools],
    prohibitedOperations: [...grant.prohibitedOperations],
    eligibleRecipients: [...grant.eligibleRecipients],
    approvalEligibleTools: [...grant.approvalEligibleTools]
  };
}

function cloneRecord(record: StoredGrant, status: GrantLifecycleStatus): GrantRecord {
  return {
    grant: cloneGrant(record.grant),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    status
  };
}

function parseExpiry(expiresAt: Date | string | undefined): string | undefined {
  if (expiresAt === undefined) {
    return undefined;
  }

  const parsed = expiresAt instanceof Date ? new Date(expiresAt.getTime()) : new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new GrantValidationError('Grant expiry must be a valid date.');
  }

  return parsed.toISOString();
}

/**
 * Server-owned, in-memory lifecycle state. Expiry and revocation information is
 * intentionally not durable and is lost when this process restarts.
 */
export class InMemoryGrantStore {
  private readonly grantsByTaskId = new Map<string, Map<string, StoredGrant>>();
  private readonly activeVersionByTaskId = new Map<string, string>();

  constructor(private readonly now: Clock = () => new Date()) {}

  create(input: unknown, options: CreateGrantOptions = {}): GrantRecord {
    const parsed = taskGrantSchema.safeParse(input);
    if (!parsed.success) {
      throw new GrantValidationError('Grant does not match the frozen TaskGrant schema.');
    }

    const grant = cloneGrant(parsed.data);
    const taskGrants = this.grantsByTaskId.get(grant.taskId) ?? new Map<string, StoredGrant>();
    if (taskGrants.has(grant.version)) {
      throw new DuplicateGrantError(grant.taskId, grant.version);
    }

    const timestamp = this.now().toISOString();
    const previousVersion = this.activeVersionByTaskId.get(grant.taskId);
    if (previousVersion !== undefined) {
      const previous = taskGrants.get(previousVersion);
      if (previous !== undefined && previous.revokedAt === undefined) {
        previous.revokedAt = timestamp;
      }
    }

    const record: StoredGrant = {
      grant,
      createdAt: timestamp,
      expiresAt: parseExpiry(options.expiresAt)
    };
    taskGrants.set(grant.version, record);
    this.grantsByTaskId.set(grant.taskId, taskGrants);
    this.activeVersionByTaskId.set(grant.taskId, grant.version);

    return cloneRecord(record, this.statusOf(record));
  }

  replace(input: unknown, options: CreateGrantOptions = {}): GrantRecord {
    return this.create(input, options);
  }

  revoke(taskId: string, version?: string): boolean {
    const targetVersion = version ?? this.activeVersionByTaskId.get(taskId);
    if (targetVersion === undefined) {
      return false;
    }

    const record = this.grantsByTaskId.get(taskId)?.get(targetVersion);
    if (record === undefined || record.revokedAt !== undefined) {
      return false;
    }

    record.revokedAt = this.now().toISOString();
    if (this.activeVersionByTaskId.get(taskId) === targetVersion) {
      this.activeVersionByTaskId.delete(taskId);
    }
    return true;
  }

  get(taskId: string, version?: string): GrantRecord | undefined {
    const targetVersion = version ?? this.activeVersionByTaskId.get(taskId);
    if (targetVersion === undefined) {
      return undefined;
    }

    const record = this.grantsByTaskId.get(taskId)?.get(targetVersion);
    return record === undefined ? undefined : cloneRecord(record, this.statusOf(record));
  }

  resolve(taskId: string, expectedVersion?: string): GrantResolution {
    const activeVersion = this.activeVersionByTaskId.get(taskId);
    if (activeVersion === undefined) {
      return { status: 'missing' };
    }

    const record = this.grantsByTaskId.get(taskId)?.get(activeVersion);
    if (record === undefined) {
      return { status: 'missing' };
    }

    const status = this.statusOf(record);
    const cloned = cloneRecord(record, status);
    if (status !== 'active') {
      return { status, record: cloned };
    }
    if (expectedVersion !== undefined && expectedVersion !== record.grant.version) {
      return { status: 'version_mismatch', record: cloned };
    }
    return { status: 'active', record: cloned };
  }

  private statusOf(record: StoredGrant): GrantLifecycleStatus {
    if (record.revokedAt !== undefined) {
      return 'revoked';
    }
    if (record.expiresAt !== undefined && new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      return 'expired';
    }
    return 'active';
  }
}
