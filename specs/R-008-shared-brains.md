# Shared Circle Brains — Specification

Oct 10, 2026 · @Andy

## Overview

Circles (R-004) are groups with roles and invitations; today **they share no data**. This piece lets a person **share chosen categories of their own brain with a named member of a circle**, read-only. It is where other people's data first becomes readable by someone else, so it is specified separately, with its own threat table and its own release gates.

A **grant** is made by the **owner of a brain** to **one other current member of a circle**, and names **categories** of that brain. The member can then **browse** those categories and the **items filed under them**, and nothing else. They cannot change anything, cannot see any other category (not even that one exists), and cannot pass what they see on through the platform. The owner can **narrow or withdraw** a grant at any time, and a grant **ends by itself** when either person leaves the circle or is removed, when an account is deleted or when the circle is deleted.

Each person keeps their own brain (R-002 D3), and **only CaCi and the LLM ever change a brain, as a result of actions performed** (R-004). Nothing here writes to anyone's graph.

## Decisions (owner, 2026-10-09, and proposals marked)

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Owner:** a grant is **read-only** | Writing into another person's brain (a carer adding a note about them) belongs to "request update" and approval (Backlog item 8) |
| D2 | **Owner:** a grant names **chosen categories**; the items filed under them come with them; everything else stays private | A note about health and one about shopping should not be shared together |
| D3 | **Owner:** **the brain's owner grants to a named circle member, one direction per grant**; the owner can narrow or withdraw at any time; **roles do not carry access** | Consent is the owner's, one person at a time; role names stay setting-agnostic (R-004 D4) |
| D4 | **Owner:** **pseudonymisation and the legal groundwork are release gates**, recorded here and not built here | Read-only sharing sends nothing new to a model; the gates must be met before anyone but the owner uses the service |
| D5 | **Proposed:** a grant lives **inside one circle**, between two **current members**, never to oneself | Membership is the only relationship the platform knows; leaving the circle must end the sharing |
| D6 | **Proposed:** a grant **ends in the same transaction** as any of: the owner or the grantee leaving or being removed, an account being deleted, the circle being deleted; it is stored with the circle store (users.db, schema version 5) | A grant that outlives membership is the worst failure here; one transaction cannot leave one behind |
| D7 | **Proposed:** a grant holds **at most 200 categories**, each an opaque id of 1 to 256 characters of the owner's own graph; setting a grant **replaces** the whole set; an empty set is a withdrawal | Bounded storage and a simple model |
| D8 | **Proposed:** a category must **exist in the owner's graph** when it is granted; if it later disappears the grant simply shows nothing for it | The owner cannot grant what is not theirs; the graph is the source of truth |
| D9 | **Proposed:** reads are **live**: no copy of anyone's data is made, and **every read re-checks the current membership and the current grant** | Withdrawal and leaving take effect on the next request |
| D10 | **Proposed:** an **item is visible** to a grantee if it is filed under **at least one shared category**; its **detail names only the shared categories**; **counts** are counts of items under the shared categories only | A private category's name or existence must never leak through an item or a count |
| D11 | **Proposed:** a grantee cannot **share onwards**: what they can see is not theirs to grant (a grant names categories of the granter's *own* graph only) | Consent does not transfer |
| D12 | **Proposed:** a stranger to the circle, a member with **no grant**, a category that is **not shared**, an item that is **not visible** and a **made-up id** all get **the same not-found answer** | No enumeration of who shares what with whom, or of what exists |
| D13 | **Proposed:** the platform admin has **no** access beyond what any member has | R-004 D12 |
| D14 | **Proposed:** the person receiving a grant is **not notified**, and neither is a withdrawal | Nothing is sent anywhere yet (R-004) |
| D15 | **Proposed:** a new component **`src/sharing/`** composes the circle store (membership and grants), the user controller (the session) and the graph store's reads; `src/circles/` still imports nothing that can read a graph | R-004 CR-NFR-06 |
| D16 | **Proposed:** the data of a visible item is returned **as it is** (capped as in R-003 FR-13), and the grantee sees the owner's username and display name as they already do in the circle | Nothing new is revealed about the person |

D1 to D4 are the owner's answers; D5 to D16 are proposals that stand unless changed.

## Goals and non-goals

Goals:
1. An owner can share chosen categories with a named circle member, see what is shared with whom, and narrow or withdraw it.
2. A member can browse exactly what has been shared with them, and nothing more.
3. Sharing never outlives membership.
4. No request can reach a category, item or graph that was not shared.

Non-goals (not here):
- Writing, proposing, editing or deleting anything in another person's brain.
- Sharing the whole brain, sharing by role, or sharing with a whole circle at once.
- Re-sharing by a grantee.
- Notifications of a grant or its withdrawal, and any audit of who looked at what.
- Relationship labels (carer, family, team).
- Copies or exports of shared data, and any search across shared brains.
- Platform-admin access.
- Anonymising what is shared (the pseudonymisation work in the Backlog).

## Definitions

- **Owner**: the person whose brain it is. **Grantee**: the circle member who may read part of it.
- **Grant**: the set of categories one owner has shared with one grantee in one circle.
- **Shared category**: a category named in a grant. **Shared item**: an item filed under at least one shared category.
- **Shared set**: the shared categories of one owner, as seen by one grantee.

## Visibility rules

| What the grantee asks | What they get |
|---|---|
| Who has shared with me in this circle | The owners (id, username, display name) who have a non-empty grant to me, each with the **number of categories shared** |
| The categories of one owner's shared set | Only the shared categories, with name and the **count of items under them** (the owner's other categories are never listed or counted) |
| The items of a shared category | The items filed under it, with their data (capped) |
| One item | The item's data, and its categories **limited to the shared ones**, with weights; an item filed only under private categories is **not found** |
| A category that is not shared, an item that is not visible, an owner who has not shared, a circle they are not in, a made-up id | **The same not-found answer** |

A category counts as shared only while a grant names it **and** both people are current members.

## Functional requirements

| ID | Requirement |
|----|-------------|
| WS-FR-01 | **Set a grant**: the owner replaces the set of categories shared with one other member of a circle; every category must exist in the owner's graph; at most 200; an empty set withdraws |
| WS-FR-02 | **List what I share**: per other member of a circle, the categories shared with them (id and name) |
| WS-FR-03 | **Withdraw**: remove a grant at any time; takes effect on the grantee's next request |
| WS-FR-04 | **Who shared with me**: the owners with a non-empty grant to me in a circle, with counts |
| WS-FR-05 | **Browse**: categories, a category's items and one item of a shared set, by the visibility rules, paged like the owner's own browsing |
| WS-FR-06 | **Every read re-checks** current membership of both people and the current grant; nothing is cached across requests |
| WS-FR-07 | **A grant ends automatically** when either person leaves or is removed, when an account is deleted, and when the circle is deleted |
| WS-FR-08 | **Not found is one answer**: strangers, members without a grant, unshared categories, invisible items and made-up ids are indistinguishable |
| WS-FR-09 | **Read-only**: no operation in this piece writes to any graph |
| WS-FR-10 | **No re-sharing and no self-grant**: a grant names only categories of the granter's own graph, and never to oneself |
| WS-FR-11 | **Limits**: 200 categories per grant; paging limits as in R-003; a refusal says which limit |
| WS-FR-12 | **Ids are opaque**: category and item ids are any text of 1 to 256 characters and travel in query strings (R-003); circle and user ids have their exact shapes |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| WS-NFR-01 | **No leak through shape**: answers for a visible and an invisible item differ only by the body they carry; the status, headers and error body of every not-found case are identical |
| WS-NFR-02 | **Grants and membership change together**: one transaction, in both the memory and the SQLite store, proved equal by a randomised test as for hand-over (R-004) |
| WS-NFR-03 | **The component boundary**: `src/circles/` imports nothing that can read a graph; `src/sharing/` is the only place that joins grants to graph reads, and only the API and the service may import it |
| WS-NFR-04 | **Fixed messages**: no store, path, SQL or provider text reaches a response |
| WS-NFR-05 | **No graph or user id is taken from a body or query to choose whose graph is read**: the owner is a path parameter checked as a current member with a grant to the caller; the graph id is derived from it, never supplied |
| WS-NFR-06 | **The session cookie is the only credential**, as everywhere |
| WS-NFR-07 | **Schema upgrade**: users.db version 4 becomes version 5 without touching users, sessions, circles or invitations |

## Routes (proposed)

All need the session cookie and the same cross-origin, JSON and size rules as the other routes; circle and user ids are the service's own shapes; category and item ids are query parameters.

| Route | What it does |
|---|---|
| `GET /api/circles/:id/grants` | What I share, per other member (`userId`, username, display name, categories with name) |
| `PUT /api/circles/:id/grants/:userId` | Body `{ "categories": [ids] }`; replaces the set; 200 with the grant, or 204 when the empty set withdraws it |
| `DELETE /api/circles/:id/grants/:userId` | Withdraws; 204 |
| `GET /api/circles/:id/shared` | Who has shared with me (owners with counts) |
| `GET /api/circles/:id/shared/:userId/categories` | `limit`, `cursor`; the shared categories with counts |
| `GET /api/circles/:id/shared/:userId/category?id=` | `limit`, `cursor`; the items of one shared category |
| `GET /api/circles/:id/shared/:userId/item?id=` | One visible item and its shared categories |

Statuses reuse the circle table: 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` is **not** used for sharing (a member without a right gets 404), 404 `NOT_FOUND`, 422 `INVALID_INPUT` (with `field`), 429 `LIMIT_REACHED`, 500 `STORAGE_ERROR`. A grant to someone who is not a current member is **404** with the circle's words, like any stranger.

## Threats and controls

Each row gets, in T-151, the test that covers it.

| Threat | Control |
|--------|---------|
| A member reading outside their grant (a private category, an item reachable only through one) | Every read is filtered by the current grant; an item must be filed under a shared category; a private id gives the same not-found as a made-up one (D10, D12, WS-FR-05, WS-FR-08) |
| A private category's name or existence leaking through an item's categories or a count | Item detail names only shared categories; counts count only shared categories (D10, WS-NFR-01) |
| A grant outliving membership (leaving, removal, account deletion, circle deletion) | Grants end in the same transaction as the membership change, in both stores, tested against each other (D6, WS-FR-07, WS-NFR-02) |
| A request naming another graph (a user id, a graph id, a category of someone else) | The owner is a path parameter that must be a current member with a grant to the caller; the graph is derived from it; categories are checked against the owner's graph at grant time (D8, WS-NFR-05) |
| Re-sharing what a grantee can see | A grant names only categories of the granter's own graph; a grantee has no way to name another person's category (D11, WS-FR-10) |
| A stranger or the platform admin reading shared data | Membership and a grant are required; the admin has no exception; the answer is the one for a missing circle (D12, D13) |
| A withdrawn or narrowed grant still used | No caching: membership and grant are re-checked on every request (D9, WS-FR-06) |
| Enumerating who shares with whom, or which ids exist | One not-found answer for every case; only the caller's own shares are listed (D12, WS-FR-08) |
| A write reaching a graph through this piece | The component has no write path; a recording adapter shows none is ever called (D1, WS-FR-09) |

## What the person is told

| Situation | Words (for the API and the web app) |
|-----------|--------------------------------------|
| Not a member, no grant, not shared, not found | "No such circle, or you are not in it." for the circle; "Not found: it may have been removed." for a category, item or person |
| Too many categories in a grant | The service's message ("at most 200 categories") |
| Something shared with you is withdrawn while you look | The same not-found, with a way back |
| After sharing | A plain statement of what the person can now read (the categories and the items filed under them, nothing else) and that the owner can stop at any time |

## Release gates (recorded, not built here)

Before anyone's data other than the owner's is held, or the service is offered to others:
1. **Pseudonymisation** of notes before they go to a model (Backlog), so that sharing does not widen what a provider sees of other people.
2. A **data processing agreement** and the provider's retention and region terms.
3. A **lawful basis** for holding and sharing the data, and a **risk assessment**.
4. A statement of **who may use the service**, and the consent wording a person sees before sharing.

## Acceptance criteria

| ID | Check |
|----|-------|
| WS-AC-01 | An owner shares two categories with a member; the member sees exactly those and the items filed under them, and no other category, name or count. |
| WS-AC-02 | An item filed under a shared and a private category shows only the shared category; an item filed only under private categories is not found. |
| WS-AC-03 | Narrowing the grant, then withdrawing it, take effect on the member's next request. |
| WS-AC-04 | Leaving the circle, being removed, deleting an account and deleting the circle each end every grant involved, in the same step. |
| WS-AC-05 | A stranger, a member without a grant, the platform admin and a made-up id all get the same not-found, with identical status, headers and body. |
| WS-AC-06 | Nobody can grant a category that is not in their own graph, to themselves, or to someone who is not a current member; more than 200 categories is refused naming the limit. |
| WS-AC-07 | No write primitive is ever called by any read or grant operation. |
| WS-AC-08 | Awkward ids (spaces, markup, slashes, emoji, 256 characters) work for categories and items, only in the query string. |
| WS-AC-09 | A database at version 4 upgrades to version 5 with everything else untouched, and the memory and SQLite stores agree over random worlds. |
| WS-AC-10 | A scan of every response finds no private category name, no graph id and no other person's data. |

## Build order

T-139 this specification; T-140 and T-141 grants in the circle store (memory and SQLite); T-142 and T-143 the sharing component (grant management, reading a shared brain); T-144 and T-145 the routes and the HTTP end-to-end; T-146 and T-147 the web client and logic; T-148 and T-149 the two pages; T-150 serving it, end to end and a hand check; T-151 the security review; T-152 the README.
