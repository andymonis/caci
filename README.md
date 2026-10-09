# caci

A blank, AI-native project scaffold for solo development with Claude Code.

It combines two ideas:

- **Spec Kit-style alignment:** write down the rules (Constitution) and the intent (Spec) before any code.
- **GSD-style execution:** a tight loop of small tasks, each verified and committed on its own.

> Status: the graph store (write, query, graph lifecycle, a memory adapter and a shared conformance suite), the LLM component (categoriser, model tiers, real Anthropic client), the capture controller (propose, preview, approve) and the local dev tools (graph explorer with a capture panel, LLM lab, evaluation harness) are complete, on **in-memory storage**. **SQLite persistence is next** (planned in `.gsd/PLAN.md`; the file adapter is deferred). Stack: TypeScript, Zod, Vitest, ESLint.

## Project layout

```
system_prompt.md        Constitution: how the agent works here (rules, loop, gate, git, boundaries)
spec.md                 Core Spec: what we're building and why
specs/                  Detailed specs (R-001: Bipartite Graph Store library)
architecture/           C4 context and container diagrams (Mermaid)
CLAUDE.md               Loads system_prompt.md and .gsd/STATE.md into every Claude Code session
.gsd/
  PLAN.md               Atomic task queue: milestones, Backlog, Done
  STATE.md              Current position, decisions, blockers
.claude/commands/       Slash commands that drive the loop: /plan /next /verify /ship
src/graph_store/        The Bipartite Graph Store, isolated as one feature (code, tests, adapters)
src/llm/                The LLM component: a model port, typed errors and token usage, and one folder per capability
src/app/                The application layer (controller): input types, normalising, item ids, propose / approve / reject
src/llm/anthropic/      The Anthropic model client (the only user of @anthropic-ai/sdk)
scripts/                Build helpers and the manual llm:try check against the real API
schema/graph_store/     Generated JSON Schema for the mutation and query formats
api/                    Committed public API report (API Extractor)
dev/graph-explorer/     Local-only visual tester for the graph store (never published)
dev/shared/             The loopback server kit every dev tool is built on (never published)
dev/llm-lab/            Local-only lab for trying the LLM component, scripted by default (never published)
dev/eval/               Local-only evaluation harness: compares models on a golden set (never published)
```

### Where the code lives

All graph store functionality sits under `src/graph_store/`, with each test file beside the module it covers. Nothing in that folder imports from elsewhere in the repo. Other platform components get their own sibling folders under `src/`; the first is `src/llm/`, the LLM component. The graph store never imports it, and it reaches the graph store only through its public entry point. `src/app/` is the third sibling: it uses the other two only through their public entry points, and neither knows it exists (`src/boundary.test.ts` enforces all of this). The folder-by-folder breakdown and the test map are in the R-001 spec ("Code layout and test map").

### Order of authority

If files disagree, the higher one wins:

1. `system_prompt.md`
2. `spec.md`
3. `.gsd/STATE.md`
4. `.gsd/PLAN.md`

## The three pieces

### 1. The Constitution (`system_prompt.md`)
Non-negotiable rules for any agent working in the repo: spec first, small steps, simplest thing that works, verify before claiming done, be honest about failures. It also defines the verification gate, the commit convention, and what needs your approval first (new dependencies, deleting files, changing spec goals, anything outward-facing). Agents don't edit it unless asked.

### 2. The Core Spec (`spec.md`)
Sections for purpose, goals, non-goals, users, requirements, constraints, architecture, milestones and open questions. Requirements get ids (`R-001`) and a testable acceptance criterion, so tasks can trace back to them.

### 3. The GSD execution loop
Orient, plan, do, verify, ship, repeat.

| Command | What it does |
|---|---|
| `/plan [section]` | Breaks a spec section into atomic tasks in `PLAN.md`. Asks questions if the spec is vague. Doesn't implement. |
| `/next [task]` | Takes the first unchecked task (or the one you name) and implements only that. Stray ideas go to the Backlog. |
| `/verify` | Runs tests, lint, typecheck and the task's acceptance check. Fixes within scope until green and reports results honestly. |
| `/ship` | Checks off the task, updates `STATE.md`, and makes one conventional commit referencing the task id. Never pushes. |

Task format in `PLAN.md`:

```
- [ ] T-003 (R-002) Add config parser — acceptance: parses sample file, rejects invalid input
```

## Getting started

1. Open the repo in Claude Code from the project root.
2. Read `.gsd/STATE.md` and `.gsd/PLAN.md` to see where the project is.
3. Run `npm install`, then `npm run gate` (typecheck, lint, tests, API check) to confirm a clean start.
4. Run `/plan` when a milestone needs breaking into tasks.
5. Loop: `/next`, then `/verify`, then `/ship`, until the milestone is done.

## Seeing the graph

`npm run dev:explorer` starts a local-only page (http://127.0.0.1:4317) that draws a graph and animates it as entries are added and removed, with scenarios, a log of every request and result, and one-click examples of what the library rejects. It lives in `dev/graph-explorer/` and is never part of a release. See its README.

## Choosing models for the LLM component

Which model does a job is configuration. `src/llm/` has three tiers, `fast` (Haiku 4.5), `balanced` (Sonnet 5.5) and `deep` (Opus 5.5), and routes each capability to a tier or to one exact model id. Categorising starts on `fast`; heavier future capabilities start on `deep`. `createLlmConfig({ tiers, capabilities })` checks what you give (an unknown tier, capability or field, or an empty model id, is a `CONFIG` error that says where) and fills in the rest; `resolveModel` picks the model for a call, with the order: a model chosen for that call, then a tier chosen for that call, then the capability's route. Changing a tier's model changes every capability routed to it. The library never reads environment variables or files: the application and the dev tools do that and pass the result in.

## Testing code that uses a model

`bipartite-graph/llm/testing` has a scripted model client that plays back answers and errors instead of calling a model, so everything built on the `ModelClient` port can be tested without a network or a key:

```ts
import { createScriptedModelClient } from 'bipartite-graph/llm/testing';

const client = createScriptedModelClient([
  { reply: '{"ops":[]}' },        // the provider answers (parsed as JSON if the request asked for JSON)
  { rateLimited: true, retryAfterMs: 500 },
  { refusal: true },
]);
await client.complete(request);
client.requests;   // every request it was asked, frozen copies
client.callCount;  // how many reached the provider
```

It behaves like a careful real client: it checks the request first, honours the time limit and cancellation, and never throws. A real client is held to the same contract with `runModelClientConformance(makeClient, { describe, it })`. The suite cannot make a real provider refuse or hang, so `makeClient` is told which scenario to produce (a text reply, JSON, prose when JSON was asked for, a refusal, a rate limit, a server fault, a rejected request, an unknown model, or a provider that never answers) and returns a client whose provider, usually a mocked HTTP layer, behaves that way. The shared helpers `checkRequest` and `runWithDeadline` do the request checking and the time limit and cancellation for any client.

## Prompts for the categoriser

`src/llm/capabilities/categorise/prompt.ts` builds everything sent to the model for one note: a fixed system prompt, one user message, and an output schema. The note and the category data appear only inside their own `<note>` and `<categories>` blocks, with `&`, `<` and `>` escaped so they cannot close a block or add one. The system prompt never contains user text. The output schema is derived from the graph store's own `mutationJsonSchema()` and narrowed to the operations the categoriser may use (`upsertNode`, `link`), so the format cannot drift. An empty or oversized note is refused, never cut. The exact wording is kept as plain-text golden files in `src/llm/capabilities/categorise/__snapshots__/`, so a change to it shows in review.

## Asking the model to categorise a note

`createLlm({ client, config? })` returns an object with one method per capability, today `categorise()`:

```ts
import { createLlm } from 'bipartite-graph/llm';

const llm = createLlm({ client });           // client: any ModelClient
const result = await llm.categorise(
  { text, graphId: 'my-notes', itemId: 'note-01', categories },   // the controller supplies the ids and the current categories
  { tier: 'balanced', timeoutMs: 20_000, signal },                 // all optional; model or tier can be chosen per call
);
// ok: { mutation, rationale?, usage, model, attempts }   an error: { code, message, retryable }
```

It builds the context and prompt, calls the model, and checks the reply with the output guard. A reply the guard rejects goes back to the model once with the reasons; a second rejection is a `BAD_OUTPUT` error. One time limit covers both attempts, cancellation is honoured, and nothing is written: the result is a proposal for a person to approve and pass to `write`. A bad `graphId`, `itemId` or option is a `CONFIG` error before any model call is paid for.

### Watching a call

Pass `trace` in the options to see what a `categorise` call does, step by step:

```ts
await llm.categorise(input, { trace: (event) => console.log(event.type, event) });
```

Events arrive in order: `prompt` (the instructions, messages and schema as built), then for each attempt `request`, then `response` (the raw output, tokens, answering model, time taken) or `failure`, then `verdict` (accepted, or every problem the output guard found), then `repair` (the feedback sent back) before attempt 2, and always `done` last (`ok`, how many calls were made, total time, and the error if it failed). Events are frozen copies, so changing one affects nothing, and a callback that throws or rejects is ignored: it can never change the result. They hold only what the call itself used, never the API key. This is what the LLM lab (next) shows on screen.

### Trying it: the LLM lab

`npm run dev:lab` opens a local page (http://127.0.0.1:4318, never published) for trying the component: write a note and some existing categories, choose a model (the configured default, a tier, or an exact id) and press Run. It shows what would be approved (the proposal and its plain summary), every attempt with the raw output and what the output guard said about it, the repair feedback, and the exact prompt that was sent, with tokens, latency and the model used. Compare runs the same note over several models side by side, and a history lists earlier runs. It uses a scripted model by default, with ten behaviours to choose from (a good answer, a repaired one, a refusal, a time-out...), so it costs nothing; the real model is used only when an API key was in the environment at start-up and you switch on "Use the real model (uses the network)" for that run. See `dev/llm-lab/README.md`.

### Capturing a note in the explorer

In `npm run dev:explorer`, the **Capture a note** panel proposes a filing for a note and draws it over the graph as dashed nodes and links (ringed categories are ones that already exist and would be reused), with the plain summary beside it. Nothing is written until you press **Approve**; **Reject** throws it away. It uses a free demo model unless you start with `npm run dev:explorer -- --real-model` and `ANTHROPIC_API_KEY` set, and then only for proposals where you tick "use the real model" (which sends the note and category names to Anthropic). See `dev/graph-explorer/README.md`.

### Choosing the model: the evaluation harness

`npm run eval -- --models fast,balanced,deep` runs 15 sample notes through `categorise` on each model and prints pass rate, repairs, latency and tokens side by side, then which cases each model got wrong and why. A model passes a case when it answers, the preview shows no problems, and it reuses the right categories, avoids the wrong ones, does not invent a duplicate and stays within the link and new-category limits. A real run prints its plan and sends nothing until you add `--yes`, because it costs money and sends the notes to Anthropic; `--scripted` checks the harness for free. See `dev/eval/README.md`. A first real run (15 notes, one run per model) found `fast` and `balanced` level at 100% and `deep` at 93%, with `fast` the quickest and cheapest, so `fast` stays the default; it is one small sample, so repeat it (`--repeat 3`) and add harder notes before relying on it.

## Using the real model

`bipartite-graph/llm/anthropic` is a `ModelClient` for the Anthropic Messages API. It is the only part of the package that uses `@anthropic-ai/sdk`, which is an **optional peer dependency**: install it only if you use this entry point (the graph store, the rest of the LLM component and the application work without it, and a test keeps it that way).

```ts
import { createLlm } from 'bipartite-graph/llm';
import { createAnthropicClient, readAnthropicKey } from 'bipartite-graph/llm/anthropic';

const key = readAnthropicKey(process.env);                 // the app reads the environment; the library never does
if (!key.ok) throw new Error(key.error.message);
const llm = createLlm({ client: createAnthropicClient({ apiKey: key.value }) });
```

- **The model comes from each request.** The client has no default model; `createLlm`'s configuration (tiers and routes) chooses it.
- **The key** comes from `ANTHROPIC_API_KEY`, read by your code with `readAnthropicKey(env)` and passed in. It lives in a closure, is never on the client object, and is removed from every error message (the SDK's raw error text is never passed on). The SDK's own environment lookups (token, base URL, credential files) are switched off, so only the key you pass is used.
- **Structured output.** A request with an `outputSchema` asks the provider for JSON in that shape. Providers enforce only part of JSON Schema, so the schema is converted first: types, properties, required, items, `anyOf`/`$defs`/`$ref` and a few formats are kept; everything else (`maxItems`, `maxLength`, `const`, `enum`, ranges) becomes text in the field's `description`, and every object is closed. The output guard is what enforces the full rules. The categoriser's schema gives each kind of node a closed `data` shape (item: `title`, `summary`; category: `name`) for the same reason.
- **Errors** map onto the component's own: a rate limit is `RATE_LIMITED` (with the wait the provider asked for), a time-out is `TIMEOUT`, a refusal is `REFUSED`, a server fault or network failure is a retryable `MODEL_ERROR`, a rejected request is a non-retryable `MODEL_ERROR`, and an unknown model or a refused key is `CONFIG`. The SDK does not retry by default (`maxRetries: 0`), so callers see every failure and decide.
- **Trying it for real.** `ANTHROPIC_API_KEY=... npm run llm:try` (options `--tier`, `--model`, `--text`) sends one sample note and prints the proposal. It is not part of the gate, costs a small amount, and sends the sample to Anthropic.

## The application layer

`src/app/` (entry point `bipartite-graph/app`) is where input meets the graph and the model. So far it holds three small pieces:

- **Input:** `{ kind: 'text', text }`, `{ kind: 'image', mediaType, data }` or `{ kind: 'audio', mediaType, data }`. `parseInput` checks one; unknown kinds and extra fields are `INVALID_INPUT`.
- **Normalising:** `normaliseInput(input, normalisers?)` turns any input into the text the categoriser reads. Only text is handled today (a blank note is `INVALID_INPUT`); images and audio give `UNSUPPORTED_INPUT` until you supply a normaliser, for example `normaliseInput(input, { audio: transcribe })`. A normaliser that throws or returns something that is not text is `NORMALISER_FAILED`, without leaking its message.
- **Item ids:** the graph store never makes ids, so `createItemIdGenerator({ now?, random?, prefix? })` does. Ids look like `note-0m5xk2q9a-00-f3k9d2` (time, a counter for the same millisecond, a random tail): lowercase, safe as a file name, and sorting by id is sorting by creation order, even if the clock steps back. Pass `now` and `random` to make them deterministic in tests.
- **Proposal summary:** `summarise(mutation, existing)` says, before anything is written, what approving a proposal would do: new items, new categories, existing categories reused, the distinct links, and existing nodes that would change. `existing` lists which of the mutation's ids are already in the graph (the controller finds out with `query()`). It reads the operations in the order `write` applies them, so a link to a category that does not exist and is not created *before* it is reported under `problems` (the write would fail: do not approve), while a repeated link or a link from an item that already exists is a `notes` entry. `describeSummary(summary)` renders it as short plain text; odd ids are shown quoted and escaped so a model-chosen id cannot add lines. It is pure, and a test checks its predictions against the real store on 400 random proposals.
- **Propose:** `createController({ adapter, llm, ids?, normalisers?, ttlMs?, maxPending?, maxCategories? })` returns `{ propose, get }`. `propose(graphId, input, options?)` reads the graph's categories with `query()` (up to `maxCategories`, default 500, and reports when it hit the cap), turns the input into text, mints the item id, asks `llm.categorise()`, checks which of the proposal's ids already exist, and returns a frozen pending proposal: `{ id, itemId, note, mutation, rationale?, summary, text, usage, model, attempts, context, createdAt, expiresAt }`. It reads the graph and **writes nothing**; a test with a recording adapter proves it, including on every failure path. The graph is checked first, so a note is never transcribed or sent to a model for a graph that is not there. Errors keep their own type, tagged with where they came from: `{ source: 'app' | 'graph' | 'llm', error }`. Proposals wait 15 minutes by default (`get` returns nothing after `expiresAt`), at most 100 at a time (`TOO_MANY_PENDING` rather than quietly forgetting one). A proposal whose summary has `problems` is still returned, so a person can see why it would fail.
- **Approve and reject:** `approve(proposalId)` applies the held mutation with `write()`, exactly once, and returns `{ proposal, written }`. The proposal is taken out of the store *before* the write starts, so a second or simultaneous approval finds nothing (`PROPOSAL_NOT_FOUND`) and writes nothing. If the write fails (the graph is gone, the store is down, a link no longer has its category) nothing changes, because a mutation is all-or-nothing; the graph store's error comes back and the proposal is put back with its original expiry, so it can be retried or rejected. `reject(proposalId)` discards it without writing. A proposal past `expiresAt` is `PROPOSAL_EXPIRED` for both (recent expired ids are remembered, up to 1,000, so the answer does not depend on whether something swept it away; older ones are `PROPOSAL_NOT_FOUND`). The preview was worked out when the proposal was made, so the graph may have changed since; the write is what decides. A full store refuses a new proposal before the model is asked, so no paid call is wasted.

## Capturing text

Capturing takes a note as text and files it in a graph: **propose, preview, approve**. The model suggests; a person decides; nothing the model produces is written until it is approved.

1. `propose(graphId, { kind: 'text', text })` reads the graph's existing categories, asks the model how to file the note, and checks the answer with the output guard (only `upsertNode` and `link`, the controller's own item id, capped sizes; one repair attempt if it is rejected). It returns a pending proposal and **writes nothing**.
2. The proposal carries a plain summary (new items, new categories, existing categories reused, links) and a list of **problems**, such as a link to a category that does not exist, so a person can see what approving would do and whether it would fail.
3. `approve(id)` applies it in one all-or-nothing write; `reject(id)` throws it away. A proposal waits 15 minutes by default, approving twice writes once, and a write that fails changes nothing and leaves the proposal there to retry or reject.

```ts
import { createGraph } from 'bipartite-graph';
import { createMemoryAdapter } from 'bipartite-graph/adapters/memory';
import { createLlm } from 'bipartite-graph/llm';
import { createAnthropicClient, readAnthropicKey } from 'bipartite-graph/llm/anthropic';
import { createController } from 'bipartite-graph/app';

const adapter = createMemoryAdapter();
await createGraph(adapter, 'notes');

const key = readAnthropicKey(process.env);   // your code reads the environment; the libraries never do
if (!key.ok) throw new Error(key.error.message);
const controller = createController({ adapter, llm: createLlm({ client: createAnthropicClient({ apiKey: key.value }) }) });

const proposal = await controller.propose('notes', { kind: 'text', text: 'Saw Dr Patel about the blood test results.' });
if (!proposal.ok) {
  // proposal.error.source says where it failed: 'app' (the input), 'graph' or 'llm' (the model), each with its own code
} else {
  console.log(proposal.value.text);                 // the plain summary, for a person to read
  await controller.approve(proposal.value.id);      // or controller.reject(proposal.value.id)
}
```

**Trying it without writing code:** the graph explorer's *Capture a note* panel draws a proposal over the graph as dashed nodes and links before you approve it (`npm run dev:explorer`); the LLM lab shows every step of a call (`npm run dev:lab`); the evaluation harness compares models (`npm run eval`). All three use a free scripted or demo model unless you ask for the real one.

### Privacy: what is sent, and what is not protected

With a real model, **the note and the graph's existing categories (their ids and data, up to 500 by default) are sent to Anthropic**, together with the fixed instructions. Nothing else is: not the items' contents, not other notes, and never the API key's value in any message or log. A real call also costs money.

- **Nothing is anonymised or pseudonymised.** Names and any other personal details in a note go to the model as written. Do not describe this as private or anonymised.
- **The proof of concept is for the owner's own data.** Do not capture other people's data with it. Pseudonymising notes before they are sent (a local mapping of names to tokens, restored in the preview) is designed in the plan's Backlog and must be built, and the legal side settled, before anyone else's data is used or the tool is offered to others.
- The model can only *propose* `upsertNode` and `link` operations. It cannot delete, unlink or choose graph ids, and its text is never treated as instructions (it is escaped into its own block of the prompt).
- Keep the key out of the repository: the dev tools read `ANTHROPIC_API_KEY` from the environment (`source ./set-key.sh` loads it from a key file outside the repo).

### Running with a real model

| Where | How | Real calls happen when |
| --- | --- | --- |
| `npm run llm:try` | `ANTHROPIC_API_KEY=... npm run llm:try` | you run it (one sample note) |
| Explorer capture panel | `npm run dev:explorer -- --real-model` with the key set | you tick "use the real model" for a proposal |
| LLM lab | `npm run dev:lab` with the key set | you switch on "Use the real model (uses the network)" for a run |
| Evaluation harness | `npm run eval -- --models fast,balanced,deep --yes` | you add `--yes` (without it, it prints the plan and sends nothing) |

### What is not done yet

- **Pictures and voice** are accepted by the input type but not handled: they return `UNSUPPORTED_INPUT` until normalisers exist (image description, transcription).
- **Link counts** are not passed to the model, so with more than 500 categories it sees the first 500 by id, not the most used.
- **Pending proposals live in memory** and are lost when the process stops.
- **The default model** (`fast`) rests on a small first evaluation; see *Choosing the model: the evaluation harness*.

## Persistence

The memory adapter forgets everything when the process ends. The SQLite adapter keeps a graph store in one file:

```ts
import { createGraphClient } from 'bipartite-graph';
import { createSqliteAdapter } from 'bipartite-graph/adapters/sqlite';

const adapter = createSqliteAdapter({ path: './data/caci.db' }); // created if missing; ':memory:' (the default) keeps nothing
const graphs = createGraphClient(adapter);
// ... write and query as usual ...
await adapter.close(); // always close it when you are done
```

It uses the `node:sqlite` module built into Node, so there is no extra dependency, but it needs **Node 22.13 or later** and Node marks it **experimental**: it prints an `ExperimentalWarning` the first time it loads, and its details may change in a future Node. Only one small file in the library touches it, so moving to another driver later is a contained change. On an older Node, `createSqliteAdapter` throws a `DbError` (`DRIVER_UNAVAILABLE`) that says so.

- **Where the file lives.** Wherever `path` says; the directory must exist. A new file is created readable and writable by its owner only (mode 0600; ignored on Windows). While the adapter is open there are also `-wal` and `-shm` files beside it; a clean `close()` removes them. `data/`, `*.db` and the `-wal`, `-shm` and `-journal` files are git-ignored.
- **A file that is not ours is never changed.** A file that is not a SQLite database, another application's SQLite database, or one written by a newer version of this library is refused with a `DbError` (`NOT_A_DATABASE`, `NOT_A_GRAPH_DATABASE`, `NEWER_SCHEMA`) and left exactly as it was. Older files are upgraded in one transaction.
- **If the process dies.** A transaction is all or nothing: a crash or `kill -9` in the middle of a write leaves the file as it was before that write (tested). With the default setting a *power cut* can lose the last few committed writes but does not damage the file.
- **One process at a time is the intended use.** Several processes (or several adapters) can share one file: they see each other's committed data and take turns to write, and 100 simultaneous updates from two processes lose none (tested). A writer that cannot get the lock within `busyTimeoutMs` (default 5,000) fails with a `DbError` (`BUSY`), which `write()` reports as `STORAGE_ERROR`. Do not open two adapters on one file inside the same process and let both hold transactions open across `await`s: waiting for a lock blocks the whole process.
- **Backup.** Call `close()`, then copy the file. Copying while the adapter is open can miss the newest writes (they may still be in the `-wal` file).
- **The file is not encrypted.** It holds your notes and categories in plain text. Protect it as you would the notes themselves: rely on disk encryption and file permissions. Nothing is anonymised (see *Privacy: what is sent, and what is not protected*).
- **Not for the browser or a network drive.** SQLite needs a local file system that supports locking.

## User accounts and the login API

An optional layer for people who want accounts: each person registers, signs in, and gets **one graph of their own**; nothing they send can choose another. It is specified in `specs/R-002-user-accounts.md`. You run it with `npm run serve`, which starts a small HTTP server (`node:http`, no extra dependency) and keeps its data in two files.

```
CACI_DATA_DIR=./data npm run serve
```

**Register yourself first.** The first account ever created becomes the admin, so on a fresh install register straight away, before anyone else can reach the server. Registration is open to anyone who can reach it (switch it off with `CACI_ALLOW_REGISTRATION=false` once the people you want have accounts).

### Settings

All settings are environment variables. An unknown `CACI_` name, or a bad value, stops the service from starting and names the variable; nothing is silently ignored.

| Variable | Meaning | Default |
|---|---|---|
| `CACI_PORT` | Port to listen on (0 picks a free one) | `8080` |
| `CACI_BIND` | Address to listen on | `127.0.0.1` (this machine only) |
| `CACI_DATA_DIR` | Folder for `graphs.db` and `users.db` (created owner-only) | `./data` |
| `CACI_ALLOW_REGISTRATION` | `true` or `false` | `true` |
| `CACI_COOKIE_SECURE` | Mark the session cookie `Secure` (needs HTTPS) | `false` |
| `CACI_TRUSTED_PROXIES` | Reverse proxies in front, 0 to 5 | `0` |
| `CACI_ALLOWED_HOSTS` | Comma separated host names the server answers to | not set |
| `CACI_ALLOW_INSECURE` | Accept a non-loopback address with plain cookies | `false` |
| `CACI_LLM` | Which model files notes: `demo` or `anthropic` (see [Capturing notes through the API](#capturing-notes-through-the-api)) | `demo` |
| `CACI_PROPOSALS_PER_HOUR` | Proposals one account may start in an hour (1 to 10,000) | `30` |
| `CACI_MAX_PENDING_PER_USER` | Proposals one account may have waiting (1 to 100) | `10` |
| `CACI_MAX_CIRCLES_PER_USER` | Circles one person may be in (1 to 1,000) | `20` |
| `CACI_MAX_MEMBERS_PER_CIRCLE` | People one circle may hold (1 to 1,000) | `50` |
| `CACI_INVITATION_DAYS` | How long an invitation to a circle stays open (1 to 365) | `7` |

Listening on anything but this machine (`CACI_BIND=0.0.0.0`, say) is refused unless `CACI_COOKIE_SECURE=true`, or you also set `CACI_ALLOW_INSECURE=true` to say you accept that session cookies cross the network in the clear.

### The routes

Bodies are JSON (`Content-Type: application/json`, at most 16 KB). The session is an `HttpOnly`, `SameSite=Strict` cookie; **it is the only credential**, so an `Authorization` header or a token in a URL does nothing. Failures are `{ "error": { "code", "message", "field"? } }`: 401 not signed in, 403 not allowed, 404, 409 conflict (a taken username, or the last admin), 422 bad input (with `field`), 429 too many tries (with `Retry-After`).

| Route | What it does |
|---|---|
| `POST /api/register` | `username`, `displayName`, `password`, optional `email`. Creates the account and its graph together |
| `POST /api/login` | `username`, `password`. Sets the cookie and returns the user and their graph id |
| `POST /api/logout` | Ends this session and clears the cookie |
| `GET /api/me` | Who you are, and your graph id |
| `PATCH /api/me` | Change `displayName` and/or `email` (not the username or role) |
| `POST /api/me/password` | `currentPassword`, `newPassword`; ends all your other sessions |
| `DELETE /api/me` | `password`; deletes your account, your graph and your sessions |
| `GET /api/users` | Admin: everyone, by username (`limit`, `cursor`) |
| `GET /api/users/:id` | Admin, or yourself |
| `PATCH /api/users/:id` | Admin: `displayName`, `email`, `role`; yourself: not the role |
| `DELETE /api/users/:id` | Admin: delete someone else's account and graph |
| `POST /api/users/:id/password` | Admin: set someone's password and end their sessions |

Usernames are 3 to 32 of `a-z 0-9 . _ -` (any case is lower-cased). Passwords are 12 to 128 characters, not your username, not a very common one, hashed with scrypt. An unknown user and a wrong password look exactly alike, in the answer and in the work done.

### What protects it, and what does not

- **Too many tries.** After 5 wrong passwords for a username (real or not) the next try waits 1 second, then 2, 4, 8... up to 15 minutes; one address gets 20 tries across all names; registration is limited to 10 an hour per address. The counts are in memory, so a restart forgets them, and someone who knows a username can keep that account waiting by failing on purpose.
- **Other sites.** Every write must come from this site (`Origin` is checked), with a JSON body, and the cookie is `SameSite=Strict`.
- **Email** is only stored as a contact detail: it is never checked, and nothing is ever sent (there is no emailed reset).
- **The files are not encrypted.** `graphs.db` holds your notes and `users.db` your accounts, password hashes and session fingerprints, in plain files readable only by their owner (mode 0600). Rely on disk encryption and keep backups safe. Back up by stopping the service and copying the two files.
- **No HTTPS here.** Put a reverse proxy that speaks HTTPS in front, bind this service to `127.0.0.1`, and set `CACI_COOKIE_SECURE=true`, `CACI_TRUSTED_PROXIES=1` (so the client address is the one the proxy saw) and `CACI_ALLOWED_HOSTS` to the public name.

### Forgotten passwords

There is no emailed reset. An admin resets anyone's password with `POST /api/users/:id/password` (that ends all of that person's sessions). If **no admin** can sign in, run this on the machine that holds the data, with the same `CACI_DATA_DIR` as the service:

```
npm run users -- recover-admin <username>
```

It asks for the new password on the terminal (not shown, typed twice), or reads it from standard input (`echo ... | npm run users -- recover-admin ann`). It never takes the password as an argument, so it is not in your shell history or the process list. It works only for an admin account, ends that account's sessions, and changes nothing else. Being able to run it is the proof of access: whoever can read the data folder can already read everything in it.

## Using the web app

The service also serves a small web app from the same address as the API. It lets you **register**, **sign in and out**, visit a **temporary home page** (your name, your username and how many invitations are waiting for you), and **use circles**: create one, accept or decline an invitation, leave, look at who is in a circle and manage it. **Nothing else is built yet**: the app does not capture notes and does not browse a graph (the API has those; the app does not use them). It is specified in `specs/R-005-web-app.md` (the first slice) and `specs/R-006-web-circles.md` (circles).

### Open it

Run `npm run serve` and open the address it prints (by default `http://127.0.0.1:8080/`). **Register yourself first**: the first account created on a new installation becomes the administrator, and the create-account form says so. After registering you are signed in with the same values and land on the home page; reloading keeps you signed in until you sign out or the session ends, and signing out ends the session on the service as well as in the page.

It is a plain web page, not an installable app: there is no manifest, no service worker and no offline use, so it needs the service to be reachable (it says so, with a button to try again).

### What it is made of

Plain HTML, CSS and JavaScript with **no build step and no dependency**: the files in `web/` are exactly the files the browser gets. The service sends only these sixteen, from a fixed list in `src/service/web-app.ts`, and nothing else in the folder:

| File | Does |
|---|---|
| `index.html` | the page: the sign-in and create-account forms, the home page and the circle screens |
| `style.css` | the look, light and dark by the system setting |
| `app.js` | starts the page |
| `mount.js` | puts the session on the page |
| `view.js` | works out what to show |
| `session.js` | what the page is doing: loading, signed out, signed in |
| `forms.js` | early checks of the forms (the service has the last word) |
| `api-client.js` | the code that talks to the account routes, and the one way every request is sent |
| `circles-client.js` | the code that talks to the circle and invitation routes |
| `router.js` | which screen the address names; anything unknown is the home screen |
| `circle-page.js` | puts one circle's screen on the page: details, the people, and the forms and buttons for the person's role (each destructive step asks first) |
| `circles-pages.js` | puts the circles list, the create form, the invitations and the home page's invitation count on the page (rows cloned from templates, text only) |
| `circles-view.js` | the words behind those screens: titles, row text, the invitation count sentence |
| `circle-session.js` | what one circle's screen shows and does: roster, invitations, managing it, and the two-step questions |
| `circles-session.js` | what the circles list, creating a circle and my invitations show (one request at a time, a count that is only ever a number the service gave) |
| `permissions.js` | what each role may do in a circle, as a hint for which buttons to show |

A file you add to `web/` is not served until you list it, and the tests fail if the list and the folder disagree. Change a file and restart the service to see it.

### What it sends and keeps

- It talks only to the account routes on the same address (`POST /api/register`, `POST /api/login`, `POST /api/logout` and `GET /api/me`) and to the fifteen circle and invitation routes listed under **Circles**. Nothing goes anywhere else, and nothing is loaded from anywhere else (no fonts, scripts or images from other sites).
- It keeps **nothing in the browser**: no local or session storage (circle data lives in memory while the page is open and is dropped when you leave a screen or sign out), and it never reads the session cookie, which the browser holds and the page cannot see (`HttpOnly`). The password lives only in the form field and the one request, and the fields are emptied once it is used.
- Everything the service says (your name, an error message) is shown **as text, never as markup**.

### Circles in the web app

The screens have addresses, so the back and forward buttons, a reload and a copied address all work. Anything that is not exactly one of these is the home screen, and an id in an address must have the exact shape the service makes before it can be used in a request.

| Address | Screen |
|---|---|
| `#/` | home: your name and username, the invitation count with a Refresh button, links, and Sign out |
| `#/circles` | your circles with your role and how many people are in each, "Show more", and the form to make a circle |
| `#/circles/<id>` | one circle: details, your role, the people, and what your role lets you do |
| `#/invitations` | the invitations addressed to you, each with Accept and Decline |

On every change of screen the main heading takes the focus and the tab title follows. If you are signed out, the address is kept and applies after you sign in.

What each role is shown, in plain words beside the choices (the same words as the page):

| Role | Words |
|---|---|
| `owner` | Everything: rename and delete the circle, invite and remove anyone, give anyone any role, including owner. |
| `manager` | Invite and remove members and observers, and move people between those two. Never touches an owner or another manager. |
| `member` | See the circle and who is in it, and leave. |
| `observer` | The same as a member for now. |

The buttons follow the role as a **hint**: the page shows only what your role allows (nothing beside your own row, a manager only on members and observers, members and observers only a way to leave), and a test checks the page's table against the service's own over every combination. The **service decides**: if a refusal arrives anyway, the page shows the service's own words and reloads the view.

**Leaving, deleting a circle and removing someone ask first**, in the page, with a confirm and a cancel (never a browser dialog); cancelling changes nothing. After inviting, the page says only that the invitation was recorded for that username; it never says whether such an account exists. A circle that is not yours and one that does not exist read the same: "No such circle, or you are not in it."

What the web app does **not** do with circles: circles share no data yet, and everyone in a circle sees everyone's username and display name (the pages say so); nobody is notified of an invitation, so you find out by looking; the invitation count is fetched when the home page opens and when you press Refresh, and **nothing is live** (a view is as old as its last load, and every action reloads what it changed); two tabs do not know about each other.

### The policy on every page

Every page and file is sent with this Content-Security-Policy, so the browser refuses any script or style that is not one of the files above, any request to another address, and any framing of the page:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

They also carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. API answers stay JSON and keep `default-src 'none'`.

**Behind a reverse proxy**: pass the service's headers through unchanged (a proxy that adds or replaces `Content-Security-Policy` can stop the page working or weaken it), and send the page and `/api/` to the same address, because the session cookie is `SameSite=Strict` and cross-origin writes are refused on purpose (there is no CORS). The service has no HTTPS of its own: see **User accounts and the login API** for the proxy recipe and `Secure` cookies.

### Browsers and limits

It needs a current browser (ES modules and `fetch`). It works with the keyboard alone, at phone width and in light and dark, but it was only looked at by hand in one browser, and nothing here was tried with a screen reader. The form checks are early feedback only, and a password manager may behave differently from one browser to the next.

## Capturing notes through the API

Once signed in (see above), a person can file a note and browse their own graph over HTTP. It is specified in `specs/R-003-caci-controller.md`. The flow is **propose, preview, approve**: a note is sent to a model, which suggests how to file it; **nothing is written until the person approves**. The same session cookie is used, the graph is always the signed-in person's own (no request can name another), and an administrator has no access to other people's graphs through these routes.

### Which model files the notes

- **`demo` (the default).** A small built-in stand-in that files by matching words. It is free, it is not a classifier, and **nothing leaves this machine**.
- **`anthropic`.** Set `CACI_LLM=anthropic` and put your key in the environment as `ANTHROPIC_API_KEY`. It applies to **every account at once**. Then **every account's notes, and the names of that account's existing categories, are sent to Anthropic, and nothing is anonymised or pseudonymised.** There is no per-account consent. Use it only when everyone with an account accepts that. Without a valid key the service refuses to start, naming `ANTHROPIC_API_KEY`; the key is read once, kept in memory, and never printed, logged, written to a file or put in a response. The provider's SDK is an optional dependency, loaded only in this mode.

Every proposal reports its `mode`. When the service starts it says which model is in use.

### The routes

All need the session cookie. Ids travel in the query string (`?id=`), never in the path, because ids are opaque text: spaces, capitals, non-Latin characters and 128-character ids all work.

| Route | What it does |
|---|---|
| `POST /api/capture/propose` | Body `{ "text" }`, at most 8,000 characters. 201 with the proposal. Nothing is written. |
| `GET /api/capture/proposals/:id` | The pending proposal (yours only). |
| `POST /api/capture/proposals/:id/approve` | Writes it in one all-or-nothing step. 200 with what was written. |
| `POST /api/capture/proposals/:id/reject` | Discards it. 204. |
| `GET /api/graph` | Counts of items, categories and links. |
| `GET /api/graph/categories` | Your categories with item counts; `limit` (1 to 100, default 50) and `cursor`. |
| `GET /api/graph/category` | The items under the category `id`; `limit` and `cursor`. |
| `GET /api/graph/item` | The item `id` and the categories it is filed under. |

A proposal is `{ id, createdAt, expiresAt, mode, text, summary, operations, rationale? }`: `text` is a plain-text preview, `summary` lists new and reused categories, links and any problems, and `operations` are exactly what you would be approving. It never contains the prompt, the model's raw output, a token count or a cost. Unknown fields and unknown query parameters are refused by name. Item data over 4,096 characters is shortened and flagged.

Failures are `{ error: { code, message } }` with these statuses: 401 not signed in, 404 not found (including a proposal that is not yours: the answer is identical to the one for a made-up id), 409 the write was refused (the proposal stays pending), 410 the proposal expired, 422 bad input, 429 over a limit (with `Retry-After`), 502 the model failed, refused or timed out, 503 the provider is rate limiting (with `Retry-After`), 500 anything else. Messages are fixed per kind: no provider text, path or stack.

### Limits and lifetimes

- **10 pending and 30 an hour per account**, both settable (`CACI_MAX_PENDING_PER_USER`, `CACI_PROPOSALS_PER_HOUR`). They are checked before the model is asked, so a refusal costs nothing.
- A proposal expires after 15 minutes. **Pending proposals live in memory**: a restart forgets them (and the hourly count), and keeps everything already approved.
- Each proposal costs one model call. Spending is limited per account, not in total.

### What is not protected

- Notes and categories are stored in `graphs.db` as plain text, readable only by the file's owner; see the warning about encryption above.
- With `anthropic`, see the paragraph above: nothing is anonymised. The proof of concept was built for its owner's own data; do not put other people's on a service with the real model switched on until pseudonymisation exists (it is in the plan's Backlog).
- A note is data, never instructions: the model can only propose `upsertNode` and `link` on your own graph, and you see them before they are written.

## Circles

A **circle** is a group of people, each with a role in it. A person can be in several circles in different roles (a helper in one, helped in another), and everyone keeps their own graph. It is specified in `specs/R-004-circles.md`.

**Circles share no data yet.** Being in a circle does not let anyone see, or change, anyone's graph: that is deliberately left for later, after pseudonymisation and the legal groundwork (see the plan's Backlog). Today a circle is only a group, its roles and its invitations. The platform admin has no power over circles either: an admin who is not in a circle is a stranger to it.

### Roles

The four roles say nothing about any setting, so the same platform can serve a household, a team or a club.

| Role | May do |
|---|---|
| `owner` | everything: rename, delete, invite and remove anyone, give anyone any role, including `owner` |
| `manager` | rename; invite `member` and `observer`; withdraw their invitations; move people between `member` and `observer`; remove `member` and `observer`. Never touches an owner or another manager |
| `member` | see the circle and who is in it; leave |
| `observer` | the same as `member` for now (the difference is kept for the later sharing work) |

A circle always has an owner: the only owner cannot leave, be removed or be demoted, and is told to make someone else an owner first, or delete the circle. Nobody changes their own role, and nobody removes themselves (that is leaving). Your role is looked at on every request, so a demotion takes effect at once.

### Invitations

You invite a **username** with a role; nothing happens until that person accepts. An invitation lasts 7 days (`CACI_INVITATION_DAYS`) and can be declined, withdrawn, or left to expire. The answer to an invitation is **the same whether or not that account exists**, whether or not they are already in, and whether or not it is a repeat, so inviting cannot be used to find out who has an account. (Registration already says when a username is taken, so this is one less way to find out, not a secret.) The invitation is kept for a name even when nobody has it: whoever registers that name within 7 days would see it, and still has to accept it.

### The routes

All need the session cookie, with the same rules as the other routes.

| Route | What it does |
|---|---|
| `POST /api/circles` | `{ name, description? }`; 201 with the circle; you are its owner |
| `GET /api/circles` | The circles you are in, with your role in each; `limit` and `cursor` |
| `GET /api/circles/:id` | One circle |
| `PATCH /api/circles/:id` | Rename or describe (owner, manager) |
| `DELETE /api/circles/:id` | Delete it (owner); 204 |
| `GET /api/circles/:id/members` | Who is in it: user id, username, display name, role, when they joined |
| `PATCH /api/circles/:id/members/:userId` | `{ role }`: change someone's role |
| `DELETE /api/circles/:id/members/:userId` | Remove someone; 204 |
| `POST /api/circles/:id/leave` | Leave; 204 |
| `POST /api/circles/:id/invitations` | `{ username, role }`; 202 `{ "invited": true }` for every target |
| `GET /api/circles/:id/invitations` | The circle's open invitations (owner, manager) |
| `DELETE /api/circles/:id/invitations/:invitationId` | Withdraw one; 204 |
| `GET /api/invitations` | Invitations addressed to you |
| `POST /api/invitations/:id/accept` | Join with the offered role; 200 with the circle |
| `POST /api/invitations/:id/decline` | Decline; 204 |

Failures are `{ error: { code, message } }` with these statuses: 401 not signed in, 403 your role does not allow that, 404 not found (**someone who is not in a circle gets exactly the answer for a circle that does not exist**, from every route, and an invitation that is not yours, expired, withdrawn or used is "no such invitation"), 409 the only owner cannot go, 422 bad input (with `field`; unknown fields and query parameters are refused by name), 429 a limit (with `Retry-After` when there is a wait), 500 anything else, with a fixed message.

### Limits

- A person may be in **20 circles** (`CACI_MAX_CIRCLES_PER_USER`); a circle holds **50 people** (`CACI_MAX_MEMBERS_PER_CIRCLE`) and **50 open invitations** (fixed); a person may send **30 invitations an hour** (fixed, kept in memory, so a restart resets it). A circle name is 1 to 80 characters and a description up to 500.
- Accepting into a full circle, or when you are already in the most circles allowed, is refused and leaves the invitation open.

### When an account is deleted

Deleting an account (your own, or by an admin) takes the person out of every circle and removes the invitations sent to them or by them, in the same step. A circle they solely owned passes to its longest-standing manager, else member, else observer; a circle they were alone in no longer exists.

### What is not protected

- Everyone in a circle sees every other member's **username and display name**. Nothing is hidden from members.
- Nobody is told about an invitation: nothing is sent anywhere, so people have to look at `GET /api/invitations`.
- Circles, memberships and invitations are stored in `users.db` as plain text, readable only by the file's owner; see the warning about encryption above. Leaving a circle ends access from then on, but cannot unsee what was already read.

## Writing a storage adapter

An adapter is an object implementing `StorageAdapter` (exported from `bipartite-graph`): a `name`, its `capabilities`, a `transaction(graphId, fn)` method, and `graphs` (`create`, `exists`, `list`, `drop`). All graph rules (validation, the bipartite rule, cascading deletes, query planning) live in the core, so an adapter only provides storage primitives. It does not check that edge endpoints exist and it does not cascade.

What every adapter must guarantee, and what the conformance suite checks:

- **Atomic, serialised transactions.** If the callback passed to `transaction` throws, nothing it did persists, and the adapter keeps working afterwards. Transactions on one graph run one at a time, so concurrent writers never lose each other's updates, and a transaction sees its own earlier writes. A transaction on a graph that does not exist rejects instead of creating it. The core refuses to write through an adapter that reports `transactions: false`.
- **Isolation.** Graphs never see each other's data, even with identical node ids. Two adapters made by the same factory share nothing.
- **Atomic `graphs.create`, idempotent `graphs.drop`.** `create(id)` creates the graph if it is missing, in one step, and returns `true` if this call created it or `false` if it was already there (leaving it untouched); of several simultaneous creates of one id exactly one returns `true`. The core relies on it: `createGraph` is `CONFLICT` when it returns `false`, and a failed `write` only removes a graph it created itself. Returning anything other than a boolean is a `STORAGE_ERROR`. Dropping a missing graph is a no-op; the core decides when that is an error.
- **Replace on write.** `putNodes` and `putEdges` store the record as given, replacing any earlier one for the same key.
- **Deterministic keyset paging.** Listings are ordered by id as plain text, comparing UTF-16 code units, the order JavaScript's `<` gives: `B` before `a`, and no locale or case folding. This is not the same as UTF-8 byte order for characters outside the basic plane, so a database adapter must order (or re-sort) accordingly. Cursors are opaque and stay valid when rows are added or removed between pages. A page that exactly fills the limit, with nothing after it, has no next cursor. Cursors must advance: a cursor that is the same as the one before, or returns to one the adapter already gave, is a bug in the adapter. The core does not trust it: queries, `describeGraph` and the node-delete cascade stop with `STORAGE_ERROR` (a write is rolled back) instead of looping for ever, and the suite fails such a listing instead of hanging.
- **Graph ids are plain, node ids are opaque.** The core only accepts graph ids of 1 to 128 characters from lowercase letters, digits, `_` and `-`, starting with a letter or digit, so an adapter may use a graph id directly as a file name or key on any platform. Node ids may be any string up to 256 characters, including `/`, `..`, spaces and non-ASCII text, and `Item` and `item` are different nodes, so an adapter must store node ids without altering or colliding them.
- **No aliasing.** Data handed in or out is copied, so callers cannot change stored state by mutating what they passed or received.

To check your adapter, call `runAdapterConformance` from your own test file and pass your test runner's `describe` and `it`:

```ts
import { describe, it } from 'vitest'; // or Jest, or node:test
import { runAdapterConformance } from 'bipartite-graph/testing';
import { createMyAdapter } from './my-adapter.js';

runAdapterConformance(
  () => createMyAdapter(),                 // a fresh, empty adapter every call
  { describe, it },
  { dispose: async (adapter) => { /* optional: release what this adapter used, e.g. delete its temp directory */ } },
);
```

The factory is called at least once per test (some cases need two adapters), and each adapter it returns must be independent of the others, for example by using its own temp directory. An adapter that passes the suite needs no changes to the core. `src/graph_store/testing/alternative-adapter.test.ts` shows this: it is a second adapter built with a different strategy (snapshot and restore, its own cursor format) that passes the same suite and runs end to end through `createGraphClient`. The memory adapter in `src/graph_store/adapters/memory/` is the reference implementation.

## Conventions

- **One task, one commit.** Conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, plus the task id.
- **Gate per task.** `npm run gate` (typecheck, lint, tests, API check) must pass for each task, plus the task's own acceptance check.
- **No scope creep.** If a task is bigger than expected, split it in `PLAN.md`. New ideas go to the Backlog.
- **Record decisions.** Non-obvious choices and their reasons go in `.gsd/STATE.md`.

## Customizing

- Change the rules by editing `system_prompt.md` yourself.
- Adjust the loop by editing the files in `.claude/commands/`.
- `.claude/settings.local.json` is git-ignored for personal settings.
