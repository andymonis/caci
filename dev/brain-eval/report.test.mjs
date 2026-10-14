import { describe, expect, it } from 'vitest';
import { formatReport, summarise } from './report.mjs';

const score = (pass, stale = []) => ({ pass, groups: [], stale: stale.map((status) => ({ phrase: 'p', status })), nothing: false, reasons: pass ? [] : ['a required fact is missing'] });
const rec = (arm, model, question, kind, pass, extra = {}) => ({
  arm, scenario: 's', question, kind, model, run: 1, pass, score: score(pass, extra.stale), error: null, answer: { headline: 'H', points: ['p1'], nothing: false },
  tokens: { inputTokens: 100, outputTokens: 10 }, attempts: 1, entriesUsed: 3, entriesLeftOut: 0, diagnostic: null, ...extra,
});
const RESULTS = [
  rec('brain', 'fast', 'q1', 'recall', true),
  rec('brain', 'fast', 'q2', 'override', false, { stale: ['surfaced'], diagnostic: { lostAt: null } }),
  rec('replay', 'fast', 'q1', 'recall', true),
  rec('replay', 'fast', 'q2', 'override', true, { stale: ['superseded'] }),
  rec('brain', 'deep', 'q1', 'recall', false, { diagnostic: { inBrain: [false], inContext: [false], inAnswer: [false], lostAt: 'filing' } }),
  rec('replay', 'deep', 'q1', 'recall', false, { overWindow: true, answer: null, diagnostic: { lostAt: 'context' } }),
];
const META = { mode: 'real', repeat: 1, aborted: false, controls: 'the shipped controls/ folder', fileWith: 'fast' };

describe('summarise', () => {
  const s = summarise(RESULTS);
  it('counts by arm and model and by kind', () => {
    expect(s.arms).toEqual(['brain', 'replay']);
    expect(s.models).toEqual(['fast', 'deep']);
    expect(s.kinds).toEqual(['recall', 'override']);
    expect(s.cells['brain|fast']).toMatchObject({ n: 2, passes: 1, passRate: 0.5, surfaced: 1, staleSurfacedRate: 0.5, tokens: { inputTokens: 200, outputTokens: 20 }, errors: 0, overWindow: 0 });
    expect(s.cells['replay|fast']).toMatchObject({ n: 2, passRate: 1, superseded: 1, supersededRate: 0.5 });
    expect(s.cells['replay|deep'].overWindow).toBe(1);
    expect(s.cells['brain|fast'].byKind.override).toMatchObject({ n: 1, passRate: 0 });
    expect(s.cells['brain|deep'].byKind.override).toBeUndefined();
  });
  it('counts errors', () => {
    const e = summarise([rec('brain', 'fast', 'q', 'recall', false, { error: { code: 'X' } })]);
    expect(e.cells['brain|fast'].errors).toBe(1);
  });
});

describe('the report', () => {
  const text = formatReport({ results: RESULTS, filing: [{ ok: true }, { ok: false, error: { code: 'REFUSED' } }], meta: META });
  it('names the run', () => {
    expect(text).toContain('mode real · arms brain, replay · filed with fast · repeats 1 · controls the shipped controls/ folder');
    expect(text).toContain('6 answers over 1 scenarios');
    expect(text).not.toContain('STOPPED EARLY');
    expect(formatReport({ results: RESULTS, meta: { ...META, aborted: true } })).toContain('STOPPED EARLY');
  });
  it('shows pass and stale rates per arm and model', () => {
    expect(text).toMatch(/brain\s+fast\s+2\s+50%\s+50%\s+0%/);
    expect(text).toMatch(/replay\s+fast\s+2\s+100%\s+0%\s+50%/);
    expect(text).toContain('0 (1 over window)');
  });
  it('shows the pass rate by kind with the number of answers', () => {
    expect(text).toMatch(/brain\s+fast\s+100% \(1\)\s+0% \(1\)/);
    expect(text).toMatch(/brain\s+deep\s+0% \(1\)\s+-/);
  });
  it('shows brain minus replay for models that have both arms', () => {
    expect(text).toContain('Brain minus replay');
    expect(text).toMatch(/fast\s+-50 pp\s+\+50 pp\s+0 pp\s+-100 pp/);
    expect(text).toMatch(/deep\s+0 pp\s+0 pp\s+0 pp\s+-/);
    expect(formatReport({ results: RESULTS.filter((r) => r.arm === 'brain'), meta: META })).not.toContain('Brain minus replay');
  });
  it('says where failed answers lost the fact', () => {
    expect(text).toMatch(/brain\s+fast\s+0\s+0\s+0\s+1\s+0/); // stale
    expect(text).toMatch(/brain\s+deep\s+1\s+0\s+0\s+0\s+0/); // lost at filing
    expect(text).toMatch(/replay\s+deep\s+0\s+1\s+0\s+0\s+0/); // lost at context
    const other = formatReport({ results: [rec('brain', 'fast', 'q', 'recall', false)], meta: META });
    expect(other).toMatch(/brain\s+fast\s+0\s+0\s+0\s+0\s+1/);
  });
  it('lists filing results and notes left out of the context', () => {
    expect(text).toContain('Filing: 1 of 2 notes filed; 1 not (REFUSED).');
    expect(formatReport({ results: [rec('brain', 'fast', 'q', 'recall', true, { entriesLeftOut: 7 })], filing: [{ ok: true }], meta: META })).toContain('left notes out of the context in 1 of 1 answers (most in one: 7)');
    expect(text).not.toContain('left notes out');
  });
  it('has a per-question table with passes of answers', () => {
    expect(text).toMatch(/s\/q2\s+override\s+0\/1\s+-\s+1\/1\s+-/);
  });
  it('lists failures with the reasons and what the model said', () => {
    expect(text).toContain('Failures (3)');
    expect(text).toContain('brain fast s/q2: a required fact is missing');
    expect(text).toContain('["H","p1"]');
    expect(text).toContain('not sent: over the window');
    const many = formatReport({ results: Array.from({ length: 25 }, (_, i) => rec('brain', 'fast', `q${i}`, 'recall', false)), meta: META });
    expect(many).toContain('Failures (25, first 20)');
    expect(many.match(/brain fast s\/q\d+/g)).toHaveLength(20);
    expect(formatReport({ results: [rec('brain', 'fast', 'q', 'recall', false, { error: { source: 'llm', code: 'RATE_LIMITED' }, answer: null })], meta: META })).toContain('error RATE_LIMITED');
    expect(formatReport({ results: [rec('brain', 'fast', 'q', 'recall', false, { answer: null })], meta: META })).toContain('no answer');
    expect(formatReport({ results: [rec('brain', 'fast', 'q', 'recall', true), rec('brain', 'fast', 'q2', 'recall', true, { run: 2 })], meta: META })).not.toContain('Failures');
  });
  it('a run that produced nothing still reports', () => {
    const empty = formatReport({ results: [], meta: META });
    expect(empty).toContain('0 answers');
    expect(empty).not.toContain('Pass rate');
  });
  it('mentions padding when there is some', () => {
    expect(formatReport({ results: RESULTS, meta: { ...META, pad: 50, seed: 7 } })).toContain('padded with 50 filler notes (seed 7)');
    expect(text).not.toContain('padded');
  });
});
