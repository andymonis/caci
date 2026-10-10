# Shared Circle Brains — Specification

Oct 9, 2026 · @Andy

**Status: being built as S2 (T-153 to T-170).** Revised 2026-10-10 with the owner's answers: observers may read a circle brain and cannot capture; tasks and actions are not stored in the brain (they are pushed to external tools such as a calendar at categorisation time, a Backlog item); editing and deleting shared items is nobody in v1.

**Relation to R-008.** R-008 (`specs/R-008-shared-brains.md`, built as S1) lets a person share chosen categories of their **own personal brain**, read-only, with one named member. R-009 is a **circle-owned brain** that many members capture into and read. They are separate features that coexist: R-009 never reads a personal brain through a grant, R-008 never touches a circle graph, and a personal capture is unchanged. Whether to retire R-008 later is a Backlog decision.

## Overview

A person has a personal brain and may belong to zero or more care circles. Each circle has a persistent shared brain. Information captured in one circle is visible only to current members of that circle; it is not relevant to another circle. A person's **My Brain** view is a virtual aggregation of their personal brain and every circle brain they may currently read, with the source of every result disclosed.

For example, a person may belong to a parent-care circle and an in-law-care circle. A prescription captured for the in-law appears only in that circle's context. A personal status view can include prescriptions from both circles and identify their sources; a parent-circle status view includes only material captured in that circle, including contributions by every member of it.

This is an application-level scope and authorisation feature. The Bipartite Graph Store (R-001) remains unchanged: every read and write targets exactly one `graphId`. CaCi resolves an authorised scope to a graph before calling it and performs aggregation only after independently authorised reads.

This specification **supersedes R-004's no-data-sharing non-goal** for the scope defined here. R-004 remains the source of truth for circle lifecycle, membership, invitations and its four role names.

## Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Every account keeps its existing personal graph: `user-<userId>`. | Existing R-002 ownership and isolation remain valid. |
| D2 | Every circle owns one persistent graph: `circle-<circleId>`. | A circle is the access boundary; separate graphs make accidental cross-circle reads impossible by construction. |
| D3 | A circle graph persists when a member leaves or is removed. Their previous contributions remain. | Shared records may remain important to the people still in the circle. |
| D4 | `owner`, `manager` and `member` may read and add shared circle information. **`observer` may read but not add** (owner decision, 2026-10-10). | Observers follow a circle without changing what it knows. |
| D5 | Every item captured into a circle is shared with every current role authorised by D4. No private circle item exists in v1. | The owner chose fully shared circle information for now. Private visibility is future scope. |
| D6 | Capture explicitly names one target scope: personal or one circle. A capture never writes to several graphs. | Removes ambiguity and preserves atomicity within one graph. |
| D7 | My Brain is a virtual aggregate, never a copied or materialised graph. Every result discloses whether it came from the personal graph or which circle. | Avoids stale duplicates and immediately removes access when membership changes. |
| D8 | A current membership authorises access; removed or departed members lose future circle-graph access immediately. | Retained records do not imply retained access. It cannot revoke information already seen. |
| D9 | Circle graph ids are derived only by trusted server code from circle ids; no request may name a graph id. | Applies R-002's graph-authorisation principle to circle data. |
| D10 | The existing circle roles still govern circle administration. This spec adds only shared-brain read and capture rights; it does not make circle members direct graph editors. | Capture keeps propose, preview, approve guardrails. |
| D11 | Provenance is shown in every aggregate result and passed to any future answering capability. | A person must know whether information concerns their personal notes, Parent Circle, or In-law Circle. |
| D12 | Editing or deleting shared items, represented care subjects, and role-specific read/write rights beyond D4 are deferred decisions. | They materially affect safety, accountability and the public API. |

## Goals and non-goals

**Goals**

1. Give each circle a durable, isolated shared brain, accessible to its authorised current members.
2. Let a person deliberately capture information into their personal brain or one selected circle brain through the existing propose, preview, approve flow.
3. Let a person view one circle brain without unrelated personal or other-circle information.
4. Let a person view an aggregated My Brain with unambiguous provenance for each result.
5. Preserve circle history when membership changes while enforcing future access from current membership.

**Non-goals (v1)**

- Private items within a circle, per-item access rules, or per-member sharing grants.
- Direct graph writes by one member to another person's personal graph.
- Editing, deleting, moving or copying shared items after approval.
- A general multi-graph graph-store query endpoint.
- A summary or question-answering feature; this specification supplies the scoped context it will need.
- Subject/person modelling, relationships such as carer or patient, notifications, audit history, export, and cross-circle links.
- Claiming that shared health or personal information is anonymised, legally compliant, encrypted, or safe to send to an external model.

## Definitions

- **Personal brain**: the graph derived from the signed-in user's account: `user-<userId>`.
- **Circle brain**: the graph derived from a circle: `circle-<circleId>`.
- **Scope**: the authorised target of a graph action. It is either `{ kind: "personal" }` or `{ kind: "circle", circleId }`.
- **My Brain**: a virtual union of the caller's personal brain and every circle brain they can currently read. It is not a graph and has no graph id.
- **Circle Brain view**: a view of exactly one circle brain, after current membership and role checks.
- **Provenance**: source information attached to a result: `{ kind: "personal" }` or `{ kind: "circle", circleId, circleName }`.
- **Contribution**: a capture approved into a circle brain. `createdBy` and `createdAt` are application-owned metadata when stored; they are not trusted model output.
- **Reading roles**: `owner`, `manager`, `member` and `observer`. **Capturing roles**: `owner`, `manager` and `member`. (There is no other role and no role with direct edit or delete rights.)

## Architecture and boundaries

```text
signed-in user
  -> scope resolver (session + current circle membership + role)
  -> one graph operation
       personal scope -> user-<userId>
       circle scope   -> circle-<circleId>

My Brain query
  -> resolve current readable scopes
  -> query each graph independently
  -> attach provenance
  -> deterministic aggregate and page results
```

The scope resolver belongs in `src/caci/` or a dedicated sibling application component. It may use only public APIs of `src/users/`, `src/circles/`, `src/app/`, and `src/graph_store/`. `src/circles/` remains independent of the graph store: it answers membership and authorisation questions but never reads or writes graphs itself.

The service wires the resolver, the CaCi controller and routes. The graph store must not learn about users, circles, memberships, roles, provenance or aggregation.

## Functional requirements

| ID | Requirement |
|---|---|
| SC-FR-01 | **Circle graph lifecycle.** Creating a circle creates its derived circle graph. Deleting a circle drops its graph. If either cross-store step fails, the controller compensates so a successful response never leaves only one of the circle record or graph. Failed compensation is a fixed storage failure and is recorded for repair. |
| SC-FR-02 | **Persistent records.** Leaving, removal, role change, invitation expiry, and account deletion of a former contributor do not remove or alter the circle graph's existing nodes or edges. Deleting the whole circle removes the whole circle graph. |
| SC-FR-03 | **Scope validation.** Capture, browse and future context requests accept only the two closed scope shapes. Unknown keys, malformed circle ids and a caller-supplied graph id are refused before any graph or model operation. |
| SC-FR-04 | **Personal scope.** A personal scope resolves only to the caller's personal graph. A client cannot name another user, another graph, or a circle through this scope. |
| SC-FR-05 | **Circle scope authorisation.** A circle scope resolves for reading only when the caller is a current `owner`, `manager`, `member` or `observer` of that exact circle, and for capturing only when a current `owner`, `manager` or `member`. A non-member, a removed member and a made-up circle receive the same not-found response for both; an `observer` asking to capture receives that same not-found response. |
| SC-FR-06 | **Scoped capture.** Propose, preview, approve and reject target exactly the scope selected at proposal creation. The proposal records immutable internal scope and graph bindings; approval cannot redirect it even if a request, session or circle changes later. |
| SC-FR-07 | **Shared capture.** An approved circle-scope proposal writes only to that circle graph. Every current member in a reading role can subsequently browse it. No circle-scope capture writes to a contributor's personal graph or another circle graph. |
| SC-FR-08 | **Model context isolation.** A circle-scope proposal reads categorisation context only from the selected circle graph. A personal proposal reads only the personal graph. Categories or items from any other scope are never included in the prompt. |
| SC-FR-09 | **Circle browsing.** A current member in a reading role can browse graph summary, categories, category items and item details for one selected circle. Results include that circle's provenance and contain no data from personal or other circle graphs. |
| SC-FR-10 | **My Brain aggregate.** A signed-in person can browse an aggregate of the personal graph plus every circle graph they are currently authorised to read. Aggregation never creates, changes or persists graph data. |
| SC-FR-11 | **Aggregate provenance.** Every aggregate category, item, edge-derived detail and count identifies its source scope. Results from different scopes with identical node ids remain distinct; provenance is part of aggregate identity and pagination. |
| SC-FR-12 | **Deterministic aggregate paging.** My Brain lists are ordered deterministically by provenance kind, circle id, partition and node id in UTF-16 order. Cursors are opaque and bound to the requested view and the readable-scope set, so they cannot be replayed for another user or after scope membership changes. |
| SC-FR-13 | **Membership changes.** A role demotion below `member`, removal or leaving takes effect on the next request: the circle is omitted from My Brain and direct circle requests return not found. A promotion to `member`, `manager` or `owner` grants access on the next request. |
| SC-FR-14 | **Contribution metadata.** Circle-scope captures store application-controlled contributor and creation metadata sufficient to disclose provenance and support future accountability. Model output cannot set, replace or forge this metadata. |
| SC-FR-15 | **Existing personal behaviour.** R-003 personal capture and browse routes remain equivalent when the default or explicit personal scope is used. Existing personal data is neither copied to nor visible in circle brains. |

## Authorisation matrix

| Role | Circle administration (R-004) | Read circle brain | Capture to circle brain | Directly edit/delete graph data |
|---|---|---:|---:|---:|
| owner | Existing owner rights | Yes | Yes | No |
| manager | Existing manager rights | Yes | Yes | No |
| member | Existing member rights | Yes | Yes | No |
| observer | Existing observer rights | Yes | No | No |
| non-member | None | No | No | No |

The final column preserves the existing capture model: graph mutations are created only by CaCi after model proposal and human approval. The edit/delete policy for previously stored shared items is intentionally not defined in v1.

## API shape

The final routes must follow the existing session-cookie, origin, JSON, response-size and error conventions. This is the intended application contract; exact path names may be adjusted before implementation, but scopes and authorisation semantics may not drift.

```ts
type Scope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'circle'; readonly circleId: string };

type Provenance =
  | { readonly kind: 'personal' }
  | { readonly kind: 'circle'; readonly circleId: string; readonly circleName: string };
```

| Route | Behaviour |
|---|---|
| `POST /api/capture/propose` | Body `{ text, scope? }`; omitted scope means personal for backward compatibility. Returns a proposal bound to the resolved scope and provenance. |
| `GET /api/capture/proposals/:id` | Returns only the proposal owner’s proposal and its scope/provenance; never a graph id. |
| `POST /api/capture/proposals/:id/approve` | Approves only into the graph bound when proposed; authorisation is rechecked for a circle. |
| `POST /api/capture/proposals/:id/reject` | Discards the owner’s proposal. |
| `GET /api/brain/scopes` | Lists the caller's personal scope and currently readable circle scopes with display provenance; does not expose unauthorised circles. |
| `GET /api/brain?scope=personal` | Existing personal summary semantics. |
| `GET /api/brain?scope=circle:<id>` | One authorised circle-brain summary. |
| `GET /api/brain?scope=mine` | My Brain aggregate summary with provenance-aware counts. |
| `GET /api/brain/categories` | Scope-selected or aggregate category listing, paged and provenance-tagged. |
| `GET /api/brain/category` | Scope-selected or aggregate category items; category identity includes provenance in aggregate mode. |
| `GET /api/brain/item` | Scope-selected or aggregate item detail; item identity includes provenance in aggregate mode. |

An HTTP response must never include a raw graph id, another member's private graph, a session token, credentials, an API key, an LLM prompt or model usage/cost.

## Privacy and safety constraints

1. A circle graph contains information deliberately shared with every current member, observers included. The interface must say this before capture and when browsing a circle.
2. Leaving, removal and account deletion prevent future service access but cannot retract data a person has already read, copied or remembered.
3. Shared-circle data may concern people who do not have accounts. It is sensitive personal data. Do not enable an external LLM for real shared data until the pseudonymisation and legal/privacy work in the backlog is completed and accepted.
4. In demo mode, nothing leaves the service. In Anthropic mode, any data admitted to the model context would leave the service. Scope isolation alone is not pseudonymisation or consent.
5. Model prompts and trace/log outputs must carry only the selected scope's allowed context. Tests must inspect captured provider requests to prove this.
6. A platform administrator remains a non-member for circle-brain access unless separately a member with an authorised role.

## Non-functional requirements

| ID | Requirement |
|---|---|
| SC-NFR-01 | **Fail closed.** If scope, membership, role, circle lookup, graph lookup or cross-store compensation cannot be established, no graph read, model call or write occurs. |
| SC-NFR-02 | **No cross-scope leakage.** A test fixture with identical item/category ids in personal, Circle A and Circle B proves every direct and aggregate response has only authorised data and correct provenance. |
| SC-NFR-03 | **Authorisation at use time.** Membership and role are checked on every circle-scoped read, proposal creation and approval; no membership decision is cached across requests. |
| SC-NFR-04 | **Deterministic results.** Aggregate ordering, cursor encoding and provenance are stable for unchanged memberships and graph contents. |
| SC-NFR-05 | **Bounded aggregation.** Aggregate fan-out, page size and concurrent graph reads have explicit configurable limits. Exceeding one gives a fixed, actionable result rather than silently omitting a scope. |
| SC-NFR-06 | **Boundary enforcement.** The graph store remains unaware of circles; the circles component remains unable to read graphs; only the authorised application composition layer joins them. |
| SC-NFR-07 | **No unapproved model writes.** Existing propose-preview-approve guarantees apply identically to personal and circle scopes. |
| SC-NFR-08 | **Observability without secrets.** Logs and metrics may identify a scope kind and stable internal id for operations, but never note text, item data, credentials, API keys or unauthorised circle names. |

## Threats and controls

Each row names the tests that cover it. `src/service/review.test.ts` fails the build if a named test file or test disappears.

| Threat | Control | Covered by |
|---|---|---|
| A member of Circle A reads Circle B | Scope resolver checks current membership for the exact circle; each graph read is independently scoped; aggregate includes only authorised circles. | `src/caci/browse-scopes.test.ts` — "shows only that circle, names it, and the same ids in the personal graph and the other circle never cross"; `src/scopes/resolver.test.ts` — "a stranger, a person in another circle only, a made-up circle and a malformed one all get the same answer"; `src/service/shared-brain-end-to-end.test.ts` — "a stranger and the administrator read nothing of a circle, from every route" |
| An observer captures into shared records, or a stranger reads them | The matrix lets observers read only; an observer's capture request gets the same not-found as a stranger's; tests compare the three. | `src/scopes/resolver.test.ts` — "owner, manager and member may capture and read; an observer may read and gets the one not-found for capture"; `src/caci/controller-scopes.test.ts` — "owner, manager and member may capture; an observer, a stranger, and a made-up circle all get the identical answer and no model call"; `src/api/brain-routes.test.ts` — "an observer, a stranger and a made-up circle are all the same 404"; `src/service/shared-brain-end-to-end.test.ts` — "an observer reads the circle and sees it in My Brain, and cannot capture: the same 404 as a stranger"; `web/shared-brain-journey.test.mjs` — "capture into two circles, browse each and My Brain with provenance, an observer reads but cannot capture, and removal takes effect" |
| A removed member keeps using a saved URL or proposal | Membership is rechecked on every direct read and approval; direct requests become not found, and My Brain omits the circle. | `src/scopes/resolver.test.ts` — "the role is read on every call: a demotion, removal and promotion take effect at once"; `src/caci/controller-scopes.test.ts` — "losing the right to capture before approval writes nothing, discards the proposal and frees its place"; `src/caci/controller-scopes.test.ts` — "the preview of a proposal whose circle access is gone is not shown either"; `src/caci/browse-scopes.test.ts` — "a removal or a demotion to observer, a promotion and a deleted circle take effect on the next request"; `src/service/shared-brain-end-to-end.test.ts` — "removal, demotion and promotion take effect on the next request, and records stay for the others" |
| A proposal created for one circle is approved into another | Proposal stores immutable resolved scope and graph binding; approval ignores client scope input and rechecks membership. | `src/caci/controller-scopes.test.ts` — "two proposals for two circles each land in their own circle, whatever order they are approved in, and a scope sent at approval is ignored"; `src/caci/controller-scopes.test.ts` — "another member of the circle, an admin and a stranger cannot see, approve or reject someone else" |
| LLM receives context from another circle | Context fetch accepts a resolved graph only; provider-request tests seed distinctive data in other scopes and prove it is absent. | `src/caci/controller-scopes.test.ts` — "prompt holds only the categories of its own scope" |
| Aggregate collisions merge unrelated nodes with the same id | Aggregate identity and cursor include provenance plus partition and id; no de-duplication crosses scopes. | `src/caci/brain.test.ts` — "a category is its scope and its id: the same id in four scopes gives four lists"; `src/caci/brain.test.ts` — "one item is its scope and its id: the same id in four scopes gives four items"; `src/service/shared-brain-end-to-end.test.ts` — "the same note into the personal brain and two circles gives the same ids three times, kept apart and tagged in My Brain, in a fixed order"; `web/shared-brain-journey.test.mjs` — "capture into two circles, browse each and My Brain with provenance, an observer reads but cannot capture, and removal takes effect" |
| Circle record and circle graph diverge after a failure | Lifecycle operations use ordered compensation and a repair marker; success is returned only after both sides agree. | `src/scopes/lifecycle.test.ts` — "a graph that cannot be made undoes the circle: neither is left, and the answer is the one fixed failure"; `src/scopes/lifecycle.test.ts` — "if undoing the circle fails too, the answer is still the fixed failure and the next reconcile makes the graph"; `src/scopes/reconcile.test.ts` — "random worlds always end with exactly the circle graphs the circles need, and other graphs and their data untouched"; `src/service/circle-graphs.test.ts` — "at start-up a circle with no graph gets one, a graph with no circle is dropped, and nothing else changes" |
| Platform admin bypasses circle privacy | Circle-brain authorisation uses membership, not platform role; an admin who is not a member gets the same response as a stranger. | `src/caci/browse-scopes.test.ts` — "a stranger, an administrator who is not a member, a person in another circle only and a made-up circle all get the identical answer, from every call"; `src/caci/brain.test.ts` — "an administrator who is not a member sees only their own brain"; `src/api/brain-routes.test.ts` — "a stranger, the administrator, someone in no circle and a made-up circle get the identical 404 from every brain route"; `src/service/shared-brain-end-to-end.test.ts` — "a stranger and the administrator read nothing of a circle, from every route" |
| Shared data is mistaken for private or anonymised data | UI and documentation explicitly state sharing and external-model risks; no claim of anonymisation is made. | `web/capture-page.test.mjs` — "choosing a circle says who can read it and that it cannot be taken back, before and on the preview, and sends the circle id only"; `web/capture-page.test.mjs` — "with the real model the circle notice also says the note goes to Anthropic, unanonymised"; `web/capture-view.test.mjs` — "gives each scope its own notice"; `web/brain-page.test.mjs` — "inside one circle every category, item and filing says the circle" |
| A departed contributor's records disappear | Leaving/removal does not mutate the circle graph; only whole-circle deletion does. | `src/caci/controller-scopes.test.ts` — "records stay when the contributor"; `src/service/shared-brain-end-to-end.test.ts` — "a contributor deleting their account leaves what they added, and the circle they alone belonged to goes with its brain"; `src/service/shared-brain-end-to-end.test.ts` — "deleting a circle drops its brain and nothing else; leaving does not touch it" |

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| SC-AC-01 | Given a user in Parent Circle and In-law Circle, when they capture one note into each, then each circle view returns only its own note and no direct query crosses circles. |
| SC-AC-02 | Given Circle A and Circle B contain nodes with the same ids, when My Brain is listed, then both results appear separately with their correct circle provenance. |
| SC-AC-03 | Given a personal note and notes from two authorised circles, when My Brain is listed, then it returns all and only those scopes with explicit provenance and deterministic order. |
| SC-AC-04 | Given a member has an approved circle-scope note, when another member (owner, manager, member or observer) views the circle, then they see it; when a stranger does, or an observer tries to capture, then they receive the same not-found response. |
| SC-AC-05 | Given a member leaves or is removed, when they request that circle or My Brain, then the direct request is not found and the circle is absent from My Brain; records remain visible to remaining authorised members. |
| SC-AC-06 | Given a proposal is made for Circle A, when approval is attempted with a changed request scope or after losing Circle A membership, then it never writes to any graph; the response follows the fixed refusal policy. |
| SC-AC-07 | Given distinctive categories and items in personal, Circle A and Circle B graphs, when a proposal is made in each scope, then the captured LLM request contains context from only that scope. |
| SC-AC-08 | Given a circle is deleted, when the operation succeeds, then its circle graph is gone and all other personal and circle graphs remain unchanged. |
| SC-AC-09 | Given a circle-creation or deletion graph step fails, when compensation succeeds, then neither a usable orphan circle nor an inaccessible orphan graph remains; when compensation fails, then a fixed storage failure and repair record result. |
| SC-AC-10 | Given identical scope contents and memberships, when the same aggregate request runs twice, then results and cursors are deep-equal; a cursor from another user, scope selection or membership state is refused. |
| SC-AC-11 | Given the personal-scope API is used without a `scope` field, when current R-003 capture and browse flows run, then their outputs and isolation behaviour remain unchanged. |
| SC-AC-12 | Given the platform administrator is not a member of a circle, when they request its scope or aggregate data, then the result is indistinguishable from a stranger's. |
| SC-AC-13 | Given a user belongs to zero circles, when they use My Brain, then it contains only their personal graph and does not issue a circle graph read. |
| SC-AC-14 | Given a circle contributor's account is deleted, when remaining members view the circle, then earlier circle records remain, while the deleted account has no future access. |

### Where each criterion is checked (T-169)

| ID | Where |
|----|-------|
| SC-AC-01 | `src/caci/browse-scopes.test.ts` — "shows only that circle, names it, and the same ids in the personal graph and the other circle never cross"; `src/service/shared-brain-end-to-end.test.ts` — "a member captures into a circle, the preview names it, nothing is written until approval, and only that circle changes"; `src/caci/controller-scopes.test.ts` — "two proposals for two circles each land in their own circle, whatever order they are approved in, and a scope sent at approval is ignored" |
| SC-AC-02 | `src/caci/brain.test.ts` — "categories, each tagged, in a fixed order (own brain, then circles by id, then by category id), the same id kept apart (SC-AC-02, SC-AC-03)"; `src/caci/brain.test.ts` — "a category is its scope and its id: the same id in four scopes gives four lists"; `src/service/shared-brain-end-to-end.test.ts` — "the same note into the personal brain and two circles gives the same ids three times, kept apart and tagged in My Brain, in a fixed order"; `web/shared-brain-journey.test.mjs` — "capture into two circles, browse each and My Brain with provenance, an observer reads but cannot capture, and removal takes effect" |
| SC-AC-03 | `src/caci/brain.test.ts` — "totals over every readable scope and the counts of each, tagged; identical ids are not merged"; `src/api/brain-routes.test.ts` — "the summary and the categories cover every readable scope, each tagged, in a fixed order, and page"; `src/caci/brain.test.ts` — "their own brain first, then each circle they are in with their role and whether they may capture; circles they are not in are absent" |
| SC-AC-04 | `src/service/shared-brain-end-to-end.test.ts` — "an observer reads the circle and sees it in My Brain, and cannot capture: the same 404 as a stranger"; `src/caci/controller-scopes.test.ts` — "owner, manager and member may capture; an observer, a stranger, and a made-up circle all get the identical answer and no model call"; `src/caci/browse-scopes.test.ts` — "every reading role may browse it (an observer included), and the results are frozen"; `src/api/brain-routes.test.ts` — "an observer, a stranger and a made-up circle are all the same 404" |
| SC-AC-05 | `src/service/shared-brain-end-to-end.test.ts` — "removal, demotion and promotion take effect on the next request, and records stay for the others"; `src/caci/browse-scopes.test.ts` — "a removal or a demotion to observer, a promotion and a deleted circle take effect on the next request"; `src/caci/brain.test.ts` — "a removal shows on the next request"; `src/scopes/resolver.test.ts` — "the role is read on every call: a demotion, removal and promotion take effect at once" |
| SC-AC-06 | `src/caci/controller-scopes.test.ts` — "two proposals for two circles each land in their own circle, whatever order they are approved in, and a scope sent at approval is ignored"; `src/caci/controller-scopes.test.ts` — "losing the right to capture before approval writes nothing, discards the proposal and frees its place"; `src/caci/controller-scopes.test.ts` — "a membership check that fails at approval keeps the proposal pending, writes nothing, and works when the store is back" |
| SC-AC-07 | `src/caci/controller-scopes.test.ts` — "prompt holds only the categories of its own scope" |
| SC-AC-08 | `src/scopes/lifecycle.test.ts` — "an owner deleting drops the record and the graph with its notes"; `src/scopes/lifecycle.test.ts` — "someone who may not delete, and a stranger, change nothing: the graph and its notes stay"; `src/service/circle-graphs.test.ts` — "creating a circle makes its graph, deleting it drops the graph and its notes, and other graphs are untouched"; `src/service/shared-brain-end-to-end.test.ts` — "deleting a circle drops its brain and nothing else; leaving does not touch it" |
| SC-AC-09 | `src/scopes/lifecycle.test.ts` — "a graph that cannot be made undoes the circle: neither is left, and the answer is the one fixed failure"; `src/scopes/lifecycle.test.ts` — "if undoing the circle fails too, the answer is still the fixed failure and the next reconcile makes the graph"; `src/scopes/lifecycle.test.ts` — "a graph that cannot be dropped is tried twice, then reported in fixed words; the circle is gone and the reconcile removes the graph" |
| SC-AC-10 | `src/caci/brain.test.ts` — "the same request twice gives the same results and the same cursors (SC-AC-10)"; `src/caci/brain.test.ts` — "a cursor is refused for another person, after the readable scopes change, when it is not one we gave, and in its non-canonical spellings"; `src/caci/brain.test.ts` — "a cursor is bound to the person even when two people can read the same circles"; `src/caci/brain.test.ts` — "a cursor is bound to the person, the scope, the category and the view" |
| SC-AC-11 | `src/caci/controller-scopes.test.ts` — "a proposal without a scope, and with the personal scope, has no scope key and writes to the personal graph only"; `src/caci/browse-scopes.test.ts` — "the same answers, no scope key, and nothing from any circle"; `src/api/brain-routes.test.ts` — "with no scope, or the personal scope, it is the same as before and the proposal has no scope"; `src/api/brain-routes.test.ts` — "an observer may browse; the old /api/graph routes still give the same personal answers as scope=personal" |
| SC-AC-12 | `src/caci/browse-scopes.test.ts` — "a stranger, an administrator who is not a member, a person in another circle only and a made-up circle all get the identical answer, from every call"; `src/caci/brain.test.ts` — "an administrator who is not a member sees only their own brain"; `src/service/shared-brain-end-to-end.test.ts` — "a stranger and the administrator read nothing of a circle, from every route"; `src/api/brain-routes.test.ts` — "a stranger, the administrator, someone in no circle and a made-up circle get the identical 404 from every brain route" |
| SC-AC-13 | `src/caci/brain.test.ts` — "a person in no circle reads only their own graph, and no circle graph is touched (SC-AC-13)"; `src/scopes/resolver.test.ts` — "a person in no circle has only their own brain, and the circle store is asked once for their circles" |
| SC-AC-14 | `src/service/shared-brain-end-to-end.test.ts` — "a contributor deleting their account leaves what they added, and the circle they alone belonged to goes with its brain"; `src/caci/controller-scopes.test.ts` — "records stay when the contributor"; `src/caci/browse-scopes.test.ts` — "what a person captured into a circle is readable there with who added it" |

The journey over the real service also ends the review with the pages' own code: `web/shared-brain-journey.test.mjs` captures into two circles, browses each and My Brain, reads as an observer and shows removal taking effect.

**Looked at by hand in Chrome (T-168, recorded in STATE.md):** an observer's capture choice and read-only line, the circle notice before and on the preview, the approved note in My Brain marked with its circle, the observer's circle with no capture link, a removal shown after Refresh, an injected script blocked, no browser storage.

### Residual risks (not covered, with the reason)

1. **What a member has already read cannot be taken back.** A note in a circle brain is visible to every current member who may read; once read, copied or remembered it stays so (D3 keeps records after a member leaves, and nobody can edit or delete a shared item in this release).
2. **A circle brain may describe people who have no account.** Notes about a patient, a parent or a neighbour are visible to every member; those people have not consented and cannot see or correct them. This is the legal groundwork in the release gates, not a technical control.
3. **Scope isolation is not pseudonymisation.** Keeping circles apart limits who reads a graph; it does not hide anyone from the service operator or from the model provider.
4. **The real model receives circle notes.** With `CACI_LLM=anthropic` the note and the names of that circle's categories go to Anthropic unanonymised, whoever later reads them (R-003 residual risk 1); the page says so before a circle capture.
5. **No edit and no delete.** A wrong or unwanted note stays until the whole circle is deleted; reject works only before approval.
6. **Aggregate fan-out is bounded, not free.** My Brain reads every readable scope one after another; a person in more circles than `CACI_MAX_BRAIN_SCOPES` allows is refused a combined view (one circle can still be read), and a very large circle makes a combined page slower.
7. **Free text can name anything.** An item's title and summary are shown as written (capped); isolation filters whole graphs, not words.
8. **Nobody is told.** Members are not notified of a new note, and a contributor is not told who read it; the stamp shows who added an item, not who looked.
9. **Plain-text files.** `graphs.db` and `users.db` are readable by whoever can read the data folder (R-002 residual risk); circle graphs are no exception.
10. **Two stores, one repair.** Circle records and circle graphs live in different files; the ordered steps, the retry and the reconcile at start-up make a divergence temporary, not impossible, and a graph whose drop keeps failing waits for the next start.
11. **A view is as old as its last load.** The page keeps what it loaded between screens and two tabs do not know about each other; the service re-checks everything on every request, so a stale page can only show something that is then refused.
12. **What was looked at by eye is one browser on one machine.** Narrow and dark layouts, a screen reader and the select's native drop-down were not tried by hand; the structure is covered by checks on the pages.

## GSD build order

1. **Specification and boundaries.** Register R-009, update R-004/R-003/README wording that says circles share no data, update the container diagram, and define the cross-store lifecycle/repair contract. Exit: decisions, API scope types, security review template and acceptance criteria are approved.
2. **Scope resolver and graph lifecycle.** Add trusted `circleGraphId`, create/drop compensation, repair handling, and tests for create/delete failures. Exit: SC-FR-01/02 and SC-AC-08/09.
3. **Circle authorisation policy.** Add the read and capture decisions independently of R-004 administration rights, with a pure table and membership-at-use-time tests. Exit: SC-FR-05/13 and SC-AC-04/05/12.
4. **Scoped capture.** Extend CaCi proposal ownership, model context loading, preview and approval with immutable scope binding. Preserve personal compatibility. Exit: SC-FR-03 to 08, 14 and SC-AC-01/06/07/11.
5. **Scoped browse.** Add circle-brain browse routes and provenance-bearing response types. Exit: SC-FR-09 and direct isolation cases.
6. **My Brain aggregation.** Implement bounded deterministic fan-out, provenance identity, aggregate cursors and aggregate route/view. Exit: SC-FR-10 to 12 and SC-AC-02/03/10/13.
7. **Web app.** Let a person choose a visible scope before capture and browse personal, one circle or My Brain. State the sharing/model notice before a circle capture. Exit: accessible, text-only UI journey over two circles.
8. **End-to-end, review and documentation.** Test real SQLite service behaviour through role and membership changes; complete threat/criterion mapping, docs and residual risks. Exit: all SC-AC checks mapped to durable tests and `npm run gate` passes.

## Decisions settled for the first release

1. **Editing and deleting an approved shared item:** nobody in v1 (the graph is append-only for members; whole-circle deletion is the only removal). A later release may let the contributor or owners and managers remove an item, with an audit trail.
2. **Cross-store repair:** there is no repair table. An idempotent **reconcile** compares circle records with circle graphs, creates a missing graph and drops a graph whose circle no longer exists; it runs at start-up and after an account deletion (which can dissolve a circle through the database trigger). A failed compensation is a fixed storage failure that the next reconcile repairs.
3. **Tasks and actions:** out of scope; if something needs doing it is pushed to an external tool (such as a calendar) at categorisation time, which needs its own specification.
