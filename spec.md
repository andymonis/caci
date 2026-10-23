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
| R-006 | [Web App: Circles — Specification](specs/R-006-web-circles.md) |
| R-007 | [Web App: Notes — Specification](specs/R-007-web-notes.md) |
| R-008 | [Shared Circle Brains — Specification](specs/R-008-shared-brains.md) |
| R-009 | [Shared Circle Brains (circle-owned graph) — Specification](specs/R-009-shared-circle-brains.md) |
| R-010 | [Raspberry Pi Deployment — Specification](specs/R-010-pi-deployment.md) |
| R-011 | [Status Updates — Specification](specs/R-011-status-updates.md) |
| R-012 | [Controllable LLM Communication — Specification](specs/R-012-controllable-llm.md) |
| R-013 | [Brain Quality Evaluation — Specification](specs/R-013-brain-evaluation.md) |
| R-014 | [The Current-View Brain — Specification](specs/R-014-current-view-brain.md) |
| R-015 | [The Fact-Level Brain — Specification](specs/R-015-fact-level-brain.md) |
| R-016 | [The Minimal User App — Specification](specs/R-016-user-app.md) |
| R-017 | [The Input Ledger and the Brain Export — Specification](specs/R-017-input-ledger-and-export.md) |
| R-018 | [Focused Answers: Horizons, Dated Facts and Follow-up Actions — Specification](specs/R-018-focused-answers.md) |

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
| Web App (register, sign in, a temporary home page, R-005; circles, R-006; notes, R-007) | `web/` (W1 and W2 done; notes planned, W3): plain HTML, CSS and JavaScript served by the service from the same address; no build step |
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
- **Done (2026-10):** C2 circles (R-004): groups of people with four fixed, setting-agnostic roles, invitations that must be accepted, the last-owner rule, account deletion handing circles on, routes, settings, an end-to-end test and a security review. (A circle shares nothing by itself; sharing arrived with S1 below.)
- **Done (2026-10):** W1 the web app, first slice (R-005): register, sign in and out and a temporary home page, in plain HTML, CSS and JavaScript served by the service from the same address under a strict Content-Security-Policy. Nothing else is in the app yet.
- **Done (2026-10):** W2 the web app with circles (R-006): screens with addresses for creating, joining, leaving, viewing and managing circles, role hints tested against the service, two-step confirmations, an end-to-end test and a security review.
- **Done (2026-10):** W3 the web app with notes (R-007): capture with a preview and approval, a notice of which model files the note shown before it is sent, read-only browsing of your own categories and items, an end-to-end test and a security review.
- **Done (2026-10):** S1 shared circle brains (R-008): read-only sharing of chosen categories between circle members; the owner grants to a named member, withdrawable at any time, ended by leaving, removal, account deletion or circle deletion in the same step; reads are live and re-checked on every request; a private category and what is reachable only through it read like a made-up id; routes, the web app's *What you share* and *Shared with you*, an end-to-end test, a hand check and a security review. **Pseudonymisation and the legal groundwork remain release gates before anyone but the owner uses it.**
- **Done (2026-10):** S2 the shared circle brain (R-009): a circle owns one graph that owners, managers and members capture into and observers read; scoped capture and browse, a My Brain aggregate with provenance on every result, contribution stamps, circle record and circle graph kept in step (ordered steps plus a reconcile at start-up), a scope choice in the web app with the sharing notice before a circle capture, a hand check and a security review. It coexists with R-008 and carries the same release gates: **pseudonymisation and the legal groundwork are required before anyone but the owner uses it.**
- **Done and running (2026-10):** D1 a Raspberry Pi family test (R-010): a systemd service on a dedicated account, plain HTTP on the home Wi-Fi, the real model with its key in an environment file, nightly snapshots and a tested restore, a one-command update that rolls back (code and data) when the new version does not come up, an install script, a doctor command and a step-by-step runbook in the README. Tested with stand-ins and then **run for real on the owner's Pi (confirmed 2026-10-13)**, used over the home Wi-Fi by the owner and their wife. The personal-data release gates stand for anything beyond that test.
- **Done (2026-10):** Q1 status updates (R-011): the person asks CaCi, in their own words, for a short standard-format status built from their personal brain and every circle brain they can read; the answer is for them alone, cites numbered notes that the server maps to where they came from, and is not filed or kept. A second LLM capability (`status`) with a guard, a demo stand-in, a context reader, a route, a web screen, an evaluation set, an end-to-end test, a hand check and a security review. The same release gates apply.
- **Done (2026-10):** K1 controllable LLM communication (R-012): every message to the model is three separate parts (the request, the combined brain context, and the controls); the controls (instructions, the words around the other two parts, and the limits) are six text files in a `controls/` folder read at start-up, with named slots only, validated (a bad file stops the start), and the reply schema and the guard built from the same numbers; the demo model no longer depends on wording; the trace and the lab show the three parts; the evaluation tools and the lab take `--controls DIR` to try a candidate folder. A feeder for testing the brain at scale.
- **Done (2026-10, awaiting the owner's real run):** B1 brain quality evaluation (R-013): `npm run brain-eval`, a development-only tool that files invented dated notes through the real categoriser into a real graph and asks questions as status requests (the brain arm), asks the same questions with every raw note replayed in time order (the replay arm), and scores both by rules (facts that must appear, stale facts that must not) on the real models; a library of 8 invented scenarios with a review page, seeded filler to test volume, a diagnostic of where a fact was lost (filing, context, answer or stale), a demo mode, a comparison of two saved runs and `--controls DIR` for trying changed controls. **The first real run is the owner's; what it finds decides what to build next (supersession, raw text kept, a dedicated answer capability, a hybrid or recent-window arm).**
- **Done (2026-10, awaiting the owner's real run):** V1 the current-view brain (R-014, T-215 to T-231): a new fact deletes the old information it replaces (candidates found by the controller, named by number by the categoriser, deleted by trusted code in the same atomic write, emptied categories tidied), the preview and outcome say what is removed, and a change log (the ledger, kept `CACI_LEDGER_DAYS` days, a review log and not a history) records what was added, removed and updated, with a screen, a route and a setting; personal and circle brains. The brain-eval measures it (`lost at replace`, `--no-replace`, two add-not-replace scenarios). **The owner's real before and after run (`--repeat 3`) decides whether it helps**; the demo filing already shows its known cost, that a replacing note takes with it any detail it does not repeat.
- **Done (2026-10, awaiting the owner's real run):** F1 (T-232 to T-241, R-015) the fact-level brain: a note that states several facts is stored as separate fact items (each with a short key), so a changed value replaces only its own fact and unchanged facts survive; `maxFacts` 1 is today's behaviour and the A/B switch; the brain-eval gains multi-fact scenarios and a collateral-loss count.
- **Done as N1 (T-242 to T-249, R-016):** a very minimal user app at `/` (login, an iMessage-style chat with Send for updates and Ask for questions, profile and password), using the same APIs as the back office, which moves to `/admin`; chat in memory only, notes saved straight away, simple PWA without manifest or HTTPS. From the owner's `architecture/user_pwa.md`.
- **Done as N2 (T-250 to T-257, R-016 D16 to D22):** from the owner's updated `architecture/user_pwa.md`: Home Send always records against the own brain; each circle gets its own Circle screen at the top of the navigation (Send records against the circle, observers read only, a Pulse button asks for a status of that circle with predefined text from `controls/pulse.txt`); `POST /api/status` gains an optional circle `scope` and `pulse: true`.
- **Done as L2 (T-258 to T-265, R-017):** the change ledger also keeps the text of each update as sent (readable by everyone who can read that brain's log), shown beside the facts in the back office's change log; an operator command `npm run export-brain` exports a user's or circle's brain from a consistent snapshot as JSON (and as a brain-eval scenario draft), so real brains can be used as test input to improve answers.
- **Done as L3 (T-266 to T-273, R-017 part 2):** a person can trace a fact to who entered it, when and the exact words (a Show the source button on each point of an answer in the minimal user app; the lookup goes through the ledger's approval ids); the model is not shown the source.
- **Being built as T1 (T-293 to T-296, R-010 amended):** using the Pi away from home through Tailscale (a private network, no router port, never Funnel), plain HTTP kept with the tailnet name added to the allowed hosts, owner only for now; a doctor line, a settings-example block and runbook step 13.
- **H1 Part A done (T-274 to T-281, R-018):** focused answers: three checks (Pulse over a week, Coming up over a month, Long range over a year) whose window the code works out in the person's time zone and states to the model, rules in `controls/status/settings.json`, three server-held check texts, `POST /api/status` taking `check` and no text, buttons on Home and the circle screens, silence (one line) when nothing needs attention, a demo-model date finder, and an evaluation of eleven invented cases (`npm run eval -- --capability focus`). **Next, re-confirmed after the owner's real run of that evaluation:** Part B (dates and done state extracted when a fact is filed, filtered in code) and Part C (suggested follow-up actions, OK or skip).
- **After that, to be planned (decided on the evidence of the real before and after run):** further changes to the brain itself (for example carrying unchanged details into a replacing note); then writing into another brain via approval, relationship labels, invitation notifications.
- **After that, to be planned:** making the web app installable, M4b matching and presets (with SQL push-down), picture and voice input, question answering, M7 packaging and release. Deferred: the M5 file adapter. Each roadmap item in the Backlog needs its own spec first.
- **Principle:** model output is never written without a human preview and approval, and only the operations the guardrails allow can reach the graph.

GSD planning reference: [Bipartite Graph Store library specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md#suggested-gsd-phase-breakdown).

## 9. Open questions
-
