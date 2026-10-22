import type { ZodType } from 'zod';
import { readQuoteArgsSchema, sendClarificationEmailArgsSchema } from '../contracts/schemas.js';
import type { ReadQuoteArgs, SendClarificationEmailArgs } from '../contracts/schemas.js';
import type { ToolName } from '../contracts/types.js';

export type CapabilityToolName = Exclude<ToolName, 'delete_quote'>;
export type OperationClass = 'read' | 'external_send';
export type ResourceRestriction = 'grant_approved_file_ids' | 'none';
export type RecipientRestriction = 'grant_eligible_recipients' | 'none';

/**
 * A typed reference to a trusted adapter. It intentionally contains no
 * executable handler; future gateway code resolves this identifier only after
 * validation, policy, approval, and audit-preflight checks succeed.
 */
export type AdapterReference<TArgs, TResult = unknown> = {
  readonly adapterId: string;
  readonly inputSchema: ZodType<TArgs>;
  readonly resultKind: string;
  readonly _result?: TResult;
};

export type RedactionPolicy = {
  readonly sensitiveArgumentFields: readonly string[];
  readonly sensitiveResultFields: readonly string[];
};

export type CapabilityDefinition<TArgs = unknown, TResult = unknown> = {
  readonly tool: CapabilityToolName;
  readonly operationClass: OperationClass;
  readonly sideEffecting: boolean;
  readonly requiresApproval: boolean;
  readonly resourceRestriction: ResourceRestriction;
  readonly recipientRestriction: RecipientRestriction;
  readonly argsSchema: ZodType<TArgs>;
  readonly adapter: AdapterReference<TArgs, TResult>;
  readonly redaction: RedactionPolicy;
};

export type TaskProfileCapabilityConfig = {
  readonly profileId: string;
  readonly manifestId: string;
  readonly tools: readonly CapabilityToolName[];
};

export type TaskProfileCapabilityBinding = {
  readonly profileId: string;
  readonly manifestId: string;
  readonly capabilities: readonly CapabilityDefinition[];
};

export class DuplicateCapabilityError extends Error {
  constructor(tool: string) {
    super(`Capability ${tool} is already registered.`);
    this.name = 'DuplicateCapabilityError';
  }
}

export class UnknownCapabilityError extends Error {
  constructor(tool: string) {
    super(`Capability ${tool} is not registered.`);
    this.name = 'UnknownCapabilityError';
  }
}

export class InvalidCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCapabilityError';
  }
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeDefinition<TArgs, TResult>(definition: CapabilityDefinition<TArgs, TResult>): CapabilityDefinition<TArgs, TResult> {
  return Object.freeze({
    tool: definition.tool,
    operationClass: definition.operationClass,
    sideEffecting: definition.sideEffecting,
    requiresApproval: definition.requiresApproval,
    resourceRestriction: definition.resourceRestriction,
    recipientRestriction: definition.recipientRestriction,
    argsSchema: definition.argsSchema,
    adapter: Object.freeze({
      adapterId: definition.adapter.adapterId,
      inputSchema: definition.adapter.inputSchema,
      resultKind: definition.adapter.resultKind
    }),
    redaction: Object.freeze({
      sensitiveArgumentFields: freezeStrings(definition.redaction.sensitiveArgumentFields),
      sensitiveResultFields: freezeStrings(definition.redaction.sensitiveResultFields)
    })
  });
}

function assertDefinition(definition: CapabilityDefinition): void {
  if (definition.tool !== 'read_quote' && definition.tool !== 'send_clarification_email') {
    throw new InvalidCapabilityError('Only frozen model-facing tools may be registered.');
  }
  if (definition.operationClass === 'read' && definition.sideEffecting) {
    throw new InvalidCapabilityError('Read capabilities cannot be side-effecting.');
  }
  if (definition.operationClass === 'external_send' && (!definition.sideEffecting || !definition.requiresApproval)) {
    throw new InvalidCapabilityError('External-send capabilities must be side-effecting and approval-required.');
  }
  if (definition.adapter.adapterId.trim().length === 0) {
    throw new InvalidCapabilityError('Capabilities require a trusted adapter identifier.');
  }
}

/**
 * Server-owned metadata registry. Presence in this registry is never an
 * authorization decision and this class never invokes an adapter.
 */
export class CapabilityRegistry {
  private readonly capabilities = new Map<CapabilityToolName, CapabilityDefinition>();

  register<TArgs, TResult>(definition: CapabilityDefinition<TArgs, TResult>): CapabilityDefinition<TArgs, TResult> {
    assertDefinition(definition);
    if (this.capabilities.has(definition.tool)) {
      throw new DuplicateCapabilityError(definition.tool);
    }
    const frozen = freezeDefinition(definition);
    this.capabilities.set(frozen.tool, frozen as CapabilityDefinition);
    return frozen;
  }

  get(tool: string): CapabilityDefinition {
    const capability = this.capabilities.get(tool as CapabilityToolName);
    if (capability === undefined) {
      throw new UnknownCapabilityError(tool);
    }
    return capability;
  }

  has(tool: string): tool is CapabilityToolName {
    return this.capabilities.has(tool as CapabilityToolName);
  }

  list(): readonly CapabilityDefinition[] {
    return Object.freeze([...this.capabilities.values()]);
  }
}

export function bindTaskProfileCapabilities(registry: CapabilityRegistry, config: TaskProfileCapabilityConfig): TaskProfileCapabilityBinding {
  if (config.profileId.trim().length === 0 || config.manifestId.trim().length === 0) {
    throw new InvalidCapabilityError('Task-profile identifiers must be non-empty.');
  }
  if (new Set(config.tools).size !== config.tools.length) {
    throw new InvalidCapabilityError('Task profiles cannot list a capability more than once.');
  }

  return Object.freeze({
    profileId: config.profileId,
    manifestId: config.manifestId,
    capabilities: Object.freeze(config.tools.map((tool) => registry.get(tool)))
  });
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register<ReadQuoteArgs, unknown>({
    tool: 'read_quote',
    operationClass: 'read',
    sideEffecting: false,
    requiresApproval: false,
    resourceRestriction: 'grant_approved_file_ids',
    recipientRestriction: 'none',
    argsSchema: readQuoteArgsSchema,
    adapter: {
      adapterId: 'quote-reader',
      inputSchema: readQuoteArgsSchema,
      resultKind: 'quote_document'
    },
    redaction: {
      sensitiveArgumentFields: [],
      sensitiveResultFields: ['documentText']
    }
  });
  registry.register<SendClarificationEmailArgs, unknown>({
    tool: 'send_clarification_email',
    operationClass: 'external_send',
    sideEffecting: true,
    requiresApproval: true,
    resourceRestriction: 'none',
    recipientRestriction: 'grant_eligible_recipients',
    argsSchema: sendClarificationEmailArgsSchema,
    adapter: {
      adapterId: 'mock-mail',
      inputSchema: sendClarificationEmailArgsSchema,
      resultKind: 'mail_dispatch'
    },
    redaction: {
      sensitiveArgumentFields: ['subject', 'body'],
      sensitiveResultFields: []
    }
  });
  return registry;
}
