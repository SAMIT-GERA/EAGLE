import { recoveryInputSchema, recoveryNoteSchema } from './schemas.js';
import type { RecoveryInput, RecoveryNote } from './schemas.js';
import type { LLMClient, RoleOptions, RoleResult } from './llmClient.js';
import { invokeRole } from './roles.js';

export async function runRecovery(
  client: LLMClient, input: RecoveryInput, options?: RoleOptions
): Promise<RoleResult<RecoveryNote>> {
  const parsed = recoveryInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid recovery input');
  const result = await invokeRole(client, 'recovery', parsed.data, recoveryNoteSchema, options);
  if (result.ok && (
    (parsed.data.outcome === 'uncertain' && (result.output.nextStep !== 'stop' || result.output.suggestedAction)) ||
    (parsed.data.outcome === 'pending' && (
      !['wait_for_approval', 'stop'].includes(result.output.nextStep) || result.output.suggestedAction
    ))
  )) {
    return { ok: false, trace: { ...result.trace, status: 'failed', errorCategory: 'invalid_output' } };
  }
  return result;
}
