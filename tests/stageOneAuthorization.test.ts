import { describe, expect, it } from 'vitest';
import { NEBULA, ORBIT, PIN, startUploadServer } from './support/uploadHarness.js';

describe('Stage 1 operator authorization and quotation correction', () => {
  it('requires the real PIN to confirm the sample grant and reports an already-confirmed grant', async () => {
    const app = await startUploadServer();
    try {
      expect((await app.request('GET', '/api/grant')).status).toBe(404);
      expect((await app.request('POST', '/api/grant/confirm', { operatorPin: 'wrong' })).status).toBe(401);
      expect((await app.request('GET', '/api/grant')).status).toBe(404);
      const confirmed = await app.request('POST', '/api/grant/confirm', { operatorPin: PIN });
      expect(confirmed).toMatchObject({ status: 200, data: { grant: { taskId: 'demo-task', confirmed: true } } });
      expect((await app.request('GET', '/api/grant')).data).toMatchObject({ grant: { taskId: 'demo-task', confirmed: true } });
      const repeated = await app.request('POST', '/api/grant/confirm', { operatorPin: PIN });
      expect(repeated.data).toEqual(confirmed.data);
    } finally { await app.close(); }
  });

  it('corrects an unsupported unit explicitly, preserves original integrity, and binds without the sample grant', async () => {
    const app = await startUploadServer();
    try {
      const session = (await app.request('POST', '/api/uploads/sessions', {})).data as { sessionId: string; capability: string };
      const invalid = await app.uploadDocument(session.sessionId, session.capability, 'orbit.json', { ...ORBIT, quantityUnit: 'units' });
      expect(invalid.status).toBe(201);
      const document = invalid.data as { documentId: string; status: string; originalSha256: string; normalizedSha256?: string; errors: string[]; correctionDraft: { quantityUnit: string; supplier: string } };
      expect(document).toMatchObject({ status: 'needs_confirmation', correctionDraft: { supplier: ORBIT.supplier, quantityUnit: 'units' } });
      expect(document.normalizedSha256).toBeUndefined();
      expect(document.errors).toContain('Quantity unit "units" is unsupported. Choose "each" or "kg" before confirming.');
      const path = `/api/uploads/sessions/${session.sessionId}/documents/${document.documentId}/confirm`;
      const headers = { 'X-Upload-Capability': session.capability };
      expect((await app.request('POST', path, { ...ORBIT, quantityUnit: 'units' }, headers)).status).toBe(400);
      expect((await app.request('GET', `/api/uploads/sessions/${session.sessionId}/documents/${document.documentId}`, undefined, headers)).data).toMatchObject({ status: 'needs_confirmation' });
      const corrected = await app.request('POST', path, ORBIT, headers);
      expect(corrected).toMatchObject({ status: 200, data: { status: 'confirmed', originalSha256: document.originalSha256, normalizedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const second = await app.uploadDocument(session.sessionId, session.capability, 'nebula.json', NEBULA);
      const secondId = (second.data as { documentId: string }).documentId;
      expect((await app.request('POST', `/api/uploads/sessions/${session.sessionId}/documents/${secondId}/confirm`, NEBULA, headers)).status).toBe(200);
      const bindPath = `/api/uploads/sessions/${session.sessionId}/bind-task`;
      const ids = [document.documentId, secondId];
      expect((await app.request('POST', bindPath, { documentIds: ids, operatorPin: 'wrong' }, headers)).status).toBe(401);
      expect((await app.request('GET', '/api/grant')).status).toBe(404);
      const bound = await app.request('POST', bindPath, { documentIds: ids, operatorPin: PIN }, headers);
      expect(bound).toMatchObject({ status: 201, data: { grantConfirmed: true, grantVersion: 'upload-v1', aliases: ['quote-A', 'quote-B'] } });
      const taskId = (bound.data as { taskId: string }).taskId;
      expect(app.server.grantStore.resolve(taskId).record?.grant.confirmed).toBe(true);
      expect((await app.request('GET', '/api/grant')).status).toBe(404);
    } finally { await app.close(); }
  });

  it('provides editable untrusted hints for a nested item with an ambiguous unit', async () => {
    const app = await startUploadServer();
    try {
      const session = (await app.request('POST', '/api/uploads/sessions', {})).data as { sessionId: string; capability: string };
      const uploaded = await app.uploadDocument(session.sessionId, session.capability, 'nested.json', {
        supplier: ORBIT.supplier, item: { name: ORBIT.item, quantity: ORBIT.quantity, quantityUnit: 'units', unitPrice: ORBIT.unitPrice },
        currency: 'INR', leadTimeDays: 3, paymentTerms: 'Net 17'
      });
      expect(uploaded.data).toMatchObject({ status: 'needs_confirmation', correctionDraft: { item: ORBIT.item, quantity: '10', quantityUnit: 'units', unitPrice: ORBIT.unitPrice }, errors: expect.arrayContaining([expect.stringContaining('Choose "each" or "kg"')]) });
      expect((uploaded.data as { normalizedSha256?: string }).normalizedSha256).toBeUndefined();
    } finally { await app.close(); }
  });
});
