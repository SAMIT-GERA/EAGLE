import type { ApiResult, Grant, UploadCorrectionDraft, UploadedDocument, UploadedTask } from './api';

export type StageOneMode = 'sample' | 'upload' | undefined;

export function correctionFor(document: UploadedDocument): UploadCorrectionDraft | undefined {
  if (document.correctionDraft) return { ...document.correctionDraft };
  const value = document.extraction;
  return value && {
    supplier: value.supplier, item: value.item, quantity: String(value.quantity),
    quantityUnit: value.quantityUnit, unitPrice: String(value.unitPrice), currency: value.currency,
    leadTimeDays: String(value.leadTimeDays), paymentTerms: value.paymentTerms
  };
}

/** Keeps a failed upload from changing the local document scope. Server records remain authoritative. */
export function retainDocumentsAfterUpload(documents: readonly UploadedDocument[], result: ApiResult<UploadedDocument>): UploadedDocument[] {
  if (!result.ok || documents.some(document => document.documentId === result.data.documentId) || documents.length >= 2) return [...documents];
  return [...documents, result.data];
}

export function buildCorrection(draft: UploadCorrectionDraft):
  | { ok: true; value: { supplier:string;item:string;quantity:number;quantityUnit:'each'|'kg';unitPrice:string;currency:string;leadTimeDays:number;paymentTerms:string;documentText?:string } }
  | { ok: false; error: string } {
  if (!draft.supplier.trim() || !draft.item.trim() || !draft.unitPrice.trim() || !draft.paymentTerms.trim())
    return { ok: false, error: 'Supplier, item, unit price and payment terms are required.' };
  if (draft.quantityUnit !== 'each' && draft.quantityUnit !== 'kg')
    return { ok: false, error: 'Choose a quantity unit: each or kg. The uploaded value is not accepted automatically.' };
  if (!['INR', 'USD', 'EUR', 'GBP'].includes(draft.currency))
    return { ok: false, error: 'Choose a supported currency: INR, USD, EUR or GBP.' };
  if (!draft.quantity.trim() || !draft.leadTimeDays.trim())
    return { ok: false, error: 'Quantity and lead time are required.' };
  const quantity = Number(draft.quantity), leadTimeDays = Number(draft.leadTimeDays);
  if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(leadTimeDays) || leadTimeDays < 0)
    return { ok: false, error: 'Quantity must be a positive whole number and lead time a nonnegative whole number.' };
  return { ok: true, value: {
    supplier: draft.supplier.trim(), item: draft.item.trim(), quantity, quantityUnit: draft.quantityUnit,
    unitPrice: draft.unitPrice.trim(), currency: draft.currency, leadTimeDays,
    paymentTerms: draft.paymentTerms.trim(),
    ...(draft.documentText === undefined ? {} : { documentText: draft.documentText })
  } };
}

export function uploadedTaskReady(documents: readonly UploadedDocument[], task: UploadedTask | undefined): boolean {
  return documents.length === 2 && documents.every(document => document.status === 'confirmed' && /^[0-9a-f]{64}$/.test(document.normalizedSha256 ?? '')) &&
    task?.grantConfirmed === true && task.preflightDecision === 'ALLOW' && task.taskId.length > 0 && task.grantVersion.length > 0 &&
    task.aliases.length === 2 && task.aliases.includes('quote-A') && task.aliases.includes('quote-B');
}

export function stageOneMessage(mode: StageOneMode, grant: Grant | undefined, documents: readonly UploadedDocument[], task: UploadedTask | undefined, hasPin: boolean): string {
  if (mode === undefined) return 'Choose a sample or uploaded-document workflow to begin.';
  if (mode === 'sample') return grant?.confirmed ? 'Sample grant confirmed by the server. Continue to the agent workflow.' : hasPin ? 'Confirm the sample grant with your operator PIN before continuing.' : 'Enter the operator PIN, then confirm the sample grant.';
  if (task && uploadedTaskReady(documents, task)) return `Uploaded task ${task.taskId} has a server-confirmed grant (${task.grantVersion}). Continue to agent execution.`;
  if (task?.preflightDecision === 'REVIEW' || task?.preflightDecision === 'BLOCK') return `Uploaded task ${task.taskId} ${task.preflightDecision === 'REVIEW' ? 'requires security review' : 'is blocked'} by document preflight. Confirmed fields do not authorize model disclosure; start a new upload session after reviewing sanitized findings.`;
  if (task && task.preflightDecision !== 'ALLOW') return 'Document preflight is unavailable. Operational agent disclosure is denied.';
  if (documents.length < 2) return `Upload two quotations. ${documents.length} of 2 uploaded.`;
  const confirmed = documents.filter(document => document.status === 'confirmed' && document.normalizedSha256).length;
  if (confirmed < 2) return `${confirmed} of 2 quotations confirmed by the server. Review and correct the remaining fields.`;
  return hasPin ? 'Bind the two confirmed quotations with the operator PIN to create this uploaded task and grant.' : 'Enter the operator PIN, then bind the two confirmed quotations. The sample grant is not required.';
}
