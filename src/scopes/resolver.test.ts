import { afterEach, describe, expect, it } from 'vitest';
import { CIRCLE_ROLES } from '../circles/index.js';
import { authoriseBrain, createScopeResolver, PERSONAL, type Scope } from './index.js';
import { cid, world, type World } from './scopes.test-util.js';

const kept: World[] = [];
afterEach(() => {
  for (const w of kept.splice(0)) w.dispose();
});
const make = (kind: 'memory' | 'sqlite') => {
  const w = world(kind);
  kept.push(w);
  return { w, r: createScopeResolver({ users: w.users as never, store: w.store }) };
};
const circle = (id: string): Scope => ({ kind: 'circle', circleId: id });
const fail = (r: { ok: boolean; error?: unknown }) => (r.ok ? undefined : r.error);
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('the access table', () => {
  it('every role reads; owner, manager and member capture; an observer reads and does not capture', () => {
    const expected: Record<string, [boolean, boolean]> = { owner: [true, true], manager: [true, true], member: [true, true], observer: [true, false] };
    for (const role of CIRCLE_ROLES) {
      expect([authoriseBrain(role, 'read'), authoriseBrain(role, 'capture')], role).toEqual(expected[role]);
    }
    expect(Object.keys(expected).sort()).toEqual([...CIRCLE_ROLES].sort());
  });

  it('anything not in the table is refused: unknown roles and actions, lookalikes, non-text values', () => {
    for (const role of [undefined, null, 5, '', 'admin', 'Owner', 'owner ', 'user', {}, ['owner'], '__proto__', 'constructor', 'toString']) {
      for (const action of ['read', 'capture']) expect(authoriseBrain(role, action), `${String(role)} ${action}`).toBe(false);
    }
    for (const action of [undefined, null, '', 'edit', 'delete', 'Read', 'read ', 5, {}, '__proto__']) expect(authoriseBrain('owner', action), String(action)).toBe(false);
  });
});

describe.each(['memory', 'sqlite'] as const)('resolving a scope over the %s circle store', (kind) => {
  it('personal is the caller\'s own graph, for both actions, and asks the circle store nothing', async () => {
    const { w, r } = make(kind);
    for (const action of ['read', 'capture'] as const) {
      const got = await r.resolve(w.token('ann'), PERSONAL, action);
      expect(got).toEqual({ ok: true, value: { userId: w.id('ann'), scope: { kind: 'personal' }, graphId: `user-${w.id('ann')}`, provenance: { kind: 'personal' } } });
    }
    expect(w.calls).toEqual([]);
    const own = await r.resolve(w.token('ann'), PERSONAL, 'read');
    expect(Object.isFrozen((own as { value: object }).value) && Object.isFrozen((own as { value: { provenance: object } }).value.provenance)).toBe(true);
  });

  it('a circle gives its graph, its provenance with the circle\'s name, and the person\'s role', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const got = await r.resolve(w.token('bob'), circle(c), 'capture');
    expect(got).toEqual({ ok: true, value: { userId: w.id('bob'), scope: { kind: 'circle', circleId: c }, graphId: `circle-${c}`, provenance: { kind: 'circle', circleId: c, circleName: 'Circle 1' }, role: 'member' } });
    expect(Object.isFrozen((got as { value: object }).value)).toBe(true);
  });

  it('owner, manager and member may capture and read; an observer may read and gets the one not-found for capture', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', [['bob', 'manager'], ['cat', 'member'], ['dan', 'observer']]);
    for (const who of ['ann', 'bob', 'cat']) {
      expect((await r.resolve(w.token(who), circle(c), 'read')).ok, who).toBe(true);
      expect((await r.resolve(w.token(who), circle(c), 'capture')).ok, who).toBe(true);
    }
    expect((await r.resolve(w.token('dan'), circle(c), 'read')).ok).toBe(true);
    expect(fail(await r.resolve(w.token('dan'), circle(c), 'capture'))).toEqual(NO_CIRCLE);
  });

  it('a stranger, a person in another circle only, a made-up circle and a malformed one all get the same answer', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    await w.circle(2, 'eve', []);
    const answers = [
      await r.resolve(w.token('cat'), circle(c), 'read'),
      await r.resolve(w.token('eve'), circle(c), 'read'),
      await r.resolve(w.token('bob'), circle(cid(9)), 'read'),
      await r.resolve(w.token('bob'), circle('c-not-an-id'), 'read'),
      await r.resolve(w.token('bob'), circle(c.toUpperCase()), 'read'),
      await r.resolve(w.token('bob'), { kind: 'circle', circleId: 5 as never }, 'read'),
    ];
    for (const a of answers) expect(a).toEqual({ ok: false, error: NO_CIRCLE });
  });

  it('the role is read on every call: a demotion, removal and promotion take effect at once', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    expect((await r.resolve(w.token('bob'), circle(c), 'capture')).ok).toBe(true);
    await w.store.changeRole(c, w.id('bob'), 'observer');
    expect(fail(await r.resolve(w.token('bob'), circle(c), 'capture'))).toEqual(NO_CIRCLE);
    expect((await r.resolve(w.token('bob'), circle(c), 'read')).ok).toBe(true);
    await w.store.changeRole(c, w.id('bob'), 'manager');
    expect((await r.resolve(w.token('bob'), circle(c), 'capture')).ok).toBe(true);
    await w.store.removeMember(c, w.id('bob'));
    expect(fail(await r.resolve(w.token('bob'), circle(c), 'read'))).toEqual(NO_CIRCLE);
    expect(w.calls.filter((x) => x === 'membershipOf')).toHaveLength(5);
  });

  it('a deleted circle reads as not found even for its former owner', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', []);
    await w.store.deleteCircle(c);
    expect(fail(await r.resolve(w.token('ann'), circle(c), 'read'))).toEqual(NO_CIRCLE);
  });

  it('a session that does not work is UNAUTHENTICATED and nothing else is asked', async () => {
    const { w, r } = make(kind);
    const c = await w.circle(1, 'ann', []);
    w.calls.length = 0;
    for (const token of [undefined, 'nope', 5, null, 'tok-zed']) {
      expect(await r.resolve(token, circle(c), 'read'), String(token)).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
      expect(await r.resolve(token, PERSONAL, 'read')).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    }
    w.forget('ann');
    expect(await r.resolve(w.token('ann'), circle(c), 'read')).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(w.calls).toEqual([]);
    expect(await r.who('tok-zed')).toMatchObject({ ok: false });
    expect(await r.who(w.token('bob'))).toEqual({ ok: true, value: w.id('bob') });
  });

  it('a scope that is not one of the two shapes is refused, and asks the circle store nothing', async () => {
    const { w, r } = make(kind);
    for (const bad of [undefined, null, 'personal', 5, {}, { kind: 'mine' }]) {
      expect(await r.resolve(w.token('ann'), bad as never, 'read'), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'scope' } });
    }
    expect(w.calls).toEqual([]);
  });
});

describe('failures are one fixed message', () => {
  const broken = (what: string) => {
    const w = world('memory');
    kept.push(w);
    const secret = 'disk exploded at /secret/path';
    const store = {
      membershipOf: async () => {
        if (what === 'membership') throw new Error(secret);
        return { circleId: cid(1), userId: w.id('ann'), role: 'owner', joinedAt: 1 };
      },
      getCircle: async () => {
        if (what === 'circle') throw new Error(secret);
        return undefined;
      },
    };
    return { w, r: createScopeResolver({ users: w.users as never, store: store as never }), secret };
  };

  it('a store that throws', async () => {
    for (const what of ['membership', 'circle']) {
      const { w, r, secret } = broken(what);
      const got = await r.resolve(w.token('ann'), circle(cid(1)), 'read');
      expect(got).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the scopes service could not complete the request' } });
      expect(JSON.stringify(got)).not.toContain(secret);
    }
  });

  it('a circle the store cannot find after membership is not found', async () => {
    const { w, r } = broken('none');
    expect(await r.resolve(w.token('ann'), circle(cid(1)), 'read')).toEqual({ ok: false, error: NO_CIRCLE });
  });

  it('a user service that throws, or answers with something other than "not signed in", is a storage failure and not a sign-out', async () => {
    const store = { membershipOf: async () => undefined, getCircle: async () => undefined };
    const throwing = createScopeResolver({ users: { resolve: async () => { throw new Error('x'); } } as never, store });
    expect(await throwing.resolve('t', PERSONAL, 'read')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    const odd = createScopeResolver({ users: { resolve: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'y' } }) } as never, store });
    expect(await odd.resolve('t', PERSONAL, 'read')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the scopes service could not complete the request' } });
    const badId = createScopeResolver({ users: { resolve: async () => ({ ok: true, value: { user: { id: 'nope' } } }) } as never, store });
    expect(await badId.resolve('t', PERSONAL, 'read')).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });

  it('construction needs both a user controller and a circle store', () => {
    expect(() => createScopeResolver({} as never)).toThrow(TypeError);
    expect(() => createScopeResolver({ users: { resolve: async () => ({}) } } as never)).toThrow(TypeError);
  });
});
