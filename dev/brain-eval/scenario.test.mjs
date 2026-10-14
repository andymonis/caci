import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askedAt, loadScenarios, timeOf, validateScenario } from './scenario.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A sound scenario: a prescription changes. */
const sound = () => ({
  id: 'meds',
  title: 'A medication change',
  description: 'Tablet A becomes Tablet B.',
  notes: [
    { id: 'n1', at: '2026-01-05', text: 'GP prescribed Mum 2 x Tablet A a day for her blood pressure.' },
    { id: 'n2', at: '2026-01-12', text: 'Bought bread and milk.' },
    { id: 'n3', at: '2026-03-02T10:30Z', text: 'After the check-up the dose changed: Mum now takes 1 x Tablet B a day.' },
  ],
  questions: [
    { id: 'q-now', kind: 'override', after: 'n3', ask: 'What tablets does Mum take?', must: [['1 x Tablet B']], stale: ['2 x Tablet A'] },
    { id: 'q-early', kind: 'recall', after: 'n2', ask: 'What did the GP prescribe?', must: [['Tablet A']] },
    { id: 'q-none', kind: 'distractor', after: 'n3', ask: 'When is the dentist?', expectNothing: true },
  ],
});
const change = (fn) => {
  const s = sound();
  fn(s);
  return s;
};
const problems = (s) => validateScenario(s);

describe('a sound scenario', () => {
  it('has no problems', () => expect(problems(sound())).toEqual([]));
  it('accepts the three date forms, and a multi and a retract question', () => {
    const s = sound();
    s.notes[0].at = '2026-01-05T08:00:30Z';
    s.questions.push({ id: 'q-multi', kind: 'multi', after: 'n3', ask: 'Summarise the tablets', must: [['Tablet B'], ['blood pressure']] });
    s.questions.push({ id: 'q-retract', kind: 'retract', after: 'n3', ask: 'Is it still Tablet A?', must: [['changed']], stale: ['Tablet A'] });
    expect(problems(s)).toEqual([]);
  });
});

describe('the scenario', () => {
  it.each([
    ['not an object', null, 'must be an object'],
    ['an unknown field', change((s) => (s.extra = 1)), 'unknown field "extra"'],
    ['a bad id', change((s) => (s.id = 'Bad Id')), 'id must be lowercase'],
    ['no title', change((s) => (s.title = ' ')), 'title must be non-empty'],
    ['a description that is not text', change((s) => (s.description = 5)), 'description must be text'],
    ['no notes', change((s) => (s.notes = [])), 'notes must be a non-empty list'],
    ['no questions', change((s) => (s.questions = [])), 'questions must be a non-empty list'],
  ])('%s', (_n, s, text) => expect(problems(s).join('\n')).toContain(text));
});

describe('the notes', () => {
  it.each([
    ['not an object', change((s) => (s.notes[1] = 'x')), 'must be an object'],
    ['an unknown field', change((s) => (s.notes[1].who = 'ann')), 'unknown field "who"'],
    ['a bad id', change((s) => (s.notes[1].id = 'N 2')), 'id must be lowercase'],
    ['a duplicate id', change((s) => (s.notes[1].id = 'n1')), 'duplicate note id'],
    ['no date', change((s) => delete s.notes[1].at), 'at must be an ISO date'],
    ['a date that is not real', change((s) => (s.notes[1].at = '2026-13-45')), 'at must be an ISO date'],
    ['a date in the wrong form', change((s) => (s.notes[1].at = '5 Jan 2026')), 'at must be an ISO date'],
    ['out of order', change((s) => (s.notes[2].at = '2026-01-01')), 'dated earlier than the note before it'],
    ['blank text', change((s) => (s.notes[1].text = '   ')), 'text must be non-empty'],
    ['text that is not text', change((s) => (s.notes[1].text = 7)), 'text must be non-empty'],
    ['too long', change((s) => (s.notes[1].text = 'x'.repeat(8001))), 'over 8000 characters'],
  ])('%s', (_n, s, text) => expect(problems(s).join('\n')).toContain(text));

  it('every note out of order is flagged, not just the first', () => {
    const s = sound();
    s.notes[0].at = '2026-01-10';
    s.notes[1].at = '2026-01-05';
    s.notes[2].at = '2026-01-07';
    expect(problems(s).filter((p) => p.includes('dated earlier'))).toHaveLength(2);
  });

  it('the same time twice is allowed, and 8,000 characters exactly', () => {
    const s = sound();
    s.notes[1].at = '2026-01-05';
    s.notes[1].text = 'y'.repeat(8000);
    expect(problems(s)).toEqual([]);
  });
});

describe('the questions', () => {
  it.each([
    ['not an object', change((s) => (s.questions[0] = 5)), 'must be an object'],
    ['an unknown field', change((s) => (s.questions[0].extra = 1)), 'unknown field "extra"'],
    ['a bad id', change((s) => (s.questions[0].id = 'Q')), 'id must be lowercase'],
    ['a duplicate id', change((s) => (s.questions[1].id = 'q-now')), 'duplicate question id'],
    ['an unknown kind', change((s) => (s.questions[0].kind = 'guess')), 'kind must be one of'],
    ['no ask', change((s) => (s.questions[0].ask = '')), 'ask must be non-empty'],
    ['an ask that is too long', change((s) => (s.questions[0].ask = 'x'.repeat(501))), 'ask is over 500'],
    ['a checkpoint that is not a note', change((s) => (s.questions[0].after = 'nope')), 'after must be the id of a note'],
    ['a time that is not a time', change((s) => (s.questions[0].at = 'later')), 'at must be an ISO date'],
    ['a time before its note', change((s) => (s.questions[0].at = '2026-01-01')), 'at is earlier than the note it follows'],
    ['why that is not text', change((s) => (s.questions[0].why = 1)), 'why must be text'],
    ['expectNothing that is not a boolean', change((s) => (s.questions[2].expectNothing = 'yes')), 'expectNothing must be true or false'],
  ])('%s', (_n, s, text) => expect(problems(s).join('\n')).toContain(text));

  it('an ask of exactly 500 characters is fine', () => {
    expect(problems(change((s) => (s.questions[0].ask = 'x'.repeat(500))))).toEqual([]);
  });

  it('a question may be asked at its own time, at or after its note', () => {
    const s = sound();
    s.questions[0].at = '2026-03-02T10:30Z';
    expect(problems(s)).toEqual([]);
    s.questions[0].at = '2026-06-01';
    expect(problems(s)).toEqual([]);
  });
});

describe('must and stale', () => {
  it.each([
    ['must that is not a list', change((s) => (s.questions[1].must = 'Tablet A')), 'must must be a non-empty list of groups'],
    ['an empty must', change((s) => (s.questions[1].must = [])), 'must must be a non-empty list of groups'],
    ['a group that is not a list', change((s) => (s.questions[1].must = ['Tablet A'])), 'must group 1 must be a non-empty list'],
    ['an empty group', change((s) => (s.questions[1].must = [[]])), 'must group 1 must be a non-empty list'],
    ['a phrase with no words', change((s) => (s.questions[1].must = [['...']])), 'must group 1 must be a non-empty list'],
    ['a phrase that is not text', change((s) => (s.questions[1].must = [[5]])), 'must group 1 must be a non-empty list'],
    ['no must on a recall question', change((s) => delete s.questions[1].must), 'must is required'],
    ['stale that is not a list', change((s) => (s.questions[0].stale = 'x')), 'stale must be a non-empty list'],
    ['an empty stale phrase', change((s) => (s.questions[0].stale = [''])), 'stale must be a non-empty list'],
    ['stale on a recall question', change((s) => (s.questions[1].stale = ['Tablet A'])), 'stale phrases are for override and retract'],
    ['an override with no stale phrase', change((s) => delete s.questions[0].stale), 'an override question needs a stale phrase'],
    ['a multi with one group', change((s) => (s.questions.push({ id: 'm', kind: 'multi', after: 'n3', ask: 'x', must: [['Tablet B']] }))), 'a multi question needs at least two must groups'],
    ['expectNothing on a recall question', change((s) => (s.questions[1].expectNothing = true)), 'expectNothing is for distractor questions only'],
    ['a distractor that does not expect nothing', change((s) => delete s.questions[2].expectNothing), 'a distractor must set expectNothing to true'],
    ['a distractor with a must', change((s) => (s.questions[2].must = [['dentist']])), 'a distractor has no must or stale'],
    ['a distractor with a stale phrase', change((s) => (s.questions[2].stale = ['dentist'])), 'a distractor has no must or stale'],
  ])('%s', (_n, s, text) => expect(problems(s).join('\n')).toContain(text));
});

describe('answerable, and the override is real', () => {
  it('a must phrase in no note makes the question unanswerable', () => {
    const p = problems(change((s) => (s.questions[1].must = [['Tablet Z']])));
    expect(p.join('\n')).toContain('is in no note at or before the checkpoint, so the question cannot be answered');
  });
  it('a must phrase only in a note after the checkpoint is unanswerable too', () => {
    const p = problems(change((s) => (s.questions[1].must = [['Tablet B']])));
    expect(p.join('\n')).toContain('cannot be answered');
  });
  it('one alternative being present is enough for a group', () => {
    expect(problems(change((s) => (s.questions[1].must = [['Tablet Z', 'Tablet A']])))).toEqual([]);
  });
  it('an override whose stale phrase is in no note is refused', () => {
    const p = problems(change((s) => (s.questions[0].stale = ['3 x Tablet C'])));
    expect(p.join('\n')).toContain('nothing is being overridden');
  });
  it('an override whose stale phrase first appears only with or after the new fact is refused, naming both notes', () => {
    const s = sound();
    s.notes[0].text = 'GP prescribed Mum something for her blood pressure.';
    s.notes[2].text = 'After the check-up: Mum now takes 1 x Tablet B a day, down from 2 x Tablet A.';
    const p = problems(s).join('\n');
    expect(p).toContain('first appears in note 3, not earlier than the note that holds the new fact (note 3)');
  });
  it('with two must groups the new fact is the latest of them', () => {
    const s = sound();
    s.questions[0].must = [['blood pressure'], ['1 x Tablet B']];
    expect(problems(s)).toEqual([]);
    s.questions[0].stale = ['1 x Tablet B'];
    expect(problems(s).join('\n')).toContain('not earlier than the note that holds the new fact');
    s.questions[0].stale = ['blood pressure'];
    expect(problems(s)).toEqual([]); // the unchanged fact is first noted earlier, so it counts as earlier
  });
  it('a group that has an alternative already in an early note does not hold a new fact', () => {
    const s = sound();
    s.questions[0].must = [['1 x Tablet B', 'Tablet A']];
    expect(problems(s).join('\n')).toContain('not earlier than the note that holds the new fact (note 1)');
  });
  it('a retract question needs no earlier-than check', () => {
    const s = sound();
    s.questions.push({ id: 'r', kind: 'retract', after: 'n3', ask: 'x', must: [['Tablet B']], stale: ['Tablet B'] });
    expect(problems(s)).toEqual([]);
  });
  it('matching is on normalised words, so a different wording of the same fact counts', () => {
    const s = sound();
    s.notes[2].text = 'After the check-up Mum now takes one times tablet-B a day.';
    expect(problems(s)).toEqual([]);
  });
  it('lists every problem at once', () => {
    const s = sound();
    s.notes[0].at = 'bad';
    s.questions[0].kind = 'x';
    s.questions[1].must = [['zzz']];
    expect(problems(s).length).toBeGreaterThanOrEqual(3);
  });
});

describe('times', () => {
  it('turns dates and date-times into milliseconds (a date alone is 09:00 UTC) and refuses the rest', () => {
    expect(timeOf('2026-03-02')).toBe(Date.UTC(2026, 2, 2, 9));
    expect(timeOf('2026-03-02T10:30')).toBe(Date.UTC(2026, 2, 2, 10, 30));
    expect(timeOf('2026-03-02T10:30Z')).toBe(Date.UTC(2026, 2, 2, 10, 30));
    expect(timeOf('2026-03-02T10:30:15Z')).toBe(Date.UTC(2026, 2, 2, 10, 30, 15));
    for (const bad of ['', 'x', '2026-3-2', '2026-02-30T99:00Z', 5, undefined]) expect(timeOf(bad), String(bad)).toBeUndefined();
  });
  it('a question is asked an hour after its note unless it says when', () => {
    const s = sound();
    expect(askedAt(s, s.questions[0])).toBe(Date.UTC(2026, 2, 2, 10, 30) + 3_600_000);
    expect(askedAt(s, { ...s.questions[0], at: '2026-06-01' })).toBe(Date.UTC(2026, 5, 1, 9));
  });
});

describe('loading a folder', () => {
  const folder = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-brain-eval-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    return dir;
  };
  it('reads every .json scenario in name order and ignores other files', () => {
    const other = { ...sound(), id: 'other' };
    const r = loadScenarios(folder({ 'b.json': other, 'a.json': sound(), 'README.md': '# not a scenario' }));
    expect(r.ok).toBe(true);
    expect(r.scenarios.map((s) => s.id)).toEqual(['meds', 'other']);
  });
  it('refuses a missing folder, a file in its place, and a folder with no scenarios', () => {
    expect(loadScenarios(join(tmpdir(), 'caci-nowhere-' + Date.now()))).toMatchObject({ ok: false, problems: [expect.stringContaining('does not exist')] });
    const dir = folder({ 'a.json': sound() });
    expect(loadScenarios(join(dir, 'a.json'))).toMatchObject({ ok: false, problems: [expect.stringContaining('is not a folder')] });
    const empty = mkdtempSync(join(tmpdir(), 'caci-brain-empty-'));
    dirs.push(empty);
    mkdirSync(join(empty, 'sub'));
    expect(loadScenarios(empty)).toMatchObject({ ok: false, problems: [expect.stringContaining('no .json scenario files')] });
  });
  it('names the file for invalid JSON, a scenario problem and a duplicate id', () => {
    const r = loadScenarios(folder({ 'a.json': sound(), 'b.json': '{ nope', 'c.json': { ...sound(), id: 'Bad' }, 'd.json': sound() }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringContaining('b.json: is not valid JSON'), expect.stringContaining('c.json: scenario "Bad"'), 'd.json: the scenario id "meds" is already used by a.json']);
  });
  it('a file that is not a scenario at all is a problem, not a crash', () => {
    const r = loadScenarios(folder({ 'a.json': '[1,2]', 'b.json': 'null' }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['a.json: scenario: must be an object', 'b.json: scenario: must be an object']);
  });
});
