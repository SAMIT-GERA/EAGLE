import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockMailAdapter } from '../src/adapters/mockMail.js';
import { createDefaultQuoteReader, SyntheticQuoteReader, UnknownQuoteIdError } from '../src/adapters/quoteReader.js';
import { ControlledAdapterWiring, UnknownAdapterIdError } from '../src/adapters/wiring.js';

const canonicalEmail = {
  taskId: 'task-1', grantVersion: 'v1', callId: 'call-email-1', tool: 'send_clarification_email' as const,
  recipient: 'supplier@example.test', subject: 'Clarification', body: 'Please confirm lead time.'
};

describe('controlled synthetic adapters', () => {
  it('reads deterministic server-owned quote fixtures and preserves untrusted document text as data', async () => {
    const reader = await createDefaultQuoteReader();
    const first = reader.read('quote-B');
    const second = reader.read('quote-B');

    expect(reader.getProfileId()).toBe('procurement-v1');
    expect(first).toEqual(second);
    expect(first.documentText).toContain('external-attacker@example.test');
    expect(first.documentText).toContain('untrusted document data');
    expect(first).not.toHaveProperty('authorization');
  });

  it('rejects unknown, URL-like, and path-like quote identifiers', async () => {
    const reader = await createDefaultQuoteReader();
    for (const fileId of ['quote-C', '../quote-A', 'C:\\quote-A', 'https://example.test/quote-A']) {
      expect(() => reader.read(fileId)).toThrow(UnknownQuoteIdError);
    }
  });

  it('enforces server-owned manifest membership without performing authorization', () => {
    const reader = new SyntheticQuoteReader({
      profileId: 'restricted-profile',
      quotes: {
        'quote-A': {
          fileId: 'quote-A', supplier: 'Synthetic', item: 'Laptop', quantity: 1, currency: 'INR',
          unitPrice: 1, leadTimeDays: 1, paymentTerms: 'Net 1', documentText: 'Data only.'
        }
      }
    });

    expect(reader.listQuoteIds()).toEqual(['quote-A']);
    expect(() => reader.read('quote-B')).toThrow(UnknownQuoteIdError);
    expect(reader.read('quote-A').supplier).toBe('Synthetic');
  });

  it('records deterministic success evidence without retaining raw subject or body', () => {
    const mail = new MockMailAdapter('succeed', () => new Date('2026-10-22T00:00:00.000Z'));
    const result = mail.send(canonicalEmail);

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.evidence).toMatchObject({ attemptId: 'mock-mail-1', taskId: 'task-1', callId: 'call-email-1' });
      expect(result.evidence.subjectDigest).toBe(createHash('sha256').update(canonicalEmail.subject).digest('hex'));
      expect(JSON.stringify(result.evidence)).not.toContain(canonicalEmail.body);
    }
    expect(mail.listEvidence()).toHaveLength(1);
    expect(mail.listAttempts()).toEqual([{ attemptId: 'mock-mail-1', taskId: 'task-1', callId: 'call-email-1', outcome: 'succeeded', executedAt: '2026-10-22T00:00:00.000Z' }]);
    const evidenceView = mail.listEvidence();
    Reflect.set(evidenceView[0], 'taskId', 'changed-view-only');
    expect(mail.listEvidence()[0]?.taskId).toBe('task-1');
  });

  it('reports definite failure without fabricating successful evidence', () => {
    const mail = new MockMailAdapter('fail', () => new Date('2026-10-22T00:00:00.000Z'));
    const result = mail.send(canonicalEmail);

    expect(result).toEqual({ outcome: 'failed', code: 'MOCK_MAIL_FAILURE', message: 'Mock mail is configured to fail.' });
    expect(mail.listEvidence()).toEqual([]);
    expect(mail.listAttempts()).toMatchObject([{ outcome: 'failed', callId: 'call-email-1' }]);
  });

  it('uses only server-owned mode configuration and resolves only stable adapter IDs', async () => {
    const reader = await createDefaultQuoteReader();
    const mail = new MockMailAdapter();
    const wiring = new ControlledAdapterWiring(reader, mail);

    expect(wiring.resolve('quote-reader')).toBe(reader);
    expect(wiring.resolve('mock-mail')).toBe(mail);
    expect(() => wiring.resolve('shell')).toThrow(UnknownAdapterIdError);
    expect(mail.getMode()).toBe('succeed');
    mail.setMode('fail');
    expect(mail.getMode()).toBe('fail');
  });

  it('rejects non-canonical mail inputs without making an attempt', () => {
    const mail = new MockMailAdapter();
    expect(() => Reflect.apply(mail.send, mail, [{ ...canonicalEmail, tool: 'read_quote' }])).toThrow();
    expect(mail.listAttempts()).toEqual([]);
  });
});
