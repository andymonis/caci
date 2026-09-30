---
description: Turn a spec section into atomic tasks in .gsd/PLAN.md
argument-hint: [spec section or requirement ids]
---

Plan work for: $ARGUMENTS (if empty, use the next unplanned part of spec.md).

1. Read `system_prompt.md`, `spec.md`, `.gsd/STATE.md`, `.gsd/PLAN.md`.
2. If the targeted spec section is vague or ambiguous, ask me focused questions first; propose spec edits rather than assuming.
3. Break the work into atomic tasks (one commit, one context window each), ordered by dependency. Each line: `- [ ] T-nnn (R-xxx) title — acceptance: <verifiable check>`. Continue numbering from the last id.
4. Triage the Backlog: promote, drop, or keep items.
5. Write the tasks to `.gsd/PLAN.md` under the current milestone and update `.gsd/STATE.md`.
6. Show me the task list and stop. Do not start implementing.
