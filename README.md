# caci

A blank, AI-native project scaffold for solo development with Claude Code.

It combines two ideas:

- **Spec Kit-style alignment:** write down the rules (Constitution) and the intent (Spec) before any code.
- **GSD-style execution:** a tight loop of small tasks, each verified and committed on its own.

> Status: scaffold only. The spec is an empty skeleton, the stack is not chosen, and the verification gate commands are `TBD`.

## Project layout

```
system_prompt.md        Constitution: how the agent works here (rules, loop, gate, git, boundaries)
spec.md                 Core Spec: what we're building and why
CLAUDE.md               Loads system_prompt.md and .gsd/STATE.md into every Claude Code session
.gsd/
  PLAN.md               Atomic task queue: current milestone, Backlog, Done
  STATE.md              Current position, decisions, blockers
.claude/commands/       Slash commands that drive the loop: /plan /next /verify /ship
.gitignore
```

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
2. Fill in `spec.md`, working through it with Claude (this is task T-001).
3. Choose a stack and replace the `TBD` test, lint and typecheck commands in `system_prompt.md` (task T-002).
4. Run `/plan` to turn spec sections into tasks.
5. Loop: `/next`, then `/verify`, then `/ship`, until the milestone is done.

## Conventions

- **One task, one commit.** Conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, plus the task id.
- **Gate per task.** Tests, lint and typecheck must pass for each task. Until the commands exist, the task's acceptance check stands in.
- **No scope creep.** If a task is bigger than expected, split it in `PLAN.md`. New ideas go to the Backlog.
- **Record decisions.** Non-obvious choices and their reasons go in `.gsd/STATE.md`.

## Customizing

- Change the rules by editing `system_prompt.md` yourself.
- Adjust the loop by editing the files in `.claude/commands/`.
- `.claude/settings.local.json` is git-ignored for personal settings.
