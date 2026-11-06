# Relevant Category Context — Specification

Nov 6, 2026 · @Andy

**Status: draft, planned as G1.** Part A of the withdrawn `R-020`. D1 to D2 are the owner's (2026-11-06); the rest are proposed by me and stand unless the owner changes them. Part A2 (merging near-duplicate categories) is an outline only and is re-confirmed after A1 is measured.

## Overview

When a note is filed, the categoriser is shown the brain's existing categories and told to reuse one where it fits, so the brain stays tidy (R-001, R-012). In a large brain it can be shown the **wrong** categories, and then it invents a duplicate ("weds-class" next to "wednesday-session") and the brain sprawls.

What happens today, checked in the code:

1. The capture controller reads categories **by id** up to `maxCategories` (500, `src/app/read-graph.ts`), whole-graph, in id order. Beyond 500 categories, the rest are never seen.
2. It passes **no link counts** (a known Backlog item), so the context builder's "most-linked first" rule (`context.ts`) has nothing to rank by: unknown counts sort last, ties by id.
3. The result is cut to a **4,000-character budget** (`maxChars`), dropping from the end.

So in a brain with more than a few dozen categories, which ones the model sees depends on **the alphabet**, not on the note. A relevant category named `weds-class` can be hidden by 400 categories that sort before it.

This spec makes the category context **relevant to the note**, chosen in code, within the same budget, and measurable against today's ordering.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** the context shown to the categoriser should be relevant to the note, not alphabetical or popular. | The brain must stay tidy as it grows. |
| D2 | **Owner:** merging near-duplicate categories, if built, is a human decision; the model never deletes. | Keeps R-014's rule that deletion is built by trusted code from a person's approval. |
| D3 | The controller reads **all** categories (ids and names only, up to a larger cap, default 5,000) and **ranks them in code** for each note; the model is shown the top ones that fit the existing budget. The cap on what the model sees is still the character budget. | Cheap (a listing, no model call), deterministic and testable. |
| D4 | Ranking, strongest first: **(1)** categories the note's **candidate facts** are filed under (R-014's word-overlap search already finds facts that share words with the note; their categories are the best evidence of where this note belongs), **(2)** categories whose **id or name shares words** with the note (the same word rule as the candidate search: lower case, plural s cut, stop words out), **(3)** the rest in today's order. Ties inside a group: more shared words, then id in code-unit order. | The fact that "weds-class" holds "Wednesday session 6pm" ranks it for "next session is 7pm Wednesday" even though the note does not say "class". |
| D5 | A setting `categoryOrder` in `controls/categorise/settings.json`: `relevance` (new) or `id` (today). Shipped `relevance` once measured (D8); `id` is the A/B baseline and the way back. | Same pattern as `maxFacts` in R-015. |
| D6 | Step (1) costs **one extra read per proposal**: the categories of the top candidate facts (a depth-1 read from at most 12 item seeds). Nothing is written. A failure of this extra read does not fail the proposal: the context falls back to steps (2) and (3) and the operator is told once by the existing warning hook. | Relevance is an improvement, not a dependency. |
| D7 | The model still sees only category **ids and names**, never other people's text beyond what it sees today, and the guard is unchanged (a link to a category that does not exist is still refused at write time). | No new trust surface. |
| D8 | **Measured before it ships as the default**: a large-brain evaluation case (D9) must pass with `relevance` and fail with `id` on the scripted ideal model, and the owner runs it on the real models. | The change is only worth it if it helps. |
| D9 | New golden cases in `dev/eval` (categorise set): a brain of 600 categories where the right category sorts last and shares no word with the note's text but holds a fact that does; the same with the right category named in the note; a brain where nothing relevant exists (a new category is right). | Proves the ranking discriminates and does not force reuse. |
| D10 | **Part A2 (outline, not planned in detail):** a periodic **merge proposal**: the model may propose that category X be merged into Y when their facts overlap; an owner or manager approves; trusted code relinks the facts and removes X; the ledger records it. | Emergent categories sprawl; relevance reduces it but cannot remove it. |

## Goals and non-goals

**Goals**

1. A note about an existing topic is offered that topic's category, however many categories exist.
2. The same budget, no extra model call, and one extra read at most.
3. The old ordering stays available and measurable.

**Non-goals**

- Link counts per category (a Backlog item; relevance does not need them, and they would only improve step 3).
- Embeddings or any model-based ranking (words are enough to start, and are explainable).
- Changing the guard, the schema of a proposal or what is stored.
- Merging categories (A2 is an outline).

## Requirements

| ID | Requirement |
|----|-------------|
| RC-FR-01 | `rankCategories(note, categories, candidateCategoryIds, options)` is a pure function returning the categories in the order of D4, deterministic for the same input regardless of input order. |
| RC-FR-02 | The capture controller reads all categories (ids and names) up to `maxCategoriesRead` (default 5,000), ranks them, and gives `categorise` the ranked list; the context builder's budget decides how many the model sees. |
| RC-FR-03 | The categories of the top candidate facts are found with one read over the same graph and ranked first (D4 step 1); a failure falls back and warns. |
| RC-FR-04 | `categoryOrder: 'id'` reproduces today's behaviour exactly (same categories in the same order in the prompt), proved by the existing golden files. |
| RC-FR-05 | The setting is validated with the other controls settings (`relevance` or `id`, required, no unknown values) and shown in the README's settings table. |
| RC-FR-06 | A category the note shares no word with and that holds no candidate fact is never ranked above one that does. |
| RC-NFR-01 | Read-only: a recording adapter shows no write primitive called by the ranking or its extra read. |
| RC-NFR-02 | Ranking 5,000 categories takes under 100 ms on the reference machine (tested with a generous bound). |
| RC-NFR-03 | The model never sees a category's data beyond what it sees today (id and name). |

## Threats and controls

| Threat | Control |
|--------|---------|
| A note crafted to rank an unrelated category first, steering filing | Ranking only chooses which categories are *shown*; the model still decides and the guard still applies; a person still approves or reviews the change log. |
| A very large brain makes ranking slow or exhausts memory | D3's cap on categories read, RC-NFR-02, a failure falls back. |
| Relevance hides a category the model should have reused | Step 3 still fills the budget in today's order; D8's evaluation measures it. |
| The extra read leaks across graphs | It uses the proposal's own graph id only (the same one the controller already reads). |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| RC-AC-01 | Given 600 categories where the right one sorts last and shares no word with the note, but holds a fact that does, when proposed with `relevance`, then that category is in the model's context; with `id` it is not. |
| RC-AC-02 | Given a note that names the category's own words, then it is in the context with `relevance`. |
| RC-AC-03 | Given nothing relevant, then the context is today's order and a new category can be proposed. |
| RC-AC-04 | Given `categoryOrder: 'id'`, then every existing categorise golden file is byte-identical. |
| RC-AC-05 | Given the extra read fails, then the proposal still succeeds, ranked by words, and the warning hook is told once with no ids or text. |
| RC-AC-06 | Given any proposal, then no write primitive was called by the ranking. |
| RC-AC-07 | The scripted ideal model passes the large-brain cases with `relevance` and fails the right-category-last case with `id`. |

## Residual risks

1. Word overlap misses a paraphrase ("lessons" for "class"); the fill and, later, merge proposals reduce but do not remove this.
2. A real model's reuse behaviour with the new ordering is untested until the owner's real run.
3. Reading up to 5,000 category names per proposal is a cost; very large brains may want link counts or an index (Backlog).
4. Categories are still emergent and can sprawl; A2 is only an outline.

## Open questions

1. Should the cap of categories read be a setting, or fixed at 5,000?
2. Is ranking by candidate facts enough, or should step (1) also use the facts' **keys** (R-015) directly?
3. For A2: who may approve a merge in a personal brain (the person), and how is a merge shown in the change log (one removed, many updated)?
