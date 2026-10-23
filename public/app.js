const state = {
  receipts: [], pending: [], activity: [], approvalId: undefined, latestEvidence: undefined,
  uncertain: 0, sequence: 0, grant: undefined, agentRun: undefined
};

const $ = (selector) => document.querySelector(selector);

export function statusClass(value) {
  if (value === 'allow' || value === 'succeeded') return 'allow';
  if (value === 'block' || value === 'failed' || value === 'uncertain') return 'block';
  return 'request_approval';
}

export function statusLabel(value) {
  return ({ allow: 'Allowed', block: 'Blocked', request_approval: 'Approval required', succeeded: 'Executed successfully', failed: 'Definite failure', not_executed: 'Not executed', uncertain: 'Outcome uncertain' })[value] ?? String(value);
}

// The operator route currently returns a redacted array. Accepting one row as
// well keeps this UI resilient to a compatible single-row transport response,
// without ever accepting an unstructured wrapper or exposing message content.
export function normalizePendingApprovals(body) {
  const candidates = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : undefined;
  if (!candidates) return undefined;
  const rows = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') return undefined;
    const { taskId, callId, recipient, subject, body: messageBody } = candidate;
    if ([taskId, callId, recipient, subject, messageBody].some((value) => typeof value !== 'string')) return undefined;
    rows.push(Object.freeze({ taskId, callId, recipient, subject, body: messageBody }));
  }
  return rows;
}

function operatorPin() { return $('#operator-pin').value; }
function headers(operator = false) { return operator && operatorPin() ? { 'X-Operator-Pin': operatorPin() } : {}; }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }

function showToast(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${error ? ' error' : ''}`;
  window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { toast.className = 'toast'; }, 3600);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) }
    });
  } catch {
    return { ok: false, status: 0, body: { error: 'Network request failed. Check the local TaskGate server.' } };
  }
  if (response.status === 204) return { ok: response.ok, status: response.status, body: undefined };
  let body;
  try { body = await response.json(); } catch { body = { error: 'Server returned an unreadable response.' }; }
  return { ok: response.ok, status: response.status, body };
}

function renderMetrics() {
  const decisionRows = new Map();
  for (const receipt of state.receipts) {
    const key = `${receipt.taskId}:${receipt.callId}`;
    if (!decisionRows.has(key) || receipt.executionStatus === 'not_executed') decisionRows.set(key, receipt);
  }
  const decisions = [...decisionRows.values()];
  $('#metric-allowed').textContent = String(decisions.filter((row) => row.decision === 'allow').length);
  $('#metric-blocked').textContent = String(decisions.filter((row) => row.decision === 'block').length);
  $('#metric-pending').textContent = String(state.pending.length);
  $('#metric-succeeded').textContent = String(state.receipts.filter((row) => row.executionStatus === 'succeeded').length);
  $('#metric-risk').textContent = String(state.receipts.filter((row) => row.executionStatus === 'failed').length + state.uncertain);
}

function renderActivity() {
  const root = $('#activity'); clear(root);
  if (state.activity.length === 0) { root.className = 'timeline empty'; root.textContent = 'No gateway calls in this browser session.'; return; }
  root.className = 'timeline';
  for (const item of state.activity.slice().reverse()) {
    const row = element('div', undefined, 'event'); const top = element('div', undefined, 'event-top');
    top.append(element('strong', item.tool), element('span', statusLabel(item.status), `tag ${statusClass(item.status)}`));
    row.append(top, element('small', `${item.callId} · ${item.ruleId ?? 'transport'} · ${item.detail}`)); root.append(row);
  }
}

function renderPending() {
  const root = $('#pending-list'); clear(root);
  if (state.pending.length === 0) { root.className = 'empty'; root.textContent = operatorPin() ? 'No pending approvals.' : 'Operator authentication is required to view pending requests.'; return; }
  root.className = 'timeline';
  for (const pending of state.pending) {
    const row = element('div', undefined, 'pending-row');
    row.append(
      element('strong', `${pending.taskId} · ${pending.callId}`),
      element('small', `Recipient: ${pending.recipient}`),
      element('small', `Subject: ${pending.subject}`),
      element('small', `Body: ${pending.body}`)
    );
    root.append(row);
  }
}

function renderReceipts() {
  const root = $('#receipts'); clear(root);
  if (state.receipts.length === 0) { root.className = 'receipt-list empty'; root.textContent = operatorPin() ? 'No durable receipts yet.' : 'Operator authentication is required to view receipts.'; return; }
  root.className = 'receipt-list';
  for (const receipt of state.receipts.slice().reverse()) {
    const row = element('div', undefined, 'receipt'); const top = element('div', undefined, 'receipt-top');
    top.append(element('strong', receipt.tool), element('span', statusLabel(receipt.executionStatus), `tag ${statusClass(receipt.executionStatus)}`));
    row.append(top, element('small', `${receipt.taskId} · ${receipt.callId} · ${receipt.ruleId}`), element('small', new Date(receipt.timestamp).toLocaleString())); root.append(row);
  }
}

function addActivity(tool, callId, status, ruleId, detail) {
  state.activity.push({ tool, callId, status, ruleId, detail }); renderActivity();
}

async function refreshGrant() {
  const result = await api('/api/grant');
  if (!result.ok) { state.grant = undefined; $('#grant-state').textContent = 'Not confirmed'; $('#grant-state').className = 'status-chip neutral'; $('#grant-detail').textContent = 'Confirm the demo grant to activate controlled actions.'; return; }
  state.grant = result.body.grant; const grant = state.grant;
  $('#grant-state').textContent = grant.confirmed ? 'Confirmed' : 'Inactive'; $('#grant-state').className = `status-chip ${grant.confirmed ? 'good' : 'warn'}`;
  const root = $('#grant-detail'); clear(root); root.className = 'timeline';
  root.append(element('div', `Task ${grant.taskId} · version ${grant.version}`, 'event'), element('div', `Resources: ${grant.approvedFileIds.join(', ')} · Tools: ${grant.permittedTools.join(', ')}`, 'event'));
}

async function refreshReceipts() {
  const result = await api('/api/receipts', { headers: headers(true) });
  if (!result.ok) { state.receipts = []; renderReceipts(); renderMetrics(); if (operatorPin()) showToast(result.body.error ?? 'Unable to load receipts.', true); return; }
  state.receipts = result.body; renderReceipts(); renderMetrics();
}

async function refreshPending() {
  const result = await api('/api/pending-approvals', { headers: headers(true) });
  if (!result.ok) { state.pending = []; renderPending(); renderMetrics(); if (operatorPin()) showToast(result.body.error ?? 'Unable to load pending approvals.', true); return; }
  const pending = normalizePendingApprovals(result.body);
  if (!pending) { state.pending = []; renderPending(); renderMetrics(); showToast('Pending approval response had an unexpected format.', true); return; }
  state.pending = pending; renderPending(); renderMetrics();
}

async function refreshAll() { await Promise.all([refreshGrant(), refreshReceipts(), refreshPending()]); }
function nextCallId(prefix) { state.sequence += 1; return `${prefix}-${state.sequence}`; }
function emailCall(approvalId) { return { taskId: state.grant?.taskId ?? 'demo-task', callId: 'demo-email-1', tool: 'send_clarification_email', args: { recipient: 'supplier@example.test', subject: 'Clarification request', body: 'Please confirm lead time and payment terms.' }, ...(approvalId ? { approvalId } : {}) }; }

async function toolCall(call) {
  const result = await api('/api/tool-call', { method: 'POST', body: JSON.stringify(call) });
  if (result.status === 503) { state.uncertain += 1; addActivity(call.tool, call.callId, 'uncertain', 'transport', result.body.error); showToast('Outcome is uncertain. Do not resend automatically.', true); renderMetrics(); return result; }
  const decision = result.body?.decision;
  if (!result.ok) { addActivity(call.tool, call.callId, decision?.decision ?? 'block', decision?.ruleId, result.body?.error ?? 'Gateway request failed'); showToast(result.body?.error ?? 'Gateway request failed.', true); return result; }
  const execution = result.body.receipt.executionStatus;
  addActivity(call.tool, call.callId, decision.decision, decision.ruleId, `${statusLabel(execution)} · ${decision.reason}`);
  if (result.body.data?.documentText !== undefined) $('#quote-output').textContent = result.body.data.documentText;
  if (result.body.data?.subjectDigest && execution === 'succeeded') state.latestEvidence = result.body.data;
  await Promise.all([refreshReceipts(), refreshPending()]); return result;
}

async function confirmGrant() {
  const result = await api('/api/grant/confirm', { method: 'POST', body: JSON.stringify({ operatorPin: operatorPin() }) });
  if (!result.ok) { showToast(result.body.error ?? 'Grant confirmation failed.', true); return; }
  showToast('Grant confirmed through the operator route.'); await refreshAll();
}

async function approvePending() {
  const call = state.agentRun?.pendingCall ?? emailCall(); const result = await api('/api/approve', { method: 'POST', body: JSON.stringify({ taskId: call.taskId, callId: call.callId, operatorPin: operatorPin() }) });
  if (!result.ok) { showToast(result.body.error ?? 'Approval was not issued.', true); return; }
  state.approvalId = result.body.approvalId; showToast(`Approval issued until ${new Date(result.body.expiresAt).toLocaleTimeString()}.`); await refreshPending();
}

async function executeApproved() {
  if (!state.approvalId) { showToast('Approve the exact pending email first.', true); return; }
  if (state.agentRun?.state === 'waiting_for_approval') { const result = await api(`/api/runs/${state.agentRun.runId}/resume`, { method: 'POST', headers: headers(true), body: JSON.stringify({ approvalId: state.approvalId }) }); if (!result.ok) { showToast(result.body?.error ?? 'Workflow resume failed.', true); return; } state.agentRun = result.body; renderRun(result.body); state.approvalId = undefined; await Promise.all([refreshReceipts(), refreshPending()]); return; }
  await toolCall(emailCall(state.approvalId)); state.approvalId = undefined;
}

async function setMode(mode) {
  const result = await api('/api/mock-mail-mode', { method: 'POST', body: JSON.stringify({ mode, operatorPin: operatorPin() }) });
  const message = result.ok && result.status === 204 ? `Mock mail mode set to ${mode}.` : (result.body?.error ?? 'Mode change failed.');
  $('#mode-result').textContent = message; showToast(message, !result.ok);
}

async function verifyClaim() {
  const evidence = state.latestEvidence;
  if (!evidence) { showToast('A real successful mock-mail evidence record is required first.', true); return; }
  const result = await api('/api/claims/verify', { method: 'POST', headers: headers(true), body: JSON.stringify({ claimId: `claim-${evidence.callId}`, taskId: evidence.taskId, callId: evidence.callId, kind: 'email_sent', recipient: evidence.canonicalRecipient, subjectDigest: evidence.subjectDigest, bodyDigest: evidence.bodyDigest }) });
  $('#claim-result').textContent = result.ok ? `${result.body.verdict}: ${result.body.explanation}` : (result.body?.error ?? 'Claim verification failed.');
  showToast($('#claim-result').textContent, !result.ok || result.body?.verdict !== 'supported');
}
function renderRun(run) { state.agentRun = run; const root = $('#agent-run'); root.textContent = `Run ${run.runId} · ${run.state}\n${(run.traces ?? []).map((trace) => `${trace.kind}: ${trace.summary}${trace.ruleId ? ` (${trace.ruleId})` : ''}`).join('\n')}`; }
async function startAgentRun() { const result = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ goal: $('#agent-goal').value }) }); if (!result.ok) { showToast(result.body?.error ?? 'Agent run failed to start.', true); return; } renderRun(result.body); showToast('Agent run completed its current server-owned step.'); await Promise.all([refreshReceipts(), refreshPending()]); }

async function boot() {
  const health = await api('/api/health'); const chip = $('#server-status');
  chip.textContent = health.ok ? `${health.body.version} online` : 'Server unavailable'; chip.className = `status-chip ${health.ok ? 'good' : 'bad'}`;
  await refreshGrant(); renderActivity(); renderPending(); renderReceipts(); renderMetrics();
  $('#confirm-grant').addEventListener('click', confirmGrant); $('#refresh-all').addEventListener('click', refreshAll); $('#refresh-pending').addEventListener('click', refreshPending); $('#refresh-receipts').addEventListener('click', refreshReceipts); $('#approve-pending').addEventListener('click', approvePending); $('#execute-approved').addEventListener('click', executeApproved); $('#verify-claim').addEventListener('click', verifyClaim); $('#start-agent').addEventListener('click', startAgentRun);
  $('#operator-pin').addEventListener('change', () => { void refreshReceipts(); void refreshPending(); });
  document.querySelectorAll('.mode-control').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'quote-a') void toolCall({ taskId: state.grant?.taskId ?? 'demo-task', callId: nextCallId('quote-a'), tool: 'read_quote', args: { fileId: 'quote-A' } });
    if (action === 'quote-b') void toolCall({ taskId: state.grant?.taskId ?? 'demo-task', callId: nextCallId('quote-b'), tool: 'read_quote', args: { fileId: 'quote-B' } });
    if (action === 'delete') void toolCall({ taskId: state.grant?.taskId ?? 'demo-task', callId: nextCallId('delete'), tool: 'delete_quote', args: { fileId: 'quote-A' } });
    if (action === 'request-email') void toolCall(emailCall());
  }));
}

if (typeof document !== 'undefined') void boot();
