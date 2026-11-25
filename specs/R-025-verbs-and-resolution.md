# Verbs and Fact Resolution: Dealing With a Fact From My View — Specification

Nov 23, 2026 · @Andy

**Status: draft for the owner's review, not yet planned as tasks.** D1 to D8 are the owner's (2026-11-23, from a discussion of Pulse results that are hard to confirm as done). The rest are proposed and stand unless changed.

## Overview

A Pulse or status answer lists facts such as "pay for this week's yoga class". Afterwards the person wants to say it is dealt with and have it leave their view, without guessing at natural English: "I did X" can match the wrong fact or none. Today a fact is either present or replaced, and the only way to touch it is a new note that the candidate search tries to match.

This spec adds two things:

1. **Resolution**: a small per-person record saying *I have dealt with this fact*. Status answers (the Pulse and the other checks) leave out facts the person has resolved, for that person only. **The fact itself is not changed**, so other members of a circle still see it.
2. **Verbs**: a short, operator-defined vocabulary (`/clear`, `/pay`, ...) that names what the person did. A verb is applied to an **exact fact reference**, never to free text, and works the same through the chat, a button, the HTTP API and MCP.

CaCi stays the brain. A verb never makes a payment or calls any outside system: it records that the person did something, in words an agent or tool can read and act on (D4).

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner: a vocabulary of verbs**, with `/pay` and `/clear` first and more later. | A named action is unambiguous where "I did X" is not. |
| D2 | **Owner: any fact can be resolved**, not only facts marked as to-dos. | No marker or extra extraction step at filing. |
| D3 | **Owner: interface-agnostic.** The operation is one controller method taking an exact fact reference and a verb; the chat, buttons, HTTP and MCP are thin adapters. A narrow MCP tool is allowed (see D13). | CaCi must not be tied to one GUI. |
| D4 | **Owner: a verb is a signal.** `/pay` means "I have paid this, outside CaCi, through a payment system". CaCi records it and never pays, calls or holds credentials for anything. | CaCi is the brain; agents and tools act. |
| D5 | **Owner: resolving is personal, deleting is the owner's.** A member who resolves a fact in a circle brain clears it from their own view only; the fact remains valid for everyone else. **Only the owner of that circle can delete the fact** (for example the yoga class owner and the payment request). | The recurring yoga request belongs to the circle, one member paying it must not remove it for others. |
| D6 | **Owner: in your own brain, `/clear` deletes the fact** (the change log keeps what it said). In a circle it hides the fact for you. | In a brain only you read, hiding and deleting are the same; deleting avoids clutter (R-014). |
| D7 | **Owner: resolutions are private.** They are never in the circle's change log or visible to other members. | Others should not see that you have paid. |
| D8 | **Owner: recurring requests are option A.** The circle owner (or an agent) posts each week's request as a new fact; a resolution is tied to that fact, so next week's new fact appears fresh. No repeat rules or occurrence dates are built. | Smallest build; real use will show whether repeat rules are worth it (Backlog). The record has no occurrence field today. |
| D9 | **Verbs live in a text file in the repo**, `controls/verbs.json`, read at start-up and validated strictly (unknown fields refused; a bad file stops the start naming the file, like `controls/` and the check texts). Each verb has a `name` (1 to 20 characters of `a-z0-9-`), an `effect` (`clear` or `remove`) and a one-line `help`. Users do not define verbs. | One place for the operator, same pattern as the other controls. |
| D10 | **Effects.** `clear`: in the person's own brain, delete the fact; in a circle, record a resolution for this person only. `remove`: delete the fact; allowed only for the owner of the brain (a person's own brain, or the circle's owner role) and in no other case. `/clear` and `/pay` use `clear`; `/remove` uses `remove`. | Matches D5 and D6. |
| D11 | **Which reads leave a resolved fact out**: the status context (Pulse, Coming up, Long range, a typed request) and the same checks through an agent. **Browsing the Brain, search and the change log are unchanged** and still show the fact, marked as resolved by you in the chat's source view. | Resolving is about what asks for attention, not about hiding knowledge. |
| D12 | **A verb takes an exact reference** `{ scope, id }`: the scope is `personal` or a circle, the id the fact's graph id. Status answers already carry these (`facts` on each point). In the chat, the answer shows numbered points and `/clear 2` or a button on point 2 is mapped to that point's reference by the page; the server never parses the number. A point citing more than one fact asks the person which. | Precision comes from the reference. |
| D13 | **MCP**: a `resolve_fact` and an `unresolve_fact` tool, each taking `{ scope, id, verb }` or `{ scope, id }`. They are available only for a token that was made with a new **`resolve` flag** and lists the circle (or personal) in its scopes; they write only the personal resolution record or, for `clear` in the person's own brain, delete the fact. They never edit a circle brain. A `resolutions` read tool lists the person's resolutions, so an agent can see `pay` signals. | Lets an agent act on a `pay` signal and close it, without a general write tool. |
| D14 | **Reading a fact is the right to resolve it.** Owners, managers, members and observers may resolve a circle fact for themselves. A stranger, a non-member and a made-up id get the one not-found answer; so does an id the person may not read. | A resolution writes nothing to the brain. |
| D15 | **A person can undo a resolution** (the fact appears in their checks again). A second verb on an already resolved fact replaces the verb. One resolution per person per fact. | Mistakes happen; keeps the table small. |
| D16 | **Storage**: a `ResolutionStore` port with a memory store and a SQLite store in `users.db` (schema version 11), a conformance suite, a database trigger clearing a person's resolutions when their user row goes and a circle's when the circle goes. At most 2,000 resolutions per person. Records for facts that no longer exist are removed by a daily clean that checks the fact exists, and at start-up. | Same pattern as the other stores; bounded. |
| D17 | **Slash input is never a note.** In the chat, text starting with `/` is a verb command: an unknown verb or a bad number is answered in the thread and nothing is filed or asked. | A mistyped verb must not become a note in the brain. |
| D18 | **Out of scope**: repeat rules and occurrence dates, pushing notifications, a payment or any outbound call, per-user verbs, an admin screen, resolving more than one fact at once, verbs on the Brain browse screen, visible-to-owner resolution counts (the owner uses the payment system to see who paid). | Keeps the first version small. |

## Goals and non-goals

**Goals**

1. A person deals with a fact precisely and quickly: a button, `/verb N`, an HTTP call or an agent tool.
2. A fact in a circle brain cleared by one person stays valid for the others and is deletable only by the owner.
3. The Pulse and checks stop showing facts the person has dealt with.
4. Agents can read `pay` signals and close them, without any general write access.

**Non-goals**

- Making payments or calling outside systems (D4).
- Repeat rules, due dates or occurrences (D8).
- Reminders or notifications (CaCi is the brain; the Pulse is a view you open).
- Letting a member delete a circle fact (D5).

## Definitions

- **Fact reference**: `{ scope, id }`, as carried on each status point.
- **Resolution**: the record `{ user, scope, fact id, verb, at }`, one per person per fact.
- **Verb**: an entry of `controls/verbs.json`.
- **Owner of a brain**: the person for their own brain; the owner role for a circle.

## Requirements

| ID | Requirement |
|----|-------------|
| VR-FR-01 | `controls/verbs.json` is read at start-up with the checks of D9; a missing or invalid file stops the start naming it and creating nothing; it ships with `clear`, `pay` and `remove`; the doctor checks it. |
| VR-FR-02 | The controller method `resolveFact(token, { scope?, id, verb })` takes only those fields (any other refused by name), checks the session, the scope under the read rule (D14), that the fact exists in that scope, and that the verb exists; every failure to read is the one no-such-circle or no-such-fact answer. |
| VR-FR-03 | Effect `clear` in the person's own brain deletes the fact (and tidies a category left empty) through the capture controller's write path with the change log's removed entry; in a circle it stores a resolution for the caller only and changes no graph. |
| VR-FR-04 | Effect `remove` deletes the fact (with the change log entry) only for the brain's owner; anyone else, an observer included, gets `FORBIDDEN` after the read check, and a stranger the not-found answer. |
| VR-FR-05 | `unresolveFact(token, { scope?, id })` removes the caller's own resolution and nothing else; with none it is a harmless no-op answered the same way. |
| VR-FR-06 | The status context leaves out, for the asker, entries the asker has resolved in the scopes read (D11); the left-out count reports them in the answer's note as resolved, not as too many; nothing else about the context changes; a recording adapter shows the status path still writes nothing. |
| VR-FR-07 | A resolution is private: no other person can read it through any route, it is not in the change log, the Brain, search, export of another person's data or any answer to another person. |
| VR-FR-08 | A person has at most 2,000 resolutions (`LIMIT_REACHED` beyond); the daily clean and start-up remove records whose fact has gone; a deleted account or circle removes its records by trigger. |
| VR-FR-09 | HTTP: `POST /api/facts/resolve` (`{ scope?, id, verb }`), `POST /api/facts/unresolve` (`{ scope?, id }`) and `GET /api/facts/resolutions` (the caller's own, paged), session cookie only; the scope as in the other routes; the statuses are the existing table. |
| VR-FR-10 | MCP: the three tools of D13, offered only to a token with the `resolve` flag; a token without it is told the tool does not exist; scopes limit them exactly as they limit the read tools. |
| VR-FR-11 | The chat treats input beginning with `/` as a command (D17): `/verb N` resolves the Nth numbered point's fact (one fact; more asks which), `/verb` alone applies to the last answer if it has one point, an unknown verb lists the known ones, and a verb on a read-only or missing target says why; the thread states what was done ('Cleared for you', 'Marked paid', 'Removed') in words from `help`. Each point also has one button per verb the person may use. |
| VR-FR-12 | The numbered points are shown with their numbers in the answer; the page holds the answer's references in memory only and forgets them with the answer. A reference whose fact has since gone is answered 'that fact is no longer there, ask again'. |
| VR-NFR-01 | No text from a fact is stored in a resolution record (only ids, verb and time); the verb text never reaches a model. |
| VR-NFR-02 | The verbs file and the resolution table never change what the model is told except by omitting resolved entries from the context. |
| VR-NFR-03 | A resolution never fails or delays a status answer: if the store cannot be read the context is built without the filter and a fixed-words warning is raised once. |

## Verbs shipped first

| Verb | Effect | Meaning | Help line |
|------|--------|---------|-----------|
| `clear` | clear | I have dealt with this. | Clear this for me. |
| `pay` | clear | I have paid this outside CaCi. | Mark this as paid. |
| `remove` | remove | Delete the fact (owner only). | Remove this fact for everyone. |

## Threats and what answers them

| Threat | Answer |
|--------|--------|
| A member resolves a fact in a circle they cannot read, or in a made-up circle, to probe it | Reading is the right to resolve; every unreadable case is the one not-found answer, identical for real and made-up ids. |
| A member removes a shared fact for others | `clear` hides for the caller only; `remove` is owner only; tested for every role. |
| A resolution hides something important from the person by accident | Reversible (`unresolve`), the Brain still shows the fact, and the source view marks it as resolved. |
| A mistyped `/verb` is filed as a note | Slash input is never a note (D17); unknown verbs are answered in the thread. |
| An agent token resolves facts it should not | The `resolve` flag, scope lists, and no write to a circle brain; tested like the read tools. |
| A typed number points at the wrong fact after the answer changed | The server never parses numbers; the page maps the number to a reference held for that answer only, and a gone fact is reported. |
| The table grows without bound | Cap per person, daily clean, triggers on account and circle deletion. |
| One person's resolution visible to another | Private by construction: no route, log or answer includes another person's resolutions. |

## Acceptance checks

| ID | Check |
|----|-------|
| VR-AC-01 | A member clears a circle fact: their next Pulse omits it, another member's Pulse still shows it, and the graph and the change log are identical before and after. |
| VR-AC-02 | A member and an observer cannot remove a circle fact; the owner can, and the change log records the removal. |
| VR-AC-03 | `/clear` in the person's own brain deletes the fact and its emptied category and the change log shows it. |
| VR-AC-04 | A stranger, a non-member and a made-up circle or id get byte-identical answers on resolve, unresolve and the resolutions list. |
| VR-AC-05 | `unresolve` makes the fact appear in the person's checks again. |
| VR-AC-06 | The status context leaves out resolved entries only for the resolver, and a recording adapter shows no write primitive on the status path. |
| VR-AC-07 | The chat treats `/` input as a command, files nothing for an unknown verb, maps `/pay 2` to the second point's fact, and asks which when a point cites several. |
| VR-AC-08 | An agent with the `resolve` flag can list resolutions and resolve a fact in a listed scope; one without the flag, or outside the scope, cannot. |
| VR-AC-09 | A bad `controls/verbs.json` stops the service naming the file; the shipped file passes the doctor. |
| VR-AC-10 | Deleting an account or a circle removes the related resolutions; a fact replaced or deleted has its resolutions cleaned. |
| VR-AC-11 | A person at 2,000 resolutions gets `LIMIT_REACHED`; a store failure never fails a status answer. |
| VR-AC-12 | An end-to-end journey on the real service: owner posts the weekly yoga fact, a member pays it with `/pay 1`, their Pulse no longer shows it, another member's still does, the owner posts next week's fact and it appears fresh. |

## Residual risks (to be completed with the review)

1. Recurring requests depend on someone posting each week's fact (D8); forgetting means no reminder, by design.
2. A resolution cannot tell the owner who has paid; the payment system is the record.
3. A resolution hides the fact from checks, so a wrongly resolved fact can be missed until undone.
4. The `pay` signal is only as good as the agent or person acting on it; CaCi does not verify any payment.
5. Resolved facts remain in the brain and in browse until the owner removes them.

## Build order (outline; tasks to be written with `/plan` once this is confirmed)

1. Verbs file, loader and doctor check.
2. `ResolutionStore` port, memory store, conformance suite; SQLite store (schema 11, triggers).
3. Controller `resolveFact`, `unresolveFact`, `remove`, and the status context filter.
4. Routes and the facts clean at start-up and daily.
5. Web client and chat logic: numbered points, `/verb N`, buttons.
6. MCP tools and the token's `resolve` flag.
7. Journey, hand check, security review and README.
