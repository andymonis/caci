import { describe, expect, it } from 'vitest';
import { MAX_PAD, padScenario, safeFiller, seeded } from './pad.mjs';
import { timeOf, validateScenario } from './scenario.mjs';
import { hasPhrase } from './text.mjs';
import { controls, demoClient, lib } from './lib.test-util.mjs';
import { runBrainArm } from './brain-arm.mjs';

const base = () => ({
  id: 'meds', title: 't', description: 'd',
  notes: [
    { id: 'n1', at: '2026-01-05', text: 'GP prescribed Mum 2 x Tablet A a day for her blood pressure.' },
    { id: 'n2', at: '2026-01-12T14:30', text: 'Dentist appointment is on Friday at 9.' },
    { id: 'n3', at: '2026-03-02T10:30Z', text: 'After the check-up Mum now takes 1 x Tablet B a day.' },
  ],
  questions: [
    { id: 'q-early', kind: 'recall', after: 'n2', ask: 'What did the GP prescribe?', must: [['Tablet A']] },
    { id: 'q-now', kind: 'override', after: 'n3', ask: 'What tablets does Mum take?', must: [['1 x Tablet B']], stale: ['2 x Tablet A'] },
    { id: 'q-none', kind: 'distractor', after: 'n3', ask: 'When is the optician booked?', expectNothing: true },
  ],
});

describe('seeded', () => {
  it('gives the same numbers for the same seed, different for another, all in [0, 1)', () => {
    const a = seeded(7);
    const b = seeded(7);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 5 }, seeded(8)));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, seeded(1))).size).toBe(1000);
  });
});

describe('padScenario', () => {
  it('pad 0 is the scenario itself', () => {
    const s = base();
    expect(padScenario(s, 0)).toBe(s);
  });
  it('adds exactly N notes and keeps the originals, in order, with their ids, dates and text', () => {
    const p = padScenario(base(), 40, 3);
    expect(p.notes).toHaveLength(43);
    expect(p.notes.filter((n) => !n.id.startsWith('pad-'))).toEqual(base().notes);
    expect(p.notes.filter((n) => n.id.startsWith('pad-')).map((n) => n.id)).toHaveLength(40);
    expect(new Set(p.notes.map((n) => n.id)).size).toBe(43);
    expect(p.questions).toEqual(base().questions);
  });
  it('keeps the scenario valid and the dates non-decreasing, each filler within the gap it sits in', () => {
    const p = padScenario(base(), 200, 5);
    expect(validateScenario(p)).toEqual([]);
    const times = p.notes.map((n) => timeOf(n.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(timeOf('2026-01-05'));
    expect(times.at(-1)).toBe(timeOf('2026-03-02T10:30Z'));
    // nothing after the last note and nothing before the first
    expect(p.notes[0].id).toBe('n1');
    expect(p.notes.at(-1).id).toBe('n3');
  });
  it('is deterministic: the same seed gives the same padded scenario, another seed does not', () => {
    expect(padScenario(base(), 30, 9)).toEqual(padScenario(base(), 30, 9));
    expect(padScenario(base(), 30, 9)).not.toEqual(padScenario(base(), 30, 10));
    expect(padScenario(base(), 30)).toEqual(padScenario(base(), 30, 1));
  });
  it('a smaller pad is not a prefix mix-up: pads of different size are separate draws but both valid', () => {
    expect(validateScenario(padScenario(base(), 1, 2))).toEqual([]);
    expect(validateScenario(padScenario(base(), MAX_PAD, 2))).toEqual([]);
  });
  it('no filler contains any must or stale phrase, nor a word of a distractor question', () => {
    const s = base();
    s.notes.push({ id: 'n4', at: '2026-03-03', text: 'Booked the optician for April.' });
    const p = padScenario(s, 600, 4);
    const filler = p.notes.filter((n) => n.id.startsWith('pad-'));
    const phrases = ['Tablet A', '1 x Tablet B', '2 x Tablet A'];
    for (const f of filler) {
      for (const phrase of phrases) expect(hasPhrase(f.text, phrase), f.text).toBe(false);
      expect(f.text.toLowerCase()).not.toContain('optician');
    }
  });
  it('filler is varied: nearly all texts are different', () => {
    const p = padScenario(base(), 300, 6);
    expect(new Set(p.notes.filter((n) => n.id.startsWith('pad-')).map((n) => n.text)).size).toBe(300);
  });
  it('picks another filler when the first would leak a phrase', () => {
    const s = base();
    s.questions[0].must = [['bread'], ['milk'], ['eggs'], ['apples'], ['pasta'], ['rice']];
    s.notes[0].text = 'Mum likes bread milk eggs apples pasta rice. GP prescribed 2 x Tablet A.';
    const p = padScenario(s, 100, 2);
    for (const n of p.notes.filter((x) => x.id.startsWith('pad-'))) for (const w of ['bread', 'milk', 'eggs', 'apples', 'pasta', 'rice']) expect(hasPhrase(n.text, w), n.text).toBe(false);
  });
  it('is refused for bad numbers and for a scenario with one note', () => {
    for (const n of [-1, 1.5, MAX_PAD + 1, NaN, '3']) expect(() => padScenario(base(), n)).toThrow(RangeError);
    expect(() => padScenario(base(), 3, 1.5)).toThrow('seed');
    const one = base();
    one.notes = [one.notes[0]];
    one.questions = [one.questions[0]];
    one.questions[0].after = 'n1';
    expect(() => padScenario(one, 3)).toThrow('fewer than two notes');
    expect(padScenario(one, 0)).toBe(one);
  });
  it('a gap with no whole minute in it takes the earlier note\'s own time', () => {
    const s = base();
    s.notes = [{ id: 'n1', at: '2026-01-05T10:00:10', text: 'first' }, { id: 'n2', at: '2026-01-05T10:00:50', text: 'second' }];
    s.questions = [{ id: 'q', kind: 'recall', after: 'n2', ask: 'x?', must: [['first']] }];
    const p = padScenario(s, 5, 1);
    expect(validateScenario(p)).toEqual([]);
    expect(p.notes.filter((n) => n.id.startsWith('pad-')).every((n) => n.at === '2026-01-05T10:00:10')).toBe(true);
  });
  it('does not change the scenario it is given', () => {
    const s = base();
    const copy = JSON.parse(JSON.stringify(s));
    padScenario(s, 20, 1);
    expect(s).toEqual(copy);
  });
});

describe('where the filler goes', () => {
  it('is spread over every gap, at many different times, with ids numbered from 0001', () => {
    const p = padScenario(base(), 200, 11);
    const at = (id) => p.notes.findIndex((n) => n.id === id);
    const gap1 = p.notes.slice(at('n1') + 1, at('n2')).length;
    const gap2 = p.notes.slice(at('n2') + 1, at('n3')).length;
    expect(gap1).toBeGreaterThan(40);
    expect(gap2).toBeGreaterThan(40);
    expect(gap1 + gap2).toBe(200);
    expect(new Set(p.notes.map((n) => n.at)).size).toBeGreaterThan(100);
        expect(p.notes.map((n) => n.id)).toContain('pad-0001');
    expect(p.notes.map((n) => n.id)).toContain('pad-0200');
  });
  it('a gap one minute wide can hold filler at both ends', () => {
    const s = base();
    s.notes = [{ id: 'n1', at: '2026-01-05T10:00', text: 'first note' }, { id: 'n2', at: '2026-01-05T10:01', text: 'second note' }];
    s.questions = [{ id: 'q', kind: 'recall', after: 'n2', ask: 'x?', must: [['first']] }];
    const times = new Set(padScenario(s, 60, 1).notes.map((n) => n.at));
    expect(times).toEqual(new Set(['2026-01-05T10:00', '2026-01-05T10:01', '2026-01-05T10:00Z', '2026-01-05T10:01Z']));
  });
  it('a scenario that is not valid to begin with cannot be padded', () => {
    const s = base();
    s.title = 5;
    expect(() => padScenario(s, 3)).toThrow('is not valid');
  });
});

describe('safeFiller', () => {
  it('accepts ordinary short words even if the distractor question has them', () => {
    expect(safeFiller(base(), 'The bins are out, so it is done.')).toBe(true);
    expect(safeFiller(base(), 'Not sure when the bins go out.')).toBe(true); // "when" is a question word, not the topic
  });
  it('refuses a stale phrase that is not a must phrase', () => {
    const s = base();
    s.questions[1].stale = ['blue door'];
    expect(safeFiller(s, 'Painted the blue door today.')).toBe(false);
    expect(safeFiller(s, 'Painted the red door today.')).toBe(true);
  });
  it('refuses a phrase of any question and a word of a distractor, accepts plain filler', () => {
    const s = base();
    expect(safeFiller(s, 'Took 1 x tablet B')).toBe(false);
    expect(safeFiller(s, 'Mum had two times Tablet A')).toBe(false); // spelled another way, it is still the phrase
    expect(safeFiller(s, 'Mum had 2 x tablet a')).toBe(false);
    expect(safeFiller(s, 'The optician rang')).toBe(false);
    expect(safeFiller(s, 'Bought bread')).toBe(true);
  });
});

describe('volume pushes the brain past its budget', () => {
  it('300 filler notes make the status context leave out the oldest entries', async () => {
    const run = (pad) => runBrainArm({ lib, controls, scenario: padScenario(base(), pad, 1), fileWith: { label: 'fast', choice: { tier: 'fast' } }, answerWith: [{ label: 'fast', choice: { tier: 'fast' } }], makeClient: () => demoClient(), replace: false });
    const none = await run(0);
    expect(none.answers.every((a) => a.entriesLeftOut === 0)).toBe(true);
    const big = await run(300);
    const now = big.answers.find((a) => a.question === 'q-now');
    expect(now.entriesLeftOut).toBeGreaterThan(0);
    expect(now.entriesUsed + now.entriesLeftOut).toBeGreaterThanOrEqual(303 - 1);
  }, 120000);
});
