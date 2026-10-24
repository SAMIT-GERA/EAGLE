import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());
function response(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('guided API client', () => {
  it('confirms a grant through the server route', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { grant: { taskId:'demo', version:'v1', confirmed:true, approvedFileIds:[], permittedTools:[], prohibitedOperations:[], approvalEligibleTools:[] } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await api.confirmGrant('operator-pin');
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe('/api/grant/confirm');
  });
  it('uses the authenticated header for redacted receipt retrieval', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, [])); vi.stubGlobal('fetch', fetcher);
    await api.receipts('pin');
    expect(fetcher.mock.calls[0][1].headers['X-Operator-Pin']).toBe('pin');
  });
  it('uses the operator PIN only for the controlled adversarial test endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { mode:'CONTROLLED_ADVERSARIAL_TEST' }));
    vi.stubGlobal('fetch', fetcher);
    await api.controlledAdversarialTest('operator-pin');
    expect(fetcher.mock.calls[0][0]).toBe('/api/security/controlled-adversarial-test');
    expect(fetcher.mock.calls[0][1].headers['X-Operator-Pin']).toBe('operator-pin');
  });
  it('sends uploaded-task authentication in the required JSON body, not an operator header', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(201, { taskId:'upload-task', grantVersion:'upload-v1', grantConfirmed:true, aliases:['quote-A','quote-B'], createdAt:'2026-10-24T00:00:00Z', preflightDecision:'ALLOW' }));
    vi.stubGlobal('fetch', fetcher);
    await api.bindUploadedTask({sessionId:'session',capability:'capability',expiresAt:'2026-10-24T01:00:00Z',maxDocuments:2},['doc-a','doc-b'],'configured-pin');
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/uploads/sessions/session/bind-task');
    expect(JSON.parse(String(init.body))).toEqual({documentIds:['doc-a','doc-b'],operatorPin:'configured-pin'});
    expect(init.headers).toMatchObject({'X-Upload-Capability':'capability'});
    expect(init.headers).not.toHaveProperty('X-Operator-Pin');
  });
  it('distinguishes policy denial from network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, { error:'Denied by policy' })));
    const denied = await api.tool({taskId:'demo',callId:'fresh-call',tool:'delete_quote',args:{fileId:'quote-A'}});
    expect(denied).toMatchObject({ok:false,kind:'security',error:'Denied by policy'});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await api.grant()).toMatchObject({ok:false,kind:'network',error:'offline'});
  });
  it('turns a non-JSON proxy 500 into a safe actionable backend message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy error</html>', { status:500, headers:{'Content-Type':'text/html'} })));
    await expect(api.createUploadSession()).resolves.toMatchObject({ok:false,status:500,kind:'backend',error:expect.stringContaining('proxy or backend')});
  });
});
