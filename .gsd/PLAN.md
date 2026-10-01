# Plan

Format: `- [ ] T-001 (R-xxx) Imperative task title — acceptance: <how we know it's done>`
Tasks must be atomic: one commit, one context window.
Detailed requirement/AC ids (FR-xx, NFR-xx, AC-xx) come from `specs/R-001: Bipartite Graph Store — Library Specification.md`.

## Current milestone: M0 Foundations

## M1 Contracts (spec phase 1; covers FR-15, FR-17, AC-10, AC-14, AC-16, AC-20)

## M2 Write endpoint + memory adapter (spec phase 2; covers AC-03 to AC-06)
- [ ] T-015 (R-001, FR-05/07) Memory adapter: edges and cascade primitives — acceptance: `putEdges`, `deleteEdges`, `edgesOf` with keyset paging; edges lookup works in both directions
- [ ] T-016 (R-001, FR-02, AC-02) Write planner: graph resolution — acceptance: pure function; missing graph without `createIfMissing` gives `GRAPH_NOT_FOUND` and writes nothing; with it, the graph is created
- [ ] T-017 (R-001, FR-03/04, AC-05) `upsertNode` and `deleteNode` ops with cascade — acceptance: `replace` and `merge` modes; deleting a category linked to 3 items leaves no orphan edges (AC-05)
- [ ] T-018 (R-001, FR-05/06, AC-03, AC-06) `link` and `unlink` ops — acceptance: link is idempotent with latest weight winning (AC-06); missing endpoint gives `NODE_NOT_FOUND` unless `ensureNodes: true`; item–item / category–category link gives `VALIDATION_ERROR` with `path` and no adapter call (AC-03)
- [ ] T-019 (R-001, FR-08, AC-04) Atomic multi-op apply in `write` — acceptance: 5-op mutation with failing op 4 leaves store unchanged; storage throws map to `STORAGE_ERROR`, never rethrown

## M3 Conformance suite (spec phase 3; covers AC-15 on memory)
- [ ] T-020 (R-001, NFR-07) `runAdapterConformance(makeAdapter)` harness at `./testing` — acceptance: harness runs under Vitest with fresh adapter per test; memory adapter passes an initial smoke group
- [ ] T-021 (R-001, AC-02..06) Move write-behaviour tests into the suite — acceptance: AC-02 to AC-06 run via the suite against memory; no duplicate adapter-specific copies remain
- [ ] T-022 (R-001, AC-01, AC-12, AC-15) Isolation and adapter-swap tests — acceptance: graph isolation (AC-01) and two-clients-two-adapters (AC-12) pass; README section drafts how a new adapter runs the suite (AC-15)

## Later milestones (plan with `/plan` when M3 is done)
- M4 Query endpoint: seeds, traversal, filters, shapes, keyset cursors, presets (AC-07..09, 13, 17..19, 21, 22)
- M5 File adapter (full conformance, AC-01, AC-02)
- M6 SQLite adapter, push-down, NFR-05 benchmark
- M7 Export/import, packaging, docs, 1.0.0 (AC-11, AC-12)
- From M5 onward, "conformance suite passes on all adapters" is a standing gate item.

## Backlog
- API Extractor only reports the main entry point. Add reports for `./adapters/memory` and `./testing` (AC-16 covers the package's whole public API) once they have real exports, e.g. after T-020.
- When `write`/`query` are implemented (M2/M4): replace the `STORAGE_ERROR` not-implemented stubs, widen `WriteOutput`/`QueryOutput`, re-baseline the API report, and decide how `ParseOptions` (limits) reach the endpoints and `createGraphClient`.
- Placeholder `$id` base URL in `src/graph_store/schema/json-schema.ts` (`https://github.com/andymonis/caci/schema/graph_store`); revisit at packaging (M7).
- M4 decision: whether `return.includeData` defaults to true or false (spec silent; schema leaves it optional with no default).
- Needs decision: FR-01 (create/list/describe/delete graphs) has no home in the public API. `write` is mutations only and `query` is reads only, yet graph lifecycle is only on `adapter.graphs`. Options: graph-level mutation ops plus a graph-list query shape, or expose `createGraph`/`dropGraph`/`listGraphs`/`describeGraph` as extra top-level functions. Decide before M2 ends.
- Consider an operation log (spec "Thoughts"); leave room in the adapter interface, do not build in v1.
- `specs/` file name contains `:` and an em dash, which breaks on Windows and in some tooling; consider renaming to `R-001-bipartite-graph-store.md`.

## Done
- [x] T-001 Fill in spec.md sections 1–5 — purpose, goals, non-goals and R-001 now exist (spec.md rewritten, §4 still to fill, tracked in T-004)
- [x] T-002 (R-001, NFR-01/03) Scaffold TypeScript package — acceptance: `package.json` (ESM, Node >=22, `zod` as the only runtime dep), strict `tsconfig`, `src/index.ts` exporting nothing yet; `npx tsc --noEmit` passes
- [x] T-003 (R-001, NFR-07) Add Vitest, ESLint (flat config) and gate scripts — acceptance: `npm test`, `npm run lint`, `npm run typecheck` all pass on a trivial test; the `TBD` commands in system_prompt.md are replaced with them
- [x] T-004 (R-001) Sync docs with decisions — acceptance: spec.md links resolve to the real file (`specs/R-001: …`), §6 records the decisions in STATE.md, §4 has 2–3 scenarios, and the answered open questions in the R-001 spec are ticked with the chosen answer
- [x] T-005 (R-001, FR-15) Define `Result`, `GraphError` and the closed error-code enum — acceptance: types compile; unit test asserts the six codes (`VALIDATION_ERROR`, `GRAPH_NOT_FOUND`, `NODE_NOT_FOUND`, `CONFLICT`, `UNSUPPORTED_VERSION`, `STORAGE_ERROR`) and `ok`/`err` helpers
- [x] T-006 (R-001, FR-03/05/17) Zod schema for mutation v1 — acceptance: spec's mutation example parses; unknown op, missing field, and `kind: query` are rejected with a `path`; `mode` defaults to `replace`, `ensureNodes` to false
- [x] T-007 (R-001, FR-17/18/19/20, AC-21) Zod schema for query v1 — acceptance: the three spec query examples parse; `depth: 4` is rejected; `where` accepts only `eq, ne, in, contains, startsWith, exists`; defaults `depth` 1, `limit` 50, max 1000
- [x] T-008 (R-001, AC-14, AC-20) Implement `parseMutation` and `parseQuery` — acceptance: return `Result`, never throw on `null`/string/garbage; unknown `version` gives `UNSUPPORTED_VERSION`; a query passed to `parseMutation` (and vice versa) gives `VALIDATION_ERROR`
- [x] T-009 (R-001) Generate JSON Schema from the Zod schemas — acceptance: committed generated files (or build script) for mutation and query; a test validates the spec examples against the JSON Schema with a JSON Schema validator in devDependencies
- [x] T-010 (R-001, NFR-06) Enforce configurable limits in parsing — acceptance: ops per mutation (1,000), `data` size (64 KB) and id length (256) are rejected over the cap and overridable via an options argument
- [x] T-011 (R-001) Define `StorageAdapter` / `AdapterTx` and supporting types (`Page`, `Paged`, `NodeRecord`, `EdgeRecord`, `EdgeKey`, `SetClause`) — acceptance: types compile exactly as in the spec's adapter contract; type-level test confirms a stub adapter satisfies it
- [x] T-012 (R-001, AC-10, AC-14, AC-20) Add `write`, `query` and `createGraphClient` stubs — acceptance: they parse then return `{ ok: false }` "not implemented" (no adapter call); never throw for `null`, string, malformed; wrong-endpoint input gives `VALIDATION_ERROR`; client is frozen
- [x] T-013 (R-001, AC-16, NFR-02) Lock the public API and purity — acceptance: API Extractor report committed and CI/script fails on diff; a lint rule or test fails on module-level mutable state; `package.json` exports map has `.`, `./adapters/memory`, `./testing` entries (adapters may be empty)
- [x] T-014 (R-001, FR-04/08) Memory adapter: graphs and nodes with copy-on-write transactions — acceptance: node CRUD per partition (same id allowed as item and category); a thrown error inside `transaction` leaves state unchanged; two instances share nothing
- [x] T-023 (R-001, architecture) Isolate the graph store under `src/graph_store/` — acceptance: all library code, tests, entry points, generated JSON Schema and tooling paths live under or point at `graph_store`; gate green with the same 120 tests as before; spec and docs describe the layout
