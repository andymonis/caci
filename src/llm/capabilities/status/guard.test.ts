import { describe, expect, it } from 'vitest';
import { guardStatusReply, inspectStatusReply } from './guard.js';

const json = (value: unknown) => ({ kind: 'json', value }) as never;
const text = (t: string) => ({ kind: 'text', text: t }) as never;
const GOOD = { headline: 'A quiet day, with a dentist visit tomorrow.', points: [{ text: 'Dentist on Friday at 9.', refs: [1] }, { text: 'Mum has new tablets, one a day with food.', refs: [2, 3] }], nothing: false };
const run = (reply: unknown, entryCount = 3) => inspectStatusReply(json(reply), { entryCount });
const problems = (reply: unknown, entryCount = 3): readonly string[] => {
  const r = run(reply, entryCount);
  expect(r.ok, JSON.stringify(reply)).toBe(false);
  return r.ok ? [] : r.error;
};

describe('a reply that is accepted', () => {
  it('a good one, as JSON or as text, comes back trimmed and read-only in shape', () => {
    const r = run({ ...GOOD, headline: '  A quiet day.  ' });
    expect(r).toEqual({ ok: true, value: { headline: 'A quiet day.', points: GOOD.points, nothing: false } });
    const t = inspectStatusReply(text(JSON.stringify(GOOD)), { entryCount: 3 });
    expect(t.ok && t.value.points).toHaveLength(2);
  });
  it('"nothing" with an empty list, and "nothing" left out of a reply that has points', () => {
    expect(run({ headline: 'Nothing relevant.', points: [], nothing: true })).toMatchObject({ ok: true, value: { nothing: true, points: [] } });
    expect(run({ headline: 'x', points: [{ text: 'y', refs: [1] }] })).toMatchObject({ ok: true, value: { nothing: false } });
  });
  it('the limits themselves are fine: 160 characters, 5 points of 240, 5 refs, entry numbers 1 and the count', () => {
    const r = run({ headline: 'h'.repeat(160), points: Array.from({ length: 5 }, () => ({ text: 't'.repeat(240), refs: [1, 2, 3, 4, 5] })) }, 5);
    expect(r.ok).toBe(true);
    expect(run({ headline: 'x', points: [{ text: 'y', refs: [3] }] }, 3).ok).toBe(true);
  });
  it('characters are counted as characters, not code units', () => {
    expect(run({ headline: '😀'.repeat(160), points: [{ text: '😀'.repeat(240), refs: [1] }] }).ok).toBe(true);
    expect(problems({ headline: '😀'.repeat(161), points: [{ text: 'y', refs: [1] }] }).join()).toContain('161 characters');
  });
});

describe('a reply that is refused, with every problem listed', () => {
  it('prose, a code fence, an array, a number, nothing', () => {
    for (const raw of ['all is well', '```json\n{}\n```', '[1]', '7', '']) {
      const r = inspectStatusReply(text(raw), { entryCount: 3 });
      expect(r.ok, raw).toBe(false);
    }
    expect(problems([GOOD]).join()).toContain('must be a JSON object');
    expect(problems(null).join()).toContain('must be a JSON object');
  });
  it('a reply longer than the limit is refused before it is parsed', () => {
    const r = inspectStatusReply(text(`{"headline":"${'x'.repeat(9000)}"}`), { entryCount: 3 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error[0]).toContain('over the limit of 8000');
    expect(inspectStatusReply(text(JSON.stringify(GOOD)), { entryCount: 3 }, { maxOutputChars: 20 }).ok).toBe(false);
  });
  it('an unknown field anywhere, naming it', () => {
    expect(problems({ ...GOOD, sources: [] }).join()).toContain('unknown field "sources"');
    expect(problems({ ...GOOD, points: [{ text: 'a', refs: [1], link: 'x' }] }).join()).toContain('points[0]: unknown field "link"');
  });
  it('a missing, empty, blank, over-long or multi-line headline', () => {
    expect(problems({ points: GOOD.points }).join()).toContain('headline: must be text');
    expect(problems({ ...GOOD, headline: '' }).join()).toContain('headline: must not be empty');
    expect(problems({ ...GOOD, headline: '   ' }).join()).toContain('headline: must not be empty');
    expect(problems({ ...GOOD, headline: 'h'.repeat(161) }).join()).toContain('161 characters, over the limit of 160');
    expect(problems({ ...GOOD, headline: 'one\ntwo' }).join()).toContain('one line of plain text');
    expect(problems({ ...GOOD, headline: 'bell\u0007' }).join()).toContain('one line of plain text');
    expect(problems({ ...GOOD, headline: 7 }).join()).toContain('headline: must be text');
  });
  it('points that are not a list, too many, not objects, or with bad text', () => {
    expect(problems({ headline: 'x', points: 'many' }).join()).toContain('points: must be a list');
    expect(problems({ headline: 'x' }).join()).toContain('points: must be a list');
    expect(problems({ headline: 'x', points: Array.from({ length: 6 }, () => ({ text: 'a', refs: [1] })) }).join()).toContain('6 points, over the limit of 5');
    expect(problems({ headline: 'x', points: ['a'] }).join()).toContain('points[0]: must be an object');
    expect(problems({ headline: 'x', points: [{ text: '', refs: [1] }] }).join()).toContain('points[0].text: must not be empty');
    expect(problems({ headline: 'x', points: [{ text: 't'.repeat(241), refs: [1] }] }).join()).toContain('points[0].text: 241 characters');
    expect(problems({ headline: 'x', points: [{ refs: [1] }] }).join()).toContain('points[0].text: must be text');
  });
  it('references that are missing, empty, too many, outside the entries, not whole numbers or repeated', () => {
    const at = (refs: unknown, n = 3) => problems({ headline: 'x', points: [{ text: 'a', refs }] }, n).join();
    expect(at(undefined)).toContain('refs: must be a list of 1 to 5');
    expect(at([])).toContain('refs: must be a list of 1 to 5');
    expect(at('1')).toContain('refs: must be a list');
    expect(at([1, 2, 3, 4, 5, 6], 9)).toContain('6 numbers, over the limit of 5');
    expect(at([4])).toContain('4 is not an entry number (the entries are numbered 1 to 3)');
    expect(at([0])).toContain('0 is not an entry number');
    expect(at([-1])).toContain('-1 is not an entry number');
    expect(at([1.5])).toContain('1.5 is not an entry number');
    expect(at(['1'])).toContain('"1" is not an entry number');
    expect(at([null])).toContain('null is not an entry number');
    expect(at([1, 1])).toContain('each entry number may appear once');
    expect(at([1], 0)).toContain('is not an entry number (the entries are numbered 1 to 0)');
  });
  it('"nothing" that contradicts the points, or is not a boolean, or points missing without it', () => {
    expect(problems({ headline: 'x', points: GOOD.points, nothing: true }).join()).toContain('nothing: true cannot be combined with points');
    expect(problems({ headline: 'x', points: [], nothing: false }).join()).toContain('must have at least one point, or set nothing to true');
    expect(problems({ headline: 'x', points: [] }).join()).toContain('must have at least one point');
    expect(problems({ headline: 'x', points: [], nothing: 'yes' }).join()).toContain('nothing: must be true or false');
  });
  it('lists every problem at once, so one repair can fix them together', () => {
    const p = problems({ headline: '', points: [{ text: '', refs: [9] }], extra: 1, nothing: true }, 3);
    expect(p.length).toBeGreaterThanOrEqual(5);
  });
  it('accepts nothing it cannot read: a throwing getter or a hostile object is a refusal, not a crash', () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, 'headline', { get() { throw new Error('boom'); }, enumerable: true });
    const r = run(hostile);
    expect(r.ok).toBe(false);
  });
});

describe('the error form', () => {
  it('is a BAD_OUTPUT whose message numbers the problems and says how many more', () => {
    const r = guardStatusReply(json({ headline: '', points: [{ text: '', refs: [9] }, { text: '', refs: [9] }, { text: '', refs: [9] }], extra: 1 }), { entryCount: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BAD_OUTPUT');
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain('(1)');
      expect(r.error.message).toMatch(/\(and \d+ more\)/);
    }
    expect(guardStatusReply(json(GOOD), { entryCount: 3 }).ok).toBe(true);
  });
});
