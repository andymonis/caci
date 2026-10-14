import { describe, expect, it } from 'vitest';
import { entriesOf, lostAt, recordingClient, runBrainArm } from './brain-arm.mjs';
import { controls, demoClient, lib } from './lib.test-util.mjs';

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
const run = (over = {}) => runBrainArm({ lib, controls, scenario: scenario(), fileWith: FAST, answerWith: [FAST], makeClient: () => demoClient(), ...over });

describe('the brain arm with the demo model', () => {
  it('files every note, and each lands with its own date', async () => {
    const r = await run();
    expect(r.aborted).toBe(false);
    expect(r.filing.map((f) => [f.note, f.ok])).toEqual([['n1', true], ['n2', true], ['n3', true]]);
    const early = r.answers.find((a) => a.question === 'q-early');
    expect(early.entriesUsed).toBe(2); // only the notes up to the checkpoint
    expect(early.answer.headline).toContain('Monday 12 January 2026'); // the question is asked an hour after its checkpoint note
    const now = r.answers.find((a) => a.question === 'q-now');
    expect(now.entriesUsed).toBe(3);
    expect(now.answer.headline).toContain('Monday 2 March 2026');
  });

  it('the old and the new fact are both stored: the brain does not supersede', async () => {
    const r = await run();
    const now = r.answers.find((a) => a.question === 'q-now');
    expect(now.diagnostic.inBrain).toEqual([true]);
    expect(now.diagnostic.inContext).toEqual([true]);
    const text = [now.answer.headline, ...now.answer.points].join(' ');
    expect(text).toContain('2 x Tablet A');
    expect(text).toContain('1 x Tablet B');
  });

  it('scores the answers and records tokens, attempts and the model', async () => {
    const r = await run();
    const early = r.answers.find((a) => a.question === 'q-early');
    expect(early).toMatchObject({ arm: 'brain', scenario: 'meds', kind: 'recall', model: 'fast', run: 1, attempts: 1, error: null, pass: true });
    expect(early.tokens.inputTokens).toBeGreaterThan(0);
    expect(early.diagnostic).toMatchObject({ inBrain: [true], inContext: [true], inAnswer: [true], lostAt: null });
    expect(r.answers.find((a) => a.question === 'q-now').pass).toBe(false); // the demo model quotes the old dose as current
    expect(r.filing[0].tokens.inputTokens).toBeGreaterThan(0);
  });

  it('a distractor has no diagnostic and the demo model answers it with a note, so it fails', async () => {
    const r = await run();
    const none = r.answers.find((a) => a.question === 'q-none');
    expect(none.diagnostic).toBeNull();
    expect(none.pass).toBe(false);
  });

  it('asks every answering model, every repeat, in order', async () => {
    const r = await run({ answerWith: [FAST, DEEP], repeat: 2 });
    expect(r.answers.filter((a) => a.question === 'q-early').map((a) => [a.model, a.run])).toEqual([['fast', 1], ['fast', 2], ['deep', 1], ['deep', 2]]);
  });

  it('uses the chosen models for the right job, and the filing model never answers', async () => {
    const seen = [];
    await run({ fileWith: DEEP, answerWith: [FAST], makeClient: (who) => ({ complete: (req) => (seen.push([who.role, req.meta?.capability, req.model]), demoClient().complete(req)) }) });
    const byRole = (role) => new Set(seen.filter((s) => s[0] === role).map((s) => `${s[1]}:${s[2]}`));
    expect(byRole('file')).toEqual(new Set(['categorise:claude-opus-5-5']));
    expect(byRole('answer')).toEqual(new Set(['status:claude-haiku-4-5-20251001']));
  });

  it('nothing is carried between runs', async () => {
    const a = await run();
    const b = await run();
    expect(b.answers.map((x) => x.entriesUsed)).toEqual(a.answers.map((x) => x.entriesUsed));
  });
});

describe('failures and stopping', () => {
  it('a refused filing is recorded and the run goes on', async () => {
    const bad = { complete: async () => ({ ok: false, error: { code: 'REFUSED', message: 'no', retryable: false } }) };
    const r = await run({ makeClient: (who) => (who.role === 'file' ? bad : demoClient()) });
    expect(r.filing.every((f) => !f.ok && f.error.stage === 'propose')).toBe(true);
    expect(r.filing[0].error).toMatchObject({ source: 'llm', code: 'REFUSED' });
    const now = r.answers.find((a) => a.question === 'q-now');
    expect(now.entriesUsed).toBe(0);
    expect(now.diagnostic.lostAt).toBe('filing');
    expect(now.pass).toBe(false);
  });

  it('a failing answering model is an error on the record, not a crash', async () => {
    const bad = { complete: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } }) };
    const r = await run({ makeClient: (who) => (who.role === 'answer' ? bad : demoClient()) });
    const a = r.answers[0];
    expect(a.error).toMatchObject({ source: 'llm' });
    expect(a.pass).toBe(false);
    expect(a.answer).toBeNull();
  });

  it('stops between calls when told to, and says so', async () => {
    const controller = new AbortController();
    const r = await run({ signal: controller.signal, onResult: () => controller.abort() });
    expect(r.aborted).toBe(true);
    expect(r.answers).toHaveLength(1);
    const before = new AbortController();
    before.abort();
    expect((await run({ signal: before.signal })).filing).toHaveLength(0);
  });

  it('a question with its own time is asked at that time', async () => {
    const sc = scenario();
    sc.questions[0].at = '2026-02-01T08:00Z';
    const r = await run({ scenario: sc });
    expect(r.answers.find((a) => a.question === 'q-early').answer.headline).toContain('Sunday 1 February 2026');
  });

  it('stops between models too', async () => {
    const controller = new AbortController();
    const r = await run({ answerWith: [FAST, DEEP], signal: controller.signal, onResult: () => controller.abort() });
    expect(r.answers).toHaveLength(1);
  });

  it('a normal run has no errors, however many repeats (nothing is throttled)', async () => {
    const r = await run({ repeat: 3 });
    expect(r.answers).toHaveLength(9);
    expect(r.answers.every((a) => a.error === null)).toBe(true);
  });

  it('each entry carries the day of its note, from the injected clock', async () => {
    const seen = [];
    await run({ makeClient: (who) => ({ complete: (req) => (who.role === 'answer' && seen.push(req.messages.map((m) => m.content).join('\n')), demoClient().complete(req)) }) });
    expect(seen[0]).toContain('2026-01-05');
    expect(seen[0]).toContain('2026-01-12');
  });

  it('counts a repair as a second attempt and adds up its tokens', async () => {
    let calls = 0;
    const flaky = { complete: async (req) => {
      if (++calls === 1) return { ok: true, value: { output: { kind: 'text', text: 'not json' }, usage: { inputTokens: 10, outputTokens: 1 }, model: req.model } };
      return demoClient().complete(req);
    } };
    const r = await run({ makeClient: (who) => (who.role === 'answer' ? flaky : demoClient()) });
    const first = r.answers[0];
    expect(first.attempts).toBe(2);
    expect(first.tokens.inputTokens).toBeGreaterThan(10);
    expect(first.error).toBeNull();
  });

  it('reports each result as it happens', async () => {
    const seen = [];
    const r = await run({ onResult: (x) => seen.push(x.question) });
    expect(seen).toEqual(r.answers.map((a) => a.question));
  });

  it('never creates a client itself: only what makeClient gives is used', async () => {
    const roles = [];
    await run({ makeClient: (who) => (roles.push(who.role), demoClient()) });
    expect(roles).toEqual(['file', 'answer']);
  });
});

describe('helpers', () => {
  it('entriesOf returns the entries block as the model saw it, unescaped', () => {
    expect(entriesOf('x <entries>\n[1] (personal) a &lt;b&gt; &amp;amp; c\n</entries> y')).toBe('[1] (personal) a <b> &amp; c');
    expect(entriesOf('no block')).toBe('');
  });
  it('lostAt names the first stage that lost a fact', () => {
    expect(lostAt([true], [true], [true])).toBeNull();
    expect(lostAt([false], [true], [true])).toBe('filing');
    expect(lostAt([true], [false], [false])).toBe('context');
    expect(lostAt([true, true], [true, true], [true, false])).toBe('answer');
  });
  it('recordingClient keeps the request and the tokens of each call', async () => {
    const { client, log } = recordingClient({ complete: async () => ({ ok: true, value: { usage: { inputTokens: 3, outputTokens: 4 } } }) });
    await client.complete({ model: 'm', meta: { capability: 'status' }, messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] });
    expect(log).toEqual([{ capability: 'status', model: 'm', content: 'a\nb', usage: { inputTokens: 3, outputTokens: 4 } }]);
    const failing = recordingClient({ complete: async () => ({ ok: false, error: {} }) });
    await failing.client.complete({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    expect(failing.log[0]).toMatchObject({ capability: null, usage: null });
  });
});
