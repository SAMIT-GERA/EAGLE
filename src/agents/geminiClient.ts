import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentRoleSchema } from './schemas.js';
import type { InvocationTrace, LLMClient, LLMErrorCategory, LLMRequest, LLMResult } from './llmClient.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;
type Options = {
  apiKey?: string;
  model?: string;
  /** Injected transports are ALWAYS labelled scripted_gateway, never live_model. */
  transport?: HttpTransport;
};
const modelSchema = z.string().regex(/^gemini-[a-z0-9][a-z0-9._-]{0,80}$/);
const envelopeSchema = z.object({
  candidates: z.array(z.object({
    finishReason: z.string(),
    content: z.object({
      parts: z.array(z.object({
        text: z.string().optional(), thought: z.boolean().optional(),
        functionCall: z.unknown().optional()
      }))
    })
  })).min(1).max(1),
  modelVersion: z.string().regex(/^[a-zA-Z0-9._/-]{1,128}$/).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional()
  }).optional()
});
class Failure extends Error {
  constructor(readonly category: LLMErrorCategory, readonly retryable = false, readonly waitMs = 250) {
    super(category); // Never preserve raw provider errors, responses or credentials.
  }
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Failure('aborted')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Failure('aborted')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
async function timed<T>(
  operation: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort!: (error: Failure) => void;
  const abort = (category: 'aborted' | 'timeout') => {
    controller.abort();
    rejectAbort(new Failure(category, category === 'timeout'));
  };
  const parentAbort = () => abort('aborted');
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  parent?.addEventListener('abort', parentAbort, { once: true });
  timer = setTimeout(() => abort('timeout'), ms);
  try {
    if (parent?.aborted) throw new Failure('aborted');
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', parentAbort);
  }
}
function retryDelay(value: string | null): number {
  if (value === null) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 250;
}

/** Native generateContent only: no tools, grounding, billing calls or fallback.
 * REST fields checked against https://ai.google.dev/api/generate-content.
 */
export function createGeminiClient(options: Options = {}): LLMClient {
  return {
    async invoke(request: LLMRequest): Promise<LLMResult> {
      const started = Date.now();
      const key = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
      const selection = request.model ?? options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
      const validModel = modelSchema.safeParse(selection);
      const model = validModel.success && (!key || !selection.includes(key)) ? validModel.data : 'invalid-model';
      const version = /^[a-zA-Z0-9._:-]{1,80}$/.test(request.promptVersion) &&
        (!key || !request.promptVersion.includes(key)) ? request.promptVersion : 'invalid-version';
      const base = {
        provider: 'gemini', requestedModel: model, model,
        invocationId: randomUUID(),
        role: agentRoleSchema.safeParse(request.role).success ? request.role : 'planner' as const,
        promptVersion: version, startedAt: new Date(started).toISOString()
      };
      let attempts = 0;
      let reportedModel: string | undefined;
      let tokenUsage: InvocationTrace['tokenUsage'];
      const trace = (status: InvocationTrace['status'], errorCategory?: LLMErrorCategory): InvocationTrace => ({
        ...base, model: reportedModel ?? model,
        ...(reportedModel ? { modelVersion: reportedModel } : {}),
        attempts, runMode: attempts === 0 ? null : options.transport ? 'scripted_gateway' : 'live_model',
        endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - started), status,
        ...(errorCategory ? { errorCategory } : {}),
        ...(tokenUsage ? { tokenUsage } : {})
      });
      const fail = (category: LLMErrorCategory): LLMResult => ({ ok: false, trace: trace('failed', category) });
      if (model === 'invalid-model' || version === 'invalid-version' || !agentRoleSchema.safeParse(request.role).success) {
        return fail('configuration');
      }
      if (!key.trim()) return fail('missing_api_key');
      const timeoutMs = request.timeoutMs ?? 12_000;
      const maxOutputTokens = request.maxOutputTokens ?? 512;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000 ||
        !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_024 ||
        typeof request.system !== 'string' || !request.system || request.system.length > 4_000 ||
        typeof request.content !== 'string' || !request.content || request.content.length > 12_000) {
        return fail('configuration');
      }

      let body: string;
      try {
        body = JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.content }] }],
          generationConfig: {
            candidateCount: 1, maxOutputTokens, temperature: 0,
            responseMimeType: 'application/json', responseJsonSchema: request.responseSchema
          }
        });
        if (!request.responseSchema || body.length > 24_000 || body.includes(key)) return fail('configuration');
      } catch { return fail('configuration'); }

      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
      const transport = options.transport ?? ((url: string, init: RequestInit) => fetch(url, init));
      const deadline = started + Math.min(30_000, timeoutMs * 2 + 1_000);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (request.signal?.aborted) return fail('aborted');
        const remaining = deadline - Date.now();
        if (remaining <= 0) return fail('deadline');
        try {
          const text = await timed(async (signal) => {
            attempts++;
            const response = await transport(url, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
              body, signal, redirect: 'error'
            });
            if (!response.ok) {
              // Do not read or copy error response bodies.
              void response.body?.cancel().catch(() => undefined);
              if (response.status === 401 || response.status === 403) throw new Failure('authentication');
              if (response.status === 429) throw new Failure('rate_limit', true, retryDelay(response.headers.get('retry-after')));
              if (response.status >= 500) throw new Failure('provider_error', true, retryDelay(response.headers.get('retry-after')));
              throw new Failure('configuration');
            }
            const raw = await response.text();
            if (raw.length > 64_000 || raw.includes(key)) throw new Failure('invalid_response');
            let value: unknown;
            try { value = JSON.parse(raw); } catch { throw new Failure('invalid_response'); }
            if (typeof value === 'object' && value !== null && 'promptFeedback' in value) {
              const feedback = (value as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
              if (feedback?.blockReason) throw new Failure('safety');
            }
            const parsed = envelopeSchema.safeParse(value);
            if (!parsed.success) throw new Failure('invalid_response');
            const candidate = parsed.data.candidates[0];
            if (candidate.finishReason !== 'STOP' || candidate.content.parts.some((part) => part.functionCall !== undefined)) {
              throw new Failure('invalid_response');
            }
            const content = candidate.content.parts.filter((part) => !part.thought).map((part) => part.text ?? '').join('');
            if (!content) throw new Failure('invalid_response');
            reportedModel = parsed.data.modelVersion;
            const usage = parsed.data.usageMetadata;
            if (usage) tokenUsage = {
              ...(usage.promptTokenCount === undefined ? {} : { promptTokens: usage.promptTokenCount }),
              ...(usage.candidatesTokenCount === undefined ? {} : { outputTokens: usage.candidatesTokenCount }),
              ...(usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount })
            };
            return content;
          }, Math.min(timeoutMs, remaining), request.signal);
          return { ok: true, text, trace: trace('succeeded') };
        } catch (error) {
          const failure = error instanceof Failure ? error : new Failure('transport', true);
          if (request.signal?.aborted) return fail('aborted');
          if (!failure.retryable || attempt === 1) return fail(failure.category);
          // A long Retry-After ends the invocation instead of retrying early.
          if (failure.waitMs >= deadline - Date.now()) return fail(failure.category);
          try { await wait(failure.waitMs, request.signal); } catch { return fail('aborted'); }
        }
      }
      return fail('provider_error');
    }
  };
}
