import type { RunMode } from '../contracts/types.js';
import type { AgentRole } from './schemas.js';

export type LLMErrorCategory =
  'configuration' | 'missing_api_key' | 'authentication' | 'rate_limit' |
  'provider_error' | 'transport' | 'timeout' | 'aborted' | 'deadline' |
  'invalid_response' | 'invalid_output' | 'safety';

export interface LLMRequest {
  role: AgentRole;
  system: string;
  content: string;
  responseSchema: Record<string, unknown>;
  promptVersion: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}
export interface InvocationTrace {
  provider: string;
  requestedModel: string;
  model: string;
  modelVersion?: string;
  invocationId: string;
  role: AgentRole;
  promptVersion: string;
  runMode: RunMode | null; // null means no provider request was attempted.
  attempts: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'succeeded' | 'failed';
  errorCategory?: LLMErrorCategory;
  tokenUsage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
}
export type LLMResult =
  { ok: true; text: string; trace: InvocationTrace } |
  { ok: false; trace: InvocationTrace };
export interface LLMClient {
  invoke(request: LLMRequest): Promise<LLMResult>;
}
export type RoleResult<T> =
  { ok: true; output: T; trace: InvocationTrace } |
  { ok: false; trace: InvocationTrace };
export type RoleOptions = Pick<LLMRequest, 'model' | 'timeoutMs' | 'signal' | 'maxOutputTokens'>;
