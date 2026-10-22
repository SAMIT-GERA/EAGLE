import { reviewerInputSchema, reviewNoteSchema } from './schemas.js';
import type { ReviewerInput, ReviewNote } from './schemas.js';
import type { LLMClient, RoleOptions, RoleResult } from './llmClient.js';
import { invokeRole } from './roles.js';

export async function runReviewer(
  client: LLMClient, input: ReviewerInput, options?: RoleOptions
): Promise<RoleResult<ReviewNote>> {
  const parsed = reviewerInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid reviewer input');
  return invokeRole(client, 'reviewer', parsed.data, reviewNoteSchema, options);
}
