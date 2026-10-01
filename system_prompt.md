# Constitution

Non-negotiable rules for any AI agent working in this repo. Humans change this file deliberately; agents never edit it without being asked.

## Source of truth
1. `system_prompt.md` (this file) — how we work.
2. `spec.md` — what we are building and why.
3. `.gsd/STATE.md` — where we are right now.
4. `.gsd/PLAN.md` — what to do next, as atomic tasks.

If these conflict, higher wins. If code conflicts with the spec, flag it; don't silently pick one.

## Principles
- **Spec first.** No feature work without a spec entry. If the spec is silent or ambiguous, ask or propose a spec edit before coding.
- **Small steps.** One task = one change a reviewer can hold in their head, fits in one context window, one commit.
- **Simplest thing that works.** No speculative abstractions, no unrequested features, no new dependencies without stating why.
- **Match the codebase.** Follow existing style, naming, and comment density.
- **Verify, don't assume.** A task is done only when the gate below passes, with output shown.
- **Be honest.** Report failures, skipped steps, and uncertainty plainly. Never claim done on unverified work.
- **Solo-dev pace.** Prefer asking one sharp question over guessing on decisions that are expensive to reverse.

## The GSD loop
Every unit of work runs this cycle. Slash commands in `.claude/commands/` drive it.

1. **Orient** — read `.gsd/STATE.md` and the current task in `.gsd/PLAN.md`.
2. **Plan** (`/plan`) — break a spec section into atomic tasks with explicit acceptance checks.
3. **Do** (`/next`) — take the first unchecked task. Implement only that task.
4. **Verify** (`/verify`) — run the gate; fix until green.
5. **Ship** (`/ship`) — check off the task, update STATE.md, make one commit.
6. **Repeat**, or stop and surface blockers.

Rules:
- Work on exactly one task at a time. New ideas go to the Backlog in PLAN.md, not into the current task.
- If a task turns out bigger than expected, stop and split it in PLAN.md.
- Record non-obvious decisions and their reasons in STATE.md.

## Verification gate
A task is done only when all pass, per task:
- Tests: `npm test`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

Run all three with `npm run gate`.

Plus the task's own acceptance check from `.gsd/PLAN.md`. Add the conformance suite to the gate once adapters exist (M5 onward).

## Git
- Repo initialized; work on feature branches off `main` when a change spans multiple tasks, otherwise commit to `main`.
- One commit per task, conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), referencing the task id, e.g. `feat: add parser (T-003)`.
- Never commit failing gate, secrets, or generated junk. Never force-push or rewrite history without explicit approval.

## Boundaries
- Ask before: adding dependencies, deleting files, changing the spec's goals or non-goals, anything outward-facing (publishing, deploying, sending).
- Never: commit secrets, edit `.env` files, run destructive commands without confirmation.
