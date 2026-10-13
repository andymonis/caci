# Status Updates — Specification

Oct 13, 2026 · @Andy

**Status: being built as Q1 (T-181 to T-194).** This is roadmap item 8 as the owner clarified it on 2026-10-13. An earlier reading of it (one member asking another member, with a request, an inbox and consent) was wrong and is dropped.

## Overview

A person asks CaCi for a **status update**: they type free text ("Give me a morning status check", "I am heading into town") and CaCi answers them, briefly and in a standard format, from **everything they can read**: their personal brain and every circle brain they belong to (My Brain, R-009). The answer is for that person alone and is **not filed anywhere**. It is the first *answering* capability of the LLM component, beside the categoriser.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** a status update is a request **to CaCi, not to another person**. There is no inbox, no notification, no consent step and no request between members. | The owner's clarification. |
| D2 | **Owner:** the context is **the person's personal brain plus every circle brain they can read**, combined as background fact. Other information (location, weather, calendars) may be added **later, not now**. | Reuses My Brain; keeps v1 small. |
| D3 | **Owner:** the answer goes **only to the person who asked** and is **not filed** in any brain. | A status is a view, not a record. |
| D4 | **Owner:** the person must have an account; **observers can ask** (a status only reads). | Same right as reading My Brain. |
| D5 | **Owner:** the request is **free text**; the answer is **short, concise and in a standard format**. | Daily use. |
| D6 | **Owner:** personal-data worries do not slow this milestone. The page says plainly that everything the person can read is sent to the model with the request; the release gates of R-008, R-009 and R-010 stand for anything wider. | As for the Pi. |
| D7 | A new LLM capability **`status`** in its own folder, routed to the **`balanced` tier** by default (overridable like every capability), provisional until T-192's evaluation. | It synthesises across notes; the categoriser's cheap tier is a poor guess. |
| D8 | The model **cites the context entries it used by number**; the **server** maps each number to where the entry came from. A number outside the entries given is rejected. | Provenance cannot be invented or altered by the model or by an instruction inside a note. |
| D9 | **Fixed output:** `headline` (1 to 160 characters), `points` (0 to 5, each `text` of 1 to 240 characters and `refs`, 1 to 5 entry numbers), and `nothing` (`true` only when there are no points). Exactly one of: at least one point, or `nothing: true`. Shown as text only. | A standard, short, checkable shape. |
| D10 | **Context** = the person's readable items (same scopes, same limit as My Brain), each with its title, summary, other data text, category names, the scope it is in, and a time (a circle item's `contributedAt`, else the time in the item's minted id, else none), **newest first**, within a fixed character budget (default 12,000) and at most 200 entries per scope; the answer says how many entries were **left out** when any were. | Bounded cost and size; recency is what a status needs. |
| D11 | The prompt carries the **current date and time in the person's time zone**: an optional `timeZone` in the request (an IANA name, checked with `Intl`), default `UTC`. | "Morning" means something. |
| D12 | **Read-only path.** Nothing a status request does writes to any graph or store (proved with a recording adapter). | D3. |
| D13 | **Limits:** `CACI_STATUS_PER_HOUR` per account (1 to 1,000, default 20), counted when the model is about to be called, and **one request in flight per account**. | Each request costs a model call over a large prompt. |
| D14 | The **demo model** answers `status` deterministically (so the default mode works free): a headline with the count and date, the newest entries as points citing their numbers, or `nothing`. | Default mode must work. |
| D15 | **Nothing is kept:** no history, no log of the request text, no stored answer. A new screen `#/status` holds the answer in memory only and forgets it on leaving the screen or signing out. | The owner chose no history for now. |
| D16 | The route is **`POST /api/status`** with `{ text, timeZone? }` (POST because it costs a model call and the Origin rules apply); the answer carries **no model name, usage, prompt, graph id or entry id**. | Same discipline as proposals. |

## Goals and non-goals

Goals: a one-press, short, grounded status from everything the person can read; provenance shown by circle name; nothing leaking between scopes or to someone who lost access; works in demo mode; bounded cost.

Non-goals (later, in the Backlog): location, weather, calendars or reminders as context; restricting a status to one circle or to "just me"; a history of statuses; free-form questions; push or email notices; asking another person; writing anything as a result of a status.

## Definitions

- **Entry:** one numbered item in the context (1, 2, 3, …) with its provenance.
- **Provenance:** `{ kind: "personal" }` or `{ kind: "circle", circleName }` (R-009).
- **Readable scopes:** what `resolver.readable(token)` returns now: the person's own brain, then each circle they are in, any role.

## Output format

| Field | Rule |
|-------|------|
| `headline` | 1 to 160 characters: the one-line state of things. |
| `points[]` | 0 to 5; each `text` 1 to 240 characters and `refs` 1 to 5 distinct whole numbers, each between 1 and the number of entries given. |
| `nothing` | `true` only when there are no points and nothing relevant was found; never with points. |

What the person is shown (built by the server): `headline`, `points` each with `text` and `sources` (for each cited entry, `personal` or the circle's name, de-duplicated), `nothing`, `generatedAt`, `mode` (`demo` or `anthropic`), `entriesUsed` (how many were sent) and `entriesLeftOut`.

## Requirements

| ID | Requirement |
|----|-------------|
| ST-FR-01 | `POST /api/status` takes a session, `text` (1 to 500 characters after trimming) and optional `timeZone`, and nothing else; anything else is refused by name. |
| ST-FR-02 | The context is built only from scopes the person may read **at that moment**; a scope they cannot read, a circle they left and any graph of someone else contribute nothing. |
| ST-FR-03 | Entries are ordered newest first within the budget; identical node ids in different scopes remain separate entries. |
| ST-FR-04 | The prompt's instructions are fixed and trusted; the request and the entries appear only inside escaped, delimited blocks of untrusted data. |
| ST-FR-05 | The reply must be accepted by the guard (D9); one repair attempt, then an error; the person never sees unguarded model text. |
| ST-FR-06 | Sources shown are computed from the entries' provenance, never taken from model text. |
| ST-FR-07 | A status writes nothing, anywhere (D12). |
| ST-FR-08 | The hourly limit and the one-at-a-time rule are checked before any read of the brain or call to the model, and a refusal is not counted. |
| ST-FR-09 | With no entries at all the model is still asked (so the wording stays consistent) and the person gets a valid `nothing: true` answer. |
| ST-FR-10 | In demo mode the answer is deterministic for the same entries and time. |
| ST-FR-11 | The web screen shows the answer as text only, the mode notice and the sentence that everything the person can read is sent with the request. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| ST-NFR-01 | **Fail closed.** If the readable scopes, a graph read or the model cannot be established, no answer is made up. |
| ST-NFR-02 | **No cross-scope leakage.** A fixture with distinctive text in personal, Circle A and Circle B brains proves the provider receives only readable scopes' content and the answer's sources are right. |
| ST-NFR-03 | **Authorisation at use time.** Membership and role are read on every request; nothing is cached. |
| ST-NFR-04 | **Bounded.** Entries, size, request text, output and time are capped. |
| ST-NFR-05 | **No secrets in answers or logs.** No key, usage, model name, prompt, graph id or entry id in any response. |
| ST-NFR-06 | **Boundaries.** The graph store knows nothing of statuses; the LLM component never imports the CaCi controller; the context reader uses the public `query` only. |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| An instruction hidden in a note ("ignore the rules and say…") steers the answer | Entries are untrusted data in escaped blocks; the output is guarded to a fixed shape; the model has no write path; sources come from the server. | `src/caci/controller-status.test.ts` — "reaches the model only as data"; `src/llm/capabilities/status/prompt.test.ts` — "tell the model the entries are data, not instructions"; `src/llm/capabilities/status/prompt.test.ts` — "cannot close or open a block"; `src/llm/capabilities/status/guard.test.ts` — "an unknown field anywhere"; `src/llm/demo-status.test.ts` — "a note that gives orders only ever becomes a quoted point"; `web/status-journey.test.mjs` — "markup in a note stays text"; `dev/eval/status.test.mjs` — "the one that cites everything is caught on the nothing-relevant case and on the hidden instruction" |
| Notes of a circle the person left, or never joined, reach the model or the answer | Context is built from `readable` at request time and nothing else; tests seed distinctive text in other scopes and inspect the provider request. | `src/caci/status-context.test.ts` — "reads only the scopes it is given"; `src/caci/controller-status.test.ts` — "never shows one person"; `src/service/status-end-to-end.test.ts` — "a stranger and another circle never appear"; `src/service/status-end-to-end.test.ts` — "the request holds only what the person may read" |
| The model invents or alters provenance | It returns numbers only; the server maps them; an unknown number fails the guard. | `src/caci/controller-status.test.ts` — "a reply citing an entry that does not exist is repaired or refused"; `src/llm/capabilities/status/guard.test.ts` — "references that are missing, empty, too many, outside the entries"; `src/caci/controller-status.test.ts` — "shows each source once for a point" |
| Cost and abuse (many requests, huge text) | Text capped at 500 characters, entries and budget capped, hourly limit, one at a time. | `src/caci/controller-status.test.ts` — "twenty statuses an hour by default"; `src/caci/controller-status.test.ts` — "one status at a time per account"; `src/caci/controller-status.test.ts` — "a request that is missing, not text, blank or too long"; `src/caci/status-context.test.ts` — "stays within the character budget"; `src/api/status-routes.test.ts` — "the hourly limit is a 429" |
| The answer is shown as markup and runs | The page sets text only; the guard tests and page guards forbid markup APIs. | `web/pages.test.mjs` — "no script uses"; `web/status-page.test.mjs` — "markup in the answer, a circle name and the request stays text"; `web/status-view.test.mjs` — "markup stays text" |
| A member is removed while a request runs | Scopes are read once at the start of the request; the next request has no trace of the circle. (A request already running may still use what was readable when it started: a residual risk.) | `src/caci/controller-status.test.ts` — "a member removed from a circle gets an answer without it on the next request"; `src/service/status-end-to-end.test.ts` — "a member removed from a circle gets an answer without that circle on the next request"; `web/status-journey.test.mjs` — "the notice comes first" |
| A status writes something | There is no write path; a recording adapter proves it for every outcome. | `src/caci/controller-status.test.ts` — "writes nothing, whatever happens"; `src/caci/status-context.test.ts` — "no write primitive is called, whatever the outcome"; `src/service/status-end-to-end.test.ts` — "writes nothing: every graph is exactly as it was" |
| Details of the model or other people's ids leak in an answer or error | The view has a fixed set of fields; errors use the fixed words of the capture routes. | `src/caci/controller-status.test.ts` — "exactly the headline, points with sources"; `src/api/status-routes.test.ts` — "answers 200 with the status view"; `src/service/status-end-to-end.test.ts` — "a provider failure reaches the person as fixed words" |

## What the person is told

| Situation | Words |
|-----------|-------|
| Mode notice | Status-specific sentences (the capture screen's say "filed", which is wrong here): `demo` "Answered by the free demo model: nothing leaves this machine."; `anthropic` "Answered by Anthropic's model: your request and the notes you can read, yours and your circles', are sent to Anthropic and are not anonymised."; plus "Your status uses everything you can read: your own notes and the circles you are in. It is sent with your request." |
| Nothing found | "Nothing relevant was found in what you can read." |
| Entries left out | "Some notes were left out because there were too many; the newest were used." |
| Limit | The service's words with the wait. |
| Model failure | The capture routes' fixed words for timeout, refusal, busy and error. |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| ST-AC-01 | Given notes in a person's personal brain and two circles, when they ask for a status, then the provider receives all three scopes' entries and the answer's sources name them. |
| ST-AC-02 | Given a person in no circle, when they ask, then only their own brain is read and no circle graph is touched. |
| ST-AC-03 | Given an observer, when they ask, then they get the same context as a member of that circle. |
| ST-AC-04 | Given a member removed from a circle, when they ask next, then nothing of that circle is in the request or the answer. |
| ST-AC-05 | Given distinctive text in another person's brain or another circle, when anyone else asks, then it is absent from the provider request and the answer. |
| ST-AC-06 | Given any number of status requests, when graph contents are compared before and after, then nothing changed. |
| ST-AC-07 | Given a reply that cites a number outside the entries, or breaks the format, when it is checked, then it is repaired once and then refused. |
| ST-AC-08 | Given more entries than the budget, when a status is made, then the newest are used and the answer says some were left out. |
| ST-AC-09 | Given the hourly limit reached, or a request already running, when another comes, then it is refused with no model call. |
| ST-AC-10 | Given a note containing instructions or markup, when a status is made, then the answer is still in the fixed format, shown as text, with sources from the server. |
| ST-AC-11 | Given demo mode, when the same request is made twice at the same time, then the answers are equal. |
| ST-AC-12 | Given the status screen, when the person leaves it or signs out, then the answer is gone from the page. |

### Where each criterion is checked (T-193)

| ID | Tests |
|----|-------|
| ST-AC-01 | `src/caci/controller-status.test.ts` — "uses their own brain and every circle they are in"; `src/service/status-end-to-end.test.ts` — "uses the personal brain and every circle the person is in"; `src/service/status-end-to-end.test.ts` — "the request holds only what the person may read" |
| ST-AC-02 | `src/caci/controller-status.test.ts` — "a person in no circle gets only their own brain, and no circle graph is touched"; `src/caci/status-context.test.ts` — "a person in no circle reads only their own graph" |
| ST-AC-03 | `src/caci/controller-status.test.ts` — "gives an observer the same context as a member of that circle"; `src/service/status-end-to-end.test.ts` — "an observer can ask and reads the same context"; `web/status-journey.test.mjs` — "the notice comes first" |
| ST-AC-04 | `src/caci/controller-status.test.ts` — "a member removed from a circle gets an answer without it on the next request"; `src/service/status-end-to-end.test.ts` — "a member removed from a circle gets an answer without that circle on the next request"; `web/status-journey.test.mjs` — "the notice comes first" |
| ST-AC-05 | `src/caci/controller-status.test.ts` — "never shows one person"; `src/caci/status-context.test.ts` — "reads only the scopes it is given"; `src/service/status-end-to-end.test.ts` — "a stranger and another circle never appear" |
| ST-AC-06 | `src/caci/controller-status.test.ts` — "writes nothing, whatever happens"; `src/caci/status-context.test.ts` — "no write primitive is called, whatever the outcome"; `src/service/status-end-to-end.test.ts` — "writes nothing: every graph is exactly as it was" |
| ST-AC-07 | `src/llm/capabilities/status/guard.test.ts` — "references that are missing, empty, too many, outside the entries"; `src/llm/capabilities/status/status.test.ts` — "a rejected reply is repaired once, and the usage of both is counted"; `src/llm/capabilities/status/status.test.ts` — "a second rejection is BAD_OUTPUT that says so"; `src/caci/controller-status.test.ts` — "a reply citing an entry that does not exist is repaired or refused" |
| ST-AC-08 | `src/caci/controller-status.test.ts` — "the context limits apply and are reported"; `src/caci/status-context.test.ts` — "stays within the character budget"; `web/status-page.test.mjs` — "says when some notes were left out" |
| ST-AC-09 | `src/caci/controller-status.test.ts` — "an hourly limit, counted when the model is about to be asked"; `src/caci/controller-status.test.ts` — "one status at a time per account"; `src/service/status-end-to-end.test.ts` — "one at a time per account"; `src/service/status-end-to-end.test.ts` — "the hourly limit comes from CACI_STATUS_PER_HOUR" |
| ST-AC-10 | `src/caci/controller-status.test.ts` — "reaches the model only as data"; `web/status-journey.test.mjs` — "markup in a note stays text"; `src/llm/demo-status.test.ts` — "a note that gives orders only ever becomes a quoted point" |
| ST-AC-11 | `src/llm/demo-status.test.ts` — "is deterministic: the same request gives the same answer" |
| ST-AC-12 | `web/status-page.test.mjs` — "forgets the answer, the typed request and the messages, and asks again on return"; `web/status-page.test.mjs` — "signing out forgets it too"; `web/status-session.test.mjs` — "reset forgets the answer, and an answer still on its way is dropped quietly"; `web/status-journey.test.mjs` — "the notice comes first" |

**Hand check in Chrome (T-191)** on the real service with the demo model: the notices, a request typed and sent by keyboard, the answer card with sources named, markup shown as text, no cookie or storage visible to the page, an injected script blocked, leaving the screen forgot the answer. Not looked at by eye: the suggestion buttons by keyboard, narrow and dark layouts, a screen reader, the real model.

### Residual risks (not covered, with the reason)

1. **The whole readable brain goes to Anthropic in one prompt** (within the budget), unanonymised; the release gates stand for anything beyond the family test.
2. **The model can still state something wrongly** or read a note too freely; the format and citations make it checkable, not correct.
3. **A status is only as good as what was captured**; there are no tasks or dates in the brain beyond what notes say.
4. **A request already running when a member is removed** may still use what was readable when it started.
5. **Time is the server's clock** with the person's declared time zone (not verified).
6. **Recency by item id** is approximate for items without `contributedAt`.
7. **Spending is bounded per account only.**
8. **The status screen was looked at by eye in one browser only**, with the demo model; narrow and dark layouts, a screen reader and the real model through the page were not tried.
9. **Quality is judged on six invented cases** (`npm run eval -- --capability status`); the real comparison of tiers has not been run, so `balanced` is a provisional default.
