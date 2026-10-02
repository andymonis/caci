import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from './adapters/memory/index.js';
import type { StorageAdapter } from './adapter.js';
import { write } from './endpoints.js';
import { createGraph, dropGraph, planCreateGraph, requireGraph, validateGraphId } from './graphs.js';

describe('validateGraphId (pure)', () => {
  it.each([
    ['a'],
    ['0'],
    ['user_42'],
    ['a-b_c-9'],
    ['9starts-with-digit'],
    ['x'.repeat(128)],
  ])('accepts %s', (id) => {
    expect(validateGraphId(id)).toEqual({ ok: true, value: id });
  });

  it.each([
    ['empty', ''],
    ['upper case', 'Graph'],
    ['a slash', 'a/b'],
    ['a parent path', '../x'],
    ['a dot', 'a.b'],
    ['only dots', '..'],
    ['a space', 'a b'],
    ['a trailing space', 'a '],
    ['a backslash', 'a\\b'],
    ['non-ASCII text', 'ünï'],
    ['an emoji', 'a😀'],
    ['a leading dash', '-a'],
    ['a leading underscore', '_a'],
    ['a newline', 'a\nb'],
    ['a NUL character', 'a\u0000b'],
    ['129 characters', 'x'.repeat(129)],
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['an array', ['g']],
  ])('rejects %s with a path to graphId', (_name, bad) => {
    expect(validateGraphId(bad)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', path: ['graphId'] } });
  });

  it('says what is allowed in the message', () => {
    const r = validateGraphId('Bad Id');
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('lowercase letters, digits') } });
  });

  it('still honours a smaller custom length limit', () => {
    expect(validateGraphId('abcd', { maxIdLength: 3 }).ok).toBe(false);
    expect(validateGraphId('abc', { maxIdLength: 3 }).ok).toBe(true);
  });
});

describe('planCreateGraph / requireGraph (pure)', () => {
  it('create: CONFLICT only when the graph exists', () => {
    expect(planCreateGraph('g', false)).toEqual({ ok: true, value: undefined });
    expect(planCreateGraph('g', true)).toMatchObject({ ok: false, error: { code: 'CONFLICT', path: ['graphId'] } });
  });

  it('drop: GRAPH_NOT_FOUND only when the graph is missing', () => {
    expect(requireGraph('g', true)).toEqual({ ok: true, value: undefined });
    expect(requireGraph('g', false)).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND', path: ['graphId'] } });
  });
});

/** Records lifecycle calls made through an adapter. */
function spied(real = createMemoryAdapter()) {
  const calls = { exists: [] as string[], create: [] as string[], drop: [] as string[] };
  const adapter: StorageAdapter = {
    ...real,
    graphs: {
      ...real.graphs,
      exists: (id) => (calls.exists.push(id), real.graphs.exists(id)),
      create: (id) => (calls.create.push(id), real.graphs.create(id)),
      drop: (id) => (calls.drop.push(id), real.graphs.drop(id)),
    },
  };
  return { adapter, real, calls };
}

const untouchable = new Proxy({}, { get() { throw new Error('adapter was touched'); } }) as StorageAdapter;
const withData = (graphId: string, tag: string) => ({
  version: 1,
  kind: 'mutation',
  graphId,
  ops: [
    { op: 'upsertNode', partition: 'item', id: 'note', data: { tag } },
    { op: 'upsertNode', partition: 'category', id: 'topic' },
    { op: 'link', item: 'note', category: 'topic', weight: 1 },
  ],
});
const contents = (adapter: StorageAdapter, graphId: string) =>
  adapter.transaction(graphId, async (tx) => ({
    items: await tx.getNodes('item', ['note']),
    categories: await tx.getNodes('category', ['topic']),
    edges: (await tx.edgesOf('item', 'note', { limit: 10, cursor: null })).items,
  }));

describe('createGraph', () => {
  it('creates an empty graph that writes can then use without createIfMissing', async () => {
    const adapter = createMemoryAdapter();
    expect(await createGraph(adapter, 'g')).toEqual({ ok: true, value: { graphId: 'g' } });
    expect(await adapter.graphs.exists('g')).toBe(true);
    expect((await write(adapter, withData('g', 'a'))).ok).toBe(true);
  });

  it('fails with CONFLICT for an existing graph and leaves its data untouched', async () => {
    const { adapter, calls } = spied();
    await createGraph(adapter, 'g');
    await write(adapter, withData('g', 'keep'));
    calls.create.length = 0;
    expect(await createGraph(adapter, 'g')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(calls.create).toEqual([]);
    expect((await contents(adapter, 'g')).items[0]?.data).toEqual({ tag: 'keep' });
  });

  it('does not touch other graphs', async () => {
    const adapter = createMemoryAdapter();
    await createGraph(adapter, 'a');
    await write(adapter, withData('a', 'x'));
    await createGraph(adapter, 'b');
    expect((await contents(adapter, 'a')).items).toHaveLength(1);
    expect((await contents(adapter, 'b')).items).toEqual([]);
  });

  it.each([['empty', ''], ['upper case', 'Graph'], ['a slash', 'a/b'], ['too long', 'x'.repeat(129)], ['a number', 7], ['null', null]])(
    'rejects %s with VALIDATION_ERROR and never touches the adapter',
    async (_name, bad) => {
      expect(await createGraph(untouchable, bad as string)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    },
  );

  it('turns adapter failures into STORAGE_ERROR instead of throwing', async () => {
    const real = createMemoryAdapter();
    const failingCreate: StorageAdapter = { ...real, graphs: { ...real.graphs, create: async () => { throw new Error('disk full'); } } };
    expect(await createGraph(failingCreate, 'g')).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('disk full') },
    });
    expect(await createGraph(untouchable, 'g')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});

describe('dropGraph', () => {
  it('removes the graph', async () => {
    const adapter = createMemoryAdapter();
    await createGraph(adapter, 'g');
    expect(await dropGraph(adapter, 'g')).toEqual({ ok: true, value: { graphId: 'g' } });
    expect(await adapter.graphs.exists('g')).toBe(false);
    expect(await write(adapter, withData('g', 'x'))).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
  });

  it('removes all nodes and edges: a recreated graph is empty (FR-01)', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, { ...withData('g', 'x'), createIfMissing: true });
    expect((await contents(adapter, 'g')).edges).toHaveLength(1);
    await dropGraph(adapter, 'g');
    await createGraph(adapter, 'g');
    expect(await contents(adapter, 'g')).toEqual({ items: [], categories: [], edges: [] });
  });

  it('leaves other graphs intact, even with identical ids (AC-01 groundwork)', async () => {
    const adapter = createMemoryAdapter();
    await write(adapter, { ...withData('a', 'from-a'), createIfMissing: true });
    await write(adapter, { ...withData('b', 'from-b'), createIfMissing: true });
    await dropGraph(adapter, 'a');
    expect(await adapter.graphs.exists('a')).toBe(false);
    const b = await contents(adapter, 'b');
    expect(b.items[0]?.data).toEqual({ tag: 'from-b' });
    expect(b.edges).toHaveLength(1);
  });

  it('fails with GRAPH_NOT_FOUND for a missing graph and drops nothing', async () => {
    const { adapter, calls } = spied();
    await createGraph(adapter, 'other');
    expect(await dropGraph(adapter, 'missing')).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
    expect(calls.drop).toEqual([]);
    expect(await adapter.graphs.exists('other')).toBe(true);
  });

  it.each([['empty', ''], ['upper case', 'Graph'], ['a dot', 'a.b'], ['too long', 'x'.repeat(129)], ['undefined', undefined]])(
    'rejects %s with VALIDATION_ERROR and never touches the adapter',
    async (_name, bad) => {
      expect(await dropGraph(untouchable, bad as unknown as string)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    },
  );

  it('turns adapter failures into STORAGE_ERROR instead of throwing', async () => {
    const real = createMemoryAdapter();
    await real.graphs.create('g');
    const failingDrop: StorageAdapter = { ...real, graphs: { ...real.graphs, drop: async () => { throw new Error('locked'); } } };
    expect(await dropGraph(failingDrop, 'g')).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: expect.stringContaining('locked') },
    });
    expect(await real.graphs.exists('g')).toBe(true);
    expect(await dropGraph(untouchable, 'g')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});
