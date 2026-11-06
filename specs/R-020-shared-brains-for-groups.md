# Shared Brains for Groups: Rhythms, Attention and Agent Access — Specification

Nov 6, 2026 · @Andy

**Status: WITHDRAWN by the owner on 2026-11-06; kept for the record, not to be built.** The owner decided that CaCi is the brain and not a reminder engine: deciding when something deserves attention is the job of an agent acting for the person. So Parts B to D (rhythms, fact authority, change events and the attention engine) are not pursued here. Part A continues as `R-021` (relevant category context), Part E as `R-022` (agent access, reshaped as read tools over the brain, no notifications) and Part F as `R-023` (join links). The long-term, non-verbose view this direction was reaching for is `R-019` (the horizon scan). The review of 2026-11-06 found that D3's premise was wrong (the context is ordered by id, not link count) and that FR-13 co-occurrence is not built; both are corrected in `R-021`. Original text follows.

**Original status: draft direction, not planned.** Written from the owner's design conversation of 2026-11-03 to 2026-11-06 ("Brain" project), which looked 2 to 5 years ahead and then mapped that view onto what CaCi already does. Every decision below is **proposed** and stands only once the owner confirms it. Nothing here is broken into tasks yet; each part needs its own planning pass (`/plan`) and may become its own R-number. Domain examples (a club, a class) are illustrative only: CaCi stays a domain-agnostic platform (`spec.md` §1). UI and the care setting are deliberately out of scope here.

## Overview

The direction is a **shared brain any group can keep**: an organiser keeps the group's current facts (when, where, how much, what changed), members join from a link, and each member's **personal brain** combines every brain they belong to and decides **when** something deserves their attention. The person's one regular action is the **pulse**; the brain also **pulses them** when something changes and the timing suits them. Over the next few years most people will reach this through their own AI agent rather than an app, so the brain must be the **trusted, current source of truth that any agent can read**.

CaCi already holds most of the foundation:

| Already built | Where |
|---|---|
| Bipartite graph store, isolated graphs, typed reads incl. related items and category co-occurrence | R-001 |
| Categorisation by LLM against the current graph: existing categories shown, reuse or create, weighted links | R-001, R-012 |
| Fact-level, current-view brain: keys, `replaces` by number, deletes built by trusted code, tidy | R-014, R-015 |
| Circles with roles (`owner`, `manager`, `member`, `observer`), circle-owned graphs, My Brain aggregate with provenance | R-004, R-009 |
| Change ledger with who, when and the exact words; trace a fact to its source | R-014, R-017 |
| Pulse, Coming up and Long range checks; silence when nothing needs attention | R-018 Part A |
| Horizon scan as an exception report (draft); temporal and reference facts | R-019 |
| Brain evaluation harness, controls outside the code | R-012, R-013 |

This specification names what is **missing** for the group vision, in six parts:

- **Part A — Relevant category context.** Choose the categories shown to the categoriser by relevance to the note, not by link count, and keep the category set tidy as it grows.
- **Part B — Rhythms and exceptions.** Recurring facts as structure, so a one-off change is recognised in code as a break from the usual pattern.
- **Part C — Fact authority.** Who may make a fact official, members proposing and stewards confirming, and when a proposal may be approved automatically.
- **Part D — Change events and the attention engine.** Turn every change into an event, score its impact, and decide per member: interrupt now, today, the next roundup, or keep.
- **Part E — Agent access.** Token-authenticated access and an MCP server, so a person's own agent can pulse, read changes and propose updates.
- **Part F — Joining by link.** An open, revocable link an organiser can drop into an existing group chat.

## Decisions (all proposed, to confirm)

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Complement chat, never replace it.** CaCi does not carry conversation, photos or social exchange. It holds the current facts a group's chat loses. | Chat apps already do conversation well; adding AI summaries to them is a sticking plaster for the missing state. |
| D2 | **Categories stay emergent**, chosen by the LLM against the current graph (as today). Stable **fields** sit beside them for code and agents to rely on: the fact `key` (R-015) and the dated-fact fields of R-018 Part B / R-019 §7 (`starts_at`, `due_at`, recurrence, `kind`, `consequence`). | Categories fit each group; fields give agents a contract that does not drift. |
| D3 | **Part A:** the categoriser is shown categories **seeded by relevance**: categories whose name or whose facts' keys share words with the note, then their co-occurring categories (FR-13), then the most-linked to fill the budget. Today's ordering (most-linked first within the character budget) is the fallback and the A/B baseline. | In a busy brain the relevant category can fall outside a 4,000-character budget ordered by link count. |
| D4 | **Part A:** near-duplicate categories ("weds-class", "wednesday-session") are found by a periodic **tidy proposal**: the model may propose a merge (relink the facts of one category to another), shown to an owner or manager for approval; the model still never deletes. | Emergent categories sprawl; merging must stay a human decision. |
| D5 | **Part B:** a **rhythm** is a temporal fact with a recurrence (for example "every Saturday 07:00"). A fact that changes one occurrence is an **exception** linked to the rhythm by key and date, and does **not** replace it. A fact that changes the rhythm itself replaces it (R-014). The categoriser decides which by number, as for `replaces`; when unsure it asks (D7). | "Next session 7pm Wednesday" is either a one-off or the new normal, and getting it wrong misleads every member. |
| D6 | **Part B:** the window, recurrence expansion and "is this a break from the rhythm" are **computed in code**, never by the model (as R-018 D6 does for windows). | Deterministic, testable, cheap; the model cannot be argued out of it by a note. |
| D7 | **Part C:** a proposal from a capturing role is either **published** or held for a **check-back** to an owner or manager. It is held when: the one-off/permanent question is open (D5); it contradicts a confirmed fact; it lacks a detail its kind needs (a time, an amount, a deadline); it is high-consequence (money, safety, cancellation); it comes from a `member` rather than an `owner` or `manager`; or the categoriser's confidence is low. Otherwise it is published. | Every question adds admin for the organiser, and reducing that admin is why they use it. |
| D8 | **Part C:** a check-back is **one question with tap answers** ("Just this week / From now on / Edit"); questions are batched per approver; an unanswered one is shown to members as **unconfirmed**, never as fact, after a configurable time. | Never let a guess look like a confirmed fact. |
| D9 | **Part C:** in a circle a `member`'s note that would **replace** a fact entered by an `owner` or `manager` becomes a **suggestion** for confirmation, not a replacement. This narrows R-014 D11 for circles that choose it (a per-circle setting, default off for compatibility). | A member should be able to say "I heard it's cancelled" without overwriting the organiser's fact. |
| D10 | **Part D:** every successful write produces **change events** from the ledger (added, replaced, removed, confirmed), each with scope, author, the fact's key and kind, and an **impact** score from the fact's `consequence`, how soon it falls, and how many members follow the categories it is linked to. | The ledger already records every change; impact can come from the graph's structure instead of hand-written rules. |
| D11 | **Part D:** each person has **attention settings**: working hours, a roundup time, quiet hours, and per-brain notification level. Each event is routed per member to **interrupt** (now), **today** (at the next free moment), **roundup** (the daily digest) or **keep** (shown on pulse only). A per-person, per-brain **last-seen marker** drives "what changed since you last looked". | The point is not storing; it is deciding when something deserves attention, so the person can trust the silence. |
| D12 | **Part D:** delivery is **in-app first** (the pulse opens with what changed, a daily digest), then web push, then email; an agent subscription (Part E) is one more channel. No channel is built before its privacy review. | No notification channel exists today. |
| D13 | **Part D:** the pulse and checks move from "send the whole readable brain to the model" to **code-filtered context**: in-window temporal facts, open exceptions and changes since last seen, with reference facts excluded (R-019 §5.8). | Cost, privacy and relevance all improve, and it scales with group size. |
| D14 | **Part E:** agents authenticate with **scoped personal access tokens** (per person, per scope, read or read-and-propose, revocable, expiring), separate from the cookie session. OAuth for third-party agents is a later step. | An agent must never hold the person's password or session. |
| D15 | **Part E:** an **MCP server** exposes, in this order: `pulse(scope?, check?)`, `changes_since(scope?, since)`, `get_fact(key or id)` with provenance, `browse(category)`, and later `propose(note, scope)` which creates a **proposal** and never writes directly. Every answer names its source brain and when the fact was last confirmed. | The brain's name and provenance must survive inside an agent's answer, or the product disappears behind the agent. |
| D16 | **Part E:** the MCP server is a thin layer over existing controllers; it adds no new read rules. Every call goes through the same scope resolver (R-009) and the same not-found answer for anything not readable. | One authorisation path, not two. |
| D17 | **Part F:** an owner or manager can create a **join link** for a circle with a role (default `observer`), an expiry and a use limit; it can be revoked at any time; joining still creates the person's own account and personal brain. | Organisers spread the product by sharing a link where the group already talks. |
| D18 | **Commercial shape (for context, not built here):** members are free and **no advertising** is shown; organisers pay for group brains and tools; payment fees later. | Ads pull attention, which contradicts the product's promise to protect it, and sit badly beside personal data. |
| D19 | **Release gates unchanged:** pseudonymisation and the legal groundwork (R-008 D4, R-009) remain required before anyone outside the owner's family test uses a group brain. Part E and Part D channels each need their own privacy review. | They are the real critical path to a first external group. |

## Goals and non-goals

**Goals**

1. The categoriser sees the categories that matter for the note, however large the brain grows.
2. A recurring fact and a one-off change to it are told apart and stored correctly.
3. An organiser's confirmed fact cannot be silently overwritten by a member; proposals are confirmed with one tap.
4. Every change can reach the members it affects at a time that suits each of them, and nothing reaches them otherwise.
5. A person's own agent can pulse, read changes and propose updates, with provenance, under the same access rules.
6. A group can be joined from a link shared in an existing chat.

**Non-goals**

- Any UI design (the owner's separate design work covers it).
- The care setting specifically.
- Replacing or integrating with chat apps' message streams (ingesting a forwarded message is a later item).
- Payments, bookings and agent-to-agent transactions.
- History questions (the ledger stays a review log, R-014).
- Model-as-judge evaluation.

## Definitions

- **Rhythm**: a temporal fact with a recurrence rule; the group's usual pattern.
- **Exception**: a fact that changes one occurrence of a rhythm and links to it.
- **Proposal**: a categorised note not yet published (today's preview-then-approve, generalised).
- **Check-back**: a single question to an owner or manager before a proposal is published.
- **Unconfirmed fact**: a published proposal whose check-back went unanswered; always shown as such.
- **Change event**: one ledger change, enriched with kind, key, scope and impact.
- **Impact**: a score of how much a wrong or missed fact would hurt members (consequence × nearness × reach).
- **Attention settings**: a person's working hours, roundup time, quiet hours and per-brain level.
- **Route**: interrupt, today, roundup or keep, decided per member per event.
- **Last-seen marker**: when a person last looked at a brain, per person per brain.
- **Agent token**: a scoped, revocable, expiring credential for a person's agent.

## Requirements

| ID | Requirement |
|----|-------------|
| GR-FR-01 | (A) The category context is seeded by relevance as D3 and stays within the existing budget; a control setting selects today's ordering for the A/B. |
| GR-FR-02 | (A) A tidy proposal can propose a category merge; only an owner or manager can approve it; the model never deletes. |
| GR-FR-03 | (B) A temporal fact can carry a recurrence; the categoriser can mark a new fact as an exception to a rhythm (by number, like `replaces`); an exception does not delete the rhythm. |
| GR-FR-04 | (B) Window, recurrence expansion and "break from rhythm" are computed in code and stated to the model. |
| GR-FR-05 | (C) A proposal is published or held for check-back by the rules of D7; the rule set is in `controls/`, not code. |
| GR-FR-06 | (C) A check-back is one question with tap answers, batched per approver; an unanswered one publishes as unconfirmed after the configured time. |
| GR-FR-07 | (C) With the circle setting on, a `member`'s replacement of an `owner`'s or `manager`'s fact becomes a suggestion (D9). |
| GR-FR-08 | (D) Every successful write emits change events from the ledger with an impact score (D10). |
| GR-FR-09 | (D) Each event is routed per member by their attention settings; the route and its reason are recorded for review. |
| GR-FR-10 | (D) Last-seen markers exist per person per brain; a pulse can be "since you last looked". |
| GR-FR-11 | (D) Checks use code-filtered context (D13); reference facts never reach a check. |
| GR-FR-12 | (D) In-app delivery first: the pulse leads with changes since last seen; a daily roundup at the person's chosen time. |
| GR-FR-13 | (E) Personal agent tokens: create, list, revoke, expire; scoped to brains and to read or read-and-propose. |
| GR-FR-14 | (E) An MCP server with the tools of D15, each result carrying source brain and last-confirmed time. |
| GR-FR-15 | (F) Join links with role, expiry, use limit and revocation. |
| GR-NFR-01 | No change to the graph store's bipartite rule; new structure lives in item `data` and in stores beside the graph (as the ledger does). |
| GR-NFR-02 | Every new model behaviour is measured with the brain-eval before and after (new scenarios: one-off versus permanent change, member suggestion, rhythm with exceptions, large-brain category recall). |
| GR-NFR-03 | The model still never writes a delete; every write still passes the guard. |
| GR-NFR-04 | Any new dependency (for example an MCP SDK) is asked for first, with the reason. |

## Threats and controls

| Threat | Control |
|--------|---------|
| A member overwrites the organiser's fact | D9 suggestion rule; D7 holds member replacements of high-consequence facts. |
| A guess is shown as fact | D8: unanswered check-backs publish as unconfirmed, labelled. |
| A merge wrongly joins two categories | D4: merges are proposals approved by an owner or manager and logged in the ledger. |
| Alert fatigue makes people mute the brain | D11 routes; interrupt only for high impact in the near window; measured by how often people open versus mute. |
| A missed change breaks trust in the silence | Every event is routed somewhere (keep at minimum) and shown on the next pulse; last-seen markers. |
| A leaked agent token reads a brain | D14: scoped, expiring, revocable, never the session; same resolver and not-found answer (D16). |
| An agent writes into a brain | D15: agents only propose; publishing follows Part C. |
| A join link spreads beyond the group | D17: expiry, use limit, revocation, default `observer` role. |
| Reference details (account numbers) pushed to phones or agents | D13 and R-019 §5.8: reference facts never reach checks, events or MCP summaries; only on explicit drill-in. |
| Personal data sent to a model or channel without the gates | D19. |

## Acceptance criteria (indicative, refined at planning)

| ID | Given / When / Then |
|----|---------------------|
| GR-AC-01 | Given a brain with 600 categories and a note about one with few links, when proposed, then that category is in the context shown to the model. |
| GR-AC-02 | Given the rhythm "sessions every Wednesday 6pm" and the note "next session 7pm Wednesday" from an owner, when proposed, then a check-back asks "Just this week / From now on". |
| GR-AC-03 | Given "Just this week" is chosen, then an exception is stored linked to the rhythm, and the rhythm remains. |
| GR-AC-04 | Given the circle setting on, when a member's note would replace the owner's fact, then it is held as a suggestion and the owner's fact is unchanged. |
| GR-AC-05 | Given a check-back unanswered past its time, when a member pulses, then the fact appears marked unconfirmed. |
| GR-AC-06 | Given a cancellation for tonight and a member whose working hours run to 17:30, when it is published at 14:00, then it is routed **today** and delivered at 17:30, not at once; given the same for a high-consequence safety fact, then it is routed **interrupt**. |
| GR-AC-07 | Given nothing has changed since a member last looked, when they pulse, then the answer is one line saying nothing needs them. |
| GR-AC-08 | Given an agent token scoped to one circle, read only, when its agent calls `pulse` for another circle or calls `propose`, then it gets the not-found and refused answers respectively. |
| GR-AC-09 | Given an MCP `get_fact`, then the result names the source brain, who confirmed it and when. |
| GR-AC-10 | Given a revoked or expired join link, when used, then it is refused with the same answer as a made-up link. |

## Suggested order

1. **Part B (with R-018 Part B):** dated facts, recurrence, exceptions. Unlocks most of the rest.
2. **Part D, first slice:** change events, last-seen markers, "since you last looked" pulse, daily roundup in-app, code-filtered checks.
3. **Part C:** check-back, unconfirmed state, member suggestions.
4. **Part A:** relevance-seeded category context, measured against today's ordering with a large-brain scenario.
5. **Part E:** agent tokens, then a read-only MCP server, then `propose`.
6. **Part F:** join links, once the release gates allow a group outside the family test.

## Open questions

1. Is impact's "reach" the count of members following a category, or of members who have read facts under it? The first needs a follow model; the second needs read tracking.
2. Does a member's attention setting apply across all brains, or per brain with a default?
3. Should check-back rules be per circle (a club versus a family) or global with circle overrides?
4. Is an exception an item linked to the rhythm's categories plus a `data.exceptionOf` key, or a dedicated category per rhythm? (The bipartite rule forbids item-to-item edges.)
5. Which MCP transport and SDK, and does the Pi deployment expose it over the tailnet only at first?
6. Does a join link need an approval step by the owner for each joiner?
7. How are forwarded chat messages and emails captured (a later capture channel), and do they always go through check-back?

## Residual risks

1. **Relevance seeding can still miss** a category whose words do not appear in the note; the most-linked fill and the merge proposals reduce but do not remove this.
2. **One-off versus permanent** is a judgement; check-backs reduce errors but add organiser load, to be balanced on the evaluation and real use.
3. **Impact scoring is a heuristic**; mis-scored events either interrupt too often or arrive too late. The recorded route and reason make it reviewable.
4. **Agents may paraphrase away provenance** even when the MCP result carries it.
5. **Without notification channels** (Part D after its first slice) the brain still relies on the person opening the app.
