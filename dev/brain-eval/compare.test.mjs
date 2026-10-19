import { describe, expect, it } from 'vitest';
import { compareRuns, scenarioDifferences } from './compare.mjs';

const stale = (...s) => s.map((status) => ({ phrase: 'p', status }));
const rec = (arm, model, question, pass, extra = {}) => ({
  arm, model, scenario: 's', question, kind: 'override', run: 1, pass, score: { pass, groups: [], stale: stale(pass ? 'absent' : 'surfaced'), nothing: false, reasons: [] },
  error: null, answer: { headline: pass ? 'good answer' : 'bad answer', points: ['p'], nothing: false }, ...extra,
});
const SCEN = [{ id: 's', hash: 'h1', notes: 5, questions: [{ id: 'q1', kind: 'override' }, { id: 'q2', kind: 'recall' }] }];
const run = (results, extra = {}) => ({ kind: 'brain-eval', startedAt: '2026-10-14T10:00:00.000Z', mode: 'real', controls: null, repeat: 1, arms: ['brain'], pads: [0], seed: 1, fileWith: 'fast', answerWith: ['fast'], aborted: false, scenarios: SCEN, results, ...extra });
const A = run([rec('brain', 'fast', 'q1', false), rec('brain', 'fast', 'q2', true)]);
const B = run([rec('brain', 'fast', 'q1', true), rec('brain', 'fast', 'q2', true)], { startedAt: '2026-10-15T10:00:00.000Z', controls: 'candidate' });
const text = (a, b, o) => {
  const r = compareRuns(a, b, o);
  if (!r.ok) throw new Error(r.message);
  return r.text;
};

describe('an improvement', () => {
  const t = text(A, B);
  it('names both runs', () => {
    expect(t).toContain('first : 2026-10-14T10:00:00.000Z · real · controls the shipped controls/ folder');
    expect(t).toContain('second: 2026-10-15T10:00:00.000Z · real · controls candidate');
    expect(t).toContain('arms brain · filed with fast · answered by fast · repeats 1 · filler 0 (seed 1)');
  });
  it('shows the change in pass rate and stale rate', () => {
    expect(t).toMatch(/brain\s+fast\s+50% → 100%\s+\+50 pp\s+50% → 0%\s+-50 pp/);
  });
  it('lists the question that went from failing to passing with both answers', () => {
    expect(t).toContain('Questions that went from failing to passing (1)');
    expect(t).toContain('brain fast · s/q1: 0/1 → 1/1');
    expect(t).toContain('first:  ["bad answer","p"]');
    expect(t).toContain('second: ["good answer","p"]');
    expect(t).toContain('Questions that went from passing to failing (0)\n  none');
    expect(t).toContain('1 question changed their pass rate in all (1 crossed');
  });
});

describe('a regression', () => {
  it('lists the question that went from passing to failing', () => {
    const t = text(B, A);
    expect(t).toContain('Questions that went from passing to failing (1)');
    expect(t).toMatch(/50% → 100%|100% → 50%/);
    expect(t).toMatch(/brain\s+fast\s+100% → 50%\s+-50 pp\s+0% → 50%\s+\+50 pp/);
    expect(t).toContain('Questions that went from failing to passing (0)');
  });
});

describe('no change', () => {
  it('says so and lists nothing', () => {
    const t = text(A, A);
    expect(t).toMatch(/\+0 pp|0 pp/);
    expect(t).toContain('0 questions changed their pass rate in all (0 crossed');
    expect(t).toContain('went from passing to failing (0)');
    expect(t).toContain('went from failing to passing (0)');
  });
});

describe('repeats', () => {
  const many = (passes) => run(passes.map((p, i) => rec('brain', 'fast', 'q1', p, { run: i + 1 })), { repeat: passes.length });
  it('a question flips when its pass rate crosses a half', () => {
    expect(text(many([true, true, false]), many([false, false, true]))).toContain('passing to failing (1)');
    expect(text(many([true, true, false]), many([true, false, false]))).toContain('passing to failing (1)');
    expect(text(many([true, true, false]), many([true, false, true]))).toContain('passing to failing (0)');
    expect(text(many([true, false]), many([true, false]))).toContain('passing to failing (0)');
    expect(text(many([true, false]), many([false, false]))).toContain('passing to failing (1)');
  });
  it('a change that does not cross is counted but not listed', () => {
    const t = text(many([true, true, true]), many([true, true, false]));
    expect(t).toContain('1 question changed their pass rate in all (0 crossed');
    expect(t).toContain('passing to failing (0)');
    expect(t).toMatch(/100% → 67%\s+-33 pp/);
  });
  it('shows the failing answer when there is one', () => {
    const t = text(many([true, true, true]), many([false, false, true]));
    expect(t).toContain('s/q1: 3/3 → 1/3');
    expect(t).toContain('second: ["bad answer","p"]');
    expect(t).toContain('first:  ["good answer","p"]');
    // a side whose first answer passed but that has a failing one shows the failing one
    const u = text(many([true, true, false]), many([true, false, false]));
    expect(u).toContain('s/q1: 2/3 → 1/3');
    expect(u).toContain('first:  ["bad answer","p"]');
    expect(u).toContain('second: ["bad answer","p"]');
  });
});

describe('different scenarios', () => {
  const other = (change) => run(A.results, { scenarios: change(JSON.parse(JSON.stringify(SCEN))) });
  it('are refused, naming the difference', () => {
    const r = compareRuns(A, other((s) => { s[0].hash = 'h2'; return s; }));
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('did not use the same scenarios and questions');
    expect(r.message).toContain('the notes or questions of s were edited between the runs');
    expect(r.message).toContain('Use --force');
  });
  it('a different question list, an extra scenario and a missing scenario are each named', () => {
    expect(scenarioDifferences(A, other((s) => { s[0].questions.pop(); return s; }))).toEqual(['the questions of s differ']);
    expect(scenarioDifferences(A, other((s) => { s[0].questions[1].kind = 'multi'; return s; }))).toEqual(['the questions of s differ']);
    expect(scenarioDifferences(A, other((s) => [...s, { id: 'extra', hash: 'x', notes: 1, questions: [] }]))).toEqual(['scenario extra is only in the second run']);
    expect(scenarioDifferences(A, other(() => []))).toEqual(['scenario s is only in the first run']);
    expect(scenarioDifferences(A, A)).toEqual([]);
  });
  it('--force compares what they share and says the runs differ', () => {
    const t = text(A, other((s) => { s[0].hash = 'h2'; return s; }), { force: true });
    expect(t).toContain('WARNING (--force): the runs differ');
    expect(t).toContain('the notes or questions of s were edited between the runs');
    expect(t).toContain('50% → 50%');
  });
});

describe('a run missing an arm or a model', () => {
  it('says which side has it', () => {
    const a = run([rec('brain', 'fast', 'q1', true), rec('replay', 'fast', 'q1', true)]);
    const b = run([rec('brain', 'fast', 'q1', true), rec('brain', 'deep', 'q1', true)]);
    const t = text(a, b);
    expect(t).toMatch(/replay\s+fast\s+only in the first run/);
    expect(t).toMatch(/brain\s+deep\s+only in the second run/);
    expect(t).toMatch(/brain\s+fast\s+100% → 100%/);
  });
});

describe('filler sizes', () => {
  it('are kept apart and shown when there is more than one', () => {
    const at = (pad, rows) => rows.map((r) => ({ ...r, pad }));
    const a = run([...at(0, [rec('brain', 'fast', 'q1', true)]), ...at(100, [rec('brain', 'fast', 'q1', true)])], { pads: [0, 100] });
    const b = run([...at(0, [rec('brain', 'fast', 'q1', true)]), ...at(100, [rec('brain', 'fast', 'q1', false)])], { pads: [0, 100] });
    const t = text(a, b);
    expect(t).toMatch(/filler\s+arm\s+model/);
    expect(t).toMatch(/0\s+brain\s+fast\s+100% → 100%/);
    expect(t).toMatch(/100\s+brain\s+fast\s+100% → 0%/);
    expect(t).toContain('filler 100 · brain fast · s/q1: 1/1 → 0/1');
    expect(t).toContain('filler 0, 100 (seed 1)');
  });
  it('sizes are ordered by number, not as text', () => {
    const at = (pad, rows) => rows.map((r) => ({ ...r, pad }));
    const mk = () => run([...at(100, [rec('brain', 'fast', 'q1', true)]), ...at(20, [rec('brain', 'fast', 'q1', true)])], { pads: [20, 100] });
    const t = text(mk(), mk());
    expect(t.search(/20\s+brain\s+fast/)).toBeLessThan(t.search(/100\s+brain\s+fast/));
  });
  it('a single size shows no filler column', () => {
    expect(text(A, B)).not.toMatch(/filler\s+arm/);
  });
});

describe('answers that are not answers', () => {
  it('an error, an over-window question and a missing answer are described', () => {
    const bad = (extra) => run([rec('brain', 'fast', 'q1', false, extra)]);
    const good = run([rec('brain', 'fast', 'q1', true)]);
    expect(text(good, bad({ error: { code: 'RATE_LIMITED' }, answer: null }))).toContain('second: error RATE_LIMITED');
    expect(text(good, bad({ error: { source: 'llm' }, answer: null }))).toContain('second: error llm');
    expect(text(good, bad({ overWindow: true, answer: null }))).toContain('second: not sent: over the window');
    expect(text(good, bad({ answer: null }))).toContain('second: no answer');
  });
  it('a long answer is cut', () => {
    const long = run([rec('brain', 'fast', 'q1', false, { answer: { headline: 'x'.repeat(500), points: [], nothing: false } })]);
    const line = text(run([rec('brain', 'fast', 'q1', true)]), long).split('\n').find((l) => l.startsWith('      second:'));
    expect(line.length).toBeLessThan(270);
  });
});

describe('files that are not results', () => {
  it.each([[null], [{}], [{ kind: 'eval', results: [] }], [{ kind: 'brain-eval' }], ['text']])('%j is refused for either side', (bad) => {
    expect(compareRuns(bad, A)).toEqual({ ok: false, message: 'the first file is not a saved brain-eval result' });
    expect(compareRuns(A, bad)).toEqual({ ok: false, message: 'the second file is not a saved brain-eval result' });
  });
  it('a run missing optional header fields still compares', () => {
    const bare = { kind: 'brain-eval', results: A.results, scenarios: SCEN };
    expect(text(bare, bare)).toContain('unknown time');
  });
  it('a stopped run is marked', () => {
    expect(text(A, run(A.results, { aborted: true }))).toContain('STOPPED EARLY');
  });
});

describe('comparing what replacing did', () => {
  const filed = (replaced, tidied = 0) => ({ ok: true, replaced: Array.from({ length: replaced }, (_, i) => ({ id: `n${i}`, title: 't', summary: '' })), tidied });
  const lostRec = (q) => rec('brain', 'fast', q, false, { diagnostic: { lostAt: 'replace' } });
  const without = run([rec('brain', 'fast', 'q1', true), rec('brain', 'fast', 'q2', true)], { replace: false, filing: [filed(0), filed(0)] });
  const withIt = run([rec('brain', 'fast', 'q1', true), lostRec('q2')], { filing: [filed(1, 1), filed(0)] });
  it('shows replacements, tidied categories and answers lost to a deletion for each run, and whether replacing was off', () => {
    const t = text(without, withIt);
    expect(t).toContain('Replacing');
    expect(t).toContain('first:  0 notes replaced 0 older notes, 0 empty categories left to tidy, 0 failed answers lost a fact to a deletion (replacing was off)');
    expect(t).toContain('second: 1 notes replaced 1 older notes, 1 empty categories left to tidy, 1 failed answers lost a fact to a deletion');
    expect(t).not.toContain('second: 1 notes replaced 1 older notes, 1 empty categories left to tidy, 1 failed answers lost a fact to a deletion (replacing was off)');
  });
  it('says "not recorded" for a run from before replacing, and shows nothing when neither recorded it', () => {
    const old = run([rec('brain', 'fast', 'q1', true), rec('brain', 'fast', 'q2', true)]);
    expect(text(old, withIt)).toContain('first:  not recorded');
    expect(text(old, old)).not.toContain('Replacing');
  });
});
