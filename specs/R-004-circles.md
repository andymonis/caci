# Circles — Specification

Oct 7, 2026 · @Andy

## Overview

A **circle** is a shared group of people with a role each. It is how CaCi will, later, let people who look after, work with or depend on one another see parts of each other's brains. **This first piece (C2) is only the group itself**: creating a circle, inviting people into it, accepting or declining, giving people roles, and leaving or removing. **No member can see or change anyone's graph through a circle.** Each person keeps exactly one graph of their own (R-002); a circle does not hold one, and nothing here reads or writes a graph.

Two things the owner has said about the later sharing work are recorded here so that this piece does not get in its way:

1. A person can be in several circles in different positions (a carer in one, cared for in another), so a role belongs to a **membership**, never to an account.
2. Only CaCi and the language model ever change a brain, as the result of actions performed (a note added, say); a member never edits another person's brain directly. Circles will only ever grant *restricted reading*, decided in a later specification.

CaCi is meant to stay a generic platform that later requirements are aimed at, so **role names say nothing about any setting** (no "carer", "patient", "teacher"). A later piece may attach labels and sharing policies to roles or memberships without changing the code that decides who may invite whom.

It is a new component, `src/circles/`, stored in the existing user database (`users.db`, like sessions), with routes in `src/api/` and wiring in `src/service/`. It takes a session token and asks the user controller who that is; it never looks at passwords or graphs.

## Decisions (owner, 2026-10-07, and proposals marked)

| # | Decision | Why |
|---|----------|-----|
| D1 | A circle is a **shared group**, not centred on one person; a person may be in several, in different roles | Owner's answer: someone can be a carer in one circle and cared for in another |
| D2 | This milestone is **membership and roles only**: no member can see or change anyone's graph | Owner's answer. Sharing is where other people's data enters, so it needs pseudonymisation and the legal groundwork first (Backlog) |
| D3 | Joining is **invite, then the invitee accepts**; either side can leave or remove at any time | Owner's answer. Nobody is put in a group without agreeing |
| D4 | Roles are a **small fixed set with environment-agnostic names**: `owner`, `manager`, `member`, `observer` | Owner's answer. A closed list in code, like the user roles; labels for particular settings come later without changing it |
| D5 | **Proposed:** `owner` may do everything in the circle; `manager` invites, removes and moves people between `member` and `observer` but cannot touch owners or managers; `member` and `observer` see the circle and its people and may leave, and are equal in power for now (the difference is recorded for the later sharing work) | The smallest set that lets a group be run by more than one person without letting a helper take it over |
| D6 | **Proposed:** a circle **always has at least one owner**; the last owner can neither leave, be removed nor be demoted (`LAST_OWNER`) | A circle nobody can manage is a circle nobody can delete or fix |
| D7 | **Proposed:** nobody can change **their own** role; to step down an owner makes someone else an owner, and another owner then changes their role (or they leave) | Closes self-promotion and keeps every role change a decision by someone else |
| D8 | **Proposed:** a new component `src/circles/` in the existing `users.db`, with routes in `src/api/` and wiring in `src/service/` | The accounts are already there, deleting an account must remove its memberships in the same transaction, and a second database file would make that impossible |
| D9 | **Proposed:** an invitation names a **username** and a role and expires after **7 days**; the answer to an invitation is **identical whether or not that account exists**, whether or not they are already a member, and whether or not it was a repeat | Otherwise inviting is a way to find out who has an account (R-002 works hard to avoid that) |
| D10 | **Proposed:** limits, all settable: **20 circles per person**, **50 people per circle**, **50 open invitations per circle**, and **30 invitations an hour per person** | Bounds storage and spam; each is a number someone can change if a household or team needs more |
| D11 | **Proposed:** when an account is deleted its memberships and invitations go with it in the same transaction; a circle it solely owned passes to its **longest-standing manager, else longest-standing member, else observer, else is dissolved** | Never leaves a circle without an owner or with a member who has no account, and never asks a deleted person to hand over |
| D12 | **Proposed:** the platform admin (R-002) has **no power over circles**: no listing, no joining, no role changes | An admin manages accounts, not groups; the same position as for graphs in R-003 |
| D13 | A person who is **not a member** of a circle (or has only been invited) gets exactly the answer given for a circle that does not exist | Same rule as R-003's proposals: no way to probe which circles exist |

D1 to D4 are the owner's answers; D5 to D13 are proposals that stand unless changed.

## Goals and non-goals

**Goals**

1. A signed-in person can create a circle, invite people by username, and accept or decline invitations, with nothing taking effect without the invitee's agreement.
2. Roles decide who may invite, remove and change roles, from one table that is tested exhaustively.
3. A circle can never be left without an owner, even when people act at the same moment or an account is deleted.
4. Nobody can learn of a circle they are not in, or whether an account exists, from the answers.
5. Nothing here exposes anyone's graph, email or credentials.

**Non-goals (v1)**: any sharing of graphs or notes between members; what members may see of each other's brains (later, after pseudonymisation); labels such as "carer" or "family"; notifications of invitations (nothing is sent anywhere); circles inside circles; per-circle settings beyond a name and description; invitations by email address; transfer between circles; an audit log; a platform-admin view.

## Definitions

- **Circle**: id `c` plus 16 characters (like user ids), a name (1 to 80 characters), an optional description (up to 500), a creation time.
- **Membership**: one account in one circle with one **role**, and the time they joined.
- **Role**: `owner`, `manager`, `member` or `observer`.
- **Invitation**: id `i` plus 16 characters, the circle, the invited **username** (lower-case), the role offered, who invited, created and expiry times. Open until accepted, declined, revoked or expired.
- **Longest-standing**: the earliest `joinedAt`, ties broken by user id in plain code-unit order.

## Roles and what they may do (D5, D6, D7)

| Action | owner | manager | member | observer |
|---|---|---|---|---|
| See the circle and its members | yes | yes | yes | yes |
| Leave | yes, unless last owner | yes | yes | yes |
| Rename or describe the circle | yes | yes | no | no |
| Delete the circle | yes | no | no | no |
| Invite someone as `owner` or `manager` | yes | no | no | no |
| Invite someone as `member` or `observer` | yes | yes | no | no |
| Revoke an open invitation | any | those for `member` or `observer` | no | no |
| Change another person's role | any, among all four roles | only between `member` and `observer`, and only for people who are one of those now | no | no |
| Remove another person | anyone but the last owner | only `member` or `observer` | no | no |
| Change **your own** role | no (D7) | no | no | no |

`authorise(actorRole, action, targetRole?, newRole?)` is the single place this table lives, as a pure function, tested over every cell.

## Functional requirements

| ID | Requirement |
|----|-------------|
| CR-FR-01 | **Create**: a signed-in person creates a circle with a name and optional description and becomes its `owner`. A person may be in at most 20 circles (D10). |
| CR-FR-02 | **See**: a member sees their circles (id, name, description, their role, member count) and, for one circle, its members (user id, username, display name, role, joined). Never an email, a hash or a token. |
| CR-FR-03 | **Edit and delete**: owners and managers rename or describe a circle; only owners delete it, which removes its memberships and invitations. |
| CR-FR-04 | **Invite**: an owner or manager invites a username with a role they may give. Nothing takes effect until the invitee accepts. The answer is identical whatever the target is (D9). A circle holds at most 50 open invitations and 50 people. A person may send at most 30 invitations an hour. |
| CR-FR-05 | **Respond**: only the account named may see, accept or decline an invitation; a stranger, a made-up id and an expired or withdrawn invitation all get the same answer. Accepting adds the membership with the offered role, atomically with closing the invitation; if the circle is full, or the person already has 20 circles, it is refused and the invitation stays open. A person already in the circle who accepts keeps their current role. |
| CR-FR-06 | **Revoke**: those who may invite that role can withdraw an open invitation. |
| CR-FR-07 | **Roles**: role changes and removals follow the table above; the caller's role is read from the store on every request, so a demotion takes effect at once on a session already held. |
| CR-FR-08 | **Leave**: anyone may leave; the last owner is refused (`LAST_OWNER`) and told to make someone else an owner or delete the circle. |
| CR-FR-09 | **Last owner**: no sequence of actions, simultaneous or not, leaves a circle with no owner. |
| CR-FR-10 | **Not a member**: anyone who is not a member of a circle gets the answer for a circle that does not exist (D13); a member who lacks the permission is told `FORBIDDEN`. |
| CR-FR-11 | **Account deletion** removes the person from every circle and cancels their invitations, and hands a circle they solely owned on, or dissolves it (D11), in the same transaction. |
| CR-FR-12 | **Expiry**: an open invitation stops working after 7 days (settable) and is removed when next met. |
| CR-FR-13 | **Unknown input** (extra fields, a role that does not exist, a bad username, a name that is empty or too long) is refused by name. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| CR-NFR-01 | **No secrets or private details in responses or logs**: no email, hash, token or graph id; no other circle's data. |
| CR-NFR-02 | **Atomic rules live in the store**: the last-owner rule, the caps, accept-with-membership and the hand-over on account deletion hold under concurrency and across two processes on one file. |
| CR-NFR-03 | **Same answer, same work**: an invitation to a missing account, an existing one and an existing member look the same in the response and in what the inviter can later list. |
| CR-NFR-04 | **Bounded**: every list is paged and every count capped; inputs have length limits. |
| CR-NFR-05 | **Fixed failure messages** per kind (no store text, path or stack). |
| CR-NFR-06 | **No graph access**: the component imports nothing that can read a graph, enforced by the boundary test. |
| CR-NFR-07 | **Safe by default**: with no circles created, nothing changes for anyone; existing databases upgrade without touching users, sessions or graphs. |

## Threats and controls

Each row gets, in T-107, the test that covers it.

| Threat | Control |
|--------|---------|
| Finding out which circles exist, or who is in one, by guessing ids | A non-member gets the answer for a missing circle (CR-FR-10, D13); ids are random |
| Finding out who has an account by inviting usernames | Identical answer and identical stored effect for every target (D9, CR-NFR-03); usernames are checked only for shape |
| Taking a role one may not have (self-promotion, a manager making owners) | One permission table, tested exhaustively; no self role change (D7); the role is read from the store on every request |
| A manager overriding an owner or another manager | The table: managers act only on `member` and `observer` |
| Leaving a circle ownerless by races or by deleting an account | The last-owner rule is in the store (CR-NFR-02); the account-deletion hand-over is in the same transaction (D11) |
| Spamming people with invitations | Per-circle cap, per-person hourly limit, invitations expire, and the recipient can decline; nothing is sent outside the service |
| A later registrant receiving an invitation addressed to a name that had no account | Invitations expire in 7 days and need acceptance; the invitee sees the circle's name and who invited them before agreeing; residual risk noted |
| Accepting or reading someone else's invitation, or one from another circle | Only the named account can see or accept it; every other case is the same not-found answer |
| Platform admin reading or editing groups | None granted (D12); no admin code path in this component |
| Leaking emails, hashes or graphs through member lists | Fixed response shapes; nothing here can read a graph (CR-NFR-06) |
| Unbounded growth (circles, members, invitations) | Caps and paging (D10, CR-NFR-04) |

## Errors

| Condition | Code | HTTP |
|-----------|------|------|
| Not signed in | `UNAUTHENTICATED` | 401 |
| Not a member of that circle, a made-up id, or an invitation that is not yours, expired or gone | `NOT_FOUND` | 404 |
| A member without the right for this action | `FORBIDDEN` | 403 |
| Bad or unknown input | `INVALID_INPUT` | 422 |
| The last owner would be lost | `LAST_OWNER` | 409 |
| A person is already a member (where that is an error), or the target is not in this state | `CONFLICT` | 409 |
| A cap is reached (circles, members, open invitations) | `LIMIT_REACHED` | 429 |
| Too many invitations in an hour | `THROTTLED` | 429 with `Retry-After` |
| A store failed | `STORAGE_ERROR` | 500 (fixed message) |

## HTTP routes (v1)

All need the session cookie and follow the same cross-origin, JSON and size rules as the other routes. Ids are in the path here because they are generated by the service (`c...`, `i...`, `u...`), never chosen by a client.

| Route | What it does |
|---|---|
| `POST /api/circles` | `{ name, description? }`; 201 with the circle |
| `GET /api/circles` | My circles, paged |
| `GET /api/circles/:id` | One circle |
| `PATCH /api/circles/:id` | Rename or describe |
| `DELETE /api/circles/:id` | Delete (owner); 204 |
| `GET /api/circles/:id/members` | The members, paged |
| `PATCH /api/circles/:id/members/:userId` | `{ role }`; change someone's role |
| `DELETE /api/circles/:id/members/:userId` | Remove someone; 204 |
| `POST /api/circles/:id/leave` | Leave; 204 |
| `POST /api/circles/:id/invitations` | `{ username, role }`; 202 `{ invited: true }`, the same for every target |
| `GET /api/circles/:id/invitations` | The circle's open invitations (owner, manager) |
| `DELETE /api/circles/:id/invitations/:invitationId` | Revoke; 204 |
| `GET /api/invitations` | Invitations addressed to me |
| `POST /api/invitations/:id/accept` | Join; 200 with the membership |
| `POST /api/invitations/:id/decline` | Decline; 204 |

## Configuration

`CACI_MAX_CIRCLES_PER_USER` (20), `CACI_MAX_MEMBERS_PER_CIRCLE` (50) and `CACI_INVITATION_DAYS` (7), alongside the settings of R-002 and R-003. The open-invitation cap (50) and the hourly invitation limit (30) are fixed in v1.

## Acceptance criteria

| ID | Check |
|----|-------|
| CR-AC-01 | A person creates a circle and is its owner; invites a second person as `manager` and a third as `member`; both accept; all three see the same members. |
| CR-AC-02 | Nothing takes effect before acceptance; declining, revoking and expiry each end an invitation, and an invitation cannot be used twice. |
| CR-AC-03 | The permission table holds for every role, action and target role, over HTTP for a representative set. |
| CR-AC-04 | A stranger gets the same 404 for a real circle as for a made-up id, for every route. |
| CR-AC-05 | Inviting an existing username, a missing one, an existing member and a repeat all give the same response. |
| CR-AC-06 | Nobody changes their own role; a manager cannot touch an owner or another manager; the last owner cannot leave, be removed or be demoted. |
| CR-AC-07 | Two owners removing each other at the same moment leave exactly one; eight accepting one invitation produce one membership. |
| CR-AC-08 | The caps (20 circles, 50 members, 50 open invitations, 30 invitations an hour) are enforced and the person is told. |
| CR-AC-09 | Deleting an owner's account passes the circle to the longest-standing manager, else member, else observer, else dissolves it; no circle ends without an owner; no membership or invitation outlives an account. |
| CR-AC-10 | A restart keeps circles, members and open invitations; a clean close leaves only the two database files. |
| CR-AC-11 | No response holds an email, a hash, a token or a graph id; the platform admin gets no more than any other non-member. |
| CR-AC-12 | A version 2 `users.db` upgrades with its users and sessions untouched. |

## Build order

T-096 this specification and the container diagram; T-097 component scaffold and the permission table; T-098 store port, memory store and conformance suite; T-099 SQLite store; T-100 account deletion; T-101 to T-103 the controller (circles, invitations, roles); T-104 and T-105 the routes; T-106 wiring and settings; T-107 end to end and security review; T-108 README.
