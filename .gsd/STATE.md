# State

**Milestone:** X1 usage metering complete (T-328 to T-335). Every earlier milestone in `spec.md` is complete: P1, U1, C1, C2, W1 to W3, S1, S2, D1, Q1, K1, B1, V1, F1, N1, N2, L2, L3, T1, G2, G3, H1 Part A.
**Current task:** none.
**Next (needs the owner):** R1 verbs and fact resolution (R-025, T-336 to T-351, planned 2026-11-25) starts with T-336, the owner's review of the committed draft spec (D11 and D12 first). G1 relevant category context (R-021, T-299 to T-304) waits for the owner to confirm R-021's decisions. H1 Parts B and C (T-282 to T-292) are not being pursued since the 2026-11-06 direction change (CaCi is the brain, not a reminder engine); R-020 is withdrawn; R-019 (a better long-term view for an agent surface) is linked in `spec.md` but not planned.
**Last updated:** 2026-11-25

## Position
CaCi (package `bipartite-graph`; TypeScript, Node 22.13+, SQLite via `node:sqlite`) is a bipartite graph store plus the layers above it: LLM capabilities (`categorise`, `status`, controlled by text files in `controls/`), the capture and CaCi controllers, users, circles, scopes, sharing, ledger, usage metering, an agent (MCP, read-only) surface, an HTTP API, the service (wiring, CLI commands) and two plain-JS web apps (`/` everyday app, `/admin` back office). It runs on the owner's Raspberry Pi for the owner and family. `npm run gate` (tsc, eslint, vitest, API Extractor on every entry point) is green: 317 files, about 9,690 tests at X1's close.

The full history, task by task, is in `.gsd/LOG.md` (not imported automatically). The task queue is `.gsd/PLAN.md`; product intent is `spec.md` and `specs/R-001` to `R-024`.

## Standing decisions (short form; reasoning in LOG.md)
- Stack: npm, Vitest, ESLint flat config, `tsc --noEmit`, Zod (the one runtime dependency); the Anthropic SDK is an optional peer dependency; `node:sqlite` behind one wrapper in `src/sqlite/`.
- Graph store adapters are deliberately dumb; the core cascades and enforces integrity. Ordering contract: ids in UTF-16 code-unit order.
- Component boundaries are enforced by `src/boundary.test.ts`; only `src/service/` assembles everything; only `src/api/` imports network modules; the LLM component never reads the environment or files (the service and dev tools do).
- LLM: structured output only, a guard on every reply, one bounded repair, the model never writes deletes (the controller builds them), the three message parts (request, context, controls) are separate and the controls text lives in `controls/`. Preview, then approve: nothing the model proposes is written until a person approves it.
- Security posture: session cookie is the only credential (agent tokens only on `/mcp`), tokens stored as hashes, strict input (unknown fields refused by name), non-members and strangers get the same not-found as a made-up id, role re-read on every request, no secret in any config object, log or response.
- Models: `categorise` on `fast` (Haiku 4.5), `status` on `balanced` (provisional until the real tier comparison is run).
- The proof of concept holds the owner's family data; notes go to Anthropic unanonymised. The release gates (pseudonymisation, a data processing agreement, a lawful basis, a risk assessment, a statement of who may use the service) must be met before any wider use.
- Deployment: plain HTTP on the home Wi-Fi, optional private Tailscale away from home, never a public port; `sudo node /opt/caci/app/deploy/run.mjs` updates over SSH with a snapshot first and rollback.

## Blockers / open questions
- **Owner-run checks not yet done:** the real-model comparisons (`npm run eval -- --capability status|focus`, `npm run brain-eval` with and without `--no-replace`, and with `maxFacts` 1 against 8); the Tailscale hand run on the Pi (the doctor's JSON field names are from memory); a real agent connecting to `/mcp`; the join-link pages in a browser (G3's hand check was not done); `npm run usage` after real use.
- `usage-prices.json` prices only `demo` and Haiku 4.5; Sonnet and Opus calls are reported as unpriced until prices are added.
- Constitution wording (`system_prompt.md` line 45, "M5 onward") is out of date and says the decision log lives in STATE.md; the owner decides whether to change it. Until then, dated decision entries go to `.gsd/LOG.md`.
- Confirm `upsertNode` `replace` semantics (omitted `data` clears) before 1.0.0.
- Privacy: see the release gates above; pseudonymisation is in the Backlog.
- Working tree: `--keep/` (see below) is an ignored stray folder holding a test backup snapshot; deleting it waits for the owner's say.
