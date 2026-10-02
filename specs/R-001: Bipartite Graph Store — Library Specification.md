# Bipartite Graph Store — Library Specification

Oct 1, 2026 · @Andy

## Overview

A TypeScript library for Node that stores, categorises and retrieves information as a bipartite graph: **items** on one side, **categories** on the other, edges only between them. Callers use two endpoints, write for JSON mutation instructions and query for JSON read queries; the library validates each, translates them into storage operations and returns typed results.

The library holds no state of its own. All state lives in a pluggable storage adapter (in-memory, JSON file, SQLite for local work; others later). Every instruction is scoped to a `graphId`, so one store can hold many isolated graphs, typically one per user.

The design follows a functional-core / imperative-shell shape: pure functions validate and plan, and a thin shell hands the plan to the adapter to execute.

## Goals and non-goals

The goal is one stable, typed entry point that turns JSON instructions into reliable graph reads and writes, against any storage backend, for any number of isolated graphs.

**Goals**

1. Two endpoints with versioned, schema-validated JSON formats: mutation instructions to write, queries to read the whole graph or a subset.
2. Strict bipartite integrity: edges only ever join an item to a category.
3. Multi-graph isolation by `graphId`; no read or write ever crosses graphs.
4. Storage-agnostic core behind a small adapter interface, with file and SQLite adapters for local development.
5. Stateless, functional behaviour: same instruction plus same store contents gives the same result; no module-level mutable state.
6. A stable public API under semver, safe to import from other packages.

**Non-goals (v1)**

- Authentication or authorisation. `graphId` is a namespace, not a security boundary; the host app decides who may use which graph.
- Full-text or vector search over item content.
- A general graph query language (Cypher, Gremlin). Queries are a fixed, typed set.
- Category-to-category or item-to-item edges (see open questions).
- A network server. This is an in-process library only.

## Core concepts

Four nouns cover the whole model: graph, item, category, edge. A pure core sits between the caller and a swappable storage adapter.

&#91;embedded content: architecture and data model · core, adapter, per-user graphs\]

The caller never touches storage directly, and the core never keeps anything between calls. Each `graphId` is a sealed namespace inside the store.

- **Graph**: a namespace keyed by `graphId`, typically one per user. Nothing crosses graphs. A `graphId` is 1 to 128 characters: lowercase letters, digits, `_` or `-`, starting with a letter or digit. Backends use it as a file name or key, so it is deliberately plain (no separators, dots, spaces, non-ASCII or upper case). Node ids stay opaque.
- **Item**: a unit of stored information (note, document, record), with an id and an opaque JSON `data` payload.
- **Category**: a label or concept items are filed under, with an id and optional `data`.
- **Edge**: an item-to-category link with optional `weight` and `data`. Never item-item or category-category.

## Functional requirements

Requirements are numbered so ACs and GSD tasks can trace back to them.

| ID | Area | Requirement |
| --- | --- | --- |
| FR-01 | Graphs | Create, list, describe and delete graphs, through four top-level functions (`createGraph`, `listGraphs`, `describeGraph`, `dropGraph`) beside the two endpoints. Deleting a graph removes all its nodes and edges. |
| FR-02 | Graphs | Every instruction and query names exactly one `graphId` (see Core concepts for the allowed characters). Mutations against a missing graph fail unless `createIfMissing: true`. |
| FR-03 | Nodes | Upsert and delete items and categories. Each node has a caller-supplied string `id`, a `partition` (`item` or `category`) and an optional JSON `data` payload. |
| FR-04 | Nodes | Node ids are unique per partition per graph. The same id may exist as an item and a category without conflict. |
| FR-05 | Edges | Link and unlink an item to a category, with optional numeric `weight` and JSON `data`. Linking is idempotent. |
| FR-06 | Edges | An edge whose ends are not one item and one category is rejected at validation, before any storage call. |
| FR-07 | Edges | Deleting a node removes its edges in the same transaction. No dangling edges, ever. |
| FR-08 | Writes | All ops in one mutation apply atomically: all succeed or none persist. |
| FR-09 | Reads | Get node(s) by id; list nodes in a partition with pagination. |
| FR-10 | Reads | Categories of an item; items in a category. |
| FR-11 | Reads | Items matching a set of categories with `all` (AND), `any` (OR) and `none` (NOT) clauses. |
| FR-12 | Reads | Related items: items sharing categories with a given item, ranked by shared-category count or summed weight. |
| FR-13 | Reads | Category co-occurrence: categories that appear alongside a given category, with counts. |
| FR-14 | Reads | All list results paginate with an opaque keyset cursor and a `limit` (default 50, max 1000). Ordering is deterministic. |
| FR-15 | Results | Both endpoints return a typed `Result` (ok or error); neither throws for invalid input or storage failures. |
| FR-16 | Export | Export a whole graph as JSON and import it back, round-trip identical. Doubles as a migration path between adapters. |
| FR-17 | Endpoints | Two endpoints: `write` accepts mutations only, `query` accepts queries only. Each rejects the other's format with `VALIDATION_ERROR`. |
| FR-18 | Reads | A query returns the whole graph or a subgraph grown from seeds (`ids`, a `data` match, or `all`) to a traversal depth of 0 to 3. |
| FR-19 | Reads | A query can filter reached nodes by partition, category set clauses, and `data` fields using a closed operator set. |
| FR-20 | Reads | A query returns one of four shapes: `subgraph`, `nodes`, `ids`, `count`. A `subgraph` contains only edges with both ends in the result. |
| FR-21 | Reads | The query endpoint is read-only; no query can change the store. |

## Write endpoint: mutation instructions

The write endpoint accepts one envelope kind, a **mutation**: an ordered list of ops applied atomically. Reads go through the separate query endpoint (next section). Both carry a schema `version` so formats can evolve without breaking callers, and both return the same result envelope.

Mutation example:

```json
{
  "version": 1,
  "kind": "mutation",
  "graphId": "user_42",
  "requestId": "b7c1-...",
  "createIfMissing": true,
  "ops": [
    { "op": "upsertNode", "partition": "item", "id": "note-1", "data": { "title": "Q3 plan" } },
    { "op": "upsertNode", "partition": "category", "id": "planning" },
    { "op": "link", "item": "note-1", "category": "planning", "weight": 0.8 },
    { "op": "unlink", "item": "note-1", "category": "drafts" },
    { "op": "deleteNode", "partition": "item", "id": "note-0" }
  ]
}
```

Result envelope:

```json
{ "ok": true, "value": { "items": [], "nextCursor": null } }
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "path": ["ops", 2, "category"] } }
```

Format rules:

- `upsertNode` merges or replaces `data` according to a `mode` field (`replace` default, `merge` shallow). Pick one default and never change it within a major version.
- `link` auto-creating missing endpoints is opt-in per op (`ensureNodes: true`); otherwise a missing endpoint fails the whole instruction.
- Error codes are a closed, documented enum: `VALIDATION_ERROR`, `GRAPH_NOT_FOUND`, `NODE_NOT_FOUND`, `CONFLICT`, `UNSUPPORTED_VERSION`, `STORAGE_ERROR`.
- `requestId` is optional; when present, adapters that support it make replays of the same mutation a no-op.
- The library publishes the schema as both TypeScript types and JSON Schema, generated from one source (e.g. Zod or TypeBox).

## Read endpoint: JSON queries

The query endpoint takes one JSON query and returns the whole graph or a subset of it, never changing the store. Every query has the same four parts: where to start (`from`), how far to walk (`traverse`), what to keep (`filter`), and what shape to return (`return`).

All references to doctor X, where doctor X is a category:

```json
{
  "version": 1,
  "graphId": "user_42",
  "from": { "partition": "category", "ids": ["doctor-x"] },
  "traverse": { "depth": 1 },
  "return": { "shape": "subgraph", "includeData": true },
  "page": { "limit": 100, "cursor": null }
}
```

The same, when doctor X is only known by a field in `data`, narrowed to appointments:

```json
{
  "version": 1,
  "graphId": "user_42",
  "from": { "partition": "category", "where": { "data.name": { "eq": "Dr X" } } },
  "traverse": { "depth": 1 },
  "filter": { "partition": "item", "where": { "data.type": { "eq": "appointment" } } },
  "return": { "shape": "nodes" }
}
```

The whole graph:

```json
{ "version": 1, "graphId": "user_42", "from": { "all": true }, "return": { "shape": "subgraph" } }
```

Result for a `subgraph` shape:

```json
{
  "ok": true,
  "value": {
    "nodes": [{ "partition": "category", "id": "doctor-x", "data": {} }, { "partition": "item", "id": "visit-17", "data": {} }],
    "edges": [{ "item": "visit-17", "category": "doctor-x", "weight": 1 }],
    "nextCursor": null,
    "truncated": false
  }
}
```

| Part | Options | Notes |
| --- | --- | --- |
| `from` | `all`; `ids` in a partition; `where` match on `data` in a partition | Seeds the result. `all` means the whole graph and ignores `traverse`. |
| `traverse` | `depth` 0 to 3 (default 1) | Walks edges from the seeds. In a bipartite graph each hop flips partition, and the result holds everything within `depth` hops (the seeds included). From a category: depth 1 adds its items, depth 2 adds the other categories those items belong to, depth 3 adds the items of those categories. From an item: depth 1 adds its categories and depth 2 adds the items that share a category with it, which is the basis of "related items". Each node appears once however many paths reach it. |
| `filter` | `partition`, `where`, and set clauses `all` / `any` / `none` over category ids | Applied to reached nodes. Seeds are always kept unless `excludeSeeds: true`. |
| `return` | `subgraph` (nodes + edges), `nodes`, `ids`, `count`; `includeData` | `subgraph` returns only edges whose both ends are in the result. |
| `page` | `limit` (default 50, max 1000), `cursor` | Keyset cursor; `truncated: true` when a size cap cut the result. |

Rules:

- `where` uses a closed operator set: `eq`, `ne`, `in`, `contains`, `startsWith`, `exists`, on dotted paths into `data`.
- The query endpoint runs in a read-only transaction; a query can never write, and a mutation sent here is rejected.
- The named queries in the requirements (items by categories, related items, co-occurrence) ship as typed presets that compile into this one format, so there is a single execution path to test.
- Matching on `data` scans in the core by default; adapters that can (SQLite via `json_extract`) push it down. Indexed fields per graph are a later option.

### Query results

A query returns one of four result shapes, told apart by their keys. All are wrapped in the usual `{ ok: true, value }` envelope.

| `return.shape` | `value` | Notes |
| --- | --- | --- |
| `nodes` | `{ nodes, nextCursor, truncated }` | Each node is `{ partition, id }`, plus `data` when `includeData` is true. |
| `ids` | `{ ids, nextCursor, truncated }` | Each entry is `{ partition, id }`. Never carries data. |
| `count` | `{ count, truncated }` | Not paged. When `truncated` is true the count is a lower bound. |
| `subgraph` | `{ nodes, edges, nextCursor, truncated }` | The `nodes` shape plus edges. Each edge is `{ item, category, weight }`, plus `data` when `includeData` is true. |

Rules:

- **One fixed order.** Every result lists nodes with all items first, then all categories, and within each partition by id in UTF-16 code-unit order. One order means one cursor works for any shape, and the same query on the same store gives the same answer (NFR-04).
- **Paging.** `page.limit` counts nodes. A cursor means "continue after this node in that order", so adding or removing nodes between pages never skips or repeats one. The last page has `nextCursor: null`, including when it exactly fills the limit.
- **Edges in a `subgraph`.** An edge appears exactly once across all pages, on the page that holds its item end, and only if its category end is somewhere in the whole result (an edge is never returned to a node outside the result). A page therefore holds at most `limit` nodes but can carry more than `limit` edges, because an item's edges are never split across pages. A consumer merges pages to get the whole subgraph.
- **`truncated`.** True when a cap on how many nodes a query may reach (default 10,000) cut the result short, so more matched than was returned. It is about size caps, not paging.
- **`includeData` defaults to false.** Without it, nodes and edges carry no `data`. The first example above sets it to true explicitly. (Provisional: see the decision log.)
- **`weight` is always reported.** An edge stored without a weight reports 1, as in the example result above, so consumers never have to handle a missing weight. Ranking queries treat a missing weight as 1 as well.
- **Cursors are opaque and tied to their query.** A cursor works only with the query that produced it, whatever its `page.limit`: change the graph, seeds, traversal, filter or `return` and it is refused with `VALIDATION_ERROR` and a path to `page.cursor`, as is a cursor that is corrupted, edited or not a cursor at all. Callers must not build or read cursors.

## Public API surface

Keep the surface tiny: two endpoint functions (write and query) for graph data, four graph-lifecycle functions (FR-01), their parsers, typed builders, and the adapter interface. Everything else is internal.

```ts
// Endpoint 1: writes. Accepts mutation instructions only.
export function write(
  adapter: StorageAdapter,
  instruction: unknown,
): Promise<Result<WriteOutput, GraphError>>;

// Endpoint 2: reads. Accepts queries only; read-only transaction.
export function query(
  adapter: StorageAdapter,
  query: unknown,
): Promise<Result<QueryOutput, GraphError>>;

// Validation only, no I/O. Useful at API boundaries.
export function parseMutation(input: unknown): Result<Mutation, GraphError>;
export function parseQuery(input: unknown): Result<Query, GraphError>;

// Graph lifecycle (FR-01). write and query carry graph data only, so graphs are managed here.
// All return a Result and never throw; graphId is validated like any other id.
export function createGraph(adapter: StorageAdapter, graphId: string): Promise<Result<{ graphId: string }, GraphError>>; // CONFLICT if it exists
export function dropGraph(adapter: StorageAdapter, graphId: string): Promise<Result<{ graphId: string }, GraphError>>; // GRAPH_NOT_FOUND if missing; removes all nodes and edges
export function listGraphs(adapter: StorageAdapter, page?: { limit?: number; cursor?: string | null }): Promise<Result<Paged<string>, GraphError>>; // keyset paging, default 50, max 1000
export function describeGraph(adapter: StorageAdapter, graphId: string): Promise<Result<GraphInfo, GraphError>>; // GRAPH_NOT_FOUND if missing
// GraphInfo = { graphId: string; itemCount: number; categoryCount: number; edgeCount: number }

// Optional convenience: binds an adapter, returns a frozen { write, query, createGraph, dropGraph, listGraphs, describeGraph }.
export function createGraphClient(adapter: StorageAdapter): GraphClient;

// Typed builders so callers need not hand-write JSON.
export const op: { upsertNode; deleteNode; link; unlink };
export const q: { from; all; references; itemsByCategories; relatedItems; coOccurrence };
// e.g. q.references({ partition: 'category', id: 'doctor-x' }) builds the doctor X query

// Adapters ship as separate entry points so core has no driver dependencies.
// 'bipartite-graph/adapters/memory' | '/file' | '/sqlite'

// Conformance suite for anyone writing an adapter. The caller passes their test runner's
// describe and it (Vitest, Jest and node:test all fit), so the library depends on none of them.
// 'bipartite-graph/testing' -> runAdapterConformance(makeAdapter, { describe, it }, { dispose? })
```

Stability rules:

- Only symbols exported from the package entry points are public. Lock the surface with API Extractor (or similar) so any change shows in review.
- Instruction `version` and package major version move independently; a new instruction version can be added in a minor release, removing one needs a major.
- `createGraphClient` holds only the adapter reference, set once at creation. It caches nothing, so it stays stateless in the sense that matters.

## Storage adapter contract

The adapter is a small set of primitives; all graph logic (validation, bipartite rules, cascade, query planning) stays in the core. That keeps adapters cheap to write and behaviour identical across backends.

```ts
export interface StorageAdapter {
  readonly name: string;
  readonly capabilities: { transactions: boolean; idempotency: boolean; nativeSetQueries: boolean };

  transaction<T>(graphId: GraphId, fn: (tx: AdapterTx) => Promise<T>): Promise<T>;

  graphs: {
    create(id: GraphId): Promise<void>;
    exists(id: GraphId): Promise<boolean>;
    list(page: Page): Promise<Paged<GraphId>>;
    drop(id: GraphId): Promise<void>;
  };
}

export interface AdapterTx {
  getNodes(p: Partition, ids: string[]): Promise<NodeRecord[]>;
  putNodes(nodes: NodeRecord[]): Promise<void>;
  deleteNodes(p: Partition, ids: string[]): Promise<void>;
  putEdges(edges: EdgeRecord[]): Promise<void>;
  deleteEdges(keys: EdgeKey[]): Promise<void>;
  edgesOf(p: Partition, id: string, page: Page): Promise<Paged<EdgeRecord>>;
  listNodes(p: Partition, page: Page): Promise<Paged<NodeRecord>>;
  // Optional fast path when capabilities.nativeSetQueries is true
  itemsByCategories?(clause: SetClause, page: Page): Promise<Paged<NodeRecord>>;
}
```

Adapter expectations:

| Adapter | Purpose | Notes |
| --- | --- | --- |
| Memory | Unit tests, reference implementation | Copy-on-write maps; transaction = swap on commit. |
| File (JSON) | Zero-dependency local dev | One file per graph; write to temp then atomic rename; single-writer lock per graph. Fine to a few thousand nodes. |
| SQLite | Realistic local dev, small deployments | Tables `graphs`, `nodes`, `edges` with composite keys led by `graph_id`; indexes on both edge directions; native set queries via SQL. Driver: `better-sqlite3` or `node:sqlite`. |

The core must not import any adapter. Adapters depend on the core's types, never the other way round.

## Code layout and test map

All graph store functionality is isolated under `src/graph_store/`. Nothing in that folder imports from elsewhere in the repo, and the package entry points (`bipartite-graph`, `/adapters/memory`, `/testing`) are built from it into `dist/graph_store/`. Generated JSON Schema is published under `schema/graph_store/`.

```
src/graph_store/
  index.ts            public entry point (the only module the API report reads)
  result.ts           Result, GraphError, error codes
  types.ts            public Mutation / Query / Op types (kept in sync with the schemas by a test)
  schema/             Zod schemas for mutation and query v1, JSON Schema generation
  parse.ts, limits.ts parseMutation / parseQuery, configurable limits
  query-order.ts, query-cursor.ts  the fixed result order and the cursors that page it
  query-plan.ts       pure planner: a parsed query becomes the plan the executor runs
  query-exec.ts       read-only executor (a handle with no write methods): seeds, breadth-first traversal, paging; and its transaction shell
  endpoints.ts        write, query, createGraphClient
  write-plan.ts       pure write planning (graph resolution) and its I/O shell
  apply-mutation.ts   runs a whole mutation atomically inside one adapter transaction
  graphs.ts           graph lifecycle: createGraph, dropGraph, listGraphs, describeGraph
  node-ops.ts         upsertNode / deleteNode: pure planning plus transactional shell
  link-ops.ts         link / unlink: pure planning plus transactional shell
  adapter.ts          StorageAdapter / AdapterTx contract
  adapters/memory/    memory adapter (M2)
  testing/            runAdapterConformance (M3): harness, case groups (smoke, write, isolation, lifecycle, primitives), types
```

Test map as of T-034 (each test file sits next to the module it covers). Update this table when tasks land.

| Test file | Covers |
| --- | --- |
| `result.test.ts` | FR-15 (closed error-code enum, `Result` helpers) |
| `schema/mutation.test.ts` | FR-03, FR-05, FR-17: mutation v1 format, defaults, strictness |
| `schema/query.test.ts` | FR-17 to FR-20, AC-21 at schema level: query v1 format, depth cap, operator set |
| `schema/json-schema.test.ts` | Published JSON Schema accepts the spec examples, rejects bad input, and matches the committed files |
| `parse.test.ts` | AC-10, AC-14, AC-20 at parser level |
| `limits.test.ts` | NFR-06: ops, id length and data size caps, overridable |
| `endpoints.test.ts` | AC-10, AC-14, AC-20 at endpoint level; adapter never touched on invalid input; frozen client exposing `write`, `query` and the four graph functions, a full lifecycle through it, clients on different adapters kept apart (AC-12 groundwork); `query` still a stub |
| `adapter.test.ts` | Adapter contract shape (type-level) |
| `types.test.ts` | Public types stay identical to the Zod-inferred types |
| `purity.test.ts` | NFR-02: lint rule against module-level mutable state |
| `adapters/memory/memory-adapter.test.ts` | Only what is specific to the memory adapter: its declared capabilities, a finished transaction handle being unusable, its page-limit check, code-unit id ordering, opaque cursors. Everything every adapter must do is in the shared suite. |
| `write-plan.test.ts` | FR-02, AC-02: pure graph-resolution plan, plus the shell against a spied adapter (nothing written on `GRAPH_NOT_FOUND`, `STORAGE_ERROR` instead of throwing) |
| `node-ops.test.ts` | FR-03, FR-04, FR-07, AC-05: `upsertNode` replace and shallow merge, `deleteNode` with cascade (including multi-page edge lists and id collisions across partitions) |
| `link-ops.test.ts` | FR-05, FR-06, AC-03, AC-06: `link` and `unlink` (idempotent, `ensureNodes`, `NODE_NOT_FOUND`, weight 0), and proof that item–item or category–category edges cannot pass validation |
| `apply-mutation.test.ts` | FR-02, FR-08, AC-02, AC-03 (end to end), AC-04, AC-05, AC-06: `write()` against the memory adapter, including all-or-nothing rollback, removing a graph a failed call created, and validation failures never reaching the adapter |
| `query-traverse.test.ts` | FR-18, AC-17, AC-21: breadth-first walks to depth 3 from categories and items (cumulative, each node once, cycles safe), several seeds, missing seeds ignored, `excludeSeeds`, the partition filter, dangling edges skipped, paging a walked result, graph isolation, and the reached-node cap (including not reading a huge hub to the end) |
| `query-exec.test.ts` | FR-09, FR-14, FR-18, FR-20, FR-21, AC-09, AC-13, AC-22: the executor for seeds without traversal: `from: all` and named seeds at depth 0, the partition filter, `nodes`/`ids`/`count`, `includeData`, 120 matches over 3 pages and paging stable under inserts and deletes, the reached-node cap, a store identical after every query, isolation between graphs, and refusal (by name) of what is not built yet |
| `query-plan.test.ts` | FR-17, FR-18, FR-19 groundwork: the planner turns each of the spec's query examples into a plan; seeds are de-duplicated and ordered; `all` ignores traverse; `where` matching and the set clauses are refused by name instead of ignored; a cursor on a count is refused; the plan is pure |
| `query-order.test.ts`, `query-cursor.test.ts` | FR-14, NFR-04: the fixed result order, and query cursors (round trip, bound to their query, corrupted, edited, foreign and garbage cursors all refused, never throwing) |
| `graphs.test.ts` | FR-01 (create and drop), AC-01 groundwork: graph id validation against the restricted character set (also tested in both schemas, the published JSON Schema and at the endpoints), `CONFLICT` and `GRAPH_NOT_FOUND`, drop removes everything and leaves other graphs intact, validation never reaches the adapter |
| `graph-info.test.ts` | FR-01 (list and describe), FR-14, AC-09 groundwork: `listGraphs` keyset paging (120 graphs over 3 pages), page validation, `describeGraph` counts across page boundaries and after cascade deletes |
| `testing/conformance.test.ts` | Runs the shared conformance suite against the memory adapter through Vitest. The suite holds **AC-02 to AC-06** (`write`), **AC-01 and AC-12** (`isolation`), **FR-01** (`lifecycle`: create, drop, list, describe, id rules) and **FR-02 to FR-08, FR-14** (`primitives`: the storage contract the core relies on, namely node and edge round trips, replace-on-write, no aliasing, atomic and serialised transactions, cascade from primitives, keyset paging) plus a smoke group; also tests the harness itself and that twenty-nine deliberately broken adapters are caught, each by the case that targets its bug |
| `testing/alternative-adapter.test.ts` | **AC-15**: an independently written adapter (snapshot and restore, its own cursor format) passes the same suite and works end to end through the client, with no core changes |
| `smoke.test.ts` | Package entry point loads |
| `npm run api:check` (not a test file) | AC-16: API report diff fails the gate |

Not yet covered (arrive with later milestones): AC-07 to AC-09, AC-11, AC-13, AC-17 to AC-19, AC-22, and the behaviour behind FR-09 to FR-13, FR-16 and FR-18 to FR-21 (FR-14 paging is covered for graphs, nodes and edges). AC-01 to AC-06, AC-12 and the FR-01 graph lifecycle now live in the shared conformance suite, so every future adapter has to pass them; AC-15 is shown by an independent fixture adapter. They run against the memory adapter and that fixture only until the file and SQLite adapters exist.

## Non-functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-01 | Platform | Node LTS (22+), TypeScript `strict`, ESM-first with CJS build if consumers need it. |
| NFR-02 | Purity | No module-level mutable state; no singletons; no global config. Lint rule or test enforces it. |
| NFR-03 | Dependencies | Core: one runtime dependency at most (the schema validator). Drivers live only in adapter entry points. |
| NFR-04 | Determinism | Same instruction on same store contents returns byte-identical results, including ordering and cursors. |
| NFR-05 | Performance | SQLite adapter, 10k items, 1k categories, 100k edges: single-category lookup under 20 ms, three-clause set query under 100 ms (p95, dev laptop). Treat as a baseline to measure, not a hard promise. |
| NFR-06 | Limits | Configurable caps: ops per mutation (default 1,000), `data` payload size (default 64 KB), node id length (default 256 chars; graph ids are fixed at 1 to 128 characters of a restricted set), nodes one query may reach (default 10,000, after which the result is marked `truncated`). |
| NFR-07 | Quality | 90%+ line coverage on core; every adapter passes the conformance suite in CI. |
| NFR-08 | Docs | Generated API reference, a README quick start, and an adapter-authoring guide. |
| NFR-09 | Observability | Optional `logger` / hook injected via the client, never global. Off by default. |

## Acceptance criteria

Each AC is testable and maps to the requirement it proves. Unless stated, every AC must pass on all three adapters via the conformance suite.

| ID | Traces to | Given / When / Then |
| --- | --- | --- |
| AC-01 | FR-02 | Given graphs `A` and `B` with identical node ids, when items are linked in `A`, then no query on `B` returns them. |
| AC-02 | FR-02 | Given no graph `C`, when a mutation targets `C` without `createIfMissing`, then the result is `GRAPH_NOT_FOUND` and nothing is written. |
| AC-03 | FR-06 | When a `link` op names two items or two categories, then the result is `VALIDATION_ERROR` with a `path` to the op, and the adapter is never called. |
| AC-04 | FR-08 | Given a mutation of 5 ops where op 4 fails, then the store is unchanged after the call. |
| AC-05 | FR-07 | Given a category linked to 3 items, when it is deleted, then each item's category list no longer contains it and no orphan edge exists in storage. |
| AC-06 | FR-05 | When the same `link` is sent twice, then exactly one edge exists and its weight equals the latest value. |
| AC-07 | FR-11 | Given items tagged {a,b}, {a}, {b,c}, when querying `all:[a] none:[b]`, then only the item tagged {a} returns. |
| AC-08 | FR-12 | Given item X sharing 2 categories with Y and 1 with Z, when querying related items for X, then Y ranks above Z and X is excluded. |
| AC-09 | FR-14 | Given 120 matches and `limit: 50`, when paging with returned cursors, then exactly 120 unique items return across 3 pages, in stable order. |
| AC-10 | FR-15 | When `write` or `query` receives `null`, a string, or a malformed object, then it returns `{ ok: false }` and never throws. |
| AC-11 | FR-16 | Given a graph exported from the file adapter, when imported into SQLite and exported again, then both exports are deep-equal. |
| AC-12 | NFR-02 | When two clients with different adapters run in one process, then neither sees the other's data or configuration. |
| AC-13 | NFR-04 | When the same query runs twice on an unchanged store, then results are deep-equal. |
| AC-14 | Version | When a mutation or query has an unknown `version`, then the result is `UNSUPPORTED_VERSION`. |
| AC-15 | Adapter | A new adapter that passes `runAdapterConformance` needs no core changes to work end to end. |
| AC-16 | API | The package's public API report is committed; CI fails if it changes without an explicit update. |
| AC-17 | FR-18 | Given category `doctor-x` linked to 4 items and other unrelated nodes, when querying from `doctor-x` at depth 1 as a subgraph, then exactly `doctor-x`, its 4 items and 4 edges return. |
| AC-18 | FR-19 | Given doctor X stored only as `data.name: "Dr X"`, when the query seeds with that `where` match and filters items to `data.type: appointment`, then only doctor X's appointments return. |
| AC-19 | FR-18 | When querying `from: { all: true }` with paging, then every node and edge in the graph returns exactly once across pages, and none from other graphs. |
| AC-20 | FR-17 | When a mutation is sent to `query`, or a query to `write`, then the result is `VALIDATION_ERROR` and the store is unchanged. |
| AC-21 | FR-18 | When `traverse.depth` is above 3, then the result is `VALIDATION_ERROR` and the adapter is never called. |
| AC-22 | FR-21 | Given a store snapshot, when any valid query runs, then the store is byte-identical afterwards. |

## Thoughts, risks and open questions

**"Stateless" needs a precise definition.** The library is stateless; the system is not. Write it down as: no state survives between calls except in the adapter. That makes the purity rule testable (AC-12) and stops scope arguments later.

**Keep the adapter dumb.** The biggest long-term risk is behaviour drifting between backends. Putting all rules in the core and shipping a conformance suite is what makes "switchable storage" true rather than aspirational. Build the memory adapter and the suite before the file or SQLite adapters.

**Set queries are the performance hotspot.** A naive core implementation of AND/OR/NOT pulls edge lists into memory. That is fine for the file adapter and fatal at scale; hence the optional `nativeSetQueries` fast path. Ship the naive version first, prove correctness, then add the SQL path behind the same tests.

**File adapter concurrency.** Two Node processes writing the same JSON file will corrupt it. Either document single-process use, or use a lockfile. Do not let it quietly become a production backend.

**Pagination over a changing set.** Offset cursors skip or repeat rows when data changes between pages. Use keyset cursors (last seen id) for deterministic paging.

**Consider an operation log.** Since every write is already a JSON instruction, optionally persisting them gives replay, audit and easy migration between adapters almost for free. Worth leaving room for in the adapter interface, not building in v1.

Open questions:

- [x] Strict bipartite, or will categories ever need hierarchy (parent/child)? Hierarchy breaks the bipartite rule and changes the schema. **Decided 2026-10-01: strict bipartite, no hierarchy in v1.**
- [x] Caller-supplied ids only, or should the library generate ids when none are given? **Decided 2026-10-01: caller-supplied only in v1.**
- [x] Should a `link` auto-create missing nodes by default, or fail by default (current spec)? **Decided 2026-10-01: fail by default; `ensureNodes: true` opts in.**
- [x] Does `data` need indexing or filtering in queries, or is it opaque payload? **Resolved by the query design: `data` is filterable via `where` (scan in core, push-down where adapters can); per-graph indexes are a later option.**
- [x] Is `requestId` idempotency needed in v1, or can it wait? **Decided 2026-10-01: waits. The field is accepted in the schema but no adapter implements replay in v1.**
- [ ] Expected scale per graph and number of graphs, to confirm NFR-05 targets.

## Suggested GSD phase breakdown

Seven phases, each small enough for one GSD milestone and each ending in green tests. Order matters: contracts and the conformance suite come before any real backend.

1. **Contracts.** Mutation and query schemas (v1), result and error types, adapter interface, `write` / `query` stubs, API Extractor baseline. Exit: types compile, schemas validate the examples above. Covers FR-15, FR-17, AC-10, AC-14, AC-16, AC-20.
2. **Write endpoint + memory adapter.** `parseMutation`, `write`, bipartite and cascade rules, atomic transactions. Exit: AC-03 to AC-06.
3. **Conformance suite.** Extract every behaviour test into `runAdapterConformance`; memory adapter passes. Exit: AC-15 on memory.
4. **Query endpoint.** `parseQuery`, `query`: seeds, traversal, filters, return shapes, keyset cursors, then the named presets compiled onto it. Exit: AC-07 to AC-09, AC-13, AC-17 to AC-19, AC-21, AC-22.
5. **File adapter.** Per-graph JSON files, atomic rename, lock. Exit: full conformance pass, AC-01, AC-02.
6. **SQLite adapter.** Schema, indexes, native set-query and `data` match push-down, benchmark harness for NFR-05. Exit: full conformance pass, benchmark report.
7. **Export/import, packaging, docs.** FR-16, adapter entry points, README, adapter guide, release 1.0.0. Exit: AC-11, AC-12.

Tip for GSD: put the FR/AC tables from this doc into the project's requirements file so each plan can cite IDs, and make "conformance suite passes on all adapters" a standing verification step from phase 5 onward.
