# User Accounts and Login API — Specification

Oct 6, 2026 · @Andy

## Overview

An optional layer on top of the graph store that gives each person an account, lets them log in over HTTP, and ties every graph operation to **their own graph**. It adds two components, both optional for anyone embedding the library: `src/users/` (the user controller: accounts, passwords, sessions, throttling, authorisation, over SQLite, no HTTP) and `src/api/` (a thin HTTP server on `node:http` that exposes it). The graph store itself stays free of authentication; this layer is what a host application would otherwise have to write.

It changes the earlier statement in `spec.md` §4 that the host application "owns auth": the host may now **use** this user controller or bring its own. R-001's non-goal ("`graphId` is a namespace, not a security boundary") is unchanged: the security boundary is here, in how a session maps to exactly one graph id.

## Decisions (owner, 2026-10-05 and 2026-10-06)

| # | Decision | Why |
|---|----------|-----|
| D1 | Password login with **server-side sessions**: an opaque random token in an HttpOnly cookie; the server stores only its SHA-256 | Revocable, survives restarts, nothing replayable from a copy of the database; no signing secret to manage |
| D2 | **Open self-registration** | Owner's choice. Consequence: throttling, enumeration-safe errors and an off switch are part of the requirements, not extras |
| D3 | **One graph per user**; its id is derived from the user id and is never read from a request | Matches `spec.md` §4 ("one isolated graph per user"); removes a whole class of authorisation mistakes |
| D4 | The **first account ever created is the admin**; later accounts are ordinary users; promotion is admin-only | Needs no setup. Risk: whoever registers first on a fresh server is admin, so register yourself straight away on a fresh install (documented) |
| D5 | Roles are only `user` and `admin` | Smallest model that gives someone the power to manage accounts |
| D6 | A user's details are **username, display name, optional email**, plus id, role and timestamps. Email is never verified and never sent to | The Pi has no outbound mail; keeps the personal-data footprint small |
| D7 | **An admin resets forgotten passwords**; there is no emailed reset. If the only admin is locked out, a documented server-side command recovers the admin account | No outbound mail; a household service has someone to ask |
| D8 | No new dependency: `node:crypto` (scrypt, randomness, hashes) and `node:http` | NFR-03 of R-001 spirit; fewer things to audit |
| D9 | The API binds **127.0.0.1 by default**; HTTPS is **not** terminated by this server (use a reverse proxy) | Safe default; TLS is better done by a tool made for it |

## Goals and non-goals

**Goals**

1. Anyone can register, log in, log out, see and change their own details and password, and delete their account (which deletes their graph).
2. An admin can list, read, edit, reset the password of and delete any account, and change roles; the last admin cannot be removed or demoted.
3. After login, the caller can only reach their own graph; nothing a client sends can choose another.
4. Credentials are stored and checked so that a stolen database file or log file does not give anyone access.
5. Every failure mode of the above leaves state unchanged (no half-created accounts, no orphaned graphs, no surviving sessions of a deleted user).

**Non-goals (v1)**: email verification or sending any email; emailed password reset; multi-factor authentication; sign-in with an external identity provider; API keys for non-browser clients; per-user quotas; an audit log; CAPTCHA, invite codes or an approval queue for registration; HTTPS termination; sharing a graph between users (that is the support-circle work, not specified yet); encryption of the database file (same position as R-001: rely on disk encryption).

## Definitions

- **User**: `{ id, username, displayName, email?, role, createdAt, updatedAt }`. Never contains a password, a hash or a token.
- **User id**: `u` followed by 16 lower-case characters from `[a-z0-9]`, random, never reused.
- **Username**: 3 to 32 characters of `[a-z0-9._-]`, stored lower-cased (input is lower-cased first), unique. `Ann` and `ann` are one account.
- **User graph id**: derived deterministically from the user id (`user-` + the user id), so it satisfies R-001's graph id rules (1 to 128 characters of `[a-z0-9_-]`).
- **Session**: a login. Identified by a token of 256 random bits, base64url. Lives until logout, until the idle timeout (default 30 minutes since last use) or the absolute lifetime (default 7 days since login), whichever is first, or until it is revoked.

## Functional requirements

| ID | Requirement |
|----|-------------|
| UA-FR-01 | **Register**: username, display name, password, optional email. Creates the user **and** their graph; either both exist afterwards or neither. Refused when registration is switched off (`CACI_ALLOW_REGISTRATION=false`). |
| UA-FR-02 | **First admin**: the first account ever created has role `admin`. Two simultaneous first registrations yield exactly one admin. |
| UA-FR-03 | **Login**: username and password give a session (cookie). A wrong password and an unknown username produce the same error, with the same shape and the same amount of work. |
| UA-FR-04 | **Logout** revokes the session it is called with, and only that one. |
| UA-FR-05 | **Me**: returns the caller's `User` and their graph id. |
| UA-FR-06 | **Update details**: the caller may change display name and email; not username, id or role. |
| UA-FR-07 | **Change password**: needs the current password; applies the password policy; ends **all other** sessions of that user. |
| UA-FR-08 | **Delete account**: needs the password; ends all the user's sessions, drops their graph and removes the user. If the graph cannot be dropped, the user is **not** removed and the error says so. |
| UA-FR-09 | **Admin: list** users (paged, stable order), **read** one, **edit** display name, email and role, **reset password** (new password applies the policy; ends that user's sessions; the old password is never shown), **delete** (also drops their graph). |
| UA-FR-10 | **Last admin**: the last remaining admin cannot be deleted or demoted (`LAST_ADMIN`), including when two such requests arrive at once. |
| UA-FR-11 | **Authorisation**: a `user` may act only on their own record; an `admin` on any. Decided by one pure function over (actor, action, target) that is tested for every role and action. |
| UA-FR-12 | **Graph scoping**: the rest of the system learns which graph to use only from the session (`graphIdOf(session)`). No API takes a graph id from the client for account purposes. |
| UA-FR-13 | **Recovery**: a documented command on the server (`npm run users -- recover-admin <username>`) sets a new admin password from standard input when no admin can log in. It needs file access to the data directory, which is the trust boundary. |
| UA-FR-14 | **Validation**: username, display name (1 to 80 characters, no control characters), email (optional, at most 254, simple shape) and password (12 to 128 characters, not equal to the username, not one of a built-in list of very common passwords) are checked before anything is stored; every rejection names the field and the reason and never repeats a password. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| UA-NFR-01 | **Password storage**: scrypt (`node:crypto`), a random 16-byte salt per password, parameters recorded in the stored string, default cost at least N=2^15, r=8, p=1; passwords are Unicode-normalised (NFKC) first; comparison is constant-time; hashes are upgraded silently at login when parameters are out of date. |
| UA-NFR-02 | **Session tokens**: 256 random bits from the platform's secure generator; only the SHA-256 is stored; lookups compare hashes; a malformed token is rejected before the store is touched. |
| UA-NFR-03 | **Throttling**: after 5 failed logins for a username within 15 minutes, further attempts get `THROTTLED` with a retry time, growing from 1 second up to 15 minutes; success resets it; counters are bounded in memory; an unknown username is throttled exactly like a known one; registration is throttled per client (default 10 an hour). |
| UA-NFR-04 | **Cookie**: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when configured; the token is never in a response body, a URL or a log. |
| UA-NFR-05 | **HTTP hygiene**: JSON only, bodies capped at 16 KB, `Origin` checked on every non-GET request, no CORS, replies `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'`; errors never include stack traces or internal messages; wrong method is 405 with `Allow`. |
| UA-NFR-06 | **Secrets never leak**: no response, log line or error ever contains a password, a hash or a session token (checked by scanning everything a full test run produces). |
| UA-NFR-07 | **Storage**: the user database is its own file, created owner-only (mode 0600), with its own application id and versioned schema, refusing foreign or newer files untouched, as the graph database does; usernames are unique by a database constraint. |
| UA-NFR-08 | **Safe defaults**: bind 127.0.0.1; refuse to bind a non-loopback address with insecure cookies unless told explicitly; refuse invalid configuration with a message naming the variable. |

## Threats and controls, and what covers each (security review, T-083)

Each control below is pinned by a test that fails if the control is removed (each was also broken on purpose during its task and the test failed). The reference format is the test file and a fragment of the test's name, and `src/service/review.test.ts` checks that every one of them still exists, so this table cannot quietly rot.

| Threat | Control | Covered by |
|--------|---------|------------|
| Credential stuffing, password guessing | Throttling per username and per client (UA-NFR-03); password policy (UA-FR-14); scrypt cost (UA-NFR-01) | `src/users/throttle.test.ts` — "holds back the attempt after the fifth failure"; `src/users/controller.test.ts` — "holds back after five failures"; `src/api/routes.test.ts` — "is 429 with Retry-After after five wrong passwords"; `src/users/validate.test.ts` — "refuse every very common password"; `src/users/password.test.ts` — "the default cost is at least the documented one" |
| Account enumeration (login, registration, timing) | Same error and same work for unknown user and wrong password (UA-FR-03); unknown usernames throttled alike; a user asking about another account gets the same 403 whether or not it exists; registration conflicts are the one place a name's existence shows, and registration is throttled | `src/users/controller.test.ts` — "a wrong password and an unknown username are the same error"; `src/users/throttle.test.ts` — "holds back a username that does not exist exactly like one that does"; `src/api/routes.test.ts` — "refuses unknown fields and wrong types"; `src/users/controller-admin.test.ts` — "refuses a user asking about anyone else, the same way whether or not that account exists"; `src/api/routes.test.ts` — "is 429 with Retry-After once a client has registered too often" |
| Stolen database file | Only scrypt hashes and token hashes are stored (UA-NFR-01, -02); files are owner-only (UA-NFR-07); no encryption at rest (non-goal, documented) | `src/service/end-to-end.test.ts` — "leaves no secret in the files"; `src/users/sqlite/sqlite-session-store.test.ts` — "never write the token itself, anywhere in the file"; `src/users/sqlite/sqlite-store.test.ts` — "is created readable and writable by its owner only"; `src/service/service.test.ts` — "a clean close leaves only the two database files" |
| Session theft or fixation | Fresh random token on every login; HttpOnly, SameSite=Strict, Secure when configured (UA-NFR-04); idle and absolute expiry; revoked on logout, password change, reset and delete | `src/users/testing/session-cases.ts` — "create gives a 43-character base64url token, and 1,000 tokens are all different"; `src/api/routes.test.ts` — "sets the session cookie (HttpOnly, SameSite=Strict, Path=/, Max-Age)"; `src/users/testing/session-cases.ts` — "a session ends at the absolute lifetime"; `src/users/controller-self.test.ts` — "ends every OTHER session"; `src/users/controller-admin.test.ts` — "sets a new password that works, the old one stops, and all of that user"; `src/users/controller-self.test.ts` — "needs the password, then removes the account, its sessions and its graph" |
| CSRF | SameSite=Strict, `Origin` check before the body is read, JSON-only bodies, no CORS (UA-NFR-05) | `src/api/server.test.ts` — "refuses a cross-origin write with 403"; `src/api/server.test.ts` — "a body that is not JSON-typed is 415"; `src/api/routes.test.ts` — "a cross-origin write is refused before it can act"; `src/api/cookies.test.ts` — "is HttpOnly, SameSite=Strict and Path=/ always" |
| XSS reading the cookie | HttpOnly; CSP `default-src 'none'` on every reply; the API never returns HTML | `src/api/server.test.ts` — "puts the security headers on every kind of reply"; `src/api/cookies.test.ts` — "is HttpOnly, SameSite=Strict and Path=/ always" |
| Timing side channels | Constant-time comparison; the same single derivation for an unknown user (verified by call counts, not by a clock) | `src/users/password.test.ts` — "a wrong password and a missing user do exactly the same work"; `src/users/controller.test.ts` — "the same work done" |
| Secrets in logs or errors | UA-NFR-06; the request log holds only method, path (no query), status, time | `src/api/routes.test.ts` — "records method, path and status only"; `src/api/server.test.ts` — "reports method, path, status and time, and never the query"; `src/users/password.test.ts` — "no error message contains the password"; `src/service/recover.test.ts` — "never prints the password, in any outcome"; `src/service/service.test.ts` — "logs requests through the hook it is given, without anything secret" |
| Registration abuse (open sign-up) | Per-client throttle, an off switch (UA-FR-01), bounded counters; no CAPTCHA (non-goal) | `src/users/throttle.test.ts` — "allows 10 attempts an hour per client"; `src/users/controller.test.ts` — "is closed when registration is switched off"; `src/users/throttle.test.ts` — "never remembers more than maxEntries"; `src/service/service.test.ts` — "counts clients by the address a trusted proxy reports" |
| Reaching another user's graph | The graph id comes only from the session (UA-FR-12); no request field names a graph | `src/users/controller.test.ts` — "two users have different graphs, and what one writes the other cannot see"; `src/api/routes.test.ts` — "a query parameter cannot change who you are"; `src/service/end-to-end.test.ts` — "keeps people apart" |
| Privilege escalation | One authorisation table (UA-FR-11); a role change is its own admin-only action; the caller's role is read on every request; last-admin rule (UA-FR-10) | `src/users/authorise.test.ts` — "a user may never change a role"; `src/users/controller-admin.test.ts` — "a demoted admin loses the power to delete at once"; `src/users/controller-admin.test.ts` — "of two admins demoting each other at the same moment"; `src/users/testing/cases.ts` — "of simultaneous guarded demotions of the only two admins"; `src/api/routes.test.ts` — "has exactly the status the table says" |
| Half-done operations (crash, failure) | Register and delete are all-or-nothing with explicit compensation (UA-FR-01, -08); one transaction per multi-statement store operation; the databases survive a kill | `src/users/controller.test.ts` — "takes the account back out if the graph cannot be made"; `src/users/controller.test.ts` — "leaves no graph if the account cannot be made"; `src/users/controller-self.test.ts` — "keeps the account, and says so, if the graph cannot be deleted"; `src/users/sqlite/sqlite-store.test.ts` — "a process killed with SIGKILL inside a write transaction"; `src/graph_store/adapters/sqlite/files.test.ts` — "survives a process killed part-way through a write transaction" |
| Lockout of every admin | Server-side recovery command (UA-FR-13) | `src/service/recover.test.ts` — "sets a new password for the admin, ends their sessions"; `src/service/end-to-end.test.ts` — "gets a locked-out admin back in" |
| Plain-HTTP exposure of the cookie | A non-loopback address with plain cookies is refused unless `CACI_ALLOW_INSECURE=true`; HTTPS is a reverse proxy's job (documented) | `src/service/config.test.ts` — "any other address needs secure cookies, or an explicit acceptance of the risk"; `src/service/docs.test.ts` — "says the things a reader must not miss" |
| Oversized, slow or malformed requests | 16 KB body, 16 KB headers, header and request time limits, strict JSON and UTF-8, no prototype keys, path whitelist | `src/api/server.test.ts` — "a body over 16 KB is 413"; `src/api/server.test.ts` — "a client that sends headers and then nothing is cut off"; `src/api/body.test.ts` — "refuses prototype-poisoning keys at any depth"; `src/api/router.test.ts` — "refuses path tricks outright" |

### Residual risks (not covered, with the reason)

These are real and known; each is also in the PLAN Backlog.

1. **Timing is checked by counting work, not by measuring time.** A clock-based test would be flaky and prove little on a shared machine; the call-count test proves the same derivation runs on both paths. Residual: ordinary network and database timing noise.
2. **CPU exhaustion by many distinct clients.** Every login or registration costs one scrypt derivation (about 100 ms of CPU, run off the main thread). Per-username and per-client throttles bound one attacker, but a crowd of different addresses is not bounded by a global limit on concurrent hashing. Low risk for a household service behind a proxy; a global concurrency cap is the fix.
3. **Account lock-out by someone who knows a username** (documented in the README and STATE): the price of not revealing which accounts exist.
4. **Throttle state is in memory**, so a restart forgets it.
5. **Registration reveals that a username exists** (409), by design, and is throttled.
6. **Expired sessions that are never used again** stay in the table until their owner next logs in or is deleted; the count per user is capped at 20, so growth is bounded, but nothing purges them on a schedule.
7. **A delete that drops the graph and then cannot delete the account** leaves an account with an empty graph (the next login recreates it) and reports the error. Data is not orphaned, but it is gone.
8. **Misconfigured proxy trust.** If `CACI_TRUSTED_PROXIES` is set when no proxy is there, a client can choose its own address and so dodge the per-client limits. Documented; the default is 0.
9. **No audit log, no multi-factor authentication, no email verification** (non-goals).

## Errors

A closed set, as in the other components: `INVALID_INPUT`, `CONFLICT` (username taken), `NOT_FOUND`, `UNAUTHENTICATED`, `FORBIDDEN`, `THROTTLED` (carries `retryAfterMs`), `LAST_ADMIN`, `STORAGE_ERROR`. HTTP mapping: 422, 409, 404, 401, 403, 429 with `Retry-After`, 409, 500.

## HTTP routes (v1)

`POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `PATCH /api/me`, `POST /api/me/password`, `DELETE /api/me`; admin: `GET /api/users`, `GET|PATCH|DELETE /api/users/:id`, `POST /api/users/:id/password`. The session cookie is the only credential: an `Authorization` header is ignored.

## Acceptance criteria

| ID | Check |
|----|-------|
| UA-AC-01 | Register then login then `me` returns the user and a graph id; the graph exists and is empty. |
| UA-AC-02 | A failed graph creation during registration leaves no user; a failed user creation leaves no graph. |
| UA-AC-03 | Wrong password and unknown username give identical responses; the number of hash computations is equal. |
| UA-AC-04 | The database holds no plaintext password or session token (searched byte for byte after a full walk-through). |
| UA-AC-05 | After password change, the other sessions fail and the current one still works. |
| UA-AC-06 | Two users' graphs are isolated: nothing written for one is visible to the other, and no request field changes which graph is used. |
| UA-AC-07 | The last admin cannot be deleted or demoted, alone or under 8 simultaneous attempts. |
| UA-AC-08 | Delete account removes sessions, user and graph; a failing graph drop leaves the user and reports it. |
| UA-AC-09 | Throttling follows UA-NFR-03 with a fake clock, including the memory bound under a flood of random usernames. |
| UA-AC-10 | No secret appears in any response, log line or error across the whole test run (UA-NFR-06). |
| UA-AC-11 | A server restart on the same files keeps accounts, graphs and valid sessions. |
| UA-AC-12 | The recovery command restores access to a locked-out admin account without touching other data. |

### Where each criterion is checked (T-083)

| ID | Checked by |
|----|------------|
| UA-AC-01 | `src/service/end-to-end.test.ts` — "keeps people apart"; `src/users/controller.test.ts` — "creates the account and its graph together" |
| UA-AC-02 | `src/users/controller.test.ts` — "takes the account back out if the graph cannot be made"; `src/users/controller.test.ts` — "leaves no graph if the account cannot be made" |
| UA-AC-03 | `src/users/controller.test.ts` — "a wrong password and an unknown username are the same error" |
| UA-AC-04 | `src/service/end-to-end.test.ts` — "leaves no secret in the files"; `src/users/sqlite/sqlite-session-store.test.ts` — "never write the token itself, anywhere in the file" |
| UA-AC-05 | `src/users/controller-self.test.ts` — "ends every OTHER session"; `src/api/routes.test.ts` — "POST /me/password changes it, ends other sessions, keeps this one" |
| UA-AC-06 | `src/users/controller.test.ts` — "two users have different graphs, and what one writes the other cannot see"; `src/service/end-to-end.test.ts` — "keeps people apart" |
| UA-AC-07 | `src/users/controller-admin.test.ts` — "of eight admins all deleting the next one at the same moment"; `src/users/controller-admin.test.ts` — "of two admins deleting each other at the same moment"; `src/users/testing/cases.ts` — "of simultaneous guarded demotions of the only two admins" |
| UA-AC-08 | `src/users/controller-self.test.ts` — "needs the password, then removes the account, its sessions and its graph"; `src/users/controller-self.test.ts` — "keeps the account, and says so, if the graph cannot be deleted" |
| UA-AC-09 | `src/users/throttle.test.ts` — "never remembers more than maxEntries"; `src/users/throttle.test.ts` — "holds back the attempt after the fifth failure" |
| UA-AC-10 | `src/api/routes.test.ts` — "records method, path and status only"; the whole-run scan at the end of `src/api/routes.test.ts`; `src/service/end-to-end.test.ts` — "leaves no secret in the files" |
| UA-AC-11 | `src/service/service.test.ts` — "keeps accounts, graphs and a signed-in session across a restart"; `src/service/end-to-end.test.ts` — "keeps people apart" |
| UA-AC-12 | `src/service/recover.test.ts` — "sets a new password for the admin, ends their sessions"; `src/service/end-to-end.test.ts` — "gets a locked-out admin back in" |

## Build order

T-070 shared SQLite wrapper; T-071 scaffold and pure rules; T-072 passwords; T-073 and T-074 user store; T-075 sessions; T-076 throttling; T-077 to T-079 controller (register/login, self service, admin); T-080 HTTP kit; T-081 routes; T-082 run it, configuration, recovery command, docs; T-083 end to end and security review. See `.gsd/PLAN.md`.
