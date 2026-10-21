import { describe, expect, it } from 'vitest';
import {
  completionClaimSchema,
  gatewayToolCallSchema,
  modelToolCallSchema,
  readQuoteToolCallSchema,
  sendClarificationEmailToolCallSchema,
  taskGrantSchema
} from '../src/contracts/schemas.js';

const validGrant = {
  taskId: 'demo-task-1',
  version: 'v1',
  confirmed: true,
  approvedFileIds: ['quote-A', 'quote-B'],
  permittedTools: ['read_quote', 'send_clarification_email'],
  prohibitedOperations: ['delete', 'modify'],
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email']
};

describe('frozen TaskGate shared contracts', () => {
  it('accepts valid strict TaskGrant and supported tool-call objects', () => {
    expect(taskGrantSchema.parse(validGrant)).toEqual(validGrant);
    expect(readQuoteToolCallSchema.parse({
      callId: 'call-read-1',
      taskId: 'demo-task-1',
      tool: 'read_quote',
      args: { fileId: 'quote-A' }
    })).toMatchObject({ tool: 'read_quote', args: { fileId: 'quote-A' } });
    expect(sendClarificationEmailToolCallSchema.parse({
      callId: 'call-email-1',
      taskId: 'demo-task-1',
      tool: 'send_clarification_email',
      args: { recipient: 'supplier@example.test', subject: 'Clarification', body: 'Please confirm lead time.' }
    })).toMatchObject({ tool: 'send_clarification_email' });
  });

  it('enforces required fields and rejects extra properties', () => {
    expect(taskGrantSchema.safeParse({ ...validGrant, confirmed: undefined }).success).toBe(false);
    expect(readQuoteToolCallSchema.safeParse({
      callId: 'call-read-1', taskId: 'demo-task-1', tool: 'read_quote', args: { fileId: 'quote-A', path: '../secrets' }
    }).success).toBe(false);
    expect(sendClarificationEmailToolCallSchema.safeParse({
      callId: 'call-email-1', taskId: 'demo-task-1', tool: 'send_clarification_email',
      args: { recipient: 'supplier@example.test', subject: 'A', body: 'B', cc: 'attacker@example.test' }
    }).success).toBe(false);
  });

  it('uses a discriminated union for the model-facing tools only', () => {
    const read = modelToolCallSchema.parse({
      callId: 'call-read-2', taskId: 'demo-task-1', tool: 'read_quote', args: { fileId: 'quote-B' }
    });
    const email = modelToolCallSchema.parse({
      callId: 'call-email-2', taskId: 'demo-task-1', tool: 'send_clarification_email',
      args: { recipient: 'supplier@example.test', subject: 'Question', body: 'Confirm payment terms.' }
    });
    expect(read.tool).toBe('read_quote');
    expect(email.tool).toBe('send_clarification_email');
    expect(modelToolCallSchema.safeParse({
      callId: 'call-delete-1', taskId: 'demo-task-1', tool: 'delete_quote', args: { fileId: 'quote-A' }
    }).success).toBe(false);
  });

  it('rejects unknown tools and malformed or unsupported arguments before dispatch', () => {
    expect(gatewayToolCallSchema.safeParse({
      callId: 'call-unknown-1', taskId: 'demo-task-1', tool: 'shell', args: { command: 'whoami' }
    }).success).toBe(false);
    expect(gatewayToolCallSchema.safeParse({
      callId: 'call-path-1', taskId: 'demo-task-1', tool: 'read_quote', args: { fileId: '../quote-A' }
    }).success).toBe(false);
    expect(gatewayToolCallSchema.safeParse({
      callId: 'call-email-3', taskId: 'demo-task-1', tool: 'send_clarification_email',
      args: { recipient: 'not-an-email', subject: '', body: '' }
    }).success).toBe(false);
  });

  it('allows delete_quote only in the gateway validation surface for policy denial tests', () => {
    expect(gatewayToolCallSchema.parse({
      callId: 'call-delete-2', taskId: 'demo-task-1', tool: 'delete_quote', args: { fileId: 'quote-A' }
    }).tool).toBe('delete_quote');
  });

  it('preserves contract compatibility through JSON serialization', () => {
    const claim = completionClaimSchema.parse({
      claimId: 'claim-1', taskId: 'demo-task-1', callId: 'call-email-1', kind: 'email_sent',
      recipient: 'supplier@example.test', subjectDigest: 'a'.repeat(64), bodyDigest: 'b'.repeat(64)
    });
    expect(completionClaimSchema.parse(JSON.parse(JSON.stringify(claim)))).toEqual(claim);
  });
});
