# Usage Metering: What Each Account's Model Calls Cost — Specification

Nov 12, 2026 · @Andy

**Status: draft, planned as X1 (T-328 to T-335).** D1 to D3 are the owner's (2026-11-12). The rest are proposed and stand unless changed.

## Overview

The operator pays for every model call: filing a note, a status check, a Pulse. At a price of £39 a month per account and a model cost of roughly £5 a month, the question that matters is whether £5 is an average or a few heavy users, and which calls drive it. Today nothing records it: the call result carries token counts and then they are dropped, and a call that fails returns an error with no usage at all, although the provider still charged for it.

This spec adds **usage metering**: one small record per model attempt, kept in `users.db`, with a command-line report of tokens and estimated cost by account, call type, model, circle and month. It records **no text**. It is reporting only: it never limits anyone.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner: no cap.** Metering only reports. Nothing is refused, slowed or warned because of it. | Visibility first; a cap can be added once the numbers are known (Backlog). |
| D2 | **Owner: the asker is charged.** A call made on a circle's brain is charged to the person who made it, and the circle is recorded as the scope. Nothing is split between members. | Simple, and it matches who triggered the spend. |
| D3 | **Owner: a command-line report** (`npm run usage`), read straight from `users.db` like backup and export. No admin screen, no route. | Operator-only, nothing new to secure. |
| D4 | **One record per model attempt**, not per user action: a guard-rejected first attempt and its repair are two records; a provider failure that reports usage is one record with its error kind; a call refused before any model was asked is none. | The provider bills attempts, and repair and failure rate are themselves findings. |
| D5 | **Records come from the existing `trace` callbacks** of `categorise` and `status` (their `response` and `failure` events carry usage even when the call fails). The controller supplies the context (user, capability, scope); the LLM component does not know users. | No change to what the model is told, and failed calls are visible. |
| D6 | **Cached tokens are kept separate**: `Usage` gains optional `cacheReadTokens` and `cacheCreationTokens`; `inputTokens` stays the total, so nothing that reads it changes. | Providers price cache reads and writes differently from plain input. |
| D7 | **Tokens are stored, prices are not.** A price table in a repo file (`usage-prices.json`: per model, per million tokens: input, output, cache read, cache write, with a date) converts at report time. A model with no entry is listed as **unpriced**, never costed as zero. | Prices change; history can be re-costed; a missing price must not look like a free call. |
| D8 | **No text in any record.** A record holds a user id, a time, a capability, a scope (personal, or a circle id), the answering model, the attempt number, token counts, a result, and a latency. There is no field that could hold a note, a request, an answer, a name or a fact id, and the check refuses any other key. | A usage table must be safe for the operator to read and export. |
| D9 | **Capabilities recorded**: `categorise` (filing a note), `status` (a typed request), `check` (pulse, coming-up, long-range from the apps) and `agent-check` (the agent view's pulse). An agent's own model costs the operator nothing and is not recorded. | Matches what the operator pays for. |
| D10 | **A failed append never fails the call** and never delays it: the recorder never throws, and a failure calls a fixed-words warning hook (no ids, no values). | Metering must not be able to break the product. |
| D11 | **Deleting an account clears the user id** on its records (a database trigger, by any route) and keeps the rest, so totals survive and nothing identifies the person. The report shows 'deleted account'. | Cost history is the operator's finance record; the person's identity is not part of it. |
| D12 | **Retention** `CACI_USAGE_DAYS` (1 to 3650, default 400, a little over a year so a year-on-year view works); older records are purged at start-up and once a day, like the change log. | Bounded storage. |
| D13 | **Storage**: a `UsageStore` port with a memory store and a SQLite store in the one `users.db` (schema version 10), a conformance suite, and `append(batch)` all or nothing. A new component `src/usage/` with its own boundary rules (it may use only the users index; only the CaCi controller, the agent view and the service may depend on it). | The same shape as the ledger, which has already proved it. |
| D14 | **The report is an estimate.** The provider's invoice is the truth; `--invoice AMOUNT` prints the difference between the estimate and an amount the operator types for the same period. | Honest about drift (cache, rounding, unpriced models, calls outside CaCi). |
| D15 | **Out of scope**: hosting and Pi costs, the operator's own tests and evaluations (they do not go through accounts), any cap or alert, a screen, per-circle billing, and the model cost of an agent's own reasoning. | Keeps the first version small. |

## Goals and non-goals

**Goals**

1. Show cost and tokens per account, call type, model, circle, day and month.
2. Show whether a few accounts drive the spend (top spenders, distribution) and what a filed note and a status check cost on average.
3. Count every attempt the provider charged for, including repairs and failures.
4. Hold nothing that identifies content or, after deletion, a person.

**Non-goals**

- A spending cap, an alert, a bill or any charge to a user (D1).
- A screen or a route (D3).
- Reconciling automatically with the provider's invoice (D14).

## Definitions

- **Attempt**: one request to the model. A call (a note filed, a status asked) is one or two attempts.
- **Record**: the row of D8 for one attempt.
- **Scope**: `personal` or a circle id, as the controller resolved it.
- **Unpriced**: a model with no entry in the price table.

## Requirements

| ID | Requirement |
|----|-------------|
| UM-FR-01 | `Usage` carries optional cache read and cache creation counts; `inputTokens` is still the total; the Anthropic client fills them; `addUsage` sums them. |
| UM-FR-02 | A record has exactly the fields of D8, checked by one shared function that refuses any other key, a non-whole or negative count, an unknown capability or result, and an id of the wrong shape. |
| UM-FR-03 | The recorder turns a trace into one record per attempt (D4) and never throws. |
| UM-FR-04 | Filing a note, a status, every check and the agent view's pulse record usage charged to the session's user with the scope. |
| UM-FR-05 | A failed append changes nothing the person sees and calls a fixed-words warning hook. |
| UM-FR-06 | `append` is all or nothing; the store keeps no text; deleting a user row clears the user id on its records. |
| UM-FR-07 | The price table is validated strictly; a model with no price is reported as unpriced, with its tokens. |
| UM-FR-08 | The report groups by user, capability, model, circle, day or month, for a month or a date range, and gives cost, tokens, the average cost per filed note and per status, repair and failure rates, and the top spenders and distribution. |
| UM-FR-09 | `npm run usage` reads `users.db` in `CACI_DATA_DIR`, never creates it, shows usernames (and 'deleted account'), writes a CSV only to a new owner-only file, and accepts `--invoice`. |
| UM-FR-10 | `CACI_USAGE_DAYS` purges old records at start-up and daily; the doctor says whether metering is on. |
| UM-NFR-01 | No record, report, CSV or log line holds a note, a request, an answer, a fact id, a name other than the account's username in the operator's own report, or a secret. |
| UM-NFR-02 | Metering adds no model call and no measurable delay: the append is after the answer is ready and its failure is swallowed. |
| UM-NFR-03 | The report's figures equal the provider stand-in's own token counts in an end-to-end test. |

## Threats and controls

| Threat | Control |
|--------|---------|
| The usage table leaks content | D8: no field can hold text; the check refuses other keys; a test searches every record and report for the words used. |
| A metering fault breaks filing or status | D10: the recorder never throws; a failing store is tested. |
| A person is identifiable after deleting their account | D11: trigger clears the user id by any route; tested through the user controller and a direct row delete. |
| The estimate is mistaken for the bill | D14: the report says it is an estimate, lists unpriced models and offers the invoice difference. |
| A missing price hides spend | D7: unpriced is listed with its tokens, never zero. |
| A CSV overwrites or exposes a file | New owner-only file, never overwritten, refused inside the project or data folder (as export-brain). |
| Spend is attributed to the wrong person | D2: the session's user is the only source; there is no parameter to name another. |
| Unbounded growth | D12 retention. |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| UM-AC-01 | Given a note filed with one repair, then two records exist with the attempt numbers and the answering model. |
| UM-AC-02 | Given a model that fails after reporting usage, then one record exists with the error kind and the call still returns its error. |
| UM-AC-03 | Given a status, a check and an agent pulse, then each is recorded with its capability and the scope. |
| UM-AC-04 | Given a circle call, then the record is charged to the asker with the circle as the scope. |
| UM-AC-05 | Given the store failing, then the person's call succeeds and the warning hook is called once with fixed words. |
| UM-AC-06 | Given an account deleted by any route, then its records stay with no user id and the report shows 'deleted account'. |
| UM-AC-07 | Given a model with no price, then the report lists it as unpriced with its tokens and does not include it as zero cost. |
| UM-AC-08 | Given records over two months, then `--month` and `--by` give the right groups and totals, and the CSV matches. |
| UM-AC-09 | Given the provider stand-in's token counts, then the report's totals equal them. |
| UM-AC-10 | Given records older than `CACI_USAGE_DAYS`, then start-up removes them. |
| UM-AC-11 | Given any record, report or CSV, then it contains no note, request, answer, fact id or secret. |
| UM-AC-12 | Given `--invoice`, then the report shows the estimate, the amount and the difference. |

## Residual risks

1. **An estimate, not a bill**: cache rounding, a provider's minimum charges, a model renamed by the provider and calls made outside CaCi (evaluations, the lab) are not in it.
2. **A restart can lose the last record**: the append follows the answer, and a crash between them drops it.
3. **Prices are typed by the operator**: a wrong table gives wrong costs until corrected (and history can be re-costed).
4. **One account can look cheap or dear by luck of the month**: the report is per month, not a forecast.
5. **The record of who asked is the user id until deletion**: while the account exists the operator can see how much each username spent.

## Open questions

1. Should a later version add an alert (not a cap) when an account's month exceeds a figure?
2. Should the report also split by circle size or by role?
