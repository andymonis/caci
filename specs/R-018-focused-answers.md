# Focused Answers: Horizons, Dated Facts and Follow-up Actions — Specification

Oct 22, 2026 · @Andy

**Status: Part A (horizons by prompt only, T-274 to T-281) is built as H1 and reviewed below. Parts B (dated facts) and C (follow-up actions) are planned in outline and are re-confirmed after the owner's real run of Part A. D1 to D5 are the owner's (2026-10-22), the rest are mine and stand unless changed.** It builds on the status capability of `specs/R-011-status-updates.md`, the controls of `specs/R-012-controllable-llm.md` and the user app of `specs/R-016-user-app.md`.

## Overview

The owner's daughter added a note with four rent payments (1 Aug 2026 to 1 May 2027) and then said the first two were paid. On 22 October 2026 a **Pulse** returned a long message about all upcoming rent, although the next payment is on 1 February 2027, more than three months away. The owner's reading, which this specification follows:

- A pulse should be about **the here and now**, about a week. There should be several checks: *what is on the long-range radar*, *what is on the short range*, *the pulse*.
- **The answer should lift load, not add to it.** Saying everything is not help. When nothing needs attention the right answer is **silence** (one line), in the spirit of inbox zero.
- The model should think further than the notes: a holiday in France implies passports and driving documents, and **six months ahead** the checks should start to appear without anyone writing a note. Such follow-ups are **actions** (no deadline, "next time you are at the car") and are different from **tasks at a time** (an appointment, a reminder), which stay in a reminder or calendar app.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** an answer with nothing to say is **silent**: one line saying nothing needs attention in the window, no points, and **no "next: ..." line**. | Inbox zero: no unnecessary noise. |
| D2 | **Owner:** **time-pointed tasks stay out of the brain** (an appointment or a reminder at a time belongs to a reminder or calendar app). **Flexible follow-up actions may live in the brain** (Part C). | An action has no moment; a task does. |
| D3 | **Owner:** when a fact is added, CaCi may suggest **a small list of follow-up actions**, each **OK or skip**, never unwieldy (Part C). | The person stays in control. |
| D4 | **Owner:** **prompt only first** (Part A), measure on the real models, then dated facts (Part B), then actions (Part C). | Find out how far wording alone gets before building structure. |
| D5 | **Owner:** answers are judged **by rules plus the owner's own wording** of what a good answer holds and leaves out; no model as judge; the cases are **invented lookalikes** of the real ones so family data stays out of the repository. | Repeatable, cheap, private. |
| D6 | There are three **horizons**: `week` (the **Pulse**), `month` (**Coming up**) and `year` (**Long range**). The **window is computed by the code** in the person's validated time zone and **stated to the model**; the model never works out the window. | A model that is told the window cannot be argued out of it by a note. |
| D7 | The window runs from the start of today to the end of the last day: `week` is 7 days including today, `month` is 31 days, `year` is up to the same date 12 months on. | Simple, predictable, easy to say. |
| D8 | The **wording** of the rules for a horizon lives in `controls/status/settings.json` (a common rule text and a one-line focus per horizon) and the **point caps** per horizon beside it (`week` 3, `month` 4, `year` 5): text outside the code, tunable with `--controls`. The system prompt gains one optional slot, `{{horizonSection}}`, which is empty when no horizon is asked, so **a question or any request without a horizon produces today's prompt byte for byte**. | R-012: instructions are static text outside the code. |
| D9 | The rules say: use only what falls **in the window**, or is **overdue or still open**; say **nothing** about what is outside it; do not restate whole notes (what, when, what to do); when nothing qualifies, **say so in one line with no points**. | The owner's reading of the failure. |
| D10 | The three checks are **server-held texts**: `controls/pulse.txt` (the week; exists), `controls/coming-up.txt` and `controls/long-range.txt`, each read at start-up with the rules of the Pulse text (one paragraph, 1 to 500 characters, an ordinary UTF-8 file); a bad or missing file stops the start naming it, and the doctor checks all three. | The Pulse text rule, unchanged. |
| D11 | `POST /api/status` takes `{ check: 'pulse' \| 'coming-up' \| 'long-range', scope?, timeZone? }` and **no text** (a text, or an unknown check, is refused by name). The check may be asked of the person's own brain, one circle, or (no scope) every brain they can read. The legacy `{ pulse: true, scope: <circle> }` keeps working as the week check (the circle screen's Pulse button still sends it; Home's Pulse and the Coming up and Long range buttons send `check`). A check text can **never** come from a client. | No client-written instructions; one fixed way to ask. |
| D12 | The circle screen shows **Pulse**, **Coming up** and **Long range** buttons; Home shows the same three over all readable brains beside the question box. A silent answer reads as one line. | Where people already look. |
| D13 | The **demo model** honours a horizon with a small deterministic date finder (`1 Feb 2027`, `01/02/2027`, `2027-02-01`, `tomorrow`, a weekday name, relative to now): an entry with no date inside the window is not surfaced; nothing in the window gives `nothing: true` and a one-line headline. It is a stand-in so tests can show silence, not a judge of meaning. | Tests and journeys need silence without a real model. |
| D14 | The status **evaluation** gains horizon cases (a date as "now", entries with dates, expectations: silent, must include, must not mention, maximum points and characters) scored by rules. The ideal scripted model passes every case through the real `status` and bad models (dump everything, never silent, invent a date) each fail the cases aimed at them. | The scoring discriminates before it is trusted. |
| D15 | **Part B (outline):** the categoriser extracts for each fact an optional `when` (an ISO date or a range) and a `state` (`open` or `done`), kept as data beside the text; the status context filters by window **in code, before the model sees anything**. A wrong or missing date degrades to Part A behaviour. | Fewer tokens, deterministic windows, "paid" becomes data. |
| D16 | **Part C (outline):** at filing the categoriser may suggest **at most three** follow-up actions (key, short text, lead time within a cap) for a note that describes a future event or implies checks; they are **not written until the person OKs them**; an action is a brain item with a key, a `from` date (the earliest it matters, from the event date and the lead time: **never a deadline**) and the fact it came from; open actions surface in the horizons once `from` is inside the window; the person completes one with a button or a later note (for example "checked the passports", which replaces it through the existing replace mechanism) or skips it, and a skipped suggestion is not offered again for that fact. Wording is always "check", never an assertion of a rule. | Reuses replacement as completion; no state machine. |
| D17 | Out of scope: notifications and push, calendar or reminder-app integration, free-form time questions ("what is on next Tuesday"), history of answers, a model as judge, and changing what the model may do with the notes (it still only reads). | Keep it small. |

## Requirements

| ID | Requirement |
|----|-------------|
| FA-FR-01 | `horizonWindow(now, timeZone, horizon)` returns the window and its spoken label in the person's zone, right at month ends, leap days and daylight-saving changes (D6, D7). |
| FA-FR-02 | A status request with a horizon states the window and the rules in the system prompt; without a horizon the prompt and schema are byte for byte today's (D8). |
| FA-FR-03 | The guard uses the per-horizon point cap; a silent answer (`nothing: true`, no points, one headline) is valid (D1, D8). |
| FA-FR-04 | The three check texts are loaded, validated and published like the Pulse text; the doctor checks them (D10). |
| FA-FR-05 | `POST /api/status` takes `check` instead of text and refuses a text, an unknown check and unknown fields by name; `pulse: true` still works as the week check; the same session, scope and not-found rules as today (D11). |
| FA-FR-06 | The demo model honours a horizon deterministically and always passes the real guard (D13). |
| FA-FR-07 | The pages show the three buttons with the answer, its sources and Show the source as today, and a silent answer as one line (D12). |
| FA-FR-08 | The evaluation scores horizon cases by rules and its bad models fail (D14). |
| FA-NFR-01 | The model is never given the means to widen the window: the window is stated by the system prompt, never taken from a note or a request. |
| FA-NFR-02 | A check reads, as a status does today, and writes nothing. |
| FA-NFR-03 | Nothing a note says can change a check's text, window or caps. |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| A check text sent by a client | D11: the route takes `check` and no text; the server picks the file. | `src/caci/controller-check.test.ts` — "refuse an unknown or non-text check, text with a check, a check with a pulse, and an unavailable check, each by name, asking nothing"; `src/api/status-routes.test.ts` — "refuses text, an unknown or non-text check, and a check with a pulse, by name, before the model is asked"; `src/service/status-end-to-end.test.ts` — "are refused by name with text, with an unknown or non-text check, or with a pulse"; `web/notes-client.test.mjs` — "check sends only the check, the scope when there is one, and the time zone: never words, never a pulse flag (R-018)"; `web/user-pages.test.mjs` — "holds no words for the checks: the texts and the window live on the server" |
| A note that tells the model to ignore the window | D6, FA-NFR-01: the window is in the trusted system prompt, notes are data in an escaped block (R-011). | `src/llm/capabilities/status/prompt.test.ts` — "a hostile entry or request cannot change the window or the rules"; `dev/eval/focus.test.mjs` — "the ideal scripted model passes every focused case, first time, with the window stated"; `src/llm/demo-focus.test.ts` — "always passes the real guard, first time, for any text, in every horizon" |
| A horizon filter hides something urgent | D9 includes overdue and open items; Part A relies on the model for them, so the evaluation has an overdue case; Part B filters in code and must keep them. | `dev/eval/focus.test.mjs` — "one that is always silent is caught on the cases that need an answer"; `dev/eval/focus.test.mjs` — "the rent cases are the real case: two payments paid, the next on 1 Feb, the week and the month silent" |
| A check reads more than the person may read, or writes | D11: the same session, scope and read rules as a status, asked before anything is read or counted; a check only reads. | `src/caci/controller-check.test.ts` — "a stranger, a made-up circle and a non-text check get the same answers as a status would, nothing asked"; `src/caci/controller-check.test.ts` — "count against the same hourly limit and one-at-a-time rule as a status, and write nothing"; `src/service/status-end-to-end.test.ts` — "a member and an observer can ask each check of a circle, anyone of every brain; a stranger and a made-up circle get the one 404; nothing is filed" |
| A bad or missing check text, or controls that cannot state the window | D10: a bad file stops the start naming it; a horizon is refused when the controls have no slot for its window. | `src/service/controls.test.ts` — "a missing or bad coming-up or long-range file stops the start the same way, naming it, with every bad file listed"; `src/llm/capabilities/status/prompt.test.ts` — "refuses an unknown horizon, and controls whose system.txt has no slot for the window, without throwing"; `src/llm/controls/settings.test.ts` — "refuse an unknown entry, a missing horizon, a stray field and a wrong kind of value, naming where" |

Part C threats (a wrong or alarming suggestion, suggestions that nag) are in D16 and are reviewed when Part C is built.

## What the person is told

A silent check says, for example, *Nothing needs your attention this week.* The pages do not add a second line.

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| FA-AC-01 | Given 22 Oct 2026 and a rent schedule with the first two payments paid, then the week and month checks are silent and the year check names 1 Feb and 1 May only. |
| FA-AC-02 | Given a dentist tomorrow beside rent months away, then the week check names the dentist only. |
| FA-AC-03 | Given an overdue unpaid item, then every check shows it. |
| FA-AC-04 | Given a request without a horizon, then the prompt is byte for byte today's. |
| FA-AC-05 | Given a check text, an unknown check or extra fields in the request, then the route refuses them by name. |
| FA-AC-06 | Given a bad or missing check text file, then the service does not start and names the file. |
| FA-AC-07 | Given the three buttons, then each asks for its check of the right brains and a silent answer is one line. |
| FA-AC-08 | Given the evaluation, then the ideal scripted model passes and the three bad models fail the cases aimed at them. |

### Where each criterion is checked (T-281)

| ID | Tests |
|----|-------|
| FA-AC-01 | `src/llm/demo-focus.test.ts` — "the rent case: the week and the month are silent, the year names only the schedule once, with one line headline"; `dev/eval/focus.test.mjs` — "the ideal scripted model passes every focused case, first time, with the window stated"; `web/user-journey.test.mjs` — "the three checks: a rent schedule with two payments paid is silent for the week and the month and shows only what is left in the long range; a dentist two days away is in the week; a circle" |
| FA-AC-02 | `src/llm/demo-focus.test.ts` — "a dentist tomorrow beside far-off rent: the week names the dentist only"; `src/caci/controller-check.test.ts` — "the week says only what falls in the week, the month adds the rent, the year adds the passport (the demo model reads the dates)" |
| FA-AC-03 | `dev/eval/focus.test.mjs` — "one that is always silent is caught on the cases that need an answer"; `dev/eval/focus.test.mjs` — "the ideal scripted model passes every focused case, first time, with the window stated" |
| FA-AC-04 | `src/llm/capabilities/status/prompt.test.ts` — "without a horizon the prompt and the schema are exactly what they were (the golden files hold)"; `src/llm/capabilities/status/status.test.ts` — "without a horizon the request is as it was: no section and the ordinary cap"; `src/caci/controller-check.test.ts` — "an ordinary status has no window and sends the person" |
| FA-AC-05 | `src/caci/controller-check.test.ts` — "refuse an unknown or non-text check, text with a check, a check with a pulse, and an unavailable check, each by name, asking nothing"; `src/api/status-routes.test.ts` — "refuses text, an unknown or non-text check, and a check with a pulse, by name, before the model is asked"; `src/service/status-end-to-end.test.ts` — "are refused by name with text, with an unknown or non-text check, or with a pulse" |
| FA-AC-06 | `src/service/controls.test.ts` — "a missing or bad coming-up or long-range file stops the start the same way, naming it, with every bad file listed"; `src/service/controls-files.test.ts` — "reports every bad file at once, each naming its file, and gives no texts for any"; `deploy/doctor-host.test.mjs` — "with the three check texts, names coming-up.txt or long-range.txt when either is missing" |
| FA-AC-07 | `web/checks-page.test.mjs` — "are three buttons beside the boxes, and each sends only its check (no words, no scope, no old pulse flag)"; `web/checks-page.test.mjs` — "Pulse, Coming up and Long range each send their check with this circle only, and a silent answer is one line"; `web/checks-page.test.mjs` — "a silent answer is the headline alone: no second line"; `web/user-pages.test.mjs` — "has the three checks as buttons (R-018): Pulse, Coming up and Long range, in that order" |
| FA-AC-08 | `dev/eval/focus.test.mjs` — "the ideal scripted model passes every focused case, first time, with the window stated"; `dev/eval/focus.test.mjs` — "one that dumps every note fails the silent cases, the cases that name what to leave out, and the cap"; `dev/eval/focus.test.mjs` — "one that is never silent is caught on every silent case"; `dev/eval/focus.test.mjs` — "one that invents a date is caught by the numbers check" |

The three checks were looked at in Chrome on the real service (demo model, scratch data, a 500-pixel window): Home showed Pulse, Coming up and Long range between the thread and the update box; with a dentist note two days away and a rent note 100 days away, Pulse and Coming up named the dentist only (a headline "1 thing to look at this week" and one point), Long range named both, the buttons were enabled again after each answer, each point had its Show the source button, the markup in a note was shown as literal text, there was no horizontal overflow and the cookie was not readable by script. Not looked at by eye: the silent answer (covered by the journey test), the circle screen's three buttons, the keyboard path (buttons were pressed by element), a dark layout, a screen reader, and any real model.

### Residual risks (not covered, with the reason)

1. **Part A relies on the model to read dates and "paid" from free text**; a weak model can still dump or miss. Part B exists for that, decided on the real run.
2. **The date finder of the demo model is a stand-in**; it does not show how a real model reads dates.
3. **A window is a hard line**: something due the day after the window is not mentioned until it enters it.
4. **One check text for everybody** (as the Pulse text is today).
5. **Parts B and C are outlines** and will be re-specified before they are built.
6. **The shipped wording and caps are untested on a real model**: only the demo model and the scripted evaluation have run them; the owner's real run of `npm run eval -- --capability focus` on the shipped and a candidate folder decides whether wording alone is enough.
7. **The circle screen's Pulse still sends the older `pulse: true` request**, which the service treats as the week check; only the other buttons send `check`.
8. **An undated note is never surfaced by a focused check in the demo model**, and a real model may or may not do likewise; a note that matters but carries no date needs Part B or an explicit date.
9. **A silent answer hides how many notes were read**: nothing says what was considered, so a person cannot tell silence from a failure to read a note (the answer's counts are in the service's view, not on the page).
