# The Fact-Level Brain — Specification

Oct 19, 2026 · @Andy

**Status: built as F1 (T-232 to T-241); decisions D1 to D14 were taken as confirmed by the owner's instruction to build (2026-10-19). Amendments made while building: the `key` is asked for but optional in the reply (D4); the default `maxCandidates` is 12 (D5); with `maxFacts` 1 the behaviour is today's but the instruction text speaks of facts. The owner's real before and after run (`maxFacts` 8 against 1, `--repeat 3`) decides whether it helps.** It follows R-014 (the current-view brain) and its first measured cost: replacing deletes the **whole** old note, so any detail the new note does not repeat is lost (the ward of a moved appointment, a phone number, a birthday). The owner's expectation, recorded 2026-10-19: where one note states several facts (name, date of birth, email, phone number) the brain should hold them as **separate entries**, so updating the phone number cannot erase the date of birth.

## Overview

Today one note becomes **one item** (a title, a summary and links to categories). R-014 replaces whole items. That is the wrong unit: a change is almost always to **one fact**, while a note often carries several.

This specification changes the unit stored in the brain from *note* to *fact*:

1. **A note is split into facts.** The categoriser returns one item per fact, each a short self-contained statement with a **key** naming what it is about ("mum / phone number"), linked to its subject and topic categories.
2. **Replacement works fact against fact.** Candidates are existing facts, matched first by **key** and then by shared words. A new phone number replaces only the old phone-number fact. The date of birth is never a candidate.
3. **Nothing else changes in the flow.** Propose, preview, approve, the atomic write, the tidy, the ledger and the guard's rule that the model never writes a delete all stay as R-014 made them; they now act on facts.

It applies to personal and circle brains, and it can be switched off by one setting (`maxFacts` 1), which gives exactly today's behaviour.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner (expectation, 2026-10-19):** a note that states several facts is stored as **several entries**, so changing one value does not erase unchanged ones. | The measured cost of R-014; granularity, not wording, is the cause. |
| D2 | **The unit is a fact item.** A fact item has the same shape as an item today (`title`, `summary`) plus `key`. `title` is a short label ("Mum: phone number"), `summary` is the statement with the value ("Mum's phone number is 07700 900456"), and `key` is a short lower-case label of what the fact is about ("mum / phone number"), at most 80 characters. | No new node kind and no graph store change; browse, status and sharing read facts as items. |
| D3 | **Ids.** The controller mints the first fact's id as today (`itemId`) and the others as `itemId-2`, `itemId-3`… . The model must use exactly those ids and no others, each once. | Keeps the rule that the model never chooses an id, and one fact gives exactly today's reply. |
| D4 | **The reply keeps its shape**: `ops` of `upsertNode` and `link` (and `replaces`, `rationale`). The guard now accepts **1 to `maxFacts` item upserts** (control setting, default 8, range 1 to 20; **1 switches facts off and gives today's behaviour**), each with a closed `data` of `title`, `summary` and `key`, each linked to **at least one category**, using the ids of D3 in order without gaps. Every problem is listed at once, as today. | Smallest change to the guard and the provider schema; the model still cannot set modes, graph ids or deletes. |
| D5 | **Candidates are facts.** The controller ranks the scope's items: an item whose `key` **equals** a key the note's facts could have is not known in advance, so ranking uses (a) shared whole words between the note and the item's `key`, title and summary as today, and (b) a bonus for a stored `key` whose words are all in the note. At most **`maxCandidates`** (default 12, was 8) within the character budget. Items stored before this change have no `key` and are matched by words as before. | The model decides what replaces what; the controller only chooses what to show. Old whole-note items stay usable and are still replaced whole. |
| D6 | **Candidates are shown with their keys** (`[3] mum / phone number — Mum: phone number — 07700 900456`), numbered, without ids, and the model is told to **reuse the key of an existing fact it updates** and to list that fact's number in `replaces`. The `replaces` rules of R-014 D8 are unchanged. | Key consistency is the main risk: "phone" and "mobile" must not become two facts. Showing keys is the cheapest control. |
| D7 | **Granularity rule for the model**: one fact is one thing that can change independently (a date, a dose, a phone number, a place). A fact states its subject, so it makes sense alone. Things that never change together are separate facts; a sentence of narrative with no checkable value stays one fact. | This is the text of the controls, tuned by the real run, not code. |
| D8 | **Stamping, ledger, tidy and preview act on every fact.** In a circle every new fact item gets `contributedBy` and `contributedAt`; the ledger records one `added` entry per new fact and one `removed` entry per replaced fact (with its text); tidy removes categories left empty; the preview lists the new facts and the removed ones. | The R-014 machinery generalised from "the one item" to "each item". |
| D9 | **The note's own text is not kept.** Each fact carries the date it was noted (`contributedAt` in circles; the minted id's time elsewhere, as today). | Current view only (R-014 D1). Keeping source notes would be history. A fact the model fails to extract is lost at filing, which the evaluation measures. |
| D10 | **No migration.** Existing note-items stay as they are, match by words and are replaced whole. | Cheap and safe; the old items age out as they are replaced. Re-splitting old notes is a possible later task. |
| D11 | **Operation limit.** `maxOps` rises (default 40) so that 8 facts with their links fit; the settings' consistency rules and the output limit follow. | The current 25 cannot hold 8 facts with three links each. |
| D12 | **The demo model splits too**, deterministically: sentences and `label: value` pairs become facts, a key from the label or the commonest words, and it replaces by key or by words as in R-014. It is a stand-in, not a judge of meaning. | The gate and the brain-eval run free with it. |
| D13 | **Measuring it.** The brain-eval gains scenarios where one note states several facts and a later note changes one; a **collateral loss** count (a fact that should have survived and did not) beside `lost at replace`; and the A/B for free through controls: `maxFacts` 1 against the default. The owner's real before and after run decides whether it helps. | It is a bet that must be measured. |
| D14 | **Out of scope:** history, splitting the existing items, merging duplicate facts after the fact, editing a fact by hand, a fact-level web editor, restating unchanged details into a new item (the cheaper alternative, kept in the Backlog as the comparison). | Keep it small. |

## Goals and non-goals

**Goals:** a changed value replaces only its own fact; unchanged facts from the same note survive; the status context holds one line per current fact; the same safety as R-014 (the model names numbers, trusted code deletes, one atomic write, a review log).

**Non-goals:** the items of D14; changing the graph store, the shared-brain (R-008, R-009) rules or the status format.

## Definitions

- **Fact**: one thing that can change independently, stored as an item (D2, D7).
- **Key**: the short label of what a fact is about (D2). It is a hint for matching, not an identifier.
- **Collateral loss**: a fact a later question needs that was deleted because a note changed a different fact of the same note, or stored in the same item.

## The changed flow

1. `propose`: categories and **candidate facts** (D5) are read as today; `categorise` receives both, the candidates with their keys (D6).
2. The model returns 1 to `maxFacts` fact items, their links and `replaces`. The guard checks D4 and D3; the controller maps numbers to ids, builds the `deleteNode`s and re-checks the mutation as in R-014.
3. The preview lists the new facts and the facts they replace. Nothing is written.
4. `approve`: one atomic write; tidy; the ledger records every added and removed fact.

## Requirements

| ID | Requirement |
|----|-------------|
| FL-FR-01 | With `maxFacts` greater than 1 the categoriser may return up to `maxFacts` fact items; with 1 the proposal equals today's. |
| FL-FR-02 | The guard enforces D3 and D4 and lists every problem; the model cannot name an id the controller did not mint. |
| FL-FR-03 | Candidates are ranked as D5, shown with keys as D6, and never exceed `maxCandidates` or the budget; old items without a key still match by words. |
| FL-FR-04 | A note that changes one fact of an earlier multi-fact note replaces only that fact; the others and their links remain. |
| FL-FR-05 | Every new fact is stamped in a circle, logged and previewed; replaced facts are removed, logged with their text and tidied (D8). |
| FL-FR-06 | The new fact items are written with their links in the same atomic write as the deletes; a failure leaves everything unchanged. |
| FL-FR-07 | The demo model splits and keys deterministically and passes the guard for any note (D12). |
| FL-FR-08 | The brain-eval reports collateral loss and runs the A/B through controls (D13). |
| FL-FR-09 | The capture page shows the facts that will be added and removed, as text. |
| FL-NFR-01 | No new dependency and no graph store change. |
| FL-NFR-02 | The controls (wording, `maxFacts`, `maxOps`) stay in `controls/`; the golden files change deliberately and are reviewed. |
| FL-NFR-03 | A note with `maxFacts` facts is proposed with one candidate read and one model call. |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| The model invents ids, or one id for two facts | D3: ids are minted, the guard accepts exactly those, once each. | `src/llm/capabilities/categorise/guard.test.ts` — "refuses an id that was not minted, a gap, a repeat and a wrong order, naming the fact"; `src/llm/capabilities/categorise/guard.test.ts` — "every fact needs a link, and a link must come from one of the facts" |
| The model splits a note into many tiny facts to flood the brain | `maxFacts` and `maxOps` caps; every fact needs a link; the preview shows them all. | `src/llm/capabilities/categorise/guard.test.ts` — "accepts exactly maxFacts facts and refuses one more"; `src/llm/controls/settings.test.ts` — "each fact needs an item and a link, so maxOps must be at least twice maxFacts"; `web/capture-page.test.mjs` — "lists the facts that will be added, as text, above the removals and the notes" |
| Inconsistent keys leave a stale fact beside the new one | Candidates shown with keys and the instruction to reuse them; the evaluation measures the stale rate. A residual risk. | `src/app/candidates.test.ts` — "a fact whose whole key is in the note comes first, even when another shares more words"; `src/llm/capabilities/categorise/prompt.test.ts` — "existing facts are shown with their key first, and without one as before"; `src/llm/demo-facts.test.ts` — "an existing fact whose whole key is in the fact beats one that only shares more words" |
| Extraction drops a fact | Measured as lost at filing; D9 says plainly the note is not kept. | `dev/brain-eval/brain-arm.test.mjs` — "records how many facts each note became"; `dev/brain-eval/library.test.mjs` — "with facts the unchanged details survive: every question of the two scenarios passes and the replacement removes one fact" |
| A hostile note forges facts or keys that match another person's | Candidates are read from the target scope's graph only (R-014); keys are data, never ids. | `src/app/candidates.test.ts` — "reads only the graph it is given, and calls no write primitive"; `src/llm/demo-facts.test.ts` — "1,500 random notes with random existing lists all pass the real guard first time" |
| A fact is stamped or logged wrongly in a circle | D8, tested per fact. | `src/app/facts.test.ts` — "every new fact is stamped with who and when, and a forged stamp is removed"; `web/replace-journey.test.mjs` — "a profile note becomes separate facts, and changing the phone number replaces only the phone fact" |

## What the person is told

The preview says "This note adds N facts" (each as its title and summary) and, when it changes earlier ones, "This note replaces, and these will be removed when you approve:" as today. The outcome counts facts added and removed.

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| FL-AC-01 | Given "Mum: born 4 June, phone 07700 900123, email mum@example.test", when proposed with the demo model, then three fact items are previewed, each linked to the subject and a topic. |
| FL-AC-02 | Given those facts stored and the note "Mum's new phone number is 07700 900456", when proposed, then only the phone fact is a replacement. |
| FL-AC-03 | Given that proposal approved, then the date of birth and the email remain, the old phone number is gone, and the new one exists. |
| FL-AC-04 | Given a reply with an unminted id, a repeated id, an item with no link, more than `maxFacts` items or a key over 80 characters, when checked, then it is refused with every problem listed. |
| FL-AC-05 | Given `maxFacts` 1, when any note is proposed, then the proposal equals today's. |
| FL-AC-06 | Given an item stored before this change (no key), when a note changes it, then it is a candidate by words and is replaced whole. |
| FL-AC-07 | Given a circle, when a member's note adds facts, then each new fact is stamped with the member and the time. |
| FL-AC-08 | Given an approval, when it succeeds, then the ledger holds one added entry per new fact and one removed entry per replaced fact with its text. |
| FL-AC-09 | Given a fact whose only item is replaced and whose category is left empty, when the approval finishes, then the category is tidied; a category another fact uses stays. |
| FL-AC-10 | Given 1,500 random notes with the demo model, when checked, then every reply passes the guard first time. |
| FL-AC-11 | Given the evaluation library with its multi-fact scenarios, when the brain-eval runs with the demo model and `maxFacts` 8 and then 1, then it reports collateral loss for each and the facts version loses fewer facts. |
| FL-AC-12 | Given the capture page, when a multi-fact note is previewed, then the facts and the removals are listed as text. |

### Where each criterion is checked (T-241)

| ID | Tests |
|----|-------|
| FL-AC-01 | `src/app/facts.test.ts` — "previews each fact, writes them all in one step, with their links"; `src/llm/demo-facts.test.ts` — "a profile note becomes three facts with minted ids, a key each, and a link each, accepted by the real guard" |
| FL-AC-02 | `src/app/facts.test.ts` — "removes only the phone fact; the date of birth, the email and their links stay, and the new number is there"; `src/llm/demo-facts.test.ts` — "a changed phone number replaces only the phone fact and reuses its key" |
| FL-AC-03 | `src/app/facts.test.ts` — "removes only the phone fact; the date of birth, the email and their links stay, and the new number is there"; `web/replace-journey.test.mjs` — "a profile note becomes separate facts, and changing the phone number replaces only the phone fact" |
| FL-AC-04 | `src/llm/capabilities/categorise/guard.test.ts` — "refuses an id that was not minted, a gap, a repeat and a wrong order, naming the fact"; `src/llm/capabilities/categorise/guard.test.ts` — "every fact needs a link, and a link must come from one of the facts"; `src/llm/capabilities/categorise/guard.test.ts` — "accepts exactly maxFacts facts and refuses one more"; `src/llm/capabilities/categorise/guard.test.ts` — "the key must be plain text of 1 to keyMaxChars characters" |
| FL-AC-05 | `src/llm/capabilities/categorise/guard.test.ts` — "with one fact allowed a second item is refused as before"; `src/llm/demo-facts.test.ts` — "with only one fact allowed (the meta says so) the reply is today" |
| FL-AC-06 | `src/app/facts.test.ts` — "items stored before facts existed (no key) are still candidates by words and replaced whole"; `src/app/candidates.test.ts` — "an item without a stored key is still matched by words, as before" |
| FL-AC-07 | `src/app/facts.test.ts` — "every new fact is stamped with who and when, and a forged stamp is removed" |
| FL-AC-08 | `web/replace-journey.test.mjs` — "a profile note becomes separate facts, and changing the phone number replaces only the phone fact" |
| FL-AC-09 | `src/app/replace.test.ts` — "a category left with no notes is removed, one that still has notes stays, and the result names what was removed" |
| FL-AC-10 | `src/llm/demo-facts.test.ts` — "1,500 random notes with random existing lists all pass the real guard first time" |
| FL-AC-11 | `dev/brain-eval/library.test.mjs` — "with one fact allowed the whole note is replaced and the details are lost; the diagnostic says replace"; `dev/brain-eval/library.test.mjs` — "so the facts version loses fewer facts than maxFacts 1 on these scenarios (the A/B through the controls)" |
| FL-AC-12 | `web/capture-page.test.mjs` — "lists the facts that will be added, as text, above the removals and the notes"; `web/replace-journey.test.mjs` — "a profile note becomes separate facts, and changing the phone number replaces only the phone fact" |

### Residual risks (not covered, with the reason)

1. **Key drift**: "phone" and "mobile" can still become two facts, leaving a stale one. The key is only a hint and is optional in the reply; the model is shown existing keys and told to reuse them, and the evaluation can measure the stale rate on a real run.
2. **Extraction can drop or garble a fact**, and the source note is not kept (D9).
3. **More items**: the status context has more, shorter lines, and its budget cuts the oldest sooner. A note of eight facts is up to eight entries.
4. **A real model's granularity is a matter of taste**: too coarse recreates the problem, too fine floods the brain. It is tuned in `controls/categorise/system.txt` (rule 6) and judged by the real run, which has not yet been made.
5. **Old whole-note items stay whole** until they are replaced (D10).
6. **The demo model is a splitter, not a reader**: it proves the plumbing and the A/B, not the quality; its keys are the first words of a fact.
7. **Replacing is still all or nothing per fact**: a fact that mixes two values (a time and a place in one sentence) is replaced as one.
8. **The capture page lists facts but one by one approval is not offered** (D2 of R-014): approving covers all of them.
9. **Looked at in a browser by hand: not done for F1**; the page logic is tested through the real mount and the real service with the demo model.
