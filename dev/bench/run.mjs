// `npm run bench:sqlite`: see README.md. Uses the built library; a real database file in a temp folder, removed afterwards.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { assertLocalDevelopment } from '../shared/server-kit.mjs';
import { main } from './cli.mjs';

assertLocalDevelopment('The benchmark');

const graph = await import('../../dist/graph_store/index.js');
const memory = await import('../../dist/graph_store/adapters/memory/index.js');
const sqlite = await import('../../dist/graph_store/adapters/sqlite/index.js');

const lib = { createGraph: graph.createGraph, write: graph.write, query: graph.query, describeGraph: graph.describeGraph };

const code = await main({
  argv: process.argv.slice(2),
  lib,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  nodeVersion: process.version,
  now: () => performance.now(),
  stamp: () => new Date().toISOString().replace(/[:.]/g, '-'),
  makeAdapter: async (name) => {
    if (name === 'memory') return { adapter: memory.createMemoryAdapter(), dispose: async () => {} };
    const dir = mkdtempSync(join(tmpdir(), 'caci-bench-'));
    const adapter = sqlite.createSqliteAdapter({ path: join(dir, 'bench.db') });
    return { adapter, dispose: async () => { await adapter.close(); rmSync(dir, { recursive: true, force: true }); } };
  },
  save: async (results) => {
    const dir = resolve('bench-results');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${results.when}-sqlite-bench.json`);
    await writeFile(file, JSON.stringify(results, null, 2));
    return file;
  },
});
process.exit(code);
