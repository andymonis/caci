import { describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { dropGraph, write } from '../graph_store/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { createCaciController } from './index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const circleScope = (circleId: string) => ({ kind: 'circle', circleId });
const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };
const SAME = 'same-id'; // the id used in every graph, with different contents
const ITEM = 'same-item';
const uid = (w: World, name: string) => (w.graphIds[name] as string).slice(5);

/** One category and one item, with the same ids in every graph and a label that says whose they are. */
async function fill(w: World, graphId: string, label: string, extraItems: string[] = []) {
  const ops: unknown[] = [
    { op: 'upsertNode', partition: 'category', id: SAME, data: { name: `Category of ${label}` } },
    { op: 'upsertNode', partition: 'item', id: ITEM, data: { title: `Item of ${label}`, summary: label } },
    { op: 'link', item: ITEM, category: SAME, weight: 0.5 },
  ];
  for (const id of extraItems) {
    ops.push({ op: 'upsertNode', partition: 'item', id, data: { title: id } }, { op: 'link', item: id, category: SAME });
  }
  must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops } as never));
}
async function setup(extra: Parameters<typeof world>[0] = {}) {
  const w = await world({ people: ['root', 'ann', 'bob', 'cat', 'dan'], ...extra });
  const a = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  const b = await w.circle(2, 'ann');
  await fill(w, w.graphIds.bob as string, 'PERSONAL-BOB');
  await fill(w, `circle-${a}`, 'CIRCLE-A');
  await fill(w, `circle-${b}`, 'CIRCLE-B');
  return { w, a, b };
}

describe('browsing with no scope or the personal scope is what it always was', () => {
  it('the same answers, no scope key, and nothing from any circle', async () => {
    const { w } = await setup();
    for (const scope of [undefined, { kind: 'personal' }]) {
      const s = must(await w.caci.summary(w.tokens.bob, scope));
      expect(s).toEqual({ itemCount: 1, categoryCount: 1, edgeCount: 1 });
      const cats = must(await w.caci.categories(w.tokens.bob, undefined, scope));
      expect(cats.items.map((c) => c.name)).toEqual(['Category of PERSONAL-BOB']);
      expect('scope' in cats).toBe(false);
      const items = must(await w.caci.categoryItems(w.tokens.bob, SAME, undefined, scope));
      expect(items.items.map((i) => i.data.summary)).toEqual(['PERSONAL-BOB']);
      expect('scope' in items).toBe(false);
      const item = must(await w.caci.item(w.tokens.bob, ITEM, scope));
      expect(item.item.data.summary).toBe('PERSONAL-BOB');
      expect('scope' in item).toBe(false);
    }
  });
});

describe('browsing one circle', () => {
  it('shows only that circle, names it, and the same ids in the personal graph and the other circle never cross', async () => {
    const { w, a, b } = await setup();
    const provenance = (id: string, name: string) => ({ kind: 'circle', circleId: id, circleName: name });
    for (const [id, name, label] of [[a, 'Circle 1', 'CIRCLE-A'], [b, 'Circle 2', 'CIRCLE-B']] as const) {
      const scope = circleScope(id);
      const who = id === a ? 'bob' : 'ann';
      const s = must(await w.caci.summary(w.tokens[who], scope));
      expect(s).toMatchObject({ itemCount: 1, categoryCount: 1, edgeCount: 1, scope: provenance(id, name) });
      const cats = must(await w.caci.categories(w.tokens[who], undefined, scope));
      expect(cats.items.map((c) => [c.id, c.name, c.itemCount])).toEqual([[SAME, `Category of ${label}`, 1]]);
      expect(cats.scope).toEqual(provenance(id, name));
      const items = must(await w.caci.categoryItems(w.tokens[who], SAME, undefined, scope));
      expect(items.items.map((i) => i.data.summary)).toEqual([label]);
      expect(items.scope).toEqual(provenance(id, name));
      const item = must(await w.caci.item(w.tokens[who], ITEM, scope));
      expect(item.item.data.summary).toBe(label);
      expect(item.categories.map((c) => c.name)).toEqual([`Category of ${label}`]);
      expect(item.scope).toEqual(provenance(id, name));
      expect(JSON.stringify([s, cats, items, item])).not.toContain('PERSONAL-BOB');
    }
  });

  it('every reading role may browse it (an observer included), and the results are frozen', async () => {
    const { w, a } = await setup();
    for (const who of ['ann', 'bob', 'cat']) {
      const r = await w.caci.categories(w.tokens[who], undefined, circleScope(a));
      expect(r.ok, who).toBe(true);
      expect(Object.isFrozen(must(r))).toBe(true);
    }
  });

  it('a stranger, an administrator who is not a member, a person in another circle only and a made-up circle all get the identical answer, from every call', async () => {
    const { w, a } = await setup();
    const calls = (token: string, scope: unknown) => [w.caci.summary(token, scope), w.caci.categories(token, undefined, scope), w.caci.categoryItems(token, SAME, undefined, scope), w.caci.item(token, ITEM, scope)];
    const missing = await Promise.all(calls(w.tokens.ann as string, circleScope('c9999999999999999')));
    for (const m of missing) expect(m).toEqual({ ok: false, error: NO_CIRCLE });
    for (const who of ['root', 'dan']) {
      for (const [i, r] of (await Promise.all(calls(w.tokens[who] as string, circleScope(a)))).entries()) expect(r, `${who} call ${i}`).toEqual({ ok: false, error: NO_CIRCLE });
    }
  });

  it('a removal or a demotion to observer, a promotion and a deleted circle take effect on the next request', async () => {
    const { w, a } = await setup();
    const read = async (who: string) => (await w.caci.summary(w.tokens[who], circleScope(a))).ok;
    expect(await read('dan')).toBe(false);
    await w.circleStore.createInvitation({ id: 'i0000000000000099', circleId: a, username: 'dan', role: 'observer', invitedBy: uid(w, 'ann'), createdAt: 1, expiresAt: 9e12 }, { maxOpenInvitationsPerCircle: 100 }, 2);
    await w.circleStore.acceptInvitation('i0000000000000099', uid(w, 'dan'), 'dan', 3, { maxCirclesPerUser: 100, maxMembersPerCircle: 100 });
    expect(await read('dan')).toBe(true);
    must(await w.circleStore.changeRole(a, uid(w, 'dan'), 'member'));
    expect(await read('dan')).toBe(true);
    must(await w.circleStore.removeMember(a, uid(w, 'dan')));
    expect(await read('dan')).toBe(false);
    expect(await read('bob')).toBe(true);
    await w.circleStore.deleteCircle(a);
    expect(await read('bob')).toBe(false);
  });

  it('a malformed scope is refused naming its field; a graph id in a scope is refused by name', async () => {
    const { w, a } = await setup();
    expect(ownErrorOf(await w.caci.summary(w.tokens.bob, { kind: 'circle', circleId: 'x' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.circleId' });
    expect(ownErrorOf(await w.caci.categories(w.tokens.bob, undefined, { kind: 'circle', circleId: a, graphId: `circle-${a}` }))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.graphId' });
    expect(ownErrorOf(await w.caci.item(w.tokens.bob, ITEM, 'circle'))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(ownErrorOf(await w.caci.categoryItems(w.tokens.bob, SAME, undefined, { kind: 'mine' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
  });

  it('a signed-out caller is unauthenticated for every call, with or without a scope', async () => {
    const { w, a } = await setup();
    for (const scope of [undefined, circleScope(a)]) {
      for (const r of [await w.caci.summary('nope', scope), await w.caci.categories('nope', undefined, scope), await w.caci.categoryItems('nope', SAME, undefined, scope), await w.caci.item('nope', ITEM, scope)]) {
        expect(ownErrorOf(r)).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
    }
  });

  it('without a scope resolver, a circle is simply not found', async () => {
    const { w, a } = await setup();
    const capture = createController({ adapter: w.graphs, llm: createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() }) });
    const bare = createCaciController({ users: w.users, capture, graphAdapter: w.graphs });
    expect(await bare.summary(w.tokens.bob, circleScope(a))).toEqual({ ok: false, error: NO_CIRCLE });
    expect((await bare.summary(w.tokens.bob)).ok).toBe(true);
  });

  it('ids stay opaque: awkward ids work in a circle, and an id that exists only in another scope is not found', async () => {
    const { w, a } = await setup();
    const odd = ['a b', 'A/B?c=d&e#f', '100%', '<b>x</b>', '😀', '..'];
    await fill(w, `circle-${a}`, 'ODD', odd);
    for (const id of odd) {
      expect(must(await w.caci.item(w.tokens.bob, id, circleScope(a))).item.id).toBe(id);
    }
    await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphIds.bob, ops: [{ op: 'upsertNode', partition: 'item', id: 'only-personal', data: { title: 'p' } }] } as never);
    expect(ownErrorOf(await w.caci.item(w.tokens.bob, 'only-personal', circleScope(a)))).toMatchObject({ code: 'NOT_FOUND' });
    expect(must(await w.caci.item(w.tokens.bob, 'only-personal')).item.id).toBe('only-personal');
  });

  it('paging works inside a circle, and a cursor from one scope is refused in another', async () => {
    const { w, a, b } = await setup();
    await fill(w, `circle-${a}`, 'MANY', Array.from({ length: 7 }, (_, i) => `i${i}`));
    const first = must(await w.caci.categoryItems(w.tokens.bob, SAME, { limit: 3 }, circleScope(a)));
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const rest = must(await w.caci.categoryItems(w.tokens.bob, SAME, { limit: 10, cursor: first.nextCursor }, circleScope(a)));
    expect(rest.items.length + first.items.length).toBe(8);
    expect(ownErrorOf(await w.caci.categoryItems(w.tokens.ann, SAME, { limit: 3, cursor: first.nextCursor }, circleScope(b)))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    expect(ownErrorOf(await w.caci.categoryItems(w.tokens.bob, SAME, { limit: 3, cursor: first.nextCursor }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
  });

  it('a circle whose graph is missing reads as a graph error, never as someone else\'s data', async () => {
    const { w, a } = await setup();
    await dropGraph(w.graphs, `circle-${a}`);
    expect(await w.caci.summary(w.tokens.bob, circleScope(a))).toMatchObject({ ok: false, error: { source: 'graph' } });
  });

  it('a store failure is the fixed storage error', async () => {
    const { w, a } = await setup();
    w.circleStore.membershipOf = async () => {
      throw new Error('disk /secret');
    };
    const r = await w.caci.summary(w.tokens.bob, circleScope(a));
    expect(r).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('what a person captured into a circle is readable there with who added it', async () => {
    const { w } = await setup();
    const c = await w.circle(3, 'ann', [['bob', 'member'], ['cat', 'observer']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: 'Dr Patel booked my blood test', scope: circleScope(c) }));
    must(await w.caci.approve(w.tokens.bob, made.id));
    const cats = must(await w.caci.categories(w.tokens.cat, undefined, circleScope(c)));
    expect(cats.items.length).toBeGreaterThan(0);
    const items = must(await w.caci.categoryItems(w.tokens.cat, cats.items[0]?.id, undefined, circleScope(c)));
    expect(items.items[0]?.data.contributedBy).toBe(uid(w, 'bob'));
  });
});
