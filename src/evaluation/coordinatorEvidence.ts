import type { WorkflowRun } from '../workflows/agentWorkflow.js';
import type { CoordinatorEvidenceEvent } from '../workflows/coordinatorEvidenceLedger.js';
import type { ScenarioExecution } from './types.js';

/** Read-only evidence supplied by the authoritative TaskGate coordinator and trusted server composition. */
export type CoordinatorEvidenceSnapshot = Readonly<{
  run?: WorkflowRun;
  events?: readonly CoordinatorEvidenceEvent[];
  gateways?: ScenarioExecution['gateways'];
  adapters?: ScenarioExecution['adapters'];
  approvals?: ScenarioExecution['approvals'];
  claims?: ScenarioExecution['claims'];
  injection?: ScenarioExecution['injection'];
  coverage?: ScenarioExecution['coverage'];
}>;

/** The public run view is deliberately sparse; this projection adds no facts. */
export function snapshotCoordinatorRun(run: WorkflowRun | undefined, events: readonly CoordinatorEvidenceEvent[] = []): CoordinatorEvidenceSnapshot | undefined {
  return run === undefined ? undefined : Object.freeze({ run, events: Object.freeze(events.map((event) => Object.freeze({ ...event }))) });
}
