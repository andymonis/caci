# The Minimal User App — Specification

Oct 20, 2026 · @Andy

**Status: N1 (T-242 to T-249) built; amended on 2026-10-20 by the owner's updated `architecture/user_pwa.md` (a Circle screen per circle) as N2 (T-250 to T-257), decisions D16 to D22; D4 and the Send question of the screens are superseded by D16.** The flow comes from the owner's `architecture/user_pwa.md`: *Login → Home (a chat) → Profile / Settings*. The existing web app stays exactly as it is, as the **back office** for testing, at `/admin`.

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
| D15 | **Out of scope:** Undo, history, a manifest or icon, offline use, managing circles and invitations (still the back office), browsing and editing notes, a per-circle question, notifications, voice and pictures. | Keep it minimal. |
| D16 | **Owner (2026-10-20), supersedes D4:** on **Home**, **Send always records against the person's own brain**; there is no "for you or a circle?" question and no choice buttons. Ask on Home is unchanged (D7: own brain and every readable circle). | The owner's updated flow: circles get their own screens. |
| D17 | **Owner:** there is **one Circle screen for each circle the person is a member of** (any role), listed **at the top of the navigation**, before Home and Settings, by circle name. It is at `#/circle/<circle id>` (the exact id shape; anything else is Home). The list comes from `GET /api/brain/scopes` and is read again whenever a screen is shown, so a circle joined or left appears or disappears. A circle the person has left falls back to Home with the one set of words. | The owner's design. |
| D18 | **Owner:** on a Circle screen, **Send records against that circle's brain** (propose then approve in one go, as D5), and the thread says "Recorded against the circle <name>" with the facts and any "Replaced:" line. The update field is the only text field. An **observer** (read-only) sees the thread and the Pulse button but the update field and Send are disabled with a line saying they can read but not add. | Keeps the circle's context separate from the person's own brain (the owner's words). |
| D19 | **Owner:** the Circle screen has a **Pulse** button instead of a question field: it asks for a status update of that circle with **predefined text**. | A fast, consistent way to get the circle's status. |
| D20 | **Pulse reads only that circle** (owner's choice): `POST /api/status` gains an optional `scope` (`{ "kind": "circle", "circleId": ... }`, the same strict rules and the same one not-found for a stranger or a made-up circle as browse; observers may read) and the context is then that circle's notes only. Without `scope` nothing changes (own brain and every circle). | The owner's choice; small server change, no new route. |
| D21 | **The pulse text is a file on the server** (owner's choice): `controls/pulse.txt`, suggested *"Provide a status update for the circle. Keep the answer factual, stick to the point and be concise."* The service reads it at start-up (a missing, blank, over 500-character or control-character file stops the start, naming it, like the controls). `POST /api/status` takes `pulse: true` with a circle `scope` and **no `text`**: the server substitutes the file's text, so the browser never holds or sends it and no member can send other text as a pulse. The doctor checks the file. | Configurable by the operator, not by a member; same discipline as the other controls. |
| D22 | **The Pulse is not filed and not kept** (as every status): the thread shows a "Pulse" message from the person and CaCi's answer with its sources. Circle threads, like the Home thread, are in memory only and are cleared on reload or sign-out. | Consistent with D8 and R-011. |

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
                 | Recorded against your brain  |   left: CaCi
                 | • Mum: phone number …        |
                 | Replaced: Mum: old number    |
                 |                  my question |
                 | Answer … (From: your notes)  |
                 |------------------------------|
                 | [ update ........... ] Send  |
                 | [ question ......... ] Ask   |
                 -------------------------------

Circle           -------------------------------      one for each circle you belong to,
(one per circle) |  CaCi          Club  (Chat…) |      its link first in the navigation
                 |------------------------------|
                 |                  my update   |
                 | Recorded against the circle  |
                 |                  Pulse       |
                 | Status of the circle …       |
                 |------------------------------|
                 | [ update ........... ] Send  |
                 |                      [Pulse] |
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
| UP-FR-03 | On Home, Send always records against the person's own brain; no question is asked, whatever circles they are in (D16). |
| UP-FR-04 | The thread says which brain a note was recorded against: "Recorded against your brain" or "Recorded against the circle <name>". |
| UP-FR-05 | A note is proposed and approved in one go; a proposal with problems, a refused write or a model failure records nothing and says why; the pending proposal is rejected so it does not use a place. |
| UP-FR-06 | The thread lists the facts recorded and any fact replaced. |
| UP-FR-07 | Ask shows the answer with where each point came from, "nothing relevant was found" when so, and the service's words and wait for any failure or limit. |
| UP-FR-08 | One request at a time; both fields and buttons are disabled while one is out; a second press sends nothing. |
| UP-FR-09 | Nothing the person or CaCi wrote is ever parsed as markup, and nothing is stored in the browser. |
| UP-FR-10 | Settings change the display name and email and the password with the service's words for refusals; a changed password ends the person's other sessions as the service does. |
| UP-FR-11 | The model notice is shown before the first Send or Ask and the buttons wait for it. |
| UP-FR-12 | The navigation lists each circle the person is in, by name, before Chat and Settings; each has a Circle screen at `#/circle/<id>` (exact id shape, otherwise Home); the list is re-read whenever a screen is shown, and a circle the person is not in or has left gives the one no-such-circle words and goes Home (D17). |
| UP-FR-13 | On a Circle screen Send records against that circle only (kind and id sent, never a graph id); an observer's update box and Send are disabled with the reason (D18). |
| UP-FR-14 | The Pulse button asks for a status of that circle only: the page sends `pulse: true` and the circle, never words; the answer shows with its sources, in the thread (D19, D20, D22). |
| UP-FR-15 | The pulse text is the file `controls/pulse.txt`, read at start-up; a missing, blank, over-long or multi-line file stops the start (D21). |
| UP-FR-16 | Each circle has its own thread, in memory only, kept while signed in and forgotten on sign-out; a changed right or name starts a fresh thread (D22). |
| UP-NFR-01 | No new dependency, no build, no server API, no browser storage. |
| UP-NFR-02 | The page works at phone width with touch targets of at least 2.75 rem and is usable by keyboard and screen reader (labels, focus, live updates for new messages). |

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| Text from the person, a circle member or the model run as markup | Text only, as in the back office; guard tests on the files. | `web/chat-page.test.mjs` — "hostile text, from the person or from CaCi, is only text"; `web/user-mount.test.mjs` — "a hostile name is only text"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console"; `web/chat-session.test.mjs` — "markup in a note comes back as text" |
| A note filed to the wrong brain | Home Send is always the own brain and a Circle screen's Send is that circle (the page sends the circle's kind and id only); the thread names the brain, and the service checks the right (an observer or stranger is refused as today). | `web/chat-page.test.mjs` — "sending with only an own brain files straight away, shows both sides and clears the box"; `web/chat-session.test.mjs` — "Send records against that circle, sending only its kind and id, and says its name"; `web/user-journey.test.mjs` — "Home is the own brain for everyone" |
| A silent wrong deletion (no preview) | D6 lists every replacement in the thread; the back office keeps the change log. A residual risk. | `web/chat-page.test.mjs` — "a replaced fact is listed"; `web/chat-session.test.mjs` — "lists every fact, and each fact replaced"; `web/user-journey.test.mjs` — "register, the model notice first, record, replace, record into a circle, ask, change settings, sign out and sign in" |
| The thread kept where it can be read later | D8: memory only, cleared on reload and sign-out. | `web/chat-page.test.mjs` — "the thread stays when going to Settings and back, and is gone after signing out"; `web/chat-session.test.mjs` — "reset clears the thread and the model, and drops an answer still on its way"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console" |
| A pending proposal left behind by a failure | UP-FR-05: rejected on any failure. | `web/chat-session.test.mjs` — "a proposal with problems is rejected, not approved"; `web/chat-session.test.mjs` — "a refused write is rejected so it holds no place"; `web/chat-page.test.mjs` — "a refusal is said in the thread in the service" |
| Two apps drifting apart | One set of clients and one API (D14). | `web/user-pages.test.mjs` — "name only routes that exist, by path"; `web/user-journey.test.mjs` — "the page is reachable at / and the back office at /admin, both from the same service"; `web/user-pages.test.mjs` — "are exactly the modules the entry point reaches, and import only each other by name" |
| The pulse text forged by a member | D21: the words are a server file; the page sends only `pulse: true` and a circle, and the service refuses text with a pulse. | `src/service/status-end-to-end.test.ts` — "is refused by name with text, with no circle, with a personal scope or with a value that is not a boolean"; `src/service/status-end-to-end.test.ts` — "an edited pulse file is what the provider is asked, and the browser never sends the words"; `web/user-pages.test.mjs` — "holds no words for the Pulse: the text lives on the server" |
| A circle read through a status or pulse by someone who is not in it | D20: the scope is resolved with the read right; a stranger, a made-up circle and a non-member administrator get the one not-found before anything is read or counted. | `src/service/status-end-to-end.test.ts` — "a member and an observer get a pulse of that circle only; a stranger and a made-up circle get the same 404; the pulse is not filed"; `src/caci/controller-status-scope.test.ts` — "a stranger, a person in another circle only and a made-up circle get the one not-found, and nothing is asked, read or counted"; `web/user-journey.test.mjs` — "circle screens: a link per circle at the top, Home Send is the own brain" |
| A Pulse that reads more than the circle | D20: a circle scope narrows the context to that circle's notes; a recording adapter shows no other graph is read. | `src/caci/controller-status-scope.test.ts` — "reads only that circle and names it as the source"; `src/caci/controller-pulse.test.ts` — "text for that circle only, whoever asks (a member or an observer), and answers like a status" |
| A link or screen for a circle the person has left | D17: the list is re-read whenever a screen is shown; an address for a circle not in the list gives the no-such-circle words and Home. | `web/user-circles.test.mjs` — "is read again whenever a screen is shown: a circle joined appears, a circle left disappears"; `web/user-circles.test.mjs` — "a circle the person is not in (or has left) gives the one set of words and goes to Home"; `web/user-journey.test.mjs` — "circle screens: a link per circle at the top, Home Send is the own brain" |
| One person's circle threads shown to the next person on the same page | D22: threads are memory only and are forgotten, and late answers dropped, on sign-out. | `web/circle-chat-page.test.mjs` — "signing out forgets every thread, even for the next person on the same page, and drops an answer still on its way"; `web/circle-chat-page.test.mjs` — "each circle has its own thread, kept while moving between screens, and forgotten on sign-out"; `web/user-circles.test.mjs` — "signing out forgets the links, the heading and the notice" |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| UP-AC-01 | Given the service, when `/` is opened, then the minimal app loads, and `/admin` loads the back office unchanged. |
| UP-AC-02 | Given no session, when the person opens the app, then Login shows; after signing in, Home; after a reload, Home again. |
| UP-AC-03 | Given the person is in a circle where they may capture, when they press Send on Home, then the note is recorded against their own brain and no question is asked. |
| UP-AC-04 | Given Me chosen, when the note is filed, then the thread says it was recorded against their own brain and lists the facts. |
| UP-AC-05 | Given a Circle screen, when they press Send, then the note is in that circle's brain, not their own, and the thread names the circle. |
| UP-AC-06 | Given a note that changes an earlier fact, then the thread says which fact was replaced. |
| UP-AC-07 | Given a refused write or a model failure, then nothing is recorded, the thread says why and no proposal stays pending. |
| UP-AC-08 | Given a question, when Ask is pressed, then the answer shows with its sources and uses the person's own and circle brains. |
| UP-AC-09 | Given a request is out, then both fields and buttons are disabled and a second press sends nothing. |
| UP-AC-10 | Given a reload or sign-out, then the thread is gone and nothing was stored in the browser. |
| UP-AC-11 | Given Settings, when the display name, email or password is changed, then the service's answer is shown and a wrong current password is refused in its words. |
| UP-AC-12 | Given hostile text in a note, a name or an answer, then it is shown as text. |
| UP-AC-13 | Given the person is in circles, then the navigation shows each circle's link first, a link opens its Circle screen, and a circle joined or left appears or disappears at the next screen. |
| UP-AC-14 | Given an observer on a Circle screen, then the update box and Send are disabled with the reason and the Pulse still works. |
| UP-AC-15 | Given a Circle screen, when the Pulse is pressed, then the answer is a status of that circle only with its sources, and the page sent no words. |
| UP-AC-16 | Given a stranger or a removed member opens a circle address, then they see the one no-such-circle words on Home and the service answers a pulse for it the same way. |
| UP-AC-17 | Given `controls/pulse.txt` is missing, blank, over 500 characters or multi-line, then the service does not start and names the file; an edited good file is what the model is asked. |
| UP-AC-18 | Given several circles, then each has its own thread, kept while signed in and gone after sign-out, even for the next person on the same page. |


### Where each criterion is checked (T-249)

| ID | Tests |
|----|-------|
| UP-AC-01 | `web/user-journey.test.mjs` — "the page is reachable at / and the back office at /admin, both from the same service"; `web/user-pages.test.mjs` — "loads one module script from /user-app.js and one style sheet, and nothing else" |
| UP-AC-02 | `web/user-mount.test.mjs` — "shows the sign-in form to a person with no session, and nothing of the app"; `web/user-mount.test.mjs` — "signing in goes to Home and empties the form"; `web/user-mount.test.mjs` — "a person with a session lands on Home with their name, the title, the focus on the heading and the nav marked" |
| UP-AC-03 | `web/chat-page.test.mjs` — "sending with only an own brain files straight away, shows both sides and clears the box"; `web/user-journey.test.mjs` — "Home is the own brain for everyone"; `web/chat-session.test.mjs` — "on Home a note always goes to the own brain, even for a person in a circle" |
| UP-AC-04 | `web/chat-page.test.mjs` — "sending with only an own brain files straight away, shows both sides and clears the box"; `web/chat-session.test.mjs` — "with only your own brain it files straight away: proposes, approves, and says what was recorded" |
| UP-AC-05 | `web/circle-chat-page.test.mjs` — "Send records against this circle (kind and id only), says so by name, lists the facts, clears the box and keeps the focus there"; `web/chat-session.test.mjs` — "Send records against that circle, sending only its kind and id, and says its name"; `web/user-journey.test.mjs` — "circle screens: a link per circle at the top, Home Send is the own brain" |
| UP-AC-06 | `web/chat-page.test.mjs` — "a replaced fact is listed"; `web/chat-session.test.mjs` — "lists every fact, and each fact replaced"; `web/chat-session.test.mjs` — "a profile note to your own brain, then a change that replaces only one fact, then a question" |
| UP-AC-07 | `web/chat-session.test.mjs` — "a model failure says why, with the wait, and nothing is approved"; `web/chat-session.test.mjs` — "a refused write is rejected so it holds no place"; `web/chat-session.test.mjs` — "a proposal with problems is rejected, not approved"; `web/chat-page.test.mjs` — "a refusal is said in the thread in the service" |
| UP-AC-08 | `web/chat-page.test.mjs` — "asking shows the question and the answer with where it came from, and clears the question"; `web/chat-session.test.mjs` — "shows the answer with where each point came from, and sends the browser time zone"; `web/user-journey.test.mjs` — "Home is the own brain for everyone" |
| UP-AC-09 | `web/chat-page.test.mjs` — "controls are disabled while a request is out, and nothing is sent twice"; `web/chat-session.test.mjs` — "a second send, ask, pulse or mode request meanwhile sends nothing"; `web/user-mount.test.mjs` — "controls are disabled while a request is out, and a second submit sends nothing" |
| UP-AC-10 | `web/chat-page.test.mjs` — "signing out empties the boxes and their errors"; `web/chat-session.test.mjs` — "reset clears the thread and the model, and drops an answer still on its way"; `web/user-pages.test.mjs` — "never turn text into markup, run strings as code, or use storage, cookies or the console" |
| UP-AC-11 | `web/user-mount.test.mjs` — "changing the password sends both, empties both fields, says the other devices were signed out and never shows a password"; `web/user-mount.test.mjs` — "saving a new name sends only the name, shows Saved, updates the name at the top and empties the email"; `web/user-mount.test.mjs` — "a refusal from the service is shown beside the field it names, or at the top"; `web/user-mount.test.mjs` — "early problems appear beside the fields; a wrong current password is the service" |
| UP-AC-12 | `web/chat-page.test.mjs` — "hostile text, from the person or from CaCi, is only text"; `web/user-mount.test.mjs` — "a hostile name is only text"; `web/chat-session.test.mjs` — "a circle name is only text" |
| UP-AC-13 | `web/user-circles.test.mjs` — "lists each circle the person is in, by name, before Chat and Settings, in the order the service gave, observers included"; `web/user-circles.test.mjs` — "is read again whenever a screen is shown: a circle joined appears, a circle left disappears"; `web/user-circles.test.mjs` — "shows only that screen, with the circle name as its heading and title, the focus on the heading and its link marked"; `web/user-circles.test.mjs` — "a circle address needs the exact id shape; anything else is Home, and Settings stays exact" |
| UP-AC-14 | `web/circle-chat-page.test.mjs` — "an observer reads: the update box and Send are disabled with the reason, the Pulse works, and nothing can be sent"; `web/chat-session.test.mjs` — "a read-only circle refuses Send and sends nothing, but the Pulse still works" |
| UP-AC-15 | `web/circle-chat-page.test.mjs` — "the Pulse sends only the circle (never words), shows a Pulse message and the answer with its sources"; `src/caci/controller-status-scope.test.ts` — "reads only that circle and names it as the source"; `web/notes-client.test.mjs` — "the pulse sends only pulse, the circle and the time zone, never words, and needs a circle"; `web/user-journey.test.mjs` — "circle screens: a link per circle at the top, Home Send is the own brain" |
| UP-AC-16 | `web/user-circles.test.mjs` — "a circle the person is not in (or has left) gives the one set of words and goes to Home"; `src/service/status-end-to-end.test.ts` — "a member and an observer get a pulse of that circle only; a stranger and a made-up circle get the same 404; the pulse is not filed"; `web/user-journey.test.mjs` — "circle screens: a link per circle at the top, Home Send is the own brain" |
| UP-AC-17 | `src/service/controls-files.test.ts` — "a missing file, a folder, a link, an empty file and blank text are each refused, naming the file"; `src/service/controls.test.ts` — "a missing, blank, over-long or multi-line pulse file stops the start, names the file and leaves no data folder behind"; `src/service/status-end-to-end.test.ts` — "an edited pulse file is what the provider is asked, and the browser never sends the words"; `src/service/status-end-to-end.test.ts` — "a bad pulse file stops the start"; `deploy/doctor-host.test.mjs` — "names pulse.txt when it is missing or bad, with the other problems" |
| UP-AC-18 | `web/circle-chat-page.test.mjs` — "each circle has its own thread, kept while moving between screens, and forgotten on sign-out"; `web/circle-chat-page.test.mjs` — "signing out forgets every thread, even for the next person on the same page, and drops an answer still on its way"; `web/circle-chat-page.test.mjs` — "a late answer for one circle never shows on another" |

Checked by hand in Chrome on the real service (T-248, and T-256 for the circle screens: the circle link first in the navigation, a Circle screen with its name shown as text, Send recorded against the circle, the Pulse reading one note with its source, an observer's disabled box and working Pulse, no overflow and no cookie visible to script): the notice before sending, recording and replacing, a question, a hostile display name shown as text, Settings, sign-out clearing the thread, no cookie or storage visible to script, no horizontal overflow. Not checked by eye: a true phone-width window, typing and the keyboard path through the forms (they were submitted by script), a screen reader, and the real model.

### Residual risks (not covered, with the reason)

1. **No preview and no Undo**: an automatic replacement can be wrong and the person finds out only from the thread; the back office's change log is the recovery.
2. **The chat forgets everything on reload**, which may feel wrong; it is deliberate while the interface is an experiment.
3. **Not installable yet**: no manifest, icon or HTTPS.
4. **Ask on Home reads every brain the person can read**, as the service does; a circle's Pulse reads only that circle, and there is no free per-circle question.
5. **The model's choice of facts is not shown before saving**; a mis-split note is recorded as is.
6. **Two pages share one cookie and one origin**: a flaw in either is a flaw in both.
7. **Looked at by eye in one browser only**, with the demo model: no true phone-width window, no screen reader, forms driven by script; the page tests cover the same handlers.
8. **A circle's thread is lost when its right or its name changes**, so the words and buttons follow the service; a person who is promoted or demoted starts a fresh thread.
9. **The thread shows facts in the model's own words**, which are the stored title and summary, so an odd split is visible only after it is saved.
10. **The Pulse text is one text for every circle and every person**, changed only by whoever can change the file on the server (the operator); it is not per circle or per person.
11. **The circle list is as old as the last screen change**: a person removed mid-screen sees the screen until the next change, and the service refuses what they try meanwhile.
