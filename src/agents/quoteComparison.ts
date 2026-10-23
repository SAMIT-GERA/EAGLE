import { z } from 'zod';
import { taskIdSchema, callIdSchema, taskGrantSchema } from '../contracts/schemas.js';
import {
  validatedQuoteSchema, quoteFileIdSchema, currencySchema, quantityUnitSchema,
  minorUnitsSchema, sourceIdSchema, sha256Schema
} from './quotationSchemas.js';
import { sourceEvidenceSchema } from './quotation.js';
import type { ObservedQuotation } from './quotation.js';

const observedSchema = z.object({
  taskId: taskIdSchema, grantVersion: taskGrantSchema.shape.version, fileId: quoteFileIdSchema,
  callId: callIdSchema, receiptId: taskIdSchema, ruleId: taskIdSchema,
  runMode: z.enum(['live_model', 'scripted_gateway']), gatewayKind: z.enum(['taskgate', 'scripted_gateway']),
  quote: validatedQuoteSchema, source: sourceEvidenceSchema
}).strict();
export function formatMinorUnits(value: string): string {
  const minor = BigInt(minorUnitsSchema.parse(value));
  return String(minor / 100n) + '.' + String(minor % 100n).padStart(2, '0');
}
export function quotationTotalMinor(quotation: ObservedQuotation): string {
  const parsed = observedSchema.parse(quotation);
  return (BigInt(parsed.quote.quantity) * BigInt(parsed.quote.unitPriceMinor)).toString();
}
export interface ComparisonEntry {
  fileId: ObservedQuotation['fileId']; supplier: string; totalMinor: string; total: string;
  leadTimeDays: number; paymentTerms: string;
  callId: string; receiptId: string; source: ObservedQuotation['source'];
  runMode: ObservedQuotation['runMode']; gatewayKind: ObservedQuotation['gatewayKind'];
}
export type QuoteComparison =
  { status: 'insufficient_evidence'; reason: 'two_distinct_reads_required' | 'invalid_observation' } |
  { status: 'incompatible'; reasons: Array<'task_or_grant' | 'currency' | 'quantity' | 'quantity_unit' | 'item'> } |
  {
    status: 'compared'; currency: z.infer<typeof currencySchema>;
    quantity: number; quantityUnit: z.infer<typeof quantityUnitSchema>; item: string;
    entries: [ComparisonEntry, ComparisonEntry]; absoluteDifferenceMinor: string; absoluteDifference: string;
    percentageDifference: {
      value: string | null; denominator: 'higher_total'; denominatorMinor: string;
      rounding: 'half_up_2dp'; undefinedReason?: 'both_totals_zero';
    };
    cheaperFileId: ObservedQuotation['fileId'] | null;
    fasterFileId: ObservedQuotation['fileId'] | null;
    tradeoff: boolean; recommendation: string;
  };

/** Comparison is deterministic server arithmetic, not a model ranking.
 * Percent = (higher - lower) / higher * 100, rounded half up to 2 decimals.
 * Payment terms are copied verbatim and never interpreted as financial advice.
 */
export function compareQuotations(values: readonly ObservedQuotation[]): QuoteComparison {
  if (values.length !== 2) return { status: 'insufficient_evidence', reason: 'two_distinct_reads_required' };
  const parsed = z.array(observedSchema).safeParse(values);
  if (!parsed.success) return { status: 'insufficient_evidence', reason: 'invalid_observation' };
  const [a, b] = parsed.data;
  if (a.fileId !== a.quote.fileId || b.fileId !== b.quote.fileId ||
    a.fileId === b.fileId || a.callId === b.callId || a.receiptId === b.receiptId) {
    return { status: 'insufficient_evidence', reason: 'two_distinct_reads_required' };
  }
  const reasons: Extract<QuoteComparison, { status: 'incompatible' }>['reasons'] = [];
  if (a.taskId !== b.taskId || a.grantVersion !== b.grantVersion) reasons.push('task_or_grant');
  if (a.quote.currency !== b.quote.currency) reasons.push('currency');
  if (a.quote.quantity !== b.quote.quantity) reasons.push('quantity');
  if (a.quote.quantityUnit !== b.quote.quantityUnit) reasons.push('quantity_unit');
  if (a.quote.item !== b.quote.item) reasons.push('item');
  if (reasons.length) return { status: 'incompatible', reasons };
  const entry = (q: ObservedQuotation): ComparisonEntry => {
    const totalMinor = quotationTotalMinor(q);
    return {
      fileId: q.fileId, supplier: q.quote.supplier, totalMinor, total: formatMinorUnits(totalMinor),
      leadTimeDays: q.quote.leadTimeDays, paymentTerms: q.quote.paymentTerms,
      callId: q.callId, receiptId: q.receiptId, source: structuredClone(q.source),
      runMode: q.runMode, gatewayKind: q.gatewayKind
    };
  };
  const entries: [ComparisonEntry, ComparisonEntry] = [entry(a), entry(b)];
  const x = BigInt(entries[0].totalMinor), y = BigInt(entries[1].totalMinor);
  const higher = x > y ? x : y, lower = x < y ? x : y;
  const difference = higher - lower;
  const scaledPercent = higher === 0n ? null : (difference * 10_000n + higher / 2n) / higher;
  const cheaperFileId = x === y ? null : x < y ? a.fileId : b.fileId;
  const fasterFileId = a.quote.leadTimeDays === b.quote.leadTimeDays ? null :
    a.quote.leadTimeDays < b.quote.leadTimeDays ? a.fileId : b.fileId;
  return {
    status: 'compared', currency: a.quote.currency, item: a.quote.item,
    quantity: a.quote.quantity, quantityUnit: a.quote.quantityUnit, entries,
    absoluteDifferenceMinor: difference.toString(), absoluteDifference: formatMinorUnits(difference.toString()),
    percentageDifference: {
      value: scaledPercent === null ? null : formatMinorUnits(scaledPercent.toString()),
      denominator: 'higher_total', denominatorMinor: higher.toString(), rounding: 'half_up_2dp',
      ...(higher === 0n ? { undefinedReason: 'both_totals_zero' as const } : {})
    },
    cheaperFileId, fasterFileId,
    tradeoff: !!cheaperFileId && !!fasterFileId && cheaperFileId !== fasterFileId,
    recommendation: 'Cost and lead time are separate criteria; no overall supplier preference is assumed.'
  };
}

// A deliberately small model-facing projection: no task/call/receipt IDs,
// raw source bytes or authority fields. Every source string remains untrusted.
const moneyTextSchema = z.string().max(20).regex(/^(0|[1-9][0-9]*)[.][0-9]{2}$/);
const agentEvidenceSchema = z.object({
  status: z.enum(['verified', 'unverified', 'unavailable']),
  trustLabel: z.literal('untrusted_document'), sourceId: sourceIdSchema.optional(),
  computedSha256: sha256Schema.optional(), basis: z.enum(['canonical_quote_v1', 'raw_utf8']).optional()
}).strict();
export const agentQuotationContextSchema = z.object({
  trustLabel: z.literal('untrusted_document'),
  quotes: z.array(z.object({
    fileId: quoteFileIdSchema, supplier: z.string().max(120), item: z.string().max(160),
    quantity: z.number().int().positive().max(1_000_000), quantityUnit: quantityUnitSchema,
    currency: currencySchema, unitPriceMinor: minorUnitsSchema, totalMinor: minorUnitsSchema,
    unitPrice: moneyTextSchema, total: moneyTextSchema,
    leadTimeDays: z.number().int().min(0).max(3_650), paymentTerms: z.string().max(200),
    paymentTermsTruncated: z.boolean(), excerptTruncated: z.boolean(),
    source: agentEvidenceSchema, excerpt: z.string().max(300)
  }).strict()).max(2),
  calculation: z.object({
    status: z.enum(['compared', 'insufficient_evidence', 'incompatible']),
    absoluteDifferenceMinor: minorUnitsSchema.optional(), absoluteDifference: moneyTextSchema.optional(),
    percentage: z.string().max(6).nullable().optional(),
    percentageDenominator: z.literal('higher_total').optional(),
    cheaperFileId: quoteFileIdSchema.nullable().optional(),
    fasterFileId: quoteFileIdSchema.nullable().optional(), tradeoff: z.boolean().optional()
  }).strict()
}).strict();
export function toAgentQuotationContext(quotes: readonly ObservedQuotation[]) {
  const comparison = compareQuotations(quotes);
  return agentQuotationContextSchema.parse({
    trustLabel: 'untrusted_document',
    quotes: quotes.map((q) => ({
      fileId: q.fileId, supplier: q.quote.supplier, item: q.quote.item,
      quantity: q.quote.quantity, quantityUnit: q.quote.quantityUnit,
      currency: q.quote.currency, unitPriceMinor: q.quote.unitPriceMinor, totalMinor: quotationTotalMinor(q),
      unitPrice: formatMinorUnits(q.quote.unitPriceMinor), total: formatMinorUnits(quotationTotalMinor(q)),
      leadTimeDays: q.quote.leadTimeDays, paymentTerms: q.quote.paymentTerms.slice(0, 200),
      paymentTermsTruncated: q.quote.paymentTerms.length > 200,
      excerptTruncated: (q.quote.documentText?.length ?? 0) > 300,
      source: {
        status: q.source.status, trustLabel: q.source.trustLabel,
        ...(q.source.sourceId ? { sourceId: q.source.sourceId } : {}),
        ...(q.source.computedSha256 ? { computedSha256: q.source.computedSha256 } : {}),
        ...(q.source.basis ? { basis: q.source.basis } : {})
      },
      excerpt: q.quote.documentText?.slice(0, 300) ?? ''
    })),
    calculation: comparison.status === 'compared' ? {
      status: comparison.status, absoluteDifferenceMinor: comparison.absoluteDifferenceMinor,
      absoluteDifference: comparison.absoluteDifference,
      percentage: comparison.percentageDifference.value, percentageDenominator: 'higher_total',
      cheaperFileId: comparison.cheaperFileId, fasterFileId: comparison.fasterFileId, tradeoff: comparison.tradeoff
    } : { status: comparison.status }
  });
}
