import { describe, expect, it } from 'vitest';
import { createGraph, describeGraph, dropGraph, query, write } from '../graph_store/index.js';
import { category, EXISTING, link, NOTE, PROPOSAL, reply, setup } from './controller-fixture.test-util.js';
import type { PendingProposal } from './pending.js';

async function proposed(options: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ existing: EXISTING, ...options });
  const r = await s.controller.propose('notes', NOTE);
  if (!r.ok) throw new Error(`propose failed: ${JSON.stringify(r.error)}`);
  return { ...s, proposal: r.value as PendingProposal };
}
const counts = async (s: { inner: Parameters<typeof describeGraph>[0] }) => {
  const r = await describeGraph(s.inner, 'notes');
  if (!r.ok) throw new Error('describe failed');
  return r.value;
};

describe('approve', () => {
  it('applies the proposal with one write and returns what was written', async () => {
    const s = await proposed();
    const before = await counts(s);
    expect(before).toMatchObject({ itemCount: 1, categoryCount: 2, edgeCount: 1 });
    const writesBefore = s.recording.writes.length;
    const r = await s.controller.approve(s.proposal.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.proposal).toBe(s.proposal);
    expect(r.value.written).toEqual({ graphId: 'notes', applied: 4, graphCreated: false });
    expect(await counts(s)).toMatchObject({ itemCount: 2, categoryCount: 3, edgeCount: 3 });
    expect(s.recording.writes.length).toBeGreaterThan(writesBefore);
  });

  it('writes what the preview said: the new item, the new category and the links', async () => {
    const s = await proposed();
    await s.controller.approve(s.proposal.id);
    const q = await query(s.inner, {
      version: 1, graphId: 'notes', from: { partition: 'item', ids: ['note-1'] }, traverse: { depth: 1 },
      return: { shape: 'subgraph', includeData: true }, page: { limit: 50, cursor: null },
    });
    expect(q.ok && 'edges' in q.value && q.value.edges.map((e) => [e.item, e.category, e.weight])).toEqual([['note-1', 'appointments', 0.7], ['note-1', 'doctor-x', 0.9]]);
    expect(q.ok && 'nodes' in q.value && q.value.nodes.find((n) => n.id === 'doctor-x')?.data).toEqual({ name: 'Dr X' });
    expect(q.ok && 'nodes' in q.value && q.value.nodes.find((n) => n.id === 'note-1')?.data).toMatchObject({ title: 'Dr X visit' });
  });

  it('is a single transaction on the adapter', async () => {
    const s = await proposed();
    const before = s.recording.calls.filter((c) => c === 'transaction').length;
    await s.controller.approve(s.proposal.id);
    expect(s.recording.calls.filter((c) => c === 'transaction').length - before).toBe(1);
  });

  it('removes the proposal: it cannot be fetched or approved again', async () => {
    const s = await proposed();
    await s.controller.approve(s.proposal.id);
    expect(s.controller.get(s.proposal.id)).toBeUndefined();
  });

  it('approving twice writes once and reports PROPOSAL_NOT_FOUND the second time', async () => {
    const s = await proposed();
    expect((await s.controller.approve(s.proposal.id)).ok).toBe(true);
    const writes = s.recording.writes.length;
    const again = await s.controller.approve(s.proposal.id);
    expect(again).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'PROPOSAL_NOT_FOUND' } } });
    expect(s.recording.writes.length).toBe(writes);
    expect(await counts(s)).toMatchObject({ itemCount: 2, edgeCount: 3 });
  });

  it('two approvals at the same moment: one wins, one writes nothing', async () => {
    const reference = await proposed();
    const w0 = reference.recording.writes.length;
    await reference.controller.approve(reference.proposal.id);
    const oneApproval = reference.recording.writes.slice(w0);

    const s = await proposed();
    const start = s.recording.writes.length;
    const [a, b] = await Promise.all([s.controller.approve(s.proposal.id), s.controller.approve(s.proposal.id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
    expect(s.recording.writes.slice(start)).toEqual(oneApproval);
  });

  it('an unknown id is PROPOSAL_NOT_FOUND and writes nothing', async () => {
    const s = await proposed();
    const writes = s.recording.writes.length;
    for (const id of ['prop-nope', '', 'note-1']) {
      expect(await s.controller.approve(id)).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'PROPOSAL_NOT_FOUND' } } });
    }
    expect(await s.controller.approve(undefined as never)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
    expect(s.recording.writes.length).toBe(writes);
  });

  it('a proposal from another controller is not found', async () => {
    const a = await proposed();
    const b = await setup({ existing: EXISTING });
    expect(await b.controller.approve(a.proposal.id)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
  });
});

describe('approve: expiry', () => {
  it('an expired proposal is PROPOSAL_EXPIRED and writes nothing', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(1000);
    const writes = s.recording.writes.length;
    expect(await s.controller.approve(s.proposal.id)).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'PROPOSAL_EXPIRED' } } });
    expect(s.recording.writes.length).toBe(writes);
    expect(await counts(s)).toMatchObject({ itemCount: 1, edgeCount: 1 });
  });

  it('one millisecond before expiry it still works', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(999);
    expect((await s.controller.approve(s.proposal.id)).ok).toBe(true);
  });

  it('keeps saying expired, even after it has been looked at or swept away', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(5000);
    expect(s.controller.get(s.proposal.id)).toBeUndefined(); // dropped here
    for (let i = 0; i < 3; i++) {
      expect(await s.controller.approve(s.proposal.id)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_EXPIRED' } } });
    }
  });

  it('is told apart from an id that never existed', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(1000);
    expect(await s.controller.approve('prop-never-existed')).toMatchObject({ error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
  });

  it('a proposal that expires while its write is running still completes (the check is at the start)', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(999);
    const pending = s.controller.approve(s.proposal.id);
    s.clock.advance(5000);
    expect((await pending).ok).toBe(true);
  });
});

describe('approve: when the write fails', () => {
  it('a graph that has gone: the error is the graph store\'s, nothing changes, the proposal is kept and can be retried', async () => {
    const s = await proposed();
    await dropGraph(s.inner, 'notes');
    const writesBefore = s.recording.writes.length;
    const failed = await s.controller.approve(s.proposal.id);
    expect(failed).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'GRAPH_NOT_FOUND' } } });
    expect(s.recording.writes.length).toBe(writesBefore);
    expect(s.controller.get(s.proposal.id)).toBe(s.proposal);

    await createGraph(s.inner, 'notes');
    await write(s.inner, { version: 1, kind: 'mutation', graphId: 'notes', createIfMissing: false, ops: [category('appointments')] });
    expect((await s.controller.approve(s.proposal.id)).ok).toBe(true);
    expect(s.controller.get(s.proposal.id)).toBeUndefined();
  });

  it('the controller\'s graph options apply to the write: an operation limit refuses it, and the proposal is kept', async () => {
    const s = await proposed({ init: { graphOptions: { limits: { maxOps: 2 } } } }); // 4 operations
    const before = await counts(s);
    expect(await s.controller.approve(s.proposal.id)).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'VALIDATION_ERROR' } } });
    expect(await counts(s)).toEqual(before);
    expect(s.controller.get(s.proposal.id)).toBe(s.proposal);
  });

  it('is all or nothing: a mutation with a bad link writes none of its operations', async () => {
    const s = await proposed({ script: [reply({ ops: [PROPOSAL.ops[0], PROPOSAL.ops[1], PROPOSAL.ops[2], { op: 'link', item: 'note-1', category: 'ghost' }] })] });
    expect(s.proposal.summary.problems).toHaveLength(1);
    const before = await counts(s);
    const failed = await s.controller.approve(s.proposal.id);
    expect(failed).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'NODE_NOT_FOUND' } } });
    expect(await counts(s)).toEqual(before); // not even the item or doctor-x
    expect(s.controller.get(s.proposal.id)).toBe(s.proposal);
  });

  it('a failed proposal can still be rejected', async () => {
    const s = await proposed({ script: [reply({ ops: [PROPOSAL.ops[0], { op: 'link', item: 'note-1', category: 'ghost' }] })] });
    expect((await s.controller.approve(s.proposal.id)).ok).toBe(false);
    expect(s.controller.reject(s.proposal.id).ok).toBe(true);
    expect(s.controller.get(s.proposal.id)).toBeUndefined();
  });

  it('keeps the original expiry when put back', async () => {
    const s = await proposed({ init: { ttlMs: 1000 }, script: [reply({ ops: [PROPOSAL.ops[0], { op: 'link', item: 'note-1', category: 'ghost' }] })] });
    s.clock.advance(600);
    await s.controller.approve(s.proposal.id);
    expect(s.controller.get(s.proposal.id)?.expiresAt).toBe(s.proposal.expiresAt);
    s.clock.advance(400);
    expect(s.controller.get(s.proposal.id)).toBeUndefined();
  });

  it('a second approval during a failing one finds nothing, and the retry afterwards still can', async () => {
    const s = await proposed({ script: [reply({ ops: [PROPOSAL.ops[0], { op: 'link', item: 'note-1', category: 'ghost' }] })] });
    const [a, b] = await Promise.all([s.controller.approve(s.proposal.id), s.controller.approve(s.proposal.id)]);
    const codes = [a, b].map((r) => (r.ok ? 'ok' : r.error.error.code)).sort();
    expect(codes).toEqual(['NODE_NOT_FOUND', 'PROPOSAL_NOT_FOUND']);
    expect(s.controller.get(s.proposal.id)).toBe(s.proposal);
  });

  it('an adapter that fails mid-write: STORAGE_ERROR, nothing changes, the proposal is kept and a retry works', async () => {
    const down = { value: false };
    const s = await setup({
      existing: EXISTING,
      wrap: (inner) => ({ ...inner, transaction: (id, fn) => (down.value ? Promise.reject(new Error('disk on fire')) : inner.transaction(id, fn)) }),
    });
    const p = await s.controller.propose('notes', NOTE);
    if (!p.ok) throw new Error('expected a proposal');
    const before = await counts(s);
    down.value = true;
    const failed = await s.controller.approve(p.value.id);
    expect(failed).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    down.value = false;
    expect(await counts(s)).toEqual(before);
    expect(s.controller.get(p.value.id)).toBe(p.value);
    expect((await s.controller.approve(p.value.id)).ok).toBe(true);
  });
});

describe('reject', () => {
  it('discards the proposal without writing anything', async () => {
    const s = await proposed();
    const writes = s.recording.writes.length;
    const before = await counts(s);
    const r = s.controller.reject(s.proposal.id);
    expect(r).toEqual({ ok: true, value: s.proposal });
    expect(s.recording.writes.length).toBe(writes);
    expect(await counts(s)).toEqual(before);
    expect(s.controller.get(s.proposal.id)).toBeUndefined();
  });

  it('a rejected proposal cannot be approved', async () => {
    const s = await proposed();
    s.controller.reject(s.proposal.id);
    expect(await s.controller.approve(s.proposal.id)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
    expect(await counts(s)).toMatchObject({ itemCount: 1 });
  });

  it('rejecting twice, or an unknown id, is PROPOSAL_NOT_FOUND', async () => {
    const s = await proposed();
    expect(s.controller.reject(s.proposal.id).ok).toBe(true);
    expect(s.controller.reject(s.proposal.id)).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'PROPOSAL_NOT_FOUND' } } });
    expect(s.controller.reject('prop-nope')).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
  });

  it('an approved proposal cannot be rejected', async () => {
    const s = await proposed();
    await s.controller.approve(s.proposal.id);
    expect(s.controller.reject(s.proposal.id)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_NOT_FOUND' } } });
  });

  it('an expired proposal reports PROPOSAL_EXPIRED', async () => {
    const s = await proposed({ init: { ttlMs: 1000 } });
    s.clock.advance(1000);
    expect(s.controller.reject(s.proposal.id)).toMatchObject({ ok: false, error: { error: { code: 'PROPOSAL_EXPIRED' } } });
  });

  it('a full store refuses before the model is asked, so no paid call is wasted', async () => {
    const s = await setup({ existing: EXISTING, init: { maxPending: 1 } });
    expect((await s.controller.propose('notes', NOTE)).ok).toBe(true);
    const calls = s.client.callCount;
    expect(await s.controller.propose('notes', NOTE)).toMatchObject({ ok: false, error: { source: 'app', error: { code: 'TOO_MANY_PENDING' } } });
    expect(s.client.callCount).toBe(calls);
    expect(s.minted()).toBe(1);
  });

  it('frees room for another proposal', async () => {
    const script = [1, 2].map((n) => reply({ ops: [{ op: 'upsertNode', partition: 'item', id: `note-${n}` }, { op: 'link', item: `note-${n}`, category: 'errands' }] }));
    const s = await setup({ script, existing: EXISTING, init: { maxPending: 1 } });
    const a = await s.controller.propose('notes', NOTE);
    if (!a.ok) throw new Error('expected a proposal');
    expect((await s.controller.propose('notes', NOTE)).ok).toBe(false);
    s.controller.reject(a.value.id);
    expect((await s.controller.propose('notes', NOTE)).ok).toBe(true);
  });
});

describe('the whole flow, nothing written until approval', () => {
  it('propose, then approve: the graph changes only at approve', async () => {
    const s = await setup({ existing: [...EXISTING, link('older-note', 'errands')] });
    const before = await counts(s);
    const p = await s.controller.propose('notes', NOTE);
    if (!p.ok) throw new Error('expected a proposal');
    expect(await counts(s)).toEqual(before);
    expect((await s.controller.approve(p.value.id)).ok).toBe(true);
    expect(await counts(s)).not.toEqual(before);
  });
});
