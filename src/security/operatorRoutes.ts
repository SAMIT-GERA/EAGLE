import { createHash, timingSafeEqual } from 'node:crypto';
import { json, Router } from 'express';
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  approvalIdSchema, callIdSchema, completionClaimSchema,
  sendClarificationEmailArgsSchema, taskGrantSchema, taskIdSchema
} from '../contracts/schemas.js';
import type { SecurityDependencies, TaskGrant } from '../contracts/types.js';
import type { createClaimVerifier } from '../audit/claimVerifier.js';

type ApprovalService = SecurityDependencies['approvalService'];
type PendingAction = Awaited<ReturnType<ApprovalService['listPending']>>[number];

export interface SecurityRouteDependencies {
  approvalService: Pick<ApprovalService, 'listPending' | 'approvePending'>;
  audit: Pick<SecurityDependencies['audit'], 'listReceipts'>;
  claimVerifier: Pick<ReturnType<typeof createClaimVerifier>, 'verifyClaim'>;
  confirmDemoGrant(operatorPin: string): TaskGrant | Promise<TaskGrant>;
  setMockMailMode(mode: 'succeed' | 'fail'): void | Promise<void>;
  /** Defaults to reading OPERATOR_PIN per request; never captured in module state. */
  getOperatorPin?: () => string | undefined;
  /** Trusted server-side grant/policy lookup only, never an adapter invocation.
   * Missing callback disables approval issuance. Gateway must recheck at dispatch.
   */
  checkApprovalEligibility?: (pending: Readonly<PendingAction>) => boolean | Promise<boolean>;
  /** Master H specifies trusted UI access but no authentication protocol here.
   * Samit must supply the agreed UI/session boundary; absence disables the route.
   */
  authorizeClaimRequest?: (request: Request) => boolean | Promise<boolean>;
}

const pin = z.string().min(1);
const noQuery = z.object({}).strict();
const confirmBody = z.object({ operatorPin: pin }).strict();
const approveBody = z.object({
  taskId: taskIdSchema, callId: callIdSchema, operatorPin: pin
}).strict();
const modeBody = z.object({
  mode: z.enum(['succeed', 'fail']), operatorPin: pin
}).strict();
const pendingSchema = z.object({
  taskId: taskIdSchema, callId: callIdSchema, ...sendClarificationEmailArgsSchema.shape
}).strict();
const credentialSchema = z.object({
  approvalId: approvalIdSchema, expiresAt: z.string().datetime()
}).strict();
const claimCheckSchema = z.object({
  claimId: completionClaimSchema.shape.claimId,
  verdict: z.enum(['supported', 'contradiction', 'missing_evidence']),
  matchingReceiptIds: z.array(z.string().uuid()), explanation: z.string()
}).strict();
// Explicit output allowlist: do not serialize internal event objects or credentials.
const receiptViewSchema = z.object({
  receiptId: z.string().uuid(), taskId: taskIdSchema, callId: callIdSchema,
  tool: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  argsDigest: completionClaimSchema.shape.bodyDigest,
  grantVersion: taskGrantSchema.shape.version,
  policyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  decision: z.enum(['allow', 'block', 'request_approval']),
  ruleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  executionStatus: z.enum(['succeeded', 'failed', 'not_executed']),
  timestamp: z.string().datetime()
});

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function parseRequest<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpFailure(400, 'Invalid request');
  return parsed.data;
}

const registeredApps = new WeakSet<Express>();

/** Mount on Samit's existing app. No listeners, services, policy engines or
 * model tools are created here. Samit must keep request logging PIN-free and
 * sanitize any JSON-parser errors from middleware mounted BEFORE this router.
 */
export function registerSecurityRoutes(app: Express, deps: SecurityRouteDependencies): void {
  if (registeredApps.has(app)) throw new Error('Security routes are already registered');
  const router = Router();
  const parseJson = json({ limit: '16kb', strict: true });

  function authenticate(provided: unknown): void {
    const expected = (deps.getOperatorPin ?? (() => process.env.OPERATOR_PIN))();
    if (typeof expected !== 'string' || expected.trim().length === 0) {
      throw new HttpFailure(503, 'Operator authentication is not configured');
    }
    if (typeof provided !== 'string' || !timingSafeEqual(
      createHash('sha256').update(provided, 'utf8').digest(),
      createHash('sha256').update(expected, 'utf8').digest()
    )) {
      throw new HttpFailure(401, 'Operator authentication required');
    }
  }

  function endpoint(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
    return (request, response, next) => {
      void handler(request, response).catch((error: unknown) => {
        if (response.headersSent) { next(error); return; }
        if (error instanceof HttpFailure) {
          response.status(error.status).json({ error: error.message });
        } else {
          response.status(500).json({ error: 'Security service failed' });
        }
      });
    };
  }

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    next();
  });

  router.post('/grant/confirm', parseJson, endpoint(async (request, response) => {
    authenticate(request.body?.operatorPin);
    parseRequest(noQuery, request.query);
    const body = parseRequest(confirmBody, request.body);
    // This is the sole intentional PIN handoff: the frozen trusted grant function.
    const grant = taskGrantSchema.parse(await deps.confirmDemoGrant(body.operatorPin));
    response.json({ grant });
  }));

  router.get('/receipts', endpoint(async (request, response) => {
    authenticate(request.get('X-Operator-Pin'));
    const query = parseRequest(z.object({ taskId: taskIdSchema.optional() }).strict(), request.query);
    const receipts = await deps.audit.listReceipts(query.taskId);
    const views = receipts.map((receipt) => {
      const view = receiptViewSchema.parse(receipt);
      return {
        ...view,
        adapterOutcome: view.executionStatus === 'not_executed' ? 'not_invoked' :
          view.executionStatus === 'succeeded' ? 'adapter_succeeded' : 'adapter_failed'
      };
    });
    response.json(views);
  }));

  router.get('/pending-approvals', endpoint(async (request, response) => {
    authenticate(request.get('X-Operator-Pin'));
    parseRequest(noQuery, request.query);
    const pending = z.array(pendingSchema).parse(await deps.approvalService.listPending());
    // Keep the existing row keys, but expose no message text or recipient details.
    response.json(pending.map(({ taskId, callId }) => ({
      taskId, callId, recipient: '[redacted]', subject: '[redacted]', body: '[redacted]'
    })));
  }));

  router.post('/approve', parseJson, endpoint(async (request, response) => {
    authenticate(request.body?.operatorPin);
    parseRequest(noQuery, request.query);
    const body = parseRequest(approveBody, request.body);
    if (!deps.checkApprovalEligibility) {
      throw new HttpFailure(503, 'Trusted approval eligibility check is not configured');
    }
    const pending = z.array(pendingSchema).parse(await deps.approvalService.listPending());
    const matches = pending.filter((item) => item.taskId === body.taskId && item.callId === body.callId);
    if (matches.length === 0) throw new HttpFailure(404, 'Pending action not found');
    if (matches.length !== 1) throw new HttpFailure(500, 'Pending action state is inconsistent');
    if (await deps.checkApprovalEligibility(Object.freeze({ ...matches[0] })) !== true) {
      throw new HttpFailure(403, 'Pending action is not eligible for approval');
    }
    const credential = credentialSchema.parse(await deps.approvalService.approvePending({
      taskId: body.taskId, callId: body.callId, approvedBy: 'local_operator'
    }));
    response.json(credential);
  }));

  router.post('/mock-mail-mode', parseJson, endpoint(async (request, response) => {
    authenticate(request.body?.operatorPin);
    parseRequest(noQuery, request.query);
    const body = parseRequest(modeBody, request.body);
    await deps.setMockMailMode(body.mode);
    // Master H freezes the request but specifies no response DTO.
    response.status(204).end();
  }));

  router.post('/claims/verify', parseJson, endpoint(async (request, response) => {
    if (!deps.authorizeClaimRequest) {
      throw new HttpFailure(503, 'Trusted claim access check is not configured');
    }
    if (await deps.authorizeClaimRequest(request) !== true) {
      throw new HttpFailure(403, 'Trusted UI access required');
    }
    parseRequest(noQuery, request.query);
    const claim = parseRequest(completionClaimSchema, request.body);
    const result = claimCheckSchema.parse(await deps.claimVerifier.verifyClaim(claim));
    if (result.claimId !== claim.claimId) throw new Error('Claim result mismatch');
    response.json(result);
  }));

  const parserError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const tooLarge = typeof error === 'object' && error !== null &&
      'type' in error && error.type === 'entity.too.large';
    response.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Request body too large' : 'Invalid JSON request' });
  };
  router.use(parserError);
  app.use('/api', router);
  registeredApps.add(app);
}

/** No safe reset API exists in the current services. Fail explicitly without
 * deleting audit files, reopening consumed calls or touching Samit's grants.
 */
export async function resetSecurityState(): Promise<void> {
  throw new Error('Safe coordinated security reset is unavailable; operator integration is required');
}
