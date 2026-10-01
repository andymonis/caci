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
- Dated decision log lives in `.gsd/STATE.md`.

## 7. Architecture sketch
Reference ./architecture/context.mmd 
Reference ./architecture/container.mmd

## 8. Milestones
- M1:

GSD planning reference: [Bipartite Graph Store library specification](specs/R-001:%20Bipartite%20Graph%20Store%20%E2%80%94%20Library%20Specification.md#suggested-gsd-phase-breakdown).

## 9. Open questions
-
