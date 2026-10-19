import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerer, grounded, replaceEverything } from './answerers.test-util.mjs';
import { runBrainArm } from './brain-arm.mjs';
import { controls, demoClient, lib } from './lib.test-util.mjs';
import { formatListing } from './list.mjs';
import { runReplayArm } from './replay-arm.mjs';
import { KINDS, loadScenarios, validateScenario } from './scenario.mjs';
import { scoreAnswer } from './score.mjs';

const DIR = new URL('./scenarios/', import.meta.url);
const loaded = loadScenarios(DIR.pathname);
const scenarios = loaded.ok ? loaded.scenarios : [];
const FAST = { label: 'fast', choice: { tier: 'fast' } };

describe('the library', () => {
  it('loads and every scenario is sound', () => {
    expect(loaded.ok, JSON.stringify(loaded.problems)).toBe(true);
    for (const s of scenarios) expect(validateScenario(s), s.id).toEqual([]);
  });
  it('has twelve scenarios with 10 to 40 notes each and about 30 to 60 questions', () => {
    expect(scenarios.map((s) => s.id)).toEqual(['activity-cancelled', 'appointment-details-one-changes', 'appointment-moved-twice', 'changed-routine', 'contact-details-change', 'fact-corrected', 'medication-change', 'old-detail-still-relevant', 'profile-one-value-changes', 'second-medication-added', 'two-appointments-similar-words', 'two-people-not-mixed']);
    for (const s of scenarios) {
      expect(s.notes.length, s.id).toBeGreaterThanOrEqual(10);
      expect(s.notes.length, s.id).toBeLessThanOrEqual(40);
      expect(s.title.length).toBeGreaterThan(5);
      expect(s.description.length).toBeGreaterThan(30);
    }
    const questions = scenarios.flatMap((s) => s.questions);
    expect(questions.length).toBeGreaterThanOrEqual(30);
    expect(questions.length).toBeLessThanOrEqual(60);
  });
  it('covers all five kinds of question, several of each, and every question says why', () => {
    const questions = scenarios.flatMap((s) => s.questions);
    for (const kind of KINDS) expect(questions.filter((q) => q.kind === kind).length, kind).toBeGreaterThanOrEqual(3);
    for (const q of questions) expect(typeof q.why === 'string' && q.why.length > 10, q.id).toBe(true);
  });
  it('contains the brief\'s own example: 2 x Tablet A becomes 1 x Tablet B', () => {
    const q = scenarios.find((s) => s.id === 'medication-change').questions.find((x) => x.id === 'tablets-now');
    expect(q).toMatchObject({ kind: 'override', must: [['1 x Tablet B']], stale: ['2 x Tablet A'] });
  });
  it('covers each of the eight situations the plan names', () => {
    const text = scenarios.map((s) => `${s.id} ${s.title} ${s.description}`).join(' ').toLowerCase();
    for (const word of ['medication', 'moved twice', 'phone number', 'corrected', 'cancelled', 'early safety detail', 'two people', 'routine']) expect(text, word).toContain(word);
  });
  it('invents everything: no real-looking email, url or long number is in any note', () => {
    for (const s of scenarios) for (const n of s.notes) expect(n.text, n.id).not.toMatch(/@(?!example\.test)|https?:|www\./);
  });
  it('the review listing is current, and lists every note and question', () => {
    const listing = formatListing(scenarios);
    expect(readFileSync(new URL('REVIEW.md', DIR), 'utf8')).toBe(listing);
    for (const s of scenarios) {
      expect(listing).toContain(`## ${s.id}: ${s.title}`);
      for (const n of s.notes) expect(listing).toContain(`- ${n.id} · ${n.at} · ${n.text}`);
      for (const q of s.questions) expect(listing).toContain(`**${q.id}** (${q.kind}, asked after ${q.after}`);
    }
    expect(listing).toContain('stale: "2 x Tablet A"');
    expect(listing).toContain('the right answer is that nothing relevant is known');
    expect(listing).toContain('must: "1 x Tablet B"');
  });
});

/** Runs every scenario through one arm with an answering model that behaves in a known way. */
async function through(arm, mode) {
  const out = [];
  for (const scenario of scenarios) {
    const makeClient = (who) => (who.role === 'file' ? demoClient() : answerer(mode, scenarios));
    const r = arm === 'brain'
      ? await runBrainArm({ lib, controls, scenario, fileWith: FAST, answerWith: [FAST], makeClient, replace: false })
      : await runReplayArm({ lib, controls, scenario, answerWith: [FAST], makeClient });
    out.push(...r.answers);
  }
  return out;
}
const byQuestion = (answers) => Object.fromEntries(answers.map((a) => [`${a.scenario}/${a.question}`, a]));

describe.each(['brain', 'replay'])('%s arm: scoring tells good from bad', (arm) => {
  const questions = scenarios.flatMap((s) => s.questions.map((q) => ({ s, q })));
  const results = {};
  const get = async (mode) => (results[mode] ??= byQuestion(await through(arm, mode)));

  it('an ideal answerer passes every question', async () => {
    const r = await get('ideal');
    expect(Object.keys(r)).toHaveLength(questions.length);
    const failed = Object.entries(r).filter(([, a]) => !a.pass).map(([k, a]) => `${k}: ${a.score.reasons.join('; ')}`);
    expect(failed).toEqual([]);
    expect(Object.values(r).every((a) => a.error === null && a.attempts === 1)).toBe(true);
  }, 120000);

  it('every fact a question needs gets into the brain through the demo filing, and into the context', async () => {
    const r = await get('ideal');
    const lost = Object.entries(r).filter(([, a]) => a.diagnostic !== null && (a.diagnostic.inBrain.includes(false) || a.diagnostic.inContext.includes(false)));
    expect(lost.map(([k, a]) => `${k}: ${JSON.stringify(a.diagnostic)}`)).toEqual([]);
  }, 120000);

  it('a stale parrot, quoting the oldest note, fails every override question', async () => {
    const r = await get('parrot');
    const overrides = questions.filter(({ q }) => q.kind === 'override');
    expect(overrides.length).toBeGreaterThanOrEqual(8);
    for (const { s, q } of overrides) expect(r[`${s.id}/${q.id}`].pass, `${s.id}/${q.id}`).toBe(false);
    expect(Object.values(r).filter((a) => a.score.stale.some((x) => x.status === 'surfaced')).length).toBeGreaterThanOrEqual(8);
  }, 120000);

  it('the parrot still passes plain recall of an early fact, so it is the staleness that fails it', async () => {
    const r = await get('parrot');
    const recalls = questions.filter(({ q }) => q.kind === 'recall');
    const passed = recalls.filter(({ s, q }) => r[`${s.id}/${q.id}`].pass);
    expect(passed.length).toBeGreaterThanOrEqual(recalls.length - 2);
  }, 120000);

  it('an amnesiac, quoting only the newest note, fails recall questions about earlier notes', async () => {
    const r = await get('amnesiac');
    const early = questions.filter(({ s, q }) => q.kind === 'recall' && !scoreAnswer(q, { headline: 'x', points: [{ text: s.notes.find((n) => n.id === q.after).text.slice(0, 120) }], nothing: false }).pass);
    expect(early.length).toBeGreaterThanOrEqual(8);
    for (const { s, q } of early) expect(r[`${s.id}/${q.id}`].pass, `${s.id}/${q.id}`).toBe(false);
    const all = Object.values(r);
    expect(all.filter((a) => a.pass).length).toBeLessThan(all.length / 2);
  }, 120000);

  it('a model that always says nothing passes only the distractors', async () => {
    const r = await get('nothing');
    for (const { s, q } of questions) expect(r[`${s.id}/${q.id}`].pass, `${s.id}/${q.id}`).toBe(q.kind === 'distractor');
    expect(questions.filter(({ q }) => q.kind === 'distractor').length).toBeGreaterThanOrEqual(8);
  }, 120000);
});

describe('replacing (R-014): the library separates a brain that replaces well from one that deletes what it should keep', () => {
  const NEW = ['second-medication-added', 'two-appointments-similar-words'];
  const filedWith = (wrap) => (who) => (who.role === 'file' ? wrap(demoClient()) : grounded(scenarios));
  const runAll = async (wrap, only) => {
    const out = [];
    for (const scenario of scenarios.filter((s) => only === undefined || only.includes(s.id))) {
      const r = await runBrainArm({ lib, controls, scenario, fileWith: FAST, answerWith: [FAST], makeClient: filedWith(wrap), replace: true });
      out.push(...r.answers.map((a) => ({ ...a, filing: r.filing })));
    }
    return out;
  };

  it('the two new scenarios add a different fact and must not replace anything', () => {
    for (const id of NEW) {
      const s = scenarios.find((x) => x.id === id);
      const text = s.notes.map((n) => n.text).join(' ');
      expect(text, id).not.toMatch(/\b(?:now|changed|change|instead|moved|rescheduled|corrected|actually|new|replaced|cancelled|switched)\b/i);
      expect(s.questions.filter((q) => q.kind !== 'distractor').every((q) => q.stale === undefined), id).toBe(true);
      expect(s.questions.some((q) => q.kind === 'multi'), id).toBe(true);
    }
  });

  it('a careful model over the demo filing, replacing on, passes the new scenarios and replaces nothing in them', async () => {
    const answers = (await runAll((c) => c)).filter((a) => NEW.includes(a.scenario));
    expect(answers.length).toBeGreaterThanOrEqual(8);
    expect(answers.filter((a) => !a.pass).map((a) => `${a.scenario}/${a.question}: ${a.score.reasons.join('; ')}`)).toEqual([]);
    for (const a of answers) expect(a.filing.every((f) => f.replaced.length === 0), a.scenario).toBe(true);
  }, 120000);

  it('with the demo filing and replacing on, the old scenarios lose only the details a replacing note did not repeat (a finding, not a fault in the library)', async () => {
    // "Hospital moved Dad's appointment: Thursday 12 March at 9am" replaces the note that held "Ward C": the unchanged ward is gone.
    const answers = (await runAll((c) => c)).filter((a) => !NEW.includes(a.scenario));
    const failed = answers.filter((a) => !a.pass);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const a of failed) expect(a.diagnostic?.lostAt, `${a.scenario}/${a.question}`).toBe('replace');
    const noReplace = [];
    for (const scenario of scenarios.filter((x) => !NEW.includes(x.id))) {
      const r = await runBrainArm({ lib, controls, scenario, fileWith: FAST, answerWith: [FAST], makeClient: filedWith((c) => c), replace: false });
      noReplace.push(...r.answers);
    }
    expect(noReplace.filter((a) => !a.pass).map((a) => `${a.scenario}/${a.question}`)).toEqual([]);
  }, 120000);

  it('a filing model that replaces everything it is shown fails the new scenarios, and the diagnostic says the fact was deleted', async () => {
    const answers = await runAll(replaceEverything, NEW);
    for (const id of NEW) {
      const mine = answers.filter((a) => a.scenario === id);
      const lost = mine.filter((a) => a.diagnostic?.lostAt === 'replace');
      expect(lost.length, id).toBeGreaterThanOrEqual(2);
      for (const a of lost) expect(a.pass, `${id}/${a.question}`).toBe(false);
      expect(mine.find((a) => a.kind === 'distractor')?.pass ?? true).toBe(true);
    }
  }, 120000);

  it('replace-everything also damages the old scenarios where a note really changes something only if the wrong note was removed', async () => {
    const answers = await runAll(replaceEverything, ['medication-change', 'two-people-not-mixed']);
    const wrong = answers.filter((a) => a.diagnostic?.lostAt === 'replace');
    expect(wrong.length).toBeGreaterThanOrEqual(1);
  }, 120000);
});

describe('facts (R-015): a note of several facts, then one of them changes', () => {
  const MULTI = ['profile-one-value-changes', 'appointment-details-one-changes'];
  const withFacts = (n) => ({ ...controls, categorise: { ...controls.categorise, settings: { ...controls.categorise.settings, maxFacts: n } } });
  const runWith = async (maxFacts) => {
    const out = [];
    let filings = [];
    for (const scenario of scenarios.filter((s) => MULTI.includes(s.id))) {
      const r = await runBrainArm({ lib, controls: withFacts(maxFacts), scenario, fileWith: FAST, answerWith: [FAST], makeClient: (who) => (who.role === 'file' ? demoClient() : grounded(scenarios)), replace: true });
      out.push(...r.answers);
      filings = filings.concat(r.filing);
    }
    return { answers: out, filings };
  };

  it('with facts the unchanged details survive: every question of the two scenarios passes and the replacement removes one fact', async () => {
    const { answers, filings } = await runWith(8);
    expect(answers.filter((a) => !a.pass).map((a) => `${a.scenario}/${a.question}: ${a.score.reasons.join('; ')}`)).toEqual([]);
    expect(filings.filter((f) => f.replaced.length > 0).map((f) => f.replaced.length)).toEqual([1, 1]);
    expect(filings[0].facts).toBeGreaterThanOrEqual(3);
  }, 60000);

  it('with one fact allowed the whole note is replaced and the details are lost; the diagnostic says replace', async () => {
    const { answers } = await runWith(1);
    const failed = answers.filter((a) => !a.pass);
    expect(failed.map((a) => a.question).sort()).toEqual(['all-details', 'birthday', 'contact-details', 'email', 'hospital', 'ward']);
    for (const a of failed) expect(a.diagnostic.lostAt, `${a.scenario}/${a.question}`).toBe('replace');
  }, 60000);

  it('so the facts version loses fewer facts than maxFacts 1 on these scenarios (the A/B through the controls)', async () => {
    const lost = (r) => r.answers.filter((a) => a.diagnostic?.lostAt === 'replace').length;
    expect(lost(await runWith(8))).toBeLessThan(lost(await runWith(1)));
  }, 60000);

  it('the new scenarios are about one value changing: the changed fact has a stale value, the others have none', () => {
    for (const id of MULTI) {
      const s = scenarios.find((x) => x.id === id);
      expect(s.questions.filter((q) => q.kind === 'override')).toHaveLength(1);
      expect(s.questions.filter((q) => q.kind === 'recall').length).toBeGreaterThanOrEqual(2);
      expect(s.questions.some((q) => q.kind === 'multi')).toBe(true);
    }
  });
});

describe('formatListing on small inputs', () => {
  it('shows a question\'s own time, leaves out what is not there and quotes alternatives', () => {
    const text = formatListing([{ id: 'x', title: 'T', notes: [{ id: 'n1', at: '2026-01-01', text: 'hello' }], questions: [
      { id: 'a', kind: 'recall', after: 'n1', at: '2026-02-01', ask: 'q?', must: [['one', 'two'], ['three']] },
      { id: 'b', kind: 'override', after: 'n1', ask: 'q2?', must: [['x']], stale: ['y', 'z'], why: 'because' },
    ] }]);
    expect(text).toContain('**a** (recall, asked after n1 at 2026-02-01): q?');
    expect(text).toContain('must: "one" or "two"');
    expect(text).toContain('must: "three"');
    expect(text).toContain('stale: "y" or "z"');
    expect(text).toContain('why: because');
    expect(text).toContain('1 scenarios, 1 notes, 2 questions');
    expect(text).not.toContain('nothing relevant');
    expect(text.match(/why:/g)).toHaveLength(1);
    expect(text).toContain('**b** (override, asked after n1): q2?');
  });
});
