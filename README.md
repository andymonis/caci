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

## Conventions

- **One task, one commit.** Conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, plus the task id.
- **Gate per task.** `npm run gate` (typecheck, lint, tests, API check) must pass for each task, plus the task's own acceptance check.
- **No scope creep.** If a task is bigger than expected, split it in `PLAN.md`. New ideas go to the Backlog.
- **Record decisions.** Non-obvious choices and their reasons go in `.gsd/STATE.md`.

## Customizing

- Change the rules by editing `system_prompt.md` yourself.
- Adjust the loop by editing the files in `.claude/commands/`.
- `.claude/settings.local.json` is git-ignored for personal settings.
