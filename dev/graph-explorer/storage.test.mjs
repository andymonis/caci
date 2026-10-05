import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as appLayer from '../../src/app/index.ts';
import { createMemoryAdapter } from '../../src/graph_store/adapters/memory/index.ts';
import { createSqliteAdapter } from '../../src/graph_store/adapters/sqlite/index.ts';
import * as library from '../../src/graph_store/index.ts';
import * as llm from '../../src/llm/index.ts';
import * as testing from '../../src/llm/testing/index.ts';
import { createApp } from './app.mjs';
import { resetLabels, resetTitle, storageLabel } from './public/storage.js';
import { dbPathFrom, openStorage } from './storage.mjs';

const lib = { ...library, createMemoryAdapter, createSqliteAdapter };
const dirs = [];
const stops = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-explorer-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts an explorer the way server.mjs does, for the given argv; returns a caller. */
async function start(argv, capture = true) {
  const store = openStorage(lib, argv);
  const explorer = createApp(lib, {
    adapter: store.adapter,
    storage: store.storage,
    ...(capture ? { capture: { createController: appLayer.createController, createLlm: llm.createLlm, createScriptedModelClient: testing.createScriptedModelClient } } : {}),
  });
  const base = `http://127.0.0.1:${await explorer.listen(0)}`;
  stops.push(async () => {
    await explorer.close();
    await store.adapter.close?.();
  });
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const stop = async () => {
    stops.pop();
    await explorer.close();
    await store.adapter.close?.();
  };
  return { call, store, stop };
}
const write = (call, ops) => call('/api/write', 'POST', { version: 1, kind: 'mutation', graphId: 'notes', createIfMissing: true, ops });
const upsert = (partition, id, data) => ({ op: 'upsertNode', partition, id, mode: 'replace', ...(data ? { data } : {}) });

describe('--db', () => {
  it('reads the path after --db, and nothing without the flag', () => {
    expect(dbPathFrom(['node', 'server.mjs'])).toBeNull();
    expect(dbPathFrom(['node', 'server.mjs', '--db', './data/x.db', '--real-model'])).toBe('./data/x.db');
  });

  it.each([[['--db']], [['--db', '']], [['--db', '--real-model']]])('refuses a missing value: %j', (argv) => {
    expect(() => dbPathFrom(argv)).toThrow(/--db needs a file path/);
  });

  it('without it the store is memory, and says so', () => {
    const { storage, note, adapter } = openStorage(lib, []);
    expect(storage).toEqual({ kind: 'memory' });
    expect(adapter.name).toBe('memory');
    expect(note).toMatch(/lost when this stops/);
  });

  it('with it the store is that SQLite file, and says which one and that it persists', async () => {
    const path = join(tmp(), 'caci.db');
    const { storage, note, adapter } = openStorage(lib, ['--db', path]);
    expect(adapter.name).toBe('sqlite');
    expect(storage).toEqual({ kind: 'sqlite', path });
    expect(note).toContain(path);
    expect(note).toMatch(/still there after a restart/);
    expect(note).toMatch(/not encrypted/);
    await adapter.close();
  });

  it('makes a missing folder (owner-only) and says so', async () => {
    const dir = join(tmp(), 'data');
    const { note, adapter } = openStorage(lib, ['--db', join(dir, 'caci.db')]);
    expect(note).toContain(`created ${dir}`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await adapter.close();
  });

  it('a bad path is a clear error naming the path, and starts nothing', () => {
    const dir = tmp();
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x');
    expect(() => openStorage(lib, ['--db', join(blocker, 'caci.db')])).toThrow(/cannot use the database ".*caci\.db"/);
  });

  it('a file that is not a database is refused and left as it was', () => {
    const path = join(tmp(), 'notes.txt');
    writeFileSync(path, 'my notes '.repeat(200));
    const before = readFileSync(path);
    expect(() => openStorage(lib, ['--db', path])).toThrow(/is not a SQLite database/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('the explorer on a database file', () => {
  it('data written through the API is still there after the server is stopped and started again', async () => {
    const path = join(tmp(), 'caci.db');
    const first = await start(['--db', path]);
    expect((await write(first.call, [upsert('category', 'health', { name: 'Health' }), upsert('item', 'n1', { title: 'One' }), { op: 'link', item: 'n1', category: 'health' }])).json.ok).toBe(true);
    await first.stop();

    const second = await start(['--db', path]);
    const graph = (await second.call('/api/graphs/notes')).json.value;
    expect(graph.items.map((i) => i.id)).toEqual(['n1']);
    expect(graph.categories.map((c) => c.id)).toEqual(['health']);
    expect(graph.edges).toHaveLength(1);
    expect((await second.call('/api/graphs')).json.value.items).toEqual(['notes']);
  });

  it('a capture approved before the restart is still there after it', async () => {
    const path = join(tmp(), 'caci.db');
    const first = await start(['--db', path]);
    await write(first.call, [upsert('category', 'health', { name: 'Health' })]);
    const proposal = await first.call('/api/capture/propose', 'POST', { graphId: 'notes', text: 'health check on Tuesday' });
    expect(proposal.json.ok).toBe(true);
    expect((await first.call('/api/capture/approve', 'POST', { id: proposal.json.value.id })).json.ok).toBe(true);
    const before = (await first.call('/api/graphs/notes')).json.value;
    expect(before.items).toHaveLength(1);
    await first.stop();

    const second = await start(['--db', path]);
    expect((await second.call('/api/graphs/notes')).json.value).toEqual(before);
  });

  it('a proposal that was not approved does not survive the restart, and writes nothing', async () => {
    const path = join(tmp(), 'caci.db');
    const first = await start(['--db', path]);
    await write(first.call, [upsert('category', 'health', { name: 'Health' })]);
    const proposal = await first.call('/api/capture/propose', 'POST', { graphId: 'notes', text: 'health check' });
    await first.stop();
    const second = await start(['--db', path]);
    expect((await second.call('/api/capture/approve', 'POST', { id: proposal.json.value.id })).json.error.code).toBe('PROPOSAL_NOT_FOUND');
    expect((await second.call('/api/graphs/notes')).json.value.items).toEqual([]);
  });

  it('reset deletes every graph in the file, and the file stays usable', async () => {
    const path = join(tmp(), 'caci.db');
    const first = await start(['--db', path]);
    await write(first.call, [upsert('item', 'a')]);
    await first.call('/api/graphs', 'POST', { graphId: 'other' });
    expect((await first.call('/api/graphs')).json.value.items).toEqual(['notes', 'other']);
    expect((await first.call('/api/reset', 'POST', {})).json.ok).toBe(true);
    expect((await first.call('/api/graphs')).json.value.items).toEqual([]);
    await first.stop();

    const second = await start(['--db', path]); // empty after a restart too
    expect((await second.call('/api/graphs')).json.value.items).toEqual([]);
    expect((await write(second.call, [upsert('item', 'again')])).json.ok).toBe(true);
  });

  it('reset also empties more graphs than one page', async () => {
    const first = await start(['--db', join(tmp(), 'caci.db')], false);
    for (let i = 0; i < 12; i++) await first.call('/api/graphs', 'POST', { graphId: `g${String(i).padStart(2, '0')}` });
    await first.call('/api/reset', 'POST', {});
    expect((await first.call('/api/graphs')).json.value.items).toEqual([]);
  });

  it('a reset that cannot drop a graph says so instead of claiming success', async () => {
    const inner = createMemoryAdapter();
    const broken = { ...inner, graphs: { ...inner.graphs, drop: async () => { throw new Error('disk on fire'); } } };
    const explorer = createApp(lib, { adapter: broken });
    const base = `http://127.0.0.1:${await explorer.listen(0)}`;
    stops.push(() => explorer.close());
    await inner.graphs.create('g');
    const result = await (await fetch(base + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(await inner.graphs.exists('g')).toBe(true);
  });

  it('tells the page where the data lives', async () => {
    const path = join(tmp(), 'caci.db');
    const sqlite = await start(['--db', path], false);
    expect((await sqlite.call('/api/storage')).json).toEqual({ ok: true, value: { kind: 'sqlite', path } });
    const memory = await start([], false);
    expect((await memory.call('/api/storage')).json).toEqual({ ok: true, value: { kind: 'memory' } });
  });

  it('in memory a reset still forgets everything', async () => {
    const memory = await start([], false);
    await write(memory.call, [upsert('item', 'a')]);
    await memory.call('/api/reset', 'POST', {});
    expect((await memory.call('/api/graphs')).json.value.items).toEqual([]);
  });
});

describe('what the page says', () => {
  const sqlite = { kind: 'sqlite', path: '/home/me/caci.db' };
  it('names the file when data is saved, and says memory otherwise', () => {
    expect(storageLabel(sqlite)).toBe('saved to /home/me/caci.db');
    expect(storageLabel({ kind: 'memory' })).toBe('in memory');
    expect(storageLabel(undefined)).toBe('in memory');
  });

  it('the reset button says it deletes the file\'s graphs, and the second click says DELETE', () => {
    expect(resetLabels(sqlite)).toEqual({ idle: 'Delete all graphs in the file', armed: 'Click again to DELETE every graph in the file' });
    expect(resetLabels({ kind: 'memory' })).toEqual({ idle: 'Reset everything', armed: 'Click again to confirm' });
  });

  it('the tooltip names the file and warns it cannot be undone', () => {
    expect(resetTitle(sqlite)).toContain('/home/me/caci.db');
    expect(resetTitle(sqlite)).toMatch(/cannot be undone/);
    expect(resetTitle({ kind: 'memory' })).toBe('Forget every graph and start again');
  });
});
