import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunMode } from '../contracts/types.js';
import { validateGatewayObservation } from './gatewayBridge.js';
import type { GatewayBridge, TrustedGatewayContext } from './gatewayBridge.js';
import type { ProposedAction } from './schemas.js';
import {
  mapProcurementQuoteData, validatedQuoteSchema, sourceIdSchema, sha256Schema
} from './quotationSchemas.js';
import type { ValidatedQuote, SuppliedSource } from './quotationSchemas.js';

export interface SourceEvidenceRef {
  sourceId: string; sha256: string; trustLabel: 'untrusted_document';
}
export const sourceEvidenceSchema = z.object({
  status: z.enum(['verified', 'unverified', 'unavailable']),
  trustLabel: z.literal('untrusted_document'),
  basis: z.enum(['canonical_quote_v1', 'raw_utf8']).optional(),
  sourceId: sourceIdSchema.optional(), computedSha256: sha256Schema.optional(),
  suppliedSha256: sha256Schema.optional(),
  reference: z.object({
    sourceId: sourceIdSchema, sha256: sha256Schema, trustLabel: z.literal('untrusted_document')
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.status === 'verified' && (!value.reference ||
    value.reference.sourceId !== value.sourceId || value.reference.sha256 !== value.computedSha256)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid verified reference' });
  }
  if (value.status !== 'verified' && value.reference) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unverified reference' });
  }
});
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export interface SourceTraceSummary {
  fileId: 'quote-A' | 'quote-B'; evidence: SourceEvidence;
  callId?: string; receiptId?: string; runMode?: RunMode;
}
export interface ObservedQuotation {
  taskId: string; grantVersion: string; fileId: 'quote-A' | 'quote-B';
  callId: string; receiptId: string; ruleId: string;
  runMode: RunMode; gatewayKind: GatewayBridge['kind'];
  quote: ValidatedQuote; source: SourceEvidence;
}
export type QuoteConsumption =
  { status: 'accepted'; quotation: ObservedQuotation } |
  { status: 'insufficient_evidence'; reason: 'no_structured_quote'; fileId: 'quote-A' | 'quote-B';
    source: SourceEvidence } |
  { status: 'rejected'; reason: 'not_successful_read' | 'invalid_quote_evidence' };

/** Hash normalized full quote values, not a shortened model excerpt.
 * Exact source strings and optional document absence are preserved. Key order,
 * price number/string lexical differences and object formatting are canonicalized.
 */
export function serializeQuotationSource(value: ValidatedQuote): string {
  const q = validatedQuoteSchema.parse(value);
  return JSON.stringify([
    'taskgate:quotation-source:v1', q.fileId, q.supplier, q.item,
    q.quantity, q.quantityUnit, q.unitPriceMinor, q.currency, q.leadTimeDays,
    q.paymentTerms, q.documentText ?? null
  ]);
}
export function hashQuotationSource(value: ValidatedQuote): string {
  return createHash('sha256').update(serializeQuotationSource(value), 'utf8').digest('hex');
}
function buildSourceEvidence(quote: ValidatedQuote, supplied?: SuppliedSource): SourceEvidence {
  let digest = hashQuotationSource(quote);
  const basis = supplied?.basis ?? 'canonical_quote_v1';
  if (supplied?.basis === 'raw_utf8') {
    // Raw bytes must decode as the same strict procurement JSON data. Do not
    // claim that unrelated bytes support the mapped numeric/text fields.
    const fromBytes = mapProcurementQuoteData(JSON.parse(supplied.utf8));
    if (serializeQuotationSource(fromBytes) !== serializeQuotationSource(quote)) {
      throw new Error('Raw source does not match quote data');
    }
    digest = createHash('sha256').update(supplied.utf8, 'utf8').digest('hex');
  }
  if (supplied?.sha256 !== undefined && supplied.sha256 !== digest) {
    throw new Error('Source digest mismatch');
  }
  const verified = !!supplied?.sourceId && (basis === 'raw_utf8' || supplied.sha256 !== undefined);
  return sourceEvidenceSchema.parse({
    status: verified ? 'verified' : 'unverified', trustLabel: 'untrusted_document', basis,
    computedSha256: digest,
    ...(supplied?.sourceId ? { sourceId: supplied.sourceId } : {}),
    ...(supplied?.sha256 ? { suppliedSha256: supplied.sha256 } : {}),
    ...(verified ? { reference: {
      sourceId: supplied!.sourceId!, sha256: digest, trustLabel: 'untrusted_document'
    } } : {})
  });
}

/** The only quote-evidence entry point. Inputs must come from trusted DI, never
 * model output. Parsing cannot attest that a dishonest bridge actually executed.
 */
export function consumeReadQuoteResult(input: {
  action: ProposedAction; context: TrustedGatewayContext; observation: unknown;
  gatewayKind: GatewayBridge['kind']; mode: RunMode;
}): QuoteConsumption {
  try {
    const observation = validateGatewayObservation(input.observation, input.action, input.context);
    if (input.action.tool !== 'read_quote' || observation.tool !== 'read_quote' ||
      observation.kind !== 'succeeded' || observation.decision !== 'allow') {
      return { status: 'rejected', reason: 'not_successful_read' };
    }
    if (!input.context.grant.approvedFileIds.includes(input.action.args.fileId)) {
      return { status: 'rejected', reason: 'invalid_quote_evidence' };
    }
    if (!observation.quotation) return {
      status: 'insufficient_evidence', reason: 'no_structured_quote',
      fileId: input.action.args.fileId, source: { status: 'unavailable', trustLabel: 'untrusted_document' }
    };
    const quote = mapProcurementQuoteData(observation.quotation.data);
    if (quote.fileId !== input.action.args.fileId) throw new Error('Quote identity mismatch');
    const source = buildSourceEvidence(quote, observation.quotation.source);
    return {
      status: 'accepted',
      quotation: {
        taskId: observation.taskId, grantVersion: observation.grantVersion, fileId: quote.fileId,
        callId: observation.callId, receiptId: observation.receiptId, ruleId: observation.ruleId,
        runMode: input.gatewayKind === 'scripted_gateway' ? 'scripted_gateway' : input.mode,
        gatewayKind: input.gatewayKind, quote, source
      }
    };
  } catch {
    return { status: 'rejected', reason: 'invalid_quote_evidence' };
  }
}
