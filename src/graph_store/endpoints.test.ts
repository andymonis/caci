import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from './adapter.js';
import { createMemoryAdapter } from './adapters/memory/index.js';
import { createGraphClient, query, write } from './endpoints.js';

/** Any use of the adapter fails the test. */
const untouchable = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`adapter was touched: ${String(prop)}`);
    },
  },
) as StorageAdapter;

const mutation = {
  version: 1,
  kind: 'mutation',
  graphId: 'g',
  ops: [{ op: 'upsertNode', partition: 'item', id: 'a' }],
};
const readQuery = { version: 1, graphId: 'g', from: { all: true }, return: { shape: 'count' } };

const garbage: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'hello'],
  ['a number', 7],
  ['an array', []],
  ['a malformed object', { version: 1, kind: 'mutation', ops: 'nope' }],
  ['a throwing getter', { get version(): number { throw new Error('boom'); } }],
];

describe.each([
  ['write', write, mutation],
  ['query', query, readQuery],
] as const)('%s', (name, endpoint, valid) => {
  it.each(garbage)('returns { ok: false } and never throws for %s (AC-10)', async (_label, input) => {
    const r = await endpoint(untouchable, input);
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown version (AC-14)', async () => {
    const r = await endpoint(untouchable, { ...valid, version: 2 });
    expect(r).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
  });
});

describe('query stub', () => {
  it('returns not-implemented for valid input without touching the adapter', async () => {
    const r = await query(untouchable, readQuery);
    expect(r).toMatchObject({ ok: false, error: { message: 'query() is not implemented yet' } });
  });
});

describe('write with a real adapter', () => {
  it('applies a valid mutation (full behaviour is covered in apply-mutation.test.ts)', async () => {
    const adapter = createMemoryAdapter();
    const r = await write(adapter, { ...mutation, createIfMissing: true });
    expect(r).toEqual({ ok: true, value: { graphId: 'g', applied: 1, graphCreated: true } });
  });

  it('returns STORAGE_ERROR instead of throwing when the adapter blows up', async () => {
    const r = await write(untouchable, mutation);
    expect(r).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});

describe('graph id rule at the endpoints', () => {
  it.each(['Graph', 'a/b', '../x', 'a b', 'ünï', ''])('write rejects graphId %j before touching the adapter', async (graphId) => {
    expect(await write(untouchable, { ...mutation, graphId })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['graphId'] },
    });
  });

  it.each(['Graph', 'a/b', '../x', 'a b', 'ünï', ''])('query rejects graphId %j before touching the adapter', async (graphId) => {
    expect(await query(untouchable, { ...readQuery, graphId })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', path: ['graphId'] },
    });
  });

  it('the client rejects bad graph ids for every graph function', async () => {
    const client = createGraphClient(untouchable);
    for (const call of [client.createGraph, client.dropGraph, client.describeGraph]) {
      expect(await call('Bad Id')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['graphId'] } });
    }
  });

  it('nothing is created when the graph id is not allowed, even with createIfMissing', async () => {
    const adapter = createMemoryAdapter();
    const r = await write(adapter, { ...mutation, graphId: 'Not Allowed', createIfMissing: true });
    expect(r.ok).toBe(false);
    expect((await adapter.graphs.list({ limit: 10, cursor: null })).items).toEqual([]);
  });
});

describe('wrong endpoint (AC-20)', () => {
  it('write rejects a query with VALIDATION_ERROR', async () => {
    expect(await write(untouchable, readQuery)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('query rejects a mutation with VALIDATION_ERROR', async () => {
    expect(await query(untouchable, mutation)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('createGraphClient', () => {
  it('returns a frozen client with the two endpoints and the four graph functions', async () => {
    const client = createGraphClient(untouchable);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.keys(client).sort()).toEqual([
      'createGraph',
      'describeGraph',
      'dropGraph',
      'listGraphs',
      'query',
      'write',
    ]);
    expect((await client.write(null)).ok).toBe(false);
    expect((await client.query(readQuery)).ok).toBe(false);
  });

  it('runs a whole lifecycle through the client', async () => {
    const client = createGraphClient(createMemoryAdapter());
    expect(await client.createGraph('g')).toEqual({ ok: true, value: { graphId: 'g' } });
    expect(await client.createGraph('g')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await client.write(mutation)).ok).toBe(true);
    expect(await client.describeGraph('g')).toEqual({
      ok: true,
      value: { graphId: 'g', itemCount: 1, categoryCount: 0, edgeCount: 0 },
    });
    expect(await client.listGraphs()).toEqual({ ok: true, value: { items: ['g'], nextCursor: null } });
    expect(await client.dropGraph('g')).toEqual({ ok: true, value: { graphId: 'g' } });
    expect(await client.listGraphs({ limit: 10 })).toEqual({ ok: true, value: { items: [], nextCursor: null } });
    expect(await client.describeGraph('g')).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('keeps clients on different adapters apart (AC-12 groundwork)', async () => {
    const one = createGraphClient(createMemoryAdapter());
    const two = createGraphClient(createMemoryAdapter());
    await one.createGraph('only-in-one');
    expect(await two.listGraphs()).toEqual({ ok: true, value: { items: [], nextCursor: null } });
  });

  it('returns errors, never exceptions, for bad arguments', async () => {
    const client = createGraphClient(untouchable);
    expect(await client.createGraph('')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(await client.listGraphs({ limit: 0 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});
