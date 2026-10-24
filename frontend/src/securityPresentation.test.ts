import { describe, expect, it } from 'vitest';
import { canEnterAgentExecution, displayDocumentName, preflightMessage, preflightTone } from './securityPresentation';

const allowedTask = { taskId:'upload-task', grantVersion:'upload-v1', grantConfirmed:true, aliases:['quote-A','quote-B'], createdAt:'2026-10-24T00:00:00Z', preflightDecision:'ALLOW' as const };

describe('security journey presentation', () => {
  it('does not make review or block decisions look like clearance', () => {
    expect(preflightTone('ALLOW')).toBe('allow');
    expect(preflightTone('REVIEW')).toBe('review');
    expect(preflightTone('BLOCK')).toBe('block');
    expect(preflightMessage('BLOCK')).toContain('cannot override');
    expect(preflightMessage('REVIEW')).toContain('remains stopped');
  });

  it('permits entry only for a confirmed sample or server-allowed uploaded task', () => {
    expect(canEnterAgentExecution('sample',true)).toBe(true);
    expect(canEnterAgentExecution('sample',false)).toBe(false);
    expect(canEnterAgentExecution('upload',false,allowedTask)).toBe(true);
    expect(canEnterAgentExecution('upload',false,{...allowedTask,preflightDecision:'REVIEW'})).toBe(false);
    expect(canEnterAgentExecution('upload',false,{...allowedTask,grantConfirmed:false})).toBe(false);
  });

  it('uses supplier business names before opaque protocol identifiers', () => {
    expect(displayDocumentName(0,'ORBIT TEST SUPPLIER','workstations')).toBe('ORBIT TEST SUPPLIER — workstations');
    expect(displayDocumentName(1)).toBe('Document 2');
  });
});
