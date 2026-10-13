import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, write, type StorageAdapter } from '../graph_store/index.js';
import type { Provenance, ResolvedScope } from '../scopes/index.js';
import { createStatusContext, DEFAULT_STATUS_CONTEXT_LIMITS, timeOf, whereOf } from './status-context.js';

const NOW = Date.UTC(2026, 9, 15, 7, 30, 0);
const DAY = 86_400_000;
const ME: Provenance = { kind: 'personal' };
const PARENT: Provenance = { kind: 'circle', circleId: 'c0000000000000001', circleName: 'Parent care' };
const INLAW: Provenance = { kind: 'circle', circleId: 'c0000000000000002', circleName: 'In-law' };
const scope = (graphId: string, provenance: Provenance, role?: 'owner' | 'observer'): ResolvedScope => ({ userId: 'u0000000000000001', scope: provenance.kind === 'personal' ? { kind: 'personal' } : { kind: 'circle', circleId: provenance.circleId }, graphId, provenance, ...(role === undefined ? {} : { role }) }) as ResolvedScope;
const READABLE = [scope('mine', ME), scope('parent', PARENT, 'owner'), scope('inlaw', INLAW, 'observer')];

type Item = { id: string; data?: Record<string, unknown>; categories?: Array<{ id: string; name?: string }> };
async function fill(adapter: StorageAdapter, graphId: string, items: Item[]): Promise<void> {
  await createGraph(adapter, graphId);
  const ops: unknown[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    ops.push({ op: 'upsertNode', partition: 'item', id: item.id, data: item.data ?? { title: item.id } });
    for (const c of item.categories ?? []) {
      if (!seen.has(c.id)) ops.push({ op: 'upsertNode', partition: 'category', id: c.id, data: c.name === undefined ? {} : { name: c.name } });
      seen.add(c.id);
      ops.push({ op: 'link', item: item.id, category: c.id, weight: 0.9 });
    }
  }
  for (let at = 0; at < ops.length; at += 500) {
    const r = await write(adapter, { version: 1, kind: 'mutation', graphId, ops: ops.slice(at, at + 500) as never });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
}
const minted = (ms: number, tail = 'aa-abcdef'): string => `note-${ms.toString(36).padStart(9, '0')}-${tail}`;
const read = async (adapter: StorageAdapter, readable = READABLE, limits = {}) => {
  const r = await createStatusContext(adapter, limits).read(readable, NOW);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** Counts every call that could change a graph. */
function recording(inner: StorageAdapter) {
  const writes: string[] = [];
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver) as unknown;
        if (typeof key === 'string' && /^(putNodes|deleteNodes|putEdges|deleteEdges|create|drop)$/.test(key)) return (...args: unknown[]) => (writes.push(key), (value as (...a: unknown[]) => unknown).apply(t, args));
        if (typeof value === 'function') return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(t, args);
          if (key === 'transaction' && typeof args[1] === 'function') return (out as Promise<unknown>);
          return out;
        };
        return typeof value === 'object' && value !== null && key === 'graphs' ? guard(value) : value;
      },
    });
  return { adapter: guard(inner), writes };
}

describe('the entries of a status request', () => {
  it('are the items of every readable scope, newest first, numbered by position, each with where it came from', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [
      { id: minted(NOW - 1 * DAY), data: { title: 'Dentist', summary: 'Friday morning at 9' } },
      { id: minted(NOW - 5 * DAY), data: { title: 'Flowers', summary: 'Buy some' } },
    ]);
    await fill(a, 'parent', [{ id: 'x1', data: { title: 'New tablets', summary: 'One a day with food', contributedBy: 'u9999999999999999', contributedAt: NOW - 2 * DAY } }]);
    await fill(a, 'inlaw', [{ id: 'y1', data: { title: 'Visit', summary: 'Sunday lunch', contributedAt: NOW - 3 * DAY } }]);
    const c = await read(a);
    expect(c.entries.map((e) => e.text)).toEqual(['Dentist: Friday morning at 9', 'New tablets: One a day with food', 'Visit: Sunday lunch', 'Flowers: Buy some']);
    expect(c.entries.map((e) => e.where)).toEqual(['personal', 'circle "Parent care"', 'circle "In-law"', 'personal']);
    expect(c.provenance).toEqual([ME, PARENT, INLAW, ME]);
    expect(c.entries.map((e) => e.when)).toEqual([NOW - DAY, NOW - 2 * DAY, NOW - 3 * DAY, NOW - 5 * DAY]);
    expect(c.entriesLeftOut).toBe(0);
    expect(Object.isFrozen(c) && Object.isFrozen(c.entries) && Object.isFrozen(c.entries[0])).toBe(true);
  });

  it('never carry who contributed an item (a user id), only what it says', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'parent', [{ id: 'x1', data: { title: 'T', summary: 'S', contributedBy: 'u1234567890abcdef', contributedAt: NOW - DAY } }]);
    const c = await read(a, [scope('parent', PARENT, 'owner')]);
    expect(JSON.stringify(c)).not.toContain('u1234567890abcdef');
    expect(JSON.stringify(c)).not.toContain('contributed');
  });

  it('say which categories an item is filed under, by name (the id when it has none)', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW - DAY), data: { title: 'Tablets', summary: 'one a day' }, categories: [{ id: 'health', name: 'Health' }, { id: 'meds' }] }]);
    const c = await read(a, [scope('mine', ME)]);
    expect(c.entries[0]?.text).toBe('Tablets: one a day; filed under Health, meds');
  });

  it('keep other data as short key: value text, at most five keys, and cut long values', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T', summary: 'S', place: 'Kitchen', count: 3, nested: { a: 1 }, long: 'x'.repeat(500), k5: 'e', k6: 'f', k7: 'g' } }]);
    const text = (await read(a, [scope('mine', ME)])).entries[0]?.text ?? '';
    expect(text).toContain('place: Kitchen');
    expect(text).toContain('count: 3');
    expect(text).toContain('nested: {"a":1}');
    expect(text).toContain(`long: ${'x'.repeat(100)}`);
    expect(text).not.toContain('x'.repeat(101));
    expect(text).not.toContain('k7');
  });

  it('turn awkward text into one line: control characters, line breaks and tabs become single spaces', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'Line\none\u0007', summary: 'two\tthree\r\nfour' } }]);
    const text = (await read(a, [scope('mine', ME)])).entries[0]?.text ?? '';
    expect(text).toBe('Line one: two three four');
  });

  it('use title or summary alone when only one is there, and "(no text)" for an item with neither', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [
      { id: minted(NOW - 1), data: { summary: 'only a summary' } },
      { id: minted(NOW - 2), data: { title: 'only a title' } },
      { id: minted(NOW - 3), data: {} },
      { id: minted(NOW - 4), data: { title: '   ', summary: '' } },
    ]);
    expect((await read(a, [scope('mine', ME)])).entries.map((e) => e.text)).toEqual(['only a summary', 'only a title', '(no text)', '(no text)']);
  });

  it('cut one entry\'s text by characters, never in the middle of an emoji', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T', summary: '😀'.repeat(500) } }]);
    const text = (await read(a, [scope('mine', ME)], { maxEntryChars: 51 })).entries[0]?.text ?? '';
    expect([...text]).toHaveLength(51);
    expect((text as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
  });
});

describe('details of an entry\'s text', () => {
  it('cuts a title at 120 characters and a summary at 300', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T'.repeat(200), summary: 'S'.repeat(500) } }]);
    const text = (await read(a, [scope('mine', ME)])).entries[0]?.text ?? '';
    expect(text).toBe(`${'T'.repeat(120)}: ${'S'.repeat(300)}`);
  });
  it('skips other data that is empty', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T', summary: 'S', blank: '', spaces: '   ', other: 'x' } }]);
    expect((await read(a, [scope('mine', ME)])).entries[0]?.text).toBe('T: S; other: x');
  });
  it('lists at most eight categories, sorted by name', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T', summary: 'S' }, categories: ['Zed', 'Mid', 'Alpha', ...Array.from({ length: 9 }, (_, i) => `Cat${i}`)].map((name, i) => ({ id: `c${i}`, name })) }]);
    const text = (await read(a, [scope('mine', ME)])).entries[0]?.text ?? '';
    expect(text).toBe('T: S; filed under Alpha, Cat0, Cat1, Cat2, Cat3, Cat4, Cat5, Cat6');
  });
  it('finds the categories of every chosen item, not just the first fifty', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', Array.from({ length: 120 }, (_, i) => ({ id: minted(NOW - i * 1000), data: { title: `n${i}` }, categories: [{ id: 'all', name: 'Everything' }] })));
    const c = await read(a, [scope('mine', ME)], { maxTotalChars: 100_000 });
    expect(c.entries).toHaveLength(120);
    expect(c.entries.every((e) => e.text.endsWith('filed under Everything'))).toBe(true);
  });
});

describe('what is left out, and why', () => {
  it('stops at the first entry that does not fit, so what is used is always the newest, even if an older one is small', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [
      { id: minted(NOW - 1000), data: { title: 'newest', summary: 'short' } },
      { id: minted(NOW - 2000), data: { title: 'big', summary: 'x'.repeat(350) } },
      { id: minted(NOW - 3000), data: { title: 'older', summary: 'small' } },
    ]);
    const c = await read(a, [scope('mine', ME)], { maxTotalChars: 340 });
    expect(c.entries.map((e) => e.text)).toEqual(['newest: short']);
    expect(c.entriesLeftOut).toBe(2);
  });
  it('counts where an entry came from towards the budget', async () => {
    const a = createMemoryAdapter();
    const long: Provenance = { kind: 'circle', circleId: 'c0000000000000009', circleName: 'N'.repeat(60) };
    await fill(a, 'g', Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, data: { title: 'x', contributedAt: NOW - i * 1000 } })));
    const c = await read(a, [scope('g', long, 'owner')], { maxTotalChars: 250 });
    expect(c.entries).toHaveLength(2);
  });
  it('stays within the character budget, taking the newest first, and counts the rest as left out', async () => {
    const a = createMemoryAdapter();
    const items = Array.from({ length: 30 }, (_, i) => ({ id: minted(NOW - i * 1000), data: { title: `note ${i}`, summary: 'y'.repeat(100) } }));
    await fill(a, 'mine', items);
    const c = await read(a, [scope('mine', ME)], { maxTotalChars: 1000 });
    expect(c.entries.length).toBeGreaterThan(3);
    expect(c.entries.length).toBeLessThan(30);
    expect(c.entries.map((e) => e.text.split(':')[0])).toEqual(items.slice(0, c.entries.length).map((_, i) => `note ${i}`));
    expect(c.entriesLeftOut).toBe(30 - c.entries.length);
    const used = c.entries.reduce((n, e) => n + e.text.length + e.where.length, 0);
    expect(used).toBeLessThanOrEqual(1000);
  });

  it('only the newest items of each scope are candidates (the cap per scope)', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', Array.from({ length: 12 }, (_, i) => ({ id: minted(NOW - i * 1000), data: { title: `n${i}` } })));
    const c = await read(a, [scope('mine', ME)], { maxPerScope: 5 });
    expect(c.entries.map((e) => e.text)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(c.entriesLeftOut).toBe(7);
  });

  it('reads at most a fixed number of items of one scope, and says the rest were left out only as far as it read', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', Array.from({ length: 30 }, (_, i) => ({ id: minted(NOW - i * 1000), data: { title: `n${i}` } })));
    const c = await read(a, [scope('mine', ME)], { maxReadPerScope: 10 });
    expect(c.entries.length + c.entriesLeftOut).toBe(10);
  });

  it('a budget too small for even one entry gives none, and counts it as left out', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'T', summary: 'S' } }]);
    const c = await read(a, [scope('mine', ME)], { maxTotalChars: 10 });
    expect(c.entries).toEqual([]);
    expect(c.entriesLeftOut).toBe(1);
  });

  it('reads more than one page of a large scope', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', Array.from({ length: 1100 }, (_, i) => ({ id: `item-${String(i).padStart(5, '0')}`, data: { title: `t${i}` } })));
    const c = await read(a, [scope('mine', ME)], { maxPerScope: 1000, maxTotalChars: 100_000 });
    expect(c.entries.length + c.entriesLeftOut).toBe(1100);
  });
});

describe('ordering', () => {
  it('uses a circle item\'s contributedAt, else the time in a minted id, else puts it last, and breaks ties by scope order then id', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [
      { id: 'odd-id', data: { title: 'unknown time' } },
      { id: minted(NOW - 10 * DAY), data: { title: 'old minted' } },
      { id: 'tie-b', data: { title: 'tie b', contributedAt: NOW - 4 * DAY } },
    ]);
    await fill(a, 'parent', [
      { id: 'tie-a', data: { title: 'tie a', contributedAt: NOW - 4 * DAY } },
      { id: 'bad-time', data: { title: 'bad stamp', contributedAt: 'yesterday' } },
    ]);
    const c = await read(a, [scope('mine', ME), scope('parent', PARENT, 'owner')]);
    expect(c.entries.map((e) => e.text)).toEqual(['tie b', 'tie a', 'old minted', 'unknown time', 'bad stamp']);
  });

  it('time of an item: a stamp in the future is not believed; a minted id is read as base 36', () => {
    expect(timeOf('x', { contributedAt: NOW - 1 }, NOW)).toBe(NOW - 1);
    expect(timeOf('x', { contributedAt: NOW + 10 * DAY }, NOW)).toBeUndefined();
    expect(timeOf('x', { contributedAt: -5 }, NOW)).toBeUndefined();
    expect(timeOf('x', { contributedAt: 1.5 }, NOW)).toBeUndefined();
    expect(timeOf(minted(NOW - DAY), undefined, NOW)).toBe(NOW - DAY);
    expect(timeOf(minted(5), undefined, NOW)).toBeUndefined();
    expect(timeOf(minted(NOW + 10 * DAY), undefined, NOW)).toBeUndefined();
    expect(timeOf('note-zzzzzzzzz-aa', undefined, NOW)).toBeUndefined();
    expect(timeOf('plain', undefined, NOW)).toBeUndefined();
    expect(timeOf(minted(NOW - DAY), { contributedAt: NOW - 2 * DAY }, NOW)).toBe(NOW - 2 * DAY);
  });
});

describe('scopes', () => {
  it('identical ids in different scopes stay separate entries, each with its own provenance', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: 'same', data: { title: 'mine', contributedAt: NOW - 1 } }]);
    await fill(a, 'parent', [{ id: 'same', data: { title: 'parent', contributedAt: NOW - 2 } }]);
    await fill(a, 'inlaw', [{ id: 'same', data: { title: 'inlaw', contributedAt: NOW - 3 } }]);
    const c = await read(a);
    expect(c.entries.map((e) => e.text)).toEqual(['mine', 'parent', 'inlaw']);
    expect(c.provenance).toEqual([ME, PARENT, INLAW]);
  });

  it('reads only the scopes it is given: nothing of any other graph appears', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'mine' } }]);
    await fill(a, 'someone-else', [{ id: minted(NOW), data: { title: 'SECRET of another person' } }]);
    await fill(a, 'parent', [{ id: minted(NOW - 1), data: { title: 'SECRET of a circle I am not in' } }]);
    const c = await read(a, [scope('mine', ME)]);
    expect(JSON.stringify(c)).not.toContain('SECRET');
    expect(c.entries).toHaveLength(1);
  });

  it('a person in no circle reads only their own graph: no circle graph is touched', async () => {
    const touched: string[] = [];
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'mine' } }]);
    const watch: StorageAdapter = { ...a, transaction: (graphId, fn) => (touched.push(graphId), a.transaction(graphId, fn)) } as StorageAdapter;
    await read(watch, [scope('mine', ME)]);
    expect([...new Set(touched)]).toEqual(['mine']);
  });

  it('a circle without its graph contributes nothing, and a missing personal graph is an error', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'mine' } }]);
    const c = await read(a, [scope('mine', ME), scope('gone', PARENT, 'owner')]);
    expect(c.entries).toHaveLength(1);
    const r = await createStatusContext(a).read([scope('nope', ME)], NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.source).toBe('graph');
  });

  it('an observer\'s circle is read like any other', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'inlaw', [{ id: 'y', data: { title: 'seen by an observer', contributedAt: NOW - 1 } }]);
    const c = await read(a, [scope('inlaw', INLAW, 'observer')]);
    expect(c.entries[0]?.where).toBe('circle "In-law"');
  });

  it('no scopes at all is an empty context', async () => {
    expect(await read(createMemoryAdapter(), [])).toMatchObject({ entries: [], provenance: [], entriesLeftOut: 0 });
  });

  it('a store that fails is reported with its source, and the failure of one scope fails the whole read', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'x' } }]);
    const broken: StorageAdapter = { ...a, transaction: async (graphId: string, fn: never) => (graphId === 'parent' ? Promise.reject(new Error('disk')) : a.transaction(graphId, fn)) } as StorageAdapter;
    await fill(a, 'parent', [{ id: 'p', data: { title: 'p' } }]);
    const r = await createStatusContext(broken).read([scope('mine', ME), scope('parent', PARENT, 'owner')], NOW);
    expect(r.ok).toBe(false);
  });
});

describe('where an entry came from, as the model is told', () => {
  it('personal, or the circle\'s name in quotes, cut and on one line, with quotes and markup kept as text', () => {
    expect(whereOf(ME)).toBe('personal');
    expect(whereOf(PARENT)).toBe('circle "Parent care"');
    expect(whereOf({ kind: 'circle', circleId: 'c1', circleName: 'He said "hi"\nand <b>left</b>' })).toBe('circle "He said \\"hi\\" and <b>left</b>"');
    expect([...whereOf({ kind: 'circle', circleId: 'c1', circleName: 'x'.repeat(100) })]).toHaveLength('circle ""'.length + 60);
  });
});

describe('it reads and never writes', () => {
  it('no write primitive is called, whatever the outcome', async () => {
    const inner = createMemoryAdapter();
    await fill(inner, 'mine', [{ id: minted(NOW), data: { title: 'a' }, categories: [{ id: 'c', name: 'C' }] }]);
    await fill(inner, 'parent', [{ id: 'p', data: { title: 'p', contributedAt: NOW - 1 } }]);
    const { adapter, writes } = recording(inner);
    await createStatusContext(adapter).read(READABLE, NOW);
    await createStatusContext(adapter).read([scope('nope', ME)], NOW);
    expect(writes).toEqual([]);
  });
});

describe('settings', () => {
  it('have defaults, and must be positive whole numbers', () => {
    expect(DEFAULT_STATUS_CONTEXT_LIMITS).toEqual({ maxTotalChars: 12_000, maxEntryChars: 600, maxPerScope: 200, maxReadPerScope: 2000, maxConcurrentReads: 4 });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      for (const name of Object.keys(DEFAULT_STATUS_CONTEXT_LIMITS)) expect(() => createStatusContext(createMemoryAdapter(), { [name]: bad })).toThrow(TypeError);
    }
  });
  it('reads several scopes at once up to the limit, and with a limit of one still reads them all', async () => {
    const a = createMemoryAdapter();
    await fill(a, 'mine', [{ id: minted(NOW), data: { title: 'a' } }]);
    await fill(a, 'parent', [{ id: 'p', data: { title: 'b', contributedAt: NOW - 1 } }]);
    await fill(a, 'inlaw', [{ id: 'q', data: { title: 'c', contributedAt: NOW - 2 } }]);
    expect((await read(a, READABLE, { maxConcurrentReads: 1 })).entries).toHaveLength(3);
    expect((await read(a, READABLE, { maxConcurrentReads: 8 })).entries).toHaveLength(3);
  });
});
