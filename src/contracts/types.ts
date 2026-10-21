export type ToolName = 'read_quote' | 'send_clarification_email' | 'delete_quote';
export type DecisionKind = 'allow' | 'block' | 'request_approval';
export type ExecutionStatus = 'succeeded' | 'failed' | 'not_executed';
export type ClaimVerdict = 'supported' | 'contradiction' | 'missing_evidence';
export type RunMode = 'live_model' | 'scripted_gateway';

export type TaskGrant = {
  taskId: string; version: string; confirmed: boolean;
  approvedFileIds: string[];
  permittedTools: Array<'read_quote' | 'send_clarification_email'>;
  prohibitedOperations: Array<'delete' | 'modify'>;
  eligibleRecipients: string[];
  approvalEligibleTools: Array<'send_clarification_email'>;
};

export type ToolCall = {
  callId: string; taskId: string; tool: string; args: unknown; approvalId?: string;
};

export type Decision = {
  callId: string; decision: DecisionKind; ruleId: string;
  reason: string; grantVersion: string;
};

export type Receipt = {
  receiptId: string; taskId: string; callId: string; tool: string;
  argsDigest: string; grantVersion: string; policyVersion: string;
  decision: DecisionKind; ruleId: string; approvalId?: string;
  executionStatus: ExecutionStatus; adapterOutcome: string; timestamp: string;
};

export type CanonicalEmail = {
  taskId: string; grantVersion: string; callId: string;
  tool: 'send_clarification_email'; recipient: string;
  subject: string; body: string;
};

export type Approval = {
  approvalId: string; taskId: string; callId: string; grantVersion: string;
  callDigest: string; expiresAt: string; used: boolean; approvedBy: string;
};

export type EmailDispatchEvidence = {
  taskId: string; callId: string; receiptId: string;
  canonicalRecipient: string; subjectDigest: string; bodyDigest: string;
};

export type CompletionClaim = {
  claimId: string; taskId: string; callId: string;
  kind: 'email_sent'; recipient: string;
  subjectDigest: string; bodyDigest: string;
};

export type ClaimCheck = {
  claimId: string; verdict: ClaimVerdict;
  matchingReceiptIds: string[]; explanation: string;
};

export type DispatchResponse = { decision: Decision; receipt: Receipt; data?: unknown };

export interface SecurityDependencies {
  canonicalizeEmail(call: ToolCall, grant: TaskGrant): CanonicalEmail;
  hashEmailAction(email: CanonicalEmail): string;
  approvalService: {
    registerPending(email: CanonicalEmail, digest: string): Promise<void>;
    approvePending(input: { taskId: string; callId: string; approvedBy: string }): Promise<{ approvalId: string; expiresAt: string }>;
    validateAndConsume(input: { email: CanonicalEmail; approvalId: string; digest: string }): Promise<boolean>;
    listPending(): Promise<Array<{ taskId: string; callId: string; recipient: string; subject: string; body: string }>>;
  };
  audit: {
    recordDecision(input: { call: ToolCall; decision: Decision; grant: TaskGrant; argsDigest: string; email?: CanonicalEmail }): Promise<Receipt>;
    beginDispatch(input: { callId: string; taskId: string; tool: string }): Promise<void>;
    recordOutcome(input: { preliminaryReceipt: Receipt; status: 'succeeded' | 'failed'; adapterOutcome: string }): Promise<Receipt>;
    listReceipts(taskId?: string): Promise<Receipt[]>;
  };
}
