import { describe, expect, it } from 'vitest';
import { MAX_TEMPLATE_CHARS, parseTemplate, renderTemplate, type TemplateRules } from './template.js';

const rules = { allowed: ['a', 'b', 'c'], required: ['a'], once: ['c'] };
const parse = (text: unknown, r: TemplateRules = rules) => parseTemplate('f.txt', text, r);
const problemsOf = (text: unknown, r: TemplateRules = rules): readonly string[] => {
  const res = parse(text, r);
  if (res.ok) throw new Error('expected problems');
  return res.problems;
};

describe('parsing', () => {
  it('finds the slots and keeps the text, a final line break dropped', () => {
    const r = parse('x {{a}} y {{b}} z {{a}}\n\n{{c}}\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe('x {{a}} y {{b}} z {{a}}\n\n{{c}}');
    expect(r.value.slots).toEqual(['a', 'b', 'c']);
    expect(Object.isFrozen(r.value) && Object.isFrozen(r.value.parts) && Object.isFrozen(r.value.slots)).toBe(true);
  });

  it('a template with no slots is fine when none is required', () => {
    expect(parse('plain text', { allowed: [] }).ok).toBe(true);
  });

  it('refuses text that is not text, an empty or blank file and an oversized one', () => {
    expect(problemsOf(5)).toEqual(['f.txt: must be text']);
    expect(problemsOf('')).toEqual(['f.txt: is empty']);
    expect(problemsOf('  \n \n')).toEqual(['f.txt: is empty']);
    expect(problemsOf(`{{a}}{{c}}${'x'.repeat(MAX_TEMPLATE_CHARS)}`)[0]).toContain('over the limit');
    expect(parse(`{{a}}{{c}}${'x'.repeat(MAX_TEMPLATE_CHARS - 10)}`).ok).toBe(true);
    expect(problemsOf(`{{a}}{{c}}${'x'.repeat(MAX_TEMPLATE_CHARS - 9)}`)[0]).toContain('over the limit');
  });

  it('refuses an unknown slot, naming it, the line and what is allowed', () => {
    expect(problemsOf('{{a}}{{c}}\nline two {{zzz}}')).toEqual(['f.txt: line 2: unknown slot "zzz" (this file may use: a, b, c)']);
  });

  it('slot names are case sensitive and need a letter first', () => {
    expect(problemsOf('{{a}}{{c}} {{A}}')[0]).toContain('unknown slot "A"');
    expect(problemsOf('{{a}}{{c}} {{1x}}')[0]).toContain('stray');
  });

  it('refuses a stray brace pair, with its line', () => {
    expect(problemsOf('{{a}}{{c}}\n\n{{ a }}')).toEqual(['f.txt: line 3: stray "{{" (a slot is written {{name}} with a letter first and letters or digits after)']);
    expect(problemsOf('{{a}}{{c}} }}')[0]).toContain('stray "}}"');
    expect(problemsOf('{{a}}{{c}} {{a}}}}')[0]).toContain('stray "}}"');
    expect(parse('{{a}}{{c}} one { brace } is fine').ok).toBe(true);
    expect(parse('{{a}}{{c}} {{{b}}}').ok).toBe(true);
  });

  it('refuses control characters except line breaks and tabs, naming the line', () => {
    expect(problemsOf(`{{a}}{{c}}\nbad${String.fromCharCode(7)}`)).toEqual(['f.txt: line 2: contains a control character (only line breaks and tabs are allowed)']);
    expect(problemsOf(`{{a}}{{c}}\r\n`)[0]).toContain('control character');
    expect(parse('{{a}}{{c}}\tindent').ok).toBe(true);
  });

  it('a required slot must be present, and a once slot exactly once', () => {
    expect(problemsOf('{{c}}')).toEqual(['f.txt: the required slot {{a}} is missing']);
    expect(problemsOf('{{a}}')).toEqual(['f.txt: the required slot {{c}} is missing']);
    expect(problemsOf('{{a}}{{c}}{{c}}')).toEqual(['f.txt: the slot {{c}} must appear exactly once, not 2 times']);
  });

  it('lists every problem at once', () => {
    const p = problemsOf('{{q}} {{ x }}');
    expect(p.length).toBe(4); // unknown slot, stray, two missing
  });

  it('a long unknown slot name is cut in the message', () => {
    expect(problemsOf(`{{a}}{{c}}{{${'z'.repeat(60)}}}`)[0]).toContain('…');
  });
});

describe('rendering', () => {
  const t = (text: string) => {
    const r = parse(text);
    if (!r.ok) throw new Error(r.problems.join());
    return r.value;
  };

  it('fills each slot with its value, as many times as it is used', () => {
    expect(renderTemplate(t('[{{a}}] {{b}} [{{a}}] {{c}}'), { a: '1', b: '2', c: '3' })).toBe('[1] 2 [1] 3');
  });

  it('inserts a value as it is and never reads it for slots', () => {
    expect(renderTemplate(t('{{a}} / {{b}} / {{c}}'), { a: '{{b}}', b: '{{a}}{{c}}', c: '{{{{' })).toBe('{{b}} / {{a}}{{c}} / {{{{');
    expect(renderTemplate(t('{{a}}{{c}}'), { a: '$&$1$`', c: '$$' })).toBe('$&$1$`$$');
  });

  it('is deterministic and does not change its arguments', () => {
    const tpl = t('{{a}}{{c}}');
    const values = Object.freeze({ a: 'x', c: 'y' });
    expect(renderTemplate(tpl, values)).toBe(renderTemplate(tpl, values));
  });

  it('a missing value is a coding mistake that throws, naming the slot; only own values count', () => {
    expect(() => renderTemplate(t('{{a}}{{c}}'), { a: 'x' })).toThrow('{{c}}');
    expect(() => renderTemplate(t('{{a}}{{c}}'), Object.create({ a: 'x', c: 'y' }) as Record<string, string>)).toThrow(TypeError);
    expect(() => renderTemplate(t('{{a}}{{c}}'), { a: 'x', c: 5 as never })).toThrow(TypeError);
  });

  it('a slot called like an object property is not read from the prototype', () => {
    const r = parseTemplate('f', '{{toString}}', { allowed: ['toString'] });
    if (!r.ok) throw new Error('parse');
    expect(() => renderTemplate(r.value, {})).toThrow(TypeError);
  });
});
