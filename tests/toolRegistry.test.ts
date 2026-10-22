import { describe, expect, it } from 'vitest';
import { readQuoteArgsSchema } from '../src/contracts/schemas.js';
import {
  bindTaskProfileCapabilities,
  CapabilityRegistry,
  createDefaultCapabilityRegistry,
  DuplicateCapabilityError,
  InvalidCapabilityError,
  UnknownCapabilityError
} from '../src/gateway/toolRegistry.js';

describe('CapabilityRegistry', () => {
  it('registers immutable server-owned capability metadata without executing anything', () => {
    let adapterExecutions = 0;
    const registry = new CapabilityRegistry();
    const definition = registry.register({
      tool: 'read_quote',
      operationClass: 'read',
      sideEffecting: false,
      requiresApproval: false,
      resourceRestriction: 'grant_approved_file_ids',
      recipientRestriction: 'none',
      argsSchema: readQuoteArgsSchema,
      adapter: { adapterId: 'test-reader', inputSchema: readQuoteArgsSchema, resultKind: 'quote_document' },
      redaction: { sensitiveArgumentFields: [], sensitiveResultFields: [] }
    });

    expect(definition.adapter.adapterId).toBe('test-reader');
    expect(adapterExecutions).toBe(0);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.redaction)).toBe(true);
    expect(Object.isFrozen(definition.redaction.sensitiveArgumentFields)).toBe(true);
    expect(Reflect.set(definition, 'sideEffecting', true)).toBe(false);
    expect(definition.sideEffecting).toBe(false);
  });

  it('rejects duplicate registrations and unknown lookups', () => {
    const registry = createDefaultCapabilityRegistry();
    expect(() => registry.register({
      tool: 'read_quote', operationClass: 'read', sideEffecting: false, requiresApproval: false,
      resourceRestriction: 'grant_approved_file_ids', recipientRestriction: 'none', argsSchema: readQuoteArgsSchema,
      adapter: { adapterId: 'other-reader', inputSchema: readQuoteArgsSchema, resultKind: 'quote_document' },
      redaction: { sensitiveArgumentFields: [], sensitiveResultFields: [] }
    })).toThrow(DuplicateCapabilityError);
    expect(() => registry.get('delete_quote')).toThrow(UnknownCapabilityError);
    expect(() => registry.get('shell')).toThrow(UnknownCapabilityError);
  });

  it('publishes only the frozen initial tool definitions with correct metadata', () => {
    const registry = createDefaultCapabilityRegistry();
    const read = registry.get('read_quote');
    const email = registry.get('send_clarification_email');

    expect(registry.list().map((capability) => capability.tool)).toEqual(['read_quote', 'send_clarification_email']);
    expect(read).toMatchObject({ operationClass: 'read', sideEffecting: false, requiresApproval: false, resourceRestriction: 'grant_approved_file_ids' });
    expect(email).toMatchObject({ operationClass: 'external_send', sideEffecting: true, requiresApproval: true, recipientRestriction: 'grant_eligible_recipients' });
    expect(registry.has('delete_quote')).toBe(false);
  });

  it('does not permit delete_quote or unsafe capability metadata', () => {
    const registry = new CapabilityRegistry();
    const deleteDefinition = {
      tool: 'delete_quote',
      operationClass: 'read', sideEffecting: false, requiresApproval: false,
      resourceRestriction: 'none', recipientRestriction: 'none', argsSchema: readQuoteArgsSchema,
      adapter: { adapterId: 'delete', inputSchema: readQuoteArgsSchema, resultKind: 'none' },
      redaction: { sensitiveArgumentFields: [], sensitiveResultFields: [] }
    };
    expect(() => {
      // @ts-expect-error Runtime validation also protects JavaScript callers.
      registry.register(deleteDefinition);
    }).toThrow(InvalidCapabilityError);
    expect(() => registry.register({
      tool: 'send_clarification_email', operationClass: 'external_send', sideEffecting: false, requiresApproval: false,
      resourceRestriction: 'none', recipientRestriction: 'grant_eligible_recipients', argsSchema: readQuoteArgsSchema,
      adapter: { adapterId: 'unsafe-mail', inputSchema: readQuoteArgsSchema, resultKind: 'none' },
      redaction: { sensitiveArgumentFields: [], sensitiveResultFields: [] }
    })).toThrow(InvalidCapabilityError);
  });

  it('reuses one registry for distinct server-owned task-profile bindings', () => {
    const registry = createDefaultCapabilityRegistry();
    const procurement = bindTaskProfileCapabilities(registry, {
      profileId: 'procurement', manifestId: 'procurement-quotes-v1', tools: ['read_quote', 'send_clarification_email']
    });
    const vendorOnboarding = bindTaskProfileCapabilities(registry, {
      profileId: 'vendor-onboarding', manifestId: 'vendor-documents-v1', tools: ['read_quote']
    });

    expect(procurement.capabilities).toHaveLength(2);
    expect(vendorOnboarding.capabilities).toHaveLength(1);
    expect(procurement.capabilities[0]).toBe(vendorOnboarding.capabilities[0]);
    expect(Object.isFrozen(procurement.capabilities)).toBe(true);
  });

  it('rejects invalid or duplicate task-profile capability lists', () => {
    const registry = createDefaultCapabilityRegistry();
    expect(() => bindTaskProfileCapabilities(registry, {
      profileId: '', manifestId: 'manifest', tools: ['read_quote']
    })).toThrow(InvalidCapabilityError);
    expect(() => bindTaskProfileCapabilities(registry, {
      profileId: 'profile', manifestId: 'manifest', tools: ['read_quote', 'read_quote']
    })).toThrow(InvalidCapabilityError);
  });
});
