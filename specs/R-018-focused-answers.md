# Focused Answers: Horizons, Dated Facts and Follow-up Actions — Specification

Oct 22, 2026 · @Andy

**Status: Part A (horizons by prompt only, T-274 to T-281) is being built as H1. Parts B (dated facts) and C (follow-up actions) are planned in outline and are re-confirmed after the owner's real run of Part A. D1 to D5 are the owner's (2026-10-22), the rest are mine and stand unless changed.** It builds on the status capability of `specs/R-011-status-updates.md`, the controls of `specs/R-012-controllable-llm.md` and the user app of `specs/R-016-user-app.md`.

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
| D11 | `POST /api/status` takes `{ check: 'pulse' \| 'coming-up' \| 'long-range', scope?, timeZone? }` and **no text** (a text, or an unknown check, is refused by name). The check may be asked of the person's own brain, one circle, or (no scope) every brain they can read. The legacy `{ pulse: true, scope: <circle> }` keeps working as the week check. A check text can **never** come from a client. | No client-written instructions; one fixed way to ask. |
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

| Threat | Control |
|--------|---------|
| A check text sent by a client | D11: the route takes `check` and no text; the server picks the file. |
| A note that tells the model to ignore the window | D6, FA-NFR-01: the window is in the trusted system prompt, notes are data in an escaped block (R-011). |
| A horizon filter hides something urgent | D9 includes overdue and open items; Part A relies on the model for them, so the evaluation has an overdue case; Part B filters in code and must keep them. |
| A wrong or alarming suggestion (Part C) | D16: nothing is written until the person OKs it; wording is "check"; at most three. |
| Suggestions that nag (Part C) | D16: at most three, skipped ones are remembered, silence is a valid answer. |

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

## Residual risks (not covered, with the reason)

1. **Part A relies on the model to read dates and "paid" from free text**; a weak model can still dump or miss. Part B exists for that, decided on the real run.
2. **The date finder of the demo model is a stand-in**; it does not show how a real model reads dates.
3. **A window is a hard line**: something due the day after the window is not mentioned until it enters it.
4. **One check text for everybody** (as the Pulse text is today).
5. **Parts B and C are outlines** and will be re-specified before they are built.
