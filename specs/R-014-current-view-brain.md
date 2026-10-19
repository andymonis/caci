# The Current-View Brain — Specification

Oct 19, 2026 · @Andy

**Status: built as V1 (T-215 to T-231); the owner's real before and after run of the brain evaluation is the measurement that decides whether it helps.** It follows the first real run of the brain evaluation (R-013, 2026-10-14), which showed that the brain stores both an old fact and the note that replaces it and leaves the model to decide which is current, and that it is a few points behind simply replaying the notes. The owner's decision: **the brain keeps only the current view; a new fact deletes the old information it replaces.**

## Overview

Today a note only ever adds. When a dose changes from `2 x Tablet A` to `1 x Tablet B`, both notes stay in the graph, both reach the model as context, and the model has to work out which one is current. Over months and years that would also fill the graph with stale information.

This specification changes what the brain stores:

1. **A note that changes an existing fact replaces it.** When a note is filed, the controller finds the existing items it may be about (the *candidates*), the categoriser may name which of them the note replaces, and on approval those items are deleted in the **same atomic write** that adds the new note.
2. **The graph and the context hold only the current view.** Status, browse and the shared brains all read the same graph, so none of them needs to change.
3. **A change log records what was added, removed and updated** (the *ledger*), so the person can review what happened, including the text of anything removed. The ledger is a review log. It is **not history**: history, and questions about it, are a separate, later question.

It applies to personal brains and to circle brains (R-009).

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** the brain holds **only the current view**. A new fact **deletes** the old information it replaces (not a flag, not a copy). | Keeps the graph clean, small and accurate over years; history is not the graph's job. |
| D2 | **Owner:** the replacement is **automatic**: there is no separate approval of removals. The note is still previewed and approved as today. | The owner's choice over a per-removal approval. |
| D3 | **Owner:** a **log of what was added, removed and updated** is kept for the person to review (the ledger). | Automatic deletion needs a way to see and correct what happened. |
| D4 | **Owner:** it applies to **personal and circle brains**. | The owner's choice. |
| D5 | **Owner:** the brain-eval scoring fix comes first (done in T-215), so before and after are comparable. | A fair baseline. |
| D6 | **The model never writes delete operations.** The categoriser's allowed operations stay `upsertNode` and `link`. It may add one field to its reply, **`replaces`**: a list of candidate **numbers** (the candidates are shown to it numbered from 1, without their ids, so an opaque id never has to be copied through the model's text). **The controller maps the numbers to the ids it found and builds the `deleteNode` operations.** (As built, the proposal view carries the removals as `summary.removed`: each replaced note's id, title and summary; the operations list also holds the `deleteNode` operations.) | A model that can only name numbers of things it was shown cannot delete anything else; the deletes are produced by trusted code from checked ids. |
| D7 | **Candidates** are found by the controller, not the model: the scope's own items ranked by shared whole words with the note (the same normalisation as the evaluation's matcher: case, numbers as digits, plurals), ties newest first then by id, **at most 8**, within a character budget (title and summary cut by character). An item sharing no word is never a candidate. Only the scope being written to is read. | Deterministic, cheap, testable, and cannot cross scopes. |
| D8 | **The guard accepts `replaces` only if** it is a list of at most `maxReplaces` whole numbers (control setting, default 5, range 0 to 20; **0 switches replacing off**), each from 1 to the number of candidates shown for this note, none repeated. With no candidates shown, or replacing switched off, the field is refused. Every problem is reported at once, as for the rest of the reply. A reply without `replaces` behaves exactly as today. | The guard is the authority, as for every other field. |
| D9 | **Only items are replaced directly.** After a successful write, **categories that were linked to a removed item and now have no items** are removed too ("tidy"), idempotently and never a category the new note links to. A failed tidy does not fail the approval. | Keeps the graph clean without letting the model delete categories. A grant (R-008) naming a removed category simply shows nothing. |
| D10 | **The preview lists what will be removed** (title and summary of each replaced item) and says so in plain words. It is shown for transparency; approving the note covers it. | The person should be able to see the effect before approving. |
| D11 | **Circles:** anyone who may capture in the circle (owner, manager, member) may replace any item in it, including another member's note; an observer cannot capture and so cannot replace. The role is re-read at approval as for any circle capture. | A circle brain is shared; the model only ever sees that circle's items as candidates. |
| D12 | **The ledger** records, after a successful write, one entry per change: `at`, `scope` (personal user or circle), `actor` (the session's user), `action` (`added`, `updated` or `removed`), the item id, and for a removal the **removed title and summary** (cut to 200 and 400 characters), plus the proposal id. Removed categories are logged as `removed` with their name. | A wrong deletion can be recognised and the information re-entered by hand. |
| D13 | **Retention:** `CACI_LEDGER_DAYS` (1 to 3650, default 90); older entries are removed at start-up and once a day. | The ledger must not grow for ever either. |
| D14 | **Who reads it:** the person for their personal ledger; anyone who may read the circle (any role) for a circle's ledger. A stranger, the administrator who is not a member, and a made-up circle get the identical "no such circle". | The scope rules of R-009. |
| D15 | **Storage:** a small `LedgerStore` of its own (new component `src/ledger/`), in `users.db` as **schema version 6**, with a memory store and a shared conformance suite; entries for a circle go when the circle is deleted, and a person's personal entries when their account is deleted. | The graph store's format stays unchanged; same pattern as circles. |
| D16 | **The graph write and the ledger append are in two databases**, so they are not one transaction. The write comes first; **a failed append never undoes the change** and is reported to the operator (once per proposal). | A missing log line is less harmful than refusing or undoing a correct change. A known gap, in the residual risks. |
| D17 | **Out of scope:** restoring from the ledger, history questions, replacing part of a note (an item is a whole note: a note with two facts replaces whole items or none), per-removal approval, the model deleting categories, and any change to the status context. | Keep it small. |
| D18 | **Measuring it:** the brain-eval records what each filing replaced and gains a **`lost at replace`** diagnostic and scenarios that add a different fact (which must replace nothing). A before and after run decides whether it helps. | An automatic deletion by a model can be wrong; it must be measured, not assumed. |

## Goals and non-goals

**Goals:** the old dose is gone when the new one arrives; the context sent to the model holds only what is current; every change can be reviewed; nothing can be deleted that the model was not shown from that scope.

**Non-goals:** history, undo, answering questions about old values, partial-note edits, a general edit or delete feature for people, and changing the shared-brain (R-008) rules.

## Definitions

- **Candidate**: an existing item of the scope, shown to the categoriser as possibly replaced by the note (D7).
- **Replaces**: the categoriser's list of candidate ids that the note makes out of date (D6, D8).
- **Tidy**: removal of categories left with no items after a replacement (D9).
- **Ledger entry**: the record in D12.

## The changed flow

1. `propose`: read the scope's categories (as today) and the **candidates** for the note (D7); `categorise` receives both.
2. The reply is checked by the guard (D8). The controller builds the mutation: the new note's operations plus **`deleteNode` for each replaced id**, checked by the real parser under the limits. `summarise` reports a `removed` list.
3. The proposal view gains `removes` (the replaced items' ids, titles and summaries). Nothing is written.
4. `approve`: one atomic `write` (adds and deletes together; a failing operation leaves both undone). A candidate already gone is a no-op. Then **tidy** (D9), then the **ledger append** (D12, D16).
5. The result tells the person what was removed and tidied.

## Requirements

| ID | Requirement |
|----|-------------|
| CV-FR-01 | Candidates come from the target scope's graph only, are ranked as D7, and never exceed 8 or the character budget. |
| CV-FR-02 | The categoriser reply may carry `replaces`; the guard enforces D8; with `maxReplaces` 0 or no `replaces` the proposal is exactly today's. |
| CV-FR-03 | The model cannot cause the deletion of anything that was not shown as a candidate, anything that is not an item, or anything in another scope. |
| CV-FR-04 | The new note and the removals are one atomic write; two proposals replacing the same item both succeed. |
| CV-FR-05 | The preview and the approval result say what is removed and tidied. |
| CV-FR-06 | Tidy removes only categories left with no items that were linked to a removed item, and never one the new note links to. |
| CV-FR-07 | In a circle, the capture right decides (D11); an observer, a stranger and a made-up circle get today's answers. |
| CV-FR-08 | The ledger records the changes of D12 after a successful write, never before, never for a proposal that wrote nothing, and a failed append never undoes the change. |
| CV-FR-09 | The ledger can be read newest first, paged, by those allowed (D14), through the CaCi controller, a route and a web screen. |
| CV-FR-10 | Entries older than `CACI_LEDGER_DAYS` are removed; a deleted circle's and a deleted account's entries go with them. |
| CV-FR-11 | The brain-eval measures replacements, wrong deletions and the new scenarios (D18). |
| CV-NFR-01 | No new dependency. |
| CV-NFR-02 | Nothing in the ledger or the preview reveals a graph id, another scope's content or a secret. |
| CV-NFR-03 | The candidate search over a graph of 5,000 items takes well under a second. |
| CV-NFR-04 | The categoriser's controls (wording and `maxReplaces`) stay in the `controls/` folder (R-012); the golden files change deliberately and are reviewed. |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| A note (or a model reply) tries to make the model delete something it was not shown | The model only names numbers; the guard accepts only numbers of candidates shown; the controller maps them to the ids it found and builds the deletes, and checks them again. | `src/llm/capabilities/categorise/guard.test.ts` — "refuses a number outside the range, a repeat, a fraction, text and a list that is not a list, listing every problem"; `src/app/replace.test.ts` — "a number that was not shown is refused by the guard and repaired, so a bad number never reaches a delete"; `src/app/replace.test.ts` — "candidates: false shows nothing and any replaces is refused" |
| A hostile note names item ids or graph ids in its text | Ids in the note are data; only the `replaces` field of the structured reply is read, and only against the candidate list. | `src/app/replace.test.ts` — "the model\'s text cannot name an id: only numbers count, ids in the note or the reply are data"; `src/llm/demo-replace.test.ts` — "1,500 random notes and lists of existing notes: none refused, none needing a repair, replaces always in range" |
| Replacing across scopes | Candidates are read from the target scope's graph only; the deletes go to that graph only; a recording adapter proves it. | `src/app/replace.test.ts` — "another graph\'s matching note is never shown and never deleted"; `src/app/candidates.test.ts` — "reads only the graph it is given, and calls no write primitive"; `src/caci/controller-replace.test.ts` — "a circle never reads or removes the personal brain, nor another circle"; `src/service/current-view-end-to-end.test.ts` — "nobody else\'s notes are touched, shown, or logged: the same words in another person\'s brain stay" |
| A wrong automatic deletion loses a fact | Caps, candidate-only, the preview, the ledger with the removed text, and the evaluation's `lost at replace` measure. | `src/app/replace.test.ts` — "is all or nothing: if the write fails the old note is still there and the proposal can be tried again"; `src/caci/controller-ledger.test.ts` — "the dose story: the new note is added, the old note removed with its text, the emptied category removed, newest first"; `dev/brain-eval/brain-arm.test.mjs` — "a model that replaces everything it is shown is caught: the fact is gone from the brain, the question fails and the diagnostic says replace"; `dev/brain-eval/library.test.mjs` — "a filing model that replaces everything it is shown fails the new scenarios, and the diagnostic says the fact was deleted" |
| The ledger leaks across scopes | Entries are keyed by scope; reads use the R-009 scope rules; strangers get the made-up-circle answer. | `src/caci/controller-ledger.test.ts` — "a stranger, a person in another circle only and a made-up circle get exactly the same answer"; `src/api/ledger-routes.test.ts` — "a person in no circle, the administrator and a made-up circle all get the same 404"; `src/ledger/testing/cases.ts` — "scopes never mix: each person and each circle sees only its own entries"; `web/ledger-service.test.mjs` — "a stranger and a made-up circle read the same; a person who left is told so; paging works" |
| Ledger growth | Retention (D13), cleanup on circle and account deletion. | `src/service/current-view-end-to-end.test.ts` — "the log is kept for CACI_LEDGER_DAYS: older entries are removed at start-up, newer ones stay"; `src/service/current-view-end-to-end.test.ts` — "an account deleted takes its personal log with it; a circle deleted takes its log"; `src/ledger/sqlite/sqlite-store.test.ts` — "deleting a circle row removes that circle\'s entries only, whoever deletes it" |
| Two databases get out of step | Write first, then log; failure of the log is reported and never undoes the change. | `src/service/current-view-end-to-end.test.ts` — "a change log that cannot record: the note is still filed, the operator is told once, with no notes or ids in the sentence"; `src/caci/controller-ledger.test.ts` — "a write that fails records nothing and the proposal is still pending" |

## What the person is told

- Preview: "This note replaces: <title>. The old note will be removed when you approve." (one line per replaced item).
- After approval: "Removed 1 note and 1 empty category."
- Ledger screen: "A review log of changes, kept for N days. It is not a history of your notes."

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| CV-AC-01 | Given a note "Mum now takes 1 x Tablet B a day" and an existing note "Mum takes 2 x Tablet A a day", when the note is proposed with the demo model, then the old note is a candidate and the proposal replaces it. |
| CV-AC-02 | Given that proposal, when it is approved, then the new note exists, the old note and its links are gone, in one write. |
| CV-AC-03 | Given a reply that names a number that was not shown as a candidate, when it is checked, then it is refused with the problem listed. |
| CV-AC-04 | Given `maxReplaces` 0, when any note is proposed, then the proposal equals today's. |
| CV-AC-05 | Given a category whose only item was replaced, when the approval finishes, then the category is gone; a category the new note links to stays. |
| CV-AC-06 | Given a circle, when a member replaces another member's note, then it works; an observer's attempt is refused as a stranger's is. |
| CV-AC-07 | Given a note that only adds a different fact, when it is proposed, then it replaces nothing. |
| CV-AC-08 | Given an approval, when it succeeds, then the ledger holds the added, updated and removed entries with the removed text. |
| CV-AC-09 | Given a failing ledger store, when an approval succeeds, then the change stands and the operator hook is told. |
| CV-AC-10 | Given the ledger of a circle, when a stranger, the administrator or a made-up circle asks, then the answer is the made-up-circle 404. |
| CV-AC-11 | Given old entries, when the retention period passes, then they are removed. |
| CV-AC-12 | Given the evaluation library, when the brain-eval runs, then it reports replacements, wrong deletions and the new scenarios. |

### Where each criterion is checked (T-231)

| ID | Tests |
|----|-------|
| CV-AC-01 | `src/llm/demo-replace.test.ts` — "the new dose replaces the old one"; `src/app/replace.test.ts` — "shows the model the old note, names it in the proposal, and the preview says it will be removed"; `src/caci/controller-replace.test.ts` — "the new dose replaces the old note: the preview says so, and after approval only the new note is there" |
| CV-AC-02 | `src/app/replace.test.ts` — "proposing writes nothing, not even a delete; approving removes the old note and its links and adds the new one in one write"; `src/service/current-view-end-to-end.test.ts` — "the new dose replaces the old: browse and status no longer show the old dose, and the change log shows what happened" |
| CV-AC-03 | `src/llm/capabilities/categorise/guard.test.ts` — "refuses a number outside the range, a repeat, a fraction, text and a list that is not a list, listing every problem"; `src/llm/capabilities/categorise/categorise.test.ts` — "without existing notes the model is not offered replaces, and naming it is refused" |
| CV-AC-04 | `src/app/replace.test.ts` — "maxReplaces 0 in the controls gives exactly today\'s proposals"; `src/service/current-view-end-to-end.test.ts` — "with replacing switched off in the controls (maxReplaces 0) every note is only added and the preview says nothing about removing"; `src/llm/capabilities/categorise/categorise.test.ts` — "with replacing switched off in the controls, existing notes are not sent and replaces is refused" |
| CV-AC-05 | `src/app/replace.test.ts` — "a category left with no notes is removed, one that still has notes stays, and the result names what was removed"; `src/app/replace.test.ts` — "a category the new note links to stays even if the replaced note was its only other one"; `src/app/replace.test.ts` — "a tidy that fails does not fail the approval; the operator is told, once" |
| CV-AC-06 | `src/caci/controller-replace.test.ts` — "a member replaces a note that another member wrote"; `src/caci/controller-replace.test.ts` — "an observer cannot capture at all, so cannot replace: the same answer a stranger gets, and nothing changes"; `src/caci/controller-replace.test.ts` — "a member demoted to observer after the preview cannot approve it: the old note stays" |
| CV-AC-07 | `src/app/replace.test.ts` — "a note that only adds replaces nothing, even though candidates were shown"; `src/llm/demo-replace.test.ts` — "a note that only adds a different fact replaces nothing, even about the same person"; `dev/brain-eval/library.test.mjs` — "a careful model over the demo filing, replacing on, passes the new scenarios and replaces nothing in them" |
| CV-AC-08 | `src/caci/controller-ledger.test.ts` — "the dose story: the new note is added, the old note removed with its text, the emptied category removed, newest first"; `src/caci/controller-ledger.test.ts` — "a first note: the note and the category it made were added, by the person, with the proposal and the time"; `src/caci/controller-ledger.test.ts` — "a circle change is recorded in the circle\'s log, by the member who made it, and not in anyone\'s personal log" |
| CV-AC-09 | `src/service/current-view-end-to-end.test.ts` — "a change log that cannot record: the note is still filed, the operator is told once, with no notes or ids in the sentence"; `src/caci/controller-ledger.test.ts` — "a hook that throws changes nothing" |
| CV-AC-10 | `src/caci/controller-ledger.test.ts` — "a stranger, a person in another circle only and a made-up circle get exactly the same answer"; `src/api/ledger-routes.test.ts` — "a person in no circle, the administrator and a made-up circle all get the same 404"; `web/ledger-service.test.mjs` — "a stranger and a made-up circle read the same; a person who left is told so; paging works" |
| CV-AC-11 | `src/service/current-view-end-to-end.test.ts` — "the log is kept for CACI_LEDGER_DAYS: older entries are removed at start-up, newer ones stay"; `src/ledger/testing/cases.ts` — "purgeBefore removes entries strictly older than the time, says how many, and keeps the rest" |
| CV-AC-12 | `dev/brain-eval/brain-arm.test.mjs` — "the filing record of a replacing note names the removed note; the others replace nothing"; `dev/brain-eval/report.test.mjs` — "says what replacing did: notes that replaced, older notes removed, categories tidied, answers lost to a deletion"; `dev/brain-eval/library.test.mjs` — "the two new scenarios add a different fact and must not replace anything"; `dev/brain-eval/compare.test.mjs` — "shows replacements, tidied categories and answers lost to a deletion for each run, and whether replacing was off" |

Also checked on the web: `web/replace-journey.test.mjs` — "previews the removal, changes nothing until approved, then the old note is gone and the outcome says so" and `web/replace-journey.test.mjs` — "the change-log screen shows the replacement: what was removed, said in full, and who made the change".

### Residual risks (not covered, with the reason)

1. **An automatic deletion by a model can be wrong** and lose a fact; it is bounded (at most 5 replaced, candidates only, the same scope) and logged with the removed text, not prevented. The evaluation measures it (`lost at replace`), and the owner's real run decides whether it helps.
2. **Delete-and-replace takes unchanged details with it.** The new note replaces the whole old note, so a detail the old note held and the new one does not repeat (the ward of a moved appointment, a phone number in a note about the address) is gone. The demo filing shows this on six questions of the library; whether a real model restates unchanged details is what the real run measures. A mitigation (restating or carrying details) is in the Backlog.
3. **The ledger is not history** and is not used to answer questions; it is kept for `CACI_LEDGER_DAYS` (default 90) and older entries are forgotten. The screen says so in the page's own words, without the number, because the setting is not sent to the browser.
4. **The candidate search is word overlap**: a paraphrase with no shared word is not found, so the old note stays (a stale fact remains, which the status model still has to resolve).
5. **Two databases are not one transaction** (D16): a failed ledger append leaves a change unlogged, reported once to the operator; a failed tidy leaves an empty category until the next time.
6. **A circle member can replace another member's note** (D11). The ledger shows who did it, but nothing asks the author.
7. **The ledger and the removed text are plain text** in `users.db`, like everything else, readable by whoever can read the file, and by every member who may read a circle's ledger.
8. **An item is a whole note**: a note with several facts replaces whole items or none.
9. **The preview shows the removals but a person may not read them**; approving covers them (D2).
10. **The hand check in a browser was not repeated for the ledger screen**: the page logic is tested through the real mount and the real service, but no real browser was used for T-227 or T-229, and the real model path (which decides what is actually replaced) is the owner's run.
