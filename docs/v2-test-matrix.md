# TaskGate v2 Security Test Matrix

This is the Milestone 2 and gateway-integration test plan. Tests marked **Eeshaan integration dependency** require Eeshaan-owned canonicalization, approval, or audit implementations. The expected adapter count is the observed invocation count for the relevant controlled adapter.

## Grant and binding cases

- `M2-G01` — Create and retrieve a valid confirmed grant. Expected: valid server-owned grant is returned; no adapter invocation. Owner: Samit.
- `M2-G02` — Reject malformed grant data, including missing required fields, extra fields, invalid tool values, and malformed recipient. Expected: validation failure; no state created; no adapter invocation. Owner: Samit.
- `M2-G03` — Duplicate `(taskId, version)` grant identifier. Expected: reject duplicate safely; existing grant remains unchanged. Owner: Samit.
- `M2-G04` — Missing or inactive grant. Expected: `block`, `TG-G001`, no adapter invocation. Owner: Samit.
- `M2-G05` — Expired grant. Expected: `block`, `TG-G001`, no adapter invocation. Owner: Samit.
- `M2-G06` — Revoked grant. Expected: `block`, `TG-G001`, no adapter invocation. Owner: Samit.
- `M2-G07` — Call task ID differs from active grant task ID. Expected: `block`, `TG-G002`, no adapter invocation. Owner: Samit.
- `M2-G08` — Call grant version differs from active grant version. Expected: `block`, `TG-G002`, no adapter invocation. Owner: Samit.

## Pure policy cases

- `M2-P01` — Authorized `read_quote` for `quote-A`. Expected: `allow`, `TG-P001`; no adapter invocation during pure policy evaluation. Owner: Samit.
- `M2-P02` — Unknown tool identifier. Expected: `block`, `TG-T001`, no adapter invocation. Owner: Samit.
- `M2-P03` — `delete_quote` request. Expected: `block`, `TG-T002`, no adapter invocation. Owner: Samit.
- `M2-P04` — Unsupported operation with a syntactically valid approval ID. Expected: `block` from its hard-deny rule, never `request_approval`. Owner: Samit.
- `M2-P05` — Unapproved quote ID. Expected: `block`, `TG-R001`, no adapter invocation. Owner: Samit.
- `M2-P06` — Path traversal or path-like file ID such as `../quote-A`, `C:\\quote-A`, or URL-like input. Expected: `block`, `TG-R002`, no adapter invocation. Owner: Samit.
- `M2-P07` — Malformed call schema or extra argument field. Expected: `block`, `TG-S001`, no adapter invocation. Owner: Samit.
- `M2-P08` — Eligible recipient with a syntactically valid email and no approval. Expected: `request_approval`, `TG-A001`, no mail invocation. Owner: Samit with **Eeshaan integration dependency** for pending registration.
- `M2-P09` — Forbidden external recipient. Expected: `block`, `TG-E001`, no mail invocation. Owner: Samit.
- `M2-P10` — Hard-deny precedence for invalid grant, mismatched task, unknown tool, destructive operation, invalid resource, and forbidden recipient. Expected: the earlier hard-deny rule wins; never `request_approval`. Owner: Samit.

## Approval and gateway integration cases

- `INT-A01` — Exact approved canonical email dispatch. Expected: `TG-P002`, exactly one mail invocation and terminal observed outcome. Owner: shared; **Eeshaan integration dependency**.
- `INT-A02` — Replayed approval. Expected: `block`, `TG-A002`, zero additional mail invocations. Owner: shared; **Eeshaan integration dependency**.
- `INT-A03` — Expired approval. Expected: `block`, `TG-A002`, zero mail invocations. Owner: shared; **Eeshaan integration dependency**.
- `INT-A04` — Recipient, subject, or body altered after approval. Expected: `block`, `TG-A002`, zero mail invocations. Owner: shared; **Eeshaan integration dependency**.
- `INT-A05` — Two concurrent approved retries for one approval. Expected: at most one mail invocation. Owner: shared; **Eeshaan integration dependency**.
- `INT-A06` — Audit preflight failure before authorized side effect. Expected: no execution with `TG-X001`; zero mail invocations. Owner: shared; **Eeshaan integration dependency**.
- `INT-A07` — Mock adapter failure after successful preflight. Expected: allowed dispatch with terminal failed receipt; no fabricated success. Owner: Samit adapter plus **Eeshaan integration dependency** for receipt persistence.
- `INT-A08` — Outcome recording fails after a possible send. Expected: explicit internal uncertain outcome and no automatic retry or second mail invocation. Owner: shared; **Eeshaan integration dependency**.

## Gateway verification cases

- `GW-01` — Authorized read dispatches only the manifest-mapped quote. Expected: one read invocation and observed terminal result. Owner: Samit.
- `GW-02` — Denied calls across all hard-deny categories. Expected: zero controlled-adapter invocations. Owner: Samit.
- `GW-03` — Quote fixture text contains a malicious instruction. Expected: text is treated as data and cannot modify grant state or policy. Owner: shared; agent behavior is separately labeled from scripted gateway enforcement.
- `GW-04` — Earlier successful email cannot satisfy a later failed call's claim. Expected: verifier uses exact task/call/recipient/digest/terminal receipt match. Owner: Eeshaan.
- `GW-05` — No matching evidence. Expected: claim verifier returns `missing_evidence`. Owner: Eeshaan.
