import type { PreflightAssessment, UploadedTask } from './api';

export type SecurityTone = 'allow' | 'review' | 'block' | 'neutral';

export function preflightTone(value: PreflightAssessment['decision'] | UploadedTask['preflightDecision'] | undefined): SecurityTone {
  if (value === 'ALLOW') return 'allow';
  if (value === 'REVIEW') return 'review';
  if (value === 'BLOCK') return 'block';
  return 'neutral';
}

export function preflightMessage(value: PreflightAssessment['decision'] | UploadedTask['preflightDecision'] | undefined): string {
  if (value === 'ALLOW') return 'Operational AI access is permitted. Gemini receives only confirmed business fields required for this task.';
  if (value === 'REVIEW') return 'Operational AI access remains stopped. A review-release workflow is not implemented in this demonstration.';
  if (value === 'BLOCK') return 'Operational AI access remains stopped. This interface cannot override a blocking security finding.';
  return 'Inspection is unavailable; operational AI access fails closed.';
}

export function canEnterAgentExecution(mode: 'sample' | 'upload' | undefined, sampleConfirmed: boolean, task?: UploadedTask): boolean {
  return mode === 'sample' ? sampleConfirmed : mode === 'upload' && task?.preflightDecision === 'ALLOW' && task.grantConfirmed === true;
}

export function canAdvanceJourney(stage: number, readiness: { mode: 'sample' | 'upload' | undefined; sampleConfirmed: boolean; task?: UploadedTask; hasRun: boolean; hasEnforcementEvidence: boolean }): boolean {
  if (stage === 0) return readiness.mode === 'sample' ? readiness.sampleConfirmed : readiness.task !== undefined;
  if (stage === 1) return canEnterAgentExecution(readiness.mode, readiness.sampleConfirmed, readiness.task);
  if (stage === 2) return readiness.hasRun;
  if (stage === 3) return readiness.hasEnforcementEvidence;
  return false;
}

export function displayDocumentName(index: number, supplier?: string, item?: string): string {
  const label = supplier?.trim() || `Document ${index + 1}`;
  return item?.trim() ? `${label} — ${item}` : label;
}
