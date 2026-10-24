import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GOAL, NEBULA, ORBIT, PIN, startUploadServer } from '../tests/support/uploadHarness.js';

type Timing = 'uploadMs' | 'confirmationMs' | 'bindingMs' | 'coordinatorMs' | 'totalMs';
const names: Timing[] = ['uploadMs', 'confirmationMs', 'bindingMs', 'coordinatorMs', 'totalMs'];
const measurements: Record<Timing, number[]> = { uploadMs: [], confirmationMs: [], bindingMs: [], coordinatorMs: [], totalMs: [] };
const warmups = 2;
const measured = 20;
const app = await startUploadServer();
let successes = 0;
let allowed = 0;
let denied = 0;
let pending = 0;

try {
  for (let index = 0; index < warmups + measured; index++) {
    const start = performance.now();
    const sessionResponse = await app.request('POST', '/api/uploads/sessions', {});
    if (sessionResponse.status !== 201) throw new Error(`Session ${index} failed`);
    const session = sessionResponse.data as { sessionId: string; capability: string };
    const documents: string[] = [];
    let uploadDuration = 0;
    let confirmationDuration = 0;
    for (const [documentIndex, quotation] of [ORBIT, NEBULA].entries()) {
      const uploadStart = performance.now();
      const uploaded = await app.uploadDocument(session.sessionId, session.capability, `${index}-${documentIndex}.json`, quotation);
      uploadDuration += performance.now() - uploadStart;
      if (uploaded.status !== 201) throw new Error(`Upload ${index}/${documentIndex} failed`);
      const documentId = (uploaded.data as { documentId: string }).documentId;
      documents.push(documentId);
      const confirmStart = performance.now();
      const confirmed = await app.request('POST', `/api/uploads/sessions/${session.sessionId}/documents/${documentId}/confirm`, quotation, { 'X-Upload-Capability': session.capability });
      confirmationDuration += performance.now() - confirmStart;
      if (confirmed.status !== 200) throw new Error(`Confirmation ${index}/${documentIndex} failed`);
    }
    const bindStart = performance.now();
    const bound = await app.request('POST', `/api/uploads/sessions/${session.sessionId}/bind-task`, { documentIds: documents, operatorPin: PIN }, { 'X-Upload-Capability': session.capability });
    const bindingDuration = performance.now() - bindStart;
    if (bound.status !== 201) throw new Error(`Binding ${index} failed`);
    const taskId = (bound.data as { taskId: string }).taskId;
    const coordinatorStart = performance.now();
    const started = await app.request('POST', `/api/uploads/sessions/${session.sessionId}/tasks/${taskId}/run`, { goal: GOAL, operatorPin: PIN }, { 'X-Upload-Capability': session.capability });
    const coordinatorDuration = performance.now() - coordinatorStart;
    const totalDuration = performance.now() - start;
    const run = started.data as { state?: string; comparison?: { status?: string; absoluteDifference?: string } };
    const success = started.status === 202 && run.state === 'completed' && run.comparison?.status === 'compared' && run.comparison.absoluteDifference === '66000.00';
    if (index >= warmups) {
      measurements.uploadMs.push(uploadDuration);
      measurements.confirmationMs.push(confirmationDuration);
      measurements.bindingMs.push(bindingDuration);
      measurements.coordinatorMs.push(coordinatorDuration);
      measurements.totalMs.push(totalDuration);
      if (success) successes++;
      const receipts = await app.request('GET', `/api/receipts?taskId=${taskId}`, undefined, { 'X-Operator-Pin': PIN });
      if (receipts.status !== 200) throw new Error(`Receipt retrieval ${index} failed`);
      const records = receipts.data as Array<{ callId: string; decision: string }>;
      const finalDecisions = new Map(records.map(record => [record.callId, record.decision]));
      for (const decision of finalDecisions.values()) {
        if (decision === 'allow') allowed++;
        else if (decision === 'block') denied++;
        else if (decision === 'approval_required') pending++;
      }
    }
    if (!success) throw new Error(`Workflow ${index} did not complete successfully`);
  }
} finally {
  await app.close();
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1];
  const round = (value: number) => Math.round(value * 100) / 100;
  return { min: round(sorted[0]!), median: round((sorted[9]! + sorted[10]!) / 2), mean: round(sorted.reduce((sum, item) => sum + item, 0) / sorted.length), p95: round(at(0.95)!), max: round(sorted.at(-1)!) };
}

const output = {
  mode: 'OFFLINE DETERMINISTIC PERFORMANCE', warmups, measured, successes, successRate: successes / measured,
  gatewayActions: { allowed, denied, pending },
  timingsMs: Object.fromEntries(names.map(name => [name, stats(measurements[name])])),
  unavailable: ['parsingMs', 'gatewayAuthorizationMs', 'quoteReadMs', 'comparisonGenerationMs'],
  limitations: ['HTTP loopback and fake model latency are included; these are not Gemini API timings.', 'Component timings unavailable without adding instrumentation to security-critical services.']
};
const directory = join(process.cwd(), 'evaluation-results', 'full-system-audit');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'performance.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
