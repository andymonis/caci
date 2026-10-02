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
- **Host application developer:** embeds the library, owns auth and decides which `graphId` a caller may use.
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

## 6. Constraints & decisions
- **Stack:** TypeScript (strict, ESM), Node 22+, npm. Platform constraints are NFR-01 to NFR-03 in the R-001 spec.
- **Validator:** Zod, the single runtime dependency; JSON Schema is generated from it.
- **Tooling:** Vitest, ESLint (flat config), `tsc --noEmit`. TypeScript pinned to `~6.0` until `typescript-eslint` supports 7.
- **`link` default:** fails on missing endpoints; `ensureNodes: true` opts in. Strict and explicit.
- **v1 scope:** `requestId` accepted in the schema but not implemented; caller-supplied ids only; strict bipartite with no category hierarchy.
- **Build order:** contracts, memory adapter and write, conformance suite, query, file adapter, SQLite adapter, export/import and packaging.
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
| CaCi Operational Store (SQLite) | provided by the SQLite adapter (M6); no code outside the adapter |
| LLM component (the LLM adapter) | `src/llm/` (planned, L1 and L2): `createLlm({ client, config })` returns one method per capability, today `categorise()`, so new capabilities can be added beside it; the model is configurable per capability through tiers (`fast`, `balanced`, `deep`), and model access sits behind a `ModelClient` port, with the real Anthropic client as its own entry point |
| CaCi Application (the controller) | `src/app/` (planned, A1): takes input, reads graph context, asks the categoriser, shows a preview, and writes only after approval |

The graph store knows nothing about the LLM, and the LLM component knows nothing about storage: only the controller connects them.

Generated JSON Schema for the instruction formats is published under `schema/graph_store/`.

Local-only development tools live under `dev/` and are never published: `dev/graph-explorer/` (built) and `dev/llm-lab/` (planned, T-052).

## 8. Milestones
- **Done:** M0 foundations, M1 contracts, M2 write path and memory adapter, M2b graph lifecycle, M3 conformance suite (see `.gsd/PLAN.md` for the task history).
- **Next, in order:** M4a core reads, then L1 the LLM categoriser core, A1 the controller with preview-then-approve, L2 the real Anthropic client, A1b capture in the explorer.
- **After that:** M4b matching and presets, M5 file adapter, M6 SQLite adapter, M7 export/import and packaging, then picture and voice input and question answering.
- **Principle:** model output is never written without a human preview and approval, and only the operations the guardrails allow can reach the graph.

GSD planning reference: [Bipartite Graph Store library specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md#suggested-gsd-phase-breakdown).

## 9. Open questions
-
