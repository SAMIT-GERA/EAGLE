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
claims. Deterministic quotation comparison is described below; structured claim
integration remains outside the agent workflow.

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

## Source-aware quotation handling (AI Milestone 3)

No gateway, adapter or fixture directory exists in this checkout at the inspected
baseline. The following is an isolated agent-side integration format, NOT a claim
about Samit's final manifest/adapter schema. No agent code reads files or fetches
quotations. Only successful, authorized read_quote observations delivered through
the injected TaskGate bridge may become comparison evidence.

### Internal bridge addition

A succeeded GatewayObservation may carry:
quotation: {format: 'procurement-v1', data: ProcurementQuoteData, source?: SuppliedSource}

data is strict:
- fileId: quote-A | quote-B, matching the requested and approved file ID.
- supplier (1..120 chars), item (1..160 chars).
- quantity: integer 1..1,000,000; quantityUnit: each | kg, explicitly required.
- unitPrice: a finite nonnegative number or plain decimal string, at most two
  decimal places, maximum 1,000,000,000 major currency units.
- currency: INR | USD | EUR | GBP; these supported currencies use two decimal places.
- leadTimeDays: integer 0..3650. This field explicitly fixes the unit as days.
- paymentTerms: original source string, 1..500 chars, without interpretation.
- optional documentText: original untrusted string, at most 8000 chars.

No missing price, quantity, unit or lead time is filled in. Totals, extra fields,
other currencies, unsupported units and excessive precision are rejected.
Numbers such as 0.1 + 0.2 are rejected rather than silently rounding them.
The format currently supports whole quantities only, including whole kilograms.
The old quote {fileId, documentText} remains accepted as an excerpt, but supplies
no structured numeric evidence and therefore cannot produce a comparison.
Sending both legacy quote and structured quotation is rejected as ambiguous.

Exports:
- mapProcurementQuoteData(value) validates/maps this format to ValidatedQuote.
  This is the format-mapping boundary to adapt after Samit's real fixture review.
- consumeReadQuoteResult({action, context, observation, gatewayKind, mode})
  revalidates gateway correlation and only accepts allow + succeeded read_quote
  with an actual receipt ID. It returns accepted, insufficient_evidence or rejected.
- compareQuotations(observedQuotes), quotationTotalMinor(), formatMinorUnits().
- serializeQuotationSource(), hashQuotationSource(), toAgentQuotationContext().

### Source evidence and digest definition

SourceEvidenceRef retains the master shape:
{sourceId, sha256, trustLabel: 'untrusted_document'}.

Source evidence separately records status verified | unverified | unavailable,
digest basis, computed digest and actual supplied source ID/digest when present.
No file ID is silently promoted into a source ID. An absent source ID is never
invented, even if a content digest can be computed. An excerpt-only/missing data
result is unavailable; complete received data without enough anchoring metadata
is unverified. Numeric comparisons may still use those genuine gateway-observed
values, while preserving the source-verification limitation on each entry.

For canonical_quote_v1, SHA-256 hashes UTF-8 JSON of a fixed-order array:
[
  "taskgate:quotation-source:v1",
  fileId, supplier, item, quantity, quantityUnit, unitPriceMinor, currency,
  leadTimeDays, paymentTerms, documentText-or-null
]
This hashes the FULL mapped source representation, not a model excerpt.
JSON key order and equivalent decimal price representations are canonicalized.
Source strings, Unicode, line endings, and absent versus empty documentText are
preserved. This is not a digest of the original manifest file's byte formatting.

SuppliedSource has one of two strict forms:
- {basis: 'canonical_quote_v1', sourceId?, sha256?}
- {basis: 'raw_utf8', sourceId?, sha256?, utf8: string}, maximum 16000 chars.

For raw_utf8, utf8 must decode as strict procurement JSON mapping to the exact
same canonical quote values. The digest hashes its actual received UTF-8 string
bytes, including formatting and trailing whitespace. The gateway is responsible
for losslessly delivering the original UTF-8 source; arbitrary binary/PDF source
bytes are not supported by this mapping. Any supplied digest must match.
Raw source bytes never enter model inputs or public-safe trace summaries.

A reference is verified only with an actual trusted source ID plus either:
(1) a matching canonical digest supplied by the gateway, or (2) consistent raw
UTF-8 source bytes, whose digest is computed and checked if also supplied.
Verified means this defined content/digest consistency check passed. It is not
an authenticity signature, proof of complete provenance or proof that content
caused a model proposal. The DI bridge remains the trusted origin boundary.

### Arithmetic and incomplete comparisons

Unit prices convert lexically to integer minor-unit strings. Totals use BigInt:
quantity * unitPriceMinor. Monetary values remain JSON-safe decimal strings;
floating-point multiplication is never used. Precision beyond two decimals is
rejected, not rounded or guessed.

Two distinct observed file/call/receipt identities from the same task/grant are
required. Currency, item, quantity and quantityUnit must match exactly.
Incompatibilities are reported explicitly; there is no FX conversion, unit
conversion, inferred basket equivalence, tax, discount or shipping calculation.

Absolute difference is higher total minus lower total.
Percentage difference = (higher - lower) / higher * 100, rounded half up to two
decimal places using integer arithmetic. Both totals zero yields null percentage
with an explicit reason; one zero and one positive total yields 100.00 percent.
Cheaper/faster file IDs are null on ties. Original payment terms remain verbatim
in comparison entries; no contractual preference is inferred. The result reports
tradeoffs and deliberately gives no overall supplier ranking.

### Supervisor, model delivery and traces

The existing state machine, dispatch ownership, approval pause, replay checks,
12/6/2 limits and uncertainty handling remain intact. WorkflowResult adds
quotations, deterministic comparison and emailProposalStatus. not_attempted
means no validated email proposal was observed; it does not claim universal
injection resistance. A proposed email is not automatically classified unsafe:
the actual gateway remains responsible for policy.

Both accepted quotes are retained. Planner/Reviewer receive quotationContext:
bounded numeric observations, exact formatted monetary values and differences, supplied source references
or explicit unverified status, and excerpts labeled untrusted_document.
Excerpts are at most 300 chars and model-facing payment terms at most 200 chars;
truncation is flagged explicitly, and full source fields remain in internal observations/comparison objects.
The legacy text input fields now carry labeled JSON document envelopes.
No document text is interpolated into system instructions or trusted controls.

The source-aware prompt version documents how to use calculated observations.
Prompt instructions are defense in depth, not authorization or a universal
injection detector. Reviewer stays advisory. Comparison never dispatches email.
Actual role functions and distinct provider calls are preserved.

Traces add sources, sanitized tool_proposal fingerprints and executionStatus.
A proposal digest uses SHA-256 over JSON ["taskgate:proposal:v1", actionKey];
it is an internal correlation fingerprint, NOT the approval action digest.
Source records include only real IDs/digests and evidence status. Model events
record sources made available to that invocation, not a claim of causal use.
Gateway events preserve actual decision, rule, call, receipt and execution state.
A quotation_comparison event reports only the calculation status and source
metadata. No raw quotation or mail bodies are copied into trace summaries.
Scripted gateways/sources stay visibly scripted; live model metadata cannot
convert a fixture into real tool execution.

All WorkflowResult data is internal, including full quotation bodies/raw-source
payloads in observations. Future HTTP routes must authenticate/redact it rather
than serialize it blindly. No routes or persistent run storage are added here.
Samit's real bridge must supply actual dispatch/terminal receipt correlation,
the reviewed mapped quote format, source identity/digest basis and sanitized
synthetic content. Those production integration guarantees remain unverified.
