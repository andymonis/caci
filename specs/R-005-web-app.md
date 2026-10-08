# Web App (first slice) — Specification

Oct 8, 2026 · @Andy

## Overview

The web app is the first screen people see. This first slice does **three things and nothing else**: a person can **register**, **sign in** (and out), and then **visit a temporary holding home page** that proves they are signed in. It does not yet capture notes, browse a brain, or use circles; those are separate, later pieces (see the PLAN Backlog, items 6 to 9).

It is plain HTML, CSS and JavaScript with **no build step and no dependency**, the same way the local development tools are written. It is served by the service itself, from the same address as the API, so the session cookie (`HttpOnly`, `SameSite=Strict`) and the API's refusal of cross-origin writes work as designed and there is no CORS. It uses only routes that already exist: `POST /api/register`, `POST /api/login`, `POST /api/logout` and `GET /api/me` (R-002).

It is a plain web app first: **no manifest, no service worker and no offline behaviour** in this slice (Backlog item 9).

## Decisions (owner, 2026-10-08, and proposals marked)

| # | Decision | Why |
|---|----------|-----|
| D1 | Scope is **register, sign in, sign out and a temporary holding home page**; nothing else | Owner's answer: keep the first slice small |
| D2 | **Plain HTML, CSS and JavaScript, no build step, no dependency** | Owner's answer. Nothing to compile or bundle, nothing new to trust, and the files the browser runs are the files in the repository |
| D3 | **A plain web app first**: no manifest, service worker or offline behaviour | Owner's answer. Installability and caching bring their own risks (what is cached, for how long); they get their own piece (Backlog item 9) |
| D4 | **Proposed:** the app is **served by the same service on the same origin**, at `/` | The cookie is `SameSite=Strict` and the API refuses cross-origin writes on purpose; a separate host would need CORS, which the service deliberately does not have |
| D5 | **Proposed:** the source lives in **`web/`** at the repository root, is part of the package, and is served from a **fixed list of files read at start** | There is no "serve this folder": nothing outside the list can be reached, so there is no path to traverse, and a missing file stops the start |
| D6 | **Proposed:** pages carry a **strict Content-Security-Policy**: scripts and styles from the same origin only, no inline code, no framing, no external resources, connections to the same origin only; API answers keep `default-src 'none'` | If a script is ever injected, the browser refuses to run it; the policy is the second line of defence behind building the page from text |
| D7 | **Proposed:** the page builds its elements with `textContent` and attributes only; **nothing the server says is ever parsed as HTML**, enforced by a test that fails on `innerHTML` and its relatives | A display name is chosen by a stranger and shown to others one day; it must never be markup |
| D8 | **Proposed:** the **password lives only in the form field and in the one request**; it is not kept in storage, a URL, a log or a variable beyond the request, and the fields are cleared after use | The least that can be leaked is nothing |
| D9 | **Proposed:** the page **never sees the session token** (an `HttpOnly` cookie) and uses **no browser storage at all** (no `localStorage`, `sessionStorage`, `indexedDB` or `document.cookie`); whether you are signed in is asked of `GET /api/me` | Nothing for a script to steal or for a shared computer to keep |
| D10 | **Proposed:** after registering, the page **signs the person in** with the same values | Registration alone leaves no cookie (R-002); asking someone to type it all again is friction for no safety |
| D11 | **Proposed:** the register form says plainly that **the first account created on an installation becomes the administrator** | It is true (R-002), and a surprise there is a real harm |
| D12 | **Proposed:** the holding page is **clearly marked temporary** and shows only the person's **display name and username**, with a sign-out button | It proves the sign-in worked without inventing features, and shows nothing about anyone else |
| D13 | **Proposed:** the app is one page at `/`; its screens are states of that page, not separate addresses | Fewer files to serve and nothing for a link to expose; deep links are not needed for three screens |

D1 to D3 are the owner's answers; D4 to D13 are proposals that stand unless changed.

## Goals and non-goals

**Goals**

1. A person with no account can register from the page, and is then signed in and sees the holding page.
2. A person with an account can sign in, stay signed in across a reload, and sign out.
3. Every message the person sees is one they can act on, and none of them reveals more than the API already does.
4. Nothing the server or another person wrote can run as code in the page.
5. It works with a keyboard, a screen reader, a phone-width window, and in light and dark.

**Non-goals (this slice)**: notes, categories, circles, invitations, account editing, password change, account deletion, administrator screens, email, an installable app, a service worker, offline use, translations, analytics of any kind, and a build chain.

## Definitions

- **Page**: the single HTML document served at `/`.
- **Screen**: what the page shows in one state: *signed out* (a register form and a sign-in form), or *signed in* (the holding page).
- **Signed in**: `GET /api/me` answered 200 for the cookie the browser holds. The page never reads the cookie.

## Functional requirements

| ID | Requirement |
|----|-------------|
| WA-FR-01 | **The page**: `GET /` serves the page; its scripts and style sheet are served from the same origin, from a fixed list of files, and nothing else is served. |
| WA-FR-02 | **Starting up**: the page shows a loading state, asks `GET /api/me`, then shows the signed-in screen (200) or the signed-out screen (401). A network failure shows "cannot reach the service" and a way to try again. |
| WA-FR-03 | **Register**: a form with username, display name, optional email and password, and the administrator note (D11). Early checks for the rules a person can see (username 3 to 32 characters of `a-z 0-9 . _ -`, password 12 to 128 characters) give feedback only; **the server stays the authority** and its message is shown for anything else. On success the page signs the person in (D10). |
| WA-FR-04 | **Sign in**: username and password. A wrong pair is the one message the API gives for both cases. Being held back after too many tries is shown with the wait. |
| WA-FR-05 | **Sign out**: `POST /api/logout`, then the signed-out screen. It works even if the session had already ended. |
| WA-FR-06 | **Holding page**: "this is a temporary home page", the display name and the username, and a sign-out button. Nothing else. |
| WA-FR-07 | **Closed registration**: when the service has registration switched off (`403`), the register form says so and offers sign-in. |
| WA-FR-08 | **Errors are shown as text, next to the field they are about** where the API names a field, and in one place for the form otherwise; the first error gets the focus. |
| WA-FR-09 | **A form being sent cannot be sent twice**: the buttons are disabled while a request is in flight. |
| WA-FR-10 | **Without JavaScript** the page says that it needs it. |

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| WA-NFR-01 | **Content-Security-Policy** on every page and asset: `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, `connect-src 'self'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`; plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (the API's own rules for every reply). |
| WA-NFR-02 | **No inline code or style, no external reference**, no `eval`-like call, no string timers; enforced by tests on the files. |
| WA-NFR-03 | **Text-only DOM**: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `DOMParser`; enforced by tests. |
| WA-NFR-04 | **No browser storage and no cookie access** from script. |
| WA-NFR-05 | **Accessible by default**: every field has a visible label, the right `autocomplete` value (`username`, `new-password`, `current-password`), errors are announced politely, focus is managed, controls can be reached and used by keyboard, contrast is adequate in both themes. |
| WA-NFR-06 | **Responsive and themed**: usable from 320 px wide; follows the system light or dark setting. |
| WA-NFR-07 | **No dependency and no build**: the files in `web/` are what the browser gets. |
| WA-NFR-08 | **Nothing is requested from anywhere else**: no fonts, scripts, images or beacons from other origins. |

## Threats and controls

Each row gets, in T-115, the test that covers it.

| Threat | Control |
|--------|---------|
| Script injection through text the server returns (a display name, an error message) | Elements are built with `textContent` only (D7, WA-NFR-03); a strict CSP stops anything that gets through (D6) |
| The page framed by another site to trick a click (clickjacking) | `frame-ancestors 'none'` (WA-NFR-01) |
| The password or session kept somewhere it can be read later | No storage, no cookie access, the token is `HttpOnly` (D8, D9, WA-NFR-04) |
| Personal data cached by a browser or proxy | `Cache-Control: no-store` on every reply (WA-NFR-01) |
| Reaching files that are not part of the app | A fixed list of files, no directory serving (D5, WA-FR-01) |
| Use of the API from another site | Unchanged: same-origin only, `Origin` checked, `SameSite=Strict`, no CORS (R-002) |
| A hostile or broken `web/` file (for example an inline script added by mistake) | Tests fail on inline code, off-origin references and unlisted ids (WA-NFR-02) |
| Someone registering as administrator by surprise | The administrator note on the form (D11, WA-FR-03) |
| A password manager or browser filling the wrong field | Correct `autocomplete` values and field names (WA-NFR-05) |

## What the person is told

| Situation | What the page shows |
|-----------|---------------------|
| `422` with a field | The message from the API next to that field |
| `422` without a field | The message at the top of the form |
| `409` on register | "That username is taken" (the API's words) |
| `401` on sign-in | The API's single "wrong username or password" |
| `403` on register | "Registration is closed on this service" and a sign-in link |
| `429` | "Too many tries: wait N seconds", with `N` from `Retry-After` |
| `500` or any other | "Something went wrong on the service; try again" |
| The service cannot be reached | "Cannot reach the service" and a retry button |

## Files

A fixed list under `web/`, served at the root of the same origin: the page (`/`), a style sheet and a small number of scripts (one for talking to the API, one for the form checks and state, one that builds the screens). The exact names are chosen in T-112 and T-113 and are listed in the service in code, so a file added to the folder is not served until it is listed.

## Acceptance criteria

| ID | Check |
|----|-------|
| WA-AC-01 | `GET /` returns the page with the strict CSP, `nosniff`, `no-store` and the right content type; every listed asset has the right type; anything unlisted is a plain 404. |
| WA-AC-02 | Registering with a new username, display name and password ends on the holding page, signed in. |
| WA-AC-03 | Signing in with the right password shows the holding page; the wrong password shows the API's single message; being held back shows the wait. |
| WA-AC-04 | Reloading the holding page keeps the person signed in; signing out returns to the signed-out screen and the old session no longer works. |
| WA-AC-05 | A display name containing markup is shown as plain text and nothing runs. |
| WA-AC-06 | The scripts use no browser storage and no cookie access, and contain none of the forbidden DOM or code-evaluation calls. |
| WA-AC-07 | The page and its files contain no inline script or style and no reference to another origin; the browser reports no CSP violation. |
| WA-AC-08 | A closed registration, a taken username, a bad password and an unreachable service each show the message in the table above. |
| WA-AC-09 | The page can be used with the keyboard alone, at 320 px wide, and in light and dark. |
| WA-AC-10 | A clean stop of the service after a session of registering and signing in leaves only the two database files. |

## Build order

T-109 this specification and the container diagram; T-110 non-JSON answers in the API kit; T-111 the web file routes; T-112 the client logic; T-113 the pages; T-114 serving it from the service, end to end and a hand check in Chrome; T-115 the security review; T-116 the README.
