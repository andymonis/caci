import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { costOf, parsePrices, priceOf, type ModelPrice, type PriceTable } from './prices.js';
import { buildReport, DELETED_ACCOUNT, GROUP_BYS, invoiceDifference } from './report.js';
import { csvCell, renderReport, reportCsv } from './render.js';
import type { UsageAggregate } from './types.js';

const U1 = 'u0000000000000001';
const U2 = 'u0000000000000002';
const C1 = 'c0000000000000001';
const HAIKU = 'claude-haiku-4-5-20251001';
const haiku = (t: PriceTable): ModelPrice => {
  const price = priceOf(t, HAIKU);
  if (price === undefined) throw new Error('the test table prices haiku');
  return price;
};
const TABLE = (): PriceTable => {
  const p = parsePrices({ asOf: '2026-11-12', currency: 'USD', note: 'n', models: { [HAIKU]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, demo: { input: 0, output: 0 } } });
  if (!p.ok) throw new Error(p.problems.join('; '));
  return p.value;
};
const row = (extra: Partial<UsageAggregate>): UsageAggregate => ({ day: '2026-11-03', userId: U1, capability: 'categorise', scope: { kind: 'personal' }, model: HAIKU, calls: 0, attempts: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 0, ...extra });
const ROWS: UsageAggregate[] = [
  row({ calls: 10, attempts: 12, rejected: 2, inputTokens: 12000, outputTokens: 1200, cacheReadTokens: 6000, cacheCreationTokens: 1000, latencyMs: 9000 }), // 0.01285
  row({ userId: U2, capability: 'status', scope: { kind: 'circle', circleId: C1 }, calls: 2, attempts: 2, inputTokens: 4000, outputTokens: 400, latencyMs: 2000 }), // 0.006
  row({ day: '2026-12-01', capability: 'status', model: 'mystery-model', calls: 1, attempts: 1, inputTokens: 1000, outputTokens: 100 }), // unpriced
  row({ day: '2026-12-01', userId: null, calls: 3, attempts: 3, failed: 1, inputTokens: 3000, outputTokens: 300 }), // 0.0045, an account that is gone
  row({ day: '2026-12-01', userId: U2, capability: 'check', model: 'demo', calls: 1, attempts: 1, inputTokens: 500, outputTokens: 50 }), // free
];

describe('the price table', () => {
  it('is checked strictly, and every problem is listed', () => {
    const r = parsePrices({ asOf: '2026-02-30', currency: 'dollars!', note: 5, extra: 1, models: { 'two words': {}, ok: { input: -1, output: 'x', cacheRead: 1e9, other: 1 }, fine: { input: 1, output: 2 } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.problems.join('\n');
    for (const part of ['no field "extra"', 'asOf must be a real date', 'currency must be', 'note must be text', 'a model name must be', 'ok: input', 'ok: output', 'ok: cacheRead', 'ok: no field "other"']) expect(text).toContain(part);
    expect(text).not.toContain('fine');
  });
  it('refuses things that are not a table', () => {
    for (const v of [null, [], 'x', 1]) expect(parsePrices(v).ok).toBe(false);
    expect(parsePrices({ asOf: '2026-11-12', currency: 'USD', note: '', models: [] }).ok).toBe(false);
    expect(parsePrices({ asOf: '2026-11-12', currency: 'USD', note: '', models: { m: 5 } }).ok).toBe(false);
  });
  it('a missing cache price is the plain input price, and an entry is read exactly', () => {
    const p = parsePrices({ asOf: '2026-11-12', currency: 'GBP', note: '', models: { m: { input: 2, output: 8 } } });
    expect(p.ok && p.value.models.m).toEqual({ input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
    expect(p.ok && Object.isFrozen(p.value)).toBe(true);
    expect(parsePrices({ asOf: '2026-11-12', currency: 'GBP', note: '', models: { m: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } } })).toMatchObject({ ok: true, value: { models: { m: { cacheRead: 0, cacheWrite: 0 } } } });
  });
  it('accepts the boundaries: a price of 0 and of 100,000, a 200-character model name, a 500-character note', () => {
    const models = { [`${'m'.repeat(199)}x`]: { input: 0, output: 100_000 } };
    expect(parsePrices({ asOf: '2024-02-29', currency: 'USD', note: 'n'.repeat(500), models }).ok).toBe(true);
    expect(parsePrices({ asOf: '2024-02-29', currency: 'USD', note: 'n'.repeat(501), models }).ok).toBe(false);
    expect(parsePrices({ asOf: '2024-02-29', currency: 'USD', note: '', models: { m: { input: 0, output: 100_001 } } }).ok).toBe(false);
    expect(parsePrices({ asOf: '2024-02-29', currency: 'USD', note: '', models: { ['m'.repeat(201)]: { input: 0, output: 1 } } }).ok).toBe(false);
  });
  it('looks a model up by its exact name and never through the prototype', () => {
    const t = TABLE();
    expect(priceOf(t, HAIKU)?.input).toBe(1);
    expect(priceOf(t, 'toString')).toBeUndefined();
    expect(priceOf(t, '__proto__')).toBeUndefined();
    expect(priceOf(t, 'CLAUDE-HAIKU-4-5-20251001')).toBeUndefined();
  });
  it('costs plain input, cache reads, cache writes and output at their own prices, per million tokens', () => {
    const t = TABLE();
    expect(costOf(haiku(t), { inputTokens: 12000, outputTokens: 1200, cacheReadTokens: 6000, cacheCreationTokens: 1000 })).toBeCloseTo(0.01285, 10);
    expect(costOf(haiku(t), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeCloseTo(1, 10);
    expect(costOf(haiku(t), { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeCloseTo(5, 10);
  });
  it('the price file in the repository is valid and prices the free demo model and the cheap model', () => {
    const file = JSON.parse(readFileSync(new URL('../../usage-prices.json', import.meta.url), 'utf8')) as unknown;
    const parsed = parsePrices(file);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(priceOf(parsed.value, 'demo')).toMatchObject({ input: 0, output: 0 });
      expect(priceOf(parsed.value, HAIKU)?.output).toBe(5);
      expect(parsed.value.note).toContain('invoice');
    }
  });
});

describe('building the report', () => {
  const report = (by: (typeof GROUP_BYS)[number]) => buildReport(ROWS, TABLE(), { by, label: (id) => (id === U1 ? 'ann' : id === U2 ? 'bob' : undefined) });

  it('adds up the totals and counts an unpriced model\'s tokens but not its cost', () => {
    const r = report('user');
    expect(r.totals).toMatchObject({ calls: 17, attempts: 19, rejected: 2, failed: 1, inputTokens: 20500, outputTokens: 2050, cacheReadTokens: 6000, cacheCreationTokens: 1000, latencyMs: 11000, unpricedAttempts: 1 });
    expect(r.totals.cost).toBeCloseTo(0.02335, 10);
    expect(r.currency).toBe('USD');
    expect(r.asOf).toBe('2026-11-12');
    expect(r.unpriced).toEqual([{ model: 'mystery-model', attempts: 1, inputTokens: 1000, outputTokens: 100 }]);
  });

  it('groups by user, with accounts that are gone together, the biggest spender first', () => {
    const r = report('user');
    expect(r.groups.map((g) => [g.key, g.attempts])).toEqual([[U1, 13], [U2, 3], [DELETED_ACCOUNT, 3]]); // by cost: ann, bob, then the deleted accounts
    expect(r.groups.map((g) => g.key)).toEqual([U1, U2, DELETED_ACCOUNT]);
    expect(r.groups[0]?.cost).toBeCloseTo(0.01285, 10);
    expect(r.groups[0]?.unpricedAttempts).toBe(1);
  });

  it('shows a username for a person when one is known, the id when not, and the same words for accounts that are gone', () => {
    const r = report('user');
    expect(r.groups.map((g) => [g.key, g.label])).toEqual([[U1, 'ann'], [U2, 'bob'], [DELETED_ACCOUNT, DELETED_ACCOUNT]]);
    expect(buildReport(ROWS, TABLE(), { by: 'user' }).groups.map((g) => g.label)).toEqual([U1, U2, DELETED_ACCOUNT]);
    expect(report('model').groups.map((g) => g.label)).toEqual([HAIKU, 'demo', 'mystery-model']); // only people get labels
    expect(buildReport(ROWS, TABLE(), { by: 'user', label: () => 'x' }).groups.at(-1)?.label).toBe(DELETED_ACCOUNT);
  });

  it('groups by call type, model, circle, day and month', () => {
    expect(report('capability').groups.map((g) => [g.key, g.attempts])).toEqual([['categorise', 15], ['status', 3], ['check', 1]]);
    expect(report('model').groups.map((g) => [g.key, g.attempts])).toEqual([[HAIKU, 17], ['demo', 1], ['mystery-model', 1]]);
    expect(report('circle').groups.map((g) => [g.key, g.attempts])).toEqual([['personal', 17], [C1, 2]]);
    expect(report('day').groups.map((g) => [g.key, g.attempts])).toEqual([['2026-11-03', 14], ['2026-12-01', 5]]);
    expect(report('month').groups.map((g) => [g.key, g.attempts])).toEqual([['2026-11', 14], ['2026-12', 5]]);
    expect(report('day').groups.map((g) => g.key)).toEqual(['2026-11-03', '2026-12-01']); // by time, not by cost
  });

  it('breaks ties between groups by key', () => {
    const r = buildReport([row({ userId: U2, calls: 1, attempts: 1 }), row({ userId: U1, calls: 1, attempts: 1 })], TABLE(), { by: 'user' });
    expect(r.groups.map((g) => g.key)).toEqual([U1, U2]);
  });

  it('days and months are in time order even when a later one cost more, and at most ten spenders are listed by default', () => {
    const rows = [row({ day: '2026-01-05', calls: 1, attempts: 1, inputTokens: 1000 }), row({ day: '2026-02-05', calls: 1, attempts: 1, inputTokens: 9_000_000 })];
    expect(buildReport(rows, TABLE(), { by: 'day' }).groups.map((g) => g.key)).toEqual(['2026-01-05', '2026-02-05']);
    expect(buildReport(rows, TABLE(), { by: 'month' }).groups.map((g) => g.key)).toEqual(['2026-01', '2026-02']);
    expect(buildReport(rows, TABLE(), { by: 'user' }).groups).toHaveLength(1);
    const twelve = Array.from({ length: 12 }, (_, i) => row({ userId: `u${String(i + 1).padStart(16, '0')}`, calls: 1, attempts: 1, inputTokens: 1000 * (i + 1) }));
    expect(buildReport(twelve, TABLE(), { by: 'user' }).topSpenders).toHaveLength(10);
  });

  it('gives the average cost of one call by call type, over the priced calls only', () => {
    const r = report('user');
    const by = Object.fromEntries(r.perCall.map((c) => [c.capability, c]));
    expect(r.perCall.map((c) => c.capability)).toEqual(['categorise', 'status', 'check']);
    expect(by.categorise).toMatchObject({ calls: 13, pricedCalls: 13 });
    expect(by.categorise?.cost).toBeCloseTo(0.01735, 10);
    expect(by.categorise?.averageCost).toBeCloseTo(0.01735 / 13, 10);
    expect(by.status).toMatchObject({ calls: 3, pricedCalls: 2 });
    expect(by.status?.averageCost).toBeCloseTo(0.003, 10);
    expect(by.check).toMatchObject({ calls: 1, pricedCalls: 1, cost: 0, averageCost: 0 });
  });

  it('an average is null when no call of that kind was priced', () => {
    const r = buildReport([row({ model: 'mystery', calls: 2, attempts: 2 })], TABLE(), { by: 'user' });
    expect(r.perCall[0]).toMatchObject({ pricedCalls: 0, averageCost: null });
  });

  it('gives the repair, refusal and failure rates', () => {
    const r = report('user');
    expect(r.repairRate).toBeCloseTo(2 / 17, 10);
    expect(r.rejectedRate).toBeCloseTo(2 / 19, 10);
    expect(r.failedRate).toBeCloseTo(1 / 19, 10);
    const none = buildReport([], TABLE(), { by: 'user' });
    expect([none.repairRate, none.rejectedRate, none.failedRate]).toEqual([0, 0, 0]);
    expect(none.groups).toEqual([]);
    expect(none.perCall).toEqual([]);
  });

  it('lists the top spenders among live accounts with their share, and the spread', () => {
    const r = report('user');
    expect(r.topSpenders.map((s) => [s.userId, s.label])).toEqual([[U1, 'ann'], [U2, 'bob']]);
    expect(r.topSpenders[0]?.share).toBeCloseTo(0.01285 / 0.01885, 10);
    expect(r.topSpenders[0]?.cost).toBeCloseTo(0.01285, 10);
    expect(r.distribution).toMatchObject({ people: 2 });
    expect(r.distribution.mean).toBeCloseTo(0.009425, 10);
    expect(r.distribution.median).toBeCloseTo(0.006, 10);
    expect(r.distribution.p90).toBeCloseTo(0.01285, 10);
    expect(r.distribution.max).toBeCloseTo(0.01285, 10);
    expect(r.distribution.topTenthShare).toBeCloseTo(0.01285 / 0.01885, 10);
    expect(r.deletedCost).toBeCloseTo(0.0045, 10);
  });

  it('shows the id when no label is known, and limits the top spenders', () => {
    const r = buildReport(ROWS, TABLE(), { by: 'user', top: 1 });
    expect(r.topSpenders).toHaveLength(1);
    expect(r.topSpenders[0]?.label).toBe(U1);
  });

  it('the top tenth is at least one person and rounds up', () => {
    const many = Array.from({ length: 25 }, (_, i) => row({ userId: `u${String(i + 1).padStart(16, '0')}`, calls: 1, attempts: 1, inputTokens: 1_000_000 * (i + 1) }));
    const r = buildReport(many, TABLE(), { by: 'user' });
    const total = (25 * 26) / 2;
    expect(r.distribution.topTenthShare).toBeCloseTo((25 + 24 + 23) / total, 10); // ceil(25/10) = 3 people
    expect(r.distribution.people).toBe(25);
  });

  it('is deterministic whatever order the rows come in, and frozen', () => {
    const a = report('user');
    const b = buildReport([...ROWS].reverse(), TABLE(), { by: 'user', label: (id) => (id === U1 ? 'ann' : id === U2 ? 'bob' : undefined) });
    expect(b).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.groups)).toBe(true);
    expect(Object.isFrozen(a.groups[0])).toBe(true);
  });

  it('the invoice difference says how far the estimate is from an amount', () => {
    expect(invoiceDifference(10, 8)).toEqual({ estimate: 10, invoice: 8, difference: 2, percent: 25 });
    expect(invoiceDifference(6, 8)).toEqual({ estimate: 6, invoice: 8, difference: -2, percent: -25 });
    expect(invoiceDifference(5, 0)).toEqual({ estimate: 5, invoice: 0, difference: 5, percent: null });
  });
});

describe('showing the report', () => {
  const r = buildReport(ROWS, TABLE(), { by: 'user', label: (id) => (id === U1 ? 'ann' : id === U2 ? 'bob' : undefined) });

  it('says it is an estimate, shows the table and total, the averages, the rates, the spread, top spenders, deleted accounts and unpriced models', () => {
    const text = renderReport(r, { period: '2026-11-01 to 2026-12-31' });
    for (const part of ['Usage report by user, 2026-11-01 to 2026-12-31', "the provider's invoice is the truth", 'total', '19', '20,500', r.totals.cost.toFixed(4), '* includes attempts on a model with no price', 'categorise: 0.0013 over 13 priced of 13 calls', 'status: 0.0030 over 2 priced of 3 calls', 'Repairs: 0.12 extra attempts per call; 10.5% of attempts refused', '5.3% of attempts failed', 'Spread over 2 people', 'ann: 0.0129 (68.2%)', 'deleted accounts: 0.0045', 'mystery-model: 1 attempts, 1,000 input and 100 output tokens']) expect(text, part).toContain(part);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain(`${(r.groups[0]?.cost ?? 0).toFixed(4)}*`); // ann has an attempt on an unpriced model
    expect(text).not.toContain(`${(r.groups[1]?.cost ?? 0).toFixed(4)}*`); // bob has none
  });

  it('shows the invoice line, with a sign and a percentage', () => {
    const text = renderReport(r, { invoice: invoiceDifference(r.totals.cost, 0.02) });
    const est = r.totals.cost.toFixed(4);
    expect(text).toContain(`Invoice: you gave 0.0200 USD; the estimate is ${est}; the difference is +${(r.totals.cost - 0.02).toFixed(4)} (+${(((r.totals.cost - 0.02) / 0.02) * 100).toFixed(1)}%).`);
    expect(renderReport(r, { invoice: invoiceDifference(0.01, 0.02) })).toContain('the difference is -0.0100 (-50.0%)');
    expect(renderReport(r, { invoice: invoiceDifference(0.01, 0) })).toContain('the difference is +0.0100.');
  });

  it('an empty period says so plainly and does not divide by zero', () => {
    const text = renderReport(buildReport([], TABLE(), { by: 'month' }));
    expect(text).toContain('no calls in this period');
    expect(text).toContain('Spread over 0 people');
    expect(text).not.toMatch(/NaN|Infinity|Top spenders/);
  });

  it('says person for one, and leaves out the unpriced and deleted lines when there are none', () => {
    const text = renderReport(buildReport([row({ calls: 1, attempts: 1, inputTokens: 100 })], TABLE(), { by: 'user' }));
    expect(text).toContain('Spread over 1 person:');
    expect(text).not.toContain('Models with no price');
    expect(text).not.toContain('deleted accounts');
    expect(text).not.toContain('* includes');
  });

  it('makes a CSV with a header, a line per group and a total, quoting and defusing cells', () => {
    const csv = reportCsv(r);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('user,calls,attempts,rejected,failed,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,latencyMs,costUSD,unpricedAttempts');
    expect(lines).toHaveLength(1 + 3 + 1);
    expect(lines[1]).toBe(`ann,11,13,2,0,13000,1300,6000,1000,9000,0.012850,1`);
    expect(lines.at(-1)).toMatch(/^total,17,19,2,1,20500,2050,6000,1000,11000,0\.023350,1$/);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
});
