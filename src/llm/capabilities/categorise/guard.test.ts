import { describe, expect, it } from 'vitest';
import type { ModelOutput } from '../../model-client.js';
import { DEFAULT_GUARD_OPTIONS, guardReply, type GuardContext, type GuardOptions } from './guard.js';

const CONTEXT: GuardContext = { graphId: 'my-notes', itemId: 'note-1', requestId: 'req-7' };
const ITEM = { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Dr X visit', summary: 'Follow up on blood test.' } };
const CATEGORY = { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } };
const LINK = { op: 'link', item: 'note-1', category: 'doctor-x', weight: 0.9 };
const GOOD = { ops: [ITEM, CATEGORY, LINK], rationale: 'It is about a doctor.' };

const json = (value: unknown): ModelOutput => ({ kind: 'json', value: value as never });
const text = (value: string): ModelOutput => ({ kind: 'text', text: value });
const guard = (output: ModelOutput, options?: GuardOptions, context: GuardContext = CONTEXT) => guardReply(output, context, options);
const message = (output: ModelOutput, options?: GuardOptions): string => {
  const r = guard(output, options);
  if (r.ok) throw new Error('expected a rejection');
  return r.error.message;
};

describe('a good reply', () => {
  it('becomes a mutation with the controller\'s values and the model\'s rationale', () => {
    const r = guard(json(GOOD));
    expect(r.ok && r.value).toEqual({
      mutation: {
        version: 1,
        kind: 'mutation',
        graphId: 'my-notes',
        requestId: 'req-7',
        createIfMissing: false,
        ops: [
          { ...ITEM, mode: 'merge' },
          { ...CATEGORY, mode: 'merge' },
          { ...LINK, ensureNodes: false },
        ],
      },
      rationale: 'It is about a doctor.',
    });
  });

  it('reads the same reply as text', () => {
    expect(guard(text(JSON.stringify(GOOD)))).toEqual(guard(json(GOOD)));
    expect(guard(text(`  \n${JSON.stringify(GOOD)}\n `)).ok).toBe(true); // surrounding whitespace is fine
  });

  it('leaves out requestId when there is none, and the rationale when it is blank or missing', () => {
    const r = guard(json({ ops: GOOD.ops, rationale: '   ' }), undefined, { graphId: 'g', itemId: 'note-1' });
    expect(r.ok && r.value).not.toHaveProperty('rationale');
    expect(r.ok && r.value.mutation).not.toHaveProperty('requestId');
    const none = guard(json({ ops: GOOD.ops }));
    expect(none.ok && none.value).not.toHaveProperty('rationale');
  });

  it('trims the rationale', () => {
    const r = guard(json({ ops: GOOD.ops, rationale: '  because  \n' }));
    expect(r.ok && r.value.rationale).toBe('because');
  });

  it('accepts a link to an existing category with no new category and no weight', () => {
    expect(guard(json({ ops: [ITEM, { op: 'link', item: 'note-1', category: 'old-one' }] })).ok).toBe(true);
  });

  it('does not change the reply it was given', () => {
    const reply = structuredClone(GOOD);
    const frozen = JSON.stringify(reply);
    guard(json(reply));
    expect(JSON.stringify(reply)).toBe(frozen);
  });
});

describe('what the model cannot choose', () => {
  it('forces the graph, request and createIfMissing, whatever the reply says', () => {
    for (const extra of [{ graphId: 'someone-elses' }, { requestId: 'mine' }, { createIfMissing: true }, { version: 2 }, { kind: 'query' }]) {
      const m = message(json({ ...GOOD, ...extra }));
      expect(m).toContain(`"${Object.keys(extra)[0]}" is set by the system`);
    }
  });

  it('refuses mode and ensureNodes on operations, and says the system sets them', () => {
    expect(message(json({ ops: [{ ...ITEM, mode: 'replace' }, LINK] }))).toContain('ops[0]: "mode" is set by the system');
    expect(message(json({ ops: [ITEM, { ...LINK, ensureNodes: true }] }))).toContain('ops[1]: "ensureNodes" is set by the system');
    expect(message(json({ ops: [ITEM, { ...LINK, ensureNodes: false }] }))).toContain('"ensureNodes"');
  });

  it('never creates the graph', () => {
    const r = guard(json(GOOD));
    expect(r.ok && r.value.mutation.createIfMissing).toBe(false);
  });
});

describe('operations that are not allowed', () => {
  it.each([
    ['deleteNode', { op: 'deleteNode', partition: 'item', id: 'note-1' }],
    ['unlink', { op: 'unlink', item: 'note-1', category: 'doctor-x' }],
    ['an unknown operation', { op: 'dropGraph', graphId: 'my-notes' }],
    ['no operation name', { partition: 'item', id: 'note-1' }],
    ['an operation name of the wrong type', { op: 5 }],
    ['a prototype-style name', { op: 'constructor' }],
    ['an operation that is not an object', 'upsertNode'],
    ['null', null],
  ])('%s hides inside an otherwise good reply and rejects all of it', (_n, bad) => {
    const r = guard(json({ ops: [ITEM, LINK, bad] }));
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT', retryable: false } });
    expect(message(json({ ops: [ITEM, LINK, bad] }))).toMatch(/ops\[2\]/);
  });

  it('lists what is allowed', () => {
    expect(message(json({ ops: [ITEM, LINK, { op: 'deleteNode' }] }))).toContain('allowed: upsertNode, link');
  });
});

describe('the note\'s item id belongs to the controller', () => {
  it('rejects an item with another id (including one that would overwrite someone else\'s note)', () => {
    expect(message(json({ ops: [{ ...ITEM, id: 'note-2' }, LINK] }))).toContain('the note\'s item id must be exactly "note-1"');
  });

  it('rejects a link from another item', () => {
    expect(message(json({ ops: [ITEM, { ...LINK, item: 'note-2' }] }))).toContain('a link\'s item must be exactly "note-1"');
  });

  it('is exact: case and spacing matter', () => {
    for (const id of ['Note-1', 'note-1 ', ' note-1', 'note-1\n']) expect(guard(json({ ops: [{ ...ITEM, id }, LINK] })).ok).toBe(false);
  });

  it('needs exactly one item and at least one link', () => {
    expect(message(json({ ops: [LINK] }))).toContain('exactly one upsertNode for the note\'s item, found 0');
    expect(message(json({ ops: [ITEM, ITEM, LINK] }))).toContain('found 2');
    expect(message(json({ ops: [ITEM, CATEGORY] }))).toContain('at least one link');
  });

  it('a bad partition is named', () => {
    expect(message(json({ ops: [{ ...ITEM, partition: 'items' }, LINK] }))).toContain('partition must be "item" or "category"');
  });
});

describe('malformed replies', () => {
  const cases: Array<[string, ModelOutput]> = [
    ['prose around the JSON', text(`Sure! Here you go:\n${JSON.stringify(GOOD)}\nHope that helps.`)],
    ['a code fence', text('```json\n' + JSON.stringify(GOOD) + '\n```')],
    ['two objects', text(JSON.stringify(GOOD) + JSON.stringify(GOOD))],
    ['truncated JSON', text(JSON.stringify(GOOD).slice(0, 40))],
    ['empty text', text('')],
    ['plain prose', text('I cannot do that.')],
    ['a JSON string', json('ops')],
    ['a JSON number', json(3)],
    ['null', json(null)],
    ['a list', json([ITEM, LINK])],
    ['text that is a list', text(JSON.stringify([ITEM, LINK]))],
    ['no ops', json({ rationale: 'x' })],
    ['ops that is not a list', json({ ops: ITEM })],
    ['ops as text', json({ ops: 'upsertNode' })],
    ['an empty list', json({ ops: [] })],
    ['an extra key', json({ ...GOOD, notes: 'hi' })],
    ['a prototype key', text('{"ops":' + JSON.stringify(GOOD.ops) + ',"__proto__":{"admin":true}}')],
    ['a rationale that is not text', json({ ...GOOD, rationale: 5 })],
    ['a rationale that is too long', json({ ...GOOD, rationale: 'x'.repeat(501) })],
    ['an extra field on an op', json({ ops: [{ ...ITEM, color: 'red' }, LINK] })],
    ['a wrong type for an id', json({ ops: [ITEM, { ...LINK, category: 5 }] })],
    ['an empty category id', json({ ops: [ITEM, { ...LINK, category: '' }] })],
    ['data that is not an object', json({ ops: [{ ...ITEM, data: 'a title' }, LINK] })],
    ['data that is a list', json({ ops: [{ ...ITEM, data: [1] }, LINK] })],
    ['a weight above 1', json({ ops: [ITEM, { ...LINK, weight: 1.5 }] })],
    ['a negative weight', json({ ops: [ITEM, { ...LINK, weight: -0.1 }] })],
    ['a weight that is text', json({ ops: [ITEM, { ...LINK, weight: '0.5' }] })],
  ];

  it.each(cases)('%s is rejected as BAD_OUTPUT with a reason', (_n, output) => {
    const r = guard(output);
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT', retryable: false } });
    if (!r.ok) expect(r.error.message).toMatch(/^The reply was not accepted: \(1\) .{10,}/);
  });

  it('a weight of exactly 0 and exactly 1 is fine', () => {
    expect(guard(json({ ops: [ITEM, { ...LINK, weight: 0 }] })).ok).toBe(true);
    expect(guard(json({ ops: [ITEM, { ...LINK, weight: 1 }] })).ok).toBe(true);
  });

  it('a prototype key does not pollute anything', () => {
    guard(text('{"ops":[],"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('an empty list', () => {
  it('says so directly', () => {
    expect(message(json({ ops: [] }))).toBe('The reply was not accepted: (1) ops: must contain at least one operation');
  });
});

describe('size limits', () => {
  const manyLinks = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'link', item: 'note-1', category: `c${i}` }));

  it('allows exactly the operation limit and rejects one more', () => {
    expect(guard(json({ ops: [ITEM, ...manyLinks(24)] })).ok).toBe(true);
    expect(message(json({ ops: [ITEM, ...manyLinks(25)] }))).toContain('26 operations, over the limit of 25');
  });

  it('uses the limit it is given', () => {
    expect(message(json({ ops: [ITEM, ...manyLinks(3)] }), { maxOps: 3 })).toContain('over the limit of 3');
    expect(guard(json({ ops: [ITEM, ...manyLinks(2)] }), { maxOps: 3 }).ok).toBe(true);
  });

  it('caps data tighter than the library does', () => {
    const big = (n: number) => ({ ops: [{ ...ITEM, data: { title: 'x'.repeat(n) } }, LINK] });
    expect(guard(json(big(2000))).ok).toBe(true);
    expect(guard(json(big(2100))).ok).toBe(false);
    expect(guard(json(big(2100)), { maxDataBytes: 4096 }).ok).toBe(true);
  });

  it('measures data in bytes, not characters', () => {
    const wide = { ops: [{ ...ITEM, data: { title: '😀'.repeat(400) } }, LINK] }; // 1600 bytes + overhead
    expect(guard(json(wide), { maxDataBytes: 1000 }).ok).toBe(false);
    expect(guard(json(wide)).ok).toBe(true);
  });

  it('a link carries no data at all (the model is not offered it)', () => {
    expect(message(json({ ops: [ITEM, { ...LINK, data: { why: 'x' } }] }))).toContain('ops[1]: unknown field "data"');
  });

  it('caps id length', () => {
    expect(guard(json({ ops: [ITEM, { ...LINK, category: 'c'.repeat(128) }] })).ok).toBe(true);
    expect(guard(json({ ops: [ITEM, { ...LINK, category: 'c'.repeat(129) }] })).ok).toBe(false);
  });

  it('rejects a huge text reply before parsing it', () => {
    const huge = text(' '.repeat(40_000) + JSON.stringify(GOOD));
    expect(message(huge)).toMatch(/over the limit of 32000/);
    expect(guard(huge, { maxOutputChars: 50_000 }).ok).toBe(true);
  });

  it('is not undone by a reply with deep nesting inside data', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 400; i++) nested = { a: nested };
    expect(() => guard(json({ ops: [{ ...ITEM, data: nested as never }, LINK] }))).not.toThrow();
  });

  it('exposes its defaults', () => {
    expect(DEFAULT_GUARD_OPTIONS).toEqual({ maxOps: 25, maxDataBytes: 2048, maxIdLength: 128, maxOutputChars: 32_000, maxRationaleChars: 500 });
  });
});

describe('reporting problems', () => {
  it('lists several problems at once so one repair attempt can fix them all', () => {
    const m = message(json({ ops: [{ ...ITEM, id: 'x' }, { op: 'deleteNode' }, { ...LINK, item: 'y' }] }));
    expect(m).toContain('(1)');
    expect(m).toContain('(2)');
    expect(m).toContain('(3)');
  });

  it('shows at most five and counts the rest', () => {
    const ops = Array.from({ length: 10 }, () => ({ op: 'deleteNode' }));
    const m = message(json({ ops }));
    expect(m).toContain('(5)');
    expect(m).not.toContain('(6)');
    expect(m).toMatch(/and \d+ more/);
  });

  it('is the same every time', () => {
    expect(guard(json({ ops: [{ op: 'x' }] }))).toEqual(guard(json({ ops: [{ op: 'x' }] })));
  });
});

describe('never throws', () => {
  it('survives hostile objects, getters and odd contexts', () => {
    const getter = { get ops(): never { throw new Error('boom'); } };
    expect(guard(json(getter))).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT' } });
    expect(guardReply(json(GOOD), { graphId: 'Bad Graph!', itemId: 'note-1' })).toMatchObject({ ok: false });
    expect(guardReply(json(GOOD), null as never)).toMatchObject({ ok: false });
    expect(guardReply(null as never, CONTEXT)).toMatchObject({ ok: false });
  });
});
