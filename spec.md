# Core Spec

> Status: skeleton. Fill in section by section; `/plan` turns finished sections into tasks.

## Detailed specification

The [Bipartite Graph Store library specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md) defines the detailed product contract: functional and non-functional requirements, acceptance criteria, API and adapter design, open questions, and the suggested GSD phase breakdown.

Use its requirement and acceptance-criterion IDs when creating GSD tasks. This core spec remains the source of truth for product intent and decisions; update both documents when a decision changes their shared scope.

## 1. Purpose

The purpose of the CaCi platform is to provide a robust and efficient system for managing and querying bipartite graphs, enabling seamless integration with external systems like LLMs and communication channels while ensuring data consistency and operational reliability.

The platform will be targetable for different product domains, which are being identified and will be expanded on later. 

Do not over optimise for a perceived market early. This is a core technology platform, that should stay agnostic to specific product domains.

## 2. Goals
- Provide a robust and efficient system for managing and querying bipartite graphs.
- Enable seamless integration with external systems like LLMs and communication channels.
- Ensure data consistency and operational reliability.

## 3. Non-goals
- Targetted market solution.
- Over-optimisation for specific product domains.

## 4. Users & scenarios
_Draft, domain-agnostic. Examples below are illustrative, not a market commitment._

**Users**
- **Host application developer:** embeds the library. May use the optional user controller (R-002) for accounts, login and per-user graphs, or bring their own authentication and decide which `graphId` a caller may use.
- **End user of the host app:** never sees the library; their information is stored and retrieved through it, one isolated graph per user.
- **LLM and comms integrations:** consume graph context and write back categorisations, via the host app.

**Scenarios**
1. **Capture and categorise:** the host app (or an LLM it calls) writes a piece of information as an item and files it under one or more categories in the user's graph.
2. **Recall context:** before asking an LLM a question, the host app queries the graph for everything referencing a category (for example one person or topic) and passes the subgraph as context.
3. **Discover related information:** the host app asks which items share categories with a given item, ranked by overlap, to surface related material.

## 5. Requirements
_Each requirement gets an id and a testable acceptance criterion._

| ID | Link |
|----|------|
| R-001 | [Bipartite Graph Store — Library Specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md) |
| R-002 | [User Accounts and Login API — Specification](specs/R-002-user-accounts.md) |
| R-003 | [CaCi Controller — Specification](specs/R-003-caci-controller.md) |
| R-004 | [Circles — Specification](specs/R-004-circles.md) |
| R-005 | [Web App (first slice) — Specification](specs/R-005-web-app.md) |

## 6. Constraints & decisions
- **Stack:** TypeScript (strict, ESM), Node 22+, npm. Platform constraints are NFR-01 to NFR-03 in the R-001 spec.
- **Validator:** Zod, the single runtime dependency; JSON Schema is generated from it.
- **Tooling:** Vitest, ESLint (flat config), `tsc --noEmit`. TypeScript pinned to `~6.0` until `typescript-eslint` supports 7.
- **`link` default:** fails on missing endpoints; `ensureNodes: true` opts in. Strict and explicit.
- **v1 scope:** `requestId` accepted in the schema but not implemented; caller-supplied ids only; strict bipartite with no category hierarchy.
- **Build order:** contracts, memory adapter and write, conformance suite, query, the capture proof of concept (LLM component, controller, dev tools), then **SQLite persistence**, then query matching, export/import and packaging. The file (JSON) adapter is deferred (decided 2026-10-05): `node:sqlite` gives zero-dependency local storage with real transactions.
- **Persistence:** SQLite through `node:sqlite` (built into Node, needs 22.13 or later, experimental), behind the same adapter interface and conformance suite as the memory adapter. The reasons and the design decisions (ids stored as UTF-16 blobs, serialised transactions, versioned schema, no encryption at rest) are in the R-001 spec.
- **Code layout:** all graph store functionality (library code, tests, adapters, conformance suite) lives under `src/graph_store/`. It is an isolated feature: nothing outside that folder may be imported by it. Other platform containers get their own sibling folders under `src/` when they exist. Reason: the architecture treats the graph store as a self-contained container.
- Dated decision log lives in `.gsd/STATE.md`.

## 7. Architecture sketch
Reference ./architecture/context.mmd 
Reference ./architecture/container.mmd

Mapping from the container diagram to the code base:

| Container | Location |
|-----------|----------|
| Bipartite Graph Store (TypeScript library) | `src/graph_store/` |
| Storage Adapter | `src/graph_store/adapters/<name>/` (adapters ship as entry points of the library, per the R-001 spec, so they sit inside the graph store folder) |
| Adapter conformance suite | `src/graph_store/testing/` |
| CaCi Operational Store (SQLite) | provided by the SQLite adapter (planned as P1, the first persistent adapter); no code outside the adapter |
| LLM component (the LLM adapter) | `src/llm/` (planned, L1 and L2): `createLlm({ client, config })` returns one method per capability, today `categorise()`, so new capabilities can be added beside it; the model is configurable per capability through tiers (`fast`, `balanced`, `deep`), and model access sits behind a `ModelClient` port, with the real Anthropic client as its own entry point |
| CaCi Application (the capture controller) | `src/app/`: takes input, reads graph context, asks the categoriser, shows a preview, and writes only after approval |
| Web App (register, sign in, a temporary home page, R-005) | `web/` (planned, W1): plain HTML, CSS and JavaScript served by the service from the same address; no build step |
| Circle Controller (groups, roles, invitations, R-004) | `src/circles/` (C2), stored in the user database; membership and roles only, no sharing of graphs |
| CaCi Controller (the platform controller, R-003) | `src/caci/`: composes the user controller, the capture controller, the LLM component and the graph store; owns proposal ownership, per-account limits and "the graph comes from the session" |
| User Controller (accounts, sessions, R-002) | `src/users/`, with its SQLite stores in `src/users/sqlite/` and its shared test suites in `src/users/testing/` |
| Shared SQLite driver wrapper | `src/sqlite/` (the only code that imports `node:sqlite`) |
| HTTP API (the only network code) | `src/api/`: the server kit, the account routes, and (planned) the capture and read routes |
| Service (configuration, the two database files, `npm run serve`, `npm run users`) | `src/service/` and `scripts/` |

The graph store knows nothing about the LLM, and the LLM component knows nothing about storage: only the controller connects them. The user accounts layer sits in front of everything: a session gives the user and their one graph, and nothing a client sends can choose another.

Generated JSON Schema for the instruction formats is published under `schema/graph_store/`.

Local-only development tools live under `dev/` and are never published: `dev/graph-explorer/` (built) and `dev/llm-lab/` (planned, T-052).

## 8. Milestones
- **Done:** M0 foundations, M1 contracts, M2 write path and memory adapter, M2b graph lifecycle, M3 conformance suite, M4a core reads, L1 the LLM categoriser core, A1 the controller with preview-then-approve, L2 the real Anthropic client, the LLM lab and the evaluation harness, A1b capture in the explorer and the end-to-end test (see `.gsd/PLAN.md` for the task history). The capture proof of concept is complete, on in-memory storage.
- **Done (2026-10):** P1 SQLite persistence: the adapter passes the shared conformance suite on memory and files, with durability, crash and two-process tests, the capture flow and the explorer on SQLite, and an NFR-05 benchmark (export/import was dropped as not needed).
- **Done (2026-10):** U1 user accounts and the login API (R-002: password login, server-side sessions, open registration, one graph per user, an admin role, a recovery command), and C1 the CaCi controller (R-003: authenticated capture with preview and approval, and read-only browsing of your own graph, over the user API, with the demo model by default).
- **Done (2026-10):** C2 circles (R-004): groups of people with four fixed, setting-agnostic roles, invitations that must be accepted, the last-owner rule, account deletion handing circles on, routes, settings, an end-to-end test and a security review. Circles share no data yet.
- **Done (2026-10):** W1 the web app, first slice (R-005): register, sign in and out and a temporary home page, in plain HTML, CSS and JavaScript served by the service from the same address under a strict Content-Security-Policy. Nothing else is in the app yet.
- **Next, to be planned:** the web app with circles and with note capture (Backlog items 6 and 7), restricted access between circle members (needs pseudonymisation and the legal groundwork first).
- **After that, to be planned:** making the web app installable, deployment to a Raspberry Pi, M4b matching and presets (with SQL push-down), picture and voice input, question answering, M7 packaging and release. Deferred: the M5 file adapter. Each roadmap item in the Backlog needs its own spec first.
- **Principle:** model output is never written without a human preview and approval, and only the operations the guardrails allow can reach the graph.

GSD planning reference: [Bipartite Graph Store library specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md#suggested-gsd-phase-breakdown).

## 9. Open questions
-
