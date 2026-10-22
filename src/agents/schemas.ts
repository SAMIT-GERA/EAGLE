import { z } from 'zod';
import { readQuoteArgsSchema, sendClarificationEmailArgsSchema } from '../contracts/schemas.js';
import type { RunMode } from '../contracts/types.js';

export const agentRoleSchema = z.enum(['planner', 'reviewer', 'recovery']);
export type AgentRole = z.infer<typeof agentRoleSchema>;
export const runModeSchema: z.ZodType<RunMode> = z.enum(['live_model', 'scripted_gateway']);

const shortText = z.string().min(1).max(1_000);
export const proposedActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('read_quote'), args: readQuoteArgsSchema, purpose: shortText }).strict(),
  z.object({ tool: z.literal('send_clarification_email'), args: sendClarificationEmailArgsSchema, purpose: shortText }).strict()
]);
export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const plannerOutputSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('propose'), action: proposedActionSchema }).strict(),
  z.object({ state: z.literal('finish'), summary: shortText }).strict()
]);
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export const reviewNoteSchema = z.object({
  concernDetected: z.boolean(), concerns: z.array(shortText).max(8),
  recommendation: z.enum(['proceed_to_gateway', 'revise_action', 'request_human_review']),
  explanation: shortText
}).strict();
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
export const recoveryNoteSchema = z.object({
  nextStep: z.enum(['continue_comparison', 'revise_proposal', 'wait_for_approval', 'stop']),
  reason: shortText, suggestedAction: proposedActionSchema.optional()
}).strict();
export type RecoveryNote = z.infer<typeof recoveryNoteSchema>;


// Bounded advisory context for the supervisor. No IDs, versions, credentials,
// policy overrides or execution claims are accepted here.
export const agentWorkflowContextSchema = z.object({
  grantSummary: z.object({
    confirmed: z.boolean(),
    approvedFileIds: z.array(z.enum(['quote-A', 'quote-B'])).max(2),
    permittedTools: z.array(z.enum(['read_quote', 'send_clarification_email'])).max(2),
    eligibleRecipients: z.array(z.string().email()).max(4)
  }).strict(),
  previousAction: proposedActionSchema.optional(),
  advice: shortText.optional(),
  lastOutcome: z.enum(['block', 'request_approval', 'succeeded', 'failed', 'uncertain', 'not_executed']).optional(),
  feedback: z.enum([
    'initial', 'reviewer_requested_revision', 'gateway_read_succeeded',
    'gateway_email_succeeded', 'recovery_requested_revision'
  ])
}).strict();
// Inputs are synthetic domain data, not grants, credentials or executable tools.
// Text fields remain untrusted; no prompt can turn them into execution authority.
export const plannerInputSchema = z.object({
  workflowContext: agentWorkflowContextSchema.optional(),
  goal: shortText, observedQuoteText: z.array(z.string().max(2_000)).max(2).default([])
}).strict();
export const reviewerInputSchema = z.object({
  workflowContext: agentWorkflowContextSchema.optional(),
  goal: shortText, proposal: proposedActionSchema, untrustedExcerpt: z.string().max(2_000)
}).strict();
export const recoveryInputSchema = z.object({
  outcome: z.enum(['blocked', 'pending', 'failed', 'uncertain']),
  description: shortText
}).strict();
export type PlannerInput = z.input<typeof plannerInputSchema>;
export type ReviewerInput = z.input<typeof reviewerInputSchema>;
export type RecoveryInput = z.input<typeof recoveryInputSchema>;

// Portable JSON Schema subset for providers; Zod remains the strict authority.
const text = { type: 'string' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false
});
const actionJson = {
  anyOf: [
    object({
      tool: { type: 'string', enum: ['read_quote'] },
      args: object({ fileId: { type: 'string', enum: ['quote-A', 'quote-B'] } }), purpose: text
    }),
    object({
      tool: { type: 'string', enum: ['send_clarification_email'] },
      args: object({ recipient: text, subject: text, body: text }), purpose: text
    })
  ]
};
export const roleResponseSchemas: Record<AgentRole, Record<string, unknown>> = {
  planner: {
    anyOf: [
      object({ state: { type: 'string', enum: ['propose'] }, action: actionJson }),
      object({ state: { type: 'string', enum: ['finish'] }, summary: text })
    ]
  },
  reviewer: object({
    concernDetected: { type: 'boolean' }, concerns: { type: 'array', items: text },
    recommendation: { type: 'string', enum: ['proceed_to_gateway', 'revise_action', 'request_human_review'] },
    explanation: text
  }),
  recovery: object({
    nextStep: { type: 'string', enum: ['continue_comparison', 'revise_proposal', 'wait_for_approval', 'stop'] },
    reason: text, suggestedAction: actionJson
  }, ['nextStep', 'reason'])
};
