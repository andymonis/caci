# CaCi Controller — Specification

Oct 6, 2026 · @Andy

## Overview

The CaCi controller is the layer a front end (the PWA, later) calls. It sits between the HTTP API and the pieces that already exist, and it adds what belongs to none of them: who owns a proposal, how much one account may ask of the model, and the rule that **the graph always comes from the session**. It does three things for a signed-in person:

1. **Capture**: propose a filing for a note (the language model suggests items, categories and links), show a preview, and write it to the person's graph only when they approve it.
2. **Browse**: read their own graph (counts, categories with how many items they hold, the items in a category, one item and where it is filed).
3. **Nothing else, yet**: no editing, no deleting items, no question answering (those do not exist in the library).

It is a new component, `src/caci/`. It composes the user controller (`src/users/`, R-002: sessions and accounts), the capture controller of `src/app/` (propose, preview, approve, reject over one graph; unchanged, still the engine), the LLM component (`src/llm/`) and the graph store (`src/graph_store/`). The HTTP routes are added to `src/api/`, and the wiring and configuration to `src/service/`.

## Decisions (owner, 2026-10-06, and proposals marked)

| # | Decision | Why |
|---|----------|-----|
| D1 | Scope is **authenticated capture plus read-only browsing of your own graph** | It is what a PWA needs to be useful; editing and answering questions have no library support yet |
| D2 | The model is the **free demo model by default**; the real Anthropic model is used only when the operator sets `CACI_LLM=anthropic` and `ANTHROPIC_API_KEY`, for every account at once | Safe by default; one explicit act to send anything out. No per-account consent for now (declined; see Backlog) |
| D3 | **Pending proposals stay in memory**, owned by the account, with an expiry (15 minutes) | They are short-lived previews; surviving a restart is not worth a table and a migration |
| D4 | **Proposed:** a new component `src/caci/`, with routes in `src/api/` and wiring in `src/service/`; `src/app/` is unchanged | Each piece keeps one job; the existing capture controller is tested and stays the engine |
| D5 | **Proposed:** each account may have at most **10 pending** proposals and make at most **30 proposals an hour** (both configurable) | Each proposal costs a model call, and the capture controller's own pending limit is global, so one account could otherwise fill it for everyone |
| D6 | **Proposed:** node and category ids travel in the **query string, not the path** | Ids are opaque; the model may mint a category id (spaces, capitals, non-Latin) that no path pattern allows |
| D7 | **Proposed:** administrators get **no access** to other people's graphs or proposals through this layer | An admin manages accounts (R-002), not their notes |
| D8 | A response never contains the prompt, the model's raw output, a key, a token count or a cost | A front end needs the preview, not the plumbing; and it keeps secrets out of responses by construction |

The first four rows are answers given by the owner; D4 to D7 are proposals that stand unless changed.

## Goals and non-goals

**Goals**

1. A signed-in person can propose, preview, approve and reject the filing of a note, and see the result in their graph.
2. Nobody can see, approve, reject or even detect another person's pending proposal.
3. One account cannot exhaust the shared capacity or run up the model bill on its own.
4. A signed-in person can browse their graph without ever being able to name another.
5. It is clear, in the interface and the documentation, exactly what leaves the machine.

**Non-goals (v1)**: editing, deleting or moving items; question answering; per-account consent; pending proposals that survive a restart; pseudonymisation (see Backlog; it becomes the first thing to plan before anyone else has an account on a service with the real model on); picture and voice input; sharing between accounts (support circles).

## Definitions

- **Proposal**: a suggested filing of one note, held (not written) until approved. Id `prop-...`, minted by the capture controller.
- **Owner**: the account that made the proposal. Recorded by the CaCi controller.
- **Pending**: held and not yet expired, approved or rejected.
- **Mode**: `demo` or `anthropic`, as configured for the whole service.

## Functional requirements

| ID | Requirement |
|----|-------------|
| CC-FR-01 | **Propose**: given a session and a note (`text`, at most 8,000 characters: the categoriser's own limit, refused here with a clear message and without a model call), asks the model for a filing and holds the result as a pending proposal owned by the caller, for their graph. Nothing is written. |
| CC-FR-02 | **Graph from the session**: the graph a proposal reads context from and is later written to is the caller's own graph, taken from the session. No request field can name a graph. |
| CC-FR-03 | **Limits**: an account may have at most 10 pending proposals and may start at most 30 an hour. A request over either is refused with `THROTTLED` (hourly) or `TOO_MANY_PENDING` (pending), saying when to try again where that is known. A refusal is made before the model is called. Both numbers are configurable. |
| CC-FR-04 | **Get**: the owner can read a pending proposal: its id, when it expires, the mode, the plain-text preview, the summary (new items, new and reused categories, links, problems) and the operations they would be approving. |
| CC-FR-05 | **Approve**: the owner approves a pending proposal; it is written to their graph in one all-or-nothing write, and the answer says what was written. A proposal that would fail stays pending after a failed write so it can be retried or rejected. Approving twice writes once. |
| CC-FR-06 | **Reject**: the owner discards a pending proposal. Nothing is written. |
| CC-FR-07 | **Ownership**: anyone but the owner (another account, an admin, a signed-out caller) who reads, approves or rejects a proposal gets exactly the answer given for a proposal that does not exist. |
| CC-FR-08 | **Expiry**: a proposal not approved within its time (15 minutes) can no longer be approved; its owner is told it expired. A restart forgets every pending proposal. |
| CC-FR-09 | **Summary**: counts of items, categories and links in the caller's graph. |
| CC-FR-10 | **Categories**: the caller's categories by id, a page at a time, each with its id, its name (from its data, if it has one) and how many items are filed under it. |
| CC-FR-11 | **Category items**: the items filed under one category, a page at a time, each with its id and its data. |
| CC-FR-12 | **Item**: one item with its data and the categories it is filed under (id, name, weight). |
| CC-FR-13 | **Unknown ids** (a category or item that does not exist in the caller's graph, whatever else exists elsewhere) are `NOT_FOUND`. Ids are opaque text: spaces, capitals, non-Latin characters and 128-character ids all work. |
| CC-FR-14 | **Size**: item data larger than a fixed cap is cut and flagged, so one huge note cannot make a huge response. |
| CC-FR-15 | **Mode and what leaves**: every proposal reports its mode. In `anthropic` mode the note and the names of the caller's existing categories are sent to Anthropic; the documentation says so, and says nothing is anonymised. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| CC-NFR-01 | **No secrets in responses or logs**: no response, log line or error contains the model key, a prompt, a raw model output or a session token. |
| CC-NFR-02 | **Guardrails stay**: only the operations the categoriser allows (`upsertNode`, `link`) can ever reach the graph, whatever a note says; a note is data, never instructions. |
| CC-NFR-03 | **The key** is read once from the environment, held in memory, never written to a file, a log or a response, and never echoed in a configuration error. |
| CC-NFR-04 | **Safe default**: with nothing configured the service uses the demo model and sends nothing anywhere. |
| CC-NFR-05 | **Fixed failure messages**: a failure of a store, the model or the graph store is reported with a fixed message for its kind (no stack, no path, no provider text). |
| CC-NFR-06 | **Bounded memory**: pending proposals are bounded per account and in total; expired ones are dropped. |

## Threats and controls

Each row gets, in T-094, the test that covers it.

| Threat | Control |
|--------|---------|
| Approving or reading another person's proposal | Ownership recorded on every proposal; every non-owner gets the answer for a missing proposal (CC-FR-07); admins have no exception |
| Probing which proposal ids exist | The same answer for a missing proposal and someone else's (CC-FR-07); ids are random and unguessable |
| Filling the shared pending store so others cannot capture | Per-account pending limit (CC-FR-03) below the global one |
| Running up the model bill | Per-account hourly limit checked before the model is called (CC-FR-03); the registration throttle (R-002) bounds how many accounts one client can make |
| Reading another account's graph by guessing ids | The graph is the session's only (CC-FR-02); ids are looked up inside that graph (CC-FR-13) |
| Prompt injection in a note reaching other accounts | A note is only ever shown to the model together with its own owner's categories; the output guard allows only two operations on the owner's graph (CC-NFR-02); a hostile note can at worst file itself badly |
| Notes leaving the machine unexpectedly | Demo model by default (CC-NFR-04); the real model needs two environment variables; the mode is reported on every proposal and documented (CC-FR-15) |
| The key in a log, response, file or error | CC-NFR-01 and CC-NFR-03, tested by scanning everything a test run produces |
| A huge or hostile response size | Pages are bounded; item data is cut (CC-FR-14) |
| Half-written filing | The capture controller's all-or-nothing write; a failed write keeps the proposal (CC-FR-05) |

## Errors

Failures keep their source so the API can map them: the CaCi controller's own (`UNAUTHENTICATED`, `NOT_FOUND`, `EXPIRED`, `THROTTLED`, `TOO_MANY_PENDING`, `INVALID_INPUT`), the capture controller's, the graph store's and the model's.

| Condition | HTTP |
|-----------|------|
| Not signed in | 401 |
| Bad input (empty or oversized note, bad paging) | 422 |
| Proposal or id not found, or not yours | 404 |
| Proposal expired | 410 |
| Proposal that would fail (it has problems), or a write that failed | 409 |
| Over the hourly limit or the pending limit | 429 with `Retry-After` where known |
| The model failed, refused, or timed out | 502 |
| Anything else | 500 with a fixed message |

## HTTP routes (v1)

All need the session cookie (R-002) and the same cross-origin and JSON rules as the account routes.

| Route | What it does |
|---|---|
| `POST /api/capture/propose` | `{ "text" }`; 201 with the proposal |
| `GET /api/capture/proposals/:id` | The pending proposal |
| `POST /api/capture/proposals/:id/approve` | Writes it; 200 with what was written |
| `POST /api/capture/proposals/:id/reject` | Discards it; 204 |
| `GET /api/graph` | Counts |
| `GET /api/graph/categories` | `limit`, `cursor`; categories with item counts |
| `GET /api/graph/category?id=` | `limit`, `cursor`; the items in one category |
| `GET /api/graph/item?id=` | One item and its categories |

A proposal in a response is `{ id, createdAt, expiresAt, mode, text, summary, operations, rationale? }`, where `text` is the plain-text preview, `summary` is `{ newItems, updatedItems, newCategories, updatedCategories, reusedCategories, newLinks, problems, notes }` and `operations` are the operations the person would be approving and `rationale` is the model's short reason, when it gave one.

## Configuration

`CACI_LLM` (`demo`, the default, or `anthropic`), `ANTHROPIC_API_KEY` (required with `anthropic`, ignored otherwise), `CACI_PROPOSALS_PER_HOUR` (30) and `CACI_MAX_PENDING_PER_USER` (10), alongside the settings of R-002.

## Acceptance criteria

| ID | Check |
|----|-------|
| CC-AC-01 | A signed-in person proposes a note, sees the preview, approves it, and finds the note in the categories, in a category's items and as an item; nothing was in the graph before the approval. |
| CC-AC-02 | A second account cannot read, approve or reject the first's pending proposal; the answer equals the answer for a made-up id. An admin cannot either. |
| CC-AC-03 | The 11th pending proposal and the 31st in an hour are refused before the model is called; the other account is unaffected. |
| CC-AC-04 | Browsing shows only the caller's graph, even when two graphs contain the same ids. |
| CC-AC-05 | Ids with spaces, capitals, non-Latin text and 128 characters work in the query string. |
| CC-AC-06 | An expired proposal cannot be approved and says it expired; a restart forgets pending proposals but keeps what was approved. |
| CC-AC-07 | With the demo model nothing is sent anywhere. With `anthropic` (a stand-in provider), the note and category names arrive in the request, the key arrives only in the header, and the key appears in no response, log line or file. |
| CC-AC-08 | A note that contains instructions or markup changes nothing except its own filing. |
| CC-AC-09 | A failed write keeps the proposal pending; approving twice writes once. |
| CC-AC-10 | No response contains a prompt, a raw model output, a key, a token count or a cost. |

## Build order

T-085 this specification and the architecture diagram; T-086 the demo model client; T-087 and T-088 the controller (propose; get, approve, reject); T-089 browsing; T-090 and T-091 the routes; T-092 configuration; T-093 wiring into the service; T-094 end to end, the security review and the documentation. See `.gsd/PLAN.md`.
