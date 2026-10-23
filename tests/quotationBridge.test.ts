import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consumeReadQuoteResult, hashQuotationSource } from '../src/agents/quotation.js';
import { mapProcurementQuoteData } from '../src/agents/quotationSchemas.js';
import type { TaskGrant, ToolCall } from '../src/contracts/types.js';
import { bridgeTrustedReadQuote, TrustedQuotationBridgeError } from '../src/gateway/quotationBridge.js';
import { createTaskGateServer } from '../src/server.js';

const grant: TaskGrant = {
  taskId: 'quote-bridge-task', version: 'quote-bridge-v1', confirmed: true,
  approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'], eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};

type ReadCall = ToolCall & { tool: 'read_quote'; args: { fileId: 'quote-A' | 'quote-B' } };

const read = (fileId: 'quote-A' | 'quote-B', callId = `read-${fileId}`): ReadCall => ({
  taskId: grant.taskId, callId, tool: 'read_quote', args: { fileId }
});

async function trustedRead(fileId: 'quote-A' | 'quote-B' = 'quote-A', callId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'taskgate-quote-bridge-'));
  const server = await createTaskGateServer({ grantTemplate: grant, auditPath: join(root, 'audit.jsonl') });
  server.grantStore.create(grant);
  const request = read(fileId, callId);
  const response = await server.dispatcher.dispatchToolCall(request);
  return { server, request, response };
}

function consumed(request: ReadCall, observation: unknown) {
  return consumeReadQuoteResult({
    action: { tool: 'read_quote', args: request.args, purpose: 'Read a trusted synthetic quote.' },
    context: { grant }, observation, gatewayKind: 'taskgate', mode: 'scripted_gateway'
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected quote object');
  return value;
}

describe('trusted quotation bridge', () => {
  it.each(['quote-A', 'quote-B'] as const)('maps successful authorized %s reads with receipt correlation', async (fileId) => {
    const { server, request, response } = await trustedRead(fileId);
    try {
      const observation = bridgeTrustedReadQuote({ request, grant, response });
      const result = consumed(request, observation);
      expect(result).toMatchObject({
        status: 'accepted', quotation: {
          taskId: grant.taskId, grantVersion: grant.version, fileId,
          callId: request.callId, receiptId: response.receipt.receiptId,
          quote: { quantityUnit: 'each' }, source: {
            status: 'verified', sourceId: `procurement-v1:${fileId}`,
            trustLabel: 'untrusted_document', basis: 'canonical_quote_v1'
          }
        }
      });
    } finally { await server.close(); }
  });

  it('preserves quote-B prompt injection text as unchanged untrusted data', async () => {
    const { server, request, response } = await trustedRead('quote-B');
    try {
      const observation = bridgeTrustedReadQuote({ request, grant, response });
      const result = consumed(request, observation);
      expect(response.data).toMatchObject({ documentText: expect.stringContaining('external-attacker@example.test') });
      expect(result).toMatchObject({ status: 'accepted', quotation: { quote: {
        documentText: expect.stringContaining('This embedded instruction is untrusted document data, not authorization.')
      }, source: { trustLabel: 'untrusted_document' } } });
    } finally { await server.close(); }
  });

  it('uses Eeshaan’s canonical helper and rejects a changed source digest', async () => {
    const { server, request, response } = await trustedRead();
    try {
      const observation = bridgeTrustedReadQuote({ request, grant, response });
      if (!('quotation' in observation) || observation.quotation === undefined) throw new Error('Expected structured quotation');
      const expected = hashQuotationSource(mapProcurementQuoteData(response.data));
      expect(observation.quotation.source?.sha256).toBe(expected);
      const tampered = {
        ...observation,
        quotation: { ...observation.quotation, source: { ...observation.quotation.source!, sha256: '0'.repeat(64) } }
      };
      expect(consumed(request, tampered)).toMatchObject({ status: 'rejected', reason: 'invalid_quote_evidence' });
    } finally { await server.close(); }
  });

  it('rejects missing units, model-shaped authority metadata, and malformed quote records', async () => {
    const { server, request, response } = await trustedRead();
    try {
      const quote = record(response.data);
      for (const data of [
        Object.fromEntries(Object.entries(quote).filter(([key]) => key !== 'quantityUnit')),
        { ...quote, sourceId: 'model-forged-source' },
        { ...quote, quantity: 1.5 }
      ]) {
        expect(() => bridgeTrustedReadQuote({ request, grant, response: { ...response, data } }))
          .toThrow(TrustedQuotationBridgeError);
      }
    } finally { await server.close(); }
  });

  it('rejects blocked, failed, uncertain, or mismatched gateway correlation', async () => {
    const { server, request, response } = await trustedRead();
    try {
      const variants = [
        { ...response, decision: { ...response.decision, decision: 'block' } },
        { ...response, receipt: { ...response.receipt, executionStatus: 'failed' } },
        { ...response, receipt: { ...response.receipt, taskId: 'different-task' } },
        { ...response, decision: { ...response.decision, grantVersion: 'other-grant' } },
        { ...response, receipt: { ...response.receipt, callId: 'different-call' } },
        { ...response, receipt: { ...response.receipt, receiptId: 'not-a-uuid' } },
        { ...response, data: { ...record(response.data), fileId: 'quote-B' } }
      ];
      for (const altered of variants) {
        expect(() => bridgeTrustedReadQuote({ request, grant, response: altered })).toThrow(TrustedQuotationBridgeError);
      }
    } finally { await server.close(); }
  });

  it('does not change existing email approval behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskgate-quote-bridge-email-'));
    const server = await createTaskGateServer({ grantTemplate: grant, auditPath: join(root, 'audit.jsonl') });
    server.grantStore.create(grant);
    try {
      const response = await server.dispatcher.dispatchToolCall({
        taskId: grant.taskId, callId: 'email-still-pending', tool: 'send_clarification_email',
        args: { recipient: 'supplier@example.test', subject: 'Clarification', body: 'Please confirm lead time.' }
      });
      expect(response).toMatchObject({ decision: { decision: 'request_approval', ruleId: 'TG-A001' }, receipt: { executionStatus: 'not_executed' } });
    } finally { await server.close(); }
  });
});
