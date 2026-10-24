# EAGLE — AI Agent Security Gateway

**Securing what AI agents see, what they can do, and what they claim to have done.**

EAGLE is a security and accountability gateway for enterprise AI agents. It introduces independent controls before untrusted documents reach operational AI and before AI-proposed actions execute through business tools.

Developed for the **CGI AgentOps Hackathon 2026**.

**Team:** Samit Gera and Eeshaan Shukla

## Overview

As AI evolves from generating responses to autonomously interacting with documents, applications and business tools, organizations face new security challenges.

An AI agent can encounter malicious instructions hidden inside external documents, attempt unauthorized operations or incorrectly report that an action succeeded.

EAGLE addresses these challenges through a **dual-boundary security architecture**:

1. **Document Security Preflight:** Inspects uploaded business documents before operational model exposure.
2. **Tool Execution Gateway:** Independently authorizes AI-proposed operations using deterministic security policies.

EAGLE also supports human approval, task-scoped permissions, structured audit evidence and verification of AI execution claims.

Our demonstration uses a secure supplier quotation workflow powered by Google Gemini.

## The Problem

Enterprise AI agents may encounter several risks:

- **Prompt injection:** Malicious instructions embedded in documents attempt to redirect AI behavior.
- **Tool misuse:** An agent proposes actions outside its authorized task.
- **Unauthorized data access:** An agent attempts to access unrelated or restricted resources.
- **Data exfiltration:** Untrusted content attempts to redirect sensitive information to unauthorized destinations.
- **Unverified execution claims:** An AI reports an action as completed without supporting execution evidence.
- **Insufficient oversight:** Organizations lack clear visibility into what agents requested, what was authorized and what actually executed.

Model-level safeguards alone are not an independent authorization system.

**EAGLE's approach is to separate AI reasoning from security enforcement.**

## Architecture

```text
               USER / ENTERPRISE WORKFLOW
                          |
                          v
                  DOCUMENT UPLOAD
                          |
                          v
          +--------------------------------+
          | SECURITY BOUNDARY 1            |
          | DOCUMENT PREFLIGHT             |
          |                                |
          | Structure and data validation  |
          | Injection and exfiltration     |
          | Sensitive information checks   |
          | Integrity and consistency      |
          +--------------------------------+
                          |
                  ALLOW / REVIEW / BLOCK
                          |
                 ALLOW only
                          |
                          v
             CONFIRMED BUSINESS DATA
                          |
                          v
          +--------------------------------+
          | GEMINI AI WORKFLOW             |
          |                                |
          | Planner                        |
          | Reviewer                       |
          | Recovery                       |
          +--------------------------------+
                          |
                  Proposed tool action
                          |
                          v
          +--------------------------------+
          | SECURITY BOUNDARY 2            |
          | TOOL EXECUTION GATEWAY         |
          |                                |
          | Task grants                    |
          | Resource authorization         |
          | Deterministic policies         |
          | Exact human approval           |
          +--------------------------------+
                          |
             ALLOW / BLOCK / APPROVAL
                          |
                 Authorized execution
                          |
                          v
                CONTROLLED ADAPTERS
                          |
                          v
              AUDIT AND CLAIM VERIFIER
                          |
                          v
              TRACEABLE WORKFLOW RESULT
```

The backend retains one authoritative, server-owned workflow execution path.

## Key Features

### 1. Document Security Preflight

Uploaded documents undergo deterministic validation and security checks before being passed into the operational AI workflow.

Checks address:

- Suspicious prompt-injection instructions.
- Attempts to override higher-priority instructions.
- Unauthorized tool-use instructions.
- Potential data exfiltration.
- Sensitive or credential-like information.
- Missing or inconsistent business fields.
- Mathematical inconsistencies.
- Source integrity and content consistency.

The inspection returns one of three decisions:

| Decision | Meaning |
|---|---|
| `ALLOW` | Eligible for controlled operational processing |
| `REVIEW` | Requires examination; withheld from operational AI |
| `BLOCK` | Rejected under the defined validation or security rules |

An `ALLOW` decision is not proof of real-world document authenticity or universal safety.

### 2. Controlled AI Model Exposure

EAGLE minimizes unnecessary untrusted content supplied to operational Gemini.

For accepted quotations, the workflow uses confirmed business fields required for the task instead of blindly transferring hostile document instructions into the operational prompt.

This reduces exposure to document-borne prompt injection.

### 3. Task-Scoped Document Authorization

Uploaded documents are associated with specific tasks.

The backend maintains controlled mappings from quotation aliases such as `quote-A` and `quote-B` to actual uploaded document resources.

This prevents agent-generated document references from independently granting access to unrelated resources.

### 4. Gemini Multi-Agent Workflow

EAGLE uses specialized AI roles:

- **Planner:** Proposes actions needed to complete the user's task.
- **Reviewer:** Critiques proposed actions and identifies concerns.
- **Recovery:** Handles blocked, failed or pending operations.

The agents provide reasoning and proposals, but **none can override deterministic gateway authorization**.

### 5. Deterministic Tool Execution Gateway

Every supported privileged action is checked against server-controlled authorization rules.

Checks include:

- Confirmed Task Grant.
- Correct task and resource scope.
- Permitted tools.
- Prohibited operations.
- Eligible recipients.
- Human approval requirements.
- Exact approved action identity.

The gateway can allow an operation, block it or hold it pending human approval.

### 6. Human-in-the-Loop Approval

Sensitive operations, such as eligible supplier clarification emails, require operator approval.

Approvals are designed to be:

- Bound to the exact action and payload.
- Associated with the correct task and call.
- Time-limited.
- Single-use.
- Revalidated before execution.

Canonicalization and SHA-256 hashing help prevent changing an approved email into a different unauthorized operation.

### 7. Deterministic Quotation Comparison

The procurement workflow supports validated comparison of supplier quotations.

Comparison criteria include:

- Supplier and item information.
- Quantity and unit.
- Unit price and calculated total.
- Currency compatibility.
- Delivery lead time.
- Payment terms.
- Price and delivery tradeoffs.

Business arithmetic is computed deterministically instead of relying solely on LLM-generated calculations.

### 8. Audit Evidence and Claim Verification

EAGLE distinguishes among:

- What the agent proposed.
- What the gateway authorized.
- Whether the controlled adapter executed.
- What execution outcome was recorded.
- Whether a subsequent AI claim is supported by evidence.

A policy decision of `ALLOW` does not automatically indicate successful execution.

Structured claim verification can identify contradictions between an AI's reported action and matching trusted execution evidence.

### 9. Security Evaluation

The project includes automated tests for security rules, document handling, authorization boundaries and workflow behavior.

Evaluation areas include:

- Malicious document handling.
- Unauthorized resource access.
- Prohibited tool operations.
- Approval correctness.
- Replay resistance.
- Adapter failures.
- Source and receipt correlation.
- False execution claims.
- Legitimate task completion.

Scripted tests and real model observations must be distinguished when interpreting results.

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js, TypeScript |
| Backend HTTP framework | Express |
| Frontend | React, TypeScript |
| AI model | Google Gemini |
| Runtime data validation | Zod |
| Security policies | Deterministic TypeScript logic |
| Hashing | SHA-256 |
| Testing | Vitest |
| Version control | Git and GitHub |

## Getting Started

### Prerequisites

Install:

- **Node.js** — an appropriate supported LTS version.
- **npm** — included with Node.js.
- **Git** — for cloning the repository.
- **Google Gemini API key** — required for live AI-model workflows.

A modern browser is required for the frontend.

### 1. Clone the Repository

```bash
git clone https://github.com/SAMIT-GERA/taskgate.git
cd taskgate
```

Check out the submitted branch or exact commit if it differs from the repository's default branch.

```bash
git checkout feat/samit-backend
```

For a reproducible evaluation, use the exact commit SHA supplied in the hackathon portal.

### 2. Install Backend Dependencies

```bash
npm ci
```

The command installs dependencies from the committed npm lockfile.

If the final repository uses a different dependency configuration, follow its package manifest.

### 3. Configure Environment Variables

The backend uses a Gemini API key for live model execution.

Do not commit credentials or place API keys in frontend source files.

For Windows PowerShell, set the key in the current terminal session:

```powershell
$env:GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"
```

The model can be configured where supported:

```powershell
$env:GEMINI_MODEL = "gemini-3.5-flash-lite"
```

Operator approval functionality may also require a backend-only operator PIN:

```powershell
$env:OPERATOR_PIN = "YOUR_LOCAL_DEMO_PIN"
```

Use appropriate values for your own local environment. Never commit real keys, PINs or secret-bearing configuration files.

**Maintainer verification:** Confirm the environment-variable names and all additional required configuration against the final server source before submission.

### 4. Start the Backend

Inspect the available package scripts:

```bash
npm run
```

Run the backend's development/start script as defined in the root `package.json`.

If the final package defines a `dev` script:

```bash
npm run dev
```

Keep the backend terminal open while using the application.

### 5. Install and Start the Frontend

Open a second terminal from the repository root:

```bash
cd frontend
npm ci
```

Inspect frontend scripts:

```bash
npm run
```

If the frontend defines a `dev` script:

```bash
npm run dev
```

Open the local URL displayed by the frontend development server.

The frontend and backend must use compatible local API settings. Confirm any frontend API-base-URL configuration against the final implementation.

### 6. Run Automated Tests

From the repository root:

```bash
npm run typecheck
npm test
npm run build
```

These commands check TypeScript correctness, execute automated tests and build the backend application.

If the frontend maintains separate checks or build scripts, run those from `frontend/` as well.

For Windows environments where PowerShell blocks npm's script shim, use:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

### 7. Running Without a Live API Key

Deterministic unit tests use controlled test data and should not require live Gemini requests.

The interactive Gemini workflow requires a valid server-side API key and available model quota.

Do not represent deterministic fake-model tests as genuine live model demonstrations.

## Demo Workflow

The current primary demo uses two supplier quotations.

1. Open the EAGLE frontend.
2. Upload the supported quotation documents.
3. Confirm the task's document scope.
4. Run document-security preflight.
5. Observe `ALLOW`, `REVIEW` or `BLOCK` decisions.
6. Continue an eligible workflow using confirmed quotation data.
7. Observe Gemini Planner/Reviewer activity where live model mode is enabled.
8. Examine deterministic quotation-comparison results.
9. Attempt an unauthorized tool request to demonstrate gateway enforcement in the supported security test workflow.
10. Review a sensitive eligible email request through human approval.
11. Inspect simulated execution outcomes, audit receipts and claim verification.

Some security demonstrations may use deterministic fixtures. Fixture-based actions must be labeled as scripted rather than presented as spontaneous live Gemini behavior.

## Repository Structure

Major components of the current project include:

```text
src/
  agents/
    quotation.ts
    ...

  documents/
    documentPreflight.ts
    quotationUploads.ts
    taskBindings.ts

  workflows/
    agentWorkflow.ts

  gateway/
    policy.ts
    dispatch.ts
    quotationBridge.ts

  contracts/
    types.ts
    schemas.ts

  evaluation/
    ...

  server.ts

frontend/
  src/
    main.tsx

tests/
  documentPreflight.test.ts
  fullSystemAudit.test.ts
  uploadedExecution.test.ts
  ...

docs/
  document-preflight.md
  ...
```

The complete file tree may contain additional modules and tests.

## Business Value

EAGLE demonstrates a security control approach relevant to enterprises adopting agentic AI.

Potential benefits include:

**Stronger security:** Reduce untrusted document exposure and independently restrict unauthorized gateway-controlled actions.

**Improved productivity:** Automate suitable document analysis and routine comparison tasks while preserving human oversight.

**Better reliability:** Use deterministic business calculations, validated inputs and evidence-backed execution outcomes.

**Greater transparency:** Record authorization decisions and outcomes for inspection and troubleshooting.

**Human accountability:** Require explicit approval for eligible sensitive actions.

**Responsible AI adoption:** Make carefully scoped AI automation more controllable and easier to evaluate.

Potential application areas include procurement, banking, insurance, customer service, IT operations and enterprise administration.

These are possible extensions of the security architecture, not claims that every industry workflow is already implemented.

## Relevance to CGI

CGI emphasizes responsible enterprise AI, secure automation, human oversight, agent governance and protection against prompt injection, tool misuse and unauthorized escalation.

EAGLE demonstrates a focused application-level approach to these challenges.

The project could conceptually complement enterprise identity, cybersecurity monitoring and governance infrastructure by enforcing authorization at the boundary between AI-generated actions and operational business tools.

**EAGLE is not a replacement for enterprise IAM, SIEM/SOC, regulatory controls or cybersecurity platforms.**

The hackathon implementation is a prototype demonstrating key security principles rather than a certified production deployment.

## Security Scope and Limitations

EAGLE focuses on supported documents and tools executed through its controlled application architecture.

Important limitations:

- No universal guarantee against every prompt-injection technique.
- Hashes establish content consistency, not real-world supplier authenticity.
- Task-level resource controls are not full enterprise multi-tenant isolation.
- Mock email execution does not represent external email delivery.
- A local audit trail is not automatically tamper-proof.
- Enterprise SSO/MFA and production IAM integration require additional work.
- Unrestricted out-of-band agent credentials or networking would require stronger sandboxing and isolation.
- Million-document scalability has not been demonstrated.
- Enterprise SOC integration, automatic containment and rollback are future extensions.
- Financial savings and threat-detection percentages must be measured before they can be claimed.

## Security and Responsible Use

- Never commit API keys, passwords, PINs or access tokens.
- Keep secret-bearing configuration out of version control.
- Use synthetic or authorized test documents.
- Do not upload confidential client information to a public demonstration.
- Use mock adapters for the supplied hackathon email workflow.
- Treat uploaded and model-generated content as untrusted.
- Preserve appropriate access controls around approval and audit endpoints.
- Avoid publishing sensitive logs or live credentials.

If a real credential is accidentally committed, remove it from the public history appropriately and rotate/revoke the credential. Simply deleting it in a later commit is not sufficient.

## Future Improvements

- Enterprise IAM, SSO, MFA and RBAC/ABAC integration.
- Stronger production tenant isolation.
- Additional secure enterprise tool adapters.
- High-volume document processing with queues and workers.
- Secure distributed audit storage and retention policies.
- SOC/SIEM integration and security monitoring.
- Expanded adversarial testing and red-teaming.
- Verified supplier identity and digital signatures.
- More document types and industry-specific workflows.
- Production reliability and load testing.

## Team

**Samit Gera** — Gateway and backend engineering, policy enforcement, workflow integration, document-handling evolution and frontend development.

**Eeshaan Shukla** — Exact-action security, human approval, audit evidence, claim verification, Gemini-agent components, source-aware quotation comparison and evaluation framework.

## References

- CGI Agentic AI: https://www.cgi.com/en/artificial-intelligence/agentic-ai
- CGI Responsible AI: https://www.cgi.com/en/artificial-intelligence/responsible-ai
- CGI — Governing Agentic AI: https://www.cgi.com/us/en-us/article/federal-government/governing-agentic-ai-why-traditional-ai-governance-isnt-enough
- OWASP LLM01 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- NIST Agent-Hijacking Evaluation: https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations

---

**EAGLE — Trust the workflow, not just the model.**
