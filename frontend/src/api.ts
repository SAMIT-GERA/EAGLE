export type ApiFailureKind = 'network' | 'backend' | 'security';
export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; status: number; error: string; kind: ApiFailureKind };

export type Grant = { taskId: string; version: number; confirmed: boolean; approvedFileIds: string[]; permittedTools: string[]; prohibitedOperations: string[]; approvalEligibleTools: string[] };
export type Receipt = { receiptId: string; taskId: string; callId: string; tool: string; argsDigest: string; grantVersion: number; policyVersion: string; decision: 'allow' | 'block' | 'request_approval'; ruleId: string; executionStatus: 'succeeded' | 'failed' | 'not_executed'; timestamp: string; adapterOutcome: string };
export type Run = { runId: string; taskId: string; state: 'running'|'waiting_for_approval'|'completed'|'blocked'|'failed'|'uncertain'; traces: Array<{kind: string; summary: string; decision?: string; ruleId?: string}>; quotations: Array<{fileId: string; accepted: boolean; source: Record<string, unknown>}>; comparison: Comparison; pendingCall?: {taskId: string; callId: string; tool: string}; lastResponse?: {decision: {decision: string; reason: string; ruleId: string}; receipt: Receipt}; claim?: ClaimResult };
export type Comparison = { status: 'insufficient_evidence'|'incompatible'|'compared'; reason?: string; reasons?: string[]; currency?: string; quantity?: number; quantityUnit?: string; item?: string; absoluteDifference?: string; percentageDifference?: string|null; cheaperFileId?: string|null; fasterFileId?: string|null; tradeoff?: boolean; entries?: Array<{fileId:string; supplier:string; total:string; leadTimeDays:number; paymentTerms:string}> };
export type ClaimResult = { claimId: string; verdict: 'supported'|'contradiction'|'missing_evidence'; matchingReceiptIds: string[]; explanation: string };
export type PendingApproval = { taskId: string; callId: string; recipient: '[redacted]'; subject: '[redacted]'; body: '[redacted]' };
export type Dispatch = { decision: {decision: 'allow'|'block'|'request_approval'; reason: string; ruleId: string}; receipt: Receipt; data?: unknown };
export type UploadSession={sessionId:string;capability:string;expiresAt:string;maxDocuments:number};
export type UploadedDocument={documentId:string;status:'needs_confirmation'|'confirmed';originalSha256:string;normalizedSha256?:string;errors:string[];extraction?:{supplier:string;item:string;quantity:number;quantityUnit:'each'|'kg';unitPrice:number|string;currency:string;leadTimeDays:number;paymentTerms:string};trustLabel:'untrusted_document'};
export type UploadedTask={taskId:string;grantVersion:string;aliases:string[];createdAt:string};

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, { ...init, signal, headers: { Accept: 'application/json', ...(init.body ? {'Content-Type':'application/json'} : {}), ...init.headers } });
    const body: unknown = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, data: body as T, status: response.status };
    const error = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    return { ok: false, status: response.status, error, kind: response.status === 401 || response.status === 403 ? 'security' : 'backend' };
  } catch (error) { return { ok: false, status: 0, error: error instanceof Error ? error.message : 'Network request failed', kind: 'network' }; }
}
const json = (value: unknown) => JSON.stringify(value);
export const api = {
  grant: () => request<{grant: Grant}>('/api/grant'),
  confirmGrant: (operatorPin: string) => request<{grant: Grant}>('/api/grant/confirm', {method:'POST',body:json({operatorPin})}),
  startRun: (goal: string, signal?: AbortSignal) => request<Run>('/api/agent/run', {method:'POST',body:json({goal})}, signal),
  getRun: (runId: string, signal?: AbortSignal) => request<Run>(`/api/runs/${encodeURIComponent(runId)}`, {}, signal),
  pending: (pin: string) => request<PendingApproval[]>('/api/pending-approvals', {headers:{'X-Operator-Pin':pin}}),
  approve: (taskId: string, callId: string, operatorPin: string) => request<{approvalId:string;expiresAt:string}>('/api/approve', {method:'POST',body:json({taskId,callId,operatorPin})}),
  resume: (runId: string, approvalId: string, pin: string) => request<Run>(`/api/runs/${encodeURIComponent(runId)}/resume`, {method:'POST',headers:{'X-Operator-Pin':pin},body:json({approvalId})}),
  tool: (call: {taskId:string;callId:string;tool:string;args:unknown;approvalId?:string}) => request<Dispatch>('/api/tool-call', {method:'POST',body:json(call)}),
  receipts: (pin: string) => request<Receipt[]>('/api/receipts', {headers:{'X-Operator-Pin':pin}}),
  verifyClaim: (pin: string, claim: {claimId:string;taskId:string;callId:string;kind:'email_sent';recipient:string;subjectDigest:string;bodyDigest:string}) => request<ClaimResult>('/api/claims/verify', {method:'POST',headers:{'X-Operator-Pin':pin},body:json(claim)})
  ,createUploadSession:()=>request<UploadSession>('/api/uploads/sessions',{method:'POST',body:json({})}),
  uploadDocument:(session:UploadSession,file:File)=>request<UploadedDocument>(`/api/uploads/sessions/${encodeURIComponent(session.sessionId)}/documents`,{method:'POST',headers:{'X-Upload-Capability':session.capability,'X-Upload-Filename':file.name,'Content-Type':file.type||'application/octet-stream'},body:file}),
  confirmDocument:(session:UploadSession,id:string,fields:NonNullable<UploadedDocument['extraction']>)=>request<UploadedDocument>(`/api/uploads/sessions/${encodeURIComponent(session.sessionId)}/documents/${encodeURIComponent(id)}/confirm`,{method:'POST',headers:{'X-Upload-Capability':session.capability},body:json(fields)}),
  bindUploadedTask:(session:UploadSession,ids:string[],operatorPin:string)=>request<UploadedTask>(`/api/uploads/sessions/${encodeURIComponent(session.sessionId)}/bind-task`,{method:'POST',headers:{'X-Upload-Capability':session.capability},body:json({documentIds:ids,operatorPin})}),
  startUploadedRun:(session:UploadSession,taskId:string,goal:string,operatorPin:string)=>request<Run>(`/api/uploads/sessions/${encodeURIComponent(session.sessionId)}/tasks/${encodeURIComponent(taskId)}/run`,{method:'POST',headers:{'X-Upload-Capability':session.capability},body:json({goal,operatorPin})})
};
