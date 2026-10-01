# State

**Milestone:** M0 Foundations
**Current task:** none (next: T-003)
**Last updated:** 2026-10-01

## Position
R-001 (Bipartite Graph Store library) is specified in `specs/` and planned through M3 in PLAN.md. Package scaffolded (T-002: ESM, strict tsc, zod); no library code yet. M4–M7 are outlined, not yet broken into tasks.

## Decisions
- 2026-10-01 — Schema validator is **Zod** — largest ecosystem, one runtime dep per NFR-03, JSON Schema derivable.
- 2026-10-01 — Toolchain is **npm + Vitest + ESLint (flat config) + `tsc --noEmit`** — gate commands to be written into system_prompt.md in T-003.
- 2026-10-01 — `link` **fails on missing endpoints by default**; `ensureNodes: true` opts in — strict and explicit, as in the spec.
- 2026-10-01 — **Lean v1**: `requestId` accepted in the schema but not implemented (no replay); caller-supplied ids only; strict bipartite, no category hierarchy.
- 2026-10-01 — Build order follows spec: contracts, memory adapter and write, conformance suite, then query, file, SQLite.

## Blockers / open questions
- FR-01 graph lifecycle has no public API home (see PLAN.md Backlog); decide before M2 ends.
- Remaining open question from R-001 spec: expected scale per graph and number of graphs (confirms NFR-05 targets); not blocking until M6.
- Verification gate commands are still `TBD` in system_prompt.md until T-003.
