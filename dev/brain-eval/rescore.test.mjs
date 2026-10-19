import { describe, expect, it } from 'vitest';
import { hashOf } from './cli.mjs';
import { rescoreRun } from './rescore.mjs';
import { RULES_VERSION } from './score.mjs';

const scenario = {
  id: 's', title: 't', description: 'd',
  notes: [{ id: 'n1', at: '2026-01-01', text: 'Appointment on 10 March.' }, { id: 'n2', at: '2026-01-02', text: 'Appointment moved to 12 March.' }],
  questions: [
    { id: 'q1', kind: 'override', after: 'n2', ask: 'When?', must: [['12 March']], stale: ['10 March'] },
    { id: 'q2', kind: 'distractor', after: 'n2', ask: 'Piano?', expectNothing: true },
  ],
};
const describe1 = (s) => ({ id: s.id, hash: hashOf(s), notes: s.notes.length, questions: s.questions.map((q) => ({ id: q.id, kind: q.kind })) });
const score = (pass) => ({ pass, groups: [], stale: [], nothing: false, reasons: [] });
const rec = (question, kind, pass, answer, extra = {}) => ({ arm: 'brain', scenario: 's', question, kind, model: 'fast', run: 1, pass, score: score(pass), error: null, answer, tokens: { inputTokens: 1, outputTokens: 1 }, ...extra });
const saved = (results, extra = {}) => ({ kind: 'brain-eval', mode: 'real', repeat: 1, scenarios: [describe1(scenario)], results, ...extra });
const explained = { headline: 'It is 12 March, moved from the original 10 March.', points: [], nothing: false };
const notFound = { headline: "I can't find anything about piano.", points: ['The dentist is on 24 March.'], nothing: false };

describe('rescoreRun', () => {
  it('changes verdicts that the new rules change, and only those', () => {
    const r = rescoreRun(saved([rec('q1', 'override', false, explained), rec('q2', 'distractor', false, notFound), rec('q1', 'override', true, { headline: '12 March', points: [], nothing: false })]), [scenario], describe1);
    expect(r.ok).toBe(true);
    expect(r.value.results.map((x) => x.pass)).toEqual([true, true, true]);
    expect(r.value.rescored).toMatchObject({ rulesVersion: RULES_VERSION, previousRulesVersion: 1, changedVerdicts: 2, skippedQuestions: 0, forced: false });
    expect(r.value.rulesVersion).toBe(RULES_VERSION);
  });
  it('a genuinely stale answer still fails and stays failed', () => {
    const r = rescoreRun(saved([rec('q1', 'override', false, { headline: 'The appointment is on 10 March.', points: [], nothing: false })]), [scenario], describe1);
    expect(r.value.results[0].pass).toBe(false);
    expect(r.value.rescored.changedVerdicts).toBe(0);
  });
  it('rebuilds the summary and the diagnostic, keeping what filing and context found', () => {
    const diag = { inBrain: [true], inContext: [true], inAnswer: [false], lostAt: 'answer' };
    const r = rescoreRun(saved([rec('q1', 'override', false, explained, { diagnostic: diag })]), [scenario], describe1);
    expect(r.value.results[0].diagnostic).toEqual({ inBrain: [true], inContext: [true], inAnswer: [true], lostAt: null });
    expect(r.value.summary.cells['brain|fast'].passRate).toBe(1);
    const lost = rescoreRun(saved([rec('q1', 'override', false, explained, { diagnostic: { inBrain: [false], inContext: [false], inAnswer: [false], lostAt: 'filing' } })]), [scenario], describe1);
    expect(lost.value.results[0].diagnostic.lostAt).toBe('filing');
  });
  it('records without an answer or a diagnostic stay failed and untouched', () => {
    const r = rescoreRun(saved([rec('q1', 'override', false, null, { error: { code: 'X' } }), rec('q2', 'distractor', false, null, { diagnostic: null, overWindow: true })]), [scenario], describe1);
    expect(r.value.results.map((x) => x.pass)).toEqual([false, false]);
    expect(r.value.results[0].error).toEqual({ code: 'X' });
    expect(r.value.results[1].diagnostic).toBeNull();
  });
  it('does not change the saved object it was given', () => {
    const s = saved([rec('q1', 'override', false, explained)]);
    const copy = JSON.stringify(s);
    rescoreRun(s, [scenario], describe1);
    expect(JSON.stringify(s)).toBe(copy);
  });
  it('a second re-score remembers the rules it replaced', () => {
    const once = rescoreRun(saved([rec('q1', 'override', false, explained)]), [scenario], describe1).value;
    expect(rescoreRun(once, [scenario], describe1).value.rescored.previousRulesVersion).toBe(RULES_VERSION);
  });
  describe('when the scenarios have changed', () => {
    const edited = { ...scenario, notes: [scenario.notes[0], { ...scenario.notes[1], text: 'Appointment moved to 13 March.' }] };
    it('refuses, naming the difference', () => {
      const r = rescoreRun(saved([rec('q1', 'override', false, explained)]), [edited], describe1);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('cannot be re-scored fairly');
      expect(r.message).toContain('the notes or questions of s were edited between the runs');
    });
    it('--force re-scores what still exists, says so, and skips questions that are gone', () => {
      const fewer = { ...edited, questions: [edited.questions[0]] };
      const r = rescoreRun(saved([rec('q1', 'override', false, explained), rec('q2', 'distractor', false, notFound)]), [fewer], describe1, { force: true });
      expect(r.ok).toBe(true);
      expect(r.value.results).toHaveLength(1);
      expect(r.value.rescored).toMatchObject({ forced: true, skippedQuestions: 1 });
    });
  });
  it.each([[null], [{}], [{ kind: 'eval', results: [] }], [{ kind: 'brain-eval' }]])('refuses %j', (bad) => {
    expect(rescoreRun(bad, [scenario], describe1)).toEqual({ ok: false, message: 'that file is not a saved brain-eval result' });
  });
});
