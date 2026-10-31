# Horizon Scan — Requirements

> Status: Draft v0.1 · 25 Oct 2026
> Scope: Redesign of the horizon scan query over the shared brain (personal space + circles)
> Related: Pulse (1-week focused view), bipartite brain graph (entities ↔ facts)

---

## 1. Summary (BLUF)

The horizon scan currently returns too much: every fact touched by an entity, including reference detail such as rent payment details. It must become an **exception report**, not a digest.

The scan answers four questions, in this order:

1. **What needs me?** (overdue soon, unowned, unconfirmed)
2. **What clashes?** (conflicts across circles: you, family, work)
3. **What's changed?** (since the last scan)
4. **What's coming?** (Now / Next / Later, detail thinning with distance)

Everything else is collapsed into a count ("17 routine items on track"). Detail is available by drilling into a node, never pushed in the scan.

---

## 2. Problem statement

| Today | Problem |
|---|---|
| Scan returns full activity detail for each item | Noisy; hard to see what matters |
| Reference facts (payment details, account numbers) appear in results | Noise **and** a privacy risk inside shared circles |
| Routine on-track items get equal weight with at-risk items | Important items are buried |
| Same item can appear once per circle | Duplication |
| No notion of "what changed since I last looked" | User must re-read everything |

Pulse (1 week) works well because its short window limits volume. The horizon scan's longer window needs explicit filtering, ranking and summarisation to stay useful.

---

## 3. Research basis

These are the patterns the design borrows from, with the specific idea taken from each.

| Source | Idea adopted | Where it applies |
|---|---|---|
| **BLUF (Bottom Line Up Front)**, US Army AR 25-50 | Lead with the conclusion; signal clearly if action is needed | Headline sentence (§5.1) |
| **Management by exception** (accounting / budgetary control) | Only surface items that deviate from expected; on-track items need no attention | "Needs you" section, collapsed routine count (§5.2, §5.7) |
| **PRINCE2 "manage by exception"** | Raise the exception on a *forecast* breach, not after the fact; tolerances per level | Risk forecast in scoring (§7) |
| **Now / Next / Later roadmap** (ProdPad, Janna Bastow) | Match certainty to time: more detail near, less far | Timeline bands (§5.5) |
| **Linear Pulse & Project Updates** | Feed + scheduled AI summaries; update = past 7 days + forecast + health indicator | Update shape, Pulse vs scan split (§9) |
| **Calm Technology** (Weiser & Seely Brown; Amber Case) | Minimum attention; information sits in the periphery and moves to the centre only when needed | Collapsing, caps, drill-in (§5.7, §6) |
| **Government horizon scanning** (GO-Science Futures Toolkit; Defra case study) | Look for *weak signals*; Defra selected only the 6 most novel signals per fortnight | Signals section with hard cap (§5.6) |
| **Progressive disclosure** (Nielsen; Carroll & Rosson) | Summary first, detail on explicit request | Drill-in API (§8.2) |
| **Jointly** (Carers UK), **Maple**, **Ohai** | Circle-of-care model; at-a-glance activity overview | Validates circle concept; gap is they're feeds, not forward scans, and none span you + family + work |

### Differentiator

Single-domain tools (Linear, Asana for work; Jointly for care; Maple/Ohai for family) cannot see across domains. **Cross-circle collision detection** is the capability only a shared brain spanning all of a person's circles can offer, and should be treated as a headline feature.

### References

- BLUF — https://en.wikipedia.org/wiki/BLUF_(communication)
- Management by exception — https://accountingtools.com/articles/what-is-management-by-exception.html
- PRINCE2 manage by exception — https://open-exam-prep.com/study-guides/prince2-practitioner/principles-5-7-application/manage-by-exception
- Now-Next-Later — https://www.prodpad.com/glossary/now-next-later-roadmap/ · https://www.koji.so/docs/now-next-later-roadmap-guide
- Linear Pulse — https://linear.app/docs/pulse · https://linear.app/blog/how-we-built-project-updates
- Calm Technology principles — https://calmtech.institute/calm-tech-principles · https://www.caseorganic.com/post/principles-of-calm-technology
- Horizon scanning (UK gov) — https://analysisfunction.civilservice.gov.uk/blog/horizon-scanning-and-futures-thinking-tools-for-government-analysts
- Defra case study — https://www.gov.uk/government/publications/weak-signals-and-trend-analysis-horizon-scanning/weak-signals-and-trend-analysis-horizon-scanning
- Jointly — https://www.carersuk.org/jointly/
- Progressive disclosure — https://www.aiuxplayground.com/pattern/progressive-disclosure

---

## 4. Concepts and definitions

| Term | Meaning |
|---|---|
| **Space** | A brain partition. Either personal (one owner) or a **circle** (shared by members). |
| **Entity** | A node on one side of the bipartite graph: a person, place, task, event, account, project, etc. |
| **Fact** | A node on the other side, linked to one or more entities. |
| **Temporal fact** | A fact with time semantics: event, deadline, commitment, recurring obligation, status change. Eligible for scans. |
| **Reference fact** | A stable detail: payment details, address, account/policy number, contact info, instructions. **Never** included in scans; only returned on drill-in. |
| **Scan item** | A derived, one-line summary of an entity plus its top temporal fact(s). |
| **Exception** | A scan item that breaches, or is forecast to breach, a tolerance (due soon and unowned, unconfirmed, overdue, conflicting). |
| **Signal** | A pattern across several facts (e.g. missed logs, repeated rescheduling), not a single event. |
| **Delta** | Change in a scan item since the viewer's previous scan: new, moved, resolved, escalated. |

---

## 5. Functional requirements

### 5.1 Headline

- **FR-1** The scan MUST begin with one sentence of counts, e.g. *"3 things need you, 1 clash, 2 changes since Monday. 17 items on track."*
- **FR-2** If there are no exceptions, the headline MUST say so plainly (*"Nothing needs you. 21 items on track."*).

### 5.2 Needs you (exceptions)

- **FR-3** List scan items whose status is an exception for the viewer, sorted by score (§7).
- **FR-4** Exception triggers (configurable tolerances):
  - due within `T_due` (default 14 days) **and** no owner
  - due within `T_confirm` (default 10 days) **and** not confirmed
  - overdue
  - forecast breach (e.g. dependency late, so this item will be late)
- **FR-5** Cap at `MAX_NEEDS_YOU` (default 5). Overflow rolls into "+N more" with drill-in.

### 5.3 Collisions

- **FR-6** Detect time conflicts between events the viewer is involved in, **across all spaces the viewer belongs to**.
- **FR-7** A collision MUST be shown once, tagged with each space involved.
- **FR-8** A collision MUST NOT reveal details of a space to members who don't belong to it (see §6.3). Other members of the work circle see only "You have a conflict", not "Mum's consultant".

### 5.4 Deltas

- **FR-9** Record a `last_scanned_at` per viewer per scan scope.
- **FR-10** Mark items as `new`, `moved`, `resolved`, or `escalated` relative to that timestamp.
- **FR-11** Resolved items appear only in the delta list, not in the timeline.

### 5.5 Timeline (Now / Next / Later)

- **FR-12** Group non-exception items into bands (defaults, configurable per space):
  - **Now**: 0–14 days
  - **Next**: 15–42 days
  - **Later**: 43–90 days
- **FR-13** Detail decreases with distance:
  - Now: title + date + owner
  - Next: title + approximate date
  - Later: title only
- **FR-14** Cap each band (defaults 5 / 5 / 3); overflow is counted.

### 5.6 Signals

- **FR-15** Show at most `MAX_SIGNALS` (default 3) pattern-level observations.
- **FR-16** Initial signal detectors:
  - adherence gap (expected recurring log missing ≥ k of last n periods)
  - drift (item rescheduled ≥ 2 times)
  - load imbalance (one member owns > X% of a circle's open items)
  - silence (no update in a circle for > N days while items are due)

### 5.7 Routine / on track

- **FR-17** All remaining items collapse into a single count line with a "Show" expander.
- **FR-18** The expanded list is fetched lazily (separate request), not included in the initial payload.

### 5.8 Exclusions (MUST NOT appear in the scan)

- **FR-19** Reference facts (payment details, account/sort codes, policy numbers, addresses, credentials).
- **FR-20** Completed items outside the delta window.
- **FR-21** Full update text (show derived item; link to source update).
- **FR-22** Duplicate items across circles (dedupe by entity id).
- **FR-23** Anything the viewer is not permitted to traverse (§6.3).

### 5.9 Drill-in

- **FR-24** Each scan item carries `entity_id` and can be expanded by a one-hop query returning that entity's facts, **including** reference facts the viewer may see.
- **FR-25** Drill-in is a separate request; the scan payload never contains reference facts.

---

## 6. Non-functional requirements

### 6.1 Payload and performance

- **NFR-1** Initial scan payload SHOULD be < 8 KB for a typical user (≈4 spaces, ≈200 open entities).
- **NFR-2** Scan computation SHOULD complete in < 300 ms p95 server-side.
- **NFR-3** Scans only traverse entity → temporal-fact edges, and pull at most `TOP_FACTS_PER_ENTITY` (default 2).

### 6.2 Calm defaults

- **NFR-4** All caps are hard limits in the default view. The user can expand, but defaults never exceed: 1 headline + 5 needs-you + collisions + 13 timeline + 3 signals + 1 routine line.

### 6.3 Privacy and visibility

- **NFR-5** Every fact has a `visibility` (`private` | `circle` | `members:[ids]`). Traversal filters by viewer **before** scoring, not after rendering.
- **NFR-6** Reference facts default to `private` to their author, even inside a circle, unless explicitly shared.
- **NFR-7** Cross-circle collisions expose to each viewer only what they can already see.

---

## 7. Data model changes

Assumes an existing bipartite store of `Entity` and `Fact` nodes with `Edge(entity_id, fact_id)`. Adjust names to the project schema.

```text
Fact
  id
  space_id
  kind            : TEMPORAL | REFERENCE          # NEW — required
  type            : event | deadline | commitment | recurring | status | note | detail ...
  visibility      : private | circle | members     # NEW
  visible_to      : [user_id]                       # when visibility = members
  author_id
  starts_at?      : datetime
  ends_at?        : datetime
  due_at?         : datetime
  owner_id?       : user_id
  confirmed       : bool                             # NEW (default false for obligations)
  consequence     : LOW | MEDIUM | HIGH              # NEW (default MEDIUM; inferable)
  status          : open | done | cancelled
  created_at, updated_at

Entity
  id, space_id, label, type
  # unchanged

ScanState                                            # NEW
  viewer_id
  scope_key                                          # e.g. "all" or a space id
  last_scanned_at
  last_snapshot   : { entity_id -> { band, due_at, status, score } }
```

### Classifying `kind`

On write (or via backfill), classify each fact:

- `TEMPORAL` if it has any of `starts_at`, `due_at`, a recurrence rule, or an obligation verb (pay, attend, submit, renew, book…).
- `REFERENCE` if it matches detail patterns: IBAN / sort code / account number, policy or reference numbers, addresses, phone/email, passwords, "how to" instructions.
- If ambiguous, default to `REFERENCE` (fail closed: keeps it out of scans).

A rent entity therefore typically has a `TEMPORAL` fact ("Rent £X due 1st monthly, owner Ella") and a `REFERENCE` fact ("Landlord account details…"). Only the first reaches the scan, and even then the amount is omitted at Later/Next detail levels.

---

## 8. API

### 8.1 Scan

```http
GET /brain/scan?scope=all&horizon_days=90
```

```json
{
  "generated_at": "2026-10-25T10:00:00Z",
  "since": "2026-10-19T08:12:00Z",
  "headline": "3 things need you, 1 clash, 2 changes since Monday. 17 items on track.",
  "needs_you": [
    { "entity_id": "e_123", "title": "Mum's care review form", "due": "2026-10-30",
      "reason": "UNOWNED", "spaces": ["mum"], "score": 0.91 }
  ],
  "collisions": [
    { "entity_ids": ["e_201", "e_877"], "title": "Consultant vs quarterly review",
      "at": "2026-11-03T10:00:00Z", "spaces": ["mum", "work"] }
  ],
  "changes": [
    { "entity_id": "e_310", "title": "Ella's deposit return", "change": "MOVED",
      "from": "2026-11-15", "to": "2026-12-10" }
  ],
  "timeline": {
    "now":   { "items": [ { "entity_id": "e_4", "title": "Boiler service", "due": "2026-10-29", "owner": "you" } ], "more": 0 },
    "next":  { "items": [ { "entity_id": "e_9", "title": "Mum's flu jab", "approx": "mid Nov" } ], "more": 2 },
    "later": { "items": [ { "entity_id": "e_11", "title": "Car MOT" } ], "more": 0 }
  },
  "signals": [
    { "kind": "ADHERENCE_GAP", "title": "Mum's medication log missed 2 of last 7 days",
      "entity_ids": ["e_55"], "spaces": ["mum"] }
  ],
  "routine_count": 17
}
```

### 8.2 Drill-in

```http
GET /brain/entity/{entity_id}?include=facts
GET /brain/scan/routine?scope=all            # lazy list for the "Show" expander
```

Drill-in returns the entity and all facts the viewer may see, including `REFERENCE` facts.

---

## 9. Pulse vs horizon scan

| | Pulse | Horizon scan |
|---|---|---|
| Window | 7 days | 90 days (configurable) |
| Question | "What's happening this week?" | "What's coming, and what needs me?" |
| Detail | Higher (short window keeps it manageable) | Exceptions first, thinning with distance |
| Shape (after Linear) | Past 7 days + this week's plan + health | Headline, needs-you, clashes, changes, Now/Next/Later, signals |

Both share the same scoring and visibility pipeline; Pulse is effectively a scan with `horizon_days=7`, higher detail level, and no Later band.

---

## 10. Pseudocode

### 10.1 Top-level scan

```python
def horizon_scan(viewer, scope="all", horizon_days=90, now=utcnow()):
    spaces    = spaces_for(viewer, scope)                       # personal + circles
    state     = load_scan_state(viewer, scope)                  # last_scanned_at, snapshot
    horizon   = now + days(horizon_days)

    # 1. Gather: one hop, temporal only, visibility-filtered BEFORE scoring
    items = []
    for entity in open_entities(spaces):
        facts = [f for f in temporal_facts(entity)
                 if can_see(viewer, f)
                 and f.status == "open"
                 and effective_date(f) is not None
                 and effective_date(f) <= horizon]
        if not facts:
            continue
        top = sorted(facts, key=effective_date)[:TOP_FACTS_PER_ENTITY]
        items.append(make_item(entity, top, viewer, now))

    items = dedupe_by_entity(items)                             # FR-22, merge space tags

    # 2. Classify and score
    for it in items:
        it.exception = exception_reason(it, now)                # FR-4, may be None
        it.score     = salience(it, viewer, now, state)

    # 3. Sections
    needs_you   = top_n([i for i in items if i.exception], MAX_NEEDS_YOU)
    collisions  = detect_collisions(viewer, spaces, now, horizon)
    changes     = diff(items, state.last_snapshot, now)         # new/moved/resolved/escalated
    signals     = top_n(detect_signals(viewer, spaces, now), MAX_SIGNALS)

    shown       = ids(needs_you) | ids_in(collisions)
    remaining   = [i for i in items if i.entity_id not in shown]
    timeline    = band(remaining, now)                          # applies caps + detail levels
    routine     = len(remaining) - timeline.shown_count()

    result = Scan(
        headline   = headline(needs_you, collisions, changes, routine, state.last_scanned_at),
        needs_you  = needs_you,
        collisions = collisions,
        changes    = changes,
        timeline   = timeline,
        signals    = signals,
        routine_count = routine,
    )

    save_scan_state(viewer, scope, now, snapshot_of(items))
    return redact_for_level(result)                             # final guard: no REFERENCE fields
```

### 10.2 Exception rules

```python
def exception_reason(it, now):
    d = days_until(it.due, now)
    if d < 0:                                   return "OVERDUE"
    if it.forecast_late:                        return "FORECAST_LATE"      # PRINCE2-style
    if d <= T_DUE and it.owner is None:         return "UNOWNED"
    if d <= T_CONFIRM and not it.confirmed and it.requires_confirmation:
                                                return "UNCONFIRMED"
    return None
```

### 10.3 Salience score

Weighted sum in `[0, 1]`. Weights are tunable; start simple and log for later tuning.

```python
W = dict(urgency=0.35, consequence=0.25, ownership=0.15, novelty=0.15, involvement=0.10)

def salience(it, viewer, now, state):
    d = max(days_until(it.due, now), 0)

    urgency     = exp(-d / 10)                                   # ~1 today, ~0.25 at 14d
    consequence = {"LOW": 0.2, "MEDIUM": 0.5, "HIGH": 1.0}[it.consequence]
    ownership   = 1.0 if it.owner is None else (0.6 if it.owner == viewer.id else 0.2)
    novelty     = 1.0 if is_new_or_changed(it, state) else 0.0
    involvement = 1.0 if viewer.id in it.participants else 0.3

    score = sum(W[k] * v for k, v in locals_subset(
        urgency=urgency, consequence=consequence, ownership=ownership,
        novelty=novelty, involvement=involvement).items())

    if it.exception == "OVERDUE":
        score = max(score, 0.95)
    return round(score, 3)
```

### 10.4 Banding with decreasing detail

```python
BANDS = [("now", 0, 14, 5, "FULL"), ("next", 15, 42, 5, "APPROX"), ("later", 43, 90, 3, "TITLE")]

def band(items, now):
    out = {}
    for name, lo, hi, cap, level in BANDS:
        bucket = sorted([i for i in items if lo <= days_until(i.due, now) <= hi],
                        key=lambda i: -i.score)
        out[name] = Band(items=[render(i, level) for i in bucket[:cap]],
                         more=max(len(bucket) - cap, 0))
    return Timeline(**out)

def render(it, level):
    base = {"entity_id": it.entity_id, "title": it.title}
    if level == "FULL":   return base | {"due": it.due.date(), "owner": display_owner(it)}
    if level == "APPROX": return base | {"approx": approx_date(it.due)}   # "mid Nov"
    return base
```

### 10.5 Cross-circle collision detection

```python
def detect_collisions(viewer, spaces, now, horizon):
    events = [f for s in spaces for f in timed_events(s, now, horizon)
              if viewer.id in f.participants and can_see(viewer, f)]
    events.sort(key=lambda f: f.starts_at)

    out, active = [], []                                   # sweep line
    for e in events:
        active = [a for a in active if a.ends_at > e.starts_at]
        for a in active:
            if a.space_id != e.space_id or COLLIDE_WITHIN_SPACE:
                out.append(Collision(
                    entity_ids=[a.entity_id, e.entity_id],
                    title=f"{label_for(viewer, a)} vs {label_for(viewer, e)}",
                    at=e.starts_at,
                    spaces=sorted({a.space_id, e.space_id})))
        active.append(e)
    return out

def label_for(viewer, fact):
    # NFR-7: never leak another space's details to members of a different space.
    # The viewer always sees their own spaces in full; when a collision is
    # surfaced to a circle (e.g. "Alex has a conflict"), use a neutral label.
    return fact.short_title if can_see(viewer, fact) else "another commitment"
```

### 10.6 Deltas

```python
def diff(items, snapshot, now):
    changes, current = [], {i.entity_id: i for i in items}
    for eid, it in current.items():
        prev = snapshot.get(eid)
        if prev is None:                         changes.append(Change(eid, "NEW"))
        elif prev.due_at != it.due:              changes.append(Change(eid, "MOVED", prev.due_at, it.due))
        elif not prev.exception and it.exception: changes.append(Change(eid, "ESCALATED"))
    for eid, prev in snapshot.items():
        if eid not in current and was_completed(eid):
            changes.append(Change(eid, "RESOLVED"))
    return top_n(changes, MAX_CHANGES)
```

### 10.7 Signals (examples)

```python
def detect_signals(viewer, spaces, now):
    out = []
    for r in recurring_logs(spaces, viewer):                    # e.g. medication log
        missed = r.expected_count(last=7, now=now) - r.logged_count(last=7, now=now)
        if missed >= 2:
            out.append(Signal("ADHERENCE_GAP", f"{r.title} missed {missed} of last 7 days", [r.entity_id]))
    for it in open_items(spaces, viewer):
        if it.reschedule_count >= 2:
            out.append(Signal("DRIFT", f"{it.title} rescheduled {it.reschedule_count} times", [it.entity_id]))
    for c in circles(spaces):
        share = max_owner_share(c)
        if share.ratio > 0.7 and c.open_count >= 5:
            out.append(Signal("LOAD_IMBALANCE", f"{share.owner_name} owns {pct(share.ratio)} of {c.name}", []))
    return sorted(out, key=signal_priority)
```

### 10.8 Final redaction guard

Defence in depth: even if a bug lets a reference fact through traversal, strip sensitive fields before serialising.

```python
SENSITIVE = [IBAN_RE, SORT_CODE_RE, ACCOUNT_NO_RE, CARD_RE, POSTCODE_ADDR_RE, PASSWORD_HINT_RE]

def redact_for_level(scan):
    for item in scan.all_items():
        item.title = mask(item.title, SENSITIVE)
        item.drop_fields(["amount", "account", "reference", "address"])  # never in scan payload
    return scan
```

---

## 11. Configuration defaults

| Key | Default | Notes |
|---|---|---|
| `horizon_days` | 90 | Pulse uses 7 |
| `T_DUE` | 14 days | unowned threshold |
| `T_CONFIRM` | 10 days | unconfirmed threshold |
| `MAX_NEEDS_YOU` | 5 | |
| `MAX_CHANGES` | 5 | |
| `MAX_SIGNALS` | 3 | after Defra's small-batch approach |
| Band caps | 5 / 5 / 3 | Now / Next / Later |
| `TOP_FACTS_PER_ENTITY` | 2 | |
| `COLLIDE_WITHIN_SPACE` | true | set false to only show cross-circle clashes |

Per-space overrides allowed (e.g. a care circle may want `T_DUE = 21`).

---

## 12. Acceptance criteria

1. **No reference leakage.** Given an entity "Rent" with a temporal fact (due 1st) and a reference fact (landlord bank details), the scan includes "Rent due 1 Nov" and the payload contains no account number, sort code or amount. Drill-in on the entity returns the bank details to permitted viewers.
2. **Exceptions first.** An unowned item due in 5 days appears in `needs_you`, not in `timeline.now`.
3. **Caps hold.** With 40 open items, the default payload shows ≤ 5 needs-you, ≤ 13 timeline items, ≤ 3 signals, and a `routine_count` for the rest.
4. **Cross-circle clash.** Events in the "Mum" and "Work" spaces overlapping on the same day for the viewer produce exactly one collision tagged with both spaces.
5. **Privacy in collisions.** A work-circle colleague viewing the work circle never sees the title of the Mum-space event.
6. **Deltas.** An item whose due date changed since the last scan appears once in `changes` as `MOVED` with old and new dates.
7. **Detail thinning.** A Later-band item renders with title only.
8. **Dedupe.** An entity linked into two circles appears once, with both space tags.
9. **Payload size.** Typical-user fixture scan payload < 8 KB.
10. **Empty state.** With no exceptions, the headline reads "Nothing needs you" plus the on-track count.

---

## 13. Open questions

- Should `consequence` be user-set, inferred by type (payments and medical = HIGH), or both?
- Who sees signals in a circle: all members, or only the circle's coordinator(s)?
- Should the scan offer audio playback (as Linear Pulse does) for carers on the move?
- Work circles: integrate with existing work tools (calendar, Linear/Jira) as read-only sources of temporal facts, rather than duplicating them?
- Do we need per-member tolerances (e.g. a student member wants fewer nudges)?

---

## 14. Out of scope (this iteration)

- Scenario modelling / long-range (> 6 months) planning
- Automatic re-assignment of unowned items
- Natural-language generation beyond the headline sentence (titles come from entity labels)
