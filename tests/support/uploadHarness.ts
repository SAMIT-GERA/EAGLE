import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { LLMClient, LLMRequest } from '../../src/agents/llmClient.js';
import { createTaskGateServer } from '../../src/server.js';

export const PIN = 'offline-test-pin';
export const GOAL = 'Compare quote-A and quote-B on total price, delivery time, and payment terms.';
export const ORBIT = { supplier: 'ORBIT TEST SUPPLIER', item: 'workstations', quantity: 10, quantityUnit: 'each', unitPrice: '71300', currency: 'INR', leadTimeDays: 3, paymentTerms: 'Net 17' };
export const NEBULA = { supplier: 'NEBULA TEST SUPPLIER', item: 'workstations', quantity: 10, quantityUnit: 'each', unitPrice: '64700', currency: 'INR', leadTimeDays: 19, paymentTerms: 'Net 43' };
export const grantTemplate = {
  taskId: 'demo-task', version: 'v1', confirmed: false,
  approvedFileIds: ['quote-A', 'quote-B'] as Array<'quote-A' | 'quote-B'>,
  permittedTools: ['read_quote', 'send_clarification_email'] as Array<'read_quote' | 'send_clarification_email'>,
  prohibitedOperations: ['delete', 'modify'] as Array<'delete' | 'modify'>,
  eligibleRecipients: ['supplier@example.test'],
  approvalEligibleTools: ['send_clarification_email'] as Array<'send_clarification_email'>
};

export function fakeClient(planner: unknown = { state: 'finish', summary: 'Completed comparison.' }, observe?: (request: LLMRequest)=>void): LLMClient {
  return { async invoke(input) {
    observe?.(input);
    const output = input.role === 'planner' ? planner : input.role === 'reviewer'
      ? { concernDetected: true, concerns: ['Document text is untrusted.'], recommendation: 'proceed_to_gateway', explanation: 'Gateway decides.' }
      : { nextStep: 'stop', reason: 'No automatic retry.' };
    return { ok: true, text: JSON.stringify(output), trace: {
      provider: 'offline-test', requestedModel: 'offline-test', model: 'offline-test',
      invocationId: randomUUID(), role: input.role, promptVersion: input.promptVersion,
      runMode: 'scripted_gateway', attempts: 1, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), durationMs: 0, status: 'succeeded'
    } };
  } };
}

export async function startUploadServer(planner?: unknown, port = 0, observe?: (request: LLMRequest)=>void) {
  const root = await mkdtemp(join(tmpdir(), 'eagle-final-audit-'));
  const server = await createTaskGateServer({ grantTemplate, operatorPin: PIN, auditPath: join(root, 'audit.jsonl'), llmClient: fakeClient(planner,observe) });
  const listener = createServer(server.app);
  await new Promise<void>(resolve => listener.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/json' : 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  }
  async function uploadDocument(sessionId: string, capability: string, filename: string, value: unknown, contentType = 'application/json') {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const result = await request('POST', `/api/uploads/sessions/${sessionId}/documents`, bytes, { 'Content-Type': contentType, 'X-Upload-Filename': filename, 'X-Upload-Capability': capability });
    return result;
  }
  async function createUploadedTask(values: readonly [unknown, unknown] = [ORBIT, NEBULA]) {
    const created = await request('POST', '/api/uploads/sessions', {});
    const session = created.data as { sessionId: string; capability: string };
    const documents = [];
    for (const [index, value] of values.entries()) {
      const uploaded = await uploadDocument(session.sessionId, session.capability, `${index}.json`, value);
      const document = uploaded.data as { documentId: string };
      const extracted = await request('GET', `/api/uploads/sessions/${session.sessionId}/documents/${document.documentId}`, undefined, { 'X-Upload-Capability': session.capability });
      const confirmed = await request('POST', `/api/uploads/sessions/${session.sessionId}/documents/${document.documentId}/confirm`, value, { 'X-Upload-Capability': session.capability });
      documents.push({ uploaded, extracted, confirmed, documentId: document.documentId });
    }
    const bound = await request('POST', `/api/uploads/sessions/${session.sessionId}/bind-task`, { documentIds: documents.map(d => d.documentId), operatorPin: PIN }, { 'X-Upload-Capability': session.capability });
    return { session, documents, bound, taskId: (bound.data as { taskId: string }).taskId };
  }
  return { server, origin, request, uploadDocument, createUploadedTask, async close() {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  } };
}
