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
  it('distinguishes policy denial from network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, { error:'Denied by policy' })));
    const denied = await api.tool({taskId:'demo',callId:'fresh-call',tool:'delete_quote',args:{fileId:'quote-A'}});
    expect(denied).toMatchObject({ok:false,kind:'security',error:'Denied by policy'});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await api.grant()).toMatchObject({ok:false,kind:'network',error:'offline'});
  });
});
