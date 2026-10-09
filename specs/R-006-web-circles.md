# Web App: Circles — Specification

Oct 8, 2026 · @Andy

## Overview

The web app (R-005) gains everything a person needs to use circles (R-004): **create** one, **join** (accept or decline an invitation), **leave**, **view** them (the list, one circle, who is in it) and **manage** them (rename and describe, invite, withdraw an invitation, change a role, remove someone, delete). It uses only the fifteen circle and invitation routes that already exist; **there is no change to the service**. It is still plain HTML, CSS and JavaScript with no build step, served from a fixed list of files under the same strict policy (R-005).

**Circles share no data yet** (R-004): a circle is a group, its roles and its invitations, and nothing here lets anyone see anyone's notes or graph. The page says so.

The first slice's rule that screens are only states of one page and have no addresses (R-005 D13) is replaced here: screens get **hash-route addresses**, so the back button, a reload and a copied address work.

## Decisions (owner, 2026-10-08, and proposals marked)

| # | Decision | Why |
|---|----------|-----|
| D1 | The app covers **creating, joining, leaving, viewing and managing circles** | Owner's request: the whole of what the circle routes offer a person |
| D2 | Screens have **hash-route addresses** (`#/circles`, `#/circles/<id>`) | Owner's answer. Several levels of screen need the back button and a reload that stays put; the hash never goes to the server |
| D3 | A person finds out about an invitation from a **count on the home page, fetched when the page loads and when they press Refresh**; no polling | Owner's answer. Nothing is sent to anyone today (R-004); a count is honest and cheap, and adds nothing to the server |
| D4 | **Proposed:** no change to the service, the policy or the routes | Everything needed exists; fewer places for a mistake |
| D5 | **Proposed:** four screens: `#/` home, `#/circles`, `#/circles/<id>`, `#/invitations`; anything else is home | The smallest set that covers D1 |
| D6 | **Proposed:** an id taken from the address is checked against the **exact shape the service makes** (`c` and 16 letters or digits) before it can reach a request path; so is every id taken from an answer | An address is typed or pasted by anyone; nothing odd may become part of a path |
| D7 | **Proposed:** buttons and choices appear **only for what the person's role allows, as a hint**; the service decides and its refusal is shown as text; **a test compares the page's role table with the service's permission function over every combination** | A hint that disagrees with the service is a bug; the test makes it impossible to ship one |
| D8 | **Proposed:** **delete a circle, remove someone and leave ask again in the page** with a confirm and a cancel; never a browser dialog | A browser dialog blocks the page and cannot be tested the same way; these three cannot be undone by the person |
| D9 | **Proposed:** each role is **described in plain words** beside the choice | Role names say nothing about any setting on purpose (R-004); a person needs to know what they are giving |
| D10 | **Proposed:** the circle page says that **circles share no data yet** and that **everyone in a circle sees everyone's username and display name** | Both are true and a person should not have to guess |
| D11 | **Proposed:** after inviting, the page says the invitation was **recorded for that username** and **never says whether such an account exists** | The service does not say (R-004 D9); the page must not undo that |
| D12 | **Proposed:** a circle that is not found, and a circle you are not in, read **the same** ("No such circle, or you are not in it.") | The service gives one answer for both; so does the page |
| D13 | **Proposed:** on every change of screen **the main heading takes the focus and the tab title follows** | Keyboard and screen-reader users need to know the screen changed |
| D14 | **Proposed:** a view is **as old as its last load**, not live: every action reloads what it changed, and a refusal that shows the view was stale (a role changed, a circle gone) reloads it | There is no push from the service; being honest about it is simpler than polling |
| D15 | **Proposed:** rows and panels come from `<template>` elements in the page, filled with `textContent` only; **the script still creates no markup from text** | The text-only rule of R-005 (D7) must keep holding as the screens grow |
| D16 | **Proposed:** circle data lives **in memory only**; nothing is written to browser storage | Same as R-005 (D9) |

D1 to D3 are the owner's answers; D4 to D16 are proposals that stand unless changed.

## Goals and non-goals

**Goals**

1. A person can run a circle from the page without anything else: make it, invite people, see who is in it, change roles, remove people, leave and delete.
2. A person can find and answer invitations to them.
3. Nothing the page shows lets a person do more than their role allows; nothing it hides is something they are allowed.
4. Nothing a stranger writes (a display name, a circle name or description) can run as code in the page, and nothing in the address can make the page ask for anything but our own routes.
5. It remains usable with a keyboard, a screen reader, a phone-width window, and in light and dark.

**Non-goals (this slice)**: any sharing of notes or graphs through a circle; notifications of any kind; background refresh; ordering or searching a roster; changing one's own display name; transferring a circle in one step (make someone else an owner, then leave); circles in the offline or installable app (Backlog item 9); the capture and browse screens (item 7); "request update" (item 8).

## Definitions

- **Route**: what the address hash names: `home` (`#/` or nothing), `circles` (`#/circles`), `circle` (`#/circles/<id>`), `invitations` (`#/invitations`).
- **Role hint**: showing or hiding a control according to the person's role in the circle, as the service's own table says.
- **Two-step action**: an action that first shows "Are you sure?" with a confirm and a cancel, and only the confirm sends the request.

## Screens

| Route | Shows | Offers |
|---|---|---|
| `#/` | the person's display name and username; "Circles" and "Invitations (n)" links; a Refresh for the count; the note that more will arrive | sign out |
| `#/circles` | the person's circles, each with its name, their role and how many people are in it; "show more" when there are more | create a circle (name, optional description) |
| `#/circles/<id>` | the circle's name and description; **your role and what it allows**; the two notices (D10); the roster (display name, username, role, when they joined; "show more") | by role: rename and describe, invite (a username and a role), the open invitations with withdraw, a role choice and save for each person, remove, leave, delete |
| `#/invitations` | each open invitation addressed to the person: the circle's name, the role offered, who invited them and when it ends | accept, decline |

## Roles in plain words

| Role | Shown as |
|---|---|
| `owner` | Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner. |
| `manager` | Invite and remove members and observers, and move people between those two. Never touches an owner or another manager. |
| `member` | See the circle and who is in it, and leave. |
| `observer` | The same as a member for now. |

## Functional requirements

| ID | Requirement |
|----|-------------|
| WC-FR-01 | **Navigation**: the screen follows the address hash, including the back and forward buttons, a reload and a copied address. A hash that is not one of the four routes (or has a bad id) is the home screen. When signed out, the sign-in screen shows first and the requested route applies after signing in. |
| WC-FR-02 | **Home**: the person's name and username, links to Circles and Invitations, the invitation count fetched on load and by Refresh, and sign out. If the count could not be fetched it says so and shows no number. |
| WC-FR-03 | **Circles list**: the person's circles by id with their role in each and the number of people; an empty list says how to start; "show more" fetches the next page. |
| WC-FR-04 | **Create**: a name (1 to 80 characters) and an optional description (up to 500); early checks give feedback only (the service is the authority); on success the page goes to the new circle. The service's refusal (for example the most circles allowed) is shown as its own words beside the form. |
| WC-FR-05 | **Circle screen**: the circle's details, the person's role in it with the plain words for that role, the two notices, and the roster with "show more". A circle that cannot be found shows D12's words and a link back to the list. |
| WC-FR-06 | **Rename and describe** (owner, manager): a form with the current values; saving shows the new values. |
| WC-FR-07 | **Invite** (owner, manager): a username and a role, offering only the roles the person may give (a manager: member and observer); the answer is worded as D11 says, the form is emptied, and the open invitations list is reloaded. |
| WC-FR-08 | **Open invitations** (owner, manager): who each is for, the role, who sent it and when it ends, with a withdraw button; a manager is not offered withdraw for a role they may not give. |
| WC-FR-09 | **Change a role** (owner: any other person, any role; manager: members and observers, between those two): a choice and a save beside the person; no control beside the person's own row. |
| WC-FR-10 | **Remove** (owner: anyone else; manager: members and observers): a two-step action; none beside the person's own row. |
| WC-FR-11 | **Leave** (everyone): a two-step action; the only owner is told what to do (make someone else an owner, or delete the circle) in the service's own words; on success the page goes to the list. |
| WC-FR-12 | **Delete** (owner): a two-step action that says it removes the circle, its members and its invitations; on success the page goes to the list. |
| WC-FR-13 | **Invitations screen**: each open invitation addressed to the person; **accept** (then the page goes to that circle) and **decline** (the row goes); the home count is refreshed after either. |
| WC-FR-14 | **Refusals are shown in words**: 401 returns to the sign-in screen; 403, 404, 409, 422 and 429 show the words in the table below; any refusal that shows the view was stale reloads it. |
| WC-FR-15 | **One request at a time** in each area: controls are disabled while a request is out, and a second click does nothing. |
| WC-FR-16 | **Every change reloads what it changed** (the roster after a role change, the list after leaving, and so on), so the screen shows what the service now holds. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| WC-NFR-01 | **Addresses are checked**: a route parsed from the hash and every id used in a request path must match the exact shape (`c`, `i` or `u` and 16 lower-case letters or digits); nothing else reaches a path; the page never assigns a whole address or follows one from text. |
| WC-NFR-02 | **Text only**: no `innerHTML` or its relatives; rows and panels are cloned from templates and filled with `textContent`; the guard tests of R-005 still pass and cover the new files. |
| WC-NFR-03 | **No dialogs**: no `alert`, `confirm` or `prompt`. |
| WC-NFR-04 | **No browser storage**, and no cookie access from script, as before. |
| WC-NFR-05 | **Focus and title**: the main heading takes the focus and the tab title follows on every change of screen; after an action the focus goes somewhere that makes sense (the message, the new row, or the control that remains). |
| WC-NFR-06 | **Accessible**: every control has a name that says what it acts on (for example "Remove Bob"); lists are lists, headings are in order, messages are announced politely, and everything works from the keyboard. |
| WC-NFR-07 | **Responsive and themed** as R-005. |
| WC-NFR-08 | **The policy is unchanged** and the new files are on the fixed list; nothing is loaded from anywhere else. |
| WC-NFR-09 | **The role table agrees with the service**: tested over every role, action, target role, new role and self flag. |

## Threats and controls

Each row names the tests that cover it. `src/service/review.test.ts` fails the build if a named test file or test disappears.

| Threat | Control | Covered by |
|--------|---------|------------|
| A crafted address (`#/circles/..%2f..`, markup, a very long hash) making the page request something else | Routes are parsed strictly; an id must match its exact shape; anything else is home (D6, WC-NFR-01) | `web/router.test.mjs` — "anything that is not exactly one of ours is home"; `web/router.test.mjs` — "whatever is typed, what comes out is one of our addresses"; `web/circles-pages.test.mjs` — "a hostile or unknown address lands on home and nothing odd is asked for"; `web/circle-page.test.mjs` — "a bad id in the address never reaches a path"; `web/pages.test.mjs` — "only the entry point touches the address bar" |
| An id in an answer used to build a path | Ids from answers are checked against their shape again before use (D6) | `web/circles-client.test.mjs` — "are recognised only in the exact shapes the service makes"; `web/circles-client.test.mjs` — "a circle id is not accepted where an invitation id goes"; `web/circles-client.test.mjs` — "one item that is not shaped right refuses the whole page"; `web/circles-client.test.mjs` — "answers that are not shaped right are server problems, never crashes" |
| Text written by other people (a display name, a circle name or description, an invitation sender) run as code | Text only through templates and `textContent`; the strict policy as the second line (D15, WC-NFR-02) | `web/circles-pages.test.mjs` — "markup in a circle name or a sender"; `web/circle-page.test.mjs` — "names and descriptions made of markup stay text"; `web/service.test.mjs` — "markup in names stays text across the whole journey"; `web/pages.test.mjs` — "no script uses %s"; `web/pages.test.mjs` — "there are ten row templates"; `web/pages.test.mjs` — "every slot the script fills exists in its template" |
| A person acting on a stale view (a role changed, a circle deleted by someone else) | Every action reloads what it changed; a refusal that shows staleness reloads the view; the service re-checks everything (D14) | `web/circle-session.test.mjs` — "a refusal for lack of rights shows the service"; `web/circle-session.test.mjs` — "forbidden refreshes everything"; `web/circle-session.test.mjs` — "a person who has left"; `web/circles-session.test.mjs` — "an invitation that has gone is"; `web/circle-page.test.mjs` — "a refusal for rights shows the service" |
| A double click sending an action twice | One request at a time and disabled controls (WC-FR-15) | `web/circles-session.test.mjs` — "a second call in the same area sends nothing"; `web/circle-session.test.mjs` — "a second call while one is out sends nothing"; `web/circles-pages.test.mjs` — "controls are disabled while a request is out and enabled again after"; `web/circle-page.test.mjs` — "controls are disabled while a request is out" |
| A role hint hiding a control that is allowed, or showing one that never is | The hint table is tested against the service's own permission function (D7, WC-NFR-09) | `web/permissions.test.mjs` — "change a role, for every actor, target, new role and self flag"; `web/permissions.test.mjs` — "remove, for every actor, target and self flag"; `web/permissions.test.mjs` — "invite and withdraw, for every actor and every offered role"; `web/circle-page.test.mjs` — "may invite members and observers only, and manage only members and observers" |
| The page revealing whether an account exists | The invitation wording never says (D11) | `web/circle-page.test.mjs` — "the notice is the same for a name with no account"; `web/circle-session.test.mjs` — "the answer is the same for every name"; `web/circles-client.test.mjs` — "an invitation answer is the same whatever the username was"; `web/service.test.mjs` — "create, invite, see the count, accept" |
| An irreversible action taken by accident | Two-step confirmation for delete, remove and leave (D8) | `web/circle-session.test.mjs` — "asking sends nothing and the state says what is asked"; `web/circle-page.test.mjs` — "asking shows the question in that row with the focus on Cancel"; `web/circle-page.test.mjs` — "leaving asks first; Cancel changes nothing"; `web/circle-page.test.mjs` — "deleting says what it removes, needs Yes, and goes to the list" |
| Circle data kept where it can be read later | Memory only; no storage (D16, WC-NFR-04) | `web/pages.test.mjs` — "nothing is kept in the browser and nothing is sent anywhere else"; `web/circle-page.test.mjs` — "signing out clears the circle, and its screen is not shown"; `web/circles-pages.test.mjs` — "signing out forgets the lists; signing in again starts clean" |

## What the person is told

| Situation | What the page shows |
|-----------|---------------------|
| 401 | The sign-in screen, with "Your session has ended. Sign in again." |
| 403 | "Your role in this circle does not allow that." and the view reloads |
| 404 on a circle | "No such circle, or you are not in it." with a link back to the list |
| 404 on an invitation | "No such invitation: it may have been withdrawn, used or expired." and the list reloads |
| 404 on a member | "That person is no longer in this circle." and the roster reloads |
| 409 (the only owner) | The service's words: make someone else an owner, or delete the circle |
| 422 | The service's message beside the field it names |
| 429, a limit | The service's message (for example the most circles a person may be in) |
| 429, a wait | "Too many tries. Wait N seconds and try again." |
| 500, or the service cannot be reached | The same words as R-005 |

## Files

The new files are chosen in T-118 to T-124 (a circles client, a router, the role hints, the logic for the list and for one circle, and the pages' code). Each is added to the fixed list in `src/service/web-app.ts` and to the README's file table in the task that adds it, and the packaging check follows.

## Acceptance criteria

| ID | Check |
|----|-------|
| WC-AC-01 | A person creates a circle, lands on it as its owner, and sees it in their list with their role and one person. |
| WC-AC-02 | An owner invites a username; the invited person sees the count on their home page after loading it or pressing Refresh, opens the invitations, accepts, and lands on the circle; the owner's roster now has them. |
| WC-AC-03 | Declining an invitation removes it and the count falls. |
| WC-AC-04 | A manager is offered only member and observer for invitations and role changes, and no control beside owners, other managers, or themselves; a member or observer is offered no management controls. |
| WC-AC-05 | Changing a role, removing someone, leaving and deleting each do what they say and leave the screen showing the new state; the three irreversible ones ask first and do nothing on cancel. |
| WC-AC-06 | The only owner leaving is refused in the service's words and nothing changes. |
| WC-AC-07 | The address selects the screen: the back button, a reload and a copied address work; a hostile or malformed hash is the home screen and no request is made with it. |
| WC-AC-08 | A stranger's address for a circle, and a made-up one, show the same words and the way back. |
| WC-AC-09 | Display names, circle names and descriptions made of markup are shown as plain text and nothing runs. |
| WC-AC-10 | The page's role table equals the service's over every combination. |
| WC-AC-11 | After inviting, nothing on the page tells whether the username has an account. |
| WC-AC-12 | The main heading takes the focus and the title follows on each change of screen; every control can be used from the keyboard; the browser reports no policy violation. |

### Where each criterion is checked (T-126)

| ID | Covered by |
|----|------------|
| WC-AC-01 | `web/service.test.mjs` — "create, invite, see the count, accept"; `web/circles-pages.test.mjs` — "sends the clean values, goes to the new circle, and empties the form"; `web/circles-pages.test.mjs` — "lists the circles with the person" |
| WC-AC-02 | `web/service.test.mjs` — "create, invite, see the count, accept"; `web/circles-pages.test.mjs` — "accepting goes to that circle; the home count follows"; `web/circles-pages.test.mjs` — "Refresh asks again and shows the new number" |
| WC-AC-03 | `web/circles-pages.test.mjs` — "declining removes the row, updates the count and keeps the focus on the heading"; `web/circles-session.test.mjs` — "declining removes the row and the count follows" |
| WC-AC-04 | `web/circle-page.test.mjs` — "may invite members and observers only, and manage only members and observers"; `web/circle-page.test.mjs` — "only the circle, the people and a way to leave"; `web/permissions.test.mjs` — "person controls: nothing beside your own row" |
| WC-AC-05 | `web/service.test.mjs` — "create, invite, see the count, accept"; `web/circle-page.test.mjs` — "leaving asks first; Cancel changes nothing"; `web/circle-page.test.mjs` — "deleting says what it removes, needs Yes, and goes to the list"; `web/circle-page.test.mjs` — "confirming removes, reloads the people and moves the focus to their heading"; `web/circle-page.test.mjs` — "sends the chosen role, reloads the people and puts the focus on their heading" |
| WC-AC-06 | `web/circle-page.test.mjs` — "the only owner is told in the service"; `web/circle-session.test.mjs` — "the only owner is told in the service"; `web/service.test.mjs` — "create, invite, see the count, accept" |
| WC-AC-07 | `web/circles-pages.test.mjs` — "follows the address, the back button and a pasted address"; `web/circles-pages.test.mjs` — "a hostile or unknown address lands on home and nothing odd is asked for"; `web/circles-pages.test.mjs` — "while signed out the address is kept, and applies after signing in"; `web/router.test.mjs` — "anything that is not exactly one of ours is home" |
| WC-AC-08 | `web/circle-page.test.mjs` — "is "no such circle" for a stranger and for a made-up one, with a way back"; `web/service.test.mjs` — "create, invite, see the count, accept"; `web/service.test.mjs` — "a circle that is not yours and one that never existed read the same" |
| WC-AC-09 | `web/service.test.mjs` — "markup in names stays text across the whole journey"; `web/circle-page.test.mjs` — "names and descriptions made of markup stay text"; `web/circles-pages.test.mjs` — "markup in a circle name or a sender" |
| WC-AC-10 | `web/permissions.test.mjs` — "change a role, for every actor, target, new role and self flag"; `web/permissions.test.mjs` — "rename, delete and leave, for every actor"; `web/permissions.test.mjs` — "remove, for every actor, target and self flag"; `web/permissions.test.mjs` — "invite and withdraw, for every actor and every offered role" |
| WC-AC-11 | `web/circle-page.test.mjs` — "the notice is the same for a name with no account"; `web/circle-session.test.mjs` — "the answer is the same for every name" |
| WC-AC-12 | `web/circles-pages.test.mjs` — "follows the address, the back button and a pasted address"; `web/circle-page.test.mjs` — "asking shows the question in that row with the focus on Cancel"; `web/pages.test.mjs` — "the navigation and heading elements exist"; `web/pages.test.mjs` — "gives every field a visible label, a name and the right autocomplete value"; `web/pages.test.mjs` — "follows the system theme, shows keyboard focus, respects reduced motion, and copes with a narrow window" |

The whole journey was also looked at by hand in Chrome against the real service (recorded in `.gsd/STATE.md`, T-125): the address, title and focus following each screen, a circle named with markup shown as text, an invitation by username, the count on the invited person's home page, accepting with the keyboard, the manager's reduced controls, the leave question's focus, the hostile address, Back, a reload, and an injected script and image being blocked.

### Residual risks (not covered, with the reason)

These are real and known; the ones that can be acted on are in the PLAN Backlog.

1. **A view is only as new as its last load.** Nothing is pushed: if another person changes a role or removes someone, this page learns it on its next load or when one of its own actions is refused. The service re-checks every action, so the effect is a wrong button for a while, never a wrong result.
2. **The invitation count is not live.** It is fetched when the home page opens and when Refresh is pressed, and shows no number if the last attempt failed; a person who does not press it can miss an invitation until the next visit.
3. **Role hints can lag behind the service.** The table is tested against the service's function today, but the page and the service are separate files: a change to the rules in `src/circles/authorise.ts` makes the test fail until the page follows, and a browser holding an old copy of the page would show the old hints (every action is still checked by the service).
4. **Usernames and display names are visible to every member of a circle.** The page says so on the circle and invitations screens; that is the design of circles for now (R-004), not something the page can limit.
5. **Nobody is notified.** An invitation is found only by looking; there is no email, push or badge outside the page.
6. **An invitation to a name nobody has can reach whoever registers it within the invitation's life.** The page deliberately never says whether an account exists (R-004 D9), which is why the invitation is held by name; the registrant still has to accept and sees who invited them.
7. **A role chosen in a row but not saved is lost when another action redraws the people**, and the roster arrives in user-id order, not by name. Both are small and harmless; neither loses data.
8. **What was looked at by eye is one browser on one machine.** Narrow and dark layouts and a screen reader were not tried by hand; they are covered by checks on the structure, not by assistive technology. The policy-violation console was read after the journey, not during page load.
9. **Two tabs of the same person do not know about each other.** Each is a view as old as its last load; the service stays the authority.

## Build order

T-117 this specification; T-118 the circles client; T-119 the router; T-120 the role hints; T-121 logic for the list, creating and invitations; T-122 logic for one circle and managing it; T-123 the pages for home, circles and invitations; T-124 the page for one circle; T-125 serving it, end to end and a hand check; T-126 the security review; T-127 the README.
