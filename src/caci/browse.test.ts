import { describe, expect, it } from 'vitest';
import { write } from '../graph_store/index.js';
import { capData, MAX_DATA_CHARS } from './index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';

type Op = Record<string, unknown>;
const cat = (id: string, name?: string): Op => ({ op: 'upsertNode', partition: 'category', id, ...(name === undefined ? {} : { data: { name } }) });
const item = (id: string, data: Record<string, unknown> = { title: id }): Op => ({ op: 'upsertNode', partition: 'item', id, data });
const link = (i: string, c: string, weight?: number): Op => ({ op: 'link', item: i, category: c, ...(weight === undefined ? {} : { weight }) });
async function seed(w: World, who: string, ops: Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 500) {
    const r = await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphIds[who] as string, ops: ops.slice(i, i + 500) });
    if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
  }
}
const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};

async function populated(): Promise<World> {
  const w = await world();
  await seed(w, 'ann', [
    cat('health', 'Health'), cat('travel', 'Travel plans'), cat('empty-one'), cat('NoName', ''),
    item('n1', { title: 'Blood test', summary: 'Dr Patel booked it' }), item('n2', { title: 'Flight to Lisbon' }), item('n3', { title: 'Passport renewal' }),
    link('n1', 'health', 0.9), link('n2', 'travel', 0.9), link('n3', 'travel', 0.6), link('n3', 'health', 0.3),
  ]);
  return w;
}

describe('summary', () => {
  it('counts the caller\'s items, categories and links', async () => {
    const w = await populated();
    expect(must(await w.caci.summary(w.tokens.ann))).toEqual({ itemCount: 3, categoryCount: 4, edgeCount: 4 });
    expect(must(await w.caci.summary(w.tokens.bob))).toEqual({ itemCount: 0, categoryCount: 0, edgeCount: 0 });
  });
});

describe('categories', () => {
  it('lists them by id with their names and how many items each holds', async () => {
    const w = await populated();
    const page = must(await w.caci.categories(w.tokens.ann));
    expect(page.items).toEqual([
      { id: 'NoName', itemCount: 0 },
      { id: 'empty-one', itemCount: 0 },
      { id: 'health', name: 'Health', itemCount: 2 },
      { id: 'travel', name: 'Travel plans', itemCount: 2 },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('pages with limit and cursor, walking every category once', async () => {
    const w = await world();
    await seed(w, 'ann', Array.from({ length: 7 }, (_, i) => cat(`cat-${i}`, `Name ${i}`)));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: { items: ReadonlyArray<{ id: string }>; nextCursor: string | null } = must(await w.caci.categories(w.tokens.ann, { limit: 3, cursor }));
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `cat-${i}`));
  });

  it('refuses a bad limit or cursor naming the field', async () => {
    const w = await populated();
    for (const limit of [0, 101, 1.5, -1, '5', null, Number.NaN]) expect(ownErrorOf(await w.caci.categories(w.tokens.ann, { limit })), String(limit)).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    for (const cursor of [5, {}, '', 'x'.repeat(3000)]) expect(ownErrorOf(await w.caci.categories(w.tokens.ann, { cursor })), String(cursor).slice(0, 10)).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    expect(ownErrorOf(await w.caci.categories(w.tokens.ann, { cursor: 'not a cursor' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
  });

  it('a cursor from one request does not work for another kind of listing', async () => {
    const w = await populated();
    const page = must(await w.caci.categories(w.tokens.ann, { limit: 1 }));
    expect(page.nextCursor).not.toBeNull();
    expect(ownErrorOf(await w.caci.categoryItems(w.tokens.ann, 'health', { cursor: page.nextCursor }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
  });

  it('a name is text only and at most 100 characters', async () => {
    const w = await world();
    await seed(w, 'ann', [{ op: 'upsertNode', partition: 'category', id: 'odd', data: { name: 5 } }, cat('long', 'x'.repeat(300))]);
    const page = must(await w.caci.categories(w.tokens.ann));
    expect(page.items.find((c) => c.id === 'odd')).toEqual({ id: 'odd', itemCount: 0 });
    expect(page.items.find((c) => c.id === 'long')?.name).toHaveLength(100);
  });

  it('a page is 50 by default', async () => {
    const w = await world();
    await seed(w, 'ann', Array.from({ length: 60 }, (_, i) => cat(`c${String(i).padStart(2, '0')}`)));
    const page = must(await w.caci.categories(w.tokens.ann));
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it('says when a count is only a lower bound because the category is too big to count (10,000 items)', async () => {
    const w = await world();
    const ids = Array.from({ length: 10_050 }, (_, i) => `i${String(i).padStart(5, '0')}`);
    await seed(w, 'ann', [cat('huge'), ...ids.map((id) => ({ op: 'upsertNode', partition: 'item', id, data: {} })), ...ids.map((id) => link(id, 'huge'))]);
    const huge = must(await w.caci.categories(w.tokens.ann)).items[0];
    expect(huge).toMatchObject({ id: 'huge', itemCountCapped: true });
    expect(huge?.itemCount).toBeGreaterThanOrEqual(9_999); // the walk stops at 10,000 nodes reached, the category itself being one
    expect(huge?.itemCount).toBeLessThan(10_050);
  }, 60_000);

  it('shows nothing for an empty graph', async () => {
    const w = await world();
    expect(must(await w.caci.categories(w.tokens.ann))).toEqual({ items: [], nextCursor: null });
  });
});

describe('the items of a category', () => {
  it('lists them with their data, by id', async () => {
    const w = await populated();
    const page = must(await w.caci.categoryItems(w.tokens.ann, 'travel'));
    expect(page.category).toEqual({ id: 'travel', name: 'Travel plans' });
    expect(page.items).toEqual([{ id: 'n2', data: { title: 'Flight to Lisbon' } }, { id: 'n3', data: { title: 'Passport renewal' } }]);
    expect(page.nextCursor).toBeNull();
  });

  it('an empty category is an empty page, not an error', async () => {
    const w = await populated();
    expect(must(await w.caci.categoryItems(w.tokens.ann, 'empty-one')).items).toEqual([]);
  });

  it('pages', async () => {
    const w = await world();
    await seed(w, 'ann', [cat('big', 'Big'), ...Array.from({ length: 12 }, (_, i) => item(`i${String(i).padStart(2, '0')}`)), ...Array.from({ length: 12 }, (_, i) => link(`i${String(i).padStart(2, '0')}`, 'big'))]);
    const first = must(await w.caci.categoryItems(w.tokens.ann, 'big', { limit: 5 }));
    expect(first.items.map((i) => i.id)).toEqual(['i00', 'i01', 'i02', 'i03', 'i04']);
    const second = must(await w.caci.categoryItems(w.tokens.ann, 'big', { limit: 5, cursor: first.nextCursor }));
    expect(second.items.map((i) => i.id)).toEqual(['i05', 'i06', 'i07', 'i08', 'i09']);
    const third = must(await w.caci.categoryItems(w.tokens.ann, 'big', { limit: 5, cursor: second.nextCursor }));
    expect(third.items.map((i) => i.id)).toEqual(['i10', 'i11']);
    expect(third.nextCursor).toBeNull();
  });

  it('an id that is not one of the caller\'s categories is NOT_FOUND: missing, an item\'s id, too long, or another account\'s', async () => {
    const w = await populated();
    await seed(w, 'bob', [cat('bobs-private', 'Private'), item('b1'), link('b1', 'bobs-private')]);
    for (const id of ['nothing', 'n1', 'HEALTH', 'health ', 'x'.repeat(300), 'bobs-private']) expect(ownErrorOf(await w.caci.categoryItems(w.tokens.ann, id)), id.slice(0, 20)).toMatchObject({ code: 'NOT_FOUND' });
    expect(must(await w.caci.categoryItems(w.tokens.bob, 'bobs-private')).items.map((i) => i.id)).toEqual(['b1']);
  });

  it('an id that is not text is INVALID_INPUT naming id', async () => {
    const w = await populated();
    for (const id of [undefined, null, 5, {}, '']) expect(ownErrorOf(await w.caci.categoryItems(w.tokens.ann, id)), String(id)).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
  });
});

describe('one item', () => {
  it('shows its data and the categories it is filed under, with names and weights', async () => {
    const w = await populated();
    expect(must(await w.caci.item(w.tokens.ann, 'n3'))).toEqual({
      item: { id: 'n3', data: { title: 'Passport renewal' } },
      categories: [{ id: 'health', name: 'Health', weight: 0.3 }, { id: 'travel', name: 'Travel plans', weight: 0.6 }],
    });
  });

  it('an item filed nowhere has no categories', async () => {
    const w = await world();
    await seed(w, 'ann', [item('lonely')]);
    expect(must(await w.caci.item(w.tokens.ann, 'lonely'))).toEqual({ item: { id: 'lonely', data: { title: 'lonely' } }, categories: [] });
  });

  it('a weight that was never set reads as 1', async () => {
    const w = await world();
    await seed(w, 'ann', [cat('c'), item('i'), link('i', 'c')]);
    expect(must(await w.caci.item(w.tokens.ann, 'i')).categories).toEqual([{ id: 'c', weight: 1 }]);
  });

  it('is NOT_FOUND for a missing id, a category\'s id, a too long id, and another account\'s item', async () => {
    const w = await populated();
    await seed(w, 'bob', [item('b-secret')]);
    for (const id of ['nothing', 'health', 'N1', 'x'.repeat(300), 'b-secret']) expect(ownErrorOf(await w.caci.item(w.tokens.ann, id)), id.slice(0, 20)).toMatchObject({ code: 'NOT_FOUND' });
    for (const id of [undefined, null, 5, '']) expect(ownErrorOf(await w.caci.item(w.tokens.ann, id)), String(id)).toMatchObject({ code: 'INVALID_INPUT', field: 'id' });
  });

  it('lists at most 200 categories and says there are more', async () => {
    const w = await world();
    const ids = Array.from({ length: 230 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    await seed(w, 'ann', [...ids.map((id) => cat(id)), item('popular'), ...ids.map((id) => link('popular', id))]);
    const detail = must(await w.caci.item(w.tokens.ann, 'popular'));
    expect(detail.categories).toHaveLength(200);
    expect(detail.categories[0]?.id).toBe('c000');
    expect(detail.moreCategories).toBe(true);
    await seed(w, 'bob', [...ids.slice(0, 200).map((id) => cat(id)), item('exact'), ...ids.slice(0, 200).map((id) => link('exact', id))]);
    expect('moreCategories' in must(await w.caci.item(w.tokens.bob, 'exact'))).toBe(false);
  });
});

describe('ids are opaque text', () => {
  const ODD = ['has spaces', 'UPPER Case', 'café ☕', '名前を忘れないように', 'a/b?c=d&e#f', '😀', '..', 'x'.repeat(128), 'x'.repeat(256), '<script>alert(1)</script>', "o'brien", 'tab\there', 'quote"d'];

  it('every kind of id works for a category, its items and an item', async () => {
    const w = await world();
    const ops: Op[] = [];
    ODD.forEach((id, i) => ops.push(cat(id, `Name ${i}`), item(`item ${id}`.slice(0, 256)), link(`item ${id}`.slice(0, 256), id)));
    await seed(w, 'ann', ops);
    const listed = must(await w.caci.categories(w.tokens.ann, { limit: 100 }));
    expect(listed.items.map((c) => c.id).sort()).toEqual([...ODD].sort());
    for (const id of ODD) {
      const items = must(await w.caci.categoryItems(w.tokens.ann, id));
      expect(items.category.id, id).toBe(id);
      expect(items.items).toHaveLength(1);
      const first = items.items[0]?.id as string;
      expect(must(await w.caci.item(w.tokens.ann, first)).categories.map((c) => c.id)).toEqual([id]);
    }
  });
});

describe('only the caller\'s graph', () => {
  it('two accounts with the same ids see their own data, never each other\'s', async () => {
    const w = await world();
    await seed(w, 'ann', [cat('shared', 'Ann\'s'), item('same', { title: 'ann secret' }), link('same', 'shared', 0.9)]);
    await seed(w, 'bob', [cat('shared', 'Bob\'s'), item('same', { title: 'bob secret' }), link('same', 'shared', 0.2), item('only-bob'), link('only-bob', 'shared')]);
    const ann = JSON.stringify([must(await w.caci.summary(w.tokens.ann)), must(await w.caci.categories(w.tokens.ann)), must(await w.caci.categoryItems(w.tokens.ann, 'shared')), must(await w.caci.item(w.tokens.ann, 'same'))]);
    const bob = JSON.stringify([must(await w.caci.summary(w.tokens.bob)), must(await w.caci.categories(w.tokens.bob)), must(await w.caci.categoryItems(w.tokens.bob, 'shared')), must(await w.caci.item(w.tokens.bob, 'same'))]);
    expect(ann).toContain('ann secret');
    expect(ann).not.toMatch(/bob|only-bob/);
    expect(bob).toContain('bob secret');
    expect(bob).not.toContain('ann secret');
    expect(ownErrorOf(await w.caci.item(w.tokens.ann, 'only-bob'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('there is no way to ask for another graph: extra arguments and graph-looking ids change nothing', async () => {
    const w = await world();
    await seed(w, 'bob', [item('bobs-note', { title: 'bob secret' })]);
    const attempt = await w.caci.item(w.tokens.ann, `${w.graphIds.bob}/bobs-note`);
    expect(ownErrorOf(attempt)).toMatchObject({ code: 'NOT_FOUND' });
    const sneaky = await w.caci.categories(w.tokens.ann, { limit: 5, graphId: w.graphIds.bob } as never);
    expect(JSON.stringify(sneaky)).not.toContain('bob');
  });
});

describe('who may browse', () => {
  it('needs a session for each call, and ends with it', async () => {
    const w = await populated();
    for (const bad of [undefined, 'garbage', 'A'.repeat(43)]) {
      expect(ownErrorOf(await w.caci.summary(bad))).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(ownErrorOf(await w.caci.categories(bad))).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(ownErrorOf(await w.caci.categoryItems(bad, 'health'))).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(ownErrorOf(await w.caci.item(bad, 'n1'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    await w.users.logout(w.tokens.ann);
    expect(ownErrorOf(await w.caci.summary(w.tokens.ann))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a graph that has gone is reported as a graph error, not hidden', async () => {
    const w = await populated();
    await w.graphs.graphs.drop(w.graphIds.ann as string);
    expect(await w.caci.summary(w.tokens.ann)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'GRAPH_NOT_FOUND' } } });
    expect(await w.caci.categories(w.tokens.ann)).toMatchObject({ ok: false, error: { source: 'graph' } });
  });
});

describe('a note that is too big for one answer', () => {
  it('is returned whole up to the cap, and above it long text is cut and flagged', async () => {
    const w = await world();
    await seed(w, 'ann', [cat('c'), item('small', { title: 't', summary: 's'.repeat(1000) }), item('big', { title: 'b', summary: 'y'.repeat(6000) }), item('huge', Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 'z'.repeat(200)]))), link('small', 'c'), link('big', 'c'), link('huge', 'c')]);
    const items = must(await w.caci.categoryItems(w.tokens.ann, 'c')).items;
    const by = (id: string) => items.find((i) => i.id === id);
    expect(by('small')).toEqual({ id: 'small', data: { title: 't', summary: 's'.repeat(1000) } });
    expect(by('big')?.dataTruncated).toBe(true);
    expect((by('big')?.data.summary as string).length).toBe(300);
    expect(by('big')?.data.title).toBe('b');
    expect(by('huge')).toEqual({ id: 'huge', data: {}, dataTruncated: true }); // still too big after cutting: dropped, and flagged
    expect(JSON.stringify(must(await w.caci.item(w.tokens.ann, 'big')).item).length).toBeLessThan(MAX_DATA_CHARS);
  });

  it('capData is exact about the cap and never cuts half a character', () => {
    const atCap = { v: 'a'.repeat(MAX_DATA_CHARS - 8) }; // {"v":"..."} is 8 characters of wrapping
    expect(JSON.stringify(atCap).length).toBe(MAX_DATA_CHARS);
    expect(capData(atCap)).toEqual({ data: atCap, truncated: false });
    expect(capData({ v: 'a'.repeat(MAX_DATA_CHARS - 7) }).truncated).toBe(true);
    const cut = capData({ title: '😀'.repeat(400), more: 'x'.repeat(5000) }).data.title as string;
    expect([...cut]).toHaveLength(300);
    expect((cut as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(capData(undefined)).toEqual({ data: {}, truncated: false });
    expect(capData({ n: 5, nested: { a: [1, 2] } })).toEqual({ data: { n: 5, nested: { a: [1, 2] } }, truncated: false });
  });
});
