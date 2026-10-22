import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DecisionKind, RunMode } from '../contracts/types.js';
import type { InvocationTrace, LLMErrorCategory } from './llmClient.js';
import { agentRoleSchema, runModeSchema } from './schemas.js';
import type { AgentRole } from './schemas.js';
import { PROMPT_VERSION } from './prompts.js';

export type WorkflowStatus =
  'planning' | 'reviewing' | 'dispatching' | 'awaiting_human' |
  'recovering' | 'completed' | 'stopped';

/** Master AgentTraceEvent fields, extended only inside the agents module. */
export interface AgentTraceEvent {
  runId: string;
  role: AgentRole | 'taskgate' | 'human';
  eventType: string;
  timestamp: string;
  summary: string;
  callId?: string;
  receiptId?: string;
  runMode: RunMode;
  decision?: DecisionKind;
  ruleId?: string;
  source: 'supervisor' | 'model' | 'gateway';
  invocation?: InvocationTrace;
}
const safeName = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
const categorySchema: z.ZodType<LLMErrorCategory> = z.enum([
  'configuration', 'missing_api_key', 'authentication', 'rate_limit', 'provider_error',
  'transport', 'timeout', 'aborted', 'deadline', 'invalid_response', 'invalid_output', 'safety'
]);
const invocationSchema = z.object({
  provider: safeName, requestedModel: safeName, model: safeName, modelVersion: safeName.optional(),
  invocationId: z.string().uuid(), role: agentRoleSchema,
  promptVersion: z.literal(PROMPT_VERSION), runMode: runModeSchema.nullable(),
  attempts: z.number().int().min(0).max(2), startedAt: z.string().datetime(),
  endedAt: z.string().datetime(), durationMs: z.number().finite().nonnegative(),
  status: z.enum(['succeeded', 'failed']), errorCategory: categorySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional()
  }).strict().optional()
}).strict();

export function validateInvocation(value: InvocationTrace, role: AgentRole): InvocationTrace {
  const trace = invocationSchema.parse(value);
  if (trace.role !== role || Date.parse(trace.endedAt) < Date.parse(trace.startedAt) ||
    (trace.attempts === 0) !== (trace.runMode === null) ||
    (trace.status === 'succeeded' && (trace.attempts === 0 || trace.errorCategory))) {
    throw new Error('Inconsistent invocation metadata');
  }
  return trace;
}

const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  planning: ['reviewing', 'completed', 'stopped'],
  reviewing: ['planning', 'dispatching', 'awaiting_human', 'stopped'],
  dispatching: ['planning', 'recovering', 'stopped'],
  recovering: ['planning', 'awaiting_human', 'stopped'],
  awaiting_human: [], completed: [], stopped: []
};

/** Per-run state only; no persistence, public callbacks or model-written events. */
export function createWorkflowTrace(mode: RunMode) {
  const runId = randomUUID();
  let status: WorkflowStatus = 'planning';
  const events: AgentTraceEvent[] = [];
  const add = (event: Omit<AgentTraceEvent, 'runId' | 'timestamp'>) => {
    events.push({ ...structuredClone(event), runId, timestamp: new Date().toISOString() });
  };
  add({ role: 'taskgate', eventType: 'workflow_started', summary: 'Bounded workflow started.',
    runMode: mode, source: 'supervisor' });
  return {
    runId,
    get status() { return status; },
    add,
    transition(next: WorkflowStatus) {
      if (!transitions[status].includes(next)) throw new Error('Invalid workflow transition');
      const previous = status;
      status = next;
      add({ role: 'taskgate', eventType: 'workflow_transition', summary: previous + ' -> ' + next,
        runMode: mode, source: 'supervisor' });
    },
    snapshot: () => structuredClone(events)
  };
}
