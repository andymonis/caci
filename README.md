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
dev/brain-eval/         Local-only test of the brain against replaying the text: invented scenarios, two arms, scored by rules (never published)
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
| `CACI_MAX_BRAIN_SCOPES` | Most brains My Brain may combine: your own plus circles (2 to 100) | `25` |
| `CACI_LEDGER_DAYS` | How long the change log keeps its entries (1 to 3650), see [The current-view brain and its change log](#the-current-view-brain-and-its-change-log) | `90` |
| `CACI_STATUS_PER_HOUR` | Status updates one account may ask for in an hour (1 to 1,000), see [Asking for a status update](#asking-for-a-status-update) | `20` |

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

The service also serves a small web app from the same address as the API. It lets you **register**, **sign in and out**, visit a **temporary home page** (your name, your username and how many invitations are waiting for you), **use circles** (create one, accept or decline an invitation, leave, look at who is in a circle and manage it), and **file notes and look through them**: type a note, see the model's proposed filing as a preview, approve or reject it, and browse your own categories and items (read-only), and **ask CaCi for a status update** (see **Asking for a status update** below). **Nothing else is built yet**: the app cannot edit, delete or search what you filed, cannot take pictures or voice, and cannot answer questions from your notes. It is specified in `specs/R-005-web-app.md` (the first slice), `specs/R-006-web-circles.md` (circles) and `specs/R-007-web-notes.md` (notes).

### Open it

**This app is the back office, served at `/admin`** (`http://127.0.0.1:8080/admin` by default); the page at `/` is the minimal everyday app. Run `npm run serve` and open the address it prints, adding `/admin`. **Register yourself first**: the first account created on a new installation becomes the administrator, and the create-account form says so. After registering you are signed in with the same values and land on the home page; reloading keeps you signed in until you sign out or the session ends, and signing out ends the session on the service as well as in the page.

It is a plain web page, not an installable app: there is no manifest, no service worker and no offline use, so it needs the service to be reachable (it says so, with a button to try again).

### What it is made of

Plain HTML, CSS and JavaScript with **no build step and no dependency**: the files in `web/` are exactly the files the browser gets. The service sends only these forty-eight, from a fixed list in `src/service/web-app.ts`, and nothing else in the folder:

| File | Does |
|---|---|
| `index.html` | the back office page, served at `/admin`: the sign-in and create-account forms, the home page and every screen |
| `user.html` | the everyday app's page, served at `/` (see [The minimal user app](#the-minimal-user-app)) |
| `user-app.js` | the everyday app's entry point |
| `circle-chat-page.js` | the chat on a Circle screen: Send records against that circle, the Pulse button asks for a status of it (no question field) |
| `thread-view.js` | draws a chat thread from the page's templates, shared by Home and the Circle screens |
| `user-circles.js` | the everyday app's circle links (one per circle you are in, at the top of the navigation) and the Circle screens |
| `user-hooks.js` | puts the everyday app's Home chat and circle screens together for `user-mount.js` |
| `user-mount.js` | puts the everyday app on its page: sign-in and create-account, the frame, Settings |
| `user-style.css` | the everyday app's look: plain, large, light only |
| `style.css` | the look, light and dark by the system setting |
| `app.js` | starts the page |
| `mount.js` | puts the session on the page |
| `view.js` | works out what to show |
| `session.js` | what the page is doing: loading, signed out, signed in |
| `forms.js` | early checks of the forms (the service has the last word) |
| `api-client.js` | the code that talks to the account routes, and the one way every request is sent |
| `circles-client.js` | the code that talks to the circle and invitation routes |
| `router.js` | which screen the address names; anything unknown is the home screen |
| `brain-page.js` | puts the Brain screen on the page: the categories, the items in one, one item (read-only) |
| `brain-view.js` | the words on the Brain screen: row text, the empty brain, the shortened mark |
| `ledger-client.js` | reads the change log of a brain, read-only |
| `ledger-page.js` | puts the change-log screen on the page |
| `ledger-view.js` | the words on the change-log screen |
| `ledger-session.js` | what the change-log screen shows: one brain's entries, newest first, a page at a time; held in memory only |
| `chat-page.js` | puts the chat on the Home screen: the thread, the update and question boxes, the choice buttons |
| `chat-view.js` | the words of the chat: which model handles your updates, and the look of each message |
| `chat-session.js` | what the everyday app's chat does: send an update (asking whose brain it is for), ask a question, keep the thread in memory only |
| `settings-session.js` | what the everyday app's Settings screen does: change the name, email and password |
| `scope-session.js` | which brains the person can capture into and read: their own, each circle (observers read only), and the combined view |
| `brain-session.js` | what the Brain screen shows: the categories, the items in one, one item (read-only, the selection is page state) |
| `capture-page.js` | puts the capture screen on the page: which model files the note, the note box, the preview, approve and reject |
| `capture-view.js` | the words on the capture screen: the model notice for each mode, operation lines, expiry, outcomes |
| `capture-session.js` | what the capture screen shows and does: which model files the note, the one current proposal, approving and rejecting it |
| `circle-page.js` | puts one circle's screen on the page: details, the people, and the forms and buttons for the person's role (each destructive step asks first) |
| `circles-pages.js` | puts the circles list, the create form, the invitations and the home page's invitation count on the page (rows cloned from templates, text only) |
| `circles-view.js` | the words behind those screens: titles, row text, the invitation count sentence |
| `circle-session.js` | what one circle's screen shows and does: roster, invitations, managing it, and the two-step questions |
| `circles-session.js` | what the circles list, creating a circle and my invitations show (one request at a time, a count that is only ever a number the service gave) |
| `notes-client.js` | the code that talks to the note capture and browsing routes |
| `share-page.js` | puts "What you share" on a circle's screen: the other members, what is shared with each, a picker of your own categories and stopping (rows cloned from templates, text only) |
| `shared-page.js` | puts "Shared with you" on a circle's screen: who has shared, their categories, a category's items and one item, read-only (rows cloned from templates, text only) |
| `grants-session.js` | what the "What you share" part of a circle's screen shows and does: the other members, your categories to choose from, saving and stopping (stopping asks first) |
| `status-page.js` | the status screen: which model answers and what is sent, the request box with a few suggestions, and the answer as a card |
| `status-view.js` | the words on the status screen |
| `status-session.js` | what the status screen shows and does: ask for a status update, hold the one answer in memory, forget it when you leave the screen or sign out |
| `shared-session.js` | what the "Shared with you" part shows: who has shared, their categories, a category's items and one item (read-only, the selection is page state) |
| `sharing-client.js` | the code that talks to the sharing routes: what you share and what is shared with you |
| `permissions.js` | what each role may do in a circle, as a hint for which buttons to show |

A file you add to `web/` is not served until you list it, and the tests fail if the list and the folder disagree. Change a file and restart the service to see it.

### What it sends and keeps

- It talks only to the account routes on the same address (`POST /api/register`, `POST /api/login`, `POST /api/logout` and `GET /api/me`) to the fifteen circle and invitation routes listed under **Circles**, and to the capture and browse routes listed under **Notes in the web app**. Nothing goes anywhere else, and nothing is loaded from anywhere else (no fonts, scripts or images from other sites).
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

What the web app does **not** do with circles: everyone in a circle sees everyone's username and display name (the pages say so); nobody is notified of an invitation, so you find out by looking; the invitation count is fetched when the home page opens and when you press Refresh, and **nothing is live** (a view is as old as its last load, and every action reloads what it changed); two tabs do not know about each other.

### Notes in the web app

Three more screens (the first is described under **Asking for a status update**), with the same address rules as the rest (anything that is not exactly one of these is the home screen):

| Address | Screen |
|---|---|
| `#/status` | ask CaCi for a status update: which model answers and what is sent, the request box, the answer |
| `#/capture` | file a note: which model files it, the note box, the preview, approve or reject |
| `#/brain` | browse your own notes: the categories, the items in one, one item (read-only) |
| `#/ledger` | the change log of a brain: what was added, updated or removed, when and by whom, newest first (a review log, not a record of every version) |

**The page says which model files the note, before it is sent.** It asks the service (`GET /api/capture/mode`) when the capture screen opens, shows the answer, and keeps the Propose button disabled until it knows. In the default mode nothing leaves the machine; with the real model the note and the names of your categories are sent to Anthropic and are not anonymised (the operator chooses this for every account at once; see **Capturing notes through the API**). The words are these, and the preview repeats the mode its own proposal carries:

| Mode | Words |
|---|---|
| `demo` | Filed by the free demo model: nothing leaves this machine. |
| `anthropic` | Filed by Anthropic's model: your note and the names of your categories are sent to Anthropic and are not anonymised. |
| not known | Could not tell which model files your notes. |

The routes it uses are `GET /api/capture/mode`, `POST /api/capture/propose`, `GET /api/capture/proposals/:id`, `POST /api/capture/proposals/:id/approve` and `POST /api/capture/proposals/:id/reject` for capturing, and `GET /api/graph/categories`, `GET /api/graph/category` and `GET /api/graph/item` for browsing (ids go in the query string, never in a path).

**The flow is propose, preview, approve.** A note is checked first (1 to 8,000 characters); nothing is written until you press Approve; Reject discards it and writes nothing. The preview shows the service's own text, the operations it would write, the model's reason and when the proposal expires (15 minutes), all as plain text. Failures and limits (the model timing out, refusing or being busy, too many proposals in an hour or waiting) are shown in the service's own words with the wait when it gives one, and **the note stays in the box** so it can be sent again. A refused write keeps the proposal; a proposal that has expired, or that the service no longer has after a restart, says so and writes nothing.

**Where a note goes.** The capture screen has a choice, "Where should this note go?", with your own notes and each circle you may add to, and the Brain screen has "Which notes?" with My Brain, your own notes and each circle; see **The shared circle brain**.

**Browsing is read-only.** The categories show how many items each holds ("at least" when the service capped the count), a category shows its items, an item shows its data as text and the categories it is filed under with their weights; a value the service shortened is marked as shortened. Which category or item you opened is **page state, not part of the address** (node ids are opaque text), so a reload returns to the list. What was loaded stays while you move between screens and is reloaded after you approve a note, or when you press Refresh; it does not update by itself.

What it does **not** do: edit, delete, move or search what you filed; hold more than one proposal at a time; take pictures or voice; work offline. A proposal and the typed note are forgotten when you leave the capture screen or sign out, and nothing is kept in the browser.

### The policy on every page

Every page and file is sent with this Content-Security-Policy, so the browser refuses any script or style that is not one of the files above, any request to another address, and any framing of the page:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

They also carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. API answers stay JSON and keep `default-src 'none'`.

**Behind a reverse proxy**: pass the service's headers through unchanged (a proxy that adds or replaces `Content-Security-Policy` can stop the page working or weaken it), and send the page and `/api/` to the same address, because the session cookie is `SameSite=Strict` and cross-origin writes are refused on purpose (there is no CORS). The service has no HTTPS of its own: see **User accounts and the login API** for the proxy recipe and `Secure` cookies.

### Browsers and limits

It needs a current browser (ES modules and `fetch`). It works with the keyboard alone, at phone width and in light and dark, but it was only looked at by hand in one browser, and nothing here was tried with a screen reader. The form checks are early feedback only, and a password manager may behave differently from one browser to the next.

## The minimal user app

The page at `/` is a very small everyday app (specified in `specs/R-016-user-app.md`). It uses exactly the same API as the back office, which stays at `/admin`; it adds no server route (apart from the circle `scope` and `pulse` options of `POST /api/status`) and keeps **nothing in the browser** (no cookie or storage the page can read, no history).

- **Login.** Sign in, or create an account (the first account made is the administrator). A reload keeps you signed in; Sign out ends the session on the service too.
- **Home is a chat.** Two boxes: **Update** with *Send*, and **Question** with *Ask*. A line above them says which model handles your updates and questions (the free demo model, or Anthropic's, in which case what you type and the notes you can read are sent to Anthropic and are not anonymised); nothing can be sent until it is known.
  - *Send* **always records against your own brain**, whatever circles you are in, and files it straight away: there is **no preview and no Undo**. The thread says "Recorded against your brain", lists the facts recorded and any fact **replaced**. A refusal or a failure records nothing and says why.
  - *Ask* is a status request as it is elsewhere: it reads your own notes and every circle you can read, and each point says where it came from.
    Three buttons beside the boxes, **Pulse**, **Coming up** and **Long range**, ask for a week, a month or a year of what needs attention across everything you can read (see *The three checks*); a circle screen has the same three for that circle only.
    Each point that came from facts has a **Show the source** button that adds who entered the fact, when, and their exact words to the thread (see *Tracing a fact to its words*); the same on a circle's Pulse.
- **A Circle screen for each circle you are in.** Each circle's link is **first in the navigation** (`#/circle/<id>`, by the circle's name; any role). There *Send* **records against that circle's brain** ("Recorded against the circle <name>", with the facts and any "Replaced:" line), and everyone in the circle can read it, which the page says. An **observer** can read but not add: the update box and Send are disabled, with the reason. There is no question box: the **Pulse** button asks for a status of **that circle only**, with a predefined text that the service holds (`controls/pulse.txt`, see [The pulse text](#the-pulse-text)); the page sends only that it is a pulse and which circle, never words. A circle you are not in, or have left, gives "No such circle, or you are not in it." and takes you Home. The list of circles is read again each time a screen is shown (nothing polls).
- **Threads are in memory only**: Home and each circle have their own thread, kept while you are signed in and gone after a reload or signing out.
- **Settings** (`#/settings`): your display name, your email (or remove it) and your password; changing the password signs your other devices out. A link leads to the back office.

It is a plain page that works on a phone (large touch targets, one column, light only), **not an installable app**: no manifest, icon, service worker or HTTPS. Managing circles and invitations, the change log and the Brain screens are in the back office at `/admin`.

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
| `GET /api/capture/mode` | `{ "mode": "demo" }` or `{ "mode": "anthropic" }` and nothing else: which model files the notes, so a page can say so before a note is sent. |
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

## The current-view brain and its change log

The brain keeps **only the current view**. When a new note changes something an older note said (a dose that was `2 x Tablet A` and is now `1 x Tablet B`), the old note is **deleted** in the same all-or-nothing write that adds the new one, so the graph, the status answers and what is shared all show the current fact and the graph does not fill with stale ones. It is specified in `specs/R-014-current-view-brain.md`, with its threats, the tests that cover each and its residual risks. It applies to your own brain and to circle brains.

### What is replaced, and when

- **The model never writes a delete.** The service finds up to 12 notes in the same brain that share words with the new one (a deterministic word-overlap search, not the model) and shows them to the categoriser numbered `[1]`, `[2]`... without their ids. The model may add `replaces: [numbers]` to its reply; a number that was not shown, a repeat, or more than 5 is refused and repaired once. The service turns the numbers into ids and builds the deletes itself.
- **Only notes are replaced directly.** After the write, a category that was left with no notes is removed too, and one the new note links to never is. A failure to tidy never fails the approval.
- **The preview says so before you approve**: "This note replaces: ... The old note will be removed when you approve." and the removal appears in the operations. After approval the outcome says what went ("removed 1 old note and 1 empty category"). A note that only adds a different fact replaces nothing.
- **A note is split into facts, and a change replaces only its own fact** (see [Facts](#facts-not-whole-notes) below). Items filed before facts existed stay whole notes, and replacing one takes with it any detail it held that the new note does not repeat.
- **In a circle**, anyone who may capture (owner, manager, member) may replace any note in that circle's brain, including another member's; an observer cannot capture. The role is read again at approval.
- Switch it off by setting `maxReplaces` to `0` in `controls/categorise/settings.json` (see [Controlling what the model is told](#controlling-what-the-model-is-told)): every note is then only added, as before.

### Facts, not whole notes

A note that states several things (a name, a date of birth, an email, a phone number) is filed as **several items, one per fact** (specified in `specs/R-015-fact-level-brain.md`). A fact is one thing that can change on its own, written so that it makes sense alone ("Mum's phone number is 07700 900456"), with a short **key** naming what it is about ("mum / phone number"). So when the phone number changes, only the phone fact is replaced: the date of birth and the email, and their links, stay.

- **How many**: at most `maxFacts` per note (default 8, 1 to 20 in `controls/categorise/settings.json`); `maxFacts` set to `1` gives one item per note, as before. The service mints the ids (`itemId`, then `itemId-2`, `itemId-3`...) and the model may use no others; every fact must be linked to at least one category. `maxOps` is 40 so eight facts with their links fit.
- **Keys** are asked for but optional. The candidate search ranks first the existing facts whose whole key is in the note, then by shared words, and shows up to 12 candidates **with their keys** so the model can reuse a key when it updates a fact. Old items without a key are matched by words as before.
- **The preview** says "This note adds N facts:" with each fact, then what it replaces. The stamp, the tidy and the change log work on every fact.
- **The note's own text is not kept**: only its facts are. A fact the model fails to extract is lost, and the brain-eval reports that as lost at filing.
- To see whether it helps, run `npm run brain-eval` once as it is and once with a copy of `controls/` whose `categorise/settings.json` has `"maxFacts": 1` (`--controls DIR`), then `--compare`: the two scenarios where one note states several facts and a later note changes one (`profile-one-value-changes`, `appointment-details-one-changes`) are there to show the difference.

### The change log

After a successful approval the service records one line per change: when, who, added, updated or removed, the note or category, and for a removal **the removed title and summary** (cut to 200 and 400 characters), so a wrong deletion can be recognised and the note typed in again. **It is a review log, not a history**: it is kept for `CACI_LEDGER_DAYS` days (default 90, 1 to 3650; older entries are removed at start-up and once a day), and it is not used to answer questions. A circle's log is deleted with the circle and your personal log with your account.

| Route | What it does |
|-------|--------------|
| `GET /api/ledger` | The log of one brain, newest first: `scope` is `personal` (the default) or `circle:<id>`, with `limit` and `cursor`. Needs the session cookie. |
| `GET /api/ledger/source` | Where one fact came from (see [Tracing a fact to its words](#tracing-a-fact-to-its-words)): `scope` as above and `id` (the fact's id). Needs the session cookie. |

You can read your own log, and a circle's log if you may read the circle (any role). A stranger, the administrator who is not a member, and a made-up circle all get the same 404. Unknown parameters are refused by name.

The write and the log are in two databases, so they are not one transaction: the write comes first, and **a failed log line never undoes the change**. The service prints a warning ("the change was made but could not be recorded in the change log"); the same goes for a failed tidy. Neither shows notes or ids.

### In the web app

The capture preview and outcome say what is removed. The **Change log** screen (`#/ledger`) shows the log of your own notes or of a circle, one line per change ("2026-10-14 09:30 UTC · Ann A · removed note · "Mum: 2 x Tablet A a day""), with Show more and Refresh; nothing is requested until you open it, and it is forgotten when you leave. It says it is a review log kept for a limited time (90 days unless the operator chose otherwise) and not a full record of every version.

### What is not protected

- **A model can choose wrongly.** The limits (at most 5 notes, only ones it was shown, the same brain) bound a wrong deletion, the preview lets you see it, and the log keeps the removed text. They do not prevent it. Whether replacing helps is measured, not assumed: run `npm run brain-eval -- --demo` for the plumbing or a real run with and without `--no-replace` and compare the saved results (`--compare`); the report counts the answers that lost their fact to a deletion.
- The word-overlap search misses a paraphrase that shares no word, so a stale note can stay. Keys can drift too ("phone" and "mobile" as two facts), leaving a stale fact beside the new one.
- The log and the removed text are plain text in `users.db`, readable by whoever can read the file and by every member who may read a circle's log. Restoring from the log and questions about history are not built.

## Input history and exporting a brain

The change log (see [The current-view brain and its change log](#the-current-view-brain-and-its-change-log)) also keeps **the words typed for each update**, as specified in `specs/R-017-input-ledger-and-export.md`. This lets a change be confirmed against what was entered and by whom, and gives an operator real notes to test with.

- **What is stored.** One `input` entry for every approved update (Send), holding the text **exactly as typed** (up to 8,000 characters), who sent it, when, and which brain it went to. It sits directly under the facts it produced in the change log; the back office's change-log screen shows it as *Entered by <name>: "<words>"*. **Questions, Pulses, rejected proposals and failed writes keep nothing.** Updates made before this existed have no recorded words.
- **Who can read it.** Everyone who can read that brain's change log: you for your own brain; the owner, managers, members **and observers** of a circle for the circle's. A stranger, a made-up circle and the platform administrator get the one "no such circle" answer. The change-log screen says so.
- **How long.** As long as the change log: `CACI_LEDGER_DAYS` (90 by default), then the entries are removed at start-up and once a day. Deleting an account removes its personal entries (the words included); deleting a circle removes the circle's. If the log cannot be written, the update is still made and the operator is told once.
- **Unencrypted.** The words are in `users.db` as plain text, like everything else, and in every snapshot.

### Tracing a fact to its words

`GET /api/ledger/source?scope=personal|circle:<id>&id=<fact id>` says where one fact came from: **who entered it** (username and display name), **when**, and **the exact words**, whether the fact is **still in the brain** and whether it was **replaced later** (a replaced fact is found through the change log, with what it said). It is read-only and needs the session cookie. Exactly the people who can read that brain's change log can ask; a stranger, a made-up circle and the platform administrator get the one "no such circle" answer, and an id that is not a fact of that brain is "no such item". When the words are no longer kept (the fact is older than the words were recorded, or older than `CACI_LEDGER_DAYS`) the answer still says who and when if it can, and says plainly that the words are not kept.

**In the minimal user app** every point of an answer (on Home, and a circle's Pulse) that came from facts has a **Show the source** button. Pressing it adds a message to the thread: *Entered by <name> on <time> UTC: "<the exact words>"*, and *This fact was replaced later.* when it was. The words are shown **as text** and the model is **never shown them**: the button only asks the change log. Each point of the status answer carries the facts it came from (`facts`: the scope and the fact's id, at most five, never a graph id or user id) so the button knows what to ask; a Pulse names only its circle's facts.

**When the words are gone**: the change log is kept for `CACI_LEDGER_DAYS` (90 by default), so a fact older than that, or entered before the words were recorded, has no words to show. The source then says who and when if it still can, and says plainly *The words behind this fact are not kept*. To trace further back, raise `CACI_LEDGER_DAYS` (a longer, separate retention for the words only is on the Backlog), or look in a snapshot or an export taken earlier.

**What it does not do**: it does not check a fact against its words or correct it, it does not search the log, and it shows only the words of the approval that created the fact (a later note that changed it has its own fact and its own words). A fact that merged detail from two notes names the note that created the item.

### Exporting a brain

```
npm run export-brain -- --user ann --out ~/exports/ann.json
npm run export-brain -- --circle c0123456789abcdef --out ~/exports/club.json
npm run export-brain -- --user ann --out ~/exports/ann-draft.json --format scenario
```

It writes **one brain** (a person's own or a circle's) as JSON from a **consistent copy of the databases** taken for the purpose, so it is safe while the service runs and the live files are never changed. `--data-dir DIR` names another data folder (default: `CACI_DATA_DIR`, then `./data`). The document (`caci-brain-export`, version 1) holds the facts (title, summary, key, who entered them as a **username**, when, and their categories with weights), the categories, and the change log with the typed words, newest first. It holds **no password, hash, session, email or user id**, and nothing of any other brain.

Safety: the file is created **owner-only**; an **existing file is never overwritten** and a **folder is never created**; a path **inside the project folder or the data folder is refused** (so it cannot be committed by accident); note text is **never printed**, only counts and the path. A user or circle that does not exist, or a folder with no databases, exits 1 and leaves nothing behind; wrong arguments exit 2 with the usage.

`--format scenario` writes a **draft for the brain-eval** instead: the typed words as dated notes (older facts from before the words were recorded become `title: summary` notes) and **no questions**. The brain-eval refuses it until you add questions by hand; see `dev/brain-eval/README.md` ("From real notes to a scenario"). On the Pi, see the runbook (step 11) for taking a file off the machine.

### What is not protected

**An exported file holds real notes**: keep it out of the repository, off shared machines and away from the model. Nothing inspects what the words say (a password typed into a note is exported as typed). The folder guard is a path check, so copying the file into the project afterwards defeats it. Facts entered before the words were recorded export as their stored title and summary only. Entries older than the retention are gone from the live database, so take a snapshot or an export before they expire.

## Circles

A **circle** is a group of people, each with a role in it. A person can be in several circles in different roles (a helper in one, helped in another), and everyone keeps their own graph. It is specified in `specs/R-004-circles.md`.

**A circle shares nothing by itself, and owns one brain only if you use it** (see **The shared circle brain**). Being in a circle lets people see who else is in it (usernames and display names) and nothing more. A member can choose to share chosen categories of their own brain, read-only, with one other member, and withdraw it at any time; it ends if either person leaves the circle. The web app's circle screen has a **What you share** part for choosing what to share and a **Shared with you** part for reading, read-only, what others have shared with you; the service has routes for both. Sharing sends nothing new to a model, but it is not safe to use with other people's data until pseudonymisation and the legal groundwork are done (see `specs/R-008-shared-brains.md`, which lists them as release gates). The platform admin has no power over circles either: an admin who is not in a circle is a stranger to it.

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

## Shared circle brains

A person can **share chosen categories of their own brain, read-only, with one other member of a circle**. It is specified in `specs/R-008-shared-brains.md`, which also holds its threat table and the release gates below.

### What is shared

- **Read-only.** The person who receives a share can read and cannot change anything: this piece has no write path at all.
- **Chosen categories.** A share names categories of the sharer's own brain; the items filed under them come along; everything else stays private. A share holds at most **200 categories**.
- **One direction, one person.** Sharing with someone does not share back, and each person is its own share. Roles in the circle carry no access: an observer may share and receive like anyone.
- **Live, and withdrawable at any time.** Nothing is copied. Every request re-checks that both people are still members and what is shared right now, so narrowing or withdrawing takes effect on the next request.
- **It ends by itself** when either person leaves the circle or is removed, when an account is deleted, and when the circle is deleted, in the same step as that change. Coming back by invitation brings nothing back.
- **The reader sees only what was shared.** An item is visible if it is filed under at least one shared category, its detail names only the shared categories, and counts include only them. A private category, an item reachable only through one, a member with no share and a made-up id all get exactly the same not-found answer. The platform admin has no access: an admin who is not in the circle is a stranger to it.

### The routes

All need the session cookie and are on the same status table as the circle routes. Ids of categories and items travel in the query string, never in the path, and an unknown parameter is refused by name.

| Route | What it does |
|-------|--------------|
| `GET /api/circles/:id/grants` | What I share, one entry per other member (`limit`, `cursor`) |
| `PUT /api/circles/:id/grants/:userId` | Body `{ "categories": [ids] }` only; replaces the set; 200 with it, or 204 when the empty list withdraws it |
| `DELETE /api/circles/:id/grants/:userId` | Withdraws; 204 |
| `GET /api/circles/:id/shared` | Who has shared with me, with how many categories |
| `GET /api/circles/:id/shared/:userId/categories` | That person's shared categories with item counts (`limit`, `cursor`) |
| `GET /api/circles/:id/shared/:userId/category?id=` | The items of one shared category (`limit`, `cursor`) |
| `GET /api/circles/:id/shared/:userId/item?id=` | One visible item and the shared categories it is filed under |

Every category you share must be one of your own, and nobody can share with themselves or with someone who is not in the circle.

### In the web app

The circle screen has **What you share** (press *Show what I share*: each other member, what is shared with them, a picker of your own categories with Save, and *Stop sharing*, which asks first) and **Shared with you** (press *Show what is shared with me*: who has shared, then their categories, a category's items and one item, read-only). Neither asks the service for anything until you press its button, and both forget everything when you leave the screen.

### What is not protected, and what must happen before other people's data is used

- **A member can copy what they see by hand.** Read-only means no write path and no export, not that a person cannot read a note aloud or take a screenshot.
- **Nobody is told** when a share starts, changes or ends, and the owner is not told who read what.
- **Some things are visible by nature:** the names of shared categories, how many items are in each, an item's weights, and any private subject an item's own text happens to mention (only the filing is filtered, not the prose).
- **The files are plain text** to whoever can read the data folder, and **the real model still receives every note** when `CACI_LLM=anthropic`, whoever may later read it.
- **The release gates are not met.** Before anyone else's data is held, the plan needs pseudonymisation, a data processing agreement and the provider's terms, a lawful basis, a risk assessment, and a statement of who may use the service. Do not use sharing with other people's data until they are done.

## The shared circle brain

A circle can also **own one brain that its members capture into and read together**. It is specified in `specs/R-009-shared-circle-brains.md`, which holds its threat table, residual risks and the release gates below. It is separate from the per-member read-only shares in **Shared circle brains** above: both work, and neither depends on the other.

### Scopes

Every capture and every read is about one **scope**: your own brain (`{ "kind": "personal" }`, the default when no scope is given, exactly as before) or one circle's brain (`{ "kind": "circle", "circleId": "..." }`). A circle's brain is made when the circle is made and dropped, with its notes, when the circle is deleted; leaving or being removed never touches it, so earlier notes stay for the others. The scope always names a brain you may use: the service never takes a graph id from a request.

| Role in the circle | May capture into the circle's brain | May read it |
|---|---|---|
| owner | yes | yes |
| manager | yes | yes |
| member | yes | yes |
| observer | no | yes |

Anything not allowed (a stranger, someone who has left, a circle that does not exist, an observer capturing, the platform admin who is not a member) gets exactly the same answer as a circle that does not exist: **no such circle**. Your role is read from the store on every request, so a demotion, a removal or a deleted circle takes effect on the next request, and a proposal you made for a circle you can no longer capture into is discarded and writes nothing.

### My Brain

My Brain is your own notes **and every circle you are in, together**. Every category, item and count in it says where it comes from (`My own notes` or the circle's name), the same category id in two scopes stays two separate rows, and the order is fixed (your own brain, then circles by id, then by category id). A person in more circles than `CACI_MAX_BRAIN_SCOPES` allows (default 25 brains including their own) is refused a combined view with a clear message, never given a partial one; any one circle can still be read on its own.

Each item captured into a circle records **who added it and when** (`contributedBy`, `contributedAt`), set by the service after the model has answered; nothing the model writes can set or forge them.

### The routes

All need the session cookie, take the scope from the query string (`scope=personal`, `scope=circle:<id>` or `scope=mine`; none means personal) and are read-only. Ids of categories and items travel in the query string, never in the path, and an unknown parameter is refused by name. In My Brain a category or item is named by where it is as well: `source=personal` or `source=circle:<id>`, required there and refused anywhere else.

| Route | What it does |
|-------|--------------|
| `GET /api/brain/scopes` | The brains you may use: your own first, then each circle with your role and whether you may capture into it |
| `GET /api/brain` | The counts of one scope, or of every scope in My Brain |
| `GET /api/brain/categories` | The categories of one scope, or of every scope in My Brain, each tagged (`limit`, `cursor`) |
| `GET /api/brain/category` | The items of one category (`id`, and `source` in My Brain) |
| `GET /api/brain/item` | One item and its categories (`id`, and `source` in My Brain) |

`POST /api/capture/propose` also takes an optional `scope` beside `text`; the proposal is bound to that scope when it is made and approval writes only there, whatever a later request says. The older `/api/graph/...` routes still read your own brain only.

### In the web app

The capture screen asks **Where should this note go?** and offers your own notes and each circle you may capture into; circles you can only read are named under it. Before anything is sent it says where the note will go. For a circle the words are: "This note will be added to the circle "Name". Everyone in the circle can read it, and it cannot be taken back once approved." (with the real model it adds that the note and the names of the circle's categories are sent to Anthropic and are not anonymised). The preview repeats the scope and the notice, and the outcome says which circle the note was added to. The Brain screen asks **Which notes?**: My Brain, your own notes or one circle, marks every row with where it is, hides the capture link for a circle you can only read, and says so in one set of words if a circle you were reading is no longer yours.

### What is not protected, and what must happen before other people's data is used

- **What a member has read cannot be taken back.** A note in a circle's brain is seen by every current member who may read; there is **no edit and no delete** of a shared note in this release (Reject works only before approval).
- **A circle's brain may describe people who have no account** and have not agreed to it.
- **Separating circles is not pseudonymisation.** It limits who reads a brain, not what the operator or the model provider can see, and **with `CACI_LLM=anthropic` the note and the names of the circle's categories go to Anthropic, unanonymised**.
- **Nobody is told** when a note is added, and the files are plain text to whoever can read the data folder.
- **The release gates are not met.** Before anyone else's data is held, the plan needs pseudonymisation, a data processing agreement and the provider's terms, a lawful basis, a risk assessment, and a statement of who may use the service. Do not use circle brains with other people's data until they are done.

## Asking for a status update

You can ask CaCi for **a short status** by typing what you want in your own words: "Give me a morning status check", "I am heading into town". CaCi reads **everything you can read** (your own notes and every circle you are in, observers included) and answers **you alone**, in a fixed format. **It is not a question to another person, nothing you ask or get back is filed in any brain, and no history is kept.** It is specified in `specs/R-011-status-updates.md`, which holds its threat table, its residual risks and the release gates that stand for anything beyond the family test.

### What is read, and what is sent to the model

The newest notes you can read, from every scope, are numbered and sent with your request: up to 200 per scope and 12,000 characters in all, newest first; when more exist the answer says some were left out. Each note carries its text, the names of its categories and where it came from; it never carries who wrote it. What you may read is decided when you ask, so a circle you have left, or were never in, is not in the request. **With the default model (`CACI_LLM=demo`) nothing leaves the machine. With `CACI_LLM=anthropic` your request and the notes you can read are sent to Anthropic and are not anonymised**, for every account at once.

A status reads everything you can read, so a person in more circles than `CACI_MAX_BRAIN_SCOPES` allows (default 25 brains including their own) is told to leave some out first and is not answered.

### The answer

A headline, at most five short points, and counts. The model only names the numbers of the notes a point is based on; **the service turns those into where each came from** (your own notes, or the circle's name), so the model cannot invent a source, and a reply that cites a note that does not exist is repaired once and then refused. When nothing relevant is found the answer says so (`nothing`), never with points. The time the model is told is the server's clock in the time zone your browser reports.

### The route

| Route | What it does |
|-------|--------------|
| `POST /api/status` | Body `{ text, timeZone?, scope? }`, for a **check** (R-018) `{ check: "pulse" | "coming-up" | "long-range", scope?, timeZone? }` with **no `text`** (the server holds each check's words; the check looks over a week, a month or a year, a window the code works out in your time zone and states to the model; the answer is silent, one line, when nothing falls in it; `scope` may be omitted for every brain you can read), or for a circle's Pulse `{ pulse: true, scope }` (the week check, kept for older pages), and nothing else (any other field or query parameter is refused by name); a circle `scope` limits the context to that circle's notes (any role may ask; a stranger or a made-up circle gets the one "no such circle"); needs the session cookie; answers `{ status }` |

Statuses are the usual ones: 401 without a session, 422 for a bad request with its field named, 429 with `Retry-After` for the hourly limit or a status already being made, 502 or 503 with fixed words when the model fails or is busy, 404 when status updates are not available.

### Limits

The request is at most 500 characters. Each account may ask for `CACI_STATUS_PER_HOUR` statuses an hour (default 20, counted when the model is about to be asked, so a request refused earlier costs nothing) and has one status in progress at a time. Pending proposals and statuses have separate limits.

### In the web app

The **Status** screen (`#/status`) says which model answers and that everything you can read is sent with your request **before anything is asked**, and keeps the Ask button disabled until it knows. The words are: "Answered by the free demo model: nothing leaves this machine." or "Answered by Anthropic's model: your request and the notes you can read, yours and your circles', are sent to Anthropic and are not anonymised.", then "Your status uses everything you can read: your own notes and the circles you are in. It is sent with your request." There are three suggestions that only fill the box. The answer is a card with the headline, each point with where it came from, "Nothing relevant was found in what you can read." when that is so, "Some notes were left out because there were too many; the newest were used." when that is so, how many notes it used and when it was made (UTC). It is only text, **is not saved anywhere, and is gone when you leave the screen or sign out**.

### The three checks: Pulse, Coming up and Long range

A long answer about everything is no help, so the three buttons ask for **one window each** (specified in `specs/R-018-focused-answers.md`): **Pulse** looks at the **week** (today and the next six days), **Coming up** at the **month** (today and the next thirty days) and **Long range** at the **year** (to the same date a year on). **The code works the window out** in your time zone and states it to the model; the model never works it out, and nothing a note says can widen it. The rules say: only what falls in the window, or is overdue or still open; nothing about anything outside it; no retelling of whole notes; and **when nothing needs attention the answer is silent**, one line such as *Nothing needs your attention this week.*, with no points and no "next" line.

The buttons are on **Home** (they look at every brain you can read) and on each **circle screen** (that circle only; observers may ask). The request is `{ check: "pulse" | "coming-up" | "long-range", scope?, timeZone? }` with **no text**: the server holds the words of each check (`controls/pulse.txt`, `controls/coming-up.txt`, `controls/long-range.txt`), and the number of points each check may make and its focus are in `controls/status/settings.json` (`horizons`, see *Controlling what the model is told*). To try other wording or caps without deploying them, copy `controls/` and run `npm run eval -- --capability focus --controls DIR` (eleven invented cases, judged by rules; add `--yes` for the real models).

**What it does not do yet:** a check relies on the dates the notes' words contain (a note with no date is never surfaced by the demo model, and a real model may do the same), it does not extract dates or "paid" as data when a note is filed, and it does not suggest follow-ups such as checking passports before a holiday; those are Parts B and C of the specification, to be built after the owner's real run shows whether wording alone is enough.

### What is not protected, and what is not done

- **The whole readable brain goes to the model in one request** (within the limits), and with the real model that is Anthropic, unanonymised. The release gates (pseudonymisation, a data processing agreement and the provider's terms, a lawful basis, a risk assessment, a statement of who may use the service) are not met: do not use it with other people's data until they are.
- **The model can still state something wrongly.** The format and the numbered sources make an answer checkable, not correct. The quality of the real model has been measured only on a small invented set (`npm run eval -- --capability status`), and the default model for status is provisional.
- **A request already running when a member is removed** may still use what they could read when it started.
- **Not built:** location, weather or calendars as context, restricting a status to one circle, a history, free questions beyond a status, notices to other people.

## Controlling what the model is told

Every message CaCi sends to a language model is made of **three separate parts**: (1) **the request** (what the person typed, or what the system is doing), (2) **the context** (the combined brain context: the existing categories, or the numbered notes a person can read) and (3) **the controls** (the instructions, guardrails and definitions that steer the exchange). The first two are data and come from people and their brains. **The controls are plain text files in the `controls/` folder of the repository**, read once when the service starts, so they can be adjusted and maintained on their own without touching the code. It is specified in `specs/R-012-controllable-llm.md`, which holds its threat table, its residual risks and its acceptance checks.

### The files

Exactly these six files are read, and nothing else in the folder:

| File | What it holds | Slots it may use |
|---|---|---|
| `controls/categorise/system.txt` | The filing assistant's instructions | `{{itemId}}` (required), `{{maxOps}}`, `{{allowedOps}}`, `{{maxReplaces}}`, `{{maxFacts}}`, `{{keyMaxChars}}` |
| `controls/categorise/frame.txt` | The words around the two blocks in the user message | `{{contextBlock}}` and `{{requestBlock}}`, each exactly once |
| `controls/categorise/settings.json` | The limits and the descriptions in the reply schema | none |
| `controls/status/system.txt` | The status assistant's instructions | `{{entryCount}}`, `{{now}}`, `{{maxHeadline}}`, `{{maxPoints}}`, `{{maxPointChars}}`, `{{maxRefs}}`, `{{horizonSection}}` (a focused check's window and rules; empty for an ordinary status) |
| `controls/status/frame.txt` | The words around the two blocks in the user message | `{{entriesBlock}}` and `{{requestBlock}}`, each exactly once |
| `controls/status/settings.json` | The limits and the descriptions in the reply schema | none |

A **slot** is written `{{name}}`: a letter first, then letters or digits, and nothing else is logic (no loops, no includes). The service fills a slot with a value from code, **inserts it as it is and never reads it again for slots**, so a note, a request or a circle name that happens to contain `{{itemId}}` stays plain text. The request and the context only ever enter through their block slots, escaped, between their own delimiters (`<note>`, `<categories>`, `<request>`, `<entries>`). An unknown slot, a stray `{{` or `}}`, an empty file, a file over 16,000 characters or a control character (other than line breaks and tabs) is an error; a final line break is ignored.

### The settings

All numbers must be whole and inside their range; unknown settings are refused. The reply schema, the guard and the instructions are all built from these same numbers, so changing one moves all three together. A per-call option in code still overrides a setting for one call.

**`categorise/settings.json`**

| Setting | Meaning | Shipped | Range |
|---|---|---|---|
| `maxOps` | Most operations the model may return; told to the model, put in the reply schema and enforced on the reply | `40` | 1 to 100 |
| `maxTextChars` | Longest note accepted (must not be below the service's own 8,000) | `8000` | 1 to 100,000 |
| `maxContextChars` | Longest category list sent | `12000` | 1 to 100,000 |
| `maxDataBytes` | Largest `data` on any operation the guard accepts | `4096` | 64 to 65,536 |
| `maxIdLength` | Longest id the guard accepts | `128` | 8 to 256 |
| `maxOutputChars` | Longest reply accepted before it is read | `32000` | 1,000 to 200,000 |
| `maxRationaleChars` | Longest reason | `500` | 1 to 2,000 |
| `maxReplaces` | Most existing facts one new note may replace (0 switches replacing off); told to the model and enforced on the reply | `5` | 0 to 20 |
| `maxFacts` | Most facts (items) one note may be split into; 1 is one item per note, as before (R-015) | `8` | 1 to 20 |
| `keyMaxChars` | Longest fact key, in the reply schema (R-015) | `80` | 1 to 200 |
| `titleMaxChars` | Longest item title, in the reply schema | `120` | 1 to 500 |
| `summaryMaxChars` | Longest item summary, in the reply schema | `300` | 1 to 1,000 |
| `categoryNameMaxChars` | Longest category name, in the reply schema | `60` | 1 to 200 |

It also holds `descriptions` with `title`, `summary`, `key` and `name` (one line each, up to 300 characters), which are placed in the reply schema.

**`status/settings.json`**

| Setting | Meaning | Shipped | Range |
|---|---|---|---|
| `maxHeadline` | Longest headline | `160` | 1 to 500 |
| `maxPoints` | Most points | `5` | 1 to 20 |
| `maxPointChars` | Longest point | `240` | 1 to 1,000 |
| `maxRefs` | Most note numbers one point may cite | `5` | 1 to 20 |
| `maxRequestChars` | Longest request (must not be below the service's own 500) | `500` | 1 to 5,000 |
| `maxEntries` | Most notes sent as context | `500` | 1 to 2,000 |
| `maxEntryChars` | Longest single note sent | `1500` | 1 to 10,000 |
| `maxTotalChars` | Most characters of notes sent in all | `30000` | 1 to 200,000 |
| `maxOutputChars` | Longest reply accepted before it is read | `8000` | 500 to 100,000 |

It also holds `descriptions` with `headline`, `pointText`, `refs` and `nothing`, and **`horizons`** (R-018): `rules` (the rules every focused check follows, up to 1,000 characters on one line) and, for each of `week`, `month` and `year`, a `maxPoints` (1 to 20, used instead of `maxPoints` for that check) and a `focus` (one line, up to 300 characters). A focused check (the Pulse, *Coming up*, *Long range*) puts its window, which **the code works out** in your time zone, with the focus and the rules into the system prompt through `{{horizonSection}}`; without a horizon that slot is empty and the prompt is unchanged. If you remove the slot from `system.txt`, a focused check is refused rather than sent without its window. Some combinations are refused because the guard could never be satisfied: `maxDataBytes` must hold the longest title, summary, key and category name; `maxOps` must be at least twice `maxFacts` (each fact needs an item and a link); `maxOutputChars` must hold `maxFacts` facts; `maxOutputChars` must hold the longest reply the other limits allow; an entry may not be longer than the total; and `maxRefs` may not exceed `maxEntries`.

### What stays in code

The **shape of the reply** and **every check of the guard** (only the operations allowed, the item id the system minted, citations that exist, one line of plain text, the numbers above), the **escaping and the block delimiters** that keep a person's text from passing as instructions, and the **limits the service itself puts on the API** (a note of at most 8,000 characters and a status request of at most 500). The service **refuses to start** if the controls allow less than that. Two small pieces of wording are also still in code: the header of the category list, and the repair turn (when a reply is rejected, the second call carries the guard's numbered reasons and one fixed closing line, "Reply again with the corrected JSON object only.").

### The pulse text

`controls/pulse.txt` is the one predefined request the **Pulse** (the week check) sends (see [The minimal user app](#the-minimal-user-app)): by default *"What needs my attention this week? Keep it factual and brief, and say so plainly if nothing does."* Two more files do the same for the other checks of R-018: `controls/coming-up.txt` (the month) and `controls/long-range.txt` (the year). Each is **one paragraph of plain text, 1 to 500 characters**; the service reads all three at start-up and **a missing, blank, too long or multi-line file stops the start**, naming the file (`npm run doctor` checks them too). A member's browser sends only which check it wants and where, never the words, so nobody can send their own text as a check; change a file and update as below to change what every check asks. The window of a check (this week, this month, this year) is worked out by the code and stated in the system prompt, not in these files. They are published with the package and never served.

### Trying a change without deploying it

Copy the folder, edit the copy, and run the same evaluation sets against it (the checks are the same, only the controls differ):

```
cp -r controls /tmp/candidate
npm run eval -- --scripted --controls /tmp/candidate      # does it load and run? free, nothing sent
npm run eval -- --controls /tmp/candidate --yes            # the real model, the same golden set
npm run dev:lab -- --controls /tmp/candidate               # the lab shows the three parts of each message
```

A bad folder stops with every problem listed before any call is made. The reports and the lab name the folder used.

### Changing it for real

Edit the files in `controls/`, commit them, and update as usual (`sudo node /opt/caci/app/deploy/run.mjs` on the Pi). **A bad file stops the service from starting**, naming the file and the problem, and a failed deploy rolls back like any other service that does not come up; `npm run doctor` has an **LLM controls** check that says which file to fix. There is **no versioning** of the controls beyond git, and a change applies only after a restart.

### What is not protected

Anyone who can edit the repository can change what the model is told, within the guard's checks. The guard checks the form of a reply, not the meaning, so a rule weakened in wording (for example dropping "cite your sources") is not caught until you compare runs of the evaluation set with the real model. The shipped `controls/` folder is part of the package and is never served over HTTP.

## Testing the brain against replaying the text

CaCi stores a short title and summary of each note in a graph and builds its answers from those. The obvious alternative is to keep every note as plain text and show the model all of it every time. `npm run brain-eval` asks which of the two answers questions better, with **invented notes** (it is a development tool, never published, specified in `specs/R-013-brain-evaluation.md`). It measures **whether the right facts come back**, not speed or cost: an early fact must not be forgotten, and a later fact that overrides an earlier one must win (the dose that was `2 x Tablet A` and became `1 x Tablet B` must not come back as `2 x Tablet A`).

### The two arms

- **Brain**: the real product path. Each note is filed by the real categoriser into a real graph (in memory, with the clock set to the note's date), and each question is asked as a status request. Notes are filed the way the product files them: a note that changes an older one replaces it (R-014). `--no-replace` files every note as an addition instead, so the two ways can be compared; the report then counts what was replaced and how many failed answers lost their fact to a deletion.
- **Replay**: the same `status` capability, the same controls and the same answering model, but shown **every raw note up to the question, oldest first, with its date**, with the size limits lifted. A transcript estimated above 150,000 tokens (`--window`) is marked over-window and not sent. `--order newest-first` reverses it for comparison.

The notes are filed once by a **filing model** (`--file-with`, default `fast`); the questions are answered by one or more **answering models** (`--answer-with`, default `fast`, the cheapest; add `balanced,deep` to compare models), each question `--repeat` times (default 3) because models vary.

### The scenarios and the scoring

`dev/brain-eval/scenarios/` holds 12 invented scenarios (147 notes, 60 questions): a medication change, an appointment moved twice then cancelled, a changed phone number and address, facts corrected, activities cancelled, an allergy and a key place written once and followed by thirty ordinary notes, two people's facts that must not be mixed, a changed routine, and two that **add a different fact in very similar words and must not replace anything** (a second medication for another condition, two people's dentist appointments), which are there to catch a brain that deletes what it should keep, and two where **one note states several facts and a later note changes only one** (a profile with date of birth, phone and email; an appointment with place, ward and time), which are there to show whether the unchanged facts survive (R-015). Each question is one of five kinds: `recall` (an earlier fact must still be found), `override` (a later fact replaced an earlier one), `retract` (something was cancelled), `multi` (several facts in one answer) and `distractor` (nothing answers it, so the right reply is "nothing relevant"). `dev/brain-eval/scenarios/REVIEW.md` shows the whole library on one page, and `dev/brain-eval/scenarios/README.md` explains how to write a scenario.

Answers are scored **by rules, not by another model**: the answer must contain one phrase from every `must` group and must not give a `stale` phrase as current. A stale phrase in the same line as a word that reports a change (*no longer*, *instead of*, *moved from*, *the original*, *replaces*, *corrected*, *cancelled* and similar) counts as a mention of the old value and is allowed, and is counted separately; a question that expects nothing passes when the answer says nothing was found, even if it adds other notes. The rules have a version, and `--rescore FILE` re-scores a saved run offline when they change (the first run's corrected numbers were recorded this way). Words are compared whole (`4 June` is not found in `14 June`), numbers written as words are read as digits, and punctuation and case are ignored. Tests prove the scoring tells good from bad: an ideal answerer passes every question, a stale parrot fails the override questions, an amnesiac fails recall of earlier notes, and a model that always says nothing passes only the distractors.

### Running it

```
npm run brain-eval -- --demo                       # free: a stand-in model checks the plumbing and says nothing about quality
npm run brain-eval                                 # a real run prints its plan and sends nothing
npm run brain-eval -- --yes                        # the real run
npm run brain-eval -- --yes --pad 0,100,300        # also with 100 and 300 unrelated filler notes mixed in
npm run brain-eval -- --yes --controls /tmp/candidate   # against changed LLM controls
npm run brain-eval -- --compare before.json after.json  # what changed between two saved runs
```

A real run needs `ANTHROPIC_API_KEY` in the environment, **costs money and sends every note and question in the scenarios to Anthropic**, which is why it prints its plan (about how many calls, which models, which controls) and stops unless you add `--yes`. **Only invented text belongs in a scenario; never put real people or real data in one.** The key is read once, handed to the client and never printed or saved. Ctrl+C stops between calls and still reports and saves what was done. Results are saved as JSON in the git-ignored `brain-eval-results/`. `--demo` and `--yes` together are refused. `--pad` mixes in seeded, unrelated filler (`--seed` repeats it) to see whether early facts are lost once there is more than the brain's context holds; the report then has a section per size and a table of the effect.

### Reading the report

For each arm and answering model: the pass rate, how often an old fact was given as current, how often it was mentioned as old, errors and tokens; the same by kind of question; **brain minus replay** (positive means the brain did better); a per-question table; and the failures with the answers given. Each failed answer is also traced to **where the fact was lost**: at *filing* (it never reached the brain), at *replace* (it was stored and then deleted because a later note replaced it), at *context* (stored, but not in what was sent to the model), at *answer* (the model had it and did not say it), or *stale* (the old fact was given as current). The report also says how many facts the filings stored (`Facts: 24 facts stored from 12 notes`). To see whether splitting notes into facts helps, run once as it is and once with a copy of `controls/` whose `categorise/settings.json` has `"maxFacts": 1` (`--controls DIR`), then `--compare`: the facts that were lost at *replace* are the collateral loss of replacing a whole note. That tells you what to fix: the categoriser's summaries, the context builder, or the wording of the answer controls.

### What it cannot tell you

Invented scenarios show whether the mechanism works, not how real notes behave. Rules can miss a correct answer given in other words, so phrases are written loosely and reviewed. A real run varies, so use repeats and compare runs, not single answers. The replay arm is only a fair upper bound while the transcript fits the window. A real run costs money. The brain now replaces an older note when a newer one changes it (R-014), so the report also shows the cost: a replacing note that does not repeat an unchanged detail (the ward in a moved appointment) takes that detail with it, which the report counts as a fact lost at *replace*. Compare a run with and without `--no-replace` to see both sides. Nothing in this tool changes the brain.

## Running on a Raspberry Pi

A step-by-step runbook for running CaCi on a Raspberry Pi in the house, so family members can try it from phones and laptops on the home Wi-Fi. It is specified in `specs/R-010-pi-deployment.md`. **Nothing here has been run on a real Pi by the person who wrote it**: the tooling is tested with stand-ins, and your first run is the real proof. Run `npm run doctor` when you reach step 7 and keep its output.

What you get: a service that starts at boot and after a power cut, plain HTTP on your home network, the real Anthropic model, **nightly snapshots** of the databases, and **one command** that updates it from GitHub and undoes itself if the new version does not come up.

You need: a Pi 4 or 5 (2 GB or more; a 1 GB Pi may run out of memory while building, so add swap), a good power supply and SD card, Pi OS Lite (64-bit), a way to give the Pi a fixed address on your router, a GitHub account that can read the repository, and an Anthropic API key.

### 1. Prepare the Pi

Flash Pi OS Lite with Raspberry Pi Imager and, in its settings, give the Pi a hostname (for example `pi`), turn on SSH and set your Wi-Fi or use a cable. Start it, `ssh` in, and run `sudo apt update && sudo apt full-upgrade`. Then **give it a fixed address**: in your router, reserve an address for the Pi's network card (a DHCP reservation). The rest of this runbook uses `192.168.1.50` and `pi.local`; use yours. **Some Android phones cannot open `.local` names**: tell the family the numeric address instead, and list both in step 5.

### 2. Install Node 22 and git

CaCi needs Node 22.13 or later, installed for the whole system. Do not pipe a download into a shell: fetch the NodeSource script, read it, then run it.

```
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
less nodesource_setup.sh
sudo bash nodesource_setup.sh
sudo apt install -y nodejs git
node --version
node -e "import('node:sqlite').then(() => console.log('node:sqlite loads'))"
```

The version must be 22.13 or later and the last command must print that it loads (it also prints a warning that `node:sqlite` is experimental; that is expected).

### 3. GitHub access

If the repository is public, skip this. If it is private, make a key that can only **read** it: `ssh-keygen -t ed25519 -f ~/caci_deploy_key -N '' -C caci-pi`, then add `~/caci_deploy_key.pub` in the repository's Settings, Deploy keys (leave "Allow write access" off).

### 4. Install

Fetch the project once to run its install script, then run it first with `--dry-run` to read the plan:

```
git clone https://github.com/andymonis/caci.git ~/caci-src
sudo bash ~/caci-src/deploy/install.sh --dry-run
sudo bash ~/caci-src/deploy/install.sh
```

For a private repository add `--repo git@github.com:andymonis/caci.git --deploy-key ~/caci_deploy_key` to both commands (and clone it the same way with `GIT_SSH_COMMAND='ssh -i ~/caci_deploy_key'`). The script creates the `caci` account (no login), the folders (`/opt/caci/app`, `/var/lib/caci`, `/var/backups/caci`, `/etc/caci`), the checkout, the systemd units and `/etc/caci/caci.env`; it enables the service and the backup timer but starts nothing, and it never overwrites the settings file or any data. Running it again is safe. Afterwards delete the temporary clone and, if you used one, the key copy in your home folder.

### 5. Settings and the key

Edit the settings file with an editor, so the key never lands in your shell history: `sudo nano /etc/caci/caci.env`. Set `ANTHROPIC_API_KEY`, and set `CACI_ALLOWED_HOSTS` to the exact names and addresses the family will type, each with its port, for example `pi.local:8080,192.168.1.50:8080`; the service answers no other `Host`. The file is readable by root and the `caci` account only. The key lives **only** here: it is not in the repository, in a command line, in a snapshot or in the backup service, and neither the deploy command nor `npm run doctor` prints it.

### 6. Build and start

```
sudo -u caci sh -c 'cd /opt/caci/app && npm ci && npm run build'
sudo systemctl start caci
sudo systemctl status caci
sudo journalctl -u caci -f
```

### 7. Check it with the doctor

```
sudo -u caci sh -c 'cd /opt/caci/app && npm run doctor'
```

It prints one line per check (`[PASS]`, `[WARN]`, `[FAIL]`, with what to do under each warning or failure): Node, the settings file's permissions, whether the service runs, whether it answers on the network address and with each allowed `Host`, the snapshots, disk, the clock and how long one password hash takes (scrypt is slow on a Pi). Fix every `[FAIL]`. If something is unclear, paste the output when you ask for help; it never contains the key.

### 8. Limit it to the home network

The service speaks plain HTTP, so only your home network should reach it. With `ufw` (adjust the network to yours, and allow SSH **before** enabling):

```
sudo apt install -y ufw
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
sudo ufw enable
```

(To reach it away from home, step 13 adds one more rule, for the Tailscale interface only; the home rule stays.)

### 9. The first accounts

Open `http://192.168.1.50:8080/admin` on your phone (the back office; `/` is the everyday app). **Register yourself first**: the first account becomes the administrator. Then let the family register. When everyone has an account, set `CACI_ALLOW_REGISTRATION=false` in `/etc/caci/caci.env` and run `sudo systemctl restart caci`. The app is a plain web page, not an installable app: bookmark it.

### 10. Updating

Push to GitHub (run `npm run gate` on your laptop first: the Pi does not run the tests), then on the Pi:

```
sudo node /opt/caci/app/deploy/run.mjs
```

It deploys `origin/main`; give it a branch, tag or commit to deploy another (`sudo node /opt/caci/app/deploy/run.mjs v1.2`). It refuses unless Node is new enough, the checkout is clean and there is room for a snapshot; it **snapshots the data first**, pulls, runs `npm ci` and `npm run build` without touching the running service, restarts, and waits until the page and the API answer. If the new version does not come up it stops the service, puts the previous code back, **restores the snapshot** (an older build cannot read a newer database, so the data goes back too) and starts it again.

| Exit code | Meaning |
|---|---|
| 0 | deployed |
| 10 | failed and rolled back: the previous version is running again |
| 11 | failed and the rollback failed too: the message says what to do by hand |
| 12 | refused before anything changed (bad ref, old Node, local changes, no snapshot) |

An update never changes `/etc/caci/caci.env`. If a change touches the systemd units, run the install script again afterwards.

The words and limits the model is told live in the `controls/` folder of the checkout (see **Controlling what the model is told**): editing them is a commit and this same update. A bad file stops the service from starting, so the update rolls back like any other that does not come up, and `npm run doctor` says which file to fix.

### 11. Snapshots and restoring

The nightly timer is `caci-backup.timer` (02:30; a missed night runs at the next start). Start it once with `sudo systemctl start caci-backup.timer` and check it with `systemctl list-timers caci-backup.timer`. Each snapshot is a folder named by its UTC time in `/var/backups/caci` holding `graphs.db` and `users.db`, taken while the service runs; the newest 14 are kept. To take one now:

```
sudo -u caci sh -c 'cd /opt/caci/app && CACI_DATA_DIR=/var/lib/caci npm run backup -- --dest /var/backups/caci'
```

**The snapshots are on the same SD card as the data**, so a dead card loses both: now and then copy `/var/backups/caci` to your laptop (`scp -r`). To restore a snapshot, stop the service first:

```
sudo systemctl stop caci
sudo -u caci sh -c 'cd /opt/caci/app && CACI_DATA_DIR=/var/lib/caci npm run restore -- /var/backups/caci/20261011T023000Z --yes'
sudo systemctl start caci
```

It checks the snapshot first, copies the files it replaces into a `pre-restore-` folder beside the snapshots, and refuses a snapshot made by a newer version than the one installed.

**Taking a brain off the Pi for testing.** `npm run export-brain` (see [Exporting a brain](#exporting-a-brain)) writes one person's or one circle's brain as JSON. The service account owns the file and the backup folder is owner-only, so write it there and read it with `sudo`:

```
sudo -u caci sh -c 'cd /opt/caci/app && CACI_DATA_DIR=/var/lib/caci npm run export-brain -- --user ann --out /var/backups/caci/ann-export.json'
ssh <pi> 'sudo cat /var/backups/caci/ann-export.json' > ann-export.json
sudo rm /var/backups/caci/ann-export.json
```

The file holds **real notes**: keep it out of the repository and delete the copy on the Pi when you have it.

### 12. Power cuts, a dead card and a forgotten password

After a power cut the Pi starts the service by itself (SQLite recovers its own write-ahead log). Shut down with `sudo shutdown -h now` rather than pulling the plug. If the card dies: new card, repeat steps 1 to 6, then restore a copied snapshot. If the administrator forgets their password, run this on the Pi (it asks twice, without showing what you type, and signs that account out everywhere): `sudo -u caci env CACI_DATA_DIR=/var/lib/caci node /opt/caci/app/scripts/users.mjs recover-admin <username>`.

### 13. Using it away from home with Tailscale

To try the service away from home without exposing the Pi to the internet, use **Tailscale**, a private network between your own devices (specified in `specs/R-010-pi-deployment.md`, D13 to D19). **No router port is opened**: only devices signed in to your tailnet can reach the Pi at all. The service stays exactly as at home (plain HTTP on the Pi, `CACI_BIND=0.0.0.0`, non-Secure cookies); Tailscale encrypts the traffic between your phone and the Pi, and the home Wi-Fi keeps working for the family without Tailscale. This is for **you only** for now. **Never use Tailscale Funnel**: it publishes a service to the whole internet.

1. **The account is the front door.** Sign up at tailscale.com with an identity account you already use, and turn on a **second sign-in step** (two-step verification) at that provider, with a recovery method, before you go further. Anyone who can sign in to it can reach your Pi.
2. **Install Tailscale on the Pi**, from its official script, **fetched, read and then run** (do not pipe a download into a shell):

   ```
   curl -fsSL https://tailscale.com/install.sh -o ~/tailscale-install.sh
   less ~/tailscale-install.sh
   sudo sh ~/tailscale-install.sh
   sudo tailscale up
   ```

   Open the link `tailscale up` prints and sign in. Then `tailscale status` shows the Pi's name, something like `pi.your-tailnet.ts.net`. In the admin console (login.tailscale.com) check that **MagicDNS** is on, and for the Pi you may turn off **key expiry** so it does not drop off the tailnet after a few months.
3. **Tell the service the new name.** The service refuses any `Host` that is not listed, so add the tailnet name and the port beside the home names: edit `/etc/caci/caci.env` (`sudo -e /etc/caci/caci.env`), use the commented line under `CACI_ALLOWED_HOSTS` as the model (for example `CACI_ALLOWED_HOSTS=pi.local:8080,192.168.1.50:8080,pi.your-tailnet.ts.net:8080`), then `sudo systemctl restart caci`. Nothing else in the file changes.
4. **Let the tailnet through the firewall**, that interface and that port only (keep the home rule from step 8):

   ```
   sudo ufw allow in on tailscale0 to any port 8080 proto tcp
   ```

5. **Phone and laptop:** install the Tailscale app, sign in with the same account, and open `http://pi.your-tailnet.ts.net:8080/` (your own name from `tailscale status`). The browser says **Not secure** because the page is plain HTTP: that is expected, the traffic is encrypted by Tailscale on the way.
6. **Check it with the doctor** (step 7). Its **Tailscale** line shows the name and address and the URL to open, **warns if the name is missing from `CACI_ALLOWED_HOSTS`** (with the exact line to set) and **fails if Funnel is on**. If you ever see that failure, run `sudo tailscale serve reset`.

**Turning it off:** `sudo tailscale down` (and `sudo tailscale logout` to remove the Pi from the tailnet), take the tailnet name out of `CACI_ALLOWED_HOSTS` and restart, and `sudo ufw delete allow in on tailscale0 to any port 8080 proto tcp`.

**Adding someone later:** invite them to the tailnet in the admin console (or share the Pi), and for their CaCi account set `CACI_ALLOW_REGISTRATION=true` briefly, restart, let them register, then set it back to `false`. Remember that every account's notes go to Anthropic, unanonymised, and that the release gates stand for anything beyond your own test.

**The HTTPS alternative, not set up here:** `tailscale serve` can put real HTTPS in front of the service (it would need `CACI_BIND=127.0.0.1`, `CACI_COOKIE_SECURE=true` and `CACI_TRUSTED_PROXIES=1`, and then everyone, at home too, would use the tailnet name). It is not the default because it would put the machine and tailnet names in public certificate logs, the family at home would need Tailscale too, and whether it passes on each client's address (the login throttle counts by it) has not been checked. The doctor warns when something is being served.

**The risks:** the identity account behind the tailnet is the front door (step 1); Tailscale's company sees which devices talk to each other and when, but not the content; a lost phone or laptop signed in to the tailnet can reach the Pi until you remove it in the admin console; and the notes still go to Anthropic as before.

**Nothing in this step has been run on a real Pi or tailnet.** After your first try, keep the output of `npm run doctor` and say whether the page opened on mobile data: that is the evidence.

### What goes where, and what leaves the house

| Thing | Where | Who can read it |
|---|---|---|
| Notes, categories, circles, accounts | `/var/lib/caci` (`graphs.db`, `users.db`) | the `caci` account (mode 0700), in plain text |
| Snapshots | `/var/backups/caci` | the `caci` account |
| Settings and the Anthropic key | `/etc/caci/caci.env` | root and the `caci` account |
| Logs | the journal (`journalctl -u caci`) | root; they hold no notes, passwords or key |

**Every account's notes, and the names of its categories, are sent to Anthropic, unanonymised, whenever a note is filed** (`CACI_LLM=anthropic`). Session cookies and everything else cross your Wi-Fi in plain HTTP. This is set up for an internal family test; the release gates in **Shared circle brains** and **The shared circle brain** (pseudonymisation, a data processing agreement, a lawful basis, a risk assessment and a statement of who may use the service) stand for anything wider, and **HTTPS is not part of this setup, and the only remote access is a private Tailscale network (step 13), never a port opened to the internet**.

### Troubleshooting

| Symptom | What to look at |
|---|---|
| The service will not start | `sudo journalctl -u caci -n 50`: usually a missing `ANTHROPIC_API_KEY` or a setting the service refuses (the doctor names it) |
| Works at home, not away from home | the doctor's Tailscale line (is it running, is the name in `CACI_ALLOWED_HOSTS`); the firewall rule for `tailscale0`; that Tailscale is on, and signed in to the same account, on the phone |
| A phone cannot connect | the doctor's "Reachable on the network" and "Host" lines; the firewall; that the address typed is exactly one in `CACI_ALLOWED_HOSTS` |
| The page says forbidden or shows nothing for one name only | that name is not in `CACI_ALLOWED_HOSTS` (an Android phone may need the numeric address) |
| Everything is slow | the doctor's password-hash line; a Pi 3 or a busy card |
| Dates and expiries look wrong | the doctor's clock lines: `sudo timedatectl set-ntp true` |
| A deploy ended with 10, 11 or 12 | the table in step 10; the lines it printed say which step failed |

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
