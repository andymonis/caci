# Controllable LLM Communication — Specification

Oct 13, 2026 · @Andy

**Status: being built as K1 (T-195 to T-204).** This is the owner's backlog item of 2026-10-13, and a feeder for the "Test the Brain and the LLM at scale" story: to compare quality before and after a change, the words and limits that steer the model must be changeable without changing code.

## Overview

Every message CaCi sends to a language model is made of **exactly three parts**, kept separate and maintained independently:

1. **The request**: what the person typed, or the system action being performed (a note to file, a status to make).
2. **The context**: the combined brain context for that request (the categories of a graph; the numbered entries a person can read).
3. **The controls**: the instructions, guardrails and definitions that steer the exchange (the model's role, the rules, the format asked for, how untrusted text is treated, the limits).

Parts 1 and 2 are data and come from the person and their brains. **Part 3 is static text kept outside the code**, in a `controls/` folder of the repository, read once when the service starts, so it can be adjusted and maintained on its own (and tried on its own with the evaluation tools) without touching TypeScript.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** every LLM message has the three parts above, and the controls are **static text outside the code**. | The owner's brief. |
| D2 | **Owner:** the controls live in **a folder of text files in the repository** (`controls/`), versioned in git and deployed by the normal update. | Reviewable, diffable, rolls back with a deploy. |
| D3 | **Owner:** controls are **wording plus tunable limits in a settings file**. The reply's shape, the guard's checks and the escaping stay in code; the schema and the guard are **generated from the settings numbers**, so the prompt, the schema and the guard cannot disagree. | A text file must not be able to weaken a safety check. |
| D4 | **Owner:** a bad controls file **stops the start**, naming the file and the problem; there is no fallback to built-in text. | One source of truth; a typo must not silently change behaviour. |
| D5 | **Owner:** **no versioning** of controls for now (git history is the record). | Keep it simple. |
| D6 | Layout: `controls/<capability>/system.txt` (the trusted instructions), `frame.txt` (the fixed words around parts 1 and 2 in the user message) and `settings.json` (limits and the descriptions placed in the reply schema), for `categorise` and `status`. Exactly these six files; nothing else in the folder is read. | Small, explicit, like the web files. |
| D7 | **Templates use named slots only**: `{{name}}` with a letter first and letters and digits after. No logic, no loops, no includes. A file may only use the slots its capability declares; **required slots must appear** (below); an unknown slot, a stray `{{` or `}}`, an empty file, a file over 16,000 characters or one with control characters (except line breaks) is an error. | Simple to read and to validate. |
| D8 | **Slot values come from code, never from text a person wrote into the request or the context, and a value is never re-read for slots** (a note id containing `{{count}}` stays literal). The request and the context are placed only through the block slots, escaped as today. | The trust rule: parts 1 and 2 can never alter part 3. |
| D9 | **Slots.** `categorise/system.txt`: `itemId` (required), `maxOps`, `allowedOps`. `categorise/frame.txt`: `contextBlock` and `requestBlock`, **both required, once each**. `status/system.txt`: `entryCount`, `now`, `maxHeadline`, `maxPoints`, `maxPointChars`, `maxRefs`. `status/frame.txt`: `entriesBlock` and `requestBlock`, **both required, once each**. A block slot is filled by code with the delimiters (`<note>`, `<categories>`, `<entries>`, `<request>`) and the escaped text. | The delimiters and escaping are the security mechanism, so code owns them; the words around them are controls. |
| D10 | **Settings** are validated: known keys only, whole numbers within the ranges below, text descriptions of 1 to 300 characters with no control characters, and **consistency rules** the guard needs (below). | A limit that cannot be met would make every reply fail. |
| D11 | **Per-call options** (`maxOps`, `maxRequestChars` and the like) still override the settings for one call, as today; the settings are the defaults. | Existing tests and tools keep working. |
| D12 | **The limits the controller enforces for the API** (a note up to 8,000 characters, a status request up to 500) **stay in code**: they are product limits. The service checks at start-up that the controls' request limits are **at least** those numbers, and refuses to start otherwise. | Otherwise a valid request would fail inside the LLM component. |
| D13 | **`createLlm` requires the controls** (`createLlm({ client, controls })`): there is no in-code fallback text. | D4. |
| D14 | **The demo model stops reading prompt wording.** The request carries a small machine-readable `meta` (which capability; for `categorise` the item id; for `status` the entry count, the time and the zone) that is **never sent to a real provider**; the demo reads it, and the delimited blocks, so a controls folder with completely different wording works with it. | Otherwise editing the words would break the free default mode. |
| D15 | **The three parts are visible**: the `prompt` trace event carries them separately (`controls`, `request`, `context`) and the LLM lab shows them in three panels. | You cannot maintain what you cannot see. |
| D16 | **Try a change without deploying it**: `npm run eval -- --controls DIR` and the lab take a candidate folder, validate it with the same code and run the same sets against it; results record the folder path. | The feeder for the Test the Brain story. |
| D17 | Out of scope: versioning or hashing of controls, editing controls through the app, controls per user or circle, changing the guard's checks by text, the **wording the context builders generate** (the header line and the "not shown" note of the categoriser's category list), which stays in code as part of building part 2 (a residual risk), and **the repair turn**: when the guard rejects a reply, the second call carries the first message, the rejected reply and the guard's own numbered reasons followed by one fixed closing line ("Reply again with the corrected JSON object only."). Those are written by code, not by a person's text; a test pins their exact shape (a residual risk). | Keep the first version small. |

## Goals and non-goals

Goals: change the model's instructions and limits by editing text files; see exactly what was sent as three parts; prove (by test) that no wording is hidden in code and that a person's text cannot change the controls; compare two controls folders on the same evaluation sets; refuse to run on a broken file.

Non-goals: a controls editor, hot reload (a restart or a deploy applies a change), per-account controls, a way to disable the guard, a plug-in system.

## Definitions

- **Part 1, the request**: the person's text or the action's input (the note, the status request).
- **Part 2, the context**: what code reads from the brains for the request, built as today and placed in the user message inside its block.
- **Part 3, the controls**: the text files above and the numbers in `settings.json`.
- **Slot**: a `{{name}}` in a template that code fills.

## Settings

`categorise/settings.json` (all required; shipped values in brackets): `maxOps` 1 to 100 [25]; `maxTextChars` 1 to 100,000 [8000]; `maxContextChars` 1 to 100,000 [12000]; `maxDataBytes` 64 to 65,536 [2048]; `maxIdLength` 8 to 256 [128]; `maxOutputChars` 1,000 to 200,000 [32000]; `maxRationaleChars` 1 to 2,000 [500]; `titleMaxChars` 1 to 500 [120]; `summaryMaxChars` 1 to 1,000 [300]; `categoryNameMaxChars` 1 to 200 [60]; `descriptions` with `title`, `summary` and `name` [the three sentences used today].

`status/settings.json`: `maxHeadline` 1 to 500 [160]; `maxPoints` 1 to 20 [5]; `maxPointChars` 1 to 1,000 [240]; `maxRefs` 1 to 20 [5]; `maxRequestChars` 1 to 5,000 [500]; `maxEntries` 1 to 2,000 [500]; `maxEntryChars` 1 to 10,000 [1500]; `maxTotalChars` 1 to 200,000 [30000]; `maxOutputChars` 500 to 100,000 [8000]; `descriptions` with `headline`, `pointText`, `refs` and `nothing` [today's sentences].

Consistency: for `categorise`, `4 * (titleMaxChars + summaryMaxChars) + 64 <= maxDataBytes` and `categoryNameMaxChars * 4 + 32 <= maxDataBytes`; for `status`, `maxHeadline + maxPoints * (maxPointChars + 12 * maxRefs + 30) + 100 <= maxOutputChars` and `maxEntryChars <= maxTotalChars`. `maxRefs` must be at most the largest entry count the schema allows (`maxEntries`).

## Functional requirements

| ID | Requirement |
|----|-------------|
| CL-FR-01 | Every request to a model client is built from exactly the three parts: the system message is the rendered `system.txt`; the user message is the rendered `frame.txt` with the request and the context in their blocks; nothing else is sent. |
| CL-FR-02 | The shipped `controls/` files, loaded by the new mechanism, produce **byte-identical** prompts, user messages and schemas to the ones the code produced before (the golden files do not change). |
| CL-FR-03 | The controls model parses the six files and reports **every** problem at once, each naming the file (and the line where there is one). |
| CL-FR-04 | A slot value is inserted literally and never re-read: text containing `{{...}}` in a note, entry, circle name or id stays text. |
| CL-FR-05 | The output schema and the guard are generated from the same settings as the prompt; changing a limit moves all three together. |
| CL-FR-06 | The service loads the controls before anything else is made; a missing or bad file stops the start naming the file and leaves no data folder behind. |
| CL-FR-07 | The loader reads exactly the six files (plain names, ordinary files only, size cap, UTF-8) and never anything else in the folder. |
| CL-FR-08 | `createLlm` requires the controls; the demo model works with any valid controls folder. |
| CL-FR-09 | The `prompt` trace event carries the three parts separately and the lab shows them. |
| CL-FR-10 | `--controls DIR` runs the evaluation and the lab against a candidate folder after validating it, and records the path. |
| CL-FR-11 | `npm run doctor` reports whether the controls load. |
| CL-FR-12 | The service refuses to start if the controls' request limits are lower than the controller's API limits (D12). |

## Non-functional requirements

CL-NFR-01 no new dependency; CL-NFR-02 the controls model is pure (no files, no environment); CL-NFR-03 rendering is deterministic and fast (no measurable cost per call); CL-NFR-04 nothing in a controls file can reach the guard's checks; CL-NFR-05 error messages never repeat file contents beyond a short quoted token; CL-NFR-06 the controls folder is never served over HTTP.

## Threats and controls

| Threat | Control | Covered by |
|--------|---------|------------|
| A bad edit (a typo in a slot, a deleted required slot, an empty file) changes behaviour silently | Strict validation, every problem listed, the service refuses to start, the doctor and the eval tools run the same check. | `src/llm/controls/controls.test.ts` — "reports every problem across all six files at once, each naming its file"; `src/llm/controls/controls.test.ts` — "the required slot of each template is enforced"; `src/service/controls.test.ts` — "a bad file stops the start, names the file and the problem, and leaves no data folder behind"; `deploy/doctor.test.mjs` — "a bad file fails the doctor, names the problems and says how to undo a bad edit"; `dev/eval/controls.test.mjs` — "every problem listed, exit 2, nothing printed, saved or created" |
| A person's text (a note, a request, a circle name) alters the controls through a slot | Slot values are inserted once and never re-read; request and context only enter through escaped block slots. | `src/llm/controls/template.test.ts` — "inserts a value as it is and never reads it for slots"; `src/llm/capabilities/categorise/controls.test.ts` — "text that looks like a slot stays text and changes nothing"; `src/llm/capabilities/status/controls.test.ts` — "text that looks like a slot, in the request, an entry or a circle name, stays text and changes nothing"; `src/llm/capabilities/categorise/controls.test.ts` — "the request and the context are placed only in their blocks, escaped, wherever the frame puts them" |
| A controls edit weakens the guard (a huge limit, a missing citation rule) | The guard and schema are generated from validated numbers within fixed ranges; the guard's checks cannot be switched off by text; a rule removed from the wording still meets the guard (the eval shows it). | `src/llm/capabilities/categorise/controls.test.ts` — "the guard enforces the same operation limit"; `src/llm/capabilities/status/controls.test.ts` — "the guard enforces the same headline, point, text and reference limits"; `src/llm/controls/settings.test.ts` — "checks the data size can hold the allowed title, summary and name"; `src/llm/controls/settings.test.ts` — "the reply limit must hold the longest reply the other limits allow" |
| The prompt, schema and guard disagree after an edit | All three are built from one settings object; consistency rules are validated. | `src/llm/capabilities/categorise/controls.test.ts` — "the prompt and the schema carry the new numbers and descriptions"; `src/llm/capabilities/status/controls.test.ts` — "the prompt and the schema carry the new numbers and descriptions"; `src/llm/capabilities/status/controls.test.ts` — "the whole call enforces the point limit from the controls"; `src/llm/capabilities/categorise/controls.test.ts` — "the note and context size limits follow the settings, and a per-call option still wins" |
| The folder is read from outside the intended place (links, odd names) | Exactly six plain names, `lstat`, size cap, nothing else read; never served. | `src/service/controls-files.test.ts` — "never reads or returns anything that is not one of the six files"; `src/service/controls-files.test.ts` — "a link or a folder in place of a file is refused"; `src/service/controls-files.test.ts` — "a link in place of a sub folder is refused, and a link to the folder itself too"; `src/service/web-app.test.ts` — "no controls file is ever served, at any path" |
| Wording is hidden in code so the controls do not really control | A test with sentinel controls proves the system message is made only of the controls and code's slot values; a scan test finds any other text sent to a model. | `src/llm/parts.test.ts` — "the trace gives the three parts separately, as frozen copies, and they add up to what was sent"; `src/llm/parts.test.ts` — "changing only the request changes only the request part"; `src/llm/parts-scan.test.ts` — "are the two capabilities: no other production file calls a model client"; `src/llm/parts-scan.test.ts` — "appears in any production source file" |
| The demo model breaks when the wording changes | It reads machine-readable `meta` and blocks, never wording; tested with a rewritten folder. | `src/llm/demo-controls.test.ts` — "files a note exactly as it does with the shipped controls"; `src/llm/demo-controls.test.ts` — "makes the same status, with the same day, count and points"; `src/llm/demo-controls.test.ts` — "the request really carried the rewritten words, and the facts as meta" |

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| CL-AC-01 | Given the shipped folder, when prompts are built, then they equal the previous golden files byte for byte. |
| CL-AC-02 | Given a file with an unknown slot, a missing required slot, a stray brace, an empty file or an oversized file, when the controls are parsed, then every problem is listed with its file. |
| CL-AC-03 | Given a note whose text is `{{itemId}}`, when the prompt is built, then the text appears literally and the item id slot is unchanged. |
| CL-AC-04 | Given a changed limit in settings, when the prompt, schema and guard are built, then all three follow it. |
| CL-AC-05 | Given a controls folder with different wording, when a note is filed and a status made with the demo model, then both work. |
| CL-AC-06 | Given a bad controls file, when the service starts, then it refuses, names the file and creates no data folder. |
| CL-AC-07 | Given a valid edited folder, when a status is made through the stand-in provider, then the provider's request contains the edited rule. |
| CL-AC-08 | Given sentinel controls, when a request is built, then the system message contains only the sentinel text and slot values. |
| CL-AC-09 | Given `--controls DIR` with a bad folder, when the eval is run, then it stops before any call and lists the problems. |
| CL-AC-10 | Given a folder whose request limit is lower than the API's, when the service starts, then it refuses. |
| CL-AC-11 | Given the trace of a call, when it is read, then the three parts are separate and the lab shows three panels. |
| CL-AC-12 | Given the controls folder, when the web app is requested at any path, then no controls file is ever served. |

### Where each criterion is checked (T-204)

| ID | Tests |
|----|-------|
| CL-AC-01 | `src/llm/capabilities/categorise/prompt.test.ts` — "the system prompt"; `src/llm/capabilities/categorise/prompt.test.ts` — "the user message"; `src/llm/capabilities/categorise/prompt.test.ts` — "the output schema"; `src/llm/capabilities/status/prompt.test.ts` — "the output schema" |
| CL-AC-02 | `src/llm/controls/controls.test.ts` — "reports every problem across all six files at once, each naming its file"; `src/llm/controls/template.test.ts` — "lists every problem at once"; `src/llm/controls/template.test.ts` — "refuses an unknown slot, naming it, the line and what is allowed"; `src/llm/controls/template.test.ts` — "refuses a stray brace pair, with its line" |
| CL-AC-03 | `src/llm/capabilities/categorise/controls.test.ts` — "text that looks like a slot stays text and changes nothing"; `src/llm/controls/template.test.ts` — "inserts a value as it is and never reads it for slots" |
| CL-AC-04 | `src/llm/capabilities/categorise/controls.test.ts` — "the prompt and the schema carry the new numbers and descriptions"; `src/llm/capabilities/categorise/controls.test.ts` — "the guard enforces the same operation limit"; `src/llm/capabilities/status/controls.test.ts` — "the prompt and the schema carry the new numbers and descriptions"; `src/llm/capabilities/status/controls.test.ts` — "the whole call enforces the point limit from the controls" |
| CL-AC-05 | `src/llm/demo-controls.test.ts` — "files a note exactly as it does with the shipped controls"; `src/llm/demo-controls.test.ts` — "makes the same status, with the same day, count and points"; `src/llm/demo-controls.test.ts` — "the request really carried the rewritten words, and the facts as meta" |
| CL-AC-06 | `src/service/controls.test.ts` — "a bad file stops the start, names the file and the problem, and leaves no data folder behind"; `src/service/controls.test.ts` — "a missing folder or file is named" |
| CL-AC-07 | `src/service/controls.test.ts` — "a status request and a note both carry the edited rule and frame, and the limits the edit set" |
| CL-AC-08 | `src/llm/parts.test.ts` — "changing only the request changes only the request part"; `src/llm/parts-scan.test.ts` — "are the two capabilities: no other production file calls a model client"; `src/llm/parts-scan.test.ts` — "appears in any production source file" |
| CL-AC-09 | `dev/eval/controls.test.mjs` — "every problem listed, exit 2, nothing printed, saved or created"; `dev/eval/controls.test.mjs` — "a changed limit shows up in the results" |
| CL-AC-10 | `src/service/controls.test.ts` — "the controls must allow at least what the API accepts" |
| CL-AC-11 | `src/llm/parts.test.ts` — "the trace gives the three parts separately, as frozen copies, and they add up to what was sent"; `dev/llm-lab/view.test.mjs` — "the page shows the three parts of a message in three labelled panels, in order, as text" |
| CL-AC-12 | `src/service/web-app.test.ts` — "no controls file is ever served, at any path"; `dev/not-published.test.mjs` — "the LLM controls are published as exactly their six files" |

### Residual risks (not covered, with the reason)

1. **A person who can edit the repository can change what the model is told**, within the guard's checks. The folder is reviewed like code (git); nothing stops a wrong but valid edit.
2. **The words the context builders generate** (the categoriser's header and "not shown" note) are still in code (D17).
3. **A rule weakened in wording** (for example removing "cite your sources") is caught by the guard's format checks but not by meaning; the evaluation sets are the safety net, and only a real-model run can compare wording.
4. **A change applies only after a restart or a deploy**; there is no hot reload.
5. **No versioning**: a run's results record only the folder path, not the content used, so a folder edited after a run cannot be told from the version that ran.
6. **The repair turn's closing line and the guard's reasons are code-written text** sent to the model (D17); they carry no text from the request or the context other than what the guard quotes from the rejected reply's own fields.
7. **Stand-ins that do not read the controls**: the explorer's own demo model still reads the shipped wording of the categoriser's prompt, so an edited folder would break the explorer's demo (not the service's).
