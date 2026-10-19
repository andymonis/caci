import { describe, expect, it } from 'vitest';
import type { ModelOutput } from '../../model-client.js';
import { SHIPPED_CONTROLS } from '../../testing/shipped-controls.test-util.js';
import { guardReply, guardSettingsOf, inspectReply, type GuardContext, type GuardOptions } from './guard.js';

const SETTINGS = guardSettingsOf(SHIPPED_CONTROLS.categorise.settings);

const CONTEXT: GuardContext = { graphId: 'my-notes', itemId: 'note-1', requestId: 'req-7' };
const ITEM = { op: 'upsertNode', partition: 'item', id: 'note-1', data: { title: 'Dr X visit', summary: 'Follow up on blood test.' } };
const CATEGORY = { op: 'upsertNode', partition: 'category', id: 'doctor-x', data: { name: 'Dr X' } };
const LINK = { op: 'link', item: 'note-1', category: 'doctor-x', weight: 0.9 };
const GOOD = { ops: [ITEM, CATEGORY, LINK], rationale: 'It is about a doctor.' };

const json = (value: unknown): ModelOutput => ({ kind: 'json', value: value as never });
const text = (value: string): ModelOutput => ({ kind: 'text', text: value });
const guard = (output: ModelOutput, options?: GuardOptions, context: GuardContext = CONTEXT) => guardReply(output, context, { ...SETTINGS, ...options });
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
      replaces: [],
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

  it('needs exactly one item (when one fact is allowed) and at least one link', () => {
    expect(message(json({ ops: [LINK] }), { maxFacts: 1 })).toContain('exactly one upsertNode for the note\'s item, found 0');
    expect(message(json({ ops: [ITEM, ITEM, LINK] }), { maxFacts: 1 })).toContain('found 2');
    expect(message(json({ ops: [LINK] }))).toContain('1 to 8 upsertNode operations for items (one per fact), found 0');
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
    expect(message(json({ ops: [ITEM, ...manyLinks(40)] }))).toContain('41 operations, over the limit of 40');
  });

  it('uses the limit it is given', () => {
    expect(message(json({ ops: [ITEM, ...manyLinks(3)] }), { maxOps: 3 })).toContain('over the limit of 3');
    expect(guard(json({ ops: [ITEM, ...manyLinks(2)] }), { maxOps: 3 }).ok).toBe(true);
  });

  it('caps data tighter than the library does', () => {
    const big = (n: number) => ({ ops: [{ ...ITEM, data: { title: 'x'.repeat(n) } }, LINK] });
    expect(guard(json(big(4000))).ok).toBe(true);
    expect(guard(json(big(4200))).ok).toBe(false);
    expect(guard(json(big(4200)), { maxDataBytes: 8192 }).ok).toBe(true);
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

  it('takes its limits from the controls and from nowhere else', () => {
    expect(SETTINGS).toEqual({ maxFacts: 8, keyMaxChars: 80, maxOps: 40, maxDataBytes: 4096, maxIdLength: 128, maxOutputChars: 32_000, maxRationaleChars: 500, maxReplaces: 5 });
    const tight = guardSettingsOf({ ...SHIPPED_CONTROLS.categorise.settings, maxOps: 2, maxOutputChars: 1500, maxRationaleChars: 5, maxIdLength: 10, maxDataBytes: 500, maxReplaces: 1 });
    expect(tight).toEqual({ maxOps: 2, maxDataBytes: 500, maxIdLength: 10, maxOutputChars: 1500, maxRationaleChars: 5, maxReplaces: 1, maxFacts: 8, keyMaxChars: 80 });
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
    expect(guardReply(json(GOOD), { graphId: 'Bad Graph!', itemId: 'note-1' }, SETTINGS)).toMatchObject({ ok: false });
    expect(guardReply(json(GOOD), null as never, SETTINGS)).toMatchObject({ ok: false });
    expect(guardReply(null as never, CONTEXT, SETTINGS)).toMatchObject({ ok: false });
  });
});

describe('inspectReply: the complete list of problems', () => {
  it('is the accepted reply when there are none', async () => {
    const { inspectReply } = await import('./guard.js');
    const r = inspectReply(json(GOOD), CONTEXT, SETTINGS);
    expect(r.ok && r.value.mutation.ops).toHaveLength(3);
  });

  it('lists every problem, where the error message shows only five', async () => {
    const { inspectReply } = await import('./guard.js');
    const r = inspectReply(json({ ops: Array.from({ length: 9 }, () => ({ op: 'deleteNode' })) }), CONTEXT, SETTINGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(9);
      expect(guard(json({ ops: Array.from({ length: 9 }, () => ({ op: 'deleteNode' })) })).ok).toBe(false);
    }
  });

  it('gives one problem for text that is not JSON, and for an oversized reply', async () => {
    const { inspectReply } = await import('./guard.js');
    expect(inspectReply(text('hello'), CONTEXT, SETTINGS)).toMatchObject({ ok: false, error: [expect.stringContaining('not a single JSON object')] });
    expect(inspectReply(text('x'.repeat(40_000)), CONTEXT, SETTINGS)).toMatchObject({ ok: false, error: [expect.stringContaining('over the limit of 32000')] });
  });

  it('agrees with guardReply: the same reasons, the same acceptance', async () => {
    const { inspectReply, rejectionError } = await import('./guard.js');
    for (const reply of [GOOD, BAD_CASE, { ops: [] }, { ...GOOD, extra: 1 }]) {
      const inspected = inspectReply(json(reply), CONTEXT, SETTINGS);
      const guarded = guard(json(reply));
      expect(inspected.ok).toBe(guarded.ok);
      if (!inspected.ok && !guarded.ok) expect(guarded.error).toEqual(rejectionError(inspected.error));
    }
  });
});

const BAD_CASE = { ops: [{ op: 'deleteNode', partition: 'item', id: 'note-9' }] };

describe('replaces (R-014)', () => {
  const shown = (n: number): GuardContext => ({ ...CONTEXT, existingCount: n });
  const withReplaces = (replaces: unknown) => ({ ...GOOD, replaces });

  it('accepts numbers from 1 to the count shown, returns them ascending, each once', () => {
    const r = guard(json(withReplaces([3, 1])), undefined, shown(3));
    expect(r.ok && r.value.replaces).toEqual([1, 3]);
    expect(guard(json(withReplaces([])), undefined, shown(3)).ok).toBe(true);
    expect(guard(json(withReplaces([5])), undefined, shown(5)).ok).toBe(true);
  });
  it('a reply without it replaces nothing, with or without notes shown', () => {
    const a = guard(json(GOOD), undefined, shown(3));
    const b = guard(json(GOOD));
    expect(a.ok && a.value.replaces).toEqual([]);
    expect(b.ok && b.value.replaces).toEqual([]);
  });
  it('refuses a number outside the range, a repeat, a fraction, text and a list that is not a list, listing every problem', () => {
    const m = message(json(withReplaces([0])), undefined);
    const r = inspectReply(json(withReplaces([0, 4, 2, 2, 1.5, '1'])), shown(3), SETTINGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual([
        'replaces: 6 numbers, over the limit of 5',
        'replaces[0]: must be a whole number from 1 to 3',
        'replaces[1]: must be a whole number from 1 to 3',
        'replaces[3]: 2 is repeated',
        'replaces[4]: must be a whole number from 1 to 3',
        'replaces[5]: must be a whole number from 1 to 3',
      ]);
    }
    expect(m).toContain('there are no existing notes');
    for (const bad of ['1', 1, { 0: 1 }, null]) expect(guard(json(withReplaces(bad)), undefined, shown(3)).ok, JSON.stringify(bad)).toBe(false);
  });
  it('refuses more than maxReplaces', () => {
    const r = guard(json(withReplaces([1, 2, 3])), { maxReplaces: 2 }, shown(5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('3 numbers, over the limit of 2');
    expect(guard(json(withReplaces([1, 2])), { maxReplaces: 2 }, shown(5)).ok).toBe(true);
  });
  it('refuses it when no notes were shown or replacing is switched off, even an empty list', () => {
    for (const [options, context] of [[undefined, CONTEXT], [undefined, shown(0)], [{ maxReplaces: 0 }, shown(4)]] as const) {
      const r = guard(json(withReplaces([])), options, context);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('there are no existing notes to replace here');
    }
  });
  it('it is the only addition: other unknown top-level fields are still refused', () => {
    expect(guard(json({ ...GOOD, replace: [1] }), undefined, shown(2)).ok).toBe(false);
  });
});

describe('facts (R-015)', () => {
  const fact = (k: number, extra: Record<string, unknown> = {}) => ({ op: 'upsertNode', partition: 'item', id: k === 1 ? 'note-1' : `note-1-${k}`, data: { title: `Fact ${k}`, summary: `Statement ${k}.`, ...extra } });
  const link = (k: number, category = 'doctor-x') => ({ op: 'link', item: k === 1 ? 'note-1' : `note-1-${k}`, category, weight: 0.8 });
  const two = { ops: [fact(1, { key: 'mum / dob' }), fact(2, { key: 'mum / phone' }), CATEGORY, link(1), link(2)] };

  it('accepts several facts with the minted ids in order, each linked, with keys', () => {
    const r = guard(json(two));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mutation.ops.filter((o) => o.op === 'upsertNode' && o.partition === 'item')).toHaveLength(2);
  });
  it('a key is optional', () => {
    expect(guard(json({ ops: [fact(1), fact(2), CATEGORY, link(1), link(2)] })).ok).toBe(true);
  });
  it('accepts exactly maxFacts facts and refuses one more', () => {
    const n = (count: number) => ({ ops: [...Array.from({ length: count }, (_, i) => fact(i + 1)), CATEGORY, ...Array.from({ length: count }, (_, i) => link(i + 1))] });
    expect(guard(json(n(8))).ok).toBe(true);
    expect(message(json(n(9)))).toContain('1 to 8 upsertNode operations for items (one per fact), found 9');
    expect(guard(json(n(3)), { maxFacts: 3 }).ok).toBe(true);
    expect(message(json(n(3)), { maxFacts: 2 })).toContain('1 to 2');
  });
  it('refuses an id that was not minted, a gap, a repeat and a wrong order, naming the fact', () => {
    expect(message(json({ ops: [fact(1), { ...fact(2), id: 'note-1-3' }, CATEGORY, link(1), link(2)] }))).toContain('fact 2\'s item id must be exactly "note-1-2"');
    expect(message(json({ ops: [fact(1), fact(3), CATEGORY, link(1), link(3)] }))).toContain('fact 2\'s item id must be exactly "note-1-2"');
    expect(message(json({ ops: [fact(1), fact(1), CATEGORY, link(1)] }))).toContain('two facts use the same item id');
    expect(message(json({ ops: [fact(2), fact(1), CATEGORY, link(1), link(2)] }))).toContain('the note\'s item id must be exactly "note-1"');
    expect(message(json({ ops: [{ ...fact(1), id: 'someone-elses' }, CATEGORY, { ...link(1), item: 'someone-elses' }] }))).toContain('the note\'s item id must be exactly "note-1"');
  });
  it('every fact needs a link, and a link must come from one of the facts', () => {
    expect(message(json({ ops: [fact(1), fact(2), CATEGORY, link(1)] }))).toContain('the fact "note-1-2" has no link to a category');
    expect(message(json({ ops: [fact(1), CATEGORY, link(1), link(2)] }))).toContain('a link\'s item must be exactly "note-1"');
    expect(message(json({ ops: [fact(1), fact(2), CATEGORY, link(1), link(2), { ...link(1), item: 'note-9' }] }))).toContain('a link\'s item must be the id of one of this reply\'s facts');
  });
  it('the key must be plain text of 1 to keyMaxChars characters', () => {
    for (const key of ['', '   ', 5, 'a\nb', 'x'.repeat(81), null]) expect(message(json({ ops: [fact(1, { key }), CATEGORY, link(1)] })), String(key)).toContain('data.key must be 1 to 80 characters of plain text');
    expect(guard(json({ ops: [fact(1, { key: 'x'.repeat(80) }), CATEGORY, link(1)] })).ok).toBe(true);
    expect(guard(json({ ops: [fact(1, { key: '😀'.repeat(80) }), CATEGORY, link(1)] })).ok).toBe(true);
    expect(message(json({ ops: [fact(1, { key: 'ab' }), CATEGORY, link(1)] }), { keyMaxChars: 1 })).toContain('1 to 1 characters');
  });
  it('with one fact allowed a second item is refused as before', () => {
    expect(message(json(two), { maxFacts: 1 })).toContain('exactly one upsertNode for the note\'s item, found 2');
    expect(guard(json(GOOD), { maxFacts: 1 }).ok).toBe(true);
  });
  it('with one fact allowed, a link from any other id says exactly which id', () => {
    expect(message(json({ ops: [fact(1), fact(2), CATEGORY, link(1), link(2), { ...link(1), item: 'note-9' }] }), { maxFacts: 1 })).toContain('a link\'s item must be exactly "note-1"');
  });
  it('lists every problem at once', () => {
    const r = inspectReply(json({ ops: [fact(1, { key: '' }), { ...fact(2), id: 'bad' }, CATEGORY, link(1)] }), CONTEXT, SETTINGS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThanOrEqual(3);
  });
});
