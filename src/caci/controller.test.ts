import { describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { describeGraph } from '../graph_store/index.js';
import { createDemoModelClient, createLlm, llmError, type ModelClient } from '../llm/index.js';
import { createCaciController, MAX_NOTE_CHARS } from './index.js';
import { ownErrorOf, T0, world } from './controller.test-util.js';

describe('propose', () => {
  it('asks the model for the signed-in person and holds a proposal: id, expiry, mode, preview, summary, operations; writes nothing', async () => {
    const w = await world();
    const r = await w.caci.propose(w.tokens.ann, { text: 'Dr Patel booked my blood test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ id: expect.stringMatching(/^prop-/), createdAt: T0, expiresAt: T0 + 15 * 60_000, mode: 'demo' });
    expect(r.value.text).toContain('New items');
    expect(r.value.summary.newItems).toHaveLength(1);
    expect(r.value.summary.newCategories).toEqual(['booked']); // every word once: the longest, then alphabetical
    expect((r.value.operations as Array<{ op: string }>).map((o) => o.op)).toEqual(['upsertNode', 'upsertNode', 'link']);
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ ok: true, value: { itemCount: 0, categoryCount: 0, edgeCount: 0 } });
    expect(w.modelCalls).toHaveLength(1);
  });

  it('shows only what a person needs: no prompt, no raw output, no usage, no model name, no graph id, no attempts', async () => {
    const w = await world();
    const r = await w.caci.propose(w.tokens.ann, { text: 'gardening notes for the spring' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'mode', 'operations', 'rationale', 'summary', 'text']);
    const text = JSON.stringify(r.value);
    for (const leak of ['usage', 'inputTokens', 'outputTokens', 'attempts', 'system', 'categories>', 'user-u', 'graphId', 'demo-model', '<note>']) expect(text, leak).not.toContain(leak);
    expect(Object.isFrozen(r.value)).toBe(true);
  });

  it('the graph is the session\'s: each person\'s model sees only their own categories', async () => {
    const w = await world();
    const seed = async (name: string, category: string) => {
      const { write } = await import('../graph_store/index.js');
      await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphIds[name] as string, ops: [{ op: 'upsertNode', partition: 'category', id: category, data: { name: category } }] });
    };
    await seed('ann', 'health');
    await seed('bob', 'travel');
    const a = await w.caci.propose(w.tokens.ann, { text: 'health check on tuesday' });
    const b = await w.caci.propose(w.tokens.bob, { text: 'health check on tuesday' });
    expect(a.ok && a.value.summary.reusedCategories).toEqual(['health']);
    expect(b.ok && b.value.summary.reusedCategories).toEqual([]);
    const bobsPrompt = w.modelCalls[1]?.messages[0]?.content ?? '';
    expect(bobsPrompt).toContain('travel');
    expect(bobsPrompt).not.toContain('health"');
  });

  it('reports the mode it was given', async () => {
    const w = await world({ mode: 'anthropic' });
    const r = await w.caci.propose(w.tokens.ann, { text: 'something to file' });
    expect(r.ok && r.value.mode).toBe('anthropic');
  });
});

describe('who may ask', () => {
  it('a missing, malformed, or ended session is UNAUTHENTICATED, and the model is never asked', async () => {
    const w = await world();
    await w.users.logout(w.tokens.bob);
    for (const token of [undefined, null, 5, '', 'garbage', 'A'.repeat(43), w.tokens.bob]) {
      const r = await w.caci.propose(token, { text: 'a note' });
      expect(r, String(token)).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'UNAUTHENTICATED' } } });
    }
    expect(w.modelCalls).toHaveLength(0);
  });

  it('input can only carry text: anything else, a graph id above all, is refused by name', async () => {
    const w = await world();
    for (const key of ['graphId', 'userId', 'mode', 'model', 'kind']) {
      const r = await w.caci.propose(w.tokens.ann, { text: 'a note', [key]: w.graphIds.bob } as never);
      expect(ownErrorOf(r), key).toMatchObject({ code: 'INVALID_INPUT', field: key });
    }
    expect(w.modelCalls).toHaveLength(0);
  });
});

describe('the note', () => {
  it.each([[5], [null], [undefined], [{}], [['text']], [''], ['   '], ['\n\t ']])('%j is refused naming text, with no model call and no hourly charge', async (bad) => {
    const w = await world({ limits: { proposalsPerHour: 1 } });
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: bad }))).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
    expect(w.modelCalls).toHaveLength(0);
    expect((await w.caci.propose(w.tokens.ann, { text: 'a real note' })).ok).toBe(true); // the one allowed this hour is still there
  });

  it('is at most 8,000 characters: 8,000 works end to end, 8,001 is refused here without asking the model', async () => {
    const w = await world();
    expect(MAX_NOTE_CHARS).toBe(8000);
    expect((await w.caci.propose(w.tokens.ann, { text: 'word '.repeat(1600) })).ok).toBe(true);
    const calls = w.modelCalls.length;
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'x'.repeat(8001) }))).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
    expect(w.modelCalls).toHaveLength(calls);
  });

  it('a missing input object is refused too', async () => {
    const w = await world();
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, undefined as never))).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
  });
});

describe('the limits', () => {
  it('an account may have 10 proposals waiting: the 11th is refused before the model, the other account is not affected', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await w.caci.propose(w.tokens.ann, { text: `note number ${i}` })).ok).toBe(true);
    const eleventh = await w.caci.propose(w.tokens.ann, { text: 'one too many' });
    expect(ownErrorOf(eleventh)).toMatchObject({ code: 'TOO_MANY_PENDING' });
    expect(w.modelCalls).toHaveLength(10);
    expect((await w.caci.propose(w.tokens.bob, { text: 'bob can still file' })).ok).toBe(true);
  });

  it('the refusal says when the oldest place frees up', async () => {
    const w = await world({ limits: { maxPendingPerUser: 2 } });
    await w.caci.propose(w.tokens.ann, { text: 'first note' });
    w.now.value += 60_000;
    await w.caci.propose(w.tokens.ann, { text: 'second note' });
    w.now.value += 60_000;
    const refused = await w.caci.propose(w.tokens.ann, { text: 'third note' });
    expect(ownErrorOf(refused)).toMatchObject({ code: 'TOO_MANY_PENDING', retryAfterMs: 15 * 60_000 - 120_000 });
  });

  it('places come back when proposals expire', async () => {
    const w = await world({ limits: { maxPendingPerUser: 2 } });
    await w.caci.propose(w.tokens.ann, { text: 'first note' });
    await w.caci.propose(w.tokens.ann, { text: 'second note' });
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'third note' }))?.code).toBe('TOO_MANY_PENDING');
    w.now.value += 15 * 60_000; // both expire at this instant
    expect((await w.caci.propose(w.tokens.ann, { text: 'third note' })).ok).toBe(true);
  });

  it('of 15 simultaneous proposals with room for 10, exactly 10 reach the model', async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => w.caci.propose(w.tokens.ann, { text: `simultaneous note ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => ownErrorOf(r)?.code === 'TOO_MANY_PENDING')).toHaveLength(5);
    expect(w.modelCalls).toHaveLength(10);
  });

  it('30 new proposals an hour: the 31st is THROTTLED with the time to wait, and the hour slides', async () => {
    const w = await world({ limits: { maxPendingPerUser: 100 } });
    for (let i = 0; i < 30; i++) {
      expect((await w.caci.propose(w.tokens.ann, { text: `hourly note ${i}` })).ok, String(i)).toBe(true);
      if (i === 29) expect((await w.caci.propose(w.tokens.bob, { text: 'bob was never limited' })).ok).toBe(true); // her limit is hers alone (and his session is still fresh)
      w.now.value += 60_000; // one a minute
    }
    const refused = await w.caci.propose(w.tokens.ann, { text: 'the 31st' });
    expect(ownErrorOf(refused)).toMatchObject({ code: 'THROTTLED' });
    expect(ownErrorOf(refused)?.retryAfterMs).toBe(60 * 60_000 - 30 * 60_000); // the first of them was 30 minutes ago
    expect(w.modelCalls).toHaveLength(31); // her 30 and bob's one: the 31st of hers never reached the model
    w.now.value += 15 * 60_000;
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'still not yet' }))?.code).toBe('THROTTLED'); // (and the session stays alive: it is used, so it does not go idle)
    w.now.value += 15 * 60_000;
    const again = await w.caci.propose(w.tokens.ann, { text: 'now it is allowed again' });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
  });

  it('a proposal whose model call fails still counts for the hour (it cost something)', async () => {
    const failing: ModelClient = { complete: async () => ({ ok: false, error: llmError('MODEL_ERROR', 'the provider had a server error') }) };
    const w = await world({ client: failing, limits: { proposalsPerHour: 2 } });
    expect((await w.caci.propose(w.tokens.ann, { text: 'a note' })).ok).toBe(false);
    expect((await w.caci.propose(w.tokens.ann, { text: 'a note' })).ok).toBe(false);
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'a note' }))).toMatchObject({ code: 'THROTTLED' });
  });

  it('a failed proposal leaves no place taken', async () => {
    const failing: ModelClient = { complete: async () => ({ ok: false, error: llmError('REFUSED', 'the model declined to answer') }) };
    const w = await world({ client: failing, limits: { maxPendingPerUser: 1 } });
    for (let i = 0; i < 3; i++) expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'a note' }))).toBeUndefined(); // refused by the model each time, never by the limit
  });

  it('a refusal by the pending limit, or for a bad note, is not counted against the hour', async () => {
    const w = await world({ limits: { maxPendingPerUser: 1, proposalsPerHour: 2 } });
    await w.caci.propose(w.tokens.ann, { text: 'the first' }); // 1 of 2
    for (let i = 0; i < 5; i++) expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'refused: too many pending' }))?.code).toBe('TOO_MANY_PENDING');
    w.now.value += 15 * 60_000; // the first expires
    expect((await w.caci.propose(w.tokens.ann, { text: 'the second' })).ok).toBe(true); // 2 of 2: the refusals were free
  });

  it('the limits are set when the controller is made, and nonsense is refused with a TypeError', async () => {
    const w = await world({ limits: { maxPendingPerUser: 3, proposalsPerHour: 50 } });
    for (let i = 0; i < 3; i++) await w.caci.propose(w.tokens.ann, { text: `note ${i}` });
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'fourth' }))?.code).toBe('TOO_MANY_PENDING');
    for (const bad of [{ maxPendingPerUser: 0 }, { maxPendingPerUser: 1.5 }, { proposalsPerHour: -1 }, { proposalsPerHour: Number.NaN }]) {
      const base = await world();
      expect(() => createCaciController({ users: base.users, capture: createController({ adapter: base.graphs, llm: createLlm({ client: createDemoModelClient() }) }), limits: bad })).toThrow(TypeError);
    }
  });

  it('the capture controller\'s own global limit still applies, and says where it came from', async () => {
    const w = await world({ capturePending: 2 });
    await w.caci.propose(w.tokens.ann, { text: 'a note' });
    await w.caci.propose(w.tokens.bob, { text: 'a note' });
    const third = await w.caci.propose(w.tokens.ann, { text: 'a third' });
    expect(third).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'TOO_MANY_PENDING' } } });
  });
});

describe('failures keep their source', () => {
  it('a model that fails is an llm error, a graph that is gone is a graph error', async () => {
    const failing: ModelClient = { complete: async () => ({ ok: false, error: llmError('RATE_LIMITED', 'slow down', { retryAfterMs: 5000 }) }) };
    const w = await world({ client: failing });
    expect(await w.caci.propose(w.tokens.ann, { text: 'a note' })).toMatchObject({ ok: false, error: { source: 'llm', error: { code: 'RATE_LIMITED' } } });
    const good = await world();
    await good.graphs.graphs.drop(good.graphIds.ann as string);
    expect(await good.caci.propose(good.tokens.ann, { text: 'a note' })).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'GRAPH_NOT_FOUND' } } });
  });

  it('a capture controller that throws leaves no place taken and lets the error out', async () => {
    const w = await world({ limits: { maxPendingPerUser: 1 } });
    const capture = { propose: async () => { throw new Error('boom'); } } as never;
    const caci = createCaciController({ users: w.users, capture, clock: () => w.now.value, limits: { maxPendingPerUser: 1 } });
    await expect(caci.propose(w.tokens.ann, { text: 'a note' })).rejects.toThrow('boom');
    await expect(caci.propose(w.tokens.ann, { text: 'a note' })).rejects.toThrow('boom'); // the place was given back, so the limit did not answer instead
  });
});

describe('making a controller', () => {
  it('needs the user controller and the capture controller, and a known mode', async () => {
    const w = await world();
    const capture = createController({ adapter: w.graphs, llm: createLlm({ client: createDemoModelClient() }) });
    expect(() => createCaciController({ users: undefined as never, capture })).toThrow(TypeError);
    expect(() => createCaciController({ users: w.users, capture: undefined as never })).toThrow(TypeError);
    expect(() => createCaciController({ users: w.users, capture, mode: 'other' as never })).toThrow(TypeError);
  });
});
