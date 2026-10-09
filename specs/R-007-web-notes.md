# Web App: Notes — Specification

Oct 9, 2026 · @Andy

## Overview

The web app (R-005, R-006) gains **capturing a note** and **browsing your own brain**. It uses only routes that already exist (R-003) plus one small read-only addition (`GET /api/capture/mode`, D6). It is still plain HTML, CSS and JavaScript with no build step, served from a fixed list of files under the same strict policy (R-005).

**Capture** is the flow of R-003: type a note, the model proposes how to file it, the person sees a **preview**, and **nothing is written until they approve**. **Browse** is read-only: the categories (with how many items each holds), the items in a category, and one item with its categories.

**Which model files the note must be visible.** In the default `demo` mode nothing leaves the machine. In `anthropic` mode the note, and the names of the person's existing categories, are sent to Anthropic and are **not anonymised** (R-003, README). The page says which one applies, on the capture screen and on the preview, before and after a note is sent.

## Decisions (owner, 2026-10-09, and proposals marked)

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Owner:** browsing is **read-only and limited** to the categories, the items in a category, and one item with its categories; no editing, deleting, moving, search, counts screen or drawn map | The three read routes that exist; editing and answering questions are later work (R-003 non-goals) |
| D2 | **Owner:** the page **shows which model files the note** from the `mode` the service reports, as a plain notice; **no confirm tick** | The README's wording must reach the screen; the earlier per-account consent stays declined (C1) |
| D3 | **Owner:** **two separate screens**, *Capture* and *Brain*, each with its own link in the navigation | Filing and browsing are different jobs |
| D4 | **Proposed:** addresses `#/capture` and `#/brain` only. **A selected category or item is page state, not an address** | Node ids are opaque (any text, including characters an address cannot carry safely) and travel in query strings (R-003 D6), never in a path or the hash; a copied link to one category is not worth a second encoding rule |
| D5 | **Proposed:** the page holds **one proposal at a time**; the service may hold up to 10 pending per person (R-003), and a restart or expiry forgets them, which the page says in words with a way back to the form | A single preview is the simplest honest flow; a list of pending proposals is a later feature |
| D6 | **Proposed:** one small service addition, **`GET /api/capture/mode`** (signed in; answers `{ "mode": "demo" \| "anthropic" }` and nothing else) | The warning must show **before** the first note is sent, and today the mode is only seen on a proposal |
| D7 | **Proposed:** the note is checked early (1 to 8,000 characters after trimming); the service stays the authority | Same rule as every other form |
| D8 | **Proposed:** the preview shows the service's own `text`, `summary`, `operations` and `rationale` **as plain text only**, with the time it expires; the page never builds markup from them | The model's output and the person's note are untrusted text (R-005 D7) |
| D9 | **Proposed:** the model's failures (timeout, refusal, busy, error), the limits (proposals per hour, pending) and a write refused are shown in the **fixed words the service already sends**, with the wait when it gives one | One place decides what a failure looks like (R-003) |
| D10 | **Proposed:** approving shows how many operations were written and what they were, **marks the brain view out of date** (it reloads on its next visit), and clears the preview; a failed approve **keeps the proposal** so it can be retried or rejected | The service keeps it too (R-003 FR-05) |
| D11 | **Proposed:** a proposal is held in memory only and **forgotten on sign-out or when the person leaves the Capture screen**; the service's copy expires on its own (15 minutes) | Same memory-only rule as circles (R-006 D16) |
| D12 | **Proposed:** a category or item is shown with its data **as text**; a value the service shortened is **marked as shortened**; an id that is gone reads "not found" in one set of words | The service caps data (R-003 FR-13); the page must not pretend it is whole |
| D13 | **Proposed:** each screen's main heading takes the focus and the title follows; every control works from the keyboard; controls are disabled while a request is out | Same as R-006 D13 and WC-FR-15 |
| D14 | **Proposed:** nothing is kept in the browser; the page reads no cookie | R-005 D9 |

D1 to D3 are the owner's answers; D4 to D14 are proposals that stand unless changed.

## Goals and non-goals

Goals:
1. A person can file a note from the page: type it, read the preview, approve or reject.
2. A person always knows, before sending, which model will see their note and what then leaves the machine.
3. A person can look through what they have filed: categories, the items in one, one item.
4. Nothing the model or the person wrote can run as code; nothing proposed is written until approved.

Non-goals (not here):
- Editing, deleting or moving items or categories; search; a counts screen; a drawn map of the graph.
- Several proposals at once, or a list of pending proposals.
- A confirm tick or per-account consent before notes go to Anthropic.
- Picture or voice input; answering questions from the graph.
- Anonymising notes (the pseudonymisation milestone in the Backlog); this spec only makes the lack of it visible.
- Addresses for a selected category or item; links to one; the offline or installable app.

## Definitions

- **Mode**: `demo` (the free built-in stand-in; nothing leaves the machine) or `anthropic` (the real model; the note and category names go to Anthropic). Chosen by the operator for every account at once (R-003 D3).
- **Proposal**: what the model suggests, held by the service until approved, rejected or expired (R-003).
- **Brain**: the person's own graph, reached only through their session.

## Screens

| Address | Shows | Can do |
|---|---|---|
| `#/capture` | the mode notice; a note box with a character count; after proposing, the preview (summary lines, the operations, the rationale, which categories are new or reused, when it expires); the outcome | propose, approve, reject, start another |
| `#/brain` | the categories (name, how many items, "show more"); choosing one shows its items with a way back; choosing an item shows its data and its categories with weights, with a way back | choose, go back, show more |

Home keeps its temporary page and gains links to both.

### The mode notice

| Mode | Words |
|---|---|
| `demo` | "Filed by the free demo model: nothing leaves this machine." |
| `anthropic` | "Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised." |
| not known yet, or the mode could not be read | "Could not tell which model files your notes." and the Propose button stays **disabled** until the mode is known |

The notice is shown on the capture screen before anything is sent, and again on the preview, using the `mode` the proposal itself carries.

## Functional requirements

| ID | Requirement |
|----|-------------|
| WN-FR-01 | **Mode**: the capture screen asks the service for the mode when it is shown and shows the notice above; Propose is disabled until the mode is known; a failure to read it is shown in words with a way to try again |
| WN-FR-02 | **Propose**: the note is trimmed and checked (1 to 8,000 characters) with its problem beside the field; on success the preview replaces the form; the note is never sent when the early check fails |
| WN-FR-03 | **Preview**: shows the service's text, summary, operations and rationale as plain text, which categories are new or reused, a problem list if the summary has problems (and says approving may be refused), and the expiry time |
| WN-FR-04 | **Approve**: writes through the service; the outcome says how many operations were written and what they were; the brain view is marked out of date; a refused write (409) keeps the proposal with the service's words |
| WN-FR-05 | **Reject**: discards the proposal; the outcome says nothing was written |
| WN-FR-06 | **Gone proposals**: an expired proposal, or one the service no longer has (a restart), is said in words with a button to start again; nothing is retried automatically |
| WN-FR-07 | **Limits and failures** are shown in the service's fixed words: per-hour limit and pending limit with the wait, the model timing out, refusing, busy or failing, a storage fault; the note is kept in the box so it can be sent again |
| WN-FR-08 | **Categories**: listed by id with name and item count ("at least" when the service says the count is capped), "show more"; an empty brain says to capture a note, with a link |
| WN-FR-09 | **A category's items**: listed with their data as text, "show more", a way back to the categories |
| WN-FR-10 | **One item**: its data as text, its categories with weights (and "more" when the service cut the list), a way back |
| WN-FR-11 | **Out of date after approve**: the brain view reloads on its next visit; every other action reloads what it changed |
| WN-FR-12 | **One request at a time** per screen: controls are disabled while a request is out and a second click does nothing |
| WN-FR-13 | **Nothing outlives its screen**: a proposal and the brain's data are forgotten on sign-out; the proposal also when the person leaves the capture screen |
| WN-FR-14 | **Refusals in words**: 401 returns to the sign-in screen; 404 and 410 for a proposal say it is gone; 404 for a category or item says "not found" in one set of words; 422 shows beside the field; 429 shows the wait; 5xx shows the service's fixed words |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| WN-NFR-01 | **Text only**: no `innerHTML` or its relatives; rows and the preview come from templates filled with `textContent`; the guard tests of R-005 and R-006 still pass and cover the new files |
| WN-NFR-02 | **Ids are checked**: a proposal id must match the shape the service makes before it reaches a path; a category or item id is any non-empty text of at most 256 characters and travels only in the query string, encoded; nothing else reaches a path |
| WN-NFR-03 | **No graph or user id is ever sent**: the page never names a graph; the service takes it from the session (R-003 FR-02) |
| WN-NFR-04 | **No browser storage and no cookie access**, as before |
| WN-NFR-05 | **No dialogs**: no `alert`, `confirm` or `prompt` |
| WN-NFR-06 | **Accessible**: labelled fields, the main heading takes the focus, the preview and outcome are announced, controls work from the keyboard, light and dark, phone width |
| WN-NFR-07 | **The model is never named**: the page shows the mode, not a model name, usage, tokens, prompts or raw output (the service does not send them) |
| WN-NFR-08 | **No change to the policy**: the new files are served like the rest under the existing policy |

## Threats and controls

Each row names the tests that cover it. `src/service/review.test.ts` fails the build if a named test file or test disappears.

| Threat | Control | Covered by |
|--------|---------|------------|
| The note, the model's rationale, a category or item name or data run as code | Text only through templates and `textContent`; the strict policy as the second line (D8, WN-NFR-01) | `web/capture-page.test.mjs` — "markup in the note, the model"; `web/brain-page.test.mjs` — "markup in names and titles stays text"; `web/brain-view.test.mjs` — "is key and value in order, text as it is and anything else as JSON"; `web/pages.test.mjs` — "no script uses %s"; `web/pages.test.mjs` — "there are ten row templates"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| A proposal id, category id or item id used to build a path | Exact shape for proposal ids; category and item ids only in the encoded query string, never in a path or the address (D4, WN-NFR-02) | `web/notes-client.test.mjs` — "a proposal id has the shape the service makes and nothing else"; `web/notes-client.test.mjs` — "a bad proposal id is"; `web/notes-client.test.mjs` — "category and item ids go only in the query string, encoded"; `web/service.test.mjs` — "with awkward ids and more than a page"; `web/brain-page.test.mjs` — "an awkward id is sent in the query string, encoded" |
| A notice that misleads about where the note goes | The notice comes from the service's `mode`, is shown before sending and again on the preview, and Propose is disabled until it is known (D2, D6, WN-FR-01) | `web/capture-view.test.mjs` — "says each mode in the words the spec gives"; `web/capture-view.test.mjs` — "the preview uses the mode the proposal carries"; `web/capture-page.test.mjs` — "says which model files notes before a note is sent"; `web/capture-page.test.mjs` — "while the mode is unknown nothing can be proposed"; `web/capture-session.test.mjs` — "starts unknown and nothing can be proposed" |
| Approving twice, or approving a stale preview | One request at a time; the service takes the proposal out on approval; a gone or expired proposal is said in words (D10, WN-FR-12) | `web/capture-session.test.mjs` — "a second proposal is refused while one is pending"; `web/capture-session.test.mjs` — "every action is refused while one is out"; `web/capture-session.test.mjs` — "end in words and nothing is written"; `web/capture-page.test.mjs` — "while a request is out the controls are disabled and a second submit does nothing"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| A note sent when the person did not mean to | Nothing is sent until Propose; nothing is written until Approve; Reject discards (WN-FR-02, WN-FR-04) | `web/capture-session.test.mjs` — "holds the one current proposal and shows the preview; nothing is approved"; `web/capture-page.test.mjs` — "shows the preview as text"; `web/capture-page.test.mjs` — "rejecting writes nothing, says so, and keeps the note for editing"; `web/service.test.mjs` — "mode, propose, preview, reject (nothing written)" |
| A request naming someone else's graph or proposal | The page never sends a graph or user id; a proposal that is not yours is the same 404 as a made-up one (WN-NFR-03, R-003) | `web/service.test.mjs` — "mode, propose, look, approve, browse, and nobody else can reach any of it"; `web/service.test.mjs` — "a stranger sees none of it"; `web/notes-client.test.mjs` — "a proposal keeps only its own fields"; `web/notes-client.test.mjs` — "only a trimmed note is sent in propose, and nothing else" |
| Notes or categories kept where they can be read later | Memory only; forgotten on sign-out and on leaving the capture screen (D11, D14, WN-NFR-04) | `web/pages.test.mjs` — "nothing is kept in the browser and nothing is sent anywhere else"; `web/capture-page.test.mjs` — "going to another screen forgets the proposal and the typed note"; `web/capture-page.test.mjs` — "signing out forgets everything, and signing in as someone else starts clean"; `web/brain-page.test.mjs` — "signing out forgets the brain" |
| A model failure or limit exposing inside detail | Only the service's fixed words are shown, never a provider's text (D9) | `web/notes-client.test.mjs` — "failures are kind model with a reason"; `web/notes-client.test.mjs` — "anything else, an unreachable service and a broken answer"; `web/capture-page.test.mjs` — "refusals show at the top in its words"; `web/service.test.mjs` — "a refused note and a full pending list" |

## What the person is told

| Situation | What the page shows |
|-----------|---------------------|
| 401 | The sign-in screen, with "Your session has ended. Sign in again." |
| 404 on a proposal, or 410 | "That proposal is gone or has expired. Make it again." with a button to start again |
| 404 on a category or item | "Not found: it may have been removed." and a way back |
| 409 on approve | The service's words ("this proposal can no longer be applied …"); the proposal stays, with Approve and Reject |
| 422 | The service's message beside the note box |
| 429, a limit | The service's message ("you have made the most proposals allowed in an hour", "you have too many proposals waiting …") |
| 429, a wait | The wait in seconds, from the service |
| 502 or 503 (the model) | The service's fixed words ("the model took too long: try again" and so on); the note stays in the box |
| 500, or the service cannot be reached | The same words as R-005 |

## Files

The new files are chosen in T-130 to T-135 (a notes client, the capture and brain logic, and the pages' code). Each is added to the fixed list in `src/service/web-app.ts` and to the README's file table in the task that adds it, and the packaging check follows.

## Acceptance criteria

| ID | Check |
|----|-------|
| WN-AC-01 | Before any note is sent the capture screen says which model files it (demo or Anthropic) in the words above; Propose is disabled until the mode is known. |
| WN-AC-02 | A note is proposed and the preview shows its summary, operations and rationale as plain text with the expiry time and the mode notice; nothing is written yet. |
| WN-AC-03 | Rejecting leaves the brain exactly as it was. |
| WN-AC-04 | Approving writes the operations; the outcome says how many; the new category and item then appear on the Brain screen. |
| WN-AC-05 | A second person sees nothing of the first person's proposal, categories or items, by any id. |
| WN-AC-06 | An expired or forgotten proposal is said in words and can be started again; approving it writes nothing. |
| WN-AC-07 | Each model failure and each limit shows the service's fixed words (and the wait where given), and the note stays in the box. |
| WN-AC-08 | The Brain screen lists categories with counts, then a category's items, then one item with its categories, each with a way back; awkward ids (spaces, markup, slashes, emoji, 256 characters) work. |
| WN-AC-09 | A note, a category name or a rationale made of markup is shown as plain text and nothing runs; a hostile hash is home. |
| WN-AC-10 | Each screen's heading takes the focus and the title follows; every control works from the keyboard; the browser reports no policy violation. |

### Where each criterion is checked (T-137)

| ID | Covered by |
|----|------------|
| WN-AC-01 | `web/capture-page.test.mjs` — "says which model files notes before a note is sent"; `web/capture-page.test.mjs` — "while the mode is unknown nothing can be proposed"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-02 | `web/capture-page.test.mjs` — "shows the preview as text"; `web/capture-session.test.mjs` — "holds the one current proposal and shows the preview; nothing is approved"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-03 | `web/capture-page.test.mjs` — "rejecting writes nothing, says so, and keeps the note for editing"; `web/service.test.mjs` — "mode, propose, preview, reject (nothing written)"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-04 | `web/capture-page.test.mjs` — "approving writes, says how many operations"; `web/brain-page.test.mjs` — "an approved note makes the next visit reload the categories"; `web/service.test.mjs` — "mode, propose, look, approve, browse, and nobody else can reach any of it"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-05 | `web/service.test.mjs` — "a stranger sees none of it"; `web/service.test.mjs` — "mode, propose, look, approve, browse, and nobody else can reach any of it"; `web/brain-page.test.mjs` — "signing out forgets the brain" |
| WN-AC-06 | `web/capture-page.test.mjs` — "an expired proposal and one the service forgot end in words and write nothing"; `web/capture-session.test.mjs` — "end in words and nothing is written"; `web/service.test.mjs` — "a proposal the service no longer has ends in words, and nothing is written"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-07 | `web/capture-page.test.mjs` — "refusals show at the top in its words"; `web/capture-session.test.mjs` — "a refusal shows the service"; `web/notes-client.test.mjs` — "failures are kind model with a reason"; `web/service.test.mjs` — "a refused note and a full pending list" |
| WN-AC-08 | `web/brain-page.test.mjs` — "opens with its items (title, summary, shortened mark)"; `web/brain-page.test.mjs` — "shows its data as text and the categories it is filed under with weights"; `web/brain-session.test.mjs` — "keeps the shortened mark on an item"; `web/service.test.mjs` — "with awkward ids and more than a page" |
| WN-AC-09 | `web/capture-page.test.mjs` — "markup in the note, the model"; `web/brain-page.test.mjs` — "markup in names and titles stays text"; `web/service.test.mjs` — "the notice first, a preview that writes nothing" |
| WN-AC-10 | `web/capture-page.test.mjs` — "takes the focus and the title"; `web/brain-page.test.mjs` — "shows the screen with the focus and the title"; `web/pages.test.mjs` — "the navigation and heading elements exist"; `web/pages.test.mjs` — "the note box is a labelled text area"; `web/pages.test.mjs` — "follows the system theme, shows keyboard focus, respects reduced motion, and copes with a narrow window" |

The whole journey was also looked at by hand in Chrome against the real service (recorded in `.gsd/STATE.md`, T-136): registering and landing on the requested Capture screen, the notice, a note made of markup proposed by keyboard, the preview with its operations, reason and expiry as text, reject, file another, approve, the Brain loaded afresh after the write, a category, an item with its data and weight, Back at each level with the focus, a hostile hash, and an injected script being blocked.

### Residual risks (not covered, with the reason)

These are real and known; the ones that can be acted on are in the PLAN Backlog.

1. **The notice cannot know what the operator changes later.** The mode is read each time the capture screen is shown, so a change while a person is on it is seen only on their next visit; the preview repeats the mode its own proposal carries, which is the one that was used.
2. **In `anthropic` mode every note and the names of the person's categories go to Anthropic, unanonymised.** The page says so, in the words above, but offers no way to decline for one note and no consent step (the owner chose a notice only); the pseudonymisation work in the Backlog is what would change this.
3. **A pending proposal is held only in memory, for 15 minutes.** A restart, an expiry or leaving the screen forgets it; the page says so and keeps the note in the box when it can, but a long wait costs the person the preview, and the model call.
4. **The demo model is not a classifier.** It files by word overlap; the preview is where a person catches a poor filing, and approving a poor one is the person's choice. A real-model evaluation is in the Backlog.
5. **Times are the service's clock, shown in UTC.** A person whose own clock differs may see an expiry that does not match their watch; the service decides, and the page never acts on its own clock.
6. **A selected category or item is page state, not an address.** A person cannot copy a link to one, and a reload returns to the list; chosen deliberately because node ids are opaque.
7. **The Brain is kept while a person moves between screens, so it can be as old as its last load.** It reloads after the person's own approved notes and on Refresh, but not after a write made elsewhere (another tab, another device); the service stays the authority and every open reads the current data.
8. **Two tabs of the same person do not know about each other**, so approving a note in one does not update the other's Brain until Refresh.
9. **Per-hour and pending limits are counted in memory by the service.** A restart resets them (R-003 residual risk), and the page only shows the service's answer.
10. **What was looked at by eye is one browser on one machine.** Narrow and dark layouts and a screen reader were not tried by hand, and the real model path was not exercised through the page (it needs a key and sends notes out); they are covered by checks on the structure and by the earlier real-model evaluation of the service, not by assistive technology or a live provider.

## Build order

T-128 this specification; T-129 the mode route; T-130 the notes client; T-131 capture logic; T-132 brain logic; T-133 router, navigation and home links; T-134 the capture page; T-135 the brain page; T-136 serving it, end to end and a hand check; T-137 the security review; T-138 the README.
