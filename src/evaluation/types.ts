import { z } from 'zod';
import { SCENARIO_IDS } from './agentCases.js';
import { taskIdSchema, callIdSchema, completionClaimSchema } from '../contracts/schemas.js';
import { sha256Schema, validatedQuoteSchema } from '../agents/quotationSchemas.js';
import { sourceEvidenceSchema } from '../agents/quotation.js';
import { agentRoleSchema, reviewNoteSchema } from '../agents/schemas.js';

export const id = taskIdSchema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ms = z.number().finite().nonnegative();
export const decisionSchema = z.enum(['allow', 'block', 'request_approval']);
export const statusSchema = z.enum(['passed', 'failed', 'not_run', 'not_implemented', 'insufficient_evidence']);
export const scopeSchema = z.enum(['integrated', 'synthetic_logic']);
export const invocationSchema = z.object({
  origin: z.enum(['provider', 'model_fixture']),
  invocationId: z.string().uuid(), runId: id.optional(), role: agentRoleSchema,
  provider: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/),
  promptVersion: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
  runMode: z.enum(['live_model', 'scripted_gateway']).nullable(),
  attempts: count.max(2), status: z.enum(['succeeded', 'failed']),
  errorCategory: z.enum(['configuration', 'missing_api_key', 'authentication', 'rate_limit', 'provider_error',
    'transport', 'timeout', 'aborted', 'deadline', 'invalid_response', 'invalid_output', 'safety']).optional(),
  startedAt: z.string().datetime(), endedAt: z.string().datetime(), durationMs: ms
}).strict();
export const gatewaySchema = z.object({
  origin: z.enum(['integrated_gateway', 'gateway_fixture']),
  requestId: id.optional(), taskId: id, callId: callIdSchema, grantVersion: id,
  tool: z.enum(['read_quote', 'send_clarification_email', 'delete_quote']),
  kind: z.enum(['block', 'request_approval', 'succeeded', 'failed', 'uncertain', 'not_executed']),
  decision: decisionSchema, ruleId: id, receiptId: id.optional(), observedAt: z.string().datetime().optional(),
  latencyMs: ms.optional(),
  label: z.object({ classification: z.enum(['eligible', 'prohibited']), manifestId: id }).strict().optional()
}).strict();
export const receiptSchema = z.object({
  origin: z.enum(['trusted_store', 'receipt_fixture']),
  receiptId: id, taskId: id, callId: callIdSchema, tool: z.string().min(1).max(128),
  argsDigest: sha256Schema, grantVersion: id, policyVersion: id, decision: decisionSchema,
  ruleId: id, executionStatus: z.enum(['succeeded', 'failed', 'not_executed']),
  timestamp: z.string().datetime(), approvalIdHash: sha256Schema.optional()
}).strict();
export const adapterSchema = z.object({
  origin: z.enum(['mock_adapter', 'simulated_adapter']),
  taskId: id, callId: callIdSchema.nullable(), count,
  /** null callId means a complete counter for THIS execution, not all task history. */
  complete: z.boolean()
}).strict();
const quoteSchema = z.object({
  taskId: id, grantVersion: id, fileId: z.enum(['quote-A', 'quote-B']),
  callId: callIdSchema, receiptId: id, ruleId: id,
  runMode: z.enum(['live_model', 'scripted_gateway']),
  gatewayKind: z.enum(['taskgate', 'scripted_gateway']), quote: validatedQuoteSchema, source: sourceEvidenceSchema
}).strict();
export const sourceLinkSchema = z.object({
  sourceId: id, sha256: sha256Schema, trustLabel: z.literal('untrusted_document'),
  callId: callIdSchema, receiptId: id, fileId: z.enum(['quote-A', 'quote-B']),
  invocationIds: z.array(z.string().uuid()).max(12)
}).strict();
export const approvalSchema = z.object({
  origin: z.enum(['operator_service', 'approval_fixture']),
  taskId: id, callId: callIdSchema, grantVersion: id, approvalIdHash: sha256Schema,
  pendingDigest: sha256Schema, approvedDigest: sha256Schema, resumedDigest: sha256Schema,
  adapterCallsBeforeApproval: count,
  operatorAuthenticated: z.boolean(), approvedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime()
}).strict();
export const claimSchema = z.object({
  origin: z.enum(['trusted_verifier', 'claim_fixture']),
  claim: completionClaimSchema,
  check: z.object({
    claimId: id, verdict: z.enum(['supported', 'contradiction', 'missing_evidence']),
    matchingReceiptIds: z.array(id).max(100)
  }).strict(),
  emailEvidence: z.array(z.object({
    taskId: id, callId: callIdSchema, receiptId: id, canonicalRecipient: z.string().email(),
    subjectDigest: sha256Schema, bodyDigest: sha256Schema
  }).strict()).max(100)
}).strict();
export const executionSchema = z.object({
  scenarioId: z.enum(SCENARIO_IDS), executionId: id,
  state: z.enum(['not_run', 'not_implemented', 'completed']),
  environment: z.enum(['observed', 'synthetic_fixture']),
  runMode: z.enum(['live_model', 'scripted_gateway']).nullable(),
  taskId: id.optional(), runId: id.optional(),
  provenance: z.object({ gateway: z.enum(['integrated_gateway', 'gateway_fixture', 'unavailable']),
    receipts: z.enum(['trusted_store', 'receipt_fixture', 'unavailable']) }).strict(),
  workflow: z.object({
    status: z.enum(['completed', 'stopped', 'awaiting_human']), outcomeUncertain: z.boolean(),
    startedAt: z.string().datetime().optional(), endedAt: z.string().datetime().optional(),
    label: z.object({ classification: z.literal('legitimate'), manifestId: id }).strict().optional()
  }).strict().optional(),
  coverage: z.object({ gateway: z.boolean(), models: z.boolean(), proposals: z.boolean(), approvals: z.boolean() }).strict(),
  models: z.array(invocationSchema).max(100), gateways: z.array(gatewaySchema).max(100),
  receipts: z.array(receiptSchema).max(200), adapters: z.array(adapterSchema).max(100),
  quotations: z.array(quoteSchema).max(2),
  /** Full comparison input is internal-only, independently recalculated by evaluator. */
  comparisonDigest: sha256Schema.optional(),
  sources: z.array(sourceLinkSchema).max(20),
  proposals: z.array(z.object({
    invocationId: z.string().uuid(), tool: z.enum(['read_quote', 'send_clarification_email']),
    argsDigest: sha256Schema, callId: callIdSchema.optional(), reviewerInvocationId: z.string().uuid().optional(), recommendation: reviewNoteSchema.shape.recommendation.optional()
  }).strict()).max(6),
  injection: z.object({
    manifestId: id, sourceId: id, sha256: sha256Schema,
    prohibitedProposalDigests: z.array(sha256Schema).max(10),
    grantBeforeDigest: sha256Schema, grantAfterDigest: sha256Schema
  }).strict().optional(),
  approvals: z.array(approvalSchema).max(10), claims: z.array(claimSchema).max(10),
  collectionErrors: z.array(z.enum(['workflow_read_failed', 'receipt_read_failed', 'measurement_read_failed',
    'invalid_workflow_evidence', 'invalid_receipt_evidence'])).max(10)
}).strict();
export type ScenarioExecution = z.infer<typeof executionSchema>;
export type GatewayEvidence = z.infer<typeof gatewaySchema>;
export type ModelEvidence = z.infer<typeof invocationSchema>;
export type ReceiptEvidence = z.infer<typeof receiptSchema>;
export type AdapterEvidence = z.infer<typeof adapterSchema>;
export type EvaluationStatus = z.infer<typeof statusSchema>;
export type EvaluationScope = z.infer<typeof scopeSchema>;
export const ISSUE_CODES = [
  'not_executed', 'unavailable_feature', 'collection_error', 'inconsistent_evidence', 'provenance_mismatch',
  'wrong_correlation', 'conflicting_receipts', 'missing_live_model', 'missing_integrated_gateway',
  'missing_receipts', 'missing_role', 'missing_workflow', 'missing_adapter_count', 'unexpected_adapter_call', 'false_block',
  'incorrect_comparison', 'missing_quote_evidence', 'missing_source_evidence', 'missing_injection_evidence',
  'grant_changed', 'missing_proposal_coverage', 'unsafe_action_allowed', 'missing_approval_evidence',
  'approval_binding_mismatch', 'missing_failed_adapter', 'missing_malformed_output', 'missing_review_advice',
  'missing_claim_evidence', 'wrong_claim_verdict', 'uncertain_outcome', 'future_rule'
] as const;
export const issueSchema = z.enum(ISSUE_CODES);
export type IssueCode = z.infer<typeof issueSchema>;
export const recordSchema = z.object({
  scenarioId: z.enum(SCENARIO_IDS), executionId: id, runId: id.optional(),
  runMode: z.enum(['live_model', 'scripted_gateway']).nullable(), scope: scopeSchema,
  status: statusSchema, integratedQualified: z.boolean(),
  expectedBehavior: z.array(z.string().max(500)), observedBehavior: z.array(z.string().max(500)),
  missingEvidence: z.array(issueSchema), failures: z.array(issueSchema),
  unsafeAction: z.enum(['not_assessed', 'not_attempted', 'attempted']),
  explanation: z.string().max(1_000), evidence: executionSchema
}).strict();
export type EvaluationRecord = z.infer<typeof recordSchema>;
export function emptyExecution(scenarioId: ScenarioExecution['scenarioId'], executionId: string): ScenarioExecution {
  return executionSchema.parse({
    scenarioId, executionId, state: 'not_run', environment: 'observed', runMode: null,
    provenance: { gateway: 'unavailable', receipts: 'unavailable' },
    coverage: { gateway: false, models: false, proposals: false, approvals: false },
    models: [], gateways: [], receipts: [], adapters: [], quotations: [], sources: [], proposals: [],
    approvals: [], claims: [], collectionErrors: []
  });
}
/** Stable JSON identities for duplicate/conflict checks; not invented receipt/request IDs. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const name = key(value);
    if (result.has(name) && stable(result.get(name)) !== stable(value)) throw new Error('Conflicting evaluation evidence');
    result.set(name, value);
  }
  return [...result.values()];
}
