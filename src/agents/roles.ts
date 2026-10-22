import type { z } from 'zod';
import { PROMPT_VERSION, ROLE_PROMPTS } from './prompts.js';
import { roleResponseSchemas } from './schemas.js';
import type { AgentRole } from './schemas.js';
import type { LLMClient, RoleOptions, RoleResult } from './llmClient.js';

/** One provider invocation per role call; malformed outputs are never retried. */
export async function invokeRole<T>(
  client: LLMClient, role: AgentRole, content: unknown,
  outputSchema: z.ZodType<T>, options: RoleOptions = {}
): Promise<RoleResult<T>> {
  let response;
  try {
    response = await client.invoke({
      role, system: ROLE_PROMPTS[role], content: JSON.stringify(content),
      responseSchema: structuredClone(roleResponseSchemas[role]), promptVersion: PROMPT_VERSION,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch {
    // A throwing client violates the result/metadata contract. Do not fabricate
    // request counts, model results or provider traces to conceal that failure.
    throw new Error('LLM client failed without invocation metadata');
  }
  if (!response.ok) return { ok: false, trace: { ...response.trace } };
  try {
    if (response.trace.role !== role || response.trace.promptVersion !== PROMPT_VERSION ||
      response.trace.status !== 'succeeded') throw new Error('Invalid invocation metadata');
    const parsed = outputSchema.safeParse(JSON.parse(response.text));
    if (!parsed.success) throw new Error('Invalid role output');
    return { ok: true, output: parsed.data, trace: { ...response.trace } };
  } catch {
    return {
      ok: false,
      trace: { ...response.trace, status: 'failed', errorCategory: 'invalid_output' }
    };
  }
}
