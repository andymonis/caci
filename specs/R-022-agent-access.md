# Agent Access: the Brain as a Source an Agent Can Use — Specification

Nov 6, 2026 · @Andy

**Status: draft, planned as G2.** Part E of the withdrawn `R-020`, reshaped by the owner's decision of 2026-11-06. D1 to D3 are the owner's. On 2026-11-06 the owner also confirmed **D12 (a hand-written MCP layer, no new dependency)**, **read-only access for now (D13)** and **token management in the user app's Settings (D14)**. The rest are proposed by me and stand unless the owner changes them.

## Overview

The owner's direction: **CaCi is the brain, not a reminder engine.** Deciding when something deserves a person's attention, and nudging them, is the job of **an agent that runs on the person's behalf** (their own assistant, which knows their calendar, location and habits). CaCi's job is to be the **trusted, current, concise source of truth** that agent can read, with provenance, under the same access rules as the person.

So this specification adds **a way for an agent to read a person's brains**: personal access tokens, and an MCP server (the protocol agents use to call tools) that exposes a small set of read tools. It adds **no notification, no routing and no attention settings** (`R-020` Part D is withdrawn). The long-term, non-verbose view an agent most needs is `R-019` (the horizon scan); this spec gives that view a door, and until `R-019` is built the tools return what already exists.

What already exists and is reused, not rebuilt:

| Needed | Already built |
|---|---|
| The same rules as the person (membership, roles, one not-found answer) | Scope resolver (R-009), CaCi controller reads (R-003, R-009) |
| Provenance: who entered a fact, when, the words | Change ledger and `source` (R-014, R-017) |
| A concise check of what needs attention | Pulse, Coming up, Long range (R-018 Part A) |
| Facts found by words | The candidate search (R-014) |

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** CaCi is the brain; reminders and attention are an agent's job on the person's behalf. No reminder engine, no notification channels, no attention routing in CaCi. | A modern agent knows the person's context; CaCi should not duplicate it. |
| D2 | **Owner:** `R-020` is withdrawn; its Parts A, E and F continue as `R-021`, `R-022` and `R-023`; Parts B to D are not pursued here. `R-019` (a better, non-verbose long-term view) is linked in `spec.md` as the view this surface should serve. | Keeps the scope on what only the brain can do. |
| D3 | **Owner:** the access is **for the person's own agent**, under the person's own rules; there is no separate "agent user" and no wider rights than the person has. | One authorisation path. |
| D4 | **Agent access is off by default** (`CACI_AGENT_ACCESS=false`). Switched on, a person can create tokens in Settings. | A new door into the brain must be a deliberate act, as for the real model. |
| D5 | A **personal access token** is a credential separate from the session: `cpat_` plus 43 random base64url characters, **shown once** at creation, **only its SHA-256 stored** (as for sessions, R-002). It is **read-only**, belongs to one person, has a name, a list of **scopes** (`personal`, `circle:<id>`; at most 20), an **expiry** (default 90 days, at most 365) and can be **revoked**; at most 10 live tokens per person. | An agent must never hold a password or a session cookie, and a leaked token must be limited and revocable. |
| D6 | A token is accepted **only** as `Authorization: Bearer <token>` on the agent surface (`/mcp`, and nothing else). The agent surface **never** accepts the session cookie. All other routes still ignore an `Authorization` header and a token in a URL or body (R-002). | A token works in one place only; the existing "the cookie is the only credential" rule is unchanged. |
| D7 | **The agent surface is the same CaCi controller, built over a token-based `users.resolve` and a token-scoped scope resolver.** A call resolves the token to its person, then to the scopes the token lists **and the person may still read now** (membership and role are re-read every call). Anything else is the same not-found answer as for a stranger. It adds **no new read rules**. | One authorisation path, tested once. |
| D8 | **Tools return structured, concise data, and make no model call by default.** The agent's own model does the reasoning; CaCi's model is not spent, and no brain text is sent to CaCi's provider because an agent asked. | "CaCi is just the brain": cheap, private by default and easy to reason about. |
| D9 | The read tools, in this order of delivery: `list_brains` (the scopes the token covers, with role and whether capture is allowed), `search_facts(scope?, text, limit?)` (word overlap, newest first), `get_fact(scope?, id)` (the fact with who entered it, when and the words, where the ledger still has them, and whether it was replaced later), `browse(scope?, category?, cursor?)` (categories with counts, or one category's facts), `changes(scope?, since, cursor?)` (the change log since a time, newest first; a **pull** for an agent, nothing is pushed). | Enough for an agent to find, check and follow the brain without a prose summary. |
| D10 | `pulse(scope?, check)` (the R-018 checks) is offered as an **extra** tool, off unless the token has `checks: true`, because it **does** call CaCi's model, counts against `CACI_STATUS_PER_HOUR` and, in `anthropic` mode, sends brain text to Anthropic. Once `R-019` exists, a `scan` tool serves its non-verbose view in the same way. | The cost and privacy difference must be a visible choice. |
| D11 | **Every result carries provenance**: the brain it came from (own or the circle's name), and for a fact who entered it and when, where known. Results are **capped** (`limit` default 20, at most 50; text cut as the browse routes cut it; no graph ids, user ids or ledger plumbing). | Provenance must survive inside an agent's answer, and the view must stay short. |
| D12 | **The MCP server is hand-written and small, with no new dependency**: Streamable HTTP's single `POST /mcp` carrying JSON-RPC 2.0 (`initialize`, `ping`, `notifications/initialized`, `tools/list`, `tools/call`), JSON responses only (no streaming, `GET` is 405). The tools are written once in a transport-neutral module so a different transport or the official SDK can replace the adapter later. | A new dependency needs your say; the subset an agent needs is small. The risk is protocol drift, recorded below. |
| D13 | **Owner (2026-11-06): read-only for now.** There is **no write tool and no write mode**: an agent cannot file, change or delete anything through CaCi. A `file_note` tool is a possible later step (Backlog) and would need its own specification and the owner's confirmation. | Keeps the first agent door safe; the brain stays written only by the person. |
| D14 | **Owner: token management is in the user app's Settings.** Creating, listing and revoking tokens uses the **session cookie** (never a token): `POST|GET /api/me/agent-tokens`, `DELETE /api/me/agent-tokens/:id`. The list shows name, scopes, created, expires and last used, never the token. Creating one says plainly that **anything the agent reads is sent to that agent's provider**. | The person must know where their brain's text goes once an agent has it. |
| D15 | Revoking a token, deleting the account and changing the password end tokens: revoke and account deletion at once; a password change ends **all tokens** of that person (as it ends other sessions). | A reset of access must reach agents too. |
| D16 | The release gates of R-008 and R-009 apply: pseudonymisation and the legal groundwork before anyone outside the owner's family test, and a token's data leaving to a third-party agent is a new data flow needing its own review. Owner only at first. | An agent provider is a new recipient. |
| D17 | **The server kit gets an opt-in `bearer` field** (found while planning, 2026-11-06: route handlers receive no headers today, `src/api/server.ts`). A route declares `bearer: true`; only then does the kit parse `Authorization: Bearer <token>` strictly (the exact scheme, one space, a token of the exact `cpat_` shape and length, no repeats) and hand the token to the handler; for every other route the header is still not looked at. `/mcp` is the only route that opts in. A notification (no reply expected) is answered `202` with no body. | Keeps R-002's rule that the cookie is the only credential everywhere else, and makes `/mcp` the single place a token is read. |

## Goals and non-goals

**Goals**

1. A person's own agent can find, read and check facts in their brains, under the same rules as the person.
2. Every answer names where it came from and, for a fact, who entered it and when.
3. A leaked token is limited (scope, expiry) and revocable.
4. No notification, reminder or attention logic in CaCi.

**Non-goals**

- Pushing anything to the agent (webhooks, subscriptions, notifications).
- OAuth for third-party agents (a later step: tokens first).
- A separate agent user, wider rights than the person has, or agent-to-agent transactions.
- The long-term scan itself (`R-019`).
- Streaming responses or server-initiated messages.

## Definitions

- **Agent**: software acting for a person, such as their own assistant, that calls CaCi's tools.
- **MCP**: Model Context Protocol, a standard way for an agent to list and call tools.
- **Token**: the personal access token of D5.
- **Checks flag**: whether a token may also call the model-using `pulse` tool (D10).
- **Scopes of a token**: the allow-list of brains it may touch; the person's current access is applied on top.

## Requirements

| ID | Requirement |
|----|-------------|
| AG-FR-01 | With `CACI_AGENT_ACCESS` off, the token routes and `/mcp` answer as if they did not exist. |
| AG-FR-02 | Tokens: create (shown once), list, revoke, expire; limits per D5; only the hash is stored; malformed tokens never reach the store. |
| AG-FR-03 | `/mcp` (the only route with `bearer: true`, D17) accepts only a Bearer token; the cookie, a `?token=` and a body token do nothing; other routes ignore a Bearer token. |
| AG-FR-04 | Each tool call resolves token → person → scope, re-reading membership and role; a scope outside the token's list or no longer readable is the one no-such-circle answer. |
| AG-FR-05 | The tools of D9 exist with the output of D11; none calls a model. |
| AG-FR-06 | `pulse`/`scan` exist only for tokens with `checks: true` and respect the status limit. |
| AG-FR-07 | No token can reach any write: no tool writes, the controller view refuses the capture action for every token, and no writing method of the controller is reachable through `/mcp`. |
| AG-FR-08 | `changes` reads the change log only as far as the person could read it in the app, newest first, paged, never beyond the retention. |
| AG-FR-09 | The MCP layer is strict: known methods only, bounded request and response sizes, JSON-RPC errors for bad input, no stack or internal text in any error. |
| AG-FR-10 | Token management in the user app's Settings: create, show once, list, revoke, with the data-leaves warning. |
| AG-FR-11 | Revoke, expiry, account deletion and password change end tokens as D15. |
| AG-NFR-01 | No new dependency (D12); the transport-neutral tools do not import the HTTP layer. |
| AG-NFR-02 | A secrets scan over every response and log line of the end-to-end test finds no token, password, hash, graph id or user id. |
| AG-NFR-03 | A token's use is throttled by the existing client-key and per-account limits; a flood of bad tokens is throttled like bad logins. |

## Threats and controls

| Threat | Control |
|--------|---------|
| A leaked token reads a brain | D5 scope, expiry, revoke; D6 one place only; D14 list shows last use. |
| A token used on the normal routes or a cookie used on `/mcp` | D6, AG-FR-03, tested both ways. |
| An agent reads a circle the person has left, or a role since demoted | D7: membership and role re-read every call. |
| An agent reads another person's brain or an item of it | D7: the resolver, the same not-found answer. |
| An agent writes into a brain | D13: there is no write path at all; AG-FR-07 and AG-AC-08 prove it. |
| Prompt injection: text from another source in the agent's context asks it to file or exfiltrate | There is no write path (D13), so the damage is limited to disclosure of what the token may read; scopes and expiry (D5); the data-leaves warning (D14). |
| Guessing tokens | 256 bits, hashed at rest, throttled misses (AG-NFR-03). |
| Token or brain text in a log or error | D11 and AG-NFR-02: no tokens or ids in responses or logs; the request log keeps only method, path and status. |
| The agent's provider receives brain text | D14 warning, D16 release gate; not preventable by CaCi. |
| A flood of tool calls | Result caps, request limits, the status limit for model tools. |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| AG-AC-01 | Given `CACI_AGENT_ACCESS` unset, then `/mcp` and the token routes are plain 404s. |
| AG-AC-02 | Given a created token, then it is shown once, the list never shows it, and the stored form is only its hash (searched in the file). |
| AG-AC-03 | Given a token scoped to one circle, when its agent calls `search_facts` on that circle, then it gets facts with the circle's name and who entered them; calls on another circle, on a made-up circle and on the personal brain all give the one not-found answer. |
| AG-AC-04 | Given the person is removed from the circle, then the next call is not-found. |
| AG-AC-05 | Given the token is revoked or expired, then every call is refused with the same answer as a made-up token. |
| AG-AC-06 | Given the session cookie sent to `/mcp`, or a token sent to `/api/me`, then both are refused. |
| AG-AC-07 | Given `get_fact` for a replaced fact, then the result says it was replaced later and gives what it said, and says plainly when the words are no longer kept. |
| AG-AC-08 | Given any token, then `tools/list` shows no write tool and a call to a write method is refused; the graph is byte-identical before and after every tool has been called. |
| AG-AC-09 | Given `changes` since a time, then only entries newer than it come back, newest first, paged, with a cursor bound to the scope. |
| AG-AC-10 | Given the person changes their password, then all their tokens stop working. |
| AG-AC-11 | Given a bad JSON-RPC request, an unknown method, an oversized body or a malformed token, then the answer is a JSON-RPC or HTTP error with fixed words and nothing internal. |
| AG-AC-12 | Given a `pulse` call without `checks: true`, then it is not in `tools/list` and is refused. |

## Residual risks

1. **Anything an agent reads leaves CaCi's control.** The person's agent provider sees it; the warning is a notice, not a protection.
2. **A hand-written MCP layer can drift from the protocol** as it evolves; the transport-neutral tools allow swapping in the official SDK later.
3. **Prompt injection reaches the agent, not CaCi**; with no write path the damage is limited to disclosure.
4. **Facts still describe people with no account** and are now machine-readable; the R-008/R-009 release gates stand.
5. **`changes` is limited by the change log's retention** (`CACI_LEDGER_DAYS`); an agent that polls less often than that can miss older changes.
6. **Until R-018 Part B / R-019 exist, facts have no structured dates**; an agent must read the text for them.
7. **Tokens are bearer credentials**: anyone who holds one has its access until it expires or is revoked.

## Open questions

1. (Answered 2026-11-06: the user app's Settings.)
2. (Answered 2026-11-06: read-only, no write mode.)
3. Is a plain JSON mirror of the tools (for agents that do not speak MCP) wanted, or MCP only?
4. Should a token be able to cover "all my brains" (a wildcard), or must scopes be listed one by one?
5. Should the person be able to see **what an agent read** (an access log), beyond "last used"?
