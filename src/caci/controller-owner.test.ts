import { describe, expect, it } from 'vitest';
import { describeGraph, query, type AdapterTx, type StorageAdapter } from '../graph_store/index.js';
import { createDemoModelClient, llmError, type ModelClient } from '../llm/index.js';
import { ownErrorOf, world, PW, type World } from './controller.test-util.js';
import type { ApprovedView, ProposalView } from './index.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const propose = async (w: World, who: string, text = 'Dr Patel booked my blood test'): Promise<ProposalView> => must(await w.caci.propose(w.tokens[who], { text }));
const itemsIn = async (w: World, who: string): Promise<string[]> => {
  const r = await query(w.graphs, { version: 1, graphId: w.graphIds[who] as string, from: { all: true }, filter: { partition: 'item' }, return: { shape: 'ids' } });
  return r.ok ? ((r.value as { ids?: Array<{ id: string }> }).ids ?? []).map((i) => i.id) : [];
};
const sameAsMissing = (a: unknown, b: unknown): void => expect(a).toEqual(b);

describe('get', () => {
  it('shows the owner their pending proposal, the same as propose showed it', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    expect(await w.caci.get(w.tokens.ann, made.id)).toEqual({ ok: true, value: made });
  });

  it('anyone else gets exactly the answer a missing proposal gets: another account, a made-up id, nonsense', async () => {
    const w = await world({ people: ['ann', 'bob', 'cat'] });
    const made = await propose(w, 'ann');
    const missing = await w.caci.get(w.tokens.bob, 'prop-does-not-exist');
    expect(missing).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND' } } });
    sameAsMissing(await w.caci.get(w.tokens.bob, made.id), missing);
    sameAsMissing(await w.caci.get(w.tokens.cat, made.id), missing);
    for (const nonsense of [undefined, null, 5, {}, '', 'x'.repeat(10_000), 'reservation-1', '__proto__', made.id + ' ', made.id.toUpperCase()]) sameAsMissing(await w.caci.get(w.tokens.ann, nonsense), missing);
  });

  it('an admin has no extra power over someone else\'s proposal', async () => {
    const w = await world({ people: ['admin1', 'ann'] }); // the first account is the admin
    const made = await propose(w, 'ann');
    const missing = await w.caci.get(w.tokens.admin1, 'prop-nothing');
    sameAsMissing(await w.caci.get(w.tokens.admin1, made.id), missing);
    sameAsMissing(await w.caci.approve(w.tokens.admin1, made.id), missing);
    sameAsMissing(await w.caci.reject(w.tokens.admin1, made.id), missing);
    expect((await w.caci.get(w.tokens.ann, made.id)).ok).toBe(true); // still there, untouched
  });

  it('needs a session: signed out, ended, or a deleted account', async () => {
    const w = await world({ people: ['admin1', 'ann'] });
    const made = await propose(w, 'ann');
    for (const token of [undefined, 'garbage', 'A'.repeat(43)]) expect(await w.caci.get(token, made.id)).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'UNAUTHENTICATED' } } });
    await w.users.logout(w.tokens.ann);
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, made.id))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const second = await w.users.login({ username: 'ann', password: PW }, { clientKey: 'ann' });
    if (!second.ok) throw new Error('login');
    expect((await w.caci.get(second.value.token, made.id)).ok).toBe(true); // a new session of the same person sees it
    await w.users.deleteMe(second.value.token, { password: PW }, { clientKey: 'ann' });
    expect(ownErrorOf(await w.caci.get(second.value.token, made.id))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('tells the owner when it has expired, and everyone else it is missing', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    const missing = await w.caci.get(w.tokens.bob, 'prop-nothing');
    w.now.value += 15 * 60_000;
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, made.id))).toMatchObject({ code: 'EXPIRED' });
    sameAsMissing(await w.caci.get(w.tokens.bob, made.id), missing);
  });

  it('remembers what expired only up to a point: the oldest are forgotten, the newest are still reported as expired', async () => {
    const w = await world({ capturePending: 5000, limits: { maxPendingPerUser: 5000, proposalsPerHour: 5000 } });
    const first = await propose(w, 'ann', 'first note');
    for (let i = 0; i < 1000; i++) await propose(w, 'ann', `filler note ${i}`);
    const last = await propose(w, 'ann', 'last note');
    w.now.value += 15 * 60_000;
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, last.id))).toMatchObject({ code: 'EXPIRED' });
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, first.id))).toMatchObject({ code: 'NOT_FOUND' }); // forgotten: the memory is bounded
  }, 60_000);
});

describe('approve', () => {
  it('writes the proposal to the owner\'s graph and nobody else\'s, and says what was written', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    expect(await itemsIn(w, 'ann')).toEqual([]);
    const done = must<ApprovedView>(await w.caci.approve(w.tokens.ann, made.id));
    expect(done).toMatchObject({ id: made.id, applied: 3, summary: { newItems: made.summary.newItems, newCategories: made.summary.newCategories } });
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ ok: true, value: { itemCount: 1, categoryCount: 1, edgeCount: 1 } });
    expect(await describeGraph(w.graphs, w.graphIds.bob as string)).toMatchObject({ ok: true, value: { itemCount: 0, categoryCount: 0, edgeCount: 0 } });
    expect(JSON.stringify(done)).not.toMatch(/user-u|graphId|usage|tokens/);
  });

  it('a second approval, or one at the same moment, writes once', async () => {
    const w = await world();
    const sequential = await propose(w, 'ann', 'sequential note');
    must(await w.caci.approve(w.tokens.ann, sequential.id));
    expect(ownErrorOf(await w.caci.approve(w.tokens.ann, sequential.id))).toMatchObject({ code: 'NOT_FOUND' });
    const racing = await propose(w, 'ann', 'racing note about gardening');
    const results = await Promise.all([w.caci.approve(w.tokens.ann, racing.id), w.caci.approve(w.tokens.ann, racing.id), w.caci.approve(w.tokens.ann, racing.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const lost of results.filter((r) => !r.ok)) expect(ownErrorOf(lost)).toMatchObject({ code: 'NOT_FOUND' });
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ value: { itemCount: 2 } }); // one item each, not three for the racing note
  });

  it('after it, the proposal is gone for everyone and the place is free again', async () => {
    const w = await world({ limits: { maxPendingPerUser: 1 } });
    const made = await propose(w, 'ann');
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'a second' }))).toMatchObject({ code: 'TOO_MANY_PENDING' });
    must(await w.caci.approve(w.tokens.ann, made.id));
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, made.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect((await w.caci.propose(w.tokens.ann, { text: 'a second' })).ok).toBe(true);
  });

  it('refuses an expired proposal to its owner as expired, and writes nothing', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    w.now.value += 15 * 60_000;
    expect(ownErrorOf(await w.caci.approve(w.tokens.ann, made.id))).toMatchObject({ code: 'EXPIRED' });
    expect(await itemsIn(w, 'ann')).toEqual([]);
  });

  it('a failed write changes nothing and leaves the proposal pending, to try again or reject', async () => {
    const flaky = { failing: true };
    const wrap = (inner: StorageAdapter): StorageAdapter => ({
      ...inner,
      transaction: (graphId, fn) =>
        inner.transaction(graphId, (tx: AdapterTx) =>
          fn({
            ...tx,
            putEdges: async (edges) => {
              if (flaky.failing) throw new Error('disk full while writing links');
              return tx.putEdges(edges);
            },
          }),
        ),
    });
    const w = await world({ captureAdapter: wrap, limits: { maxPendingPerUser: 1 } });
    const made = await propose(w, 'ann');
    const failed = await w.caci.approve(w.tokens.ann, made.id);
    expect(failed).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ value: { itemCount: 0, categoryCount: 0, edgeCount: 0 } }); // the item and category put first were undone
    expect((await w.caci.get(w.tokens.ann, made.id)).ok).toBe(true); // still pending
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: 'another' }))).toMatchObject({ code: 'TOO_MANY_PENDING' }); // and still counted
    flaky.failing = false;
    must(await w.caci.approve(w.tokens.ann, made.id)); // the retry works
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ value: { itemCount: 1, edgeCount: 1 } });
  });

  it('a proposal that would fail (a link to a category that does not exist) says so, is refused, and can be rejected', async () => {
    const dangling: ModelClient = {
      complete: async (request) => {
        const itemId = /The note's own id is "([^"]+)"/.exec(request.system ?? '')?.[1] as string;
        const value = { ops: [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 't', summary: 's' } }, { op: 'link', item: itemId, category: 'ghost' }], rationale: 'x' };
        return { ok: true, value: { model: 'm', output: { kind: 'json', value }, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
    };
    const w = await world({ client: dangling });
    const made = await propose(w, 'ann');
    expect(made.summary.problems).toHaveLength(1);
    expect(await w.caci.approve(w.tokens.ann, made.id)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'NODE_NOT_FOUND' } } });
    expect(await itemsIn(w, 'ann')).toEqual([]);
    expect((await w.caci.reject(w.tokens.ann, made.id)).ok).toBe(true);
  });

  it('a graph that has gone fails the write and keeps the proposal', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    await w.graphs.graphs.drop(w.graphIds.ann as string);
    expect(await w.caci.approve(w.tokens.ann, made.id)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'GRAPH_NOT_FOUND' } } });
    expect((await w.caci.get(w.tokens.ann, made.id)).ok).toBe(true);
  });

  it('writes to the graph the proposal was made for, even if the other person approves at the same time', async () => {
    const w = await world();
    const a = await propose(w, 'ann', 'ann writes about gardening');
    const b = await propose(w, 'bob', 'bob writes about cooking');
    await Promise.all([w.caci.approve(w.tokens.ann, a.id), w.caci.approve(w.tokens.bob, b.id)]);
    expect((await itemsIn(w, 'ann')).length).toBe(1);
    expect((await itemsIn(w, 'bob')).length).toBe(1);
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ value: { itemCount: 1, categoryCount: 1 } });
  });

  it('a person who cannot be signed in cannot approve, and the proposal stays', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    expect(ownErrorOf(await w.caci.approve(undefined, made.id))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await itemsIn(w, 'ann')).toEqual([]);
    expect((await w.caci.get(w.tokens.ann, made.id)).ok).toBe(true);
  });
});

describe('reject', () => {
  it('discards the owner\'s proposal, writes nothing, and frees the place', async () => {
    const w = await world({ limits: { maxPendingPerUser: 1 } });
    const made = await propose(w, 'ann');
    expect(await w.caci.reject(w.tokens.ann, made.id)).toEqual({ ok: true, value: { id: made.id } });
    expect(await itemsIn(w, 'ann')).toEqual([]);
    expect(ownErrorOf(await w.caci.get(w.tokens.ann, made.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(ownErrorOf(await w.caci.approve(w.tokens.ann, made.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect((await w.caci.propose(w.tokens.ann, { text: 'a second' })).ok).toBe(true);
  });

  it('rejecting twice is NOT_FOUND the second time; an expired one says expired', async () => {
    const w = await world();
    const a = await propose(w, 'ann', 'first note');
    must(await w.caci.reject(w.tokens.ann, a.id));
    expect(ownErrorOf(await w.caci.reject(w.tokens.ann, a.id))).toMatchObject({ code: 'NOT_FOUND' });
    const b = await propose(w, 'ann', 'second note');
    w.now.value += 15 * 60_000;
    expect(ownErrorOf(await w.caci.reject(w.tokens.ann, b.id))).toMatchObject({ code: 'EXPIRED' });
  });

  it('cannot be used by someone else: the proposal stays, and the answer is the missing-proposal answer', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    sameAsMissing(await w.caci.reject(w.tokens.bob, made.id), await w.caci.reject(w.tokens.bob, 'prop-nothing'));
    expect((await w.caci.get(w.tokens.ann, made.id)).ok).toBe(true);
  });

  it('a reject and an approve at the same moment: exactly one wins', async () => {
    const w = await world();
    const made = await propose(w, 'ann');
    const [approved, rejected] = await Promise.all([w.caci.approve(w.tokens.ann, made.id), w.caci.reject(w.tokens.ann, made.id)]);
    expect([approved.ok, rejected.ok].filter(Boolean)).toHaveLength(1);
    expect((await itemsIn(w, 'ann')).length).toBe(approved.ok ? 1 : 0);
  });
});

describe('when the capture controller thinks a proposal has expired before this one does', () => {
  it.each(['get', 'approve', 'reject'] as const)('%s tells the owner it expired, every time, and gives the place back', async (act) => {
    const w = await world({ limits: { maxPendingPerUser: 1 } });
    const made = await propose(w, 'ann');
    w.skew.value = 20 * 60_000; // by the capture controller's clock the proposal is stale; by this one's it is not
    expect(ownErrorOf(await w.caci[act](w.tokens.ann, made.id))).toMatchObject({ code: 'EXPIRED' });
    expect(ownErrorOf(await w.caci[act](w.tokens.ann, made.id))).toMatchObject({ code: 'NOT_FOUND' }); // it has been given up now
    w.skew.value = 0;
    expect((await w.caci.propose(w.tokens.ann, { text: 'the place is free again' })).ok).toBe(true);
  });
});

describe('what a restart does', () => {
  it('forgets every pending proposal and keeps everything approved', async () => {
    const w = await world();
    const approved = await propose(w, 'ann', 'approved before the restart');
    const pending = await propose(w, 'ann', 'pending at the restart');
    must(await w.caci.approve(w.tokens.ann, approved.id));
    // a restart: new controllers over the same stores
    const { createController } = await import('../app/index.js');
    const { createLlm } = await import('../llm/index.js');
    const { createCaciController } = await import('./index.js');
    const after = createCaciController({ users: w.users, graphAdapter: w.graphs, capture: createController({ adapter: w.graphs, llm: createLlm({ client: createDemoModelClient() }), now: () => w.now.value }), clock: () => w.now.value });
    expect(ownErrorOf(await after.get(w.tokens.ann, pending.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(ownErrorOf(await after.approve(w.tokens.ann, pending.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await describeGraph(w.graphs, w.graphIds.ann as string)).toMatchObject({ value: { itemCount: 1 } });
    expect((await after.propose(w.tokens.ann, { text: 'a new one after the restart' })).ok).toBe(true);
  });
});

describe('a failed proposal leaves nothing to find', () => {
  it('cannot be fetched, approved or rejected under any id, and the places kept for it are not ids', async () => {
    const failing: ModelClient = { complete: async () => ({ ok: false, error: llmError('REFUSED', 'the model declined to answer') }) };
    const w = await world({ client: failing });
    const r = await w.caci.propose(w.tokens.ann, { text: 'a note' });
    expect(r.ok).toBe(false);
    for (const id of ['reservation-1', 'prop-1', '1']) {
      sameAsMissing(await w.caci.get(w.tokens.ann, id), await w.caci.get(w.tokens.bob, 'prop-nothing'));
    }
  });
});
