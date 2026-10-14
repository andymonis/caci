import { describe, expect, it } from 'vitest';
import { aggregate, CUES, scoreAnswer } from './score.mjs';

const answer = (headline, ...points) => ({ headline, points: points.map((text) => ({ text })), nothing: false });
const NOTHING = { headline: 'Nothing relevant.', points: [], nothing: true };

const meds = { id: 'q', kind: 'override', ask: 'What tablets does Mum take?', must: [['1 x Tablet B']], stale: ['2 x Tablet A'] };

describe('the 2 x Tablet A to 1 x Tablet B case', () => {
  it.each([
    ['plain', answer('Mum takes 1 x Tablet B a day.')],
    ['digits and x', answer('Medication', 'She now takes 1x Tablet B daily.')],
    ['words', answer('Tablets', 'One times Tablet B each day.')],
    ['a multiplication sign', answer('Tablets', 'Tablet B: 1 × a day.', 'Take 1 × tablet b')],
    ['hyphenated and upper case', answer('MUM TAKES 1 X TABLET-B')],
    ['plural', answer('Her tablets', '1 x tablet B every morning')],
  ])('passes: %s', (_n, a) => {
    const s = scoreAnswer(meds, a);
    expect(s.pass, s.reasons.join('; ')).toBe(true);
    expect(s.stale[0].status).toBe('absent');
  });

  it.each([
    ['the old fact only', answer('Mum takes 2 x Tablet A a day.')],
    ['the old fact as current beside the new', answer('Mum takes 1 x Tablet B', 'She takes two times Tablet A a day.')],
    ['the old fact in the headline as current', answer('2 x Tablet A and 1 x Tablet B')],
    ['the old fact written another way', answer('Tablets', 'Two x tablet-a a day', '1 x Tablet B')],
    ['neither', answer('Mum takes some tablets.')],
  ])('fails: %s', (_n, a) => expect(scoreAnswer(meds, a).pass).toBe(false));

  it.each([
    ['instead of', answer('Mum takes 1 x Tablet B a day instead of 2 x Tablet A.')],
    ['no longer', answer('Mum no longer takes 2 x Tablet A; it is now 1 x Tablet B.')],
    ['changed from', answer('Tablets', 'The dose changed from 2 x Tablet A to 1 x Tablet B.')],
    ['previously', answer('Tablets', 'She previously took 2x Tablet A.', 'Now: 1 x Tablet B.')],
    ['replaced', answer('1 x Tablet B has replaced 2 x Tablet A')],
    ['stopped', answer('Stopped 2 x Tablet A, started 1 x Tablet B')],
  ])('passes with the old fact mentioned as superseded: %s', (_n, a) => {
    const s = scoreAnswer(meds, a);
    expect(s.pass, s.reasons.join('; ')).toBe(true);
    expect(s.stale[0].status).toBe('superseded');
  });

  it('a cue in a different point does not excuse the old fact as current', () => {
    const s = scoreAnswer(meds, answer('Tablets', 'Mum takes 2 x Tablet A a day.', 'Her old dose is no longer in use.', '1 x Tablet B too.'));
    expect(s.stale[0].status).toBe('surfaced');
    expect(s.pass).toBe(false);
  });

  it('when it appears twice, once as current and once superseded, it is surfaced', () => {
    const s = scoreAnswer(meds, answer('Tablets', 'Mum takes 2 x Tablet A a day.', 'It used to be 2 x Tablet A.', '1 x Tablet B'));
    expect(s.stale[0].status).toBe('surfaced');
  });
});

describe('must groups', () => {
  const q = { id: 'q', kind: 'multi', ask: 'x', must: [['tablet b', 'the new tablet'], ['blood pressure']] };
  it('every group needs one alternative, in the headline or any point', () => {
    expect(scoreAnswer(q, answer('Tablet B', 'for blood pressure')).pass).toBe(true);
    expect(scoreAnswer(q, answer('The new tablet is for blood pressure')).pass).toBe(true);
    expect(scoreAnswer(q, answer('Tablet B')).pass).toBe(false);
    expect(scoreAnswer(q, answer('blood pressure')).pass).toBe(false);
  });
  it('reports which alternative met each group and what is missing', () => {
    const s = scoreAnswer(q, answer('The new tablet'));
    expect(s.groups).toEqual([{ met: true, by: 'the new tablet' }, { met: false, by: null }]);
    expect(s.reasons).toEqual(['a required fact is missing (one of: "blood pressure")']);
  });
  it('a phrase inside a longer word does not count', () => {
    const one = { id: 'q', kind: 'recall', ask: 'x', must: [['tablet a']] };
    expect(scoreAnswer(one, answer('Tablet Apple pie')).pass).toBe(false);
    expect(scoreAnswer(one, answer('Tablet A')).pass).toBe(true);
    const stale = { id: 'q', kind: 'retract', ask: 'x', must: [['cancelled']], stale: ['swim'] };
    expect(scoreAnswer(stale, answer('Cancelled: swimming')).stale[0].status).toBe('absent');
  });
  it('a phrase may not be spread over two points', () => {
    const one = { id: 'q', kind: 'recall', ask: 'x', must: [['tablet b daily']] };
    expect(scoreAnswer(one, answer('Tablet B', 'daily')).pass).toBe(false);
  });
});

describe('an answer that says nothing', () => {
  it('fails a question whose answer is in the notes, even if the fact would have matched', () => {
    const s = scoreAnswer(meds, { headline: '1 x Tablet B', points: [], nothing: true });
    expect(s.pass).toBe(false);
    expect(s.nothing).toBe(true);
    expect(s.reasons.join(' ')).toContain('said nothing was relevant');
  });
  const none = { id: 'q', kind: 'distractor', ask: 'When is the dentist?', expectNothing: true };
  it('passes a distractor that expects nothing, and fails one that gives an answer or points', () => {
    expect(scoreAnswer(none, NOTHING).pass).toBe(true);
    expect(scoreAnswer(none, answer('The dentist is on Friday.')).pass).toBe(false);
    expect(scoreAnswer(none, { headline: 'h', points: [{ text: 'something' }], nothing: true }).pass).toBe(false);
    expect(scoreAnswer(none, answer('x')).reasons[0]).toContain('no answer in the notes');
  });
});

describe('no answer', () => {
  it.each([null, undefined, 'text', 5])('%s fails with a reason', (a) => {
    const s = scoreAnswer(meds, a);
    expect(s).toEqual({ pass: false, groups: [], stale: [], nothing: false, reasons: ['there was no answer'] });
  });
  it('an answer with no points list or odd points is still scored', () => {
    expect(scoreAnswer(meds, { headline: '1 x Tablet B' }).pass).toBe(true);
    expect(scoreAnswer(meds, { headline: 'x', points: [null, { text: 5 }, { text: '1 x Tablet B' }], nothing: false }).pass).toBe(true);
    expect(scoreAnswer(meds, { points: [{ text: '' }] }).pass).toBe(false);
  });
});

describe('the cues', () => {
  it('are a fixed list of phrases', () => {
    expect([...CUES]).toEqual(['no longer', 'previously', 'instead of', 'changed from', 'was changed', 'replaced', 'stopped', 'used to', 'cancelled', 'canceled', 'formerly', 'anymore', 'any more', 'no more', 'switched from', 'rather than']);
  });
  it.each(CUES)('"%s" excuses the old fact in the same point', (cue) => {
    expect(scoreAnswer(meds, answer('Tablets', `1 x Tablet B ${cue} 2 x Tablet A`)).stale[0].status).toBe('superseded');
  });
});

describe('aggregate', () => {
  const s = (pass, ...statuses) => ({ pass, stale: statuses.map((status) => ({ phrase: 'p', status })) });
  it('turns repeats into rates', () => {
    expect(aggregate([s(true, 'absent'), s(true, 'superseded'), s(false, 'surfaced'), s(false, 'surfaced')])).toEqual({ n: 4, passes: 2, passRate: 0.5, surfaced: 2, staleSurfacedRate: 0.5, superseded: 1, supersededRate: 0.25 });
  });
  it('one repeat with several stale phrases counts once', () => {
    expect(aggregate([s(false, 'surfaced', 'surfaced')]).surfaced).toBe(1);
  });
  it('no repeats is zeros, not NaN', () => {
    expect(aggregate([])).toEqual({ n: 0, passes: 0, passRate: 0, surfaced: 0, staleSurfacedRate: 0, superseded: 0, supersededRate: 0 });
  });
});
