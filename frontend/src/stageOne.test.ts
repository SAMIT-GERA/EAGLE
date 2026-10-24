import { describe, expect, it } from 'vitest';
import type { Grant, UploadedDocument, UploadedTask } from './api';
import { buildCorrection, correctionFor, retainDocumentsAfterUpload, selectedFileNames, stageOneMessage, uploadedTaskReady } from './stageOne';

const digest = 'a'.repeat(64);
const draft = { supplier: 'ORBIT', item: 'workstations', quantity: '10', quantityUnit: 'units', unitPrice: '71300', currency: 'INR', leadTimeDays: '3', paymentTerms: 'Net 17' };
const document = (id: string, status: UploadedDocument['status']): UploadedDocument => ({ documentId: id, status, originalSha256: digest, ...(status === 'confirmed' ? { normalizedSha256: digest } : {}), errors: [], trustLabel: 'untrusted_document' });
const task: UploadedTask = { taskId: 'upload-task', grantVersion: 'upload-v1', grantConfirmed: true, aliases: ['quote-A', 'quote-B'], createdAt: '2026-10-24T00:00:00Z', preflightDecision: 'ALLOW' };
const grant: Grant = { taskId: 'demo-task', version: 'v1', confirmed: true, approvedFileIds: ['quote-A', 'quote-B'], permittedTools: ['read_quote'], prohibitedOperations: ['delete'], approvalEligibleTools: [] };

describe('Stage 1 view state', () => {
  it('requires explicit correction of unsupported quantity units', () => {
    const pending: UploadedDocument = { ...document('doc-1', 'needs_confirmation'), correctionDraft: draft, errors: ['Choose each or kg'] };
    expect(correctionFor(pending)?.quantityUnit).toBe('units');
    expect(buildCorrection(draft)).toMatchObject({ ok: false, error: expect.stringContaining('Choose a quantity unit') });
    expect(buildCorrection({ ...draft, quantityUnit: 'each' })).toMatchObject({ ok: true, value: { quantity: 10, quantityUnit: 'each', unitPrice: '71300' } });
  });

  it('never enables upload progression from two uploads alone or from a sample grant', () => {
    const pending = [document('doc-1', 'needs_confirmation'), document('doc-2', 'needs_confirmation')];
    expect(uploadedTaskReady(pending, task)).toBe(false);
    expect(stageOneMessage('upload', grant, pending, undefined, true)).toContain('0 of 2 quotations confirmed');
    const confirmed = [document('doc-1', 'confirmed'), document('doc-2', 'confirmed')];
    expect(uploadedTaskReady(confirmed, undefined)).toBe(false);
    expect(uploadedTaskReady(confirmed, { ...task, grantConfirmed: false })).toBe(false);
    expect(uploadedTaskReady(confirmed, task)).toBe(true);
    expect(uploadedTaskReady(confirmed, { ...task, preflightDecision: 'REVIEW' })).toBe(false);
    expect(stageOneMessage('upload', grant, confirmed, { ...task, preflightDecision: 'BLOCK' }, true)).toContain('model disclosure');
    expect(stageOneMessage('upload', grant, confirmed, undefined, false)).toContain('sample grant is not required');
    expect(stageOneMessage('upload', grant, confirmed, task, true)).toContain('server-confirmed grant');
  });

  it('distinguishes an already-confirmed sample grant from missing sample authorization', () => {
    expect(stageOneMessage('sample', undefined, [], undefined, true)).toContain('Confirm the sample grant');
    expect(stageOneMessage('sample', grant, [], undefined, false)).toContain('Sample grant confirmed');
  });

  it('does not corrupt the local document scope when session creation or an upload fails', () => {
    const first=document('doc-1','needs_confirmation');
    expect(retainDocumentsAfterUpload([],{ok:false,status:500,kind:'backend',error:'backend unavailable'})).toEqual([]);
    expect(retainDocumentsAfterUpload([first],{ok:false,status:404,kind:'backend',error:'stale upload session'})).toEqual([first]);
    expect(retainDocumentsAfterUpload([first],{ok:true,status:201,data:document('doc-2','needs_confirmation')})).toHaveLength(2);
    expect(retainDocumentsAfterUpload([first,document('doc-2','needs_confirmation')],{ok:true,status:201,data:document('doc-3','needs_confirmation')})).toHaveLength(2);
  });

  it('keeps the native two-document selection visible without submitting extra files', () => {
    expect(selectedFileNames([{name:'orbit.json'},{name:'nebula.json'},{name:'third.json'}],2)).toEqual(['orbit.json','nebula.json']);
    expect(selectedFileNames([{name:'orbit.json'}],0)).toEqual([]);
  });
});
