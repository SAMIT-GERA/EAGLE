import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalEmail } from '../contracts/types.js';
import type { Clock } from '../gateway/grants.js';

export type MockMailMode = 'succeed' | 'fail';
export type MockMailEvidence = {
  attemptId: string;
  taskId: string;
  callId: string;
  canonicalRecipient: string;
  subjectDigest: string;
  bodyDigest: string;
  executedAt: string;
};
export type MockMailResult =
  | { outcome: 'succeeded'; evidence: MockMailEvidence }
  | { outcome: 'failed'; code: 'MOCK_MAIL_FAILURE'; message: string };
export type MockMailAttempt = {
  attemptId: string;
  taskId: string;
  callId: string;
  outcome: MockMailResult['outcome'];
  executedAt: string;
};

const canonicalEmailSchema = z.object({
  taskId: z.string().min(1),
  grantVersion: z.string().min(1),
  callId: z.string().min(1),
  tool: z.literal('send_clarification_email'),
  recipient: z.string().min(1).email(),
  subject: z.string().min(1),
  body: z.string().min(1)
}).strict();

export class InvalidCanonicalEmailError extends Error {
  constructor() {
    super('Mock mail accepts only a valid canonical clarification-email action.');
    this.name = 'InvalidCanonicalEmailError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cloneEvidence(evidence: MockMailEvidence): MockMailEvidence {
  return { ...evidence };
}

/**
 * A network-free adapter for gateway-owned, already-canonical email actions.
 * It performs no permission, approval, policy, or audit decisions.
 */
export class MockMailAdapter {
  private mode: MockMailMode;
  private attemptSequence = 0;
  private readonly evidence: MockMailEvidence[] = [];
  private readonly attempts: MockMailAttempt[] = [];

  constructor(initialMode: MockMailMode = 'succeed', private readonly now: Clock = () => new Date()) {
    this.mode = initialMode;
  }

  setMode(mode: MockMailMode): void {
    this.mode = mode;
  }

  getMode(): MockMailMode {
    return this.mode;
  }

  send(input: CanonicalEmail): MockMailResult {
    const parsed = canonicalEmailSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidCanonicalEmailError();
    }

    this.attemptSequence += 1;
    const attemptId = `mock-mail-${this.attemptSequence}`;
    const executedAt = this.now().toISOString();
    if (this.mode === 'fail') {
      this.attempts.push({ attemptId, taskId: parsed.data.taskId, callId: parsed.data.callId, outcome: 'failed', executedAt });
      return { outcome: 'failed', code: 'MOCK_MAIL_FAILURE', message: 'Mock mail is configured to fail.' };
    }

    const evidence: MockMailEvidence = {
      attemptId,
      taskId: parsed.data.taskId,
      callId: parsed.data.callId,
      canonicalRecipient: parsed.data.recipient,
      subjectDigest: sha256(parsed.data.subject),
      bodyDigest: sha256(parsed.data.body),
      executedAt
    };
    this.evidence.push(evidence);
    this.attempts.push({ attemptId, taskId: evidence.taskId, callId: evidence.callId, outcome: 'succeeded', executedAt });
    return { outcome: 'succeeded', evidence: cloneEvidence(evidence) };
  }

  listEvidence(): readonly MockMailEvidence[] {
    return Object.freeze(this.evidence.map(cloneEvidence));
  }

  listAttempts(): readonly MockMailAttempt[] {
    return Object.freeze(this.attempts.map((attempt) => ({ ...attempt })));
  }

  reset(): void {
    this.attemptSequence = 0;
    this.evidence.length = 0;
    this.attempts.length = 0;
  }
}
