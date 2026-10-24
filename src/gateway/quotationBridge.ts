import { z } from 'zod';
import { quotationPayloadSchema, mapProcurementQuoteData } from '../agents/quotationSchemas.js';
import { hashQuotationSource } from '../agents/quotation.js';
import { gatewayObservationSchema } from '../agents/gatewayBridge.js';
import { readQuoteToolCallSchema, taskGrantSchema } from '../contracts/schemas.js';

/**
 * Converts a response produced by the trusted local GatewayDispatcher into
 * Eeshaan's internal observation format. This is a server-composition helper,
 * never a model, document, or browser-data mapper.
 */
export const trustedReadQuoteBridgeInputSchema = z.object({
  request: readQuoteToolCallSchema,
  grant: taskGrantSchema,
  response: z.object({
    decision: z.object({
      callId: z.string(), decision: z.literal('allow'), ruleId: z.string(),
      reason: z.string(), grantVersion: z.string()
    }).strict(),
    receipt: z.object({
      receiptId: z.string().uuid(), taskId: z.string(), callId: z.string(),
      tool: z.literal('read_quote'), argsDigest: z.string(), grantVersion: z.string(),
      policyVersion: z.string(), decision: z.literal('allow'), ruleId: z.string(),
      executionStatus: z.literal('succeeded'), adapterOutcome: z.string(), timestamp: z.string()
    }).strict(),
    data: z.unknown()
  }).strict()
}).strict();

export type TrustedReadQuoteBridgeInput = z.input<typeof trustedReadQuoteBridgeInputSchema>;

export class TrustedQuotationBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedQuotationBridgeError';
  }
}

function sourceId(fileId: 'quote-A' | 'quote-B'): string {
  return `procurement-v1:${fileId}`;
}
export type TrustedUploadedQuoteSource = Readonly<{taskId:string;fileId:'quote-A'|'quote-B';documentId:string;sha256:string}>;

/**
 * Build a structured quotation only from an already successful gateway read.
 * The source ID is derived from the server-owned profile and frozen public ID;
 * it is not supplied by the caller, the fixture text, or a model.
 */
export function bridgeTrustedReadQuote(input: unknown, uploadedSource?: TrustedUploadedQuoteSource) {
  const parsed = trustedReadQuoteBridgeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TrustedQuotationBridgeError('Gateway response is not a successful trusted quote read.');
  }
  const { request, grant, response } = parsed.data;
  if (request.taskId !== grant.taskId ||
    response.decision.callId !== request.callId || response.decision.grantVersion !== grant.version ||
    response.receipt.taskId !== request.taskId || response.receipt.callId !== request.callId ||
    response.receipt.grantVersion !== grant.version || response.receipt.ruleId !== response.decision.ruleId) {
    throw new TrustedQuotationBridgeError('Gateway response correlation does not match the trusted request and grant.');
  }

  try {
    const quote = mapProcurementQuoteData(response.data);
    if (quote.fileId !== request.args.fileId) {
      throw new TrustedQuotationBridgeError('Gateway quote identifier does not match the requested file.');
    }

    const canonicalDigest = hashQuotationSource(quote);
    if (uploadedSource && (uploadedSource.taskId !== request.taskId || uploadedSource.fileId !== request.args.fileId ||
      !/^doc-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadedSource.documentId) || uploadedSource.sha256 !== canonicalDigest)) {
      throw new TrustedQuotationBridgeError('Uploaded quote source does not match the trusted binding and gateway result.');
    }
    const quotation = quotationPayloadSchema.parse({
      format: 'procurement-v1',
      data: response.data,
      source: {
        basis: 'canonical_quote_v1',
        sourceId: uploadedSource ? `upload-v1:${uploadedSource.documentId}` : sourceId(quote.fileId),
        sha256: canonicalDigest
      }
    });
    return gatewayObservationSchema.parse({
      kind: 'succeeded', taskId: request.taskId, grantVersion: grant.version,
      callId: request.callId, receiptId: response.receipt.receiptId,
      tool: 'read_quote', decision: 'allow', ruleId: response.decision.ruleId,
      quotation
    });
  } catch (error) {
    if (error instanceof TrustedQuotationBridgeError) throw error;
    throw new TrustedQuotationBridgeError('Gateway quote data is not a valid procurement-v1 quotation.');
  }
}
