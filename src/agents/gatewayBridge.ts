import { z } from 'zod';
import { callIdSchema, taskGrantSchema, taskIdSchema } from '../contracts/schemas.js';
import type { TaskGrant } from '../contracts/types.js';
import { canonicalizeEmail, hashEmailAction } from '../security/canonical.js';
import type { ProposedAction } from './schemas.js';

/** Server-owned snapshot, never model output. The real gateway rechecks current state. */
export interface TrustedGatewayContext { grant: TaskGrant }
export interface GatewayBridge {
  /** Independent of model provenance: fake dispatch must remain visibly scripted. */
  kind: 'taskgate' | 'scripted_gateway';
  dispatch(
    action: ProposedAction, context: TrustedGatewayContext, options: { signal?: AbortSignal }
  ): Promise<GatewayObservation>;
}

const correlation = {
  taskId: taskIdSchema, callId: callIdSchema,
  grantVersion: taskGrantSchema.shape.version,
  tool: z.enum(['read_quote', 'send_clarification_email']),
  ruleId: taskIdSchema, receiptId: taskIdSchema.optional()
};
const canonicalEmailSchema = z.object({
  taskId: taskIdSchema, callId: callIdSchema,
  grantVersion: taskGrantSchema.shape.version, tool: z.literal('send_clarification_email'),
  recipient: z.string(), subject: z.string(), body: z.string()
}).strict();
const quoteSchema = z.object({
  fileId: z.enum(['quote-A', 'quote-B']), documentText: z.string().max(2_000)
}).strict();

/** Internal normalization contract, not a change to DispatchResponse or public enums.
 * Do not forward raw adapter data/errors. quote is a bounded untrusted excerpt.
 */
export const gatewayObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...correlation, kind: z.literal('block'), decision: z.literal('block') }).strict(),
  z.object({
    ...correlation, kind: z.literal('request_approval'), decision: z.literal('request_approval'),
    tool: z.literal('send_clarification_email'),
    pending: z.object({ email: canonicalEmailSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  }).strict(),
  z.object({
    ...correlation, kind: z.literal('succeeded'), decision: z.literal('allow'),
    receiptId: taskIdSchema, quote: quoteSchema.optional()
  }).strict(),
  z.object({
    ...correlation, kind: z.literal('failed'), decision: z.literal('allow'), receiptId: taskIdSchema
  }).strict(),
  z.object({ ...correlation, kind: z.literal('uncertain'), decision: z.literal('allow') }).strict(),
  z.object({ ...correlation, kind: z.literal('not_executed'), decision: z.literal('allow') }).strict()
]);
export type GatewayObservation = z.infer<typeof gatewayObservationSchema>;

export function validateGatewayObservation(
  value: unknown, action: ProposedAction, context: TrustedGatewayContext
): GatewayObservation {
  const observation = gatewayObservationSchema.parse(value);
  const grant = context.grant;
  if (observation.taskId !== grant.taskId || observation.grantVersion !== grant.version ||
    observation.tool !== action.tool) throw new Error('Inconsistent gateway correlation');
  if (observation.kind === 'succeeded' && observation.quote) {
    if (action.tool !== 'read_quote' || observation.quote.fileId !== action.args.fileId) {
      throw new Error('Inconsistent quote observation');
    }
  }
  if (observation.kind === 'request_approval') {
    const expected = canonicalizeEmail({
      taskId: grant.taskId, callId: observation.callId, tool: action.tool, args: action.args
    }, grant);
    const actual = observation.pending.email;
    if (hashEmailAction(actual) !== observation.pending.digest ||
      hashEmailAction(expected) !== observation.pending.digest) {
      throw new Error('Inconsistent pending binding');
    }
  }
  return observation;
}
