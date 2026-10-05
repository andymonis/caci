// Starts the graph explorer against the built library: `npm run dev:explorer`.
// The capture panel uses a free demo model. To let it use the real model, start with
// `npm run dev:explorer -- --real-model` and ANTHROPIC_API_KEY set; the key is read here, once, and never printed.
// Data is in memory unless you start with `--db ./data/caci.db`, which keeps it in a SQLite file.
import { assertLocalDevelopment, createApp } from './app.mjs';
import { openStorage } from './storage.mjs';

assertLocalDevelopment();

const lib = {
  ...(await import('../../dist/graph_store/index.js')),
  ...(await import('../../dist/graph_store/adapters/memory/index.js')),
  ...(await import('../../dist/graph_store/adapters/sqlite/index.js')),
};
const app = await import('../../dist/app/index.js');
const llm = await import('../../dist/llm/index.js');
const testing = await import('../../dist/llm/testing/index.js');
const anthropic = await import('../../dist/llm/anthropic/index.js');

const realModel = process.argv.includes('--real-model');
const key = realModel ? anthropic.readAnthropicKey(process.env) : null;
if (realModel && !key.ok) {
  console.error(`--real-model needs a key: ${key.error.message}. Starting with the demo model only.`);
}

let store;
try {
  store = openStorage(lib, process.argv);
} catch (cause) {
  console.error(cause.message);
  process.exit(1);
}

const explorer = createApp(lib, {
  adapter: store.adapter,
  storage: store.storage,
  capture: {
    createController: app.createController,
    createLlm: llm.createLlm,
    createScriptedModelClient: testing.createScriptedModelClient,
    createAnthropicClient: anthropic.createAnthropicClient,
    realModel,
    ...(key?.ok ? { apiKey: key.value } : {}),
  },
});
const port = await explorer.listen(Number(process.env.GRAPH_EXPLORER_PORT ?? 4317));
console.log(`Graph explorer (local development only): http://127.0.0.1:${port}`);
console.log(`${store.note} Press Ctrl+C to quit.`);
process.on('SIGINT', async () => {
  await explorer.close();
  await store.adapter.close?.();
  process.exit(0);
});
console.log(
  key?.ok
    ? 'Capture can use the real model (a per-request switch). That sends the note and the category names to Anthropic.'
    : 'Capture uses the free demo model.',
);
