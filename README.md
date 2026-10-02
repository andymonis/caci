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
schema/graph_store/     Generated JSON Schema for the mutation and query formats
api/                    Committed public API report (API Extractor)
dev/graph-explorer/     Local-only visual tester for the graph store (never published)
```

### Where the code lives

All graph store functionality sits under `src/graph_store/`, with each test file beside the module it covers. Nothing in that folder imports from elsewhere in the repo. Other platform components get their own sibling folders under `src/`. The folder-by-folder breakdown and the test map are in the R-001 spec ("Code layout and test map").

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

## Writing a storage adapter

An adapter is an object implementing `StorageAdapter` (exported from `bipartite-graph`): a `name`, its `capabilities`, a `transaction(graphId, fn)` method, and `graphs` (`create`, `exists`, `list`, `drop`). All graph rules (validation, the bipartite rule, cascading deletes, query planning) live in the core, so an adapter only provides storage primitives. It does not check that edge endpoints exist and it does not cascade.

What every adapter must guarantee, and what the conformance suite checks:

- **Atomic transactions.** If the callback passed to `transaction` throws, nothing it did persists. The core refuses to write through an adapter that reports `transactions: false`.
- **Isolation.** Graphs never see each other's data, even with identical node ids. Two adapters made by the same factory share nothing.
- **Idempotent `graphs.create` and `graphs.drop`.** Creating an existing graph or dropping a missing one is a no-op; the core decides when those are errors.
- **Replace on write.** `putNodes` and `putEdges` store the record as given, replacing any earlier one for the same key.
- **Deterministic keyset paging.** Listings are ordered by id and use an opaque cursor that stays valid when rows are added or removed between pages.
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
