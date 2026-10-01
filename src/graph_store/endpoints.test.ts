import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from './adapter.js';
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

  it('returns not-implemented for valid input without touching the adapter', async () => {
    const r = await endpoint(untouchable, valid);
    expect(r).toMatchObject({ ok: false, error: { message: `${name}() is not implemented yet` } });
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
  it('returns a frozen { write, query } bound to the adapter', async () => {
    const client = createGraphClient(untouchable);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.keys(client).sort()).toEqual(['query', 'write']);
    expect((await client.write(null)).ok).toBe(false);
    expect((await client.query(readQuery)).ok).toBe(false);
  });
});
