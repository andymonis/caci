import { describe, expect, it } from 'vitest';
import type { Mutation } from '../graph_store/index.js';
import { createPendingStore, type NewProposal } from './pending.js';
import type { ProposalSummary } from './summary.js';

const SUMMARY: ProposalSummary = { newItems: [], updatedItems: [], newCategories: [], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [] };
const MUTATION: Mutation = { version: 1, kind: 'mutation', graphId: 'g', createIfMissing: false, ops: [] };
const proposal = (id: string): NewProposal => ({
  id, graphId: 'g', itemId: 'n', note: 'x', mutation: MUTATION, summary: SUMMARY, text: '', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', attempts: 1,
  context: { categoriesRead: 0, capped: false },
});
function make(options: { ttlMs?: number; maxPending?: number } = {}) {
  let clock = 100;
  const store = createPendingStore({ now: () => clock, ttlMs: options.ttlMs ?? 1000, maxPending: options.maxPending ?? 5 });
  return { store, advance: (ms: number) => void (clock += ms) };
}
const added = (r: ReturnType<ReturnType<typeof make>['store']['add']>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('the pending store', () => {
  it('holds a proposal with its times, frozen', () => {
    const { store } = make();
    const p = added(store.add(proposal('a')));
    expect(p).toMatchObject({ id: 'a', createdAt: 100, expiresAt: 1100 });
    expect(Object.isFrozen(p)).toBe(true);
    expect(store.get('a')).toBe(p);
  });

  it('refuses a duplicate id', () => {
    const { store } = make();
    store.add(proposal('a'));
    expect(store.add(proposal('a'))).toMatchObject({ ok: false, error: { code: 'UNEXPECTED' } });
  });

  it('take hands a proposal over once', () => {
    const { store } = make();
    const p = added(store.add(proposal('a')));
    expect(store.take('a')).toEqual({ state: 'found', proposal: p });
    expect(store.take('a')).toEqual({ state: 'unknown' });
    expect(store.get('a')).toBeUndefined();
  });

  it('take of an unknown id is unknown', () => {
    expect(make().store.take('zzz')).toEqual({ state: 'unknown' });
  });

  it('take of an expired proposal is expired, then stays expired', () => {
    const { store, advance } = make();
    store.add(proposal('a'));
    advance(1000);
    expect(store.take('a')).toEqual({ state: 'expired' });
    expect(store.take('a')).toEqual({ state: 'expired' });
  });

  it('remembers ids that expired and were swept by a later add', () => {
    const { store, advance } = make();
    store.add(proposal('a'));
    advance(5000);
    store.add(proposal('b'));
    expect(store.take('a')).toEqual({ state: 'expired' });
  });

  it('remembers ids that expired and were dropped by get', () => {
    const { store, advance } = make();
    store.add(proposal('a'));
    advance(1000);
    expect(store.get('a')).toBeUndefined();
    expect(store.take('a')).toEqual({ state: 'expired' });
  });

  it('forgets the oldest expired ids after 1,000 of them, so memory stays bounded', () => {
    const { store, advance } = make({ maxPending: 2000 });
    for (let i = 0; i < 1001; i++) store.add(proposal(`p${i}`));
    advance(5000);
    store.add(proposal('fresh')); // sweeps all 1,001
    expect(store.take('p0')).toEqual({ state: 'unknown' });
    expect(store.take('p1')).toEqual({ state: 'expired' });
    expect(store.take('p1000')).toEqual({ state: 'expired' });
  });

  it('restore puts a taken proposal back with its original expiry', () => {
    const { store, advance } = make();
    const p = added(store.add(proposal('a')));
    store.take('a');
    advance(500);
    store.restore(p);
    expect(store.get('a')).toBe(p);
    expect(store.get('a')?.expiresAt).toBe(1100);
  });

  it('a restored proposal that has meanwhile run out of time is reported as expired', () => {
    const { store, advance } = make();
    const p = added(store.add(proposal('a')));
    advance(1000);
    store.get('a'); // expired
    store.restore(p);
    advance(0);
    expect(store.take('a')).toEqual({ state: 'expired' }); // it is back but past its time, so reported expired again
  });

  it('restore may go one over the limit rather than lose a proposal', () => {
    const { store } = make({ maxPending: 1 });
    const p = added(store.add(proposal('a')));
    store.take('a');
    added(store.add(proposal('b')));
    store.restore(p);
    expect(store.get('a')).toBe(p);
    expect(store.get('b')).toBeDefined();
  });

  it('hasRoom says whether another would fit, counting only live proposals', () => {
    const { store, advance } = make({ maxPending: 1 });
    expect(store.hasRoom()).toBe(true);
    store.add(proposal('a'));
    expect(store.hasRoom()).toBe(false);
    advance(1000);
    expect(store.hasRoom()).toBe(true);
  });

  it('limits how many are held, counting only live ones', () => {
    const { store, advance } = make({ maxPending: 2 });
    store.add(proposal('a'));
    store.add(proposal('b'));
    expect(store.add(proposal('c'))).toMatchObject({ ok: false, error: { code: 'TOO_MANY_PENDING' } });
    store.take('a');
    expect(store.add(proposal('c')).ok).toBe(true);
    advance(1000);
    expect(store.add(proposal('d')).ok).toBe(true);
  });
});
