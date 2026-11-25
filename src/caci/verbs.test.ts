import { describe, expect, it } from 'vitest';
import { defaultVerbs, parseVerbs } from './verbs.js';

const file = (verbs: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ verbs, ...extra });
const good = { name: 'pay', effect: 'clear', help: 'Mark this as paid.' };
const problems = (text: string): readonly string[] => {
  const r = parseVerbs(text);
  if (r.ok) throw new Error('expected problems');
  return r.error;
};

describe('parsing the verbs file (R-025 D9)', () => {
  it('reads a good file in order and looks verbs up by name', () => {
    const r = parseVerbs(file([good, { name: 'remove-all', effect: 'remove', help: ' Remove it. ' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.list.map((v) => v.name)).toEqual(['pay', 'remove-all']);
    expect(r.value.get('remove-all')).toEqual({ name: 'remove-all', effect: 'remove', help: 'Remove it.' });
    expect(r.value.get('nope')).toBeUndefined();
    expect(r.value.get('__proto__')).toBeUndefined();
    expect(r.value.get('constructor')).toBeUndefined();
  });

  it('the shipped three verbs match the default vocabulary', async () => {
    const { readFileSync } = await import('node:fs');
    const r = parseVerbs(readFileSync(new URL('../../controls/verbs.json', import.meta.url), 'utf8'));
    expect(r.ok && r.value.list).toEqual(defaultVerbs().list);
    expect(defaultVerbs().list.map((v) => [v.name, v.effect])).toEqual([['clear', 'clear'], ['pay', 'clear'], ['remove', 'remove']]);
  });

  it('refuses text that is not JSON or not an object, naming the file', () => {
    expect(problems('{')).toEqual(['verbs.json: is not valid JSON']);
    expect(problems('[]')).toEqual(['verbs.json: must be an object with a "verbs" list']);
    expect(problems('null')).toEqual(['verbs.json: must be an object with a "verbs" list']);
    expect(problems('{}')).toEqual(['verbs.json: "verbs" must be a list']);
    expect(problems('{"verbs":"x"}')).toEqual(['verbs.json: "verbs" must be a list']);
  });

  it('refuses an empty list, too many verbs and unknown fields by name', () => {
    expect(problems(file([]))).toEqual(['verbs.json: "verbs" must not be empty']);
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, effect: 'clear', help: 'x' }));
    expect(problems(file(many))).toEqual(['verbs.json: 21 verbs, over the limit of 20']);
    expect(problems(file([good], { extra: 1 }))).toEqual(['verbs.json: unknown field "extra"']);
    expect(problems(file([{ ...good, undo: true }]))).toEqual(['verbs.json: verb 1: unknown field "undo"']);
  });

  it('refuses a bad name, effect or help and reports every problem at once', () => {
    for (const name of ['', 'Pay', 'pay now', 'a'.repeat(21), '/pay', 'pay_', 7, null]) {
      expect(problems(file([{ ...good, name }]))[0]).toContain('"name" must be 1 to 20 characters');
    }
    for (const effect of ['delete', 'Clear', '', 1, undefined]) {
      expect(problems(file([{ ...good, effect }]))[0]).toContain('"effect" must be "clear" or "remove"');
    }
    for (const help of ['', '   ', 'two\nlines', 'x'.repeat(81), 5, 'bell\u0007']) {
      expect(problems(file([{ ...good, help }]))[0]).toContain('"help" must be one line');
    }
    expect(problems(file([{ name: 'A', effect: 'x', help: '' }, 5])).length).toBe(4);
  });

  it('refuses a name used twice and a verb that is not an object', () => {
    expect(problems(file([good, good]))).toEqual(['verbs.json: verb 2: the name "pay" is used twice']);
    expect(problems(file([good, 'pay']))).toEqual(['verbs.json: verb 2 must be an object']);
  });

  it('accepts exactly 20 characters in a name and 80 in a help line', () => {
    expect(parseVerbs(file([{ name: 'a'.repeat(20), effect: 'clear', help: 'x'.repeat(80) }])).ok).toBe(true);
  });
});
