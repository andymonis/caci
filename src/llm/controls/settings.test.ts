import { describe, expect, it } from 'vitest';
import { validFiles } from './fixtures.test-util.js';
import { parseCategoriseSettings, parseStatusSettings } from './settings.js';

const cat = (change: (o: Record<string, any>) => void = () => {}): string => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = JSON.parse(validFiles()['categorise/settings.json'] as string);
  change(o);
  return JSON.stringify(o);
};
const sta = (change: (o: Record<string, any>) => void = () => {}): string => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = JSON.parse(validFiles()['status/settings.json'] as string);
  change(o);
  return JSON.stringify(o);
};
const problems = (r: { ok: boolean; problems?: readonly string[] }): readonly string[] => (r.ok ? [] : (r.problems as readonly string[]));

describe('categorise settings: facts (R-015)', () => {
  it('maxFacts and keyMaxChars are whole numbers in range', () => {
    for (const [name, lo, hi] of [['maxFacts', 1, 20], ['keyMaxChars', 1, 200]] as const) {
      expect(parseCategoriseSettings('c.json', cat((o) => { o.maxOps = 100; o.maxDataBytes = 8000; o[name] = lo; })).ok, `${name} ${lo}`).toBe(true);
      expect(parseCategoriseSettings('c.json', cat((o) => { o.maxOps = 100; o.maxDataBytes = 8000; o.maxOutputChars = 100_000; o[name] = hi; })).ok, `${name} ${hi}`).toBe(true);
      expect(problems(parseCategoriseSettings('c.json', cat((o) => (o[name] = lo - 1))))[0], name).toContain('outside');
      expect(problems(parseCategoriseSettings('c.json', cat((o) => (o[name] = hi + 1))))[0], name).toContain('outside');
      expect(problems(parseCategoriseSettings('c.json', cat((o) => { Reflect.deleteProperty(o, name); })))[0]).toContain(`"${name}" is missing`);
    }
  });
  it('the key needs a description, and an unknown description is still refused', () => {
    expect(problems(parseCategoriseSettings('c.json', cat((o) => delete o.descriptions.key)))[0]).toContain('descriptions."key" must be text');
  });
  it('each fact needs an item and a link, so maxOps must be at least twice maxFacts', () => {
    expect(parseCategoriseSettings('c.json', cat((o) => { o.maxFacts = 4; o.maxOps = 8; })).ok).toBe(true);
    const bad = problems(parseCategoriseSettings('c.json', cat((o) => { o.maxFacts = 4; o.maxOps = 7; })));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('at least 8');
  });
  it('maxDataBytes must hold a title, summary and key of the allowed lengths, exactly', () => {
    const need = 4 * (120 + 300 + 80) + 96;
    expect(parseCategoriseSettings('c.json', cat((o) => (o.maxDataBytes = need))).ok).toBe(true);
    const bad = problems(parseCategoriseSettings('c.json', cat((o) => (o.maxDataBytes = need - 1))));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('title, summary and key');
    expect(bad[0]).toContain(`at least ${need}`);
  });
  it('maxOutputChars must hold maxFacts facts, exactly', () => {
    const need = 3 * (120 + 300 + 80 + 400);
    expect(parseCategoriseSettings('c.json', cat((o) => { o.maxFacts = 3; o.maxOutputChars = need; })).ok).toBe(true);
    const bad = problems(parseCategoriseSettings('c.json', cat((o) => { o.maxFacts = 3; o.maxOutputChars = need - 1; })));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(`at least ${need}`);
  });
});

describe('categorise settings', () => {
  it('accept the shipped numbers and freeze them', () => {
    const r = parseCategoriseSettings('c.json', cat());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.maxOps).toBe(25);
      expect(r.value.maxFacts).toBe(1);
      expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.descriptions)).toBe(true);
    }
  });

  it.each([
    ['maxOps', 0], ['maxOps', 101], ['maxTextChars', 0], ['maxTextChars', 100_001], ['maxContextChars', 0], ['maxDataBytes', 63], ['maxDataBytes', 65_537],
    ['maxIdLength', 7], ['maxIdLength', 257], ['maxOutputChars', 999], ['maxOutputChars', 200_001], ['maxRationaleChars', 0], ['maxRationaleChars', 2001], ['maxReplaces', -1], ['maxReplaces', 21],
    ['titleMaxChars', 0], ['titleMaxChars', 501], ['summaryMaxChars', 1001], ['categoryNameMaxChars', 201],
  ] as const)('%s = %s is outside its range', (name, value) => {
    const r = parseCategoriseSettings('c.json', cat((o) => { o[name] = value; if (name === 'maxDataBytes') o.maxDataBytes = value; }));
    expect(problems(r).some((p) => p.includes(`"${name}"`))).toBe(true);
  });

  it('the range edges themselves are accepted', () => {
    expect(parseCategoriseSettings('c.json', cat((o) => { o.maxOps = 100; o.maxIdLength = 8; o.maxRationaleChars = 2000; o.maxReplaces = 20; o.titleMaxChars = 1; o.summaryMaxChars = 1; o.categoryNameMaxChars = 1; o.maxDataBytes = 65_536; })).ok).toBe(true);
  });

  it('refuses a missing, fractional or non-number value, naming it', () => {
    expect(problems(parseCategoriseSettings('c.json', cat((o) => delete o.maxOps)))).toEqual(['c.json: "maxOps" is missing']);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.maxOps = 2.5))))).toEqual(['c.json: "maxOps" must be a whole number']);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.maxOps = '25'))))).toEqual(['c.json: "maxOps" must be a whole number']);
  });

  it('refuses unknown settings and unknown descriptions, and bad descriptions', () => {
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.extra = 1))))).toEqual(['c.json: unknown setting "extra"']);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.descriptions.extra = 'x'))))[0]).toContain('unknown entry "extra"');
    expect(problems(parseCategoriseSettings('c.json', cat((o) => delete o.descriptions.name)))[0]).toContain('descriptions."name" must be text');
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.descriptions.title = '   '))))[0]).toContain('1 to 300');
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.descriptions.title = 'x'.repeat(301)))))[0]).toContain('1 to 300');
    expect(parseCategoriseSettings('c.json', cat((o) => (o.descriptions.title = 'x'.repeat(300)))).ok).toBe(true);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.descriptions.title = 'a\nb'))))[0]).toContain('control characters');
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.descriptions = 'x'))))[0]).toContain('"descriptions" must be an object');
  });

  it('refuses text that is not an object of JSON', () => {
    expect(problems(parseCategoriseSettings('c.json', 5))).toEqual(['c.json: must be text']);
    expect(problems(parseCategoriseSettings('c.json', '{not json'))).toEqual(['c.json: is not valid JSON']);
    expect(problems(parseCategoriseSettings('c.json', '[1]'))).toEqual(['c.json: must be a JSON object']);
    expect(problems(parseCategoriseSettings('c.json', `{"a":"${'x'.repeat(16_001)}"}`))[0]).toContain('over the limit');
    expect(parseCategoriseSettings('c.json', cat() + ' '.repeat(16_000 - cat().length)).ok).toBe(true);
    expect(problems(parseCategoriseSettings('c.json', cat() + ' '.repeat(16_001 - cat().length)))[0]).toContain('over the limit');
  });

  it('checks the data size can hold the allowed title, summary and name', () => {
    expect(problems(parseCategoriseSettings('c.json', cat((o) => (o.maxDataBytes = 1000))))[0]).toContain('title and summary');
    expect(parseCategoriseSettings('c.json', cat((o) => (o.maxDataBytes = 4 * 500 + 96))).ok).toBe(true);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => { o.maxDataBytes = 4 * 500 + 95; }))).length).toBe(1);
    expect(problems(parseCategoriseSettings('c.json', cat((o) => { o.titleMaxChars = 1; o.summaryMaxChars = 1; o.categoryNameMaxChars = 200; o.maxDataBytes = 200; }))).some((p) => p.includes('category name'))).toBe(true);
  });

  it('lists every problem at once', () => {
    expect(problems(parseCategoriseSettings('c.json', cat((o) => { o.maxOps = 0; o.maxTextChars = 0; o.extra = 1; }))).length).toBe(3);
  });
});

describe('status settings', () => {
  it('accept the shipped numbers', () => {
    const r = parseStatusSettings('s.json', sta());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maxPoints).toBe(5);
  });

  it.each([
    ['maxHeadline', 0], ['maxHeadline', 501], ['maxPoints', 0], ['maxPoints', 21], ['maxPointChars', 0], ['maxPointChars', 1001], ['maxRefs', 0], ['maxRefs', 21],
    ['maxRequestChars', 0], ['maxRequestChars', 5001], ['maxEntries', 0], ['maxEntries', 2001], ['maxEntryChars', 0], ['maxEntryChars', 10_001],
    ['maxTotalChars', 0], ['maxTotalChars', 200_001], ['maxOutputChars', 499], ['maxOutputChars', 100_001],
  ] as const)('%s = %s is outside its range', (name, value) => {
    const r = parseStatusSettings('s.json', sta((o) => (o[name] = value)));
    expect(problems(r).some((p) => p.includes(`"${name}"`))).toBe(true);
  });

  it('the range edges themselves are accepted', () => {
    expect(parseStatusSettings('s.json', sta((o) => { o.maxHeadline = 1; o.maxPoints = 1; o.maxPointChars = 1; o.maxRefs = 1; o.maxRequestChars = 5000; o.maxEntries = 2000; o.maxEntryChars = 1; o.maxTotalChars = 200_000; o.maxOutputChars = 500; })).ok).toBe(true);
  });

  it('the reply limit must hold the longest reply the other limits allow', () => {
    const need = 160 + 5 * (240 + 60 + 30) + 100;
    expect(parseStatusSettings('s.json', sta((o) => (o.maxOutputChars = need))).ok).toBe(true);
    expect(problems(parseStatusSettings('s.json', sta((o) => (o.maxOutputChars = need - 1))))[0]).toContain('needs at least');
  });

  it('an entry may not be longer than the total, nor may references exceed the entries', () => {
    expect(problems(parseStatusSettings('s.json', sta((o) => { o.maxEntryChars = 2000; o.maxTotalChars = 1999; })))[0]).toContain('"maxEntryChars"');
    expect(parseStatusSettings('s.json', sta((o) => { o.maxEntryChars = 2000; o.maxTotalChars = 2000; })).ok).toBe(true);
    expect(problems(parseStatusSettings('s.json', sta((o) => { o.maxRefs = 6; o.maxEntries = 5; })))[0]).toContain('"maxRefs"');
    expect(parseStatusSettings('s.json', sta((o) => { o.maxRefs = 5; o.maxEntries = 5; })).ok).toBe(true);
  });

  it('checks the descriptions like the other capability', () => {
    expect(problems(parseStatusSettings('s.json', sta((o) => delete o.descriptions.refs)))[0]).toContain('descriptions."refs"');
    expect(problems(parseStatusSettings('s.json', sta((o) => (o.descriptions.nothing = ''))))[0]).toContain('1 to 300');
    expect(problems(parseStatusSettings('s.json', sta((o) => (o.unknown = 1))))).toEqual(['s.json: unknown setting "unknown"']);
    expect(problems(parseStatusSettings('s.json', 'x'))).toEqual(['s.json: is not valid JSON']);
  });
});
