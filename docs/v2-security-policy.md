# TaskGate v2 Security Policy Specification

## Status and compatibility

This specification records the approved Milestone 1 policy decisions. It does not alter the frozen v1 public contracts, Zod schemas, HTTP DTOs, routes, or `SecurityDependencies` interface. New v2 state and descriptors remain internal until a jointly reviewed contract migration approves a public change.

## Rule catalog

- `TG-G001` — Missing, expired, revoked, or inactive grant.
- `TG-G002` — Task ID or grant-version mismatch.
- `TG-T001` — Unknown or unsupported tool.
- `TG-T002` — Destructive operation prohibited.
- `TG-R001` — Resource not authorized.
- `TG-R002` — Invalid or path-like resource identifier.
- `TG-E001` — Unauthorized recipient.
- `TG-A001` — Human approval required.
- `TG-A002` — Approval invalid, expired, altered, or consumed.
- `TG-S001` — Invalid schema or canonical payload.
- `TG-P001` — Authorized read-only operation.
- `TG-P002` — Authorized action with valid approval.
- `TG-X001` — Audit preflight failure; no execution. This rule belongs to dispatch, not the pure policy evaluator.

## Deterministic precedence

The policy evaluator must apply these checks in order and return the first applicable result:

1. Strict schema and canonical-payload validation (`TG-S001`).
2. Active-grant validation (`TG-G001`).
3. Task ID and grant-version binding (`TG-G002`).
4. Supported-tool validation (`TG-T001`).
5. Destructive-operation prohibition (`TG-T002`).
6. Resource and recipient restrictions (`TG-R002`, `TG-R001`, `TG-E001`).
7. Human-approval requirement for an otherwise eligible email (`TG-A001`).
8. Authorization (`TG-P001` for reads; `TG-P002` only after the gateway validates and consumes exact approval).

Hard-deny outcomes always return `DecisionKind = 'block'`; they cannot be converted to `request_approval` by approval data, an operator, a reviewer, agent output, or retrieved text. An eligible email in isolation returns `request_approval`; it is not dispatched by the policy evaluator.

## Internal grant state

The public `TaskGrant` remains unchanged. A future Samit-owned internal grant-state store will key state by `(taskId, version)` and retain only server-owned lifecycle data such as active status, expiry, revocation status, and confirmation metadata. Policy receives a public grant plus that internal state and fails closed with `TG-G001` when state is absent, inactive, expired, revoked, or unconfirmed. Agents and retrieved documents cannot create, amend, confirm, revoke, or extend a grant.

## Approval boundary

Eeshaan owns canonicalization and approval services. Samit's gateway will call the frozen `SecurityDependencies` methods only after a syntactically valid, currently eligible email has passed all hard-deny checks. Canonical approval must bind the exact canonical payload, call ID, task ID, and grant version. The gateway must re-evaluate grant validity and hard-deny conditions before adapter execution. An invalid, expired, replayed, altered, or consumed approval yields `TG-A002` and zero adapter calls.

### Pending-approval integration state

Server composition retains a private pending-approval metadata record for each gateway-created pending email. It binds the canonical action digest, task ID, call ID, trusted grant version, canonical recipient, subject, and body. The operator route may issue an approval only when its pending row exactly matches that private record, the active grant is still the same version, and the pure policy still returns `request_approval`. The gateway independently repeats its metadata, approval-consumption, grant, and policy checks before dispatch.

This metadata is process-local and is deliberately not reconstructed from an operator-visible pending row after restart. Pending approvals from before a restart therefore fail closed; the operator must initiate a new, identical request under the current grant. This bridge is not a second approval authority: Eeshaan's approval service remains the only issuer and atomic consumer.

## Dispatch and audit boundary

The policy evaluator has no adapter, network, audit, approval-write, or filesystem side effects. For a side-effecting email allowed after exact approval, the gateway must persist audit preflight before invoking the adapter. A failed preflight is `TG-X001` and guarantees zero adapter calls. A policy `allow` is authorization only; it is never evidence of success. If outcome persistence fails after a possible side effect, the gateway must expose an internal uncertain-outcome result, prohibit automatic resend, and must not relabel the outcome as success or failure through the frozen public `ExecutionStatus` enum.

## Testable invariants

- No active server-confirmed grant means no privileged execution.
- Unknown tools, malformed payloads, and unknown object fields fail closed.
- Unauthorized resources, recipients, path-like IDs, and destructive operations invoke zero adapters.
- Approval never overrides a hard deny and is exact, expiring, single-use, and atomic.
- All controlled adapters execute only through the gateway.
- Read authorization and adapter success are distinct facts.
- Side effects require successful durable audit preflight.
- Retrieved documents, LLM output, reviewer notes, and browser input have no authorization authority.
- Every returned decision has a stable rule ID and deterministic explanation.

## Ownership

Samit owns grant lifecycle state, deterministic policy, internal capability descriptors, gateway orchestration, controlled adapters, server wiring, fixtures, and Samit-owned tests. Eeshaan owns canonical action construction, exact approval persistence and consumption, audit/receipt persistence, email evidence, claim verification, operator routes, and agent orchestration. Neither side replaces the other's modules; integration uses only the frozen `SecurityDependencies` interface and route-registration hooks.
