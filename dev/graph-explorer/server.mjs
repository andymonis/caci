// Starts the graph explorer against the built library: `npm run dev:explorer`.
import { assertLocalDevelopment, createApp } from './app.mjs';

assertLocalDevelopment();

const lib = {
  ...(await import('../../dist/graph_store/index.js')),
  ...(await import('../../dist/graph_store/adapters/memory/index.js')),
};

const app = createApp(lib);
const port = await app.listen(Number(process.env.GRAPH_EXPLORER_PORT ?? 4317));
console.log(`Graph explorer (local development only): http://127.0.0.1:${port}`);
console.log('Data lives in memory and is lost when this stops. Press Ctrl+C to quit.');
