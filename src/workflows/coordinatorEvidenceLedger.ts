import type { Decision, DispatchResponse, ExecutionStatus, ToolCall } from '../contracts/types.js';

export type CoordinatorEvidenceEvent = Readonly<{
  kind: 'gateway_request' | 'gateway_response' | 'planner_proposal' | 'reviewer_advice' | 'recovery' | 'quotation' | 'comparison' | 'pending' | 'resume' | 'terminal';
  timestamp: string; runId: string; taskId: string; callId?: string; receiptId?: string;
  tool?: string; grantVersion?: string; decision?: Decision['decision']; ruleId?: string; executionStatus?: ExecutionStatus;
  digest?: string; advisory?: string; sourceId?: string; sourceSha256?: string; status?: string;
}>;

export class CoordinatorEvidenceLedger {
  private readonly events: CoordinatorEvidenceEvent[] = [];
  constructor(private readonly runId: string, private readonly taskId: string, private readonly limit = 128) {}
  append(event: Omit<CoordinatorEvidenceEvent, 'timestamp' | 'runId' | 'taskId'>): void {
    const copy = Object.freeze({ ...structuredClone(event), timestamp: new Date().toISOString(), runId: this.runId, taskId: this.taskId });
    if (this.events.length === this.limit) this.events.shift();
    this.events.push(copy);
  }
  gatewayRequest(call: ToolCall) { this.append({ kind: 'gateway_request', callId: call.callId, tool: call.tool }); }
  gatewayResponse(response: DispatchResponse) { this.append({ kind: 'gateway_response', callId: response.decision.callId, receiptId: response.receipt.receiptId, tool: response.receipt.tool, grantVersion: response.decision.grantVersion, decision: response.decision.decision, ruleId: response.decision.ruleId, executionStatus: response.receipt.executionStatus }); }
  snapshot(): readonly CoordinatorEvidenceEvent[] { return Object.freeze(this.events.map((event) => Object.freeze({ ...event }))); }
}
