import assert from 'node:assert/strict';
import type { UsageError } from '../errors.js';
import type { Result } from '../result.js';
import type { UsageStore } from '../store.js';
import type { UsageAggregate, UsageRange, UsageRecord } from '../types.js';
import type { UsageStoreCase } from './types.js';

const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const C2 = 'c0000000000000002';
const DAY = 86_400_000;
const D1 = Date.UTC(2026, 10, 3, 9, 0, 0); // 3 Nov 2026, 09:00 UTC
const ALL: UsageRange = { from: 0, to: Date.UTC(2100, 0, 1) };

const rec = (extra: Partial<UsageRecord> = {}): UsageRecord => ({
  at: D1,
  userId: U1,
  capability: 'categorise',
  scope: { kind: 'personal' },
  model: 'claude-haiku-4-5-20251001',
  attempt: 1,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  result: 'ok',
  latencyMs: 800,
  ...extra,
});

const must = <T>(result: Result<T, UsageError>): T => {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
};
const code = <T>(result: Result<T, UsageError>): string | undefined => (result.ok ? undefined : result.error.code);
const total = async (store: UsageStore): Promise<number> => (await store.aggregate(ALL)).reduce((n, a) => n + a.attempts, 0);
const one = async (store: UsageStore, range: UsageRange = ALL): Promise<UsageAggregate> => {
  const rows = await store.aggregate(range);
  assert.equal(rows.length, 1, `expected one aggregate, got ${rows.length}`);
  return rows[0] as UsageAggregate;
};

export function usageStoreCases(): UsageStoreCase[] {
  return [
    {
      name: 'an empty store has nothing to add up',
      run: async (store) => {
        assert.deepEqual(await store.aggregate(ALL), []);
      },
    },
    {
      name: 'a record is added up with every figure, the day in UTC and the call counted',
      run: async (store) => {
        must(await store.append([rec({ cacheReadTokens: 400, cacheCreationTokens: 50 })]));
        assert.deepEqual(await one(store), {
          day: '2026-11-03',
          userId: U1,
          capability: 'categorise',
          scope: { kind: 'personal' },
          model: 'claude-haiku-4-5-20251001',
          calls: 1,
          attempts: 1,
          rejected: 0,
          failed: 0,
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          cacheCreationTokens: 50,
          latencyMs: 800,
        });
      },
    },
    {
      name: 'records of the same person, call type, scope, model and day are summed into one row',
      run: async (store) => {
        must(await store.append([rec(), rec({ at: D1 + 1000, inputTokens: 500, outputTokens: 50, latencyMs: 200 }), rec({ at: D1 + 2000, inputTokens: 0, outputTokens: 0, latencyMs: 0 })]));
        const a = await one(store);
        assert.equal(a.calls, 3);
        assert.equal(a.attempts, 3);
        assert.equal(a.inputTokens, 1500);
        assert.equal(a.outputTokens, 150);
        assert.equal(a.latencyMs, 1000);
      },
    },
    {
      name: 'a person, a call type, a scope, a model and a day each make a separate row',
      run: async (store) => {
        must(
          await store.append([
            rec(),
            rec({ userId: U2 }),
            rec({ capability: 'status' }),
            rec({ scope: { kind: 'circle', circleId: C1 } }),
            rec({ scope: { kind: 'circle', circleId: C2 } }),
            rec({ model: 'claude-sonnet-5-5' }),
            rec({ at: D1 + DAY }),
          ]),
        );
        assert.equal((await store.aggregate(ALL)).length, 7);
      },
    },
    {
      name: 'a call is its first attempt: a repair adds an attempt and not a call',
      run: async (store) => {
        must(await store.append([rec({ result: 'rejected' }), rec({ attempt: 2, at: D1 + 5 })]));
        const a = await one(store);
        assert.equal(a.calls, 1);
        assert.equal(a.attempts, 2);
        assert.equal(a.rejected, 1);
        assert.equal(a.failed, 0);
      },
    },
    {
      name: 'every way of failing counts as failed, and a rejected answer does not',
      run: async (store) => {
        const results = ['timeout', 'rate_limited', 'refused', 'bad_output', 'model_error', 'config', 'cancelled'] as const;
        must(await store.append([rec({ result: 'ok' }), rec({ result: 'rejected' }), ...results.map((result) => rec({ result }))]));
        const a = await one(store);
        assert.equal(a.attempts, 9);
        assert.equal(a.failed, 7);
        assert.equal(a.rejected, 1);
      },
    },
    {
      name: 'a batch is all or nothing: one bad record keeps none of it',
      run: async (store) => {
        assert.equal(code(await store.append([rec(), rec({ inputTokens: -1 }), rec()])), 'INVALID_INPUT');
        assert.equal(await total(store), 0);
        assert.equal(code(await store.append([rec({ result: 'maybe' as never })])), 'INVALID_INPUT');
        assert.equal(await total(store), 0);
      },
    },
    {
      name: 'an empty batch is fine and records nothing',
      run: async (store) => {
        must(await store.append([]));
        assert.equal(await total(store), 0);
      },
    },
    {
      name: 'a record with any field that is not part of it is refused, so no text can be stored',
      run: async (store) => {
        for (const extra of [{ text: 'Mum takes 2 tablets' }, { prompt: 'x' }, { subject: 'note-1' }, { factId: 'f' }]) {
          assert.equal(code(await store.append([{ ...rec(), ...extra } as UsageRecord])), 'INVALID_INPUT');
        }
        assert.equal(await total(store), 0);
      },
    },
    {
      name: 'a record with a field missing is refused',
      run: async (store) => {
        const rest: Record<string, unknown> = { ...rec() };
        delete rest.latencyMs;
        assert.equal(code(await store.append([rest as unknown as UsageRecord])), 'INVALID_INPUT');
        assert.equal(await total(store), 0);
      },
    },
    {
      name: 'the limits of each field are checked at their exact edges',
      run: async (store) => {
        const bad: Array<Partial<UsageRecord>> = [
          { userId: 'someone' },
          { userId: 'U0000000000000001' },
          { capability: 'agent' as never },
          { scope: { kind: 'circle', circleId: 'C1' } },
          { scope: { kind: 'circle', circleId: 'c1' } },
          { scope: { kind: 'personal', circleId: C1 } as never },
          { scope: { kind: 'world' } as never },
          { model: '' },
          { model: 'two words' },
          { model: 'x'.repeat(201) },
          { attempt: 3 as never },
          { attempt: 0 as never },
          { inputTokens: 1.5 },
          { outputTokens: -1 },
          { inputTokens: 1_000_000_001 },
          { cacheReadTokens: 2000 },
          { cacheReadTokens: 600, cacheCreationTokens: 401 },
          { latencyMs: 86_400_001 },
          { latencyMs: -1 },
          { at: -1 },
          { at: 1.5 },
          { at: 'now' as never },
        ];
        for (const extra of bad) assert.equal(code(await store.append([rec(extra)])), 'INVALID_INPUT', JSON.stringify(extra));
        assert.equal(await total(store), 0);
        const good: Array<Partial<UsageRecord>> = [
          { model: 'x'.repeat(200) },
          { model: '😀'.repeat(200) },
          { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 },
          { latencyMs: 86_400_000 },
          { latencyMs: 0 },
          { at: 0 },
          { attempt: 2 },
          { cacheReadTokens: 600, cacheCreationTokens: 400 },
          { scope: { kind: 'circle', circleId: 'czzzzzzzzzzzzzzzz' } },
        ];
        for (const extra of good) must(await store.append([rec(extra)]));
        assert.equal(await total(store), good.length);
      },
    },
    {
      name: 'a range includes its start and leaves out its end',
      run: async (store) => {
        must(await store.append([rec({ at: 1000 }), rec({ at: 2000 }), rec({ at: 3000 })]));
        assert.equal(await total(store), 3);
        const sum = async (from: number, to: number): Promise<number> => (await store.aggregate({ from, to })).reduce((n, a) => n + a.attempts, 0);
        assert.equal(await sum(1000, 3000), 2);
        assert.equal(await sum(1001, 3001), 2);
        assert.equal(await sum(2000, 2000), 0);
        assert.equal(await sum(2000, 2001), 1);
        assert.equal(await sum(4000, 5000), 0);
      },
    },
    {
      name: 'a bad range is a RangeError',
      run: async (store) => {
        for (const range of [{ from: 5, to: 4 }, { from: -1, to: 4 }, { from: 1.5, to: 4 }, { from: 1, to: Number.NaN }]) {
          await assert.rejects(() => store.aggregate(range), RangeError);
        }
      },
    },
    {
      name: 'the day is the UTC day: either side of midnight is a different row',
      run: async (store) => {
        const midnight = Date.UTC(2026, 10, 4);
        must(await store.append([rec({ at: midnight - 1 }), rec({ at: midnight }), rec({ at: midnight + DAY - 1 })]));
        const rows = await store.aggregate(ALL);
        assert.deepEqual(rows.map((r) => [r.day, r.attempts]), [['2026-11-03', 1], ['2026-11-04', 2]]);
      },
    },
    {
      name: 'the rows come in a fixed order: day, person (gone last), call type, scope, model',
      run: async (store) => {
        must(
          await store.append([
            rec({ at: D1 + DAY, userId: U1 }),
            rec({ userId: U2 }),
            rec({ userId: U1, capability: 'status' }),
            rec({ userId: U1, scope: { kind: 'circle', circleId: C1 } }),
            rec({ userId: U1, model: 'a-model' }),
            rec({ userId: U1 }),
          ]),
        );
        const keys = (await store.aggregate(ALL)).map((r) => [r.day, r.userId, r.capability, r.scope.kind === 'personal' ? 'personal' : r.scope.circleId, r.model].join('|'));
        assert.deepEqual(keys, [
          `2026-11-03|${U1}|categorise|c0000000000000001|claude-haiku-4-5-20251001`,
          `2026-11-03|${U1}|categorise|personal|a-model`,
          `2026-11-03|${U1}|categorise|personal|claude-haiku-4-5-20251001`,
          `2026-11-03|${U1}|status|personal|claude-haiku-4-5-20251001`,
          `2026-11-03|${U2}|categorise|personal|claude-haiku-4-5-20251001`,
          `2026-11-04|${U1}|categorise|personal|claude-haiku-4-5-20251001`,
        ]);
      },
    },
    {
      name: 'models are ordered by plain code-unit order, not by UTF-8 bytes',
      run: async (store) => {
        must(await store.append([rec({ model: '\uFF5E-model' }), rec({ model: '😀-model' }), rec({ model: 'a-model' })]));
        assert.deepEqual((await store.aggregate(ALL)).map((r) => r.model), ['a-model', '😀-model', '\uFF5E-model']);
      },
    },
    {
      name: 'clearing a person keeps their records and totals but no longer says whose they are',
      run: async (store) => {
        must(await store.append([rec(), rec({ at: D1 + 1, attempt: 2 }), rec({ userId: U2 })]));
        assert.equal(await store.clearUser(U1), 2);
        const rows = await store.aggregate(ALL);
        assert.deepEqual(rows.map((r) => [r.userId, r.attempts]), [[U2, 1], [null, 2]]);
        assert.equal(rows.find((r) => r.userId === null)?.calls, 1);
        assert.equal(rows.find((r) => r.userId === null)?.inputTokens, 2000);
        assert.equal(await store.clearUser(U1), 0);
        assert.equal(await store.clearUser(U2), 1);
      },
    },
    {
      name: 'cleared records of two people on the same day join into one row without a person',
      run: async (store) => {
        must(await store.append([rec(), rec({ userId: U2 })]));
        await store.clearUser(U1);
        await store.clearUser(U2);
        const a = await one(store);
        assert.equal(a.userId, null);
        assert.equal(a.attempts, 2);
      },
    },
    {
      name: 'clearing someone with no records, or a made-up id, changes nothing',
      run: async (store) => {
        must(await store.append([rec()]));
        assert.equal(await store.clearUser(U2), 0);
        assert.equal(await store.clearUser('nobody'), 0);
        assert.equal((await one(store)).userId, U1);
      },
    },
    {
      name: 'purging removes records older than the time, strictly, and says how many',
      run: async (store) => {
        must(await store.append([rec({ at: 1000 }), rec({ at: 2000 }), rec({ at: 3000 })]));
        assert.equal(await store.purgeBefore(2000), 1);
        assert.equal(await total(store), 2);
        assert.equal(await store.purgeBefore(2000), 0);
        assert.equal(await store.purgeBefore(3001), 2);
        assert.equal(await total(store), 0);
      },
    },
    {
      name: 'purging also removes the records of people who are gone',
      run: async (store) => {
        must(await store.append([rec({ at: 1000 })]));
        await store.clearUser(U1);
        assert.equal(await store.purgeBefore(2000), 1);
        assert.deepEqual(await store.aggregate(ALL), []);
      },
    },
    {
      name: 'what comes back is a copy: changing it, or the record that was written, changes nothing stored',
      run: async (store) => {
        const r = { ...rec(), scope: { kind: 'circle' as const, circleId: C1 } };
        must(await store.append([r]));
        (r as { inputTokens: number }).inputTokens = 5;
        (r.scope as { circleId: string }).circleId = C2;
        const first = (await store.aggregate(ALL))[0] as { inputTokens: number; scope: { circleId: string } };
        assert.equal(first.inputTokens, 1000);
        assert.equal(first.scope.circleId, C1);
        try {
          first.inputTokens = 7;
          first.scope.circleId = C2;
        } catch {
          // a frozen copy refuses, which is fine
        }
        const second = (await store.aggregate(ALL))[0] as { inputTokens: number; scope: { circleId: string } };
        assert.equal(second.inputTokens, 1000);
        assert.equal(second.scope.circleId, C1);
      },
    },
    {
      name: 'a large batch is kept whole',
      run: async (store) => {
        const batch = Array.from({ length: 600 }, (_, i) => rec({ at: D1 + i, userId: i % 2 === 0 ? U1 : U2 }));
        must(await store.append(batch));
        assert.equal(await total(store), 600);
        assert.equal((await store.aggregate(ALL)).length, 2);
      },
    },
    {
      name: 'simultaneous appends lose nothing',
      run: async (store) => {
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.append([rec({ at: D1 + i }), rec({ at: D1 + i, capability: 'status' })])));
        for (const r of results) must(r);
        assert.equal(await total(store), 40);
      },
    },
    {
      name: 'an append racing a purge or a clear leaves only whole results',
      run: async (store) => {
        must(await store.append([rec({ at: 1000 })]));
        await Promise.all([store.append([rec({ at: D1 })]), store.purgeBefore(2000), store.clearUser(U1)]);
        const rows = await store.aggregate(ALL);
        assert.ok(rows.length <= 2);
        assert.ok(rows.every((r) => r.attempts >= 1));
      },
    },
    {
      name: 'two stores share nothing',
      run: async (store, makeAnother) => {
        const other = await makeAnother();
        must(await store.append([rec()]));
        assert.equal(await total(other), 0);
        must(await other.append([rec({ userId: U2 }), rec({ userId: U2 })]));
        assert.equal(await total(store), 1);
        assert.equal(await store.purgeBefore(Date.UTC(2100, 0, 1)), 1);
        assert.equal(await total(other), 2);
      },
    },
  ];
}
