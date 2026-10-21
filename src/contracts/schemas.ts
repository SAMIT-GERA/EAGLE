import { z } from 'zod';

export const MAX_TASK_ID_LENGTH = 128;
export const MAX_CALL_ID_LENGTH = 128;
export const MAX_APPROVAL_ID_LENGTH = 128;
export const MAX_EMAIL_RECIPIENT_LENGTH = 254;
export const MAX_EMAIL_SUBJECT_LENGTH = 200;
export const MAX_EMAIL_BODY_LENGTH = 5_000;

const identifierSchema = z.string().trim().min(1).max(MAX_TASK_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const callIdentifierSchema = z.string().trim().min(1).max(MAX_CALL_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const approvalIdentifierSchema = z.string().trim().min(1).max(MAX_APPROVAL_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const taskIdSchema = identifierSchema;
export const callIdSchema = callIdentifierSchema;
export const approvalIdSchema = approvalIdentifierSchema;

export const readQuoteArgsSchema = z.object({
  fileId: z.enum(['quote-A', 'quote-B'])
}).strict();

export const sendClarificationEmailArgsSchema = z.object({
  recipient: z.string().trim().min(1).max(MAX_EMAIL_RECIPIENT_LENGTH).email(),
  subject: z.string().min(1).max(MAX_EMAIL_SUBJECT_LENGTH),
  body: z.string().min(1).max(MAX_EMAIL_BODY_LENGTH)
}).strict();

export const deleteQuoteArgsSchema = z.object({
  fileId: z.string().trim().min(1).max(MAX_TASK_ID_LENGTH)
}).strict();

const toolCallBaseSchema = z.object({
  callId: callIdSchema,
  taskId: taskIdSchema,
  approvalId: approvalIdSchema.optional()
}).strict();

export const readQuoteToolCallSchema = toolCallBaseSchema.extend({
  tool: z.literal('read_quote'),
  args: readQuoteArgsSchema
}).strict();

export const sendClarificationEmailToolCallSchema = toolCallBaseSchema.extend({
  tool: z.literal('send_clarification_email'),
  args: sendClarificationEmailArgsSchema
}).strict();

export const deleteQuoteToolCallSchema = toolCallBaseSchema.extend({
  tool: z.literal('delete_quote'),
  args: deleteQuoteArgsSchema
}).strict();

export const modelToolCallSchema = z.discriminatedUnion('tool', [
  readQuoteToolCallSchema,
  sendClarificationEmailToolCallSchema
]);

export const gatewayToolCallSchema = z.discriminatedUnion('tool', [
  readQuoteToolCallSchema,
  sendClarificationEmailToolCallSchema,
  deleteQuoteToolCallSchema
]);

export const taskGrantSchema = z.object({
  taskId: taskIdSchema,
  version: z.string().trim().min(1).max(MAX_TASK_ID_LENGTH),
  confirmed: z.boolean(),
  approvedFileIds: z.array(z.enum(['quote-A', 'quote-B'])),
  permittedTools: z.array(z.enum(['read_quote', 'send_clarification_email'])),
  prohibitedOperations: z.array(z.enum(['delete', 'modify'])),
  eligibleRecipients: z.array(z.string().trim().min(1).max(MAX_EMAIL_RECIPIENT_LENGTH).email()),
  approvalEligibleTools: z.array(z.literal('send_clarification_email'))
}).strict();

export const completionClaimSchema = z.object({
  claimId: identifierSchema,
  taskId: taskIdSchema,
  callId: callIdSchema,
  kind: z.literal('email_sent'),
  recipient: z.string().trim().min(1).max(MAX_EMAIL_RECIPIENT_LENGTH).email(),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type ReadQuoteArgs = z.infer<typeof readQuoteArgsSchema>;
export type SendClarificationEmailArgs = z.infer<typeof sendClarificationEmailArgsSchema>;
export type ModelToolCall = z.infer<typeof modelToolCallSchema>;
export type GatewayToolCall = z.infer<typeof gatewayToolCallSchema>;
