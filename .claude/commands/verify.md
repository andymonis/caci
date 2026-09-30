---
description: Run the verification gate for the current task
---

1. Read the Verification gate in `system_prompt.md` and the current task's acceptance check in `.gsd/PLAN.md`.
2. Run tests, lint, and typecheck, plus the task's own acceptance check. Skip none; if a command is still `TBD`, say so explicitly.
3. If anything fails, fix it (within the current task's scope) and re-run until green.
4. Report plainly: each check, pass/fail, and key output. Never claim success on anything not run.
