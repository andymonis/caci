# Joining a Circle by Link — Specification

Nov 6, 2026 · @Andy

**Status: draft, planned as G3.** Part F of the withdrawn `R-020`. D1 is the owner's (2026-11-06). On 2026-11-06 the owner also decided that **joining needs approval by default (D13)** and that **a link is one-time use by default (D4)**. The rest are proposed by me and stand unless the owner changes them. It is **off by default** and sits behind the release gates.

## Overview

Today a person joins a circle only by **invitation by username** (R-004): the inviter must know the exact username, the invitee must already have an account, and the invitation answer never says whether the account exists. That is right for a family, and clumsy for a group that already talks in a chat: an organiser wants to drop **one link** in the group and let people join.

This spec adds a **join link**: a revocable, expiring, use-limited secret that an owner or manager creates for a circle with a role. Whoever opens it, signs in (or registers) and confirms, becomes a member with that role. It reuses everything about membership: the roles, the caps, the last-owner rule and the roster. It adds no notification, no approval inbox and no change to how invitations work.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** an organiser can share one link in an existing chat; joining creates the person's own account and personal brain if they have none. | Organisers spread the product where the group already talks. |
| D2 | **Off by default:** `CACI_JOIN_LINKS=false`. When off, the routes answer as if they did not exist. | A way for strangers to enter a circle must be a deliberate act, and it is behind the release gates (D14). |
| D3 | A link is a **token**: `cjoin_` plus 43 random base64url characters, **shown once** at creation, **only its SHA-256 stored** (as for sessions and agent tokens). | A copy of the database must not let anyone join. |
| D4 | A link has: the circle, a **role**, an **expiry** (default 7 days, at most 30), a **use limit** (**default 1, one-time**, at most 100), an **approval** flag (**default on**, D13), a **label** (the creator's note, 1 to 80 characters), who made it and when, and a revoked flag. **Role:** an owner may offer `member` or `observer` (default `observer`); a manager only `member` or `observer`; **never `owner` or `manager`**. | A link can be passed on, so it must never confer power. |
| D5 | Who may create, list and revoke links: **owners and managers** (the invite rule, R-004). A member and an observer cannot; a stranger gets the one no-such-circle answer. | Same permissions as inviting. |
| D6 | The token travels in the **URL fragment** (`/#/join/<token>`), which the browser never sends to a server, a log or a referrer. The page reads it, then sends it in a request body. | Keeps the secret out of logs and proxies. |
| D7 | **Preview, then join, in two steps:** `POST /api/join/preview { token }` returns the circle's **name**, the **role** offered and the creator's **display name** (and nothing else) so the person knows what they are joining; `POST /api/join { token }` joins. Both need a signed-in session. A signed-out person is sent to sign in or create an account first, and the token is held **in page memory only** (a reload loses it; they open the link again). | A person must see where they are going before they join, and nothing is kept in the browser (R-005 D8). |
| D8 | **Every kind of miss is the same answer**: a made-up token, an expired, revoked or used-up link, a link for a deleted circle. A person already in the circle is told they are already a member, and a person who already has a pending request is told it is waiting (their role is **not** changed and **no use is consumed** in either case). | No probing for which links exist, and a repeat click is harmless. |
| D9 | Joining (approval off) and approving a request are each **one atomic step in the store**: check the link (live, uses left), the circle's member cap, the person's circle cap and membership, then add the member at the link's role and count the use, as `acceptInvitation` does. A full circle or a person at their cap is `LIMIT_REACHED`: the use is **not** consumed, and an approval that cannot complete leaves the request pending. | Concurrency must not exceed the use limit or the cap. |
| D10 | Registration is **not bypassed**: a link does not create accounts. If `CACI_ALLOW_REGISTRATION` is `false`, only people who already have an account can use it. | The operator's registration switch stays the single control. |
| D11 | Throttling: previews and joins are throttled per client address like logins, and a miss is recorded, so guessing is slow (it is 256 bits and hopeless, this is for noise). | Defence in depth. |
| D12 | The change **never reveals the circle to anyone without the link**; the creator sees their links' labels, role, expiry, uses and limit, never the token (it cannot be recovered; create another). | The secret is shown once. |
| D13 | **Owner: approval by default.** A link has an `approval` flag, **on by default** (a creator may turn it off for a trusted group). With approval on, opening a live link and confirming creates a **join request**, not a membership; **an owner or manager approves or declines it**. The use is counted when the request is made (so a link cannot be used to flood requests), a person has at most one pending request per circle, a circle holds at most 20 pending requests, and a request lapses after 7 days. Approving adds the person at the link's role in one atomic step with the caps (D9); a decline or lapse leaves nothing. With approval off, joining is immediate (D9). | A leaked or passed-on link must not by itself add someone to a shared brain. |
| D14 | The release gates of R-008 and R-009 apply: pseudonymisation and the legal groundwork before anyone outside the owner's family test joins a circle this way. Owner and family only at first. | A circle's brain is shared sensitive data. |
| D15 | Deleting a circle, deleting its creator's account or removing the creator from the circle: the circle's deletion removes its links; **the creator leaving does not revoke** their links (the circle owns them), and an owner or manager can revoke any link in the circle. | Links belong to the circle, not to one person's membership. |

## Goals and non-goals

**Goals**

1. An organiser can create a link, share it in a chat, and members join by it.
2. A link cannot confer power, cannot be used more than its limit or after its expiry, and can be revoked at once.
3. The same not-found answer for every bad link; concurrency cannot exceed a limit or a cap.

**Non-goals**

- Account creation by link (D10), invitations by email or by phone number.
- Notifications to the organiser or the person (they look at the circle screen and the join screen).
- A public circle directory or any way to find a circle without its link.
- Link previews in chat apps (the fragment is not sent, so none can be built).

## Definitions

- **Join link**: the secret URL of D3 to D6.
- **Live**: not expired, not revoked and with uses left.
- **Use**: one person becoming a member through the link.

## Requirements

| ID | Requirement |
|----|-------------|
| JL-FR-01 | With `CACI_JOIN_LINKS` off, every join-link route is a plain 404. |
| JL-FR-02 | Owners and managers create, list and revoke links for their circle; role, expiry, limit and label are validated as D4; any other field is refused by name. |
| JL-FR-03 | The token is shown once and stored only as its hash; a malformed token never reaches the store. |
| JL-FR-04 | `preview` returns the circle's name, the offered role and the creator's display name, and nothing else; a bad link and a miss are the same answer. |
| JL-FR-05 | With approval off, `join` adds the member at the link's role atomically with the use count and the caps (D9), is idempotent for a current member, and returns the circle as the person now sees it. |
| JL-FR-11 | With approval on (the default), `join` creates one pending request and counts the use atomically; a second request by the same person for the circle is answered as waiting and counts nothing; at most 20 pending per circle; a request lapses after 7 days. |
| JL-FR-12 | Owners and managers list a circle's pending requests (display name, role asked, when) and approve or decline each; approving adds the member atomically with the caps; a member, an observer and a stranger cannot, and a stranger gets the one no-such-circle answer. |
| JL-FR-13 | A person lists their own pending requests (`GET /api/join-requests`: circle name, role, when) and the user app's join screen says the request is waiting. |
| JL-FR-06 | A link never offers `owner` or `manager`, whoever creates it. |
| JL-FR-07 | Revoking, expiry and the use limit take effect on the next request. |
| JL-FR-08 | Deleting the circle removes its links; links are never listed to non-managers. |
| JL-FR-09 | The back office's circle screen has a Join links section (create, show once, list, revoke); the user app has the join screen (`#/join/<token>`: sign in or register, preview, join). |
| JL-FR-10 | The router accepts a join route only with the token's exact shape; anything else is home. |
| JL-NFR-01 | Eight simultaneous joins on a link with one use left make exactly one member (approval off) or exactly one request (approval on), and eight simultaneous approvals of one request add exactly one member (store and HTTP level). |
| JL-NFR-02 | A secrets scan over responses and logs finds no token, password or hash; the request log never holds the fragment (it is never sent) or a body. |
| JL-NFR-03 | The store's lookup is by hash; the plain token is never in the database file (searched, as for sessions). |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| A link is passed beyond the group | D4 one-time use and expiry, D13 approval by default, the low role, D4/D15 revocation; the roster shows who joined; an owner can remove anyone. | `src/service/join-links-end-to-end.test.ts` — "a link made with the defaults allows one use and needs approval"; `src/service/join-links-end-to-end.test.ts` — "a request lapses after a week"; `src/service/join-links-end-to-end.test.ts` — "a revoked link no longer works"; `src/circles/controller-join.test.ts` — "a one-use link serves one person" |
| A link confers power | D4: never `owner` or `manager`; enforced in the store, not only the controller. | `src/circles/controller-join.test.ts` — "refuses a role other than member or observer"; `src/circles/sqlite/join-links.test.ts` — "the database itself refuses a link that offers more than member or observer"; `src/service/join-links-end-to-end.test.ts` — "nobody can make a link for owner or manager" |
| Guessing a link | 256 bits, hashed at rest, D11 throttle, D8 one answer for every miss. | `src/circles/controller-join.test.ts` — "every kind of miss is the same answer"; `src/circles/controller-join.test.ts` — "holds a client back after too many misses"; `src/api/join-routes.test.ts` — "every kind of miss is the same 404, byte for byte"; `src/circles/sqlite/join-links.test.ts` — "only the hash is in the database and its log" |
| The token ends up in logs or referrers | D6: fragment, body not query; the request log keeps no body or query. | `src/api/join-routes.test.ts` — "a token in the query string of a join is refused by name"; `src/api/join-routes.test.ts` — "never repeats a token outside the one response that made it"; `web/join-client.test.mjs` — "each call goes to its route by path only, the token only ever in a body"; `web/user-join.test.mjs` — "takes the token out of the address, previews it by body" |
| Concurrent joins, requests or approvals exceed the limit or the cap | D9 atomic store steps; JL-NFR-01. | `src/service/join-links-end-to-end.test.ts` — "eight people joining at once by a one-use link make exactly one member"; `src/service/join-links-end-to-end.test.ts` — "eight approvals of one request at once add exactly one member"; `src/circles/sqlite/join-links.test.ts` — "four processes joining by a one-use link make exactly one member"; `src/circles/controller-join-requests.test.ts` — "eight approvals of one request at once add exactly one member" |
| Request flooding on a circle | D13: the use is counted at request time, one pending per person, 20 per circle, lapse after 7 days, throttle by client. | `src/circles/controller-join.test.ts` — "a request waits as long as the setting says, and a circle holds only so many"; `src/circles/controller-join.test.ts` — "asking again says waiting, with the same end time, and counts nothing"; `src/service/join-links-end-to-end.test.ts` — "a person asking by a bad link too often is held back" |
| An approver approves the wrong person | The request shows the person's display name and the role; the roster and an owner's power to remove anyone remain. | `src/circles/controller-join-requests.test.ts` — "owners and managers see who asked by display name only"; `web/join-links-journey.test.mjs` — "ann makes a link on her page" |
| A deleted or demoted creator's links keep working | D15: links belong to the circle; revocable by any owner or manager. | `src/circles/controller-join.test.ts` — "a link made by someone who has since gone is still listed"; `src/circles/controller-join.test.ts` — "the role is read afresh: a demoted manager cannot make a link"; `src/service/join-links-end-to-end.test.ts` — "a person deleting their account takes their waiting requests with them" |
| A link used to probe which circles exist | D8: one answer; the preview shows the circle only to a holder of a live link. | `src/circles/controller-join.test.ts` — "every kind of miss is the same answer"; `web/user-join-journey.test.mjs` — "a link that has been withdrawn is the miss for a newcomer"; `src/api/join-routes.test.ts` — "every kind of miss is the same 404, byte for byte" |
| Registration closed but links let strangers in | D10: a link never creates an account. | `src/service/join-links-end-to-end.test.ts` — "a link does not create accounts" |
| An expired link read from a backup | Hashed; expiry is checked at use. | `src/circles/sqlite/join-links.test.ts` — "only the hash is in the database and its log"; `src/service/join-links-end-to-end.test.ts` — "a restart keeps links, uses and waiting requests; the files hold the hash and never the token"; `src/service/join-links-end-to-end.test.ts` — "a request lapses after a week" |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| JL-AC-01 | Given `CACI_JOIN_LINKS` unset, then every route is a 404. |
| JL-AC-02 | Given an owner creating a link for `observer`, then the token is shown once, the list never shows it, and only its hash is in the file. |
| JL-AC-03 | Given a signed-in person previewing a live link, then they see the circle's name, the role and the creator's display name; given a made-up, expired, revoked or used-up link, then the answers are identical. |
| JL-AC-04 | Given a link with approval off, when someone joins, then they are a member at the link's role, the use is counted and the roster shows them. |
| JL-AC-13 | Given a link made with the defaults, then it allows one use and needs approval. |
| JL-AC-14 | Given approval on, when a person joins, then they are **not** a member, a pending request exists, the use is counted, and the person's own list and the join screen say it is waiting; a second try says waiting and counts nothing. |
| JL-AC-15 | Given a pending request, when an owner or manager approves, then the person becomes a member at the link's role; when one declines, or a week passes, then nothing is added and the request is gone. |
| JL-AC-16 | Given a full circle, when a request is approved, then the approval is refused as a limit and the request stays pending. |
| JL-AC-17 | Given a member or observer, then they cannot list, approve or decline requests; a stranger gets the one no-such-circle answer. |
| JL-AC-18 | Given eight approvals of one request at once, then exactly one member is added. |
| JL-AC-05 | Given a link with one use left and eight people joining at once, then exactly one becomes a member (approval off) or has a request (approval on). |
| JL-AC-06 | Given a manager asking for a link for `manager` or `owner`, then it is refused, and the same for an owner. |
| JL-AC-07 | Given a person already in the circle opening the link, then they are told so, their role is unchanged and no use is consumed. |
| JL-AC-08 | Given a full circle or a person at their circle cap, then the join is refused as a limit and the use is not consumed. |
| JL-AC-09 | Given the link is revoked, then the next preview and join give the made-up answer. |
| JL-AC-10 | Given a member or an observer, then they cannot create, list or revoke links, and a stranger gets the one no-such-circle answer. |
| JL-AC-11 | Given registration is closed, then someone with no account cannot create one through a link. |
| JL-AC-12 | Given the circle is deleted, then its links are gone and the answer is the made-up one. |

### Where each criterion is checked (T-322)

| ID | Tests |
|----|-------|
| JL-AC-01 | `src/service/join-links-end-to-end.test.ts` — "with join links off (the default) every join route is a plain 404"; `src/service/join-links-end-to-end.test.ts` — "with it on the routes answer" |
| JL-AC-02 | `src/api/join-routes.test.ts` — "201 with the token once and the link"; `src/circles/sqlite/join-links.test.ts` — "only the hash is in the database and its log"; `src/service/join-links-end-to-end.test.ts` — "a restart keeps links, uses and waiting requests; the files hold the hash" |
| JL-AC-03 | `src/api/join-routes.test.ts` — "preview: 200 with the circle"; `src/circles/controller-join.test.ts` — "every kind of miss is the same answer"; `src/api/join-routes.test.ts` — "every kind of miss is the same 404, byte for byte" |
| JL-AC-04 | `src/service/join-links-end-to-end.test.ts` — "a link with approval off joins at once at the role it offers"; `src/circles/controller-join.test.ts` — "adds the person at the link" |
| JL-AC-05 | `src/service/join-links-end-to-end.test.ts` — "eight people joining at once by a one-use link make exactly one member"; `src/circles/sqlite/join-links.test.ts` — "four processes asking by a one-use approval link make exactly one request" |
| JL-AC-06 | `src/service/join-links-end-to-end.test.ts` — "nobody can make a link for owner or manager"; `src/circles/controller-join.test.ts` — "refuses a role other than member or observer" |
| JL-AC-07 | `src/circles/controller-join.test.ts` — "someone already in is told so, keeps their role, and costs no use"; `web/user-join-journey.test.mjs` — "a link that needs no approval joins at once and offers the circle" |
| JL-AC-08 | `src/circles/controller-join.test.ts` — "a full circle or a person in the most circles allowed gets a limit and the use is not spent"; `src/service/join-links-end-to-end.test.ts` — "a full circle refuses to approve" |
| JL-AC-09 | `src/service/join-links-end-to-end.test.ts` — "a revoked link no longer works"; `web/join-links-journey.test.mjs` — "withdrawing a link on the page, after the question, makes it a miss for everyone" |
| JL-AC-10 | `src/circles/controller-join.test.ts` — "a manager may make one; a member and an observer may not"; `src/service/join-links-end-to-end.test.ts` — "owners and managers manage links and requests; members and observers are forbidden"; `src/api/join-routes.test.ts` — "members and observers are 403; a stranger and a made-up circle get the one no-such-circle" |
| JL-AC-11 | `src/service/join-links-end-to-end.test.ts` — "a link does not create accounts" |
| JL-AC-12 | `src/service/join-links-end-to-end.test.ts` — "deleting the circle removes its links and requests"; `src/circles/sqlite/join-links.test.ts` — "deleting the circle row removes its links and requests" |
| JL-AC-13 | `src/circles/controller-join.test.ts` — "has the defaults: observer, 7 days, one use, approval on"; `src/service/join-links-end-to-end.test.ts` — "a link made with the defaults allows one use and needs approval" |
| JL-AC-14 | `src/circles/controller-join.test.ts` — "makes a waiting request, not a member, and counts the use"; `src/service/join-links-end-to-end.test.ts` — "with uses to spare, clicking the link again while waiting says waiting and counts nothing"; `web/user-join-journey.test.mjs` — "a new person opens a link, is asked to sign up, asks to join, waits" |
| JL-AC-15 | `src/circles/controller-join-requests.test.ts` — "an owner or a manager makes the person a member at the link"; `src/circles/controller-join-requests.test.ts` — "removes the request, adds nobody, and does not give the use back"; `src/service/join-links-end-to-end.test.ts` — "a request lapses after a week and cannot be approved" |
| JL-AC-16 | `src/circles/controller-join-requests.test.ts` — "a full circle or a person in the most circles allowed is a limit, the request stays waiting"; `src/api/join-routes.test.ts` — "a full circle is 429 and the request stays waiting" |
| JL-AC-17 | `src/circles/controller-join-requests.test.ts` — "members and observers cannot see them"; `src/circles/controller-join-requests.test.ts` — "members and observers cannot approve or decline"; `src/api/join-routes.test.ts` — "members, observers are 403 and a stranger gets the one no-such-circle" |
| JL-AC-18 | `src/circles/controller-join-requests.test.ts` — "eight approvals of one request at once add exactly one member"; `src/service/join-links-end-to-end.test.ts` — "eight approvals of one request at once add exactly one member"; `src/circles/sqlite/join-links.test.ts` — "four processes approving one request add exactly one member" |

### Residual risks (not covered, with the reason)

1. **A link is a bearer secret in a chat**: anyone who sees it can join until it expires, runs out or is revoked. The low role and limits bound it.
2. **Approval waits for a person who may not look**: nobody is notified of a request (R-020's attention engine is not pursued), so a request waits until an owner or manager opens the circle screen; it lapses after 7 days. With approval off a leaked link adds someone the organiser did not choose.
3. **The preview shows the circle's name** to anyone with the link, by design.
4. **Joiners see every member's username and display name** (R-004), and a circle's brain is shared sensitive data until the release gates are met.
5. **Nobody is told a person joined or asked to**; the organiser sees it when they next look.
6. **The token is held in page memory** while the person signs in; a reload loses it.
7. **The token is in the address a person opens** (in the fragment, which is never sent to the service): it can sit in a browser history, a chat preview or a screen shared in the moment; the page replaces it with `#/join` as soon as it is taken in.
8. **The miss throttle is in memory, per client address**: a restart forgets it, a household behind one address shares an allowance, and a hostile address can use it up for an hour so the others on it see `THROTTLED` for links.
9. **Nothing here has been run by real people or on the Pi**: the pages were looked at in one browser with the demo setup (T-322 hand check) and the flow is covered by tests, not by use.

## Open questions

1. (Answered 2026-11-06: approval is on by default; one-time use by default.)
2. Should the default role be `observer` (read only) or `member`?
3. Should links be allowed for any circle by default, or have a per-circle switch that owners turn on?
4. Do you want a QR code or a share-sheet button in the user app, or is copy and paste enough?
