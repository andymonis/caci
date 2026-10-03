# caci

A blank, AI-native project scaffold for solo development with Claude Code.

It combines two ideas:

- **Spec Kit-style alignment:** write down the rules (Constitution) and the intent (Spec) before any code.
- **GSD-style execution:** a tight loop of small tasks, each verified and committed on its own.

> Status: M0 to M2 and the graph lifecycle API are complete: schemas, parsers, limits, the adapter contract, a memory adapter, an atomic `write`, and `createGraph` / `dropGraph` / `listGraphs` / `describeGraph`. `query` is still a stub until M4, and the shared adapter conformance suite (M3) is next. Stack: TypeScript, Zod, Vitest, ESLint.

## Project layout

```
system_prompt.md        Constitution: how the agent works here (rules, loop, gate, git, boundaries)
spec.md                 Core Spec: what we're building and why
specs/                  Detailed specs (R-001: Bipartite Graph Store library)
architecture/           C4 context and container diagrams (Mermaid)
CLAUDE.md               Loads system_prompt.md and .gsd/STATE.md into every Claude Code session
.gsd/
  PLAN.md               Atomic task queue: milestones, Backlog, Done
  STATE.md              Current position, decisions, blockers
.claude/commands/       Slash commands that drive the loop: /plan /next /verify /ship
src/graph_store/        The Bipartite Graph Store, isolated as one feature (code, tests, adapters)
src/llm/                The LLM component: a model port, typed errors and token usage, and one folder per capability
src/app/                The application layer (controller): input types, input normalising, item id minting
schema/graph_store/     Generated JSON Schema for the mutation and query formats
api/                    Committed public API report (API Extractor)
dev/graph-explorer/     Local-only visual tester for the graph store (never published)
```

### Where the code lives

All graph store functionality sits under `src/graph_store/`, with each test file beside the module it covers. Nothing in that folder imports from elsewhere in the repo. Other platform components get their own sibling folders under `src/`; the first is `src/llm/`, the LLM component. The graph store never imports it, and it reaches the graph store only through its public entry point. `src/app/` is the third sibling: it uses the other two only through their public entry points, and neither knows it exists (`src/boundary.test.ts` enforces all of this). The folder-by-folder breakdown and the test map are in the R-001 spec ("Code layout and test map").

### Order of authority

If files disagree, the higher one wins:

1. `system_prompt.md`
2. `spec.md`
3. `.gsd/STATE.md`
4. `.gsd/PLAN.md`

## The three pieces

### 1. The Constitution (`system_prompt.md`)
Non-negotiable rules for any agent working in the repo: spec first, small steps, simplest thing that works, verify before claiming done, be honest about failures. It also defines the verification gate, the commit convention, and what needs your approval first (new dependencies, deleting files, changing spec goals, anything outward-facing). Agents don't edit it unless asked.

### 2. The Core Spec (`spec.md`)
Sections for purpose, goals, non-goals, users, requirements, constraints, architecture, milestones and open questions. Requirements get ids (`R-001`) and a testable acceptance criterion, so tasks can trace back to them.

### 3. The GSD execution loop
Orient, plan, do, verify, ship, repeat.

| Command | What it does |
|---|---|
| `/plan [section]` | Breaks a spec section into atomic tasks in `PLAN.md`. Asks questions if the spec is vague. Doesn't implement. |
| `/next [task]` | Takes the first unchecked task (or the one you name) and implements only that. Stray ideas go to the Backlog. |
| `/verify` | Runs tests, lint, typecheck and the task's acceptance check. Fixes within scope until green and reports results honestly. |
| `/ship` | Checks off the task, updates `STATE.md`, and makes one conventional commit referencing the task id. Never pushes. |

Task format in `PLAN.md`:

```
- [ ] T-003 (R-002) Add config parser — acceptance: parses sample file, rejects invalid input
```

## Getting started

1. Open the repo in Claude Code from the project root.
2. Read `.gsd/STATE.md` and `.gsd/PLAN.md` to see where the project is.
3. Run `npm install`, then `npm run gate` (typecheck, lint, tests, API check) to confirm a clean start.
4. Run `/plan` when a milestone needs breaking into tasks.
5. Loop: `/next`, then `/verify`, then `/ship`, until the milestone is done.

## Seeing the graph

`npm run dev:explorer` starts a local-only page (http://127.0.0.1:4317) that draws a graph and animates it as entries are added and removed, with scenarios, a log of every request and result, and one-click examples of what the library rejects. It lives in `dev/graph-explorer/` and is never part of a release. See its README.

## Choosing models for the LLM component

Which model does a job is configuration. `src/llm/` has three tiers, `fast` (Haiku 4.5), `balanced` (Sonnet 5.5) and `deep` (Opus 5.5), and routes each capability to a tier or to one exact model id. Categorising starts on `fast`; heavier future capabilities start on `deep`. `createLlmConfig({ tiers, capabilities })` checks what you give (an unknown tier, capability or field, or an empty model id, is a `CONFIG` error that says where) and fills in the rest; `resolveModel` picks the model for a call, with the order: a model chosen for that call, then a tier chosen for that call, then the capability's route. Changing a tier's model changes every capability routed to it. The library never reads environment variables or files: the application and the dev tools do that and pass the result in.

## Testing code that uses a model

`bipartite-graph/llm/testing` has a scripted model client that plays back answers and errors instead of calling a model, so everything built on the `ModelClient` port can be tested without a network or a key:

```ts
import { createScriptedModelClient } from 'bipartite-graph/llm/testing';

const client = createScriptedModelClient([
  { reply: '{"ops":[]}' },        // the provider answers (parsed as JSON if the request asked for JSON)
  { rateLimited: true, retryAfterMs: 500 },
  { refusal: true },
]);
await client.complete(request);
client.requests;   // every request it was asked, frozen copies
client.callCount;  // how many reached the provider
```

It behaves like a careful real client: it checks the request first, honours the time limit and cancellation, and never throws. A real client is held to the same contract with `runModelClientConformance(makeClient, { describe, it })`. The suite cannot make a real provider refuse or hang, so `makeClient` is told which scenario to produce (a text reply, JSON, prose when JSON was asked for, a refusal, a rate limit, a server fault, a rejected request, an unknown model, or a provider that never answers) and returns a client whose provider, usually a mocked HTTP layer, behaves that way. The shared helpers `checkRequest` and `runWithDeadline` do the request checking and the time limit and cancellation for any client.

## Prompts for the categoriser

`src/llm/capabilities/categorise/prompt.ts` builds everything sent to the model for one note: a fixed system prompt, one user message, and an output schema. The note and the category data appear only inside their own `<note>` and `<categories>` blocks, with `&`, `<` and `>` escaped so they cannot close a block or add one. The system prompt never contains user text. The output schema is derived from the graph store's own `mutationJsonSchema()` and narrowed to the operations the categoriser may use (`upsertNode`, `link`), so the format cannot drift. An empty or oversized note is refused, never cut. The exact wording is kept as plain-text golden files in `src/llm/capabilities/categorise/__snapshots__/`, so a change to it shows in review.

## Asking the model to categorise a note

`createLlm({ client, config? })` returns an object with one method per capability, today `categorise()`:

```ts
import { createLlm } from 'bipartite-graph/llm';

const llm = createLlm({ client });           // client: any ModelClient
const result = await llm.categorise(
  { text, graphId: 'my-notes', itemId: 'note-01', categories },   // the controller supplies the ids and the current categories
  { tier: 'balanced', timeoutMs: 20_000, signal },                 // all optional; model or tier can be chosen per call
);
// ok: { mutation, rationale?, usage, model, attempts }   an error: { code, message, retryable }
```

It builds the context and prompt, calls the model, and checks the reply with the output guard. A reply the guard rejects goes back to the model once with the reasons; a second rejection is a `BAD_OUTPUT` error. One time limit covers both attempts, cancellation is honoured, and nothing is written: the result is a proposal for a person to approve and pass to `write`. A bad `graphId`, `itemId` or option is a `CONFIG` error before any model call is paid for.

## The application layer

`src/app/` (entry point `bipartite-graph/app`) is where input meets the graph and the model. So far it holds three small pieces:

- **Input:** `{ kind: 'text', text }`, `{ kind: 'image', mediaType, data }` or `{ kind: 'audio', mediaType, data }`. `parseInput` checks one; unknown kinds and extra fields are `INVALID_INPUT`.
- **Normalising:** `normaliseInput(input, normalisers?)` turns any input into the text the categoriser reads. Only text is handled today (a blank note is `INVALID_INPUT`); images and audio give `UNSUPPORTED_INPUT` until you supply a normaliser, for example `normaliseInput(input, { audio: transcribe })`. A normaliser that throws or returns something that is not text is `NORMALISER_FAILED`, without leaking its message.
- **Item ids:** the graph store never makes ids, so `createItemIdGenerator({ now?, random?, prefix? })` does. Ids look like `note-0m5xk2q9a-00-f3k9d2` (time, a counter for the same millisecond, a random tail): lowercase, safe as a file name, and sorting by id is sorting by creation order, even if the clock steps back. Pass `now` and `random` to make them deterministic in tests.
- **Proposal summary:** `summarise(mutation, existing)` says, before anything is written, what approving a proposal would do: new items, new categories, existing categories reused, the distinct links, and existing nodes that would change. `existing` lists which of the mutation's ids are already in the graph (the controller finds out with `query()`). It reads the operations in the order `write` applies them, so a link to a category that does not exist and is not created *before* it is reported under `problems` (the write would fail: do not approve), while a repeated link or a link from an item that already exists is a `notes` entry. `describeSummary(summary)` renders it as short plain text; odd ids are shown quoted and escaped so a model-chosen id cannot add lines. It is pure, and a test checks its predictions against the real store on 400 random proposals.
- **Propose:** `createController({ adapter, llm, ids?, normalisers?, ttlMs?, maxPending?, maxCategories? })` returns `{ propose, get }`. `propose(graphId, input, options?)` reads the graph's categories with `query()` (up to `maxCategories`, default 500, and reports when it hit the cap), turns the input into text, mints the item id, asks `llm.categorise()`, checks which of the proposal's ids already exist, and returns a frozen pending proposal: `{ id, itemId, note, mutation, rationale?, summary, text, usage, model, attempts, context, createdAt, expiresAt }`. It reads the graph and **writes nothing**; a test with a recording adapter proves it, including on every failure path. The graph is checked first, so a note is never transcribed or sent to a model for a graph that is not there. Errors keep their own type, tagged with where they came from: `{ source: 'app' | 'graph' | 'llm', error }`. Proposals wait 15 minutes by default (`get` returns nothing after `expiresAt`), at most 100 at a time (`TOO_MANY_PENDING` rather than quietly forgetting one). A proposal whose summary has `problems` is still returned, so a person can see why it would fail; approving and rejecting come next (T-055).

## Writing a storage adapter

An adapter is an object implementing `StorageAdapter` (exported from `bipartite-graph`): a `name`, its `capabilities`, a `transaction(graphId, fn)` method, and `graphs` (`create`, `exists`, `list`, `drop`). All graph rules (validation, the bipartite rule, cascading deletes, query planning) live in the core, so an adapter only provides storage primitives. It does not check that edge endpoints exist and it does not cascade.

What every adapter must guarantee, and what the conformance suite checks:

- **Atomic, serialised transactions.** If the callback passed to `transaction` throws, nothing it did persists, and the adapter keeps working afterwards. Transactions on one graph run one at a time, so concurrent writers never lose each other's updates, and a transaction sees its own earlier writes. A transaction on a graph that does not exist rejects instead of creating it. The core refuses to write through an adapter that reports `transactions: false`.
- **Isolation.** Graphs never see each other's data, even with identical node ids. Two adapters made by the same factory share nothing.
- **Idempotent `graphs.create` and `graphs.drop`.** Creating an existing graph or dropping a missing one is a no-op; the core decides when those are errors.
- **Replace on write.** `putNodes` and `putEdges` store the record as given, replacing any earlier one for the same key.
- **Deterministic keyset paging.** Listings are ordered by id as plain text, comparing UTF-16 code units, the order JavaScript's `<` gives: `B` before `a`, and no locale or case folding. This is not the same as UTF-8 byte order for characters outside the basic plane, so a database adapter must order (or re-sort) accordingly. Cursors are opaque and stay valid when rows are added or removed between pages. A page that exactly fills the limit, with nothing after it, has no next cursor. Cursors must advance: the suite stops a listing that never ends instead of hanging.
- **Graph ids are plain, node ids are opaque.** The core only accepts graph ids of 1 to 128 characters from lowercase letters, digits, `_` and `-`, starting with a letter or digit, so an adapter may use a graph id directly as a file name or key on any platform. Node ids may be any string up to 256 characters, including `/`, `..`, spaces and non-ASCII text, and `Item` and `item` are different nodes, so an adapter must store node ids without altering or colliding them.
- **No aliasing.** Data handed in or out is copied, so callers cannot change stored state by mutating what they passed or received.

To check your adapter, call `runAdapterConformance` from your own test file and pass your test runner's `describe` and `it`:

```ts
import { describe, it } from 'vitest'; // or Jest, or node:test
import { runAdapterConformance } from 'bipartite-graph/testing';
import { createMyAdapter } from './my-adapter.js';

runAdapterConformance(
  () => createMyAdapter(),                 // a fresh, empty adapter every call
  { describe, it },
  { dispose: async (adapter) => { /* optional: release what this adapter used, e.g. delete its temp directory */ } },
);
```

The factory is called at least once per test (some cases need two adapters), and each adapter it returns must be independent of the others, for example by using its own temp directory. An adapter that passes the suite needs no changes to the core. `src/graph_store/testing/alternative-adapter.test.ts` shows this: it is a second adapter built with a different strategy (snapshot and restore, its own cursor format) that passes the same suite and runs end to end through `createGraphClient`. The memory adapter in `src/graph_store/adapters/memory/` is the reference implementation.

## Conventions

- **One task, one commit.** Conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, plus the task id.
- **Gate per task.** `npm run gate` (typecheck, lint, tests, API check) must pass for each task, plus the task's own acceptance check.
- **No scope creep.** If a task is bigger than expected, split it in `PLAN.md`. New ideas go to the Backlog.
- **Record decisions.** Non-obvious choices and their reasons go in `.gsd/STATE.md`.

## Customizing

- Change the rules by editing `system_prompt.md` yourself.
- Adjust the loop by editing the files in `.claude/commands/`.
- `.claude/settings.local.json` is git-ignored for personal settings.
