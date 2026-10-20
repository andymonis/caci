# The Minimal User App — Specification

Oct 20, 2026 · @Andy

**Status: being built as N1 (T-242 to T-249); decisions D1 to D15 taken as confirmed by the owner's instruction to build (2026-10-20).** The flow comes from the owner's `architecture/user_pwa.md`: *Login → Home (a chat) → Profile / Settings*. The existing web app stays exactly as it is, as the **back office** for testing, at `/admin`.

## Overview

The current web app (R-005, R-006, R-007, R-008, R-009, R-011, R-014) exposes every feature of the service. This specification adds a second, **very minimal** web app for ordinary use:

1. **Login** with the existing account API.
2. **Home**, an iMessage-style chat. The person types an *update* and presses **Send**, or types a *question* and presses **Ask**. CaCi answers in the thread.
3. **Profile / Settings**: change display name and email, change password, sign out.

It **adds no server API**: every action uses the routes the back office already uses (R-005, R-007, R-009, R-011). That keeps one set of rules and one place to fix a bug. The chat is an experiment (the owner is "not even certain this is the right interface yet"), so it keeps no history.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** the minimal app is served at `/`; the current app moves to `/admin` and is otherwise unchanged. Same service, same login cookie, same origin. | The family sees the simple app; the owner keeps the back office for testing. |
| D2 | **Owner:** the flow is Login → Home → Profile / Settings (`architecture/user_pwa.md`). | The owner's design. |
| D3 | **Owner:** Home is a chat with two fields as drawn: an *update* field with **Send** and a *question* field with **Ask**. | The owner's design. |
| D4 | **Owner:** **Send** first asks *"Is this for you or a circle?"* **in the thread**, as buttons: "Me" and one per circle the person may capture into (`GET /api/brain/scopes`, `canCapture` true; read-only circles are not offered). The note is then filed there, and the thread says **"Recorded against your brain"** or **"Recorded against the circle <name>"**. With no writable circle the question is skipped and the note goes to the person's own brain. | The owner's design; the existing scope rules decide who may capture where. |
| D5 | **Owner:** a note is **saved straight away**, with no preview step and no Undo in this version. The app makes `propose` and then `approve` itself. If the proposal has problems, or the write is refused, the app does **not** keep it: it rejects the proposal, and the thread says what went wrong in the service's words. | The owner's choice. The back office keeps the preview and the change log. |
| D6 | Because nothing is previewed, the thread **says what happened** in plain lines: the facts recorded (title and summary) and, when it replaced something, **"Replaced: <old fact>"**. | Automatic replacement must not be silent (R-014). |
| D7 | **Owner:** **Ask** is `POST /api/status` as it is: it reads the person's own brain **and every circle they can read** (R-011). The answer appears in the thread with where each point came from. | The owner's choice over restricting a question to one circle. |
| D8 | **Owner:** the thread is **in memory only**. Reloading, signing out or leaving the page clears it. Nothing is kept in the browser (no storage), as in the back office. | The owner is not yet sure the chat is right; no history to design or protect. |
| D9 | **Owner:** Profile / Settings holds **display name and email** (`PATCH /api/me`), **change password** (`POST /api/me/password`), **sign out** (`POST /api/logout`) and a link to `/admin`. Circles, invitations and deleting the account are not in this app. | The owner's choice. |
| D10 | **Owner:** a **simple PWA**: a plain web page that works well on a phone (viewport, large touch targets, one column). **No manifest, no icon, no service worker, no HTTPS** in this version. | The owner's choice; the Pi runs plain HTTP. Installing can be added later. |
| D11 | **Look:** plain and large, one column, light only (no dark mode). Built with the same rules as the back office: plain HTML, CSS and JavaScript, no build, no dependency, text set only with `textContent`, the same Content-Security-Policy, nothing in browser storage, the session cookie invisible to the page. | Consistency and safety. |
| D12 | **The model notice** stays: a small line saying which model files notes and answers (`GET /api/capture/mode`) is shown before the first thing is sent, and Send/Ask stay disabled until it is known. With the real model it says everything is sent to Anthropic and not anonymised. | The honesty rule of R-007 and R-011. |
| D13 | **Limits are the service's.** A note is 1 to 8,000 characters, a question 1 to 500; the service's limits (pending proposals, proposals and statuses an hour, one status at a time) appear in the thread in its own words with the wait. | One set of rules. |
| D14 | **Sharing code.** The new app reuses the existing client modules (`api-client.js`, `notes-client.js`, `session.js`, `forms.js`) and adds only its own screens and chat logic. Shared files keep their names and paths. The back office page moves to `/admin` and keeps loading `/app.js` and `/style.css`; the new page is `/` and loads its own `/user-app.js` and `/user-style.css`. | The smallest change to the served list; nothing is copied. |
| D15 | **Out of scope:** Undo, history, a manifest or icon, offline use, circles and invitations, browsing and editing notes, a per-circle question, notifications, voice and pictures. | Keep it minimal. |

## Goals and non-goals

**Goals:** a person can sign in, tell CaCi something, choose whose brain it goes to, see that it was recorded and what changed, ask a question and get an answer built from everything they can read, and manage their profile, all from a phone, with almost nothing on the screen.

**Non-goals:** the items in D15; changing any service rule; replacing the back office.

## Screens

```
Login            username, password, [Sign in]          (a "Create account" link while registration is open)

Home (chat)      -------------------------------
                 |  CaCi              (Settings)|
                 |  <user name>                 |
                 |------------------------------|
                 |                  my update   |   right: the person
                 | Is this for you or a circle? |   left: CaCi
                 | [Me] [Parent care]           |
                 |                  Me          |
                 | Recorded against your brain  |
                 | • Mum: phone number …        |
                 | Replaced: Mum: old number    |
                 |                  my question |
                 | Answer … (From: your notes)  |
                 |------------------------------|
                 | [ update ........... ] Send  |
                 | [ question ......... ] Ask   |
                 -------------------------------

Settings         display name, email, [Save]
                 change password: current, new, [Change]
                 [Sign out]        Back office (/admin)
```

## Requirements

| ID | Requirement |
|----|-------------|
| UP-FR-01 | `/` serves the minimal app and `/admin` serves the back office; every other served file keeps its path; no API route changes. |
| UP-FR-02 | The app signs the person in and out, shows Login when there is no session (a stale session is handled as in the back office), and keeps the person on Home after a reload. |
| UP-FR-03 | Send asks "for you or a circle?" in the thread with only the places the person may capture into; with none but their own it files straight away. |
| UP-FR-04 | The chosen scope is sent with the note; the thread says which brain it was recorded against, by the circle's name. |
| UP-FR-05 | A note is proposed and approved in one go; a proposal with problems, a refused write or a model failure records nothing and says why; the pending proposal is rejected so it does not use a place. |
| UP-FR-06 | The thread lists the facts recorded and any fact replaced. |
| UP-FR-07 | Ask shows the answer with where each point came from, "nothing relevant was found" when so, and the service's words and wait for any failure or limit. |
| UP-FR-08 | One request at a time; both fields and buttons are disabled while one is out; a second press sends nothing. |
| UP-FR-09 | Nothing the person or CaCi wrote is ever parsed as markup, and nothing is stored in the browser. |
| UP-FR-10 | Settings change the display name and email and the password with the service's words for refusals; a changed password ends the person's other sessions as the service does. |
| UP-FR-11 | The model notice is shown before the first Send or Ask and the buttons wait for it. |
| UP-NFR-01 | No new dependency, no build, no server API, no browser storage. |
| UP-NFR-02 | The page works at phone width with touch targets of at least 2.75 rem and is usable by keyboard and screen reader (labels, focus, live updates for new messages). |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| Text from the person, a circle member or the model run as markup | Text only, as in the back office; guard tests on the files. | `web/chat-page.test.mjs` — "hostile text, from the person or from CaCi, is only text"; `web/user-mount.test.mjs` — "a hostile name is only text"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console"; `web/chat-session.test.mjs` — "markup in a note comes back as text, and a cancelled choice records nothing" |
| A note filed to the wrong brain | The scope is chosen in the thread, shown in the confirmation, and checked by the service (an observer or stranger is refused as today). | `web/chat-page.test.mjs` — "with a circle to write to it asks in the thread, with buttons, and the first button takes the focus"; `web/chat-session.test.mjs` — "a circle files to that circle, sending only its kind and id, and says its name"; `web/user-journey.test.mjs` — "an observer is not offered the circle and her update goes to her own brain" |
| A silent wrong deletion (no preview) | D6 lists every replacement in the thread; the back office keeps the change log. A residual risk. | `web/chat-page.test.mjs` — "a replaced fact is listed"; `web/chat-session.test.mjs` — "lists every fact, and each fact replaced"; `web/user-journey.test.mjs` — "register, the model notice first, record, replace, record into a circle, ask, change settings, sign out and sign in" |
| The thread kept where it can be read later | D8: memory only, cleared on reload and sign-out. | `web/chat-page.test.mjs` — "the thread stays when going to Settings and back, and is gone after signing out"; `web/chat-session.test.mjs` — "reset clears the thread and the model, and drops an answer still on its way"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console" |
| A pending proposal left behind by a failure | UP-FR-05: rejected on any failure. | `web/chat-session.test.mjs` — "a proposal with problems is rejected, not approved"; `web/chat-session.test.mjs` — "a refused write is rejected so it holds no place"; `web/chat-page.test.mjs` — "a refusal is said in the thread in the service" |
| Two apps drifting apart | One set of clients and one API (D14). | `web/user-pages.test.mjs` — "name only routes that exist, by path"; `web/user-journey.test.mjs` — "the page is reachable at / and the back office at /admin, both from the same service"; `web/user-pages.test.mjs` — "are exactly the modules the entry point reaches, and import only each other by name" |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| UP-AC-01 | Given the service, when `/` is opened, then the minimal app loads, and `/admin` loads the back office unchanged. |
| UP-AC-02 | Given no session, when the person opens the app, then Login shows; after signing in, Home; after a reload, Home again. |
| UP-AC-03 | Given the person is in a circle where they may capture, when they press Send, then the thread asks "for you or a circle" with Me and the circle; an observer-only circle is not offered. |
| UP-AC-04 | Given Me chosen, when the note is filed, then the thread says it was recorded against their own brain and lists the facts. |
| UP-AC-05 | Given a circle chosen, then the note is in that circle's brain and the thread names the circle. |
| UP-AC-06 | Given a note that changes an earlier fact, then the thread says which fact was replaced. |
| UP-AC-07 | Given a refused write or a model failure, then nothing is recorded, the thread says why and no proposal stays pending. |
| UP-AC-08 | Given a question, when Ask is pressed, then the answer shows with its sources and uses the person's own and circle brains. |
| UP-AC-09 | Given a request is out, then both fields and buttons are disabled and a second press sends nothing. |
| UP-AC-10 | Given a reload or sign-out, then the thread is gone and nothing was stored in the browser. |
| UP-AC-11 | Given Settings, when the display name, email or password is changed, then the service's answer is shown and a wrong current password is refused in its words. |
| UP-AC-12 | Given hostile text in a note, a name or an answer, then it is shown as text. |


### Where each criterion is checked (T-249)

| ID | Tests |
|----|-------|
| UP-AC-01 | `web/user-journey.test.mjs` — "the page is reachable at / and the back office at /admin, both from the same service"; `web/user-pages.test.mjs` — "loads one module script from /user-app.js and one style sheet, and nothing else" |
| UP-AC-02 | `web/user-mount.test.mjs` — "shows the sign-in form to a person with no session, and nothing of the app"; `web/user-mount.test.mjs` — "signing in goes to Home and empties the form"; `web/user-mount.test.mjs` — "a person with a session lands on Home with their name, the title, the focus on the heading and the nav marked" |
| UP-AC-03 | `web/chat-page.test.mjs` — "with a circle to write to it asks in the thread, with buttons, and the first button takes the focus"; `web/chat-session.test.mjs` — "asks in the thread, offering Me, each circle you may capture into, and Cancel"; `web/user-journey.test.mjs` — "an observer is not offered the circle and her update goes to her own brain" |
| UP-AC-04 | `web/chat-page.test.mjs` — "sending with only an own brain files straight away, shows both sides and clears the box"; `web/chat-session.test.mjs` — "with only your own brain it files straight away: proposes, approves, and says what was recorded" |
| UP-AC-05 | `web/chat-session.test.mjs` — "a circle files to that circle, sending only its kind and id, and says its name"; `web/chat-session.test.mjs` — "a person in a circle is asked, and the note lands in the circle; another member can read it"; `web/user-journey.test.mjs` — "register, the model notice first, record, replace, record into a circle, ask, change settings, sign out and sign in" |
| UP-AC-06 | `web/chat-page.test.mjs` — "a replaced fact is listed"; `web/chat-session.test.mjs` — "lists every fact, and each fact replaced"; `web/chat-session.test.mjs` — "a profile note to your own brain, then a change that replaces only one fact, then a question" |
| UP-AC-07 | `web/chat-session.test.mjs` — "a model failure says why, with the wait, and nothing is approved"; `web/chat-session.test.mjs` — "a refused write is rejected so it holds no place"; `web/chat-session.test.mjs` — "a proposal with problems is rejected, not approved"; `web/chat-page.test.mjs` — "a refusal is said in the thread in the service" |
| UP-AC-08 | `web/chat-page.test.mjs` — "asking shows the question and the answer with where it came from, and clears the question"; `web/chat-session.test.mjs` — "shows the answer with where each point came from, and sends the browser time zone"; `web/user-journey.test.mjs` — "an observer is not offered the circle and her update goes to her own brain" |
| UP-AC-09 | `web/chat-page.test.mjs` — "controls are disabled while a request is out, and nothing is sent twice"; `web/chat-session.test.mjs` — "a second send, ask or choice meanwhile sends nothing"; `web/user-mount.test.mjs` — "controls are disabled while a request is out, and a second submit sends nothing" |
| UP-AC-10 | `web/chat-page.test.mjs` — "signing out empties the boxes and their errors"; `web/chat-session.test.mjs` — "reset clears the thread and the model, and drops an answer still on its way"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console" |
| UP-AC-11 | `web/user-mount.test.mjs` — "changing the password sends both, empties both fields, says the other devices were signed out and never shows a password"; `web/user-mount.test.mjs` — "saving a new name sends only the name, shows Saved, updates the name at the top and empties the email"; `web/user-mount.test.mjs` — "a refusal from the service is shown beside the field it names, or at the top"; `web/user-mount.test.mjs` — "early problems appear beside the fields; a wrong current password is the service" |
| UP-AC-12 | `web/chat-page.test.mjs` — "hostile text, from the person or from CaCi, is only text"; `web/user-mount.test.mjs` — "a hostile name is only text"; `web/chat-session.test.mjs` — "a circle name is only text" |

Checked by hand in Chrome on the real service (T-248): the notice before sending, recording and replacing, a question, a hostile display name shown as text, Settings, sign-out clearing the thread, no cookie or storage visible to script, no horizontal overflow. Not checked by eye: a true phone-width window, typing and the keyboard path through the forms (they were submitted by script), a screen reader, and the real model.

### Residual risks (not covered, with the reason)

1. **No preview and no Undo**: an automatic replacement can be wrong and the person finds out only from the thread; the back office's change log is the recovery.
2. **The chat forgets everything on reload**, which may feel wrong; it is deliberate while the interface is an experiment.
3. **Not installable yet**: no manifest, icon or HTTPS.
4. **Ask reads every brain the person can read**, as the service does; there is no per-circle question.
5. **The model's choice of facts is not shown before saving**; a mis-split note is recorded as is.
6. **Two pages share one cookie and one origin**: a flaw in either is a flaw in both.
7. **Looked at by eye in one browser only**, with the demo model: no true phone-width window, no screen reader, forms driven by script; the page tests cover the same handlers.
8. **A choice question in the thread is not a dialog**: a person who scrolls away leaves the question open; the update and question buttons stay disabled until it is answered or cancelled.
9. **The thread shows facts in the model's own words**, which are the stored title and summary, so an odd split is visible only after it is saved.
