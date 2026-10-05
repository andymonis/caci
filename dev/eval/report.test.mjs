import { describe, expect, it } from 'vitest';
import { caseMatrix, formatMs, formatReport, percentile, summarizeResults } from './report.mjs';

const run = (model, caseId, extra = {}) => ({
  caseId, model, run: 1, pass: true, checks: [{ name: 'answered', pass: true, detail: '' }], error: null, attempts: 1, repaired: false,
  latencyMs: 1000, tokens: { inputTokens: 500, outputTokens: 50 }, answeredBy: `${model}-id`, proposal: null, ...extra,
});
const failing = (model, caseId, extra = {}) => run(model, caseId, { pass: false, checks: [{ name: 'answered', pass: true, detail: '' }, { name: 'reuses health', pass: false, detail: 'reused: none' }], ...extra });
const cases = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile(v, 10)).toBe(10);
    expect(percentile(v, 0)).toBe(10);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
  it('does not need its input sorted and does not change it', () => {
    const v = [30, 10, 20];
    expect(percentile(v, 50)).toBe(20);
    expect(v).toEqual([30, 10, 20]);
  });
});

describe('formatMs', () => {
  it.each([[0, '0 ms'], [999, '999 ms'], [1000, '1.00 s'], [9999, '10.00 s'], [12_345, '12.3 s']])('%s', (ms, text) => expect(formatMs(ms)).toBe(text));
  it('a dash for nothing', () => expect(formatMs(Number.NaN)).toBe('–'));
});

describe('summarizeResults', () => {
  const results = [
    run('fast', 'a', { latencyMs: 400 }), failing('fast', 'b', { latencyMs: 800, repaired: true }), run('fast', 'c', { latencyMs: 1200 }),
    run('deep', 'a', { latencyMs: 3000 }), run('deep', 'b', { latencyMs: 5000 }), failing('deep', 'c', { latencyMs: 4000, error: { code: 'REFUSED', message: 'no' }, tokens: { inputTokens: 0, outputTokens: 0 } }),
  ];
  const [fast, deep] = summarizeResults(results, ['fast', 'deep']);

  it('counts passes and the pass rate per model, in the order asked', () => {
    expect([fast.label, deep.label]).toEqual(['fast', 'deep']);
    expect(fast).toMatchObject({ runs: 3, passes: 2, answered: 3, repaired: 1 });
    expect(fast.passRate).toBeCloseTo(2 / 3);
    expect(deep).toMatchObject({ runs: 3, passes: 2, answered: 2, repaired: 0 });
  });
  it('sums tokens and averages them per run', () => {
    expect(fast.tokens).toEqual({ input: 1500, output: 150, perRun: 550 });
    expect(deep.tokens).toEqual({ input: 1000, output: 100, perRun: 366.6666666666667 });
  });
  it('gives latency mean, median, p95 and slowest', () => {
    expect(fast.latency).toEqual({ mean: 800, median: 800, p95: 1200, max: 1200 });
    expect(deep.latency).toEqual({ mean: 4000, median: 4000, p95: 5000, max: 5000 });
  });
  it('counts failed checks and error codes', () => {
    expect(fast.failedChecks).toEqual({ 'reuses health': 1 });
    expect(deep.errors).toEqual({ REFUSED: 1 });
    expect(fast.errors).toEqual({});
  });
  it('lists the models that actually answered', () => {
    expect(fast.answeredBy).toEqual(['fast-id']);
  });
  it('copes with a model that has no runs', () => {
    const [none] = summarizeResults([], ['x']);
    expect(none).toMatchObject({ runs: 0, passes: 0, passRate: 0, latency: { mean: 0, median: 0, p95: 0, max: 0 }, tokens: { input: 0, output: 0, perRun: 0 } });
  });
});

describe('caseMatrix', () => {
  it('shows pass, FAIL, a dash, and passes out of runs when repeated', () => {
    const results = [run('m1', 'a'), failing('m1', 'b'), run('m2', 'a', { run: 1 }), failing('m2', 'a', { run: 2 }), run('m2', 'a', { run: 3 })];
    const matrix = caseMatrix(results, cases, ['m1', 'm2']);
    expect(matrix).toEqual([
      { caseId: 'a', cells: { m1: 'pass', m2: '2/3' } },
      { caseId: 'b', cells: { m1: 'FAIL', m2: '–' } },
      { caseId: 'c', cells: { m1: '–', m2: '–' } },
    ]);
  });
});

describe('formatReport', () => {
  const results = [run('fast', 'a'), failing('fast', 'b', { latencyMs: 2500 }), run('deep', 'a', { latencyMs: 6000 }), run('deep', 'b')];
  const text = formatReport({ results, cases: cases.slice(0, 2), labels: ['fast', 'deep'], resolved: { fast: 'claude-haiku-x', deep: 'deep' }, meta: { mode: 'real', repeat: 1, aborted: false } });

  it('has a header saying what was run and with what', () => {
    expect(text.split('\n')[0]).toBe('Evaluation: 2 cases × 2 models × 1 run (4 done) — real model');
    expect(text).toContain('fast = claude-haiku-x');
    expect(text).not.toContain('deep = deep'); // only when the label differs from the id
  });
  it('puts the models side by side with the figures that decide', () => {
    for (const row of ['Pass rate', 'Answered', 'Needed a repair', 'Latency median / p95', 'Tokens in / out', 'Tokens per run']) expect(text).toContain(row);
    const passLine = text.split('\n').find((l) => l.startsWith('Pass rate'));
    expect(passLine).toContain('50% (1/2)');
    expect(passLine).toContain('100% (2/2)');
    expect(passLine.indexOf('50%')).toBeLessThan(passLine.indexOf('100%')); // columns follow the order asked
  });
  it('shows the most common failures and a case by model grid', () => {
    expect(text).toContain('fast: reuses health (1)');
    expect(text).toContain('deep: none');
    const grid = text.split('\n').filter((l) => /^(a|b)\s/.test(l));
    expect(grid[0]).toMatch(/^a\s+pass\s+pass$/);
    expect(grid[1]).toMatch(/^b\s+FAIL\s+pass$/);
  });
  it('lists the failures with the reason', () => {
    expect(text).toContain('Failures (1):');
    expect(text).toContain('fast · b: reuses health: reused: none');
  });
  it('says so when it was stopped early, and uses plural and singular properly', () => {
    const stopped = formatReport({ results: [run('fast', 'a')], cases: [{ id: 'a' }], labels: ['fast'], meta: { mode: 'scripted', repeat: 2, aborted: true } });
    expect(stopped.split('\n')[0]).toBe('Evaluation: 1 cases × 1 model × 2 runs (1 done) — scripted model — STOPPED EARLY');
  });
  it('lists errors by code, and caps a long list of failures', () => {
    const many = Array.from({ length: 25 }, (_, i) => failing('fast', `case-${i}`, { error: i === 0 ? { code: 'TIMEOUT', message: 't' } : null }));
    const long = formatReport({ results: many, cases: many.map((m) => ({ id: m.caseId })), labels: ['fast'], meta: { mode: 'real', repeat: 1, aborted: false } });
    expect(long).toContain('Errors:');
    expect(long).toContain('fast: TIMEOUT × 1');
    expect(long).toContain('Failures (25):');
    expect(long).toContain('… and 5 more (see the saved results)');
    expect(long.split('\n').filter((l) => l.startsWith('  fast · ')).length).toBe(20);
  });
  it('marks repeated runs of a failure', () => {
    const t = formatReport({ results: [failing('fast', 'a', { run: 2 })], cases: [{ id: 'a' }], labels: ['fast'], meta: { mode: 'real', repeat: 2, aborted: false } });
    expect(t).toContain('fast · a #2:');
  });
});
