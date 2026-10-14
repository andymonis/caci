import { describe, expect, it } from 'vitest';
import { runBrainArm } from './brain-arm.mjs';
import { controls, demoClient, lib } from './lib.test-util.mjs';
import { DEFAULT_WINDOW_TOKENS, entriesFor, estimateTokens, ORDERS, runReplayArm } from './replay-arm.mjs';
import { timeOf } from './scenario.mjs';

const FAST = { label: 'fast', choice: { tier: 'fast' } };
const DEEP = { label: 'deep', choice: { tier: 'deep' } };
const scenario = () => ({
  id: 'meds', title: 't', description: 'd',
  notes: [
    { id: 'n1', at: '2026-01-05', text: 'GP prescribed Mum 2 x Tablet A a day.' },
    { id: 'n2', at: '2026-01-12', text: 'Bought bread and milk.' },
    { id: 'n3', at: '2026-03-02T10:30Z', text: 'Check-up: Mum now takes 1 x Tablet B a day.' },
  ],
  questions: [
    { id: 'q-early', kind: 'recall', after: 'n2', ask: 'What did the GP prescribe for Mum?', must: [['Tablet A']] },
    { id: 'q-now', kind: 'override', after: 'n3', ask: 'What tablets does Mum take?', must: [['1 x Tablet B']], stale: ['2 x Tablet A'] },
    { id: 'q-none', kind: 'distractor', after: 'n3', ask: 'zzzz', expectNothing: true },
  ],
});
const run = (over = {}) => runReplayArm({ lib, controls, scenario: scenario(), answerWith: [FAST], makeClient: () => demoClient(), ...over });
const q = (id) => scenario().questions.find((x) => x.id === id);

describe('the entries', () => {
  it('are exactly the notes up to the checkpoint, oldest first, each with its date', () => {
    expect(entriesFor(scenario(), q('q-early'))).toEqual([
      { where: 'personal', text: 'GP prescribed Mum 2 x Tablet A a day.', when: timeOf('2026-01-05') },
      { where: 'personal', text: 'Bought bread and milk.', when: timeOf('2026-01-12') },
    ]);
    expect(entriesFor(scenario(), q('q-now'))).toHaveLength(3);
  });
  it('newest-first reverses them', () => {
    expect(entriesFor(scenario(), q('q-now'), 'newest-first').map((e) => e.text[0])).toEqual(['C', 'B', 'G']);
    expect(ORDERS).toEqual(['oldest-first', 'newest-first']);
  });
  it('the size estimate is about four characters to a token, request included', () => {
    expect(estimateTokens('abcd', [{ text: 'abcdefgh' }, { text: 'abcd' }])).toBe(4);
    expect(estimateTokens('a', [])).toBe(1);
  });
});

describe('the replay arm with the demo model', () => {
  it('shows the model every note up to the checkpoint, and keeps old notes however many come later', async () => {
    const r = await run();
    expect(r.aborted).toBe(false);
    expect(r.answers.map((a) => [a.question, a.entriesUsed])).toEqual([['q-early', 2], ['q-now', 3], ['q-none', 3]]);
    expect(r.answers[0]).toMatchObject({ arm: 'replay', scenario: 'meds', kind: 'recall', model: 'fast', run: 1, attempts: 1, error: null, overWindow: false, entriesLeftOut: 0, pass: true });
    expect(r.answers[0].tokens.inputTokens).toBeGreaterThan(0);
    expect(r.answers[0].diagnostic).toMatchObject({ inBrain: [true], inContext: [true], inAnswer: [true], lostAt: null });
    expect(r.answers[2].diagnostic).toBeNull();
  });

  it('files nothing and stores nothing: no filing model is ever asked', async () => {
    const roles = [];
    const seen = [];
    await run({ makeClient: (who) => (roles.push(who.role), { complete: (req) => (seen.push(req.meta?.capability), demoClient().complete(req)) }) });
    expect(roles).toEqual(['answer']);
    expect(new Set(seen)).toEqual(new Set(['status']));
  });

  it('asks the same question of the same model the same way in both arms except for the entries', async () => {
    const take = () => {
      const requests = [];
      const makeClient = () => ({ complete: (req) => (req.meta?.capability === 'status' && requests.push(req), demoClient().complete(req)) });
      return [requests, makeClient];
    };
    const [a, makeA] = take();
    const [b, makeB] = take();
    await runBrainArm({ lib, controls, scenario: scenario(), fileWith: FAST, answerWith: [FAST], makeClient: makeA });
    await run({ makeClient: makeB });
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(b[i].system).toBe(a[i].system);
      expect(b[i].model).toBe(a[i].model);
      expect(b[i].outputSchema).toEqual(a[i].outputSchema);
      const request = (r) => /<request>[\s\S]*<\/request>/.exec(r.messages[0].content)[0];
      expect(request(b[i])).toBe(request(a[i]));
    }
  });

  it('an over-window transcript is not sent, and says so', async () => {
    const calls = [];
    const r = await run({ windowTokens: 10, makeClient: () => ({ complete: (req) => (calls.push(req), demoClient().complete(req)) }) });
    expect(calls).toHaveLength(0);
    expect(r.answers.every((a) => a.overWindow && !a.pass && a.answer === null && a.error === null && a.entriesUsed === 0)).toBe(true);
    expect(r.answers[0].diagnostic.inContext).toEqual([false]);
    expect(r.answers[0].diagnostic.lostAt).toBe('context');
    expect(r.answers[0].estimatedTokens).toBeGreaterThan(10);
  });

  it('just inside the window is sent', async () => {
    const n = estimateTokens(q('q-early').ask, entriesFor(scenario(), q('q-early')));
    const r = await run({ windowTokens: n });
    expect(r.answers[0].overWindow).toBe(false);
    const tight = await run({ windowTokens: n - 1 });
    expect(tight.answers[0].overWindow).toBe(true);
    expect(DEFAULT_WINDOW_TOKENS).toBe(150_000);
  });

  it('lifts the size limits so a long transcript is not refused', async () => {
    const sc = scenario();
    sc.notes = Array.from({ length: 600 }, (_, i) => ({ id: `n${i + 1}`, at: '2026-01-05', text: `note ${i} ${'x'.repeat(i === 5 ? 1700 : 900)}` }));
    sc.questions = [{ id: 'q', kind: 'recall', after: 'n600', ask: 'note 3', must: [['note 3']] }];
    const r = await run({ scenario: sc });
    expect(r.answers[0].error).toBeNull();
    expect(r.answers[0].entriesUsed).toBe(600);
  });

  it('newest-first sends the entries the other way round', async () => {
    const seen = [];
    await run({ order: 'newest-first', makeClient: () => ({ complete: (req) => (seen.push(req.messages[0].content), demoClient().complete(req)) }) });
    const entries = seen[1];
    expect(entries.indexOf('1 x Tablet B')).toBeLessThan(entries.indexOf('2 x Tablet A'));
    await expect(run({ order: 'sideways' })).rejects.toThrow(TypeError);
  });

  it('asks every model and repeat, a failing model is an error not a crash, and it can be stopped', async () => {
    const r = await run({ answerWith: [FAST, DEEP], repeat: 2 });
    expect(r.answers.filter((a) => a.question === 'q-early').map((a) => [a.model, a.run])).toEqual([['fast', 1], ['fast', 2], ['deep', 1], ['deep', 2]]);
    const bad = await run({ makeClient: () => ({ complete: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow', retryable: true } }) }) });
    expect(bad.answers[0].error).toMatchObject({ source: 'llm', code: 'RATE_LIMITED' });
    const controller = new AbortController();
    const stopped = await run({ signal: controller.signal, onResult: () => controller.abort() });
    expect(stopped).toMatchObject({ aborted: true });
    expect(stopped.answers).toHaveLength(1);
  });

  it('gives each call a generous time limit, settable', async () => {
    const limits = [];
    const spy = () => ({ complete: (req) => (limits.push(req.timeoutMs), demoClient().complete(req)) });
    await run({ makeClient: spy });
    await run({ makeClient: spy, timeoutMs: 5000 });
    expect(new Set(limits.slice(0, 3))).toEqual(new Set([120_000]));
    expect(new Set(limits.slice(3))).toEqual(new Set([5000]));
  });

  it('asks at the checkpoint time', async () => {
    const r = await run();
    expect(r.answers[0].answer.headline).toContain('Monday 12 January 2026');
  });
});
