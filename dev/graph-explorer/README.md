# Graph Explorer (local development only)

A small web page that draws a graph and redraws it as you change it, so you can *see* the bipartite
store being built up and torn down. Items sit in the left column, categories in the right column, and
links are the curves between them. New nodes and links glow as they arrive, removed ones fade out, and
everything else stays where it is.

**This is a development tool. It is never part of the library or any release.**

- It lives in `dev/`, outside `src/`, so it is not compiled into `dist/`.
- The package publishes only `dist/` and `schema/` (see `files` in `package.json`).
- `dev/not-published.test.mjs` (one test for every dev tool) asks npm what it would publish and fails if anything from `dev/` is in it, and checks that only the shared server kit touches the network modules.
- The server binds `127.0.0.1` only, checks the `Host` and `Origin` headers, and refuses to start when
  `NODE_ENV=production`.
- Data is held in memory and is lost when you stop it.

## Run it

```
npm run dev:explorer
```

then open http://127.0.0.1:4317 (set `GRAPH_EXPLORER_PORT` to change the port). It builds the library
first, because the server uses the real `write`, `query`, `createGraph`, `dropGraph`, `listGraphs` and
`describeGraph` plus the memory adapter. Nothing is faked, and the picture itself is read with one
whole-graph `query()` (a page at a time), so what you see is what a caller of the library would get.

## What you can do

- **Build a graph by hand**: add nodes, link and unlink them, delete nodes (their links go with them).
  Link to a node that doesn't exist and you'll see `NODE_NOT_FOUND` unless "create missing" is ticked.
- **Play a scenario**: step through a prepared sequence of mutations, or press Play and watch it run.
  "All or nothing" shows a mutation whose fourth op fails leaving the graph untouched.
- **Try what gets rejected**: one click sends an item-to-item link, a misspelt field, a graph id with a
  capital and a slash, and so on, and shows the library's error.
- **Send a raw mutation**: paste any mutation JSON and see the result.
- **Run queries**: the Query panel sends any query JSON to the library's `query()` and highlights the matching nodes and links in the picture while everything else fades. Presets cover the common ones: all categories, a count, the first three nodes (then **Next page** follows the cursor), the whole graph as a subgraph, everything about the selected node within 1 or 2 hops, and the items related to a selected item. Click a node first for the presets that need one. Refusals (depth 4, a feature not built yet, a missing graph) appear in red with the library's own message.
- **Click a node or a link** to see its data and remove it. Hover to highlight what it connects to.
- **Read the log**: every request and result, newest first. Open an entry for the full JSON.
- **Auto-refresh** redraws once a second, so changes made from elsewhere (for example `curl`) show up.

## Capture a note

The **Capture a note** panel runs the whole filing flow on the current graph: write a note, press
**Propose**, and the suggested filing is drawn over the graph before anything is written.

- **Dashed** nodes and links are only proposed. A **ringed** category already exists and would be reused.
  The plain summary (new items, new categories, categories reused, links) and the reason appear in the panel.
- The real counts at the top do not change, and the server holds the proposal without writing anything.
- **Approve** writes exactly what was previewed (one all-or-nothing write) and the dashed items turn solid.
  **Reject** discards it and the dashes disappear. A proposal that cannot be applied (the graph changed, or it
  ran out of time) says why and changes nothing.
- A proposal that the preview shows would fail (a link to a category that does not exist) is shown with the reason.

By default a **free demo model** answers: it links the note to the categories whose id or name shares a word
with it, or makes a new category from the note's most common word. It is a stand-in, not a classifier.

To use a real model: `source ./set-key.sh && npm run dev:explorer -- --real-model`. Both the flag and
`ANTHROPIC_API_KEY` are needed; the key is read once at start-up and never sent to the browser. The
"use the real model" switch then becomes available, off by default, per proposal. **A real call sends the
note and the category names to Anthropic and costs money.**

## Layout

| File | Purpose |
| --- | --- |
| `server.mjs` | Entry point: loads the built library and starts the server |
| `capture-model.mjs` | The free demo model for the capture panel |
| `app.mjs` | The explorer's JSON API, mounted on the shared loopback server (`../shared/server-kit.mjs`: host, origin and content-type checks, body limit, file allow-list, production guard) |
| `public/` | The page: `index.html`, `style.css`, `app.js` (rendering and animation), `layout.js` (pure layout and diff logic), `capture.js` (pure helpers: how a proposal is laid over the graph), `scenarios.js` (sample data) |
| `*.test.mjs` | Tests for the API and the layout logic (the server kit and the "never published" guarantees are tested in `../shared/` and `../`) |

The page uses no libraries and loads nothing from the network.
