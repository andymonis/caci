import assert from 'node:assert/strict';
import type { ResolutionError } from '../errors.js';
import type { Result } from '../result.js';
import type { ResolutionStore } from '../store.js';
import { MAX_RESOLUTIONS_PER_USER, type Resolution } from '../types.js';
import type { ResolutionStoreCase } from './types.js';

const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);

const circle = (circleId: string) => ({ kind: 'circle' as const, circleId });
const res = (extra: Partial<Resolution> = {}): Resolution => ({ userId: U1, scope: circle(C1), factId: 'fact-1', verb: 'pay', at: T0, ...extra });

const must = async (result: Promise<Result<void, ResolutionError>>): Promise<void> => {
  const r = await result;
  assert.ok(r.ok, `expected success, got ${JSON.stringify(r)}`);
};
const code = async (result: Promise<Result<void, ResolutionError>>): Promise<string | undefined> => {
  const r = await result;
  return r.ok ? undefined : r.error.code;
};
const rejects = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return false;
  } catch (e) {
    return e instanceof RangeError;
  }
};
const fill = async (store: ResolutionStore, userId: string, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await must(store.set(res({ userId, factId: `f${String(i).padStart(5, '0')}` })));
};

export function resolutionStoreCases(): ResolutionStoreCase[] {
  return [
    {
      name: 'an empty store holds nothing',
      run: async (store) => {
        assert.equal(await store.get(U1, circle(C1), 'fact-1'), undefined);
        assert.equal(await store.count(U1), 0);
        assert.deepEqual(await store.list(U1, { limit: 10 }), { items: [], hasMore: false });
        assert.deepEqual(await store.facts({ limit: 10 }), { items: [], hasMore: false });
        assert.deepEqual(await store.listFor(U1, circle(C1), ['fact-1']), []);
      },
    },
    {
      name: 'a resolution is stored and read back whole',
      run: async (store) => {
        await must(store.set(res()));
        assert.deepEqual(await store.get(U1, circle(C1), 'fact-1'), res());
        assert.equal(await store.count(U1), 1);
      },
    },
    {
      name: 'a personal scope resolution is kept apart from a circle one with the same fact id',
      run: async (store) => {
        await must(store.set(res({ scope: { kind: 'personal' }, verb: 'clear' })));
        await must(store.set(res()));
        assert.equal((await store.get(U1, { kind: 'personal' }, 'fact-1'))?.verb, 'clear');
        assert.equal((await store.get(U1, circle(C1), 'fact-1'))?.verb, 'pay');
        assert.equal(await store.count(U1), 2);
      },
    },
    {
      name: 'one record per person per fact: a second verb replaces the first and keeps the count',
      run: async (store) => {
        await must(store.set(res({ verb: 'clear', at: T0 })));
        await must(store.set(res({ verb: 'pay', at: T0 + 5 })));
        assert.deepEqual(await store.get(U1, circle(C1), 'fact-1'), res({ verb: 'pay', at: T0 + 5 }));
        assert.equal(await store.count(U1), 1);
      },
    },
    {
      name: 'the same fact in another circle, or the same circle for another person, is another record',
      run: async (store) => {
        await must(store.set(res()));
        await must(store.set(res({ scope: circle(C2) })));
        await must(store.set(res({ userId: U2, verb: 'clear' })));
        assert.equal(await store.count(U1), 2);
        assert.equal(await store.count(U2), 1);
        assert.equal((await store.get(U2, circle(C1), 'fact-1'))?.verb, 'clear');
        assert.equal((await store.get(U1, circle(C1), 'fact-1'))?.verb, 'pay');
      },
    },
    {
      name: 'a person never reads another person\'s record through any read',
      run: async (store) => {
        await must(store.set(res()));
        assert.equal(await store.get(U2, circle(C1), 'fact-1'), undefined);
        assert.deepEqual(await store.listFor(U2, circle(C1), ['fact-1']), []);
        assert.deepEqual((await store.list(U2, { limit: 10 })).items, []);
        assert.equal(await store.count(U2), 0);
      },
    },
    {
      name: 'a record that is not well formed is refused and changes nothing',
      run: async (store) => {
        const bad: unknown[] = [
          null,
          'x',
          { ...res(), text: 'the note' },
          { ...res(), userId: 'nobody' },
          { ...res(), scope: { kind: 'circle' } },
          { ...res(), scope: { kind: 'circle', circleId: 'x' } },
          { ...res(), scope: { kind: 'personal', circleId: C1 } },
          { ...res(), scope: { kind: 'group' } },
          { ...res(), factId: '' },
          { ...res(), factId: 'a'.repeat(257) },
          { ...res(), factId: `a${String.fromCharCode(0xd800)}` },
          { ...res(), verb: '' },
          { ...res(), verb: 'Pay' },
          { ...res(), verb: 'a'.repeat(21) },
          { ...res(), at: -1 },
          { ...res(), at: 1.5 },
          { ...res(), at: Number.NaN },
          { ...res(), at: '1' },
        ];
        for (const record of bad) assert.equal(await code(store.set(record as Resolution)), 'INVALID_INPUT', JSON.stringify(record));
        assert.equal(await store.count(U1), 0);
      },
    },
    {
      name: 'a fact id may be any text of 1 to 256 characters, markup and emoji included',
      run: async (store) => {
        const ids = ['a b', '<b>x</b>', '../../x', '😀', 'a'.repeat(256), '😀'.repeat(256), "o'brien", 'x\ny'];
        for (const factId of ids) await must(store.set(res({ factId })));
        for (const factId of ids) assert.equal((await store.get(U1, circle(C1), factId))?.factId, factId);
        assert.equal(await store.count(U1), ids.length);
      },
    },
    {
      name: 'a stored record is a copy: changing what was passed in or read out changes nothing',
      run: async (store) => {
        const input = { ...res(), scope: circle(C1) };
        await must(store.set(input));
        (input as { verb: string }).verb = 'clear';
        (input.scope as { circleId: string }).circleId = C2;
        const read = (await store.get(U1, circle(C1), 'fact-1')) as Resolution;
        assert.equal(read.verb, 'pay');
        try {
          (read.scope as { circleId: string }).circleId = C2;
          (read as { verb: string }).verb = 'clear';
        } catch {
          // frozen copies refuse the change, which is fine too
        }
        assert.deepEqual(await store.get(U1, circle(C1), 'fact-1'), res());
        assert.equal(await store.get(U1, circle(C2), 'fact-1'), undefined);
      },
    },
    {
      name: 'removing deletes only the person\'s own record and says whether there was one',
      run: async (store) => {
        await must(store.set(res()));
        await must(store.set(res({ userId: U2 })));
        assert.equal(await store.remove(U1, circle(C1), 'fact-1'), true);
        assert.equal(await store.remove(U1, circle(C1), 'fact-1'), false);
        assert.equal(await store.get(U1, circle(C1), 'fact-1'), undefined);
        assert.equal((await store.get(U2, circle(C1), 'fact-1'))?.userId, U2);
        assert.equal(await store.remove(U1, circle(C2), 'fact-1'), false);
      },
    },
    {
      name: 'listFor answers only the asked ids of the asked scope, in fact-id order',
      run: async (store) => {
        for (const factId of ['c', 'a', 'b', 'd']) await must(store.set(res({ factId })));
        await must(store.set(res({ factId: 'a', scope: circle(C2) })));
        assert.deepEqual((await store.listFor(U1, circle(C1), ['c', 'b', 'zzz', 'b'])).map((r) => r.factId), ['b', 'c']);
        assert.deepEqual((await store.listFor(U1, circle(C2), ['a', 'b'])).map((r) => r.scope), [circle(C2)]);
        assert.deepEqual(await store.listFor(U1, circle(C1), []), []);
      },
    },
    {
      name: 'listFor takes at most 500 ids and a bad id is a RangeError',
      run: async (store) => {
        await store.listFor(U1, circle(C1), Array.from({ length: 500 }, (_, i) => `f${i}`));
        assert.ok(await rejects(() => store.listFor(U1, circle(C1), Array.from({ length: 501 }, (_, i) => `f${i}`))));
        assert.ok(await rejects(() => store.listFor(U1, circle(C1), [''])));
        assert.ok(await rejects(() => store.listFor('nobody', circle(C1), ['a'])));
      },
    },
    {
      name: 'a page lists the person\'s own records in scope then fact order and continues from the last one',
      run: async (store) => {
        await must(store.set(res({ factId: 'b', scope: circle(C2) })));
        await must(store.set(res({ factId: 'z' })));
        await must(store.set(res({ factId: 'a' })));
        await must(store.set(res({ factId: 'm', scope: { kind: 'personal' } })));
        await must(store.set(res({ factId: 'other', userId: U2 })));
        const first = await store.list(U1, { limit: 2 });
        assert.deepEqual(first.items.map((r) => `${r.scope.kind}:${r.factId}`), ['circle:a', 'circle:z']);
        assert.equal(first.hasMore, true);
        const last = first.items[1] as Resolution;
        const second = await store.list(U1, { limit: 2, after: { scope: last.scope, factId: last.factId } });
        assert.deepEqual(second.items.map((r) => `${r.scope.kind}:${r.factId}`), ['circle:b', 'personal:m']);
        assert.equal(second.hasMore, false);
      },
    },
    {
      name: 'the ordering is by UTF-16 code unit, not by locale',
      run: async (store) => {
        for (const factId of ['b', 'B', 'a', 'Z', '😀', '￿', 'é']) await must(store.set(res({ factId })));
        const ids = (await store.list(U1, { limit: 100 })).items.map((r) => r.factId);
        assert.deepEqual(ids, ['B', 'Z', 'a', 'b', 'é', '😀', '￿']);
      },
    },
    {
      name: 'a page limit outside 1 to 100 is a RangeError',
      run: async (store) => {
        for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
          assert.ok(await rejects(() => store.list(U1, { limit })), String(limit));
          assert.ok(await rejects(() => store.facts({ limit })), String(limit));
        }
        await store.list(U1, { limit: 1 });
        await store.list(U1, { limit: 100 });
      },
    },
    {
      name: 'a person may hold 2,000 records; one more is LIMIT_REACHED, but replacing one is still fine',
      run: async (store) => {
        await fill(store, U1, MAX_RESOLUTIONS_PER_USER);
        assert.equal(await store.count(U1), MAX_RESOLUTIONS_PER_USER);
        assert.equal(await code(store.set(res({ factId: 'one-more' }))), 'LIMIT_REACHED');
        assert.equal(await store.count(U1), MAX_RESOLUTIONS_PER_USER);
        await must(store.set(res({ factId: 'f00000', verb: 'clear' })));
        assert.equal((await store.get(U1, circle(C1), 'f00000'))?.verb, 'clear');
        assert.equal(await store.remove(U1, circle(C1), 'f00001'), true);
        await must(store.set(res({ factId: 'one-more' })));
      },
    },
    {
      name: 'the limit is per person: another person is not held back',
      run: async (store) => {
        await fill(store, U1, MAX_RESOLUTIONS_PER_USER);
        await must(store.set(res({ userId: U2, factId: 'f00000' })));
        assert.equal(await store.count(U2), 1);
      },
    },
    {
      name: 'removeForUser removes only that person\'s records and says how many',
      run: async (store) => {
        await must(store.set(res({ factId: 'a' })));
        await must(store.set(res({ factId: 'b', scope: circle(C2) })));
        await must(store.set(res({ factId: 'a', userId: U2 })));
        assert.equal(await store.removeForUser(U1), 2);
        assert.equal(await store.count(U1), 0);
        assert.equal(await store.count(U2), 1);
        assert.equal(await store.removeForUser(U1), 0);
      },
    },
    {
      name: 'removeForCircle removes every person\'s records in that circle and nothing else',
      run: async (store) => {
        await must(store.set(res({ factId: 'a' })));
        await must(store.set(res({ factId: 'a', userId: U2 })));
        await must(store.set(res({ factId: 'a', scope: circle(C2) })));
        await must(store.set(res({ factId: 'a', scope: { kind: 'personal' } })));
        assert.equal(await store.removeForCircle(C1), 2);
        assert.equal(await store.get(U1, circle(C1), 'a'), undefined);
        assert.equal(await store.get(U2, circle(C1), 'a'), undefined);
        assert.ok(await store.get(U1, circle(C2), 'a'));
        assert.ok(await store.get(U1, { kind: 'personal' }, 'a'));
        assert.equal(await store.removeForCircle(C1), 0);
      },
    },
    {
      name: 'removeFact removes every person\'s record for that one fact and nothing else',
      run: async (store) => {
        await must(store.set(res({ factId: 'a' })));
        await must(store.set(res({ factId: 'a', userId: U2 })));
        await must(store.set(res({ factId: 'b' })));
        await must(store.set(res({ factId: 'a', scope: circle(C2) })));
        assert.equal(await store.removeFact(circle(C1), 'a'), 2);
        assert.equal(await store.get(U1, circle(C1), 'a'), undefined);
        assert.equal(await store.get(U2, circle(C1), 'a'), undefined);
        assert.ok(await store.get(U1, circle(C1), 'b'));
        assert.ok(await store.get(U1, circle(C2), 'a'));
        assert.equal(await store.removeFact(circle(C1), 'a'), 0);
      },
    },
    {
      name: 'facts lists each fact once, whoever resolved it, in order, and pages',
      run: async (store) => {
        await must(store.set(res({ factId: 'b' })));
        await must(store.set(res({ factId: 'b', userId: U2 })));
        await must(store.set(res({ factId: 'a', scope: circle(C2) })));
        await must(store.set(res({ factId: 'c' })));
        const first = await store.facts({ limit: 2 });
        assert.deepEqual(first.items.map((f) => `${f.scope.kind === 'circle' ? f.scope.circleId : 'p'}:${f.factId}`), [`${C1}:b`, `${C1}:c`]);
        assert.equal(first.hasMore, true);
        const second = await store.facts({ limit: 2, after: first.items[1] as { scope: Resolution['scope']; factId: string } });
        assert.deepEqual(second.items.map((f) => f.factId), ['a']);
        assert.equal(second.hasMore, false);
        assert.deepEqual(Object.keys(first.items[0] as object).sort(), ['factId', 'scope']);
      },
    },
    {
      name: 'a bad key for get or remove is a RangeError, not a quiet no-record',
      run: async (store) => {
        assert.ok(await rejects(() => store.get('nobody', circle(C1), 'a')));
        assert.ok(await rejects(() => store.get(U1, { kind: 'circle', circleId: 'x' }, 'a')));
        assert.ok(await rejects(() => store.get(U1, circle(C1), '')));
        assert.ok(await rejects(() => store.remove('nobody', circle(C1), 'a')));
      },
    },
    {
      name: 'two stores share nothing',
      run: async (store, makeAnother) => {
        const other = await makeAnother();
        await must(store.set(res()));
        assert.equal(await other.get(U1, circle(C1), 'fact-1'), undefined);
        assert.equal(await other.count(U1), 0);
      },
    },
    {
      name: 'many records set at once are all kept',
      run: async (store) => {
        await Promise.all(Array.from({ length: 50 }, (_, i) => must(store.set(res({ factId: `p${i}` })))));
        assert.equal(await store.count(U1), 50);
      },
    },
    {
      name: 'setting the same fact at once leaves exactly one record',
      run: async (store) => {
        await Promise.all(Array.from({ length: 20 }, (_, i) => must(store.set(res({ verb: i % 2 === 0 ? 'pay' : 'clear', at: T0 + i })))));
        assert.equal(await store.count(U1), 1);
        assert.ok(await store.get(U1, circle(C1), 'fact-1'));
      },
    },
  ];
}
