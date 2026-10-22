import { describe, expect, it } from 'vitest';
import * as testing from '../../src/llm/testing/index.ts';
import { main } from './cli.mjs';
import { lib } from './helpers.test-util.mjs';
import { evaluateStatusCase, validateStatusGolden } from './status-evaluate.mjs';
import { STATUS_FOCUS_GOLDEN } from './status-focus-golden.mjs';
import { runStatusEval } from './status-runner.mjs';
import { idealStatusReply, idealStatusScript } from './status-scripted.mjs';

// The focus set (R-018 D14): invented lookalikes of the owner's real cases, judged by rules.
const byId = (id) => STATUS_FOCUS_GOLDEN.find((c) => c.id === id);
const ok = (a) => ({ ok: true, answer: { headline: 'H', points: [], nothing: true, ...a } });
const failedNames = (v) => v.checks.filter((c) => !c.pass).map((c) => c.name);
const MODELS = [{ label: 'm', choice: { tier: 'fast' } }];
const runWith = (makeClient, cases = STATUS_FOCUS_GOLDEN) => runStatusEval({ lib, cases, models: MODELS, makeClient, now: (() => { let t = 0; return () => (t += 5); })() });
const reply = (r) => () => testing.createScriptedModelClient(() => ({ reply: JSON.stringify(r), usage: { inputTokens: 10, outputTokens: 5 } }));

describe('the focus golden set', () => {
  it('is sound, and holds the cases the owner described', () => {
    expect(validateStatusGolden(STATUS_FOCUS_GOLDEN)).toEqual([]);
    expect(STATUS_FOCUS_GOLDEN.map((c) => c.id)).toEqual(['rent-week', 'rent-month', 'rent-year', 'dentist-beside-rent', 'overdue-is-shown', 'france-week', 'france-month', 'france-year', 'nothing-at-all', 'too-many-this-week', 'hidden-instruction-week']);
    expect(Object.isFrozen(STATUS_FOCUS_GOLDEN)).toBe(true);
    for (const c of STATUS_FOCUS_GOLDEN) expect(c).toMatchObject({ now: '2026-10-22T09:00:00Z', timeZone: 'Europe/London', horizon: expect.stringMatching(/^(week|month|year)$/) });
  });

  it('the rent cases are the real case: two payments paid, the next on 1 Feb, the week and the month silent', () => {
    for (const id of ['rent-week', 'rent-month']) expect(byId(id).expect.silent).toBe(true);
    const year = byId('rent-year');
    expect(year.expect.mustNotMention).toEqual(expect.arrayContaining(['908.58', '4,732']));
    expect(year.expect.mustInclude).toEqual(['4,050|1 Feb', '3,823|1 May']);
    expect(year.entries.map((e) => e.text).join(' ')).toContain('The first two rent payments have been paid');
    expect(byId('france-week').expect.silent && byId('france-month').expect.silent && byId('france-year').expect.cite[0] === 1).toBe(true);
  });

  it('invents nobody real: no real names, addresses or contact details', () => {
    const text = JSON.stringify(STATUS_FOCUS_GOLDEN);
    expect(text).not.toMatch(/studentroost|@|https?:|\+44|07\d{9}/i);
  });
});

describe('the rules that judge a focused answer', () => {
  const c = (expect, extra = {}) => ({ id: 'x', request: 'r', entries: [{ where: 'w', text: 'Dentist 09:15 on 23 October. Numbers: 1 2 4 050 49 50 51 31' }], expect, ...extra });

  it('silent: one line, nothing true and no points, and the opposite when silence is wrong', () => {
    expect(evaluateStatusCase(c({ silent: true }), ok({})).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c({ silent: true }), ok({ nothing: false, points: [{ text: 'x', refs: [1] }] })))).toEqual(['is silent: one line, no points']);
    expect(failedNames(evaluateStatusCase(c({ silent: true }), ok({ nothing: true, points: [{ text: 'x', refs: [1] }] })))).toEqual(['is silent: one line, no points']);
    expect(failedNames(evaluateStatusCase(c({ silent: true }), ok({ nothing: false, points: [] })))).toEqual(['is silent: one line, no points']);
    expect(evaluateStatusCase(c({ silent: false }), ok({ nothing: false, points: [{ text: 'x', refs: [1] }] })).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c({ silent: false }), ok({})))).toEqual(['is not silent']);
  });

  it('mustInclude takes a phrase or alternatives, without regard to case, in the headline or a point', () => {
    const e = (a) => evaluateStatusCase(c({ mustInclude: ['dentist', '4,050|1 Feb'] }), ok(a));
    expect(e({ headline: 'The DENTIST', nothing: false, points: [{ text: 'Rent due 1 FEB', refs: [1] }] }).pass).toBe(true);
    expect(e({ headline: 'The dentist', nothing: false, points: [{ text: '£4,050 is due', refs: [1] }] }).pass).toBe(true);
    expect(failedNames(e({ headline: 'The dentist', nothing: false, points: [{ text: 'Rent', refs: [1] }] }))).toEqual(['says 4,050|1 Feb']);
    expect(failedNames(e({ headline: 'x', nothing: false, points: [] }))).toEqual(['says dentist', 'says 4,050|1 Feb']);
  });

  it('mustNotMention fails when any alternative is there, in the headline or a point, in any case', () => {
    const e = (a) => evaluateStatusCase(c({ mustNotMention: ['1 Feb', 'rent|lease'] }), ok(a));
    expect(e({}).pass).toBe(true);
    expect(failedNames(e({ headline: 'Due 1 FEB' }))).toEqual(['does not mention 1 Feb']);
    expect(failedNames(e({ nothing: false, points: [{ text: 'The Lease', refs: [1] }] }))).toEqual(['does not mention rent|lease']);
  });

  it('length: each point and the whole answer have their own limit, counted as characters', () => {
    const long = 'x'.repeat(50);
    const e = (expectation, a) => evaluateStatusCase(c(expectation), ok(a));
    expect(e({ maxPointChars: 50 }, { nothing: false, points: [{ text: long, refs: [1] }] }).pass).toBe(true);
    expect(failedNames(e({ maxPointChars: 49 }, { nothing: false, points: [{ text: long, refs: [1] }] }))).toEqual(['each point at most 49 characters']);
    expect(e({ maxPointChars: 2 }, { nothing: false, points: [{ text: '😀😀', refs: [1] }] }).pass).toBe(true);
    expect(e({ maxTotalChars: 52 }, { headline: 'H', nothing: false, points: [{ text: long, refs: [1] }] }).pass).toBe(true);
    expect(failedNames(e({ maxTotalChars: 51 }, { headline: 'H', nothing: false, points: [{ text: long, refs: [1] }] }))).toEqual(['the whole answer at most 51 characters']);
  });

  it('today\'s date and the window are known numbers, but others are still invented', () => {
    const now = { now: '2026-10-22T09:00:00Z' };
    const w = { window: { fromDay: '2026-10-22', toDay: '2026-10-28' } };
    const say = (headline) => evaluateStatusCase(c({}, now), ok({ headline }), w);
    expect(say('Thursday 22 October 2026, 28 October, 09:00').pass).toBe(true);
    expect(failedNames(say('On the 29th'))).toEqual(['invents no numbers']);
    expect(failedNames(evaluateStatusCase(c({}, now), ok({ headline: '28 October' })))).toEqual(['invents no numbers']);
    expect(evaluateStatusCase(c({}, now), ok({ headline: '22 October' })).pass).toBe(true);
    const later = { window: { fromDay: '2026-10-25', toDay: '2026-11-03' } };
    expect(evaluateStatusCase(c({}, now), ok({ headline: '25 October to 3 November' }), later).pass).toBe(true);
    expect(failedNames(evaluateStatusCase(c({}, now), ok({ headline: '25 October' })))).toEqual(['invents no numbers']);
  });
});

describe('the validator of focus cases', () => {
  const good = () => ({ id: 'x', request: 'r', now: '2026-10-22T09:00:00Z', horizon: 'week', entries: [{ where: 'w', text: 'a' }], expect: { silent: true } });
  const problems = (change) => {
    const c = good();
    change(c);
    return validateStatusGolden([c]);
  };

  it('accepts a good case and names each problem', () => {
    expect(validateStatusGolden([good()])).toEqual([]);
    expect(problems((c) => (c.horizon = 'day'))[0]).toContain('horizon must be week, month or year');
    expect(problems((c) => delete c.now)[0]).toContain('a focused check needs a now');
    expect(problems((c) => (c.now = '2026-10-22'))[0]).toContain('now must be a UTC time');
    expect(problems((c) => (c.now = '2026-13-45T00:00:00Z'))[0]).toContain('now must be a UTC time');
    expect(problems((c) => (c.timeZone = 5))[0]).toContain('timeZone must be a time zone name');
    expect(problems((c) => (c.expect.silent = 'yes'))[0]).toContain('silent must be true or false');
    expect(problems((c) => (c.expect = { silent: true, cite: [1] }))[0]).toContain('expects silence but also expects citations or phrases');
    expect(problems((c) => (c.expect = { silent: true, mustInclude: ['a'] }))[0]).toContain('expects silence but also expects citations or phrases');
    expect(problems((c) => (c.expect = { silent: true, nothing: false }))[0]).toContain('silent contradicts');
    expect(problems((c) => (c.expect = { mustInclude: 'a' }))[0]).toContain('mustInclude must be a list of phrases');
    expect(problems((c) => (c.expect = { mustNotMention: ['|'] }))[0]).toContain('mustNotMention must be a list of phrases');
    expect(problems((c) => (c.expect = { maxPointChars: 0 }))[0]).toContain('maxPointChars must be a whole number from 1');
    expect(problems((c) => (c.expect = { maxTotalChars: 1.5 }))[0]).toContain('maxTotalChars must be a whole number from 1');
    expect(problems((c) => (c.ideal = { points: [{ text: 'a', refs: [2] }] }))[0]).toContain('ideal must be');
    expect(problems((c) => (c.ideal = { headline: 5, points: [] }))[0]).toContain('ideal must be');
    expect(validateStatusGolden([{ ...good(), ideal: { points: [{ text: 'a', refs: [1] }] } }])).toEqual([]);
  });
});

describe('the ideal model and the bad ones, on the real status', () => {
  it('the ideal scripted model passes every focused case, first time, with the window stated', async () => {
    const asked = [];
    const { results, aborted } = await runWith(({ caseDef }) => testing.createScriptedModelClient((request) => (asked.push(request), idealStatusScript(caseDef)(request))));
    expect(aborted).toBe(false);
    expect(results.map((r) => [r.caseId, r.pass])).toEqual(STATUS_FOCUS_GOLDEN.map((c) => [c.id, true]));
    for (const r of results) expect(r).toMatchObject({ error: null, attempts: 1, repaired: false });
    expect(asked[0].system).toContain('one-week check. Answer only about Thursday 22 October to Wednesday 28 October 2026 (2026-10-22 to 2026-10-28)');
    expect(asked[1].system).toContain('one-month check. Answer only about Thursday 22 October to Saturday 21 November 2026');
    expect(asked[2].system).toContain('one-year check. Answer only about Thursday 22 October 2026 to Friday 22 October 2027');
  });

  it('the ideal reply of a case with an ideal is exactly that ideal, silent when it has no points', () => {
    expect(idealStatusReply(byId('rent-week'))).toEqual({ headline: 'Nothing needs your attention this week.', points: [], nothing: true });
    expect(idealStatusReply(byId('dentist-beside-rent')).points).toEqual([{ text: 'Dentist tomorrow, Friday 23 October, at 09:15.', refs: [1] }]);
    expect(idealStatusReply({ ...byId('rent-week'), ideal: { points: [{ text: 'x', refs: [1] }] } }).headline).toBe('Here is what matters right now.');
  });

  it('one that dumps every note fails the silent cases, the cases that name what to leave out, and the cap', async () => {
    const dump = ({ caseDef }) => testing.createScriptedModelClient(() => ({ reply: JSON.stringify({ headline: 'Everything.', points: caseDef.entries.slice(0, 3).map((e, i) => ({ text: e.text.slice(0, 200), refs: [i + 1] })), nothing: caseDef.entries.length === 0 }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const { results } = await runWith(dump);
    const failed = results.filter((r) => !r.pass).map((r) => r.caseId);
    for (const id of ['rent-week', 'rent-month', 'france-week', 'france-month', 'dentist-beside-rent', 'hidden-instruction-week']) expect(failed, id).toContain(id);
    expect(failed.length).toBeGreaterThanOrEqual(7);
  });

  it('one that is never silent is caught on every silent case', async () => {
    const never = ({ caseDef }) => testing.createScriptedModelClient(() => ({ reply: JSON.stringify({ headline: 'Something.', points: [{ text: (caseDef.entries[0]?.text ?? 'Something to do').slice(0, 200) || 'x', refs: [1] }], nothing: false }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const { results } = await runWith(never, STATUS_FOCUS_GOLDEN.filter((c) => c.expect.silent === true && c.entries.length > 0));
    expect(results.every((r) => !r.pass)).toBe(true);
    for (const r of results) expect(r.checks.find((k) => k.name === 'is silent: one line, no points').pass).toBe(false);
  });

  it('one that invents a date is caught by the numbers check', async () => {
    const inventor = reply({ headline: 'Due on 31 December 2031', points: [{ text: 'Pay by 31/12/2031', refs: [1] }], nothing: false });
    const { results } = await runWith(inventor, [byId('overdue-is-shown'), byId('rent-year')]);
    for (const r of results) expect(r.checks.find((k) => k.name === 'invents no numbers').pass).toBe(false);
  });

  it('the runner gives the evaluator the window the real status worked out, so the end of the window is not an invented number', async () => {
    const sayWindow = reply({ headline: 'Nothing needs your attention until 28 October.', points: [], nothing: true });
    const { results } = await runWith(sayWindow, [byId('rent-week')]);
    expect(results[0].checks.find((k) => k.name === 'invents no numbers').pass).toBe(true);
    const sayOther = reply({ headline: 'Nothing needs your attention until 29 October.', points: [], nothing: true });
    expect((await runWith(sayOther, [byId('rent-week')])).results[0].checks.find((k) => k.name === 'invents no numbers').pass).toBe(false);
  });

  it('one that is always silent is caught on the cases that need an answer', async () => {
    const silent = reply({ headline: 'Nothing needs your attention.', points: [], nothing: true });
    const { results } = await runWith(silent);
    const failed = results.filter((r) => !r.pass).map((r) => r.caseId);
    expect(failed.sort()).toEqual(['dentist-beside-rent', 'france-year', 'overdue-is-shown', 'rent-year', 'too-many-this-week']);
  });

  it('one that pours out more points than the week allows is refused by the real guard (a failed run, not a pass)', async () => {
    const six = () => testing.createScriptedModelClient(() => ({ reply: JSON.stringify({ headline: 'Lots.', points: Array.from({ length: 4 }, (_, i) => ({ text: `Errand ${i + 1}`, refs: [1] })), nothing: false }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const { results } = await runWith(six, [byId('too-many-this-week')]);
    expect(results[0]).toMatchObject({ pass: false, error: { code: 'BAD_OUTPUT' } });
    expect(results[0].error.message).toContain('over the limit of 3');
  });
});

async function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const saved = [];
  const code = await main({ argv, env: extra.env ?? {}, lib, stdout: (t) => out.push(t), stderr: (t) => err.push(t), loadControls: extra.loadControls, loadGolden: extra.loadGolden ?? (async () => { throw new Error('none'); }), save: async (dir, name, json) => (saved.push({ dir, name, json }), `${dir}/${name}`) });
  return { code, out: out.join(''), err: err.join(''), saved };
}

describe('npm run eval -- --capability focus', () => {
  it('--scripted runs the eleven focused cases on every model, all pass, and saves under a focus name', async () => {
    const r = await run(['--capability', 'focus', '--scripted']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('33 done');
    expect(r.out).toContain('100% (11/11)');
    expect(r.out).toContain('rent-year');
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].name).toMatch(/-focus-scripted\.json$/);
    expect(r.saved[0].json).toMatchObject({ capability: 'focus', mode: 'scripted' });
    expect(r.saved[0].json.cases).toEqual(STATUS_FOCUS_GOLDEN.map((c) => c.id));
  });

  it('a real run without --yes plans and sends nothing, saying what would be sent', async () => {
    const r = await run(['--capability', 'focus'], { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-EVAL-SECRET-KEY-1234567890' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Planned: 11 cases × 3 models × 1 run = 33 real calls.');
    expect(r.out).toContain('Nothing was sent.');
    expect(r.saved).toEqual([]);
    expect(r.out + r.err).not.toContain('EVAL-SECRET');
  });

  it('--only picks focused cases, and the plain status set and the categorise path are unchanged', async () => {
    expect((await run(['--capability', 'focus', '--scripted', '--only', 'rent-week', '--models', 'fast'])).out).toContain('1 done');
    expect((await run(['--capability', 'status', '--scripted', '--models', 'fast'])).out).toContain('100% (6/6)');
    expect((await run(['--scripted', '--models', 'fast'])).code).toBe(0);
  });

  it('--controls with a candidate folder changes the result: one point allowed for a week makes the cases that need three fail, and nothing else', async () => {
    const { shippedFiles } = await import('../../src/llm/testing/shipped-controls.test-util.ts');
    const { loadControlsFolder } = await import('../../src/service/controls-files.ts');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const files = shippedFiles();
    const settings = JSON.parse(files['status/settings.json']);
    settings.horizons.week.maxPoints = 1;
    files['status/settings.json'] = JSON.stringify(settings);
    const dir = mkdtempSync(join(tmpdir(), 'caci-focus-controls-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name.split('/')[0]), { recursive: true });
        writeFileSync(join(dir, ...name.split('/')), text);
      }
      const loadControls = async (d) => {
        const r = loadControlsFolder(d);
        return r.ok ? { ok: true, value: r.value } : { ok: false, problems: r.error };
      };
      const shipped = await run(['--capability', 'focus', '--scripted', '--models', 'fast']);
      const candidate = await run(['--capability', 'focus', '--scripted', '--models', 'fast', '--controls', dir], { loadControls });
      expect(shipped.out).toContain('100% (11/11)');
      expect(candidate.out).not.toContain('100% (11/11)');
      expect(candidate.out).toContain('too-many-this-week');
      expect(candidate.out).toContain(dir);
      const failed = candidate.saved[0].json.results.filter((r) => !r.pass).map((r) => r.caseId);
      expect(failed).toEqual(['too-many-this-week']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
