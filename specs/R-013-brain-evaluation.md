# Brain Quality Evaluation — Specification

Oct 14, 2026 · @Andy

**Status: being built as B1 (T-205 to T-214).** This is the owner's backlog item "Test the Brain and the LLM at scale", sharpened on 2026-10-14: the purpose is **not performance but the quality of fact retrieval**. Information added early must not be forgotten when it is relevant; **a later fact that overrides an earlier one must win**; and the question behind it all: **does the bipartite-graph brain answer better than simply keeping all the input as text and replaying it?**

## Overview

A development-only tool (`dev/brain-eval/`, `npm run brain-eval`, never published) replays **a library of dated notes** (scenarios) into two different memories and asks both the same **questions**, on the **real models**, several times each:

- **The brain arm**: every note is filed through the real categoriser into a real graph, exactly as the product does it, and each question is asked as a **status request** (the product's only answering path today).
- **The replay arm**: the same `status` capability, the same controls and the same answering model, given **every raw note, oldest first, with its date**.

Each answer is **scored by rules** (facts that must appear, stale facts that must not). The report compares the arms, the models and the kinds of question, and says where a fact was lost.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** the aim is quality of fact retrieval: early facts kept, overriding facts winning (the 2 x Tablet A then 1 x Tablet B case), and **brain versus replaying the text**. Not performance, not cost. | The owner's brief. |
| D2 | **Owner:** the **brain arm uses `status` as it is** (the real product path); weak results point at what to build. | Measure the product before changing it. |
| D3 | **Owner:** the baseline is the **full transcript, in time order**, same model, same answer format. | An honest upper bound until it outgrows the model's window. |
| D4 | **Owner:** answers are **scored by rules**; each question is asked several times (default 3) because real runs vary. | Cheap, repeatable, no judge to trust. |
| D5 | **Owner:** the **first library is drafted by me (invented scenarios) and reviewed by the owner**: about 8 scenarios of 10 to 40 dated notes, with distractors, and about 30 questions. | The owner still needs a reliable source for real-world text; invented text is safe to send to a model. |
| D6 | The tool runs on **invented text only**. A real run sends the notes and questions to Anthropic and costs money, so it **prints its plan and stops unless `--yes`** (like the other evaluations); `--demo` uses the free demo model, is deterministic and refuses `--yes`. | Privacy and cost. |
| D7 | **Scenario files** are plain JSON, one scenario per file: `{ id, title, description?, notes: [{ id, at, text }], questions: [{ id, kind, after, ask, at?, must?, stale?, expectNothing?, why? }] }`. Notes have an ISO date (non-decreasing); `after` is the id of the note after which the question is asked; `at` (optional) is when it is asked (default one hour after that note). | Easy to write, review and add to; stable under padding. |
| D8 | **Question kinds:** `recall` (an early fact that is still relevant), `override` (a later fact replaces an earlier one; the old one must not be given as current), `retract` (a fact is withdrawn or cancelled), `multi` (an answer needs two or more facts), `distractor` (asks about something never noted: the right answer is "nothing relevant", `expectNothing: true`, no `must`). | The cases the owner named, plus the two that catch inventing and mixing. |
| D9 | **Scoring.** Text is normalised (case, punctuation and hyphens, number words and digits, "x", "×" and "times", a trailing plural s) and phrases match on whole words. A question passes when **every `must` group has one alternative present** in the headline or points and **no `stale` phrase is surfaced**. A stale phrase in the **same point as a superseding cue** ("no longer", "previously", "instead of", "changed from", "replaced", "stopped", "used to", "cancelled", "formerly", "anymore") is **tolerated** and counted as `superseded`, not as a failure. A `distractor` passes only on `nothing: true`. | An answer may truthfully say what changed; only giving the old fact as current is the failure. |
| D10 | **The brain arm runs the real product stack in memory**: memory graph, user, session and CaCi controllers and the capture controller, the real categoriser and status, an **injected clock** so each note is filed at its own date (item ids carry the time the status context reads), limits raised so only the real context budget (12,000 characters, 200 entries) cuts anything. One person, personal scope. | The product path, with time under control. |
| D11 | **The replay arm** calls `status` with **every raw note up to the checkpoint** as an entry (`where: personal`, the date as its time), **oldest first** (option `newest-first`), with the request, entry and total limits lifted. A transcript estimated over the window (default 150,000 tokens, about four characters a token) is marked `over-window` and not sent. | Differs from the brain arm only in what the entries are and how many fit. |
| D12 | **Models:** a **filing model** (default `fast`, as the product's route) and **answering models** (default `fast`, `balanced`, `deep`); the filing happens once per scenario and filing model and is reused for every question, model and repeat; the replay arm does not file. | Cost, and a fair like-for-like comparison. |
| D13 | **Diagnostic per question** (brain arm): `inBrain` (the must groups are all present in the stored items), `inContext` (all present in the entries actually sent), `inAnswer` (all present in the answer). A failed question is classified **lost at filing**, **lost at context** or **lost in the answer**. The replay arm records `inContext` (always true unless over-window) and `inAnswer`. | Says *where* a fact was lost, which is what decides what to build. |
| D14 | **Filler**: `--pad N` inserts N deterministic, unrelated everyday notes (seeded) between the scenario's notes, never containing a phrase any question of that scenario looks for, and re-validates; results are grouped by pad size. | The test of "early facts forgotten": pushes the brain past its context budget. |
| D15 | **Report** (and saved JSON in a git-ignored folder): per arm and answering model the pass rate, stale-surfacing rate and tokens, **by question kind**, a per-question table, the **brain-minus-replay difference**, the diagnostic counts and every failure with its answer. `--compare A.json B.json` shows what changed between two runs (also the way to compare two controls folders via `--controls`, K1). | The comparison the owner asked for. |
| D16 | **Not in scope:** changing the brain (supersession, raw text kept beside the summary, a dedicated answer capability, a hybrid arm, a recent-window arm, circle scopes). They are Backlog items to decide on the evidence. | Measure first. |

## Goals and non-goals

Goals: a replayable library; a fair like-for-like comparison of brain and replay on the real models; where facts are lost; repeatable runs comparable before and after a change.

Non-goals: performance or cost measurement; real or personal data; judging answers with a model; improving the brain in this milestone.

## Definitions

- **Scenario**: a dated story of notes with questions. **Note**: one dated text. **Checkpoint**: the note after which a question is asked. **Arm**: brain or replay. **Repeat**: one more asking of the same question. **Diagnostic**: the three-stage check of D13.

## Scenario rules (checked by the validator)

Unique scenario, note and question ids; every note a valid ISO date in non-decreasing order with 1 to 8,000 characters; every question a known kind, a checkpoint that is a note id, an `ask` of 1 to 500 characters and (unless `expectNothing`) at least one `must` group of non-empty alternatives; `stale` only on `override` and `retract` questions; `expectNothing` only on `distractor` questions, which have no `must`; **every `must` phrase is present in a note at or before the checkpoint** (answerable); **for an `override` question every stale phrase is present in a note earlier than the note that holds the new fact** (the override is real); unknown fields refused.

## Functional requirements

| ID | Requirement |
|----|-------------|
| BE-FR-01 | The loader reads every `.json` scenario in a folder and refuses duplicates and non-scenarios; the validator lists every problem at once. |
| BE-FR-02 | Scoring follows D9, is pure and deterministic, and aggregates repeats into a pass rate and a stale-surfacing rate. |
| BE-FR-03 | The brain arm files each note through the real propose and approve at the note's date and asks each question at its checkpoint; a failed filing is recorded and the run goes on. |
| BE-FR-04 | The replay arm gives every raw note up to the checkpoint, oldest first, nothing is filed, and an over-window transcript is not sent. |
| BE-FR-05 | The command prints a plan and stops unless `--yes` for a real run; `--demo` is free and refuses `--yes`; the key is read once, never printed or saved. |
| BE-FR-06 | The report has the per-arm, per-model, per-kind and per-question results, the brain-minus-replay difference, the diagnostic and the failures. |
| BE-FR-07 | `--pad N` is deterministic for a seed, never leaks a scored phrase, and keeps order and dates. |
| BE-FR-08 | `--compare` lists the changes between two saved runs and refuses runs of different scenarios without `--force`. |
| BE-FR-09 | `--controls DIR` runs both arms against a candidate controls folder (R-012). |
| BE-FR-10 | The library's own tests prove an ideal answerer passes everything and three bad answerers fail the questions they should. |

## Risks

| Risk | Control |
|------|---------|
| A scenario that is unfair to one arm (the answer needs detail only one arm keeps) | Scenarios are reviewed by the owner; both arms see the same notes; the diagnostic shows where each loses. |
| A stale phrase that matches a legitimate mention | The superseded-cue rule; stale phrases are written specific; the scoring tests include such answers. |
| Model variance | Several repeats and a pass rate, not a single answer. |
| A scenario that leaks the answer into a distractor note | The validator and filler checks; review. |
| Real or personal data used by accident | Invented text only, stated in the README and the plan; the real run needs `--yes`. |
| A scoring rule that cannot tell good from bad | An ideal answerer and three bad answerers are run through the real scoring in the tests. |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| BE-AC-01 | Given a scenario whose question needs a phrase no note holds, when it is validated, then it is refused. |
| BE-AC-02 | Given an override whose stale phrase appears only after the new fact, when it is validated, then it is refused. |
| BE-AC-03 | Given "Tablet B" with "instead of Tablet A" in one point, when scored, then it passes with the stale phrase superseded; with "Tablet A" as current it fails. |
| BE-AC-04 | Given the demo model, when a scenario is run, then every note is filed at its own date and the old and the new fact are both stored. |
| BE-AC-05 | Given a transcript over the window, when the replay arm runs, then it is marked and not sent. |
| BE-AC-06 | Given a real run without `--yes`, when it is started, then only the plan is printed. |
| BE-AC-07 | Given `--pad 300`, when the brain arm runs, then the context drops the oldest entries and the report says how many. |
| BE-AC-08 | Given the shipped library, when the ideal answerer runs, then it passes every question, and the stale-parrot fails the override questions. |
| BE-AC-09 | Given two saved runs, when compared, then the changes and flipped questions are listed. |
| BE-AC-10 | Given a question lost at filing, when the report is read, then it is counted as lost at filing, not in the answer. |

## Residual risks

1. **Invented scenarios are not real life**: they show whether the mechanism works, not how real notes behave.
2. **Rules miss paraphrases**: an answer that is right in other words fails; phrases are written loosely and reviewed.
3. **One filing model, one run**: filing is also non-deterministic; the filing is reused for all questions of a run.
4. **The replay arm is an upper bound only while the transcript fits the window**; beyond it the comparison stops being meaningful.
5. **A real run costs money and sends the scenario text to Anthropic.**
