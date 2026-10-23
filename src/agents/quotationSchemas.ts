import { z } from 'zod';
import { readQuoteArgsSchema } from '../contracts/schemas.js';

export const quoteFileIdSchema = readQuoteArgsSchema.shape.fileId;
export const sourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
export const currencySchema = z.enum(['INR', 'USD', 'EUR', 'GBP']);
export const quantityUnitSchema = z.enum(['each', 'kg']);
export const minorUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

/** Decimal conversion from the lexical value, never floating-point multiplication.
 * Prices with more than two decimal places are rejected, not silently rounded.
 */
export function priceToMinorUnits(value: number | string): string {
  const text = typeof value === 'number' ? String(value) : value;
  if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(text)) {
    throw new Error('Invalid two-decimal unit price');
  }
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > 100_000_000_000n) throw new Error('Unit price exceeds supported limit');
  return minor.toString();
}
const priceSchema = z.union([
  z.number().finite().nonnegative().max(1_000_000_000), z.string().max(13)
]).superRefine((value, context) => {
  try { priceToMinorUnits(value); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid unit price precision or range' }); }
});

/** Agent-side integration format only; no claim that absent backend fixtures use it.
 * Quantity units are mandatory. leadTimeDays explicitly fixes the time unit.
 */
export const procurementQuoteDataSchema = z.object({
  fileId: quoteFileIdSchema, supplier: sourceText(120), item: sourceText(160),
  quantity: z.number().int().positive().max(1_000_000), quantityUnit: quantityUnitSchema,
  unitPrice: priceSchema, currency: currencySchema,
  leadTimeDays: z.number().int().min(0).max(3_650),
  paymentTerms: sourceText(500), documentText: z.string().max(8_000).optional()
}).strict();
export type ProcurementQuoteData = z.infer<typeof procurementQuoteDataSchema>;
export const validatedQuoteSchema = procurementQuoteDataSchema.omit({ unitPrice: true }).extend({
  unitPriceMinor: minorUnitsSchema.refine((value) => BigInt(value) <= 100_000_000_000n)
}).strict();
export type ValidatedQuote = z.infer<typeof validatedQuoteSchema>;

export const suppliedSourceSchema = z.discriminatedUnion('basis', [
  z.object({
    basis: z.literal('canonical_quote_v1'), sourceId: sourceIdSchema.optional(), sha256: sha256Schema.optional()
  }).strict(),
  z.object({
    basis: z.literal('raw_utf8'), sourceId: sourceIdSchema.optional(), sha256: sha256Schema.optional(),
    utf8: z.string().min(1).max(16_000)
  }).strict()
]);
export type SuppliedSource = z.infer<typeof suppliedSourceSchema>;
export const quotationPayloadSchema = z.object({
  format: z.literal('procurement-v1'), data: procurementQuoteDataSchema, source: suppliedSourceSchema.optional()
}).strict();

export type QuotationPayload = z.infer<typeof quotationPayloadSchema>;

export function mapProcurementQuoteData(value: unknown): ValidatedQuote {
  const { unitPrice, ...rest } = procurementQuoteDataSchema.parse(value);
  return validatedQuoteSchema.parse({ ...rest, unitPriceMinor: priceToMinorUnits(unitPrice) });
}
