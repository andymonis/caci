import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createGraph, describeGraph, ok, type StorageAdapter } from '../graph_store/index.js';
import { createLlm } from '../llm/index.js';
import { createScriptedModelClient, type ScriptStep } from '../llm/testing/index.js';
import { createController } from './controller.js';
import { category, EXISTING, item, NOTE, PROPOSAL, reply, setup, type Script } from './controller-fixture.test-util.js';

describe('propose: a proposal for a note', () => {
  it('returns a pending proposal with the mutation, summary and plain text', async () => {
    const { controller } = await setup({ existing: EXISTING });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
    expect(p).toMatchObject({
      graphId: 'notes',
      itemId: 'note-1',
      note: NOTE.text,
      rationale: 'About a doctor visit.',
      model: expect.stringContaining('haiku'),
      attempts: 1,
      context: { categoriesRead: 2, capped: false },
    });
    expect(p.mutation).toMatchObject({ graphId: 'notes', requestId: p.id, createIfMissing: false });
    expect(p.mutation.ops).toHaveLength(4);
    expect(p.summary).toMatchObject({ newItems: ['note-1'], newCategories: ['doctor-x'], reusedCategories: ['appointments'], problems: [], notes: [] });
    expect(p.summary.newLinks).toEqual([{ item: 'note-1', category: 'doctor-x' }, { item: 'note-1', category: 'appointments' }]);
    expect(p.text).toBe(
      ['New items: note-1', 'New categories: doctor-x', 'Existing categories used: appointments', 'Links: note-1 → doctor-x, note-1 → appointments'].join('\n'),
    );
    expect(p.usage.inputTokens).toBeGreaterThan(0);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('gives each proposal its own id, with the prop prefix, and holds it', async () => {
    const { controller } = await setup({ script: [reply(PROPOSAL), reply({ ...PROPOSAL, ops: PROPOSAL.ops.map((o) => ('id' in o && o.id === 'note-1' ? { ...o, id: 'note-2' } : 'item' in o ? { ...o, item: 'note-2' } : o)) })], existing: EXISTING });
    const a = await controller.propose('notes', NOTE);
    const b = await controller.propose('notes', NOTE);
    if (!a.ok || !b.ok) throw new Error('expected both to work');
    expect(a.value.id).toMatch(/^prop-[a-z0-9-]+$/);
    expect(b.value.id).not.toBe(a.value.id);
    expect(controller.get(a.value.id)).toBe(a.value);
    expect(controller.get(b.value.id)).toBe(b.value);
    expect(controller.get('prop-unknown')).toBeUndefined();
    expect(b.value.itemId).toBe('note-2');
  });

  it('shows the model the categories that exist, with their data, and the note', async () => {
    const { controller, client } = await setup({ existing: EXISTING });
    await controller.propose('notes', NOTE);
    const content = client.requests[0]?.messages[0]?.content ?? '';
    expect(content).toContain('{"id":"appointments","data":{"name":"Appointments"}}');
    expect(content).toContain('{"id":"errands","data":{"name":"errands"}}');
    expect(content).toContain('Saw Dr X on Tuesday');
    expect(client.requests[0]?.system).toContain('"note-1"');
  });

  it('works on a graph with no categories yet', async () => {
    const { controller, client } = await setup({ script: [reply({ ops: PROPOSAL.ops.slice(0, 3) })] });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.context).toEqual({ categoriesRead: 0, capped: false });
    expect(client.requests[0]?.messages[0]?.content).toContain('No categories exist yet.');
  });

  it('reports an id collision as an update, not a new node', async () => {
    const { controller } = await setup({ existing: [item('note-1'), category('appointments')] });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.summary).toMatchObject({ newItems: [], updatedItems: ['note-1'] });
    expect(r.ok && r.value.summary.notes.length).toBeGreaterThan(0);
  });

  it('counts an existing category that is only updated (upserted, not linked) as updated', async () => {
    const { controller } = await setup({
      script: [reply({ ops: [PROPOSAL.ops[0], { op: 'upsertNode', partition: 'category', id: 'errands', data: { name: 'Errands!' } }, { op: 'link', item: 'note-1', category: 'appointments' }] })],
      existing: EXISTING,
    });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.summary).toMatchObject({ newCategories: [], updatedCategories: ['errands'], reusedCategories: ['appointments'], problems: [] });
  });

  it('still holds a proposal that has problems, and shows them (a person decides)', async () => {
    const { controller } = await setup({ script: [reply({ ops: [PROPOSAL.ops[0], PROPOSAL.ops[2]] })] }); // links to doctor-x, which does not exist
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.summary.problems).toHaveLength(1);
    expect(r.ok && r.value.text).toContain('Problems (this would fail if approved)');
    expect(r.ok && controller.get(r.value.id)).toBeDefined();
  });

  it('passes model choices and limits on to the categoriser', async () => {
    const { controller, client } = await setup({ existing: EXISTING });
    await controller.propose('notes', NOTE, { categorise: { tier: 'deep', timeoutMs: 9_000 } });
    expect(client.requests[0]?.model).toBe('claude-opus-5-5');
    expect(client.requests[0]?.timeoutMs).toBeLessThanOrEqual(9_000);
  });

  it('handles two proposals at the same time', async () => {
    const script: Script = (q) => {
      const id = /"(note-\d+)"/.exec(q.system ?? '')?.[1] ?? 'missing';
      return reply({ ops: [{ op: 'upsertNode', partition: 'item', id }, { op: 'link', item: id, category: 'errands' }] });
    };
    const { controller } = await setup({ script, existing: EXISTING });
    const [a, b] = await Promise.all([controller.propose('notes', NOTE), controller.propose('notes', NOTE)]);
    if (!a.ok || !b.ok) throw new Error('expected both to work');
    expect(new Set([a.value.id, b.value.id]).size).toBe(2);
    expect(new Set([a.value.itemId, b.value.itemId]).size).toBe(2);
    expect(a.value.mutation.ops[0]).toMatchObject({ id: a.value.itemId });
    expect(b.value.mutation.ops[0]).toMatchObject({ id: b.value.itemId });
  });
});

describe('propose: nothing is written', () => {
  it('not by a proposal, and the graph is as it was', async () => {
    const { controller, recording, inner } = await setup({ existing: EXISTING });
    const before = await describeGraph(inner, 'notes');
    const writesBefore = recording.writes.length;
    await controller.propose('notes', NOTE);
    expect(recording.writes.slice(writesBefore)).toEqual([]);
    expect(recording.calls.length).toBeGreaterThan(0); // it did read
    expect(await describeGraph(inner, 'notes')).toEqual(before);
  });

  it('not when the model fails, the output is rejected, or the input is refused', async () => {
    const cases: Array<[string, ScriptStep[], unknown]> = [
      ['a refusal', [{ refusal: true }], NOTE],
      ['rejected output after a repair', [reply({ ops: [] }), reply({ ops: [] })], NOTE],
      ['a blank note', [reply(PROPOSAL)], { kind: 'text', text: '  ' }],
      ['a picture', [reply(PROPOSAL)], { kind: 'image', mediaType: 'image/png', data: new Uint8Array([1]) }],
    ];
    for (const [, script, input] of cases) {
      const { controller, recording } = await setup({ script, existing: EXISTING });
      const writesBefore = recording.writes.length;
      expect((await controller.propose('notes', input)).ok).toBe(false);
      expect(recording.writes.slice(writesBefore)).toEqual([]);
    }
  });
});

describe('propose: reading the graph', () => {
  it('shows the model at most maxCategories, in id order, and says it was capped', async () => {
    const many = Array.from({ length: 10 }, (_, i) => category(`cat-${String(i).padStart(2, '0')}`));
    const { controller, client } = await setup({ existing: many, init: { maxCategories: 3 } });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.context).toEqual({ categoriesRead: 3, capped: true });
    const content = client.requests[0]?.messages[0]?.content ?? '';
    expect(content).toContain('cat-00');
    expect(content).toContain('cat-02');
    expect(content).not.toContain('cat-03');
  });

  it('is not capped when there are exactly maxCategories', async () => {
    const some = Array.from({ length: 3 }, (_, i) => category(`cat-${i}`));
    const { controller } = await setup({ existing: some, init: { maxCategories: 3 } });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.context).toEqual({ categoriesRead: 3, capped: false });
  });

  it('reads across pages: 450 categories, all seen', async () => {
    const many = Array.from({ length: 450 }, (_, i) => category(`c-${String(i).padStart(3, '0')}`));
    const { controller } = await setup({ existing: many, init: { maxCategories: 1000 } });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.context).toEqual({ categoriesRead: 450, capped: false });
  });

  it('does not count items as categories', async () => {
    const { controller } = await setup({ existing: [item('i1'), item('i2'), category('c1')] });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.context.categoriesRead).toBe(1);
  });

  it('a graph that does not exist is GRAPH_NOT_FOUND, before the model or the id generator is used', async () => {
    const { controller, client, minted } = await setup({ createGraphFirst: false });
    expect(await controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'GRAPH_NOT_FOUND' } } });
    expect(client.callCount).toBe(0);
    expect(minted()).toBe(0);
  });

  it('a bad graph id is a graph validation error, before anything else', async () => {
    const { controller, client } = await setup();
    expect(await controller.propose('Not A Graph!', NOTE)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'VALIDATION_ERROR' } } });
    expect(client.callCount).toBe(0);
  });

  it('checks the graph before the input, so a note is not processed for a missing graph', async () => {
    let normalised = false;
    const { controller } = await setup({ createGraphFirst: false, init: { normalisers: { audio: async () => ((normalised = true), ok('transcript')) } } });
    await controller.propose('notes', { kind: 'audio', mediaType: 'audio/mpeg', data: new Uint8Array([1]) });
    expect(normalised).toBe(false);
  });
});

describe('propose: graph options', () => {
  it('reach the category read', async () => {
    const { controller, client } = await setup({ existing: EXISTING, init: { graphOptions: { limits: { maxOps: 0 } } } });
    expect(await controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'VALIDATION_ERROR' } } });
    expect(client.callCount).toBe(0);
  });

  it('reach the read of which ids exist (a short id limit refuses the minted id there, after the model has answered)', async () => {
    const { controller, client } = await setup({ existing: EXISTING, init: { graphOptions: { limits: { maxIdLength: 5 } } } });
    expect(await controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'VALIDATION_ERROR' } } });
    expect(client.callCount).toBe(1);
  });
});

describe('propose: input', () => {
  it.each([
    ['blank text', { kind: 'text', text: ' ' }, 'INVALID_INPUT'],
    ['a picture', { kind: 'image', mediaType: 'image/png', data: new Uint8Array([1]) }, 'UNSUPPORTED_INPUT'],
    ['voice', { kind: 'audio', mediaType: 'audio/mpeg', data: new Uint8Array([1]) }, 'UNSUPPORTED_INPUT'],
    ['nonsense', 'a note', 'INVALID_INPUT'],
  ])('%s is an app error, with no model call and no id minted', async (_n, input, code) => {
    const { controller, client, minted } = await setup({ existing: EXISTING });
    expect(await controller.propose('notes', input)).toMatchObject({ ok: false, error: { source: 'app', error: { code } } });
    expect(client.callCount).toBe(0);
    expect(minted()).toBe(0);
  });

  it('uses a supplied normaliser, and the model sees its text', async () => {
    const { controller, client } = await setup({
      existing: EXISTING,
      init: { normalisers: { audio: async () => ok('Transcript: booked the dentist for Friday.') } },
    });
    const r = await controller.propose('notes', { kind: 'audio', mediaType: 'audio/mpeg', data: new Uint8Array([1]) });
    expect(r.ok && r.value.note).toBe('Transcript: booked the dentist for Friday.');
    expect(client.requests[0]?.messages[0]?.content).toContain('booked the dentist');
  });
});

describe('propose: errors from the model keep their own type', () => {
  it.each([
    ['a refusal', [{ refusal: true }] as ScriptStep[], 'REFUSED'],
    ['a rate limit', [{ rateLimited: true, retryAfterMs: 500 }] as ScriptStep[], 'RATE_LIMITED'],
    ['output still rejected after repair', [reply({ ops: [] }), reply({ ops: [] })] as ScriptStep[], 'BAD_OUTPUT'],
    ['a provider that never answers', [{ hang: true }] as ScriptStep[], 'TIMEOUT'],
  ])('%s', async (_n, script, code) => {
    const { controller } = await setup({ script, existing: EXISTING });
    const r = await controller.propose('notes', NOTE, { categorise: { timeoutMs: 40 } });
    expect(r).toMatchObject({ ok: false, error: { source: 'llm', error: { code } } });
  });

  it('a bad item id from the id generator is a model-side CONFIG error before any model call', async () => {
    const { controller, client } = await setup({ existing: EXISTING, init: { ids: () => 'bad id!' } });
    expect(await controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'llm', error: { code: 'CONFIG' } } });
    expect(client.callCount).toBe(0);
  });

  it('cancellation is reported as CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    const { controller: c } = await setup({ existing: EXISTING });
    expect(await c.propose('notes', NOTE, { categorise: { signal: controller.signal } })).toMatchObject({ ok: false, error: { source: 'llm', error: { code: 'CANCELLED' } } });
  });

  it('nothing is held after a failure', async () => {
    const { controller } = await setup({ script: [{ refusal: true }], existing: EXISTING });
    await controller.propose('notes', NOTE);
    expect(controller.get('prop-anything')).toBeUndefined();
  });
});

describe('proposals expire and are limited in number', () => {
  it('a proposal can be fetched until expiresAt, and not from that moment', async () => {
    const { controller, clock } = await setup({ existing: EXISTING, init: { ttlMs: 10_000 } });
    const r = await controller.propose('notes', NOTE);
    if (!r.ok) throw new Error('expected a proposal');
    expect(r.value.expiresAt - r.value.createdAt).toBe(10_000);
    clock.advance(9_999);
    expect(controller.get(r.value.id)).toBeDefined();
    clock.advance(1);
    expect(controller.get(r.value.id)).toBeUndefined();
  });

  it('defaults to fifteen minutes', async () => {
    const { controller } = await setup({ existing: EXISTING });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.expiresAt - r.value.createdAt).toBe(15 * 60_000);
  });

  it('refuses a new proposal when too many are waiting, until some expire', async () => {
    const script = [1, 2, 3, 4].map((n) => reply({ ops: [{ op: 'upsertNode', partition: 'item', id: `note-${n}` }, { op: 'link', item: `note-${n}`, category: 'errands' }] }));
    const { controller, clock } = await setup({ script, existing: EXISTING, init: { maxPending: 2, ttlMs: 5_000 } });
    expect((await controller.propose('notes', NOTE)).ok).toBe(true);
    expect((await controller.propose('notes', NOTE)).ok).toBe(true);
    expect(await controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'TOO_MANY_PENDING' } } });
    clock.advance(5_000);
    expect((await controller.propose('notes', NOTE)).ok).toBe(true);
  });
});

describe('createController', () => {
  const base = { adapter: createMemoryAdapter(), llm: createLlm({ client: createScriptedModelClient([]) }) };

  it('returns a frozen object with propose, approve, reject and get', () => {
    const c = createController(base);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.keys(c).sort()).toEqual(['approve', 'get', 'propose', 'reject']);
  });

  it.each([
    ['nothing', undefined],
    ['no adapter', { llm: base.llm }],
    ['no llm', { adapter: base.adapter }],
    ['an llm that is not from createLlm', { ...base, llm: {} }],
    ['a zero ttl', { ...base, ttlMs: 0 }],
    ['a fractional maxPending', { ...base, maxPending: 1.5 }],
    ['a text maxCategories', { ...base, maxCategories: '10' }],
  ])('throws a TypeError for %s', (_n, init) => {
    expect(() => createController(init as never)).toThrow(TypeError);
  });

  it('does not share held proposals between controllers', async () => {
    const a = await setup({ existing: EXISTING });
    const b = await setup({ existing: EXISTING });
    const r = await a.controller.propose('notes', NOTE);
    if (!r.ok) throw new Error('expected a proposal');
    expect(b.controller.get(r.value.id)).toBeUndefined();
  });

  it('uses real ids and the real clock when none are given', async () => {
    const inner: StorageAdapter = createMemoryAdapter();
    await createGraph(inner, 'notes');
    const client = createScriptedModelClient((q) => {
      const id = /"(note-[a-z0-9-]+)"/.exec(q.system ?? '')?.[1] ?? 'x';
      return reply({ ops: [{ op: 'upsertNode', partition: 'item', id }, { op: 'link', item: id, category: 'errands' }] });
    });
    const controller = createController({ adapter: inner, llm: createLlm({ client }) });
    const r = await controller.propose('notes', NOTE);
    expect(r.ok && r.value.itemId).toMatch(/^note-[0-9a-z]{9}-00-[0-9a-z]{6}$/);
  });
});
