import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { json } from 'express';
import type { Express, Request } from 'express';
import { z } from 'zod';
import { createClaimVerifier } from './audit/claimVerifier.js';
import { createReceiptStore } from './audit/receiptStore.js';
import { ControlledAdapterWiring } from './adapters/wiring.js';
import { MockMailAdapter, type MockMailMode } from './adapters/mockMail.js';
import { createDefaultQuoteReader } from './adapters/quoteReader.js';
import { taskGrantSchema } from './contracts/schemas.js';
import type { SecurityDependencies, TaskGrant, ToolCall } from './contracts/types.js';
import {
  DuplicateGatewayCallError,
  GatewayBlockedError,
  GatewayPreflightError,
  GatewayUncertainOutcomeError,
  GatewayDispatcher
} from './gateway/dispatch.js';
import { InMemoryGrantStore } from './gateway/grants.js';
import { PendingApprovalMetadataStore } from './gateway/pendingApprovalMetadata.js';
import { evaluateStoredToolCall } from './gateway/policy.js';
import { createDefaultCapabilityRegistry } from './gateway/toolRegistry.js';
import { createApprovalService } from './security/approvalService.js';
import { canonicalizeEmail, hashEmailAction } from './security/canonical.js';
import { registerSecurityRoutes } from './security/operatorRoutes.js';
import { createGeminiClient } from './agents/geminiClient.js';
import type { LLMClient } from './agents/llmClient.js';
import { AgentWorkflowCoordinator } from './workflows/agentWorkflow.js';

type ReceiptStore = Awaited<ReturnType<typeof createReceiptStore>>;

export type TaskGateServerOptions = {
  grantTemplate: TaskGrant;
  auditPath?: string;
  operatorPin?: string;
  policyVersion?: string;
  /** Demo-only trusted UI boundary. Defaults to the local operator PIN header. */
  authorizeClaimRequest?: (request: Request) => boolean | Promise<boolean>;
  llmClient?: LLMClient;
};

export type ComposedTaskGateServer = {
  app: Express;
  grantStore: InMemoryGrantStore;
  dispatcher: GatewayDispatcher;
  approvalService: SecurityDependencies['approvalService'];
  auditStore: ReceiptStore;
  pendingApprovalMetadata: PendingApprovalMetadataStore;
  adapters: ControlledAdapterWiring;
  workflows: AgentWorkflowCoordinator;
  close(): Promise<void>;
};

const toolCallEnvelopeSchema = z.object({
  taskId: z.string(), callId: z.string(), tool: z.string(), args: z.unknown(), approvalId: z.string().optional()
}).strict();

function sameSecret(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.trim().length === 0) return false;
  const left = createHash('sha256').update(provided, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

function redactedGrant(grant: TaskGrant) {
  return {
    taskId: grant.taskId,
    version: grant.version,
    confirmed: grant.confirmed,
    approvedFileIds: [...grant.approvedFileIds],
    permittedTools: [...grant.permittedTools],
    prohibitedOperations: [...grant.prohibitedOperations],
    approvalEligibleTools: [...grant.approvalEligibleTools]
  };
}

/**
 * Builds one local-process TaskGate backend. The PIN gates operator endpoints
 * for a demo only; it is not enterprise authentication. The audit store is
 * durable, while grants, approvals, adapter state, and pending metadata are
 * intentionally process-local.
 */
export async function createTaskGateServer(options: TaskGateServerOptions): Promise<ComposedTaskGateServer> {
  const grantTemplate = taskGrantSchema.parse(options.grantTemplate);
  const operatorPin = options.operatorPin ?? process.env.OPERATOR_PIN;
  const grantStore = new InMemoryGrantStore();
  const capabilityRegistry = createDefaultCapabilityRegistry();
  const mockMail = new MockMailAdapter();
  const adapters = new ControlledAdapterWiring(await createDefaultQuoteReader(), mockMail);
  const approvalService = createApprovalService();
  const auditStore = await createReceiptStore({
    ...(options.auditPath === undefined ? {} : { path: options.auditPath }),
    policyVersion: options.policyVersion ?? 'taskgate-v2-policy-1'
  });
  const pendingApprovalMetadata = new PendingApprovalMetadataStore();
  const dependencies: SecurityDependencies = {
    canonicalizeEmail,
    hashEmailAction,
    approvalService,
    audit: auditStore.audit
  };
  const dispatcher = new GatewayDispatcher(dependencies, {
    grantStore,
    capabilityRegistry,
    adapters,
    pendingApprovalMetadata
  });
  const claimVerifier = createClaimVerifier({
    audit: auditStore.audit,
    findEmailEvidence: auditStore.findEmailEvidence,
    listUnresolvedDispatches: auditStore.listUnresolvedDispatches
  });
  const workflows = new AgentWorkflowCoordinator({ client: options.llmClient ?? createGeminiClient(), gateway: dispatcher, grantStore, claimVerifier, taskId: grantTemplate.taskId });
  const app = express();

  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), {
    index: 'index.html',
    redirect: false
  }));

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', version: 'taskgate-v2' });
  });

  app.get('/api/grant', (_request, response) => {
    const grant = grantStore.resolve(grantTemplate.taskId).record?.grant;
    if (grant === undefined) {
      response.status(404).json({ error: 'No confirmed grant is active.' });
      return;
    }
    response.json({ grant: redactedGrant(grant) });
  });

  app.post('/api/tool-call', json({ limit: '16kb', strict: true }), async (request, response) => {
    const parsed = toolCallEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid tool call' });
      return;
    }
    const call: ToolCall = {
      taskId: parsed.data.taskId,
      callId: parsed.data.callId,
      tool: parsed.data.tool,
      args: parsed.data.args,
      ...(parsed.data.approvalId === undefined ? {} : { approvalId: parsed.data.approvalId })
    };
    try {
      const result = await dispatcher.dispatchToolCall(call);
      response.json(result);
    } catch (error) {
      if (error instanceof GatewayBlockedError) {
        response.status(403).json({ decision: error.decision });
      } else if (error instanceof GatewayPreflightError) {
        response.status(503).json({ error: 'Audit preflight failed; no adapter was invoked.' });
      } else if (error instanceof GatewayUncertainOutcomeError) {
        response.status(503).json({ error: 'Execution outcome is uncertain; do not resend automatically.' });
      } else if (error instanceof DuplicateGatewayCallError) {
        response.status(409).json({ error: 'Tool call is already in progress, completed, or uncertain.' });
      } else {
        response.status(500).json({ error: 'Gateway dispatch failed' });
      }
    }
  });

  const workflowGoalSchema = z.object({ goal: z.string().trim().min(1).max(1_000) }).strict();
  const workflowResumeSchema = z.object({ approvalId: z.string().trim().min(1).max(128) }).strict();
  app.post('/api/agent/run', json({ limit: '16kb', strict: true }), async (request, response) => {
    const input = workflowGoalSchema.safeParse(request.body);
    if (!input.success) { response.status(400).json({ error: 'Invalid workflow request' }); return; }
    try { response.status(202).json(await workflows.start(input.data.goal)); }
    catch { response.status(409).json({ error: 'Workflow could not start' }); }
  });
  app.get('/api/runs/:runId', (request, response) => {
    const run = workflows.get(request.params.runId);
    if (run === undefined) { response.status(404).json({ error: 'Workflow run not found' }); return; }
    response.json(run);
  });
  app.post('/api/runs/:runId/resume', json({ limit: '16kb', strict: true }), async (request, response) => {
    if (!sameSecret(request.get('X-Operator-Pin'), operatorPin)) { response.status(401).json({ error: 'Operator authentication required' }); return; }
    const input = workflowResumeSchema.safeParse(request.body);
    if (!input.success) { response.status(400).json({ error: 'Invalid resume request' }); return; }
    try { response.json(await workflows.resume(request.params.runId, input.data.approvalId)); }
    catch { response.status(409).json({ error: 'Workflow could not resume' }); }
  });

  registerSecurityRoutes(app, {
    approvalService,
    audit: auditStore.audit,
    claimVerifier,
    getOperatorPin: () => operatorPin,
    confirmDemoGrant: () => {
      const existing = grantStore.resolve(grantTemplate.taskId).record?.grant;
      if (existing !== undefined && existing.confirmed) return existing;
      return grantStore.create({ ...grantTemplate, confirmed: true }).grant;
    },
    setMockMailMode: (mode: MockMailMode) => mockMail.setMode(mode),
    checkApprovalEligibility: (pending) => {
      const metadata = pendingApprovalMetadata.get(pending.taskId, pending.callId);
      if (metadata === undefined || metadata.state !== 'pending' ||
        metadata.email.recipient !== pending.recipient || metadata.email.subject !== pending.subject || metadata.email.body !== pending.body) {
        return false;
      }
      const resolution = grantStore.resolve(pending.taskId, metadata.grantVersion);
      const grant = resolution.record?.grant;
      if (resolution.status !== 'active' || grant === undefined || grant.version !== metadata.grantVersion) return false;
      try {
        const canonical = canonicalizeEmail({
          taskId: pending.taskId,
          callId: pending.callId,
          tool: 'send_clarification_email',
          args: { recipient: pending.recipient, subject: pending.subject, body: pending.body }
        }, grant);
        if (hashEmailAction(canonical) !== metadata.digest ||
          canonical.recipient !== metadata.email.recipient || canonical.subject !== metadata.email.subject || canonical.body !== metadata.email.body ||
          !pendingApprovalMetadata.matchesPending(canonical, metadata.digest)) return false;
        return evaluateStoredToolCall({
          taskId: pending.taskId,
          callId: pending.callId,
          tool: 'send_clarification_email',
          args: { recipient: pending.recipient, subject: pending.subject, body: pending.body }
        }, grantStore, metadata.grantVersion).decision === 'request_approval';
      } catch {
        return false;
      }
    },
    authorizeClaimRequest: options.authorizeClaimRequest ?? ((request) => sameSecret(request.get('X-Operator-Pin'), operatorPin))
  });

  return {
    app,
    grantStore,
    dispatcher,
    approvalService,
    auditStore,
    pendingApprovalMetadata,
    adapters,
    workflows,
    close: () => auditStore.close()
  };
}
