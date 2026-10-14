import { describe, expect, it } from 'vitest';
import { controls, demoClient, lib } from './lib.test-util.mjs';
import { plannedCalls, runEval } from './runner.mjs';

const FAST = { label: 'fast', choice: { tier: 'fast' } };
const DEEP = { label: 'deep', choice: { tier: 'deep' } };
const sc = (id) => ({
  id, title: 't', description: 'd',
  notes: [{ id: 'n1', at: '2026-01-05', text: 'GP prescribed Mum 2 x Tablet A a day.' }, { id: 'n2', at: '2026-01-06', text: 'Bought bread.' }],
  questions: [{ id: 'q1', kind: 'recall', after: 'n2', ask: 'What did the GP prescribe?', must: [['Tablet A']] }],
});
const base = { lib, controls, fileWith: FAST, answerWith: [FAST], repeat: 1, order: 'oldest-first', windowTokens: 150000, makeClient: () => demoClient() };

describe('plannedCalls', () => {
  const scenarios = [sc('a'), sc('b')];
  it('counts filing once per note and answers per question, model and repeat', () => {
    expect(plannedCalls({ scenarios, arms: ['brain', 'replay'], answerWith: [FAST, DEEP], repeat: 3 })).toEqual({ filing: 4, brain: 12, replay: 12, total: 28 });
    // filler adds notes to file and repeats everything for each pad size
    expect(plannedCalls({ scenarios, arms: ['brain', 'replay'], answerWith: [FAST], repeat: 1, pads: [0, 10] })).toEqual({ filing: 4 + 24, brain: 4, replay: 4, total: 36 });
    expect(plannedCalls({ scenarios, arms: ['replay'], answerWith: [FAST], repeat: 1 })).toEqual({ filing: 0, brain: 0, replay: 2, total: 2 });
    expect(plannedCalls({ scenarios, arms: ['brain'], answerWith: [FAST], repeat: 2 })).toEqual({ filing: 4, brain: 4, replay: 0, total: 8 });
  });
});

describe('runEval with filler', () => {
  it('runs every scenario once for each pad size, tags the results and pads with the seed', async () => {
    const r = await runEval({ ...base, scenarios: [sc('a')], arms: ['brain', 'replay'], pads: [0, 6], seed: 3 });
    expect(r.results.map((x) => [x.pad, x.arm, x.entriesUsed])).toEqual([[0, 'brain', 2], [0, 'replay', 2], [6, 'brain', 8], [6, 'replay', 8]]);
    expect(r.filing.map((f) => f.pad)).toEqual([0, 0, ...Array(8).fill(6)]);
    const again = await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], pads: [6], seed: 3 });
    expect(again.results[0].entriesUsed).toBe(8);
  });
  it('a different seed gives different filler', async () => {
    const seen = [];
    const run = (seed) => runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], pads: [6], seed, makeClient: () => ({ complete: (req) => (seen.push(req.messages[0].content), demoClient().complete(req)) }) });
    await run(1);
    await run(2);
    await run(1);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[0]).not.toBe(seen[1]);
  });
  it('the numbers in the results are numbered across pad sizes', async () => {
    const seen = [];
    await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], pads: [0, 2], onResult: (_x, n) => seen.push(n) });
    expect(seen).toEqual([1, 2]);
  });
});

describe('runEval', () => {
  it('runs both arms over every scenario, brain first, and numbers the results', async () => {
    const seen = [];
    const r = await runEval({ ...base, scenarios: [sc('a'), sc('b')], arms: ['brain', 'replay'], onResult: (x, n) => seen.push([n, x.arm, x.scenario]) });
    expect(r.aborted).toBe(false);
    expect(seen).toEqual([[1, 'brain', 'a'], [2, 'replay', 'a'], [3, 'brain', 'b'], [4, 'replay', 'b']]);
    expect(r.results).toHaveLength(4);
    expect(r.filing.map((f) => [f.scenario, f.note])).toEqual([['a', 'n1'], ['a', 'n2'], ['b', 'n1'], ['b', 'n2']]);
  });
  it('one arm only', async () => {
    const brain = await runEval({ ...base, scenarios: [sc('a')], arms: ['brain'] });
    expect(brain.results.map((x) => x.arm)).toEqual(['brain']);
    const replay = await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'] });
    expect(replay.results.map((x) => x.arm)).toEqual(['replay']);
    expect(replay.filing).toEqual([]);
  });
  it('passes the order and the window to the replay arm', async () => {
    const r = await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], windowTokens: 5 });
    expect(r.results[0].overWindow).toBe(true);
    const seen = [];
    await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], order: 'newest-first', makeClient: () => ({ complete: (req) => (seen.push(req.messages[0].content), demoClient().complete(req)) }) });
    expect(seen[0].indexOf('Bought bread')).toBeLessThan(seen[0].indexOf('GP prescribed'));
  });
  it('passes repeat and the models on', async () => {
    const r = await runEval({ ...base, scenarios: [sc('a')], arms: ['replay'], answerWith: [FAST, DEEP], repeat: 2 });
    expect(r.results.map((x) => `${x.model}${x.run}`)).toEqual(['fast1', 'fast2', 'deep1', 'deep2']);
  });
  it('stops between scenarios, inside the brain arm and before the replay arm', async () => {
    const before = new AbortController();
    before.abort();
    expect(await runEval({ ...base, scenarios: [sc('a')], arms: ['brain', 'replay'], signal: before.signal })).toMatchObject({ aborted: true, results: [] });
    const c1 = new AbortController();
    const brain = await runEval({ ...base, scenarios: [sc('a'), sc('b')], arms: ['brain', 'replay'], signal: c1.signal, onResult: () => c1.abort() });
    expect(brain).toMatchObject({ aborted: true });
    expect(brain.results.map((x) => x.arm)).toEqual(['brain']);
    const c2 = new AbortController();
    const two = { ...sc('a'), questions: [sc('a').questions[0], { ...sc('a').questions[0], id: 'q2' }] };
    const replay = await runEval({ ...base, scenarios: [two, sc('b')], arms: ['replay'], signal: c2.signal, onResult: () => c2.abort() });
    expect(replay).toMatchObject({ aborted: true });
    expect(replay.results).toHaveLength(1);
  });
});
