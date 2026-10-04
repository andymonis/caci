# LLM lab (local development only)

A small local server for trying the LLM component: run a note through `categorise`, see exactly what
was sent and what came back, and compare models. **It is never part of the library or the published
package**, and it only listens on `127.0.0.1` (the server and its safety checks are the shared kit in
`../shared/server-kit.mjs`).

```
npm run dev:lab          # http://127.0.0.1:4318   (LLM_LAB_PORT to change the port)
```

The page itself arrives in the next task; for now the API is usable with `curl`.

## The scripted model is the default

Every run uses a scripted model unless you explicitly ask for a real one. A scenario chooses how the
scripted model behaves, so every path through `categorise` can be seen without spending anything:

| Scenario | What happens |
| --- | --- |
| `good` (default) | A correct answer, reusing the first existing category (or creating `inbox`) |
| `good-new-category` | A correct answer that creates a new category |
| `repaired` | A rejected first answer, then a correct one after the repair attempt |
| `rejected-twice` | Two rejected answers: `BAD_OUTPUT` |
| `link-missing-category` | Accepted by the guard, but the preview reports a problem |
| `prose` | Prose instead of JSON: `BAD_OUTPUT` from the client, no repair |
| `refusal` | `REFUSED` |
| `rate-limited` | `RATE_LIMITED`, retry after 1.5 s |
| `server-error` | A retryable `MODEL_ERROR` |
| `hangs` | Never answers: `TIMEOUT` (the lab uses a 1.5 s limit for this one) |

## The real model

A real call happens only when **both** are true:

1. `ANTHROPIC_API_KEY` was set in the environment when the lab started. It is read once, at start-up, and
   held in the server; it is never sent to the browser, never printed, and removed from anything the
   server returns, even if a provider error echoes it.
2. The request says `"network": true`. A key being present is not enough.

A real call **sends the note and the category names to Anthropic** and costs money. Without a key,
`"network": true` is refused with `409`. A scenario cannot be combined with a real call.

## API

| Route | Does |
| --- | --- |
| `GET /api/status` | Capabilities, tiers and their models, routes, scenarios, limits, and whether a real call is possible (never the key) |
| `POST /api/run` | One run. Body: `text`, optional `categories` (`[{ id, data?, linkCount? }]`), `tier` or `model`, `scenario`, `network`, `timeoutMs`, `graphId`, `itemId`, `capability` |
| `POST /api/compare` | The same input over `models` (1 to 6 choices like `{ "tier": "fast" }` or `{ "model": "..." }`), in turn; one failing does not stop the others |
| `GET /api/history` | The last 50 runs, newest first, each with its full trace |
| `DELETE /api/history` | Clears it |

A run returns a record: `{ id, at, mode, scenario, asked, model, note, categories, trace, result, latencyMs, usage }`.
`trace` is the list of events from `categorise` (prompt, request, response or failure, verdict with every
problem, repair, done). `result` is `{ ok: true, proposal: { mutation, rationale, attempts, usage, model, summary, text } }`
or `{ ok: false, error }`; a failure of the component itself is data in the record, not an HTTP error. Only
a badly shaped request is `400`.

```
curl -s -X POST -H 'content-type: application/json' http://127.0.0.1:4318/api/run \
  -d '{"text":"Dentist on Friday at 9","categories":[{"id":"health"}],"scenario":"repaired","tier":"balanced"}'
```

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | Entry point: loads the built library, reads the key (once), starts the server |
| `app.mjs` | The routes, on the shared loopback server |
| `scenarios.mjs` | The scripted behaviours |
| `public/` | The page |
| `*.test.mjs` | Tests; `../not-published.test.mjs` guards the "never published" and "loopback only" rules |
