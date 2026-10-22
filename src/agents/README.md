# AI foundation (developer-only)

Default model: gemini-3.5-flash-lite. GEMINI_MODEL explicitly overrides it.
Credentials are read only from GEMINI_API_KEY (or explicitly injected by server
configuration). This code does not load .env files automatically.

No model/provider fallback, billing changes, grounding, caching, external tools,
gateway bridge or execution loop is implemented. Synthetic data only. Project
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
