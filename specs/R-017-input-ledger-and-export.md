# The Input Ledger and the Brain Export — Specification

Oct 21, 2026 · @Andy

**Status: L2 (T-258 to T-265) built; part 2, tracing a fact to its words, is being built as L3 (T-266 to T-273). D1 to D4 and D15 are the owner's (2026-10-21), the rest are mine and stand unless changed.** It extends the change ledger of `specs/R-014-current-view-brain.md` and adds an operator command that exports a brain.

## Overview

Two things the owner asked for after trying CaCi on the Raspberry Pi:

1. **Keep the words that were typed.** The brain stores the facts extracted from an update (a title, a summary, a key) but not the update itself, so after the fact you cannot see what was entered, and a fact that changed cannot be checked against the words that changed it. The change ledger already records *what* changed and *who* did it; it now also records **the text of each update as sent**.
2. **Export a brain** (a person's own, or a circle's) so real notes can be used as test input to improve the model's answers, which the owner finds *mechanical, very long and containing information that is not relevant*. The export is an **operator command** on the data folder, not a feature members use.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** the ledger keeps **the text of every update (Send) as sent**. Questions and Pulses are **not** kept. | What built the brain is what is needed to confirm a change and to replay it. |
| D2 | **Owner:** **everyone who can read a brain's change log can read the input text**: the owner for their own brain; the members and observers of a circle for the circle's. | The same rule as the log today, and as "everyone in this circle can read what is added here". |
| D3 | **Owner:** the export is an **operator command on a snapshot**: no new server route and no member-facing download. | Real notes leave the service only by the operator's hand. |
| D4 | **Owner:** **no redaction option** for now (Backlog). | The owner's own data; the privacy position is unchanged. |
| D5 | The input is **one ledger entry per approved update**, kind `input`, `action: added`, `subject` the proposal id, with the optional field `text` (1 to 8,000 characters, counted as characters; required for `input`, refused on any other kind). | One note can make several facts; the words are stored once. |
| D6 | The `input` entry is written **in the same batch as the facts of the same approval, one millisecond before them**, so in the newest-first log it sits directly under the facts it produced. | Adjacent without a new grouping field. |
| D7 | users.db **schema 7** adds the `text` column and the `input` kind to the ledger table, upgrading a version 6 file without touching existing rows. The triggers that remove a person's and a circle's entries still apply. | One database, one migration path. |
| D8 | Retention follows **`CACI_LEDGER_DAYS`** (default 90). Deleting an account removes its personal entries (inputs included) and deleting a circle removes the circle's. The export reads a snapshot, so take one (or export) before entries expire. | No new setting; the export is the long-term copy. |
| D9 | A failed or throwing append never undoes or refuses the change (as today); nothing is recorded for a proposal only made, rejected, refused, failed, or approved twice. | Same discipline as R-014 D17. |
| D10 | `GET /api/ledger` answers `input` entries with the same scope, paging and not-found rules as facts. The change-log screen shows an input as *Entered by <name>: "<text>"* next to its facts, as text only. | One route, one rule. |
| D11 | The export **takes its own consistent snapshot** of `graphs.db` and `users.db` into a temporary owner-only folder, reads from that, and removes it (also on failure). The live files are never opened for writing. | Safe while the service runs; no half-written transaction. |
| D12 | The export is **one JSON document** `{ format: 'caci-brain-export', version: 1 }` holding the facts (id, title, summary, key, author as username, time), the categories (id, name), the links (weights), and the ledger (facts and inputs, newest first, authors as usernames). Written **owner-only (0600), never overwriting a file, refusing a path inside the project folder or the data folder**, printing counts and the path but never note text. | Everything needed to rebuild a brain or a scenario, nothing about passwords or sessions. |
| D13 | `--format scenario` writes a **brain-eval draft**: dated notes from the recorded inputs (or `title: summary` for facts with no recorded input, flagged in its description) and **no questions**, which the owner adds by hand. | Real notes become scenarios; the questions need a human who knows what a good answer is. |
| D14 | Out of scope: redaction, a signed-in download, exporting several brains at once, importing an export, keeping questions and answers, and any change to what the model is sent. | Keep it small. |
| D15 | **Owner:** a person can **trace a fact to the words it came from** when something unexpected shows up (a prescription changes because someone updated the circle brain): who entered it, when, and the original words. **Only this**: the model is not shown the source and answers are not checked against it. | The facts are trusted as they are; the trace is for the unexpected case. |
| D16 | The trace is **on demand**: nothing is added to an answer's text. A page asks for the source of one fact. | Keeps answers short and prompts unchanged. |
| D17 | A fact's source is found **through the ledger**: the fact's `added item` entry carries the approval's id, and the `input` entry of that approval carries the same id. The lookup also says whether a later entry **removed** that fact (so a changed value can be followed from the old fact to the new one). No schema change. | The link already exists. |
| D18 | The status answer's points carry **the ids of the facts they came from** (with their scope), at most five per point, in citation order, de-duplicated; the model is not told the ids (the server maps them, as it maps the sources). | A page needs something to ask about. |
| D19 | The source is readable by exactly the people who can read that brain's change log (the same one-answer rule for a stranger, a made-up circle and a non-member administrator). When the words are no longer there (the fact is older than the words were recorded, or older than `CACI_LEDGER_DAYS`) the answer says so plainly. The minimal user app shows a **Show the source** button on each point of an answer. | Same permissions; honest about limits. |

## Goals and non-goals

**Goals:** confirm a fact change against the words and the person behind it; recover the text typed into a brain; turn a real brain into test input for improving answers.

**Non-goals:** the items in D14; changing how notes are filed or replaced.

## Entry shape

A ledger entry gains kind `input` and `text`:

| Field | For an `input` entry |
|---|---|
| `kind` | `input` |
| `action` | `added` |
| `subject` | the proposal id |
| `text` | the update exactly as the proposal holds it (as typed, spaces and new lines included), at most 8,000 characters |
| `title`, `summary` | absent |

## Export document (version 1)

```
{ format, version, exportedAt, brain: { kind: 'personal'|'circle', name (username or circle name), id },
  counts: { facts, categories, links, entries, inputs },
  categories: [{ id, name? }],
  facts: [{ id, title?, summary?, key?, author?, at?, categories: [{ id, weight }] }],
  ledger: [{ at, action, kind, subject, by?, title?, summary?, text? }] }
```

`author` and `by` are usernames, never user ids; a deleted account is left out.

## Requirements

| ID | Requirement |
|----|-------------|
| LX-FR-01 | An approved update records one `input` entry with its exact text, actor, scope and time, directly under the facts it produced (D5, D6). |
| LX-FR-02 | Nothing is recorded for a proposal only made, rejected, refused or failed, for questions or Pulses, or twice for one approval (D1, D9). |
| LX-FR-03 | A failed append never undoes the change and gives the one fixed warning (D9). |
| LX-FR-04 | The ledger stores keep the text exactly (a lone surrogate included), refuse `text` on other kinds, and upgrade a schema 6 file without touching it (D5, D7). |
| LX-FR-05 | The change log answers inputs under the facts' rules; a stranger, a made-up circle and a non-member administrator get the one no-such-circle (D10). |
| LX-FR-06 | The change-log screen shows who entered which words next to the facts, as text, and says the words are stored (D10). |
| LX-FR-07 | Deleting an account or a circle removes its inputs; the retention setting purges them (D8). |
| LX-FR-08 | `export-brain` exports one user's or one circle's brain from a consistent snapshot without opening the live files for writing, and removes its temporary folder (D11, D12). |
| LX-FR-09 | The export file is owner-only, never overwrites, never prints note text, and refuses a path inside the project folder or the data folder (D12). |
| LX-FR-10 | `--format scenario` writes a draft with no questions and says it cannot run until some are added (D13). |
| LX-FR-11 | `GET /api/ledger/source?scope&id` answers `{ fact, enteredBy?, at?, words?, replacedLater, recorded }` for a fact in that brain now, or for one replaced (D17). |
| LX-FR-12 | When the words are gone the answer has `recorded: false` and a plain sentence, never an error (D19). |
| LX-FR-13 | The scope and not-found rules are the change log's; an id that is not in that brain's graph or ledger is the same not-found as browse (D19). |
| LX-FR-14 | Each point of a status answer carries `facts` (scope and id, at most five, de-duplicated), and nothing else about the answer changes (D18). |
| LX-FR-15 | The user app shows a Show the source button on each point and adds the source to the thread; the model is never told (D15, D19). |
| LX-FR-16 | A source says who entered it as a username and display name, the time, and the exact words, as text only. |
| LX-NFR-01 | No new dependency and no new server route. |
| LX-NFR-02 | The text is stored unencrypted in `users.db`, as everything else is; the README says so. |
| LX-NFR-03 | Ids and text round-trip through the ledger and the export unchanged. |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| Raw text read by someone who may not read the brain | D2: the same scope and not-found rules as the facts; a stranger, a made-up circle and a non-member administrator get the one answer. | `src/api/ledger-routes.test.ts` — "an observer and every member read the words of a circle update; a stranger, the administrator and a made-up circle get the one 404"; `src/service/input-ledger-end-to-end.test.ts` — "every member and the observer read the same words; a stranger, the administrator and a made-up circle get the identical 404"; `web/ledger-service.test.mjs` — "keeps the words of each update (R-017): a member, an observer and the owner read the same words and the author" |
| Input text left behind after an account or circle is deleted | D8: the existing triggers remove personal and circle entries. | `src/ledger/sqlite/sqlite-store.test.ts` — "keeps every entry exactly, then accepts inputs"; `src/service/input-ledger-end-to-end.test.ts` — "after an account and a circle are deleted their words are in no later export, and the person is no longer found"; `src/service/brain-export.test.ts` — "a deleted circle is no longer found, and its words are in no later export" |
| A failed log write loses or blocks the change | D9: the write is first, the log second, and a failure only warns. | `src/caci/controller-ledger.test.ts` — "when the log cannot be written the update is still made and the operator hears the one fixed sentence"; `src/caci/controller-ledger.test.ts` — "a failed write records nothing, words included" |
| The export reads half a transaction or changes live data | D11: its own snapshot, the live files never opened for writing. | `src/service/brain-export.test.ts` — "the live files are never changed, and no temporary folder is left, whether it works or refuses"; `src/service/brain-export.test.ts` — "works while the service is running and holds only what had happened by then" |
| The export leaks passwords, hashes, session tokens or other people's brains | D12: only facts, names and ledger of one brain are read; authors are usernames; tests scan the file. | `src/service/brain-export.test.ts` — "is found by username in any case and never holds a password, hash, session, email or user id"; `src/service/input-ledger-end-to-end.test.ts` — "the export of a person and of a circle holds the same words and facts as the change log shows, and nothing of the other brain"; `src/service/brain-export.test.ts` — "s brain with the same words never mixes in" |
| The export file readable by others, overwritten, or committed by accident | D12: mode 0600, refuses an existing file, refuses a path inside the project folder or the data folder (also through a link). | `src/service/export-command.test.ts` — "writes the user brain as JSON, owner-only, and prints counts, the path and the warning but never the words"; `src/service/export-command.test.ts` — "an existing file (also a folder, or a link to nowhere) is never overwritten"; `src/service/export-command.test.ts` — "a path inside the project folder or inside the data folder is refused" |
| Text from a note run as markup in the change log | The screen sets text only, as every page does. | `web/ledger-view.test.mjs` — "reads as who entered which words, as text"; `web/ledger-service.test.mjs` — "keeps the words of each update (R-017): a member, an observer and the owner read the same words and the author" |
| One brain's export mixing another's data (same ids) | D12: each export is for one scope; tests use the same ids in two brains. | `src/service/brain-export.test.ts` — "s brain with the same words never mixes in"; `src/service/input-ledger-end-to-end.test.ts` — "the export of a person and of a circle holds the same words and facts as the change log shows, and nothing of the other brain" |
| A fact traced by someone who may not read its brain | D19: the source uses the change log's scope rules; a stranger, a person in other circles only, a made-up circle and a non-member administrator get the one no-such-circle. | `src/caci/controller-source.test.ts` — "a stranger, a person in other circles only, the administrator-like non-member and a made-up circle get the one not-found, and an id in another brain is not found"; `src/api/ledger-routes.test.ts` — "the source route: a stranger, the administrator and a made-up circle get the same 404, an id from another brain is not found, and bad input is refused by name"; `src/service/input-ledger-end-to-end.test.ts` — "every member and the observer read the same words; a stranger, the administrator and a made-up circle get the identical 404"; `web/user-journey.test.mjs` — "tracing a fact: a member changes a dose in the circle, the owner asks on Home, and Show the source names who, when and the exact words; a fact whose words are gone says so; a stranger gets nothing" |
| The trace names the wrong words or a wrong author | D17: found through the approval's own id (the proposal id on the entry that added the fact), in that scope only; the old fact traces to its own words. | `src/caci/controller-source.test.ts` — "a replaced fact says it was replaced, with what it said and the words that made it, and the new fact has its own words"; `src/caci/controller-source.test.ts` — "finds odd ids exactly, with the words of the approval that added them"; `src/ledger/testing/cases.ts` — "sourceOf finds the entry that added a fact, the input of the same approval, and the newest removal, in that scope only" |
| The trace used to probe for facts, or a status answer exposing graph ids | D18: ids travel only in the answer to the person who may read that brain, the model is never told them, and an id from another brain or a forgotten one is the same not-found. | `src/caci/controller-status.test.ts` — "each point carries the facts it came from: scope and graph id, de-duplicated, never another brain"; `src/caci/controller-status.test.ts` — "a pulse names only its own circle in its facts"; `src/caci/controller-source.test.ts` — "shows nothing of the plumbing: no graph id, user id or proposal id"; `src/caci/controller-source.test.ts` — "a removed fact whose entries are gone is not found" |

## What the person is told

The change-log screen says: *The words typed for each update are kept with the change, for as long as the change log is kept, and everyone who can read this log can read them.*

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| LX-AC-01 | Given an update is approved, then the change log shows the words typed and who entered them directly under the facts, and the same for a circle's update. |
| LX-AC-02 | Given a proposal is rejected, refused, failed or a question or Pulse is asked, then no input is recorded. |
| LX-AC-03 | Given the ledger cannot be written, then the change is made, and the operator gets one fixed warning. |
| LX-AC-04 | Given an observer, then they read a member's input in the circle's log; a stranger and a made-up circle get the same not-found. |
| LX-AC-05 | Given a version 6 `users.db`, then it upgrades and keeps its entries. |
| LX-AC-06 | Given an account or circle is deleted, then its inputs are gone from the database and from a later export. |
| LX-AC-07 | Given the export command for a user and for a circle, then the file holds that brain's facts, categories, links and ledger with inputs and usernames, and nothing of any other brain. |
| LX-AC-08 | Given the live service is running, then the export works and the live files are unchanged. |
| LX-AC-09 | Given an existing output file, a path inside the project folder or the data folder, or a missing brain, then the command refuses and creates nothing. |
| LX-AC-10 | Given `--format scenario`, then the draft has dated notes and no questions, becomes valid when a question is added, and the brain-eval says what is missing otherwise. |
| LX-AC-11 | Given an answer built from a fact a member entered in the circle, when the person presses Show the source, then the thread says who entered it, when, and the exact words. |
| LX-AC-12 | Given a fact that replaced an earlier one, then the source of the old fact says it was replaced, and the new fact's source is its own words. |
| LX-AC-13 | Given a fact from before the words were recorded, or older than the retention, then the source says plainly that the words are not kept. |
| LX-AC-14 | Given a stranger, a made-up circle or a non-member administrator asks for a source, then they get the same not-found as the change log, and an id in another brain is not found. |
| LX-AC-15 | Given a status answer, then each point carries the ids of its facts and the model's request never contains them. |
| LX-AC-16 | Given a pulse, then its points name only that circle's facts. |

### Where each criterion is checked (T-265, T-273)

| ID | Tests |
|----|-------|
| LX-AC-01 | `src/caci/controller-ledger.test.ts` — "an approved update records one input with its exact words, the actor, the scope and the proposal, directly under the facts it produced"; `src/caci/controller-ledger.test.ts` — "a circle update is recorded in the circle"; `src/service/input-ledger-end-to-end.test.ts` — "update each show the words typed and who typed them, beside the facts, and a replacement shows both" |
| LX-AC-02 | `src/caci/controller-ledger.test.ts` — "nothing is recorded for a proposal only made, rejected, or refused, nor for a question or a pulse"; `src/service/input-ledger-end-to-end.test.ts` — "a question, a pulse and a rejected proposal leave no words behind" |
| LX-AC-03 | `src/caci/controller-ledger.test.ts` — "when the log cannot be written the update is still made and the operator hears the one fixed sentence" |
| LX-AC-04 | `src/api/ledger-routes.test.ts` — "an observer and every member read the words of a circle update; a stranger, the administrator and a made-up circle get the one 404"; `web/ledger-service.test.mjs` — "keeps the words of each update (R-017): a member, an observer and the owner read the same words and the author" |
| LX-AC-05 | `src/ledger/sqlite/sqlite-store.test.ts` — "keeps every entry exactly, then accepts inputs"; `src/ledger/sqlite/sqlite-store.test.ts` — "an input without text, text on any other kind, and text that is not JSON" |
| LX-AC-06 | `src/service/input-ledger-end-to-end.test.ts` — "after an account and a circle are deleted their words are in no later export, and the person is no longer found"; `src/service/input-ledger-end-to-end.test.ts` — "a restart keeps the words, and the retention setting removes old ones at start-up" |
| LX-AC-07 | `src/service/brain-export.test.ts` — "holds the facts, categories, links and the change log with the words typed and who entered them"; `src/service/brain-export.test.ts` — "after an account is deleted the circle keeps what the person added, without a name"; `src/service/input-ledger-end-to-end.test.ts` — "the export of a person and of a circle holds the same words and facts as the change log shows, and nothing of the other brain"; `src/service/brain-export.test.ts` — "more than a page of facts and entries all come out, in a stable order, with odd ids and text kept exactly" |
| LX-AC-08 | `src/service/brain-export.test.ts` — "works while the service is running and holds only what had happened by then"; `src/service/brain-export.test.ts` — "the live files are never changed, and no temporary folder is left, whether it works or refuses" |
| LX-AC-09 | `src/service/export-command.test.ts` — "an existing file (also a folder, or a link to nowhere) is never overwritten"; `src/service/export-command.test.ts` — "a path inside the project folder or inside the data folder is refused"; `src/service/export-command.test.ts` — "a user or circle that does not exist, or no databases, exits 1 and creates no file"; `src/service/brain-export.test.ts` — "a data folder with no databases is refused and nothing is created" |
| LX-AC-10 | `src/service/export-command.test.ts` — "--format scenario writes the typed words as dated notes with no questions, owner-only, and says it cannot run yet"; `src/service/scenario-draft.test.ts` — "has the typed words as notes, oldest first, dated to the second in UTC, with numbered ids and no questions"; `dev/brain-eval/export-draft.test.mjs` — "is a sound scenario once a valid question is added, and then loads"; `dev/brain-eval/export-draft.test.mjs` — "is not runnable as it is: the validator and the loader say that questions are missing, naming the draft" |
| LX-AC-11 | `web/user-journey.test.mjs` — "tracing a fact: a member changes a dose in the circle, the owner asks on Home, and Show the source names who, when and the exact words; a fact whose words are gone says so; a stranger gets nothing"; `web/show-source-page.test.mjs` — "pressing it asks the ledger (scope and id in the address), adds who, when and the words as text, and moves the focus there"; `src/caci/controller-source.test.ts` — "says who entered it, when, and the exact words, for a fact in the brain now" |
| LX-AC-12 | `src/caci/controller-source.test.ts` — "a replaced fact says it was replaced, with what it said and the words that made it, and the new fact has its own words"; `web/chat-session.test.mjs` — "asks the ledger for each fact of the line and adds who, when, the exact words and the replaced note to the thread" |
| LX-AC-13 | `src/caci/controller-source.test.ts` — "when the words are gone it still says who and when, and says plainly that the words are not kept"; `src/caci/controller-source.test.ts` — "a fact from before the words were recorded, or with nothing left in the log, is still found in the brain and says so plainly"; `web/chat-session.test.mjs` — "says plainly when the words are gone: who and when if known, else the not-kept sentence" |
| LX-AC-14 | `src/caci/controller-source.test.ts` — "a stranger, a person in other circles only, the administrator-like non-member and a made-up circle get the one not-found, and an id in another brain is not found"; `src/api/ledger-routes.test.ts` — "the source route: a stranger, the administrator and a made-up circle get the same 404, an id from another brain is not found, and bad input is refused by name" |
| LX-AC-15 | `src/caci/controller-status.test.ts` — "each point carries the facts it came from: scope and graph id, de-duplicated, never another brain"; `web/notes-client.test.mjs` — "keeps each point" |
| LX-AC-16 | `src/caci/controller-status.test.ts` — "a pulse names only its own circle in its facts"; `web/show-source-page.test.mjs` — "an observer can trace what the Pulse said" |

Also covered by the storage conformance suite (an input keeps its text exactly; its rules; one batch is all or nothing): `src/ledger/testing/cases.ts` — "an input keeps its text exactly: emoji, new lines, markup, a lone surrogate and exactly 8,000 characters"; `src/ledger/testing/cases.ts` — "an input needs text of 1 to 8,000 characters, is only ever added, and carries no title or summary; no other kind has text"; `src/ledger/testing/cases.ts` — "inputs and facts in one batch are all or nothing, and an input is listed with its facts in time order".

Not looked at in a browser: the change-log line for an input was checked through the real mount and the real service, not by eye. The Show the source button was looked at in Chrome on the real service (demo model): the answer's points each had a button, pressing it added the source as literal text and moved the focus to it, no horizontal overflow; not checked by eye: the keyboard path, a dark layout, a screen reader, the real model.

### Residual risks (not covered, with the reason)

1. **Raw text is now stored in plain files** on the Pi (and in every snapshot); anyone who can read `users.db` can read it.
2. **An exported file holds real notes**; the operator must keep it out of the repository and off shared machines.
3. **Retention versus export timing**: inputs older than `CACI_LEDGER_DAYS` are gone from the live database; only a snapshot or an earlier export has them.
4. **An observer reads every input** in a circle's log, including words a member might not expect to be shared.
5. **Facts entered before this change have no recorded input**; their exports fall back to the stored title and summary.
6. **The input is the text as the proposal holds it**; if the page ever changes what it sends (for example trimming), the log holds what the service received.
7. **The export never inspects what the words say**: a note that contains a password or a phone number is exported as typed.
8. **The project-folder guard is a path check**: an operator who copies the file into the project afterwards, or into a synced folder, defeats it.
9. **The change-log line for an input was not looked at in a browser**; its text is set only as text and tested through the real mount.
10. **A trace is only as long as the change log is kept**: after `CACI_LEDGER_DAYS` the words are gone (a separate longer retention is on the Backlog).
11. **The source of a fact is the first input that made it**: a later note that changed it has its own fact and its own words; a fact the model merged from two notes names the note that created the item.
12. **Showing the source does not show the model the words**: an answer can still be wrong where a fact dropped a detail; the owner checks by tracing.
