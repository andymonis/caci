import { describe, expect, it } from 'vitest';
import { describeGraph } from '../graph_store/index.js';
import { createMemoryLedgerStore } from '../ledger/index.js';
import { T0, world, type World } from './controller.test-util.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const NO_CIRCLE = { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } } };
const circle = (circleId: string) => ({ kind: 'circle', circleId });

/** Files a note the way the app does (propose, approve), so facts carry their stamps and the change log fills. */
async function file(w: World, who: string, text: string, scope?: unknown): Promise<void> {
  const made = must(await w.caci.propose(w.tokens[who] as string, { text, ...(scope === undefined ? {} : { scope }) }));
  must(await w.caci.approve(w.tokens[who] as string, made.id));
}
const setup = async () => {
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan'], ledger: createMemoryLedgerStore(), directory: true });
  const club = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  const other = await w.circle(2, 'ann');
  return { w, club, other };
};

describe('searchFacts', () => {
  it('finds the facts that share words with the text, with when and who where the brain says', async () => {
    const { w, club } = await setup();
    w.now.value = T0 + 1000;
    await file(w, 'bob', 'Dentist appointment moved to Tuesday at four', circle(club));
    w.now.value = T0 + 2000;
    await file(w, 'ann', 'Garden club meets on Wednesday', circle(club));
    const found = must(await w.caci.searchFacts(w.tokens.cat as string, { text: 'dentist appointment', scope: circle(club) })) as unknown as { items: Array<Record<string, unknown>>; scope: unknown };
    expect(found.scope).toEqual({ kind: 'circle', circleId: club, circleName: 'Circle 1' });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ title: expect.stringContaining('Dentist'), at: T0 + 1000, by: { username: 'bob', displayName: 'bob' } });
    expect(Object.keys(found.items[0] as object).every((k) => ['at', 'by', 'id', 'key', 'summary', 'title'].includes(k))).toBe(true); // nothing about the plumbing
  });

  it('personal facts have no scope key and no author (a personal brain does not stamp them), and the two brains do not mix', async () => {
    const { w, club } = await setup();
    await file(w, 'ann', 'Passport check in January');
    await file(w, 'ann', 'Passport renewal form for the club', circle(club));
    const own = must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'passport' })) as unknown as { items: Array<{ title: string; by?: unknown }>; scope?: unknown };
    expect(own.scope).toBeUndefined();
    expect(own.items).toHaveLength(1);
    expect(own.items[0]?.title).toMatch(/January/i);
    expect(own.items[0]?.by).toBeUndefined();
    const theirs = must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'passport', scope: circle(club) })) as unknown as { items: Array<{ title: string }> };
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]?.title).toMatch(/club/i);
  });

  it('returns nothing for words nothing shares, and at most the limit', async () => {
    const { w } = await setup();
    for (let i = 0; i < 4; i++) await file(w, 'ann', `Remember the red bicycle number ${i} in the shed`);
    expect(must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'volcano eruption' }))).toMatchObject({ items: [] });
    const two = must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'red bicycle shed', limit: 2 })) as unknown as { items: unknown[] };
    expect(two.items).toHaveLength(2);
    const dflt = must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'red bicycle shed' })) as unknown as { items: unknown[] };
    expect(dflt.items.length).toBe(4);
    for (let i = 4; i < 23; i++) await file(w, 'ann', `Remember the red bicycle number ${i} in the shed`);
    expect((must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'red bicycle shed' })) as unknown as { items: unknown[] }).items).toHaveLength(20); // the default
    expect((must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'red bicycle shed', limit: 50 })) as unknown as { items: unknown[] }).items).toHaveLength(23);
  });

  it('an observer may search; a stranger, a person in other circles only and a made-up circle get the one no-such-circle answer', async () => {
    const { w, club, other } = await setup();
    await file(w, 'bob', 'Club picnic on Saturday', circle(club));
    expect(must(await w.caci.searchFacts(w.tokens.cat as string, { text: 'picnic', scope: circle(club) }))).toMatchObject({ items: [{}] });
    const stranger = await w.caci.searchFacts(w.tokens.dan as string, { text: 'picnic', scope: circle(club) });
    expect(stranger).toMatchObject(NO_CIRCLE);
    expect(await w.caci.searchFacts(w.tokens.bob as string, { text: 'picnic', scope: circle(other) })).toEqual(stranger);
    expect(await w.caci.searchFacts(w.tokens.ann as string, { text: 'picnic', scope: circle('c0000000000000099') })).toEqual(stranger);
  });

  it('shows a fact\'s key when it has one', async () => {
    const { w } = await setup();
    await file(w, 'ann', 'Passport: number 12345 and expiry in March');
    const hits = (must(await w.caci.searchFacts(w.tokens.ann as string, { text: 'passport expiry' })) as unknown as { items: Array<{ key?: string }> }).items;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => typeof h.key === 'string' && h.key !== '')).toBe(true);
  });

  it('refuses bad input by naming the field, and needs a session', async () => {
    const { w } = await setup();
    const ann = w.tokens.ann as string;
    const field = async (input: unknown, expected: string) => expect(await w.caci.searchFacts(ann, input), JSON.stringify(input)).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'INVALID_INPUT', field: expected } } });
    await field({ text: '' }, 'text');
    await field({ text: '   ' }, 'text');
    await field({ text: 5 }, 'text');
    await field({}, 'text');
    await field({ text: 'a'.repeat(501) }, 'text');
    await field({ text: 'ok', limit: 0 }, 'limit');
    await field({ text: 'ok', limit: 51 }, 'limit');
    await field({ text: 'ok', limit: 1.5 }, 'limit');
    await field({ text: 'ok', limit: '3' }, 'limit');
    await field({ text: 'ok', graphId: 'user-x' }, 'graphId');
    await field({ text: 'ok', scope: { kind: 'circle', circleId: 'x' } }, 'scope.circleId');
    for (const bad of [null, 'text', 5, ['x']]) expect(await w.caci.searchFacts(ann, bad)).toMatchObject({ ok: false, error: { error: { code: 'INVALID_INPUT' } } });
    expect(await w.caci.searchFacts(undefined, { text: 'ok' })).toMatchObject({ ok: false, error: { error: { code: 'UNAUTHENTICATED' } } });
    expect((await w.caci.searchFacts(ann, { text: 'a'.repeat(500) })).ok).toBe(true); // exactly the limit
  });

  it('writes nothing', async () => {
    const { w, club } = await setup();
    await file(w, 'ann', 'Something to find', circle(club));
    const before = await describeGraph(w.graphs, `circle-${club}`);
    await w.caci.searchFacts(w.tokens.ann as string, { text: 'something find', scope: circle(club) });
    expect(await describeGraph(w.graphs, `circle-${club}`)).toEqual(before);
  });
});

describe('changes', () => {
  it('lists the change log entries newer than a time, newest first, and none at or before it', async () => {
    const { w, club } = await setup();
    w.now.value = T0 + 1000;
    await file(w, 'ann', 'First thing about boats', circle(club));
    w.now.value = T0 + 5000;
    await file(w, 'bob', 'Second thing about gardens', circle(club));
    w.now.value = T0 + 9000;
    await file(w, 'ann', 'Third thing about music', circle(club));
    const all = must(await w.caci.changes(w.tokens.cat as string, { scope: circle(club), since: 0 })) as unknown as { items: Array<{ at: number; action: string; kind: string }>; since: number; nextCursor: string | null; scope: unknown };
    expect(all.scope).toEqual({ kind: 'circle', circleId: club, circleName: 'Circle 1' });
    expect(all.items.map((e) => e.at)).toEqual([...all.items.map((e) => e.at)].sort((a, b) => b - a));
    expect(all.items.length).toBeGreaterThanOrEqual(9); // each approval: an input, an item and a category
    const later = must(await w.caci.changes(w.tokens.cat as string, { scope: circle(club), since: T0 + 5000 })) as unknown as { items: Array<{ at: number }>; nextCursor: string | null };
    expect(later.items.length).toBeGreaterThan(0);
    expect(later.items.every((e) => e.at > T0 + 5000)).toBe(true);
    expect(later.items.length).toBeLessThan(all.items.length);
    expect(later.nextCursor).toBeNull(); // an older entry was reached, so there is nothing newer after it
    expect(must(await w.caci.changes(w.tokens.cat as string, { scope: circle(club), since: T0 + 9100 }))).toMatchObject({ items: [], nextCursor: null }); // an approval's entries are a millisecond apart, so this is after all of them
    expect(must(await w.caci.changes(w.tokens.cat as string, { scope: circle(club), since: T0 + 9000 + 1_000_000 }))).toMatchObject({ items: [] });
  });

  it('takes a time as milliseconds or as an ISO 8601 date and time, and says which field is wrong otherwise', async () => {
    const { w } = await setup();
    const ann = w.tokens.ann as string;
    const iso = (ms: number): string => new Date(ms).toISOString();
    w.now.value = T0 + 60_000;
    await file(w, 'ann', 'A thing for March');
    expect(must(await w.caci.changes(ann, { since: iso(T0 + 59_000) }))).toMatchObject({ since: T0 + 59_000 });
    expect((must(await w.caci.changes(ann, { since: iso(T0 + 59_000) })) as unknown as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((must(await w.caci.changes(ann, { since: iso(T0 + 61_000) })) as unknown as { items: unknown[] }).items).toEqual([]);
    expect(must(await w.caci.changes(ann, { since: '2023-11-14' }))).toMatchObject({ since: Date.parse('2023-11-14') }); // a bare date is accepted
    const field = async (input: unknown, expected: string) => expect(await w.caci.changes(ann, input), JSON.stringify(input)).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'INVALID_INPUT', field: expected } } });
    for (const since of [undefined, -1, 1.5, Number.NaN, 'yesterday', '2026-13-45', '2026-03-01 12:00', '', null, {}]) await field({ since }, 'since');
    await field({ since: 0, limit: 0 }, 'limit');
    await field({ since: 0, cursor: 'nonsense' }, 'cursor');
    await field({ since: 0, graphId: 'x' }, 'graphId');
    for (const bad of [null, 5, 'x', []]) await field(bad, 'since');
  });

  it('pages with a limit and a cursor, and stops at the time asked', async () => {
    const { w } = await setup();
    const ann = w.tokens.ann as string;
    for (let i = 0; i < 4; i++) {
      w.now.value = T0 + 1000 * (i + 1);
      await file(w, 'ann', `Thing number ${i} about topic${i}`);
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = must(await w.caci.changes(ann, { since: T0 + 2500, limit: 2, ...(cursor === null ? {} : { cursor }) })) as unknown as unknown as { items: Array<{ at: number }>; nextCursor: string | null };
      seen.push(...page.items.map((e) => e.at));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((t) => t > T0 + 2500)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('keeps the change log\'s scope rules: a stranger, other circles only and a made-up circle are the one answer; the personal log is the person\'s own', async () => {
    const { w, club, other } = await setup();
    await file(w, 'bob', 'A club thing', circle(club));
    await file(w, 'ann', 'My own thing');
    const stranger = await w.caci.changes(w.tokens.dan as string, { scope: circle(club), since: 0 });
    expect(stranger).toMatchObject(NO_CIRCLE);
    expect(await w.caci.changes(w.tokens.bob as string, { scope: circle(other), since: 0 })).toEqual(stranger);
    expect(await w.caci.changes(w.tokens.ann as string, { scope: circle('c0000000000000099'), since: 0 })).toEqual(stranger);
    const own = must(await w.caci.changes(w.tokens.ann as string, { since: 0 })) as unknown as { items: Array<{ title?: string; text?: string }>; scope?: unknown };
    expect(own.scope).toBeUndefined();
    expect(JSON.stringify(own)).toContain('My own thing');
    expect(JSON.stringify(own)).not.toContain('A club thing');
    expect(await w.caci.changes(undefined, { since: 0 })).toMatchObject({ ok: false, error: { error: { code: 'UNAUTHENTICATED' } } });
  });

  it('says there is nothing newer to fetch as soon as a page reaches an old entry, even when the log has more pages', async () => {
    const { w } = await setup();
    const ann = w.tokens.ann as string;
    for (let i = 0; i < 3; i++) {
      w.now.value = T0 + 10_000 * (i + 1);
      await file(w, 'ann', `Entry ${i} about subject${i}`);
    }
    const cut = T0 + 20_000 + 500; // after the second approval's entries, before the third's
    const first = must(await w.caci.changes(ann, { since: cut, limit: 100 })) as unknown as { items: Array<{ at: number }>; nextCursor: string | null };
    const newer = first.items.length;
    expect(newer).toBeGreaterThan(0);
    const small = must(await w.caci.changes(ann, { since: cut, limit: newer + 1 })) as unknown as { items: unknown[]; nextCursor: string | null };
    expect(small.items).toHaveLength(newer); // the page held one older entry, which is dropped
    expect(small.nextCursor).toBeNull(); // and there was more log after it, but none of it can be newer
  });

  it('without a change log it is not available', async () => {
    const w = await world({ people: ['ann'] });
    expect(await w.caci.changes(w.tokens.ann as string, { since: 0 })).toMatchObject({ ok: false, error: { error: { code: 'NOT_FOUND', message: 'the change log is not available' } } });
  });
});
