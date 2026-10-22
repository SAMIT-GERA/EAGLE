# AI foundation (developer-only)

Default model: gemini-3.5-flash-lite. GEMINI_MODEL explicitly overrides it.
Credentials are read only from GEMINI_API_KEY (or explicitly injected by server
configuration). This code does not load .env files automatically.

No model/provider fallback, billing changes, grounding, caching or external tools
are implemented. The bounded supervisor uses an injected bridge. Synthetic data
only. Project
quotas and billing remain controlled in Google AI Studio; they are not inferred
or hardcoded here. Free-tier use is not guaranteed by this adapter.

## Exports

- LLMClient.invoke(request): raw JSON text plus server-owned invocation metadata,
  or a categorized failure. Native requests use live_model; injected transports
  use scripted_gateway. No attempted request means runMode is null.
- createGeminiClient({apiKey?, model?, transport?})
- runPlanner(client, input, options?)
- runReviewer(client, input, options?)
- runRecovery(client, input, options?)

Role options: model, timeoutMs (default 12000, maximum 15000), signal and
maxOutputTokens (default 512, maximum 1024). Each invocation makes at most two
requests with a bounded overall deadline (maximum 30 seconds). Retry-After
longer than the remaining deadline stops the invocation instead of retrying early.
Malformed role output is not retried.

All outputs are untrusted proposals. A finish summary is not execution evidence.
Provider JSON Schema is a guide; local strict Zod validation is authoritative.
No authority-bearing IDs are accepted in model output. These IDs must be supplied
by the future server-owned workflow. Free-text fields are untrusted and must
never be parsed as commands or permission grants.

## Live smoke (explicit opt-in)

After setting GEMINI_API_KEY privately in the process environment and building:

    node dist/agents/smoke.js --live

Run only once when intentionally testing connectivity. This runs three separate
logical invocations (Planner, Reviewer, Recovery), each with at most two attempts:
at most six generateContent requests, never adapter calls. It does not start the
full workflow. Independent synthetic samples are used even if an earlier role
fails; a failed role is never replaced with a scripted answer.

Without --live, or with missing credentials, all roles report not_run and no API
calls occur. Ordinary npm.cmd test uses only injected transports/clients.
Printed smoke outputs are validated but untrusted model text; never treat them
as proof that TaskGate executed anything.

## API references

- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/pricing

## Bounded supervisor (AI Milestone 2)

runAgentWorkflow({llm, gateway}, input, options?) uses the existing role functions.
input is {goal, mode, context: {grant: TaskGrant}} supplied by trusted server code.
mode is mandatory: live_model or scripted_gateway. No model creates a grant,
task ID, call ID, approval ID or policy result. The model sees only the limited
grant summary, bounded untrusted excerpts and advisory feedback. The gateway
receives a defensive copy of the full trusted grant snapshot and must recheck
current server state; that snapshot is never an authorization decision.

Options extend the existing RoleOptions with limits:
{llmInvocations?: number, toolProposals?: number, revisions?: number}.
Defaults and hard maxima are 12 logical role calls, 6 proposals and 2 revisions.
Limits may be lowered only. A role call can still use the existing client's two
HTTP attempts. Every new model proposal consumes the proposal budget, including
proposals that Reviewer asks to revise. Revision budgets are shared by review
and recovery. Loops consume these budgets; there is no recursive replanning.

States:
planning -> reviewing -> dispatching -> planning on observed success.
reviewing -> planning for bounded revision, or awaiting_human for human advice.
dispatching -> recovering for block, pending, failure or unconfirmed outcome.
recovering -> planning only for a different read after a block, or a terminal
awaiting_human/stopped state. Planning may complete without dispatch.
Invalid transitions and repeated dispatched action payloads are rejected.
Purpose-only changes do not make a new action. A denied email stops even if
Recovery suggests changing its recipient. Failed or uncertain attempts stop
after Recovery; neither is automatically retried.

### Bridge contract for Samit's later integration

GatewayBridge is exported from gatewayBridge.ts:

- kind: taskgate | scripted_gateway
- dispatch(action: ProposedAction, context: TrustedGatewayContext,
  options: {signal?: AbortSignal}): Promise<GatewayObservation>
- TrustedGatewayContext: {grant: TaskGrant}

This milestone provides the interface and validation only, not a dispatcher
implementation. A real bridge must call Samit's existing gateway and supply
actual server-generated call IDs and receipt IDs. It must never directly invoke
an adapter, invent outcomes, or treat policy allow as execution success.

GatewayObservation is a strict internal discriminated union with:
taskId, callId, grantVersion, tool, decision, ruleId and optional receiptId.
Kinds:

- block: decision block, no execution.
- request_approval: decision request_approval, tool send_clarification_email,
  pending {email: CanonicalEmail, digest: string}.
- succeeded/failed: decision allow, mandatory durable terminal receiptId.
- uncertain: decision allow, no confirmed terminal outcome.
- not_executed: decision allow, but no execution established.

Only succeeded reads may include quote {fileId, documentText}; the text must be
a sanitized synthetic excerpt, at most 2000 characters, not raw adapter data.
Exact returned task/version/tool must match trusted context and the proposal.
Pending email canonical fields and digest are checked using canonical.ts.
The real bridge must verify receipt correlation and durable terminal status,
sanitize data, and honor cancellation; these cannot be proved by DTO parsing.
No public DispatchResponse or ExecutionStatus changes are made.

No resume API exists. Pending returns the original trusted call/version/payload/
digest internally. It never issues approval, redispatches, or creates a new ID.
The internal pending object contains the full canonical synthetic email body:
future HTTP code must authenticate and redact it rather than serialize blindly.
Human-review advice has a separate humanReviewProposal without fabricated
gateway identity or approval evidence.

### Results and traces

WorkflowResult returns runId, terminal status/reason, mode, gatewayKind, bounded
counts, observations, trace and outcomeUncertain. Pending/review data is optional.
A completed workflow means Planner finished; completion.summary is explicitly
untrusted_planner text, not evidence that mail was sent or every action succeeded.
Use actual gateway observations and the existing claim verifier for execution
claims. No comparison engine or structured claim integration is added here.

AgentTraceEvent preserves the master fields and adds source and optional
invocation metadata (plus decision/ruleId on gateway observations).
Events contain fixed summaries and actual correlated IDs, not prompts, raw
provider exceptions, email bodies or quotation bodies. Invocation metadata
retains provider, model/version when supplied, prompt version, attempts, timings,
token usage when supplied and server invocation ID. reportedHttpAttempts totals
returned metadata, including scripted attempts; it is null if metadata is absent
or invalid. llmInvocations counts logical role-function calls, not HTTP requests.
Zero-request configuration failures have a model_not_sent event with null
invocation.runMode and zero attempts; no provider request is invented.

Supervisor lifecycle events use the requested run mode. Model events use their
actual returned mode; mismatches stop the workflow. Scripted gateway events stay
scripted_gateway even if model requests are live. Check source, gatewayKind and
invocation metadata together: a live model plus a fake bridge is not live tool
execution. Injected clients/bridges are trusted composition dependencies; this
module cannot independently attest to a dishonest dependency's provenance.

State, traces and replay guards are per run and in memory only. Durable/replay
protection across runs, current grants/policy and approval enforcement remain
the real gateway's responsibility. No run persistence, HTTP route, approval
resume, fixture retrieval, billing change or live test is started by this module.
Ordinary tests use deterministic clients and bridges with native fetch forbidden.
