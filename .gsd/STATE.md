# State

**Milestone:** M1 Contracts
**Current task:** none (next: T-008)
**Last updated:** 2026-10-01

## Position
R-001 (Bipartite Graph Store library) is specified in `specs/` and planned through M3 in PLAN.md. Package scaffolded and verification gate live (`npm run gate`: tsc, eslint, vitest); M0 complete; spec, decisions and architecture docs are in sync. `Result`/`GraphError` types exist (T-005); mutation v1 Zod schema exists (T-006, strict objects, internal until T-013); query v1 Zod schema exists (T-007); parsers and endpoints not yet. M4–M7 are outlined, not yet broken into tasks.

## Decisions
- 2026-10-01 — Schema validator is **Zod** — largest ecosystem, one runtime dep per NFR-03, JSON Schema derivable.
- 2026-10-01 — Toolchain is **npm + Vitest + ESLint (flat config) + `tsc --noEmit`** — gate commands to be written into system_prompt.md in T-003.
- 2026-10-01 — `link` **fails on missing endpoints by default**; `ensureNodes: true` opts in — strict and explicit, as in the spec.
- 2026-10-01 — **Lean v1**: `requestId` accepted in the schema but not implemented (no replay); caller-supplied ids only; strict bipartite, no category hierarchy.
- 2026-10-01 — **TypeScript pinned to `~6.0`** (T-002 had installed 7.0) — `typescript-eslint` peer range is `<6.1.0`; revisit when it supports 7.
- 2026-10-01 — Schemas use **strict objects** (unknown keys rejected) so typos in LLM-written instructions fail loudly; `version` is a literal checked separately for `UNSUPPORTED_VERSION` in T-008.
- 2026-10-01 — Query schema has **no `kind` field** (spec examples omit it); a mutation sent to it fails on unknown keys. `where` keys must be `data.<path>`.
- 2026-10-01 — Build order follows spec: contracts, memory adapter and write, conformance suite, then query, file, SQLite.

## Blockers / open questions
- FR-01 graph lifecycle has no public API home (see PLAN.md Backlog); decide before M2 ends.
- Remaining open question from R-001 spec: expected scale per graph and number of graphs (confirms NFR-05 targets); not blocking until M6.
