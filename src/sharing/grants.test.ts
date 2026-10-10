import { afterEach, describe, expect, it } from 'vitest';
import { createSharing } from './index.js';
import { cid, T0, world, type World } from './sharing.test-util.js';

const kept: World[] = [];
afterEach(() => {
  for (const w of kept.splice(0)) w.dispose();
});
async function make(kind: 'memory' | 'sqlite', extra: Parameters<typeof world>[1] = {}): Promise<World> {
  const w = await world(kind, extra);
  kept.push(w);
  return w;
}
const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const errorOf = (r: { ok: boolean; error?: { code: string; message: string; field?: string } }) => (r.ok ? undefined : r.error);

describe.each(['memory', 'sqlite'] as const)('grant management over the %s circle store', (kind) => {
  /** ann (owner), bob and cat (members) in circle 1, with a few categories of ann's own. */
  async function trio(extra: Parameters<typeof world>[1] = {}): Promise<{ w: World; circle: string }> {
    const w = await make(kind, extra);
    const circle = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'member']]);
    await w.seed('ann', { categories: { health: 'Health', travel: 'Travel', secret: 'Secret', plain: undefined }, items: [{ id: 'i1', under: ['health'] }] });
    return { w, circle };
  }

  describe('setting a grant', () => {
    it('shares chosen categories with one member, and the view names the person and the categories', async () => {
      const { w, circle } = await trio();
      w.now.value = T0 + 5;
      const r = must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['travel', 'health'] }));
      expect(r).toEqual({ userId: w.id('bob'), username: 'bob', displayName: 'Display bob', categories: [{ id: 'health', name: 'Health' }, { id: 'travel', name: 'Travel' }], updatedAt: T0 + 5 });
      const listed = must(await w.sharing.grants(w.token('ann'), circle));
      expect(listed.items).toEqual([r]);
      expect(listed.nextCursor).toBeNull();
      expect(Object.isFrozen(listed) && Object.isFrozen(listed.items) && Object.isFrozen(listed.items[0]) && Object.isFrozen(listed.items[0]?.categories)).toBe(true);
    });

    it('a category without a name is shown by id alone', async () => {
      const { w, circle } = await trio();
      const r = must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['plain'] }));
      expect(r?.categories).toEqual([{ id: 'plain' }]);
    });

    it('replaces the whole set, and an empty list withdraws and says nothing', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'travel'] });
      const second = must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['travel'] }));
      expect(second?.categories.map((c) => c.id)).toEqual(['travel']);
      expect(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: [] })).toEqual({ ok: true, value: undefined });
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items).toEqual([]);
    });

    it('collapses duplicates', async () => {
      const { w, circle } = await trio();
      const r = must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'health', 'health'] }));
      expect(r?.categories).toHaveLength(1);
    });

    it('every category must be one of the caller\'s own: unknown, someone else\'s, and an item are refused, and nothing changes', async () => {
      const { w, circle } = await trio();
      await w.seed('bob', { categories: { 'bobs-only': 'Bob' }, items: [{ id: 'bob-item', under: ['bobs-only'] }] });
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      for (const bad of [['nope'], ['health', 'nope'], ['bobs-only'], ['i1'], ['bob-item']]) {
        const e = errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: bad }));
        expect(e, JSON.stringify(bad)).toMatchObject({ code: 'INVALID_INPUT', field: 'categories' });
      }
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items[0]?.categories.map((c) => c.id)).toEqual(['health']);
      // bob's own category is bob's to share, and only bob's
      const bobs = must(await w.sharing.setGrant(w.token('bob'), circle, w.id('ann'), { categories: ['bobs-only'] }));
      expect(bobs?.categories.map((c) => c.id)).toEqual(['bobs-only']);
    });

    it('the message never repeats an id that was asked for', async () => {
      const { w, circle } = await trio();
      const e = errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['SECRET-CATEGORY-NAME'] }));
      expect(JSON.stringify(e)).not.toContain('SECRET-CATEGORY-NAME');
    });

    it('refuses ids that are empty, too long or not text, naming categories', async () => {
      const { w, circle } = await trio();
      for (const bad of [[''], ['x'.repeat(257)], [5], [null], 'health', undefined, {}]) {
        const e = errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: bad }));
        expect(e, JSON.stringify(bad)).toMatchObject({ code: 'INVALID_INPUT', field: 'categories' });
      }
    });

    it('at most 3 with that limit; exactly 3 is fine; the default is 200', async () => {
      const { w, circle } = await trio({ limits: { maxCategoriesPerGrant: 3 } });
      await w.seed('ann', { categories: { c1: 'One', c2: 'Two' } });
      expect(must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'c1', 'c2'] }))?.categories).toHaveLength(3);
      expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'c1', 'c2', 'travel'] }))?.code).toBe('LIMIT_REACHED');
      const big = await make(kind);
      const bigCircle = await big.circle(1, 'ann', [['bob', 'member']]);
      const ids = Array.from({ length: 201 }, (_, i) => `cat-${String(i).padStart(3, '0')}`);
      await big.seed('ann', { categories: Object.fromEntries(ids.map((id) => [id, id])) });
      expect(must(await big.sharing.setGrant(big.token('ann'), bigCircle, big.id('bob'), { categories: ids.slice(0, 200) }))?.categories).toHaveLength(200);
      expect(errorOf(await big.sharing.setGrant(big.token('ann'), bigCircle, big.id('bob'), { categories: ids }))?.code).toBe('LIMIT_REACHED');
    });

    it('opaque ids round-trip: spaces, capitals, markup, slashes, emoji, CJK and 256 characters', async () => {
      const { w, circle } = await trio();
      const ids = ['a/b?c=d&e#f %é😀<b>..', ' spaces ', 'Capitals', '日本語', 'x'.repeat(256)];
      await w.seed('ann', { categories: Object.fromEntries(ids.map((id) => [id, `n:${id.slice(0, 5)}`])) });
      const r = must(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ids }));
      expect(r?.categories.map((c) => c.id).sort()).toEqual([...ids].sort());
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items[0]?.categories).toHaveLength(5);
    });

    it('takes only `categories`: any other field is refused by name, and so is anything that is not an object', async () => {
      const { w, circle } = await trio();
      for (const key of ['graphId', 'owner', 'userId', 'categoryIds', 'x']) {
        const e = errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'], [key]: 'x' }));
        expect(e, key).toMatchObject({ code: 'INVALID_INPUT', field: key });
      }
      for (const bad of [undefined, null, 'health', 5, ['health'], true]) expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), bad))?.code, String(bad)).toBe('INVALID_INPUT');
      const long = 'k'.repeat(200);
      const e = errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'], [long]: 1 }));
      expect(JSON.stringify(e).length).toBeLessThan(300);
    });

    it('the owner always comes from the session: the caller can only share their own categories, never name another graph', async () => {
      const { w, circle } = await trio();
      await w.seed('cat', { categories: { 'cats-category': 'Cat' } });
      expect(errorOf(await w.sharing.setGrant(w.token('bob'), circle, w.id('cat'), { categories: ['health'] }))?.code).toBe('INVALID_INPUT'); // ann's category, not bob's
      expect(errorOf(await w.sharing.setGrant(w.token('bob'), circle, w.id('cat'), { categories: ['cats-category'] }))?.code).toBe('INVALID_INPUT');
    });

    it('a grant is one direction, and a role carries nothing: an observer may share and receive like anyone', async () => {
      const w = await make(kind);
      const circle = await w.circle(1, 'ann', [['bob', 'observer'], ['cat', 'manager']]);
      await w.seed('bob', { categories: { b: 'B' } });
      must(await w.sharing.setGrant(w.token('bob'), circle, w.id('ann'), { categories: ['b'] }));
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items).toEqual([]);
      expect(must(await w.sharing.grants(w.token('bob'), circle)).items.map((g) => g.userId)).toEqual([w.id('ann')]);
    });
  });

  describe('who may and may not', () => {
    it('a stranger, a made-up circle and a malformed id all get the one not-found; a non-member grantee gets "no such member"', async () => {
      const { w, circle } = await trio();
      const stranger = errorOf(await w.sharing.setGrant(w.token('dan'), circle, w.id('bob'), { categories: ['health'] }));
      const madeUp = errorOf(await w.sharing.setGrant(w.token('ann'), cid(99), w.id('bob'), { categories: ['health'] }));
      expect(stranger).toEqual({ code: 'NOT_FOUND', message: 'no such circle' });
      expect(madeUp).toEqual(stranger);
      for (const bad of ['', '../x', 5, null, undefined, 'C0000000000000001']) expect(errorOf(await w.sharing.setGrant(w.token('ann'), bad, w.id('bob'), { categories: ['health'] })), String(bad)).toEqual(stranger);
      for (const grantee of [w.id('dan'), 'u0000000000000099', 'nope', 5, null, undefined, '../x']) expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, grantee, { categories: ['health'] })), String(grantee)).toEqual({ code: 'NOT_FOUND', message: 'no such member' });
      expect(errorOf(await w.sharing.grants(w.token('dan'), circle))).toEqual(stranger);
      expect(errorOf(await w.sharing.withdraw(w.token('dan'), circle, w.id('bob')))).toEqual(stranger);
    });

    it('a grant to oneself is refused, naming granteeId', async () => {
      const { w, circle } = await trio();
      expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('ann'), { categories: ['health'] }))).toMatchObject({ code: 'INVALID_INPUT', field: 'granteeId' });
    });

    it('a member of another circle only is not a member of this one', async () => {
      const { w, circle } = await trio();
      await w.circle(2, 'dan', [['eve', 'member']]);
      expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('eve'), { categories: ['health'] }))?.code).toBe('NOT_FOUND');
      expect(errorOf(await w.sharing.setGrant(w.token('ann'), cid(2), w.id('eve'), { categories: ['health'] }))?.code).toBe('NOT_FOUND');
    });

    it('needs a session: none, a made-up token, a forgotten account, and nothing is asked of the graph', async () => {
      const { w, circle } = await trio();
      for (const token of [undefined, null, '', 'nope', 5, {}]) {
        expect(errorOf(await w.sharing.setGrant(token, circle, w.id('bob'), { categories: ['health'] }))?.code, String(token)).toBe('UNAUTHENTICATED');
        expect(errorOf(await w.sharing.grants(token, circle))?.code).toBe('UNAUTHENTICATED');
        expect(errorOf(await w.sharing.withdraw(token, circle, w.id('bob')))?.code).toBe('UNAUTHENTICATED');
      }
      w.forget('ann');
      expect(errorOf(await w.sharing.grants(w.token('ann'), circle))?.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('what I share', () => {
    it('lists one entry per member by user id, in pages, and not other circles, other owners or other people\'s shares', async () => {
      const w = await make(kind);
      const circle = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'member'], ['dan', 'member']]);
      const other = await w.circle(2, 'ann', [['bob', 'member']]);
      await w.seed('ann', { categories: { a: 'A', b: 'B' } });
      await w.seed('bob', { categories: { x: 'X' } });
      for (const name of ['dan', 'bob', 'cat']) await w.sharing.setGrant(w.token('ann'), circle, w.id(name), { categories: ['a'] });
      await w.sharing.setGrant(w.token('ann'), other, w.id('bob'), { categories: ['b'] });
      await w.sharing.setGrant(w.token('bob'), circle, w.id('cat'), { categories: ['x'] });
      const first = must(await w.sharing.grants(w.token('ann'), circle, { limit: 2 }));
      expect(first.items.map((g) => g.userId)).toEqual([w.id('bob'), w.id('cat')]);
      expect(first.nextCursor).not.toBeNull();
      const second = must(await w.sharing.grants(w.token('ann'), circle, { limit: 2, cursor: first.nextCursor }));
      expect(second.items.map((g) => g.userId)).toEqual([w.id('dan')]);
      expect(second.nextCursor).toBeNull();
      expect(must(await w.sharing.grants(w.token('ann'), other)).items.map((g) => g.categories[0]?.id)).toEqual(['b']);
    });

    it('refuses a bad limit and a cursor it did not give, naming the field', async () => {
      const { w, circle } = await trio();
      for (const limit of [0, 101, 1.5, -1, '5' as unknown as number]) expect(errorOf(await w.sharing.grants(w.token('ann'), circle, { limit })), String(limit)).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
      expect(errorOf(await w.sharing.grants(w.token('ann'), circle, { cursor: 'not-a-cursor' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
      expect(errorOf(await w.sharing.grants(w.token('ann'), circle, { cursor: 5 as unknown as string }))).toMatchObject({ code: 'INVALID_INPUT', field: 'cursor' });
    });

    it('a shared category that no longer exists in the graph is simply not shown', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'travel'] });
      const { write } = await import('../graph_store/index.js');
      expect((await write(w.graphs, { version: 1, kind: 'mutation', graphId: w.graphOf('ann'), ops: [{ op: 'deleteNode', partition: 'category', id: 'travel' }] } as never)).ok).toBe(true);
      w.writes.length = 0;
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items[0]?.categories.map((c) => c.id)).toEqual(['health']);
    });

    it('a grantee whose account is gone from the directory is shown without names', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      const bobId = w.id('bob');
      w.forget('bob');
      const item = must(await w.sharing.grants(w.token('ann'), circle)).items[0];
      expect(item?.userId).toBe(bobId);
      expect(item?.username).toBeUndefined();
      expect(item?.displayName).toBeUndefined();
    });
  });

  describe('withdrawing and leaving', () => {
    it('withdraw removes one grant, says whether there was one, and leaves the others', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      await w.sharing.setGrant(w.token('ann'), circle, w.id('cat'), { categories: ['travel'] });
      expect(must(await w.sharing.withdraw(w.token('ann'), circle, w.id('bob')))).toBe(true);
      expect(must(await w.sharing.withdraw(w.token('ann'), circle, w.id('bob')))).toBe(false);
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items.map((g) => g.userId)).toEqual([w.id('cat')]);
      for (const bad of ['nope', 5, null, undefined, '../x', w.id('dan')]) expect(must(await w.sharing.withdraw(w.token('ann'), circle, bad)), String(bad)).toBe(false);
    });

    it('only the owner can withdraw what they shared: another member\'s withdraw touches nothing', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      expect(must(await w.sharing.withdraw(w.token('bob'), circle, w.id('ann')))).toBe(false); // bob's own (empty) share with ann
      expect(must(await w.sharing.withdraw(w.token('cat'), circle, w.id('bob')))).toBe(false);
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items).toHaveLength(1);
    });

    it('when the person leaves, the share goes with them and cannot be set again', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      await w.store.removeMember(circle, w.id('bob'));
      expect(must(await w.sharing.grants(w.token('ann'), circle)).items).toEqual([]);
      expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] }))).toEqual({ code: 'NOT_FOUND', message: 'no such member' });
    });

    it('when the owner leaves, they cannot reach the circle, and their shares are gone', async () => {
      const { w, circle } = await trio();
      await w.sharing.setGrant(w.token('bob'), circle, w.id('cat'), { categories: [] });
      await w.seed('bob', { categories: { b: 'B' } });
      await w.sharing.setGrant(w.token('bob'), circle, w.id('cat'), { categories: ['b'] });
      await w.store.removeMember(circle, w.id('bob'));
      expect(errorOf(await w.sharing.grants(w.token('bob'), circle))).toEqual({ code: 'NOT_FOUND', message: 'no such circle' });
      expect(await w.store.getGrant(circle, w.id('bob'), w.id('cat'))).toBeUndefined();
    });
  });

  describe('it only ever reads', () => {
    it('no write primitive is called by any grant operation, successful or refused', async () => {
      const { w, circle } = await trio();
      w.writes.length = 0;
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health', 'nope'] });
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] });
      await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: [] });
      await w.sharing.setGrant(w.token('dan'), circle, w.id('bob'), { categories: ['health'] });
      await w.sharing.grants(w.token('ann'), circle);
      await w.sharing.withdraw(w.token('ann'), circle, w.id('bob'));
      expect(w.writes).toEqual([]);
    });
  });

  describe('failures', () => {
    it('anything that breaks inside is one fixed message, never the thrown text', async () => {
      const { w, circle } = await trio();
      const secret = 'ENOENT /var/secret/path SELECT * FROM x';
      const boom = (): never => {
        throw new Error(secret);
      };
      const broken = {
        store: { ...w.store, membershipOf: boom },
        users: { resolve: boom },
        graphs: { ...w.graphs, transaction: boom },
      };
      const make3 = (over: Partial<Parameters<typeof createSharing>[0]>) => createSharing({ users: { resolve: async () => ({ ok: true, value: { user: { id: w.id('ann'), username: 'ann' } } }) as never }, directory: { get: async () => undefined }, store: w.store, graphAdapter: w.graphs, ...over });
      const cases = [make3({ store: broken.store }), make3({ users: broken.users }), make3({ store: { ...w.store, listGrantsBy: boom } }), make3({ store: { ...w.store, setGrant: boom } }), make3({ graphAdapter: broken.graphs })];
      const results = [
        await cases[0]?.grants(w.token('ann'), circle),
        await cases[1]?.grants(w.token('ann'), circle),
        await cases[2]?.grants(w.token('ann'), circle),
        await cases[3]?.setGrant(w.token('ann'), circle, w.id('bob'), { categories: [] }),
        await cases[4]?.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] }),
      ];
      for (const r of results) {
        expect(r?.ok).toBe(false);
        expect(JSON.stringify(r)).not.toContain('secret');
        expect(r && !r.ok ? r.error : undefined).toEqual({ code: 'STORAGE_ERROR', message: 'the sharing service could not complete the request' });
      }
    });

    it('a user service that answers with something other than "not signed in" is a storage failure, not a sign-out', async () => {
      const { w, circle } = await trio();
      const s = createSharing({ users: { resolve: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the user database is locked' } }) as never }, directory: { get: async () => undefined }, store: w.store, graphAdapter: w.graphs });
      expect(await s.grants('any-token', circle)).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the sharing service could not complete the request' } });
    });

    it('a store that reports a storage error in its own words is replaced by the fixed message', async () => {
      const { w, circle } = await trio();
      const s = createSharing({ users: { resolve: async () => ({ ok: true, value: { user: { id: w.id('ann'), username: 'ann' } } }) as never }, directory: { get: async () => undefined }, store: { ...w.store, setGrant: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'database is locked at /var/x/users.db' } }) as never }, graphAdapter: w.graphs });
      const r = await s.setGrant(w.token('ann'), circle, w.id('bob'), { categories: [] });
      expect(r).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the sharing service could not complete the request' } });
    });
  });

  it('a graph that is missing holds no categories, so nothing can be shared from it', async () => {
    const w = await make(kind, { people: ['ann', 'bob'] });
    const circle = await w.circle(1, 'ann', [['bob', 'member']]);
    const { dropGraph } = await import('../graph_store/index.js');
    await dropGraph(w.graphs, w.graphOf('ann'));
    expect(errorOf(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: ['health'] }))?.code).toBe('INVALID_INPUT');
    expect(await w.sharing.setGrant(w.token('ann'), circle, w.id('bob'), { categories: [] })).toEqual({ ok: true, value: undefined });
  });
});

describe('construction', () => {
  it('needs a user controller, a directory, a store and a graph adapter, and sensible limits', async () => {
    const w = await make('memory');
    const ok = { users: { resolve: async () => ({}) as never }, directory: { get: async () => undefined }, store: w.store, graphAdapter: w.graphs };
    expect(() => createSharing(ok)).not.toThrow();
    for (const bad of [{}, { ...ok, users: {} }, { ...ok, directory: {} }, { ...ok, store: undefined }, { ...ok, graphAdapter: undefined }]) expect(() => createSharing(bad as never)).toThrow(TypeError);
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => createSharing({ ...ok, limits: { maxCategoriesPerGrant: limit } })).toThrow(TypeError);
  });
});
