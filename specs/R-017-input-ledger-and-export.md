# The Input Ledger and the Brain Export — Specification

Oct 21, 2026 · @Andy

**Status: being built as L2 (T-258 to T-265); decisions D1 to D4 are the owner's (2026-10-21), D5 to D14 are mine and stand unless changed.** It extends the change ledger of `specs/R-014-current-view-brain.md` and adds an operator command that exports a brain.

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
| D12 | The export is **one JSON document** `{ format: 'caci-brain-export', version: 1 }` holding the facts (id, title, summary, key, author as username, time), the categories (id, name), the links (weights), and the ledger (facts and inputs, newest first, authors as usernames). Written **owner-only (0600), never overwriting a file**, printing counts and the path but never note text. | Everything needed to rebuild a brain or a scenario, nothing about passwords or sessions. |
| D13 | `--format scenario` writes a **brain-eval draft**: dated notes from the recorded inputs (or `title: summary` for facts with no recorded input, flagged in its description) and **no questions**, which the owner adds by hand. | Real notes become scenarios; the questions need a human who knows what a good answer is. |
| D14 | Out of scope: redaction, a signed-in download, exporting several brains at once, importing an export, keeping questions and answers, and any change to what the model is sent. | Keep it small. |

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
| LX-FR-09 | The export file is owner-only, never overwrites, never prints note text, and refuses a path inside the repository's tracked tree (D12). |
| LX-FR-10 | `--format scenario` writes a draft with no questions and says it cannot run until some are added (D13). |
| LX-NFR-01 | No new dependency and no new server route. |
| LX-NFR-02 | The text is stored unencrypted in `users.db`, as everything else is; the README says so. |
| LX-NFR-03 | Ids and text round-trip through the ledger and the export unchanged. |

## Threats and controls

| Threat | Control |
|--------|---------|
| Raw text read by someone who may not read the brain | D2: the same scope and not-found rules as the facts; a stranger, a made-up circle and a non-member administrator get the one answer. |
| Input text left behind after an account or circle is deleted | D8: the existing triggers remove personal and circle entries. |
| A failed log write loses or blocks the change | D9: the write is first, the log second, and a failure only warns. |
| The export reads half a transaction or changes live data | D11: its own snapshot, the live files never opened for writing. |
| The export leaks passwords, hashes, session tokens or other people's brains | D12: only facts, names and ledger of one brain are read; authors are usernames; tests scan the file. |
| The export file readable by others or overwritten | D12: mode 0600, refuses an existing file, refuses a path inside the repository. |
| Text from a note run as markup in the change log | The screen sets text only, as every page does. |
| One brain's export mixing another's data (same ids) | D12: each export is for one scope; tests use the same ids in two brains. |

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
| LX-AC-09 | Given an existing output file, a path inside the repository, or a missing brain, then the command refuses and creates nothing. |
| LX-AC-10 | Given `--format scenario`, then the draft has dated notes and no questions, becomes valid when a question is added, and the brain-eval says what is missing otherwise. |

## Residual risks (not covered, with the reason)

1. **Raw text is now stored in plain files** on the Pi (and in every snapshot); anyone who can read `users.db` can read it.
2. **An exported file holds real notes**; the operator must keep it out of the repository and off shared machines.
3. **Retention versus export timing**: inputs older than `CACI_LEDGER_DAYS` are gone from the live database; only a snapshot or an earlier export has them.
4. **An observer reads every input** in a circle's log, including words a member might not expect to be shared.
5. **Facts entered before this change have no recorded input**; their exports fall back to the stored title and summary.
6. **The input is the text as the proposal holds it**; if the page ever changes what it sends (for example trimming), the log holds what the service received.
