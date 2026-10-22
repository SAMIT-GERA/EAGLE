import { plannerInputSchema, plannerOutputSchema } from './schemas.js';
import type { PlannerInput, PlannerOutput } from './schemas.js';
import type { LLMClient, RoleOptions, RoleResult } from './llmClient.js';
import { invokeRole } from './roles.js';

export async function runPlanner(
  client: LLMClient, input: PlannerInput, options?: RoleOptions
): Promise<RoleResult<PlannerOutput>> {
  const parsed = plannerInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid planner input');
  return invokeRole(client, 'planner', parsed.data, plannerOutputSchema, options);
}
