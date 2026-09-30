---
description: Close out the current task with state update and one commit
---

1. Confirm the gate passed for the current task in this session. If not, run `/verify` first and stop if it fails.
2. In `.gsd/PLAN.md`, check off the task and move it to **Done**.
3. Update `.gsd/STATE.md`: clear Current task, note position, record any decisions or blockers.
4. Stage only files belonging to this task plus the `.gsd/` updates. Make one conventional commit referencing the task id, e.g. `feat: add parser (T-003)`.
5. Report the commit and the next unchecked task. Do not push.
