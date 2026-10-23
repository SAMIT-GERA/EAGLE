import type { WorkflowRun } from '../workflows/agentWorkflow.js';
import type { ScenarioExecution } from './types.js';

/** Read-only evidence supplied by the authoritative TaskGate coordinator and trusted server composition. */
export type CoordinatorEvidenceSnapshot = Readonly<{
  run?: WorkflowRun;
  gateways?: ScenarioExecution['gateways'];
  adapters?: ScenarioExecution['adapters'];
  approvals?: ScenarioExecution['approvals'];
  claims?: ScenarioExecution['claims'];
  injection?: ScenarioExecution['injection'];
  coverage?: ScenarioExecution['coverage'];
}>;

/** The public run view is deliberately sparse; this projection adds no facts. */
export function snapshotCoordinatorRun(run: WorkflowRun | undefined): CoordinatorEvidenceSnapshot | undefined {
  return run === undefined ? undefined : Object.freeze({ run });
}
