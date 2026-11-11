import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMember, code, must, T0, world } from './controller.test-util.js';
import { createMemoryCircleStore } from './memory-store.js';
import type { CircleStore } from './store.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ann = 'tok-ann';
const bob = 'tok-bob';
const cat = 'tok-cat';
const dan = 'tok-dan';
const eve = 'tok-eve';
const fay = 'tok-fay';
const TOKEN = /^cjoin_[A-Za-z0-9_-]{43}$/;
const NO_LINK = { ok: false, error: { code: 'NOT_FOUND', message: 'no such join link' } };
const NO_CIRCLE = { ok: false, error: { code: 'NOT_FOUND', message: 'no such circle' } };

/** A circle owned by ann with bob (manager), cat (member), dan (observer). */
async function team(extra: Parameters<typeof world>[0] = {}) {
  const w = world(extra);
  const made = await must(w.controller.create(ann, { name: 'Team' }));
  await addMember(w, made.id, 'bob', 'manager');
  await addMember(w, made.id, 'cat', 'member');
  await addMember(w, made.id, 'dan', 'observer');
  return { w, id: made.id };
}
type W = ReturnType<typeof world>;
const link = async (w: W, id: string, input: Record<string, unknown> = {}, as = ann) => must(w.controller.createJoinLink(as, id, { label: 'Club chat', ...input }));
const links = async (w: W, id: string, as = ann) => (await must(w.controller.listJoinLinks(as, id, { limit: 100 }))).items;
const uses = async (w: W, id: string): Promise<number[]> => (await links(w, id)).map((l) => l.uses);

describe('making a link', () => {
  it('has the defaults: observer, 7 days, one use, approval on; the token is shown once and has its shape', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    expect(made.token).toMatch(TOKEN);
    expect(made.link).toMatchObject({ role: 'observer', label: 'Club chat', maxUses: 1, uses: 0, approval: true, createdAt: T0, expiresAt: T0 + 7 * DAY });
    expect(made.link.createdBy).toEqual({ userId: w.id('ann'), displayName: 'DISPLAY ANN' });
    expect(Object.keys(made).sort()).toEqual(['link', 'token']);
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.link)).toBe(true);
    expect(JSON.stringify(made.link)).not.toContain(made.token);
  });

  it('honours every option, trims the label, and makes a different token each time', async () => {
    const { w, id } = await team();
    const a = await link(w, id, { label: '  Neighbours  ', role: 'member', days: 30, uses: 100, approval: false });
    expect(a.link).toMatchObject({ role: 'member', label: 'Neighbours', maxUses: 100, approval: false, expiresAt: T0 + 30 * DAY });
    const b = await link(w, id, { role: 'observer', days: 1, uses: 2 });
    expect(b.link).toMatchObject({ role: 'observer', maxUses: 2, expiresAt: T0 + DAY });
    expect(a.token).not.toBe(b.token);
    expect(a.link.id).not.toBe(b.link.id);
  });

  it('only the hash reaches the store, never the token', async () => {
    const real = createMemoryCircleStore();
    const seen: unknown[] = [];
    const spy: CircleStore = { ...real, createJoinLink: async (...args) => (seen.push(args), real.createJoinLink(...args)) };
    const { w, id } = await team({ store: spy });
    const made = await link(w, id);
    expect(seen).toHaveLength(1);
    const record = (seen[0] as [Record<string, unknown>])[0];
    expect(record.tokenHash).toBe(createHash('sha256').update(made.token).digest('hex'));
    expect(JSON.stringify(seen)).not.toContain(made.token);
    expect(JSON.stringify(seen)).not.toContain(made.token.slice(6));
    expect(Object.keys(record)).not.toContain('token');
  });

  it('a manager may make one; a member and an observer may not, and permission comes before the input is looked at', async () => {
    const { w, id } = await team();
    expect((await link(w, id, {}, bob)).link.createdBy.userId).toBe(w.id('bob'));
    for (const token of [cat, dan]) {
      expect(await code(w.controller.createJoinLink(token, id, { label: 'x' }))).toBe('FORBIDDEN');
      expect(await code(w.controller.createJoinLink(token, id, { garbage: true }))).toBe('FORBIDDEN');
      expect(await code(w.controller.createJoinLink(token, id, undefined))).toBe('FORBIDDEN');
    }
    expect(await links(w, id)).toHaveLength(1);
  });

  it('a stranger, a made-up circle, a malformed id and a non-text id all get the one no-such-circle answer, for every join link method', async () => {
    const { w, id } = await team();
    for (const circle of [id, 'c0000000000000000', 'nonsense', '', 42, null, undefined, {}]) {
      const asEve = circle === id;
      const answers = [
        await w.controller.createJoinLink(eve, circle, { label: 'x' }),
        await w.controller.listJoinLinks(eve, circle),
        await w.controller.revokeJoinLink(eve, circle, 'j0000000000000000'),
      ];
      for (const a of answers) expect(a, `${String(circle)} ${asEve}`).toEqual(NO_CIRCLE);
    }
    expect(await links(w, id)).toEqual([]);
  });

  it('refuses a role other than member or observer, naming the field', async () => {
    const { w, id } = await team();
    for (const role of ['owner', 'manager', 'admin', '', 5, null, 'MEMBER']) {
      const r = await w.controller.createJoinLink(ann, id, { label: 'x', role });
      expect(r, String(role)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'role' } });
    }
    expect(await links(w, id)).toEqual([]);
  });

  it('checks the days, uses, approval and label, each naming its field, and refuses unknown fields', async () => {
    const { w, id } = await team();
    const field = async (input: unknown): Promise<string | undefined> => {
      const r = await w.controller.createJoinLink(ann, id, input);
      return r.ok ? undefined : r.error.field;
    };
    for (const days of [0, 31, 1.5, '7', null, Number.NaN]) expect(await field({ label: 'x', days }), `days ${String(days)}`).toBe('days');
    for (const n of [0, 101, 2.5, '1', null]) expect(await field({ label: 'x', uses: n }), `uses ${String(n)}`).toBe('uses');
    for (const approval of ['yes', 1, 0, null, 'true']) expect(await field({ label: 'x', approval }), `approval ${String(approval)}`).toBe('approval');
    for (const label of [undefined, '', '   ', 'x'.repeat(81), 'a\nb', 'a\u0000b', 7, null]) expect(await field({ label }), `label ${String(label)}`).toBe('label');
    expect(await field({ label: 'x'.repeat(80) })).toBeUndefined();
    expect(await field({ label: '😀'.repeat(80) })).toBeUndefined();
    expect(await field({ label: '😀'.repeat(81) })).toBe('label');
    expect(await field({ label: 'x', token: 'cjoin_x' })).toBe('token');
    expect(await field({ label: 'x', circleId: 'c1' })).toBe('circleId');
    expect(await field(undefined)).toBe('body');
    expect(await field([])).toBe('body');
    expect(await field({ label: 'x', days: 1 })).toBeUndefined();
    expect(await field({ label: 'x', days: 30, uses: 100 })).toBeUndefined();
  });

  it('a circle may have only so many live links; dead ones do not count', async () => {
    const { w, id } = await team({ limits: { maxLiveJoinLinksPerCircle: 2 } });
    await link(w, id, { days: 1 });
    await link(w, id);
    expect(await code(w.controller.createJoinLink(ann, id, { label: 'x' }))).toBe('LIMIT_REACHED');
    w.now.value = T0 + 2 * DAY; // the first has expired
    await link(w, id);
    expect(await links(w, id)).toHaveLength(2);
  });

  it('the role is read afresh: a demoted manager cannot make a link', async () => {
    const { w, id } = await team();
    await link(w, id, {}, bob);
    await must(w.controller.changeRole(ann, id, w.id('bob'), { role: 'member' }));
    expect(await code(w.controller.createJoinLink(bob, id, { label: 'x' }))).toBe('FORBIDDEN');
  });

  it('a signed-out request is refused as that and touches nothing', async () => {
    const { w, id } = await team();
    expect(await code(w.controller.createJoinLink('nonsense', id, { label: 'x' }))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.listJoinLinks(undefined, id))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.revokeJoinLink(7, id, 'x'))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.previewJoin('nonsense', { token: 'x' }))).toBe('UNAUTHENTICATED');
    expect(await code(w.controller.join(null, { token: 'x' }))).toBe('UNAUTHENTICATED');
  });
});

describe('listing and revoking', () => {
  it('owners and managers see live links without tokens, with uses and who made them; members and observers cannot', async () => {
    const { w, id } = await team();
    const one = await link(w, id, { label: 'One', uses: 3, approval: false });
    await link(w, id, { label: 'Two' }, bob);
    await must(w.controller.join(eve, { token: one.token }));
    const listed = await links(w, id);
    expect(listed.map((l) => [l.label, l.uses, l.maxUses, l.approval])).toEqual(expect.arrayContaining([['One', 1, 3, false], ['Two', 0, 1, true]]));
    expect(listed.find((l) => l.label === 'Two')?.createdBy).toEqual({ userId: w.id('bob'), displayName: 'DISPLAY BOB' });
    expect(JSON.stringify(listed)).not.toContain(one.token);
    expect(JSON.stringify(listed)).not.toMatch(/cjoin_|tokenHash/);
    expect(await links(w, id, bob)).toHaveLength(2);
    for (const token of [cat, dan]) expect(await code(w.controller.listJoinLinks(token, id))).toBe('FORBIDDEN');
  });

  it('a link made by someone who has since gone is still listed, without a name', async () => {
    const { w, id } = await team();
    await link(w, id, { label: 'Bobs' }, bob);
    const bobsId = w.id('bob');
    w.forget('bob');
    const listed = await links(w, id);
    expect(listed[0]?.createdBy).toEqual({ userId: bobsId });
  });

  it('is paged by id, with limits and cursors checked', async () => {
    const { w, id } = await team();
    for (let n = 0; n < 5; n++) await link(w, id, { label: `L${n}` });
    const first = await must(w.controller.listJoinLinks(ann, id, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    const second = await must(w.controller.listJoinLinks(ann, id, { limit: 2, cursor: first.nextCursor }));
    const third = await must(w.controller.listJoinLinks(ann, id, { limit: 2, cursor: second.nextCursor }));
    expect([...first.items, ...second.items, ...third.items].map((l) => l.id)).toEqual((await links(w, id)).map((l) => l.id));
    expect(third.nextCursor).toBeNull();
    expect(await w.controller.listJoinLinks(ann, id, { limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'limit' } });
    expect(await w.controller.listJoinLinks(ann, id, { limit: 101 })).toMatchObject({ ok: false, error: { field: 'limit' } });
    expect(await w.controller.listJoinLinks(ann, id, { cursor: 'garbage' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'cursor' } });
    expect(await w.controller.listJoinLinks(ann, id, { cursor: 5 as never })).toMatchObject({ ok: false, error: { field: 'cursor' } });
  });

  it('only live links are listed: expired and used-up ones are not', async () => {
    const { w, id } = await team();
    await link(w, id, { label: 'short', days: 1, approval: false });
    const once = await link(w, id, { label: 'once', approval: false });
    await link(w, id, { label: 'long', days: 5, approval: false });
    await must(w.controller.join(eve, { token: once.token }));
    w.now.value = T0 + 2 * DAY;
    expect((await links(w, id)).map((l) => l.label)).toEqual(['long']);
  });

  it('revoking removes a link of this circle, so it no longer works; the answers for anything else are one not-found', async () => {
    const { w, id } = await team();
    const other = await must(w.controller.create(eve, { name: 'Other' }));
    const mine = await link(w, id);
    const theirs = await must(w.controller.createJoinLink(eve, other.id, { label: 'x' }));
    const listed = await links(w, id);
    expect(await w.controller.revokeJoinLink(ann, id, theirs.link.id)).toEqual(NO_LINK);
    expect(await w.controller.revokeJoinLink(ann, id, 'j0000000000000000')).toEqual(NO_LINK);
    for (const odd of ['', 5, null, undefined, {}]) expect(await w.controller.revokeJoinLink(ann, id, odd)).toEqual(NO_LINK);
    expect(await w.controller.revokeJoinLink(bob, id, listed[0]?.id)).toEqual({ ok: true, value: true });
    expect(await w.controller.revokeJoinLink(ann, id, listed[0]?.id)).toEqual(NO_LINK);
    expect(await w.controller.previewJoin(fay, { token: mine.token })).toEqual(NO_LINK);
    expect(await w.controller.join(fay, { token: mine.token })).toEqual(NO_LINK);
    expect(await links(w, other.id, eve)).toHaveLength(1);
  });

  it('members and observers cannot revoke, even a link that does not exist', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    for (const token of [cat, dan]) {
      expect(await code(w.controller.revokeJoinLink(token, id, made.link.id))).toBe('FORBIDDEN');
      expect(await code(w.controller.revokeJoinLink(token, id, 'j0000000000000000'))).toBe('FORBIDDEN');
    }
    expect(await links(w, id)).toHaveLength(1);
  });
});

describe('previewing', () => {
  it('shows only the circle\'s name, the role offered and who made the link, and spends nothing', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'member', approval: false });
    const seen = await must(w.controller.previewJoin(fay, { token: made.token }));
    expect(seen).toEqual({ circle: { name: 'Team' }, role: 'member', createdBy: { displayName: 'DISPLAY ANN' } });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(id);
    expect(await uses(w, id)).toEqual([0]);
    expect(await code(w.controller.previewJoin(fay, { token: made.token }))).toBeUndefined();
    expect((await must(w.controller.join(fay, { token: made.token }))).state).toBe('joined');
  });

  it('a creator who has gone shows no name', async () => {
    const { w, id } = await team();
    const made = await link(w, id, {}, bob);
    w.forget('bob');
    expect(await must(w.controller.previewJoin(fay, { token: made.token }))).toEqual({ circle: { name: 'Team' }, role: 'observer', createdBy: {} });
  });

  it('every kind of miss is the same answer: made up, malformed, expired, revoked, used up, circle deleted', async () => {
    const { w, id } = await team();
    const expiring = await link(w, id, { days: 1, approval: false });
    const revoked = await link(w, id, { approval: false });
    const usedUp = await link(w, id, { approval: false });
    const doomed = await must(w.controller.create(eve, { name: 'Doomed' }));
    const deleted = await must(w.controller.createJoinLink(eve, doomed.id, { label: 'x' }));
    await must(w.controller.join(fay, { token: usedUp.token }));
    await must(w.controller.revokeJoinLink(ann, id, revoked.link.id));
    await must(w.controller.delete(eve, doomed.id));
    w.now.value = T0 + 2 * DAY;
    const tokens = ['cjoin_' + 'A'.repeat(43), 'abc', '', 'cjoin_', 'x'.repeat(200), expiring.token, revoked.token, usedUp.token, deleted.token];
    for (const token of tokens) {
      expect(await w.controller.previewJoin('tok-gus', { token }, { clientKey: token })).toEqual(NO_LINK);
      expect(await w.controller.join('tok-gus', { token }, { clientKey: token })).toEqual(NO_LINK);
    }
    expect(await w.store.membershipOf(id, w.id('gus'))).toBeUndefined();
  });

  it('refuses a body that is not exactly { token } with a token that is text, naming the field', async () => {
    const { w } = await team();
    expect(await w.controller.previewJoin(fay, { token: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'token' } });
    expect(await w.controller.previewJoin(fay, { token: 'x', circleId: 'c' })).toMatchObject({ ok: false, error: { field: 'circleId' } });
    expect(await w.controller.join(fay, undefined)).toMatchObject({ ok: false, error: { field: 'body' } });
    expect(await w.controller.join(fay, { token: null })).toMatchObject({ ok: false, error: { field: 'token' } });
    expect(await w.controller.join(fay, {})).toMatchObject({ ok: false, error: { field: 'token' } });
  });
});

describe('what never reaches the store', () => {
  it('a link id that is not text, and a token that is not shaped like one, never reach it', async () => {
    const real = createMemoryCircleStore();
    const calls: string[] = [];
    const spy: CircleStore = {
      ...real,
      revokeJoinLink: async (...a) => (calls.push('revoke'), real.revokeJoinLink(...a)),
      getJoinLinkByHash: async (...a) => (calls.push('lookup'), real.getJoinLinkByHash(...a)),
      joinWithLink: async (...a) => (calls.push('join'), real.joinWithLink(...a)),
      requestJoin: async (...a) => (calls.push('request'), real.requestJoin(...a)),
    };
    const { w, id } = await team({ store: spy });
    for (const odd of ['', 5, null, undefined, {}]) await w.controller.revokeJoinLink(ann, id, odd);
    for (const token of ['', 'abc', 'cjoin_', `cjoin_${'A'.repeat(42)}`, `cjoin_${'A'.repeat(44)}`, 'x'.repeat(5000)]) {
      await w.controller.previewJoin(fay, { token });
      await w.controller.join(fay, { token });
    }
    expect(calls).toEqual([]);
  });
});

describe('the throttle on links that do not work', () => {
  const bad = (n: number): string => `cjoin_${String(n).padStart(43, 'B')}`;

  it('holds a client back after too many misses, even for a good link, and not another client', async () => {
    const { w, id } = await team({ limits: { joinMissesPerHour: 3 } });
    const good = await link(w, id, { approval: false, uses: 5 });
    for (let n = 0; n < 3; n++) expect(await w.controller.previewJoin(fay, { token: bad(n) }, { clientKey: 'x' })).toEqual(NO_LINK);
    const held = await w.controller.previewJoin(fay, { token: good.token }, { clientKey: 'x' });
    expect(held).toMatchObject({ ok: false, error: { code: 'THROTTLED' } });
    expect((held as { error: { retryAfterMs?: number } }).error.retryAfterMs).toBeGreaterThan(0);
    expect(await code(w.controller.join(fay, { token: good.token }, { clientKey: 'x' }))).toBe('THROTTLED');
    expect(await code(w.controller.previewJoin(fay, { token: good.token }, { clientKey: 'y' }))).toBeUndefined();
    w.now.value = T0 + HOUR + 1;
    expect(await code(w.controller.previewJoin(fay, { token: good.token }, { clientKey: 'x' }))).toBeUndefined();
  });

  it('counts misses from both preview and join, but not good links, and being held back counts for nothing more', async () => {
    const { w, id } = await team({ limits: { joinMissesPerHour: 3 } });
    const good = await link(w, id, { approval: false, uses: 50 });
    for (let n = 0; n < 5; n++) await w.controller.previewJoin(fay, { token: good.token }, { clientKey: 'x' });
    expect(await code(w.controller.previewJoin(fay, { token: bad(1) }, { clientKey: 'x' }))).toBe('NOT_FOUND');
    expect(await code(w.controller.join(fay, { token: bad(2) }, { clientKey: 'x' }))).toBe('NOT_FOUND');
    expect(await code(w.controller.previewJoin(fay, { token: bad(3) }, { clientKey: 'x' }))).toBe('NOT_FOUND');
    for (let n = 0; n < 20; n++) expect(await code(w.controller.previewJoin(fay, { token: bad(n) }, { clientKey: 'x' }))).toBe('THROTTLED');
    w.now.value = T0 + HOUR + 1; // only the three real misses counted, so the hold ends an hour after them
    expect(await code(w.controller.previewJoin(fay, { token: good.token }, { clientKey: 'x' }))).toBeUndefined();
  });

  it('a link used up in the moment between looking and joining is counted as a miss, with or without approval', async () => {
    const real = createMemoryCircleStore();
    const gone = { ok: false as const, error: { code: 'NOT_FOUND', message: 'no such join link' } as never };
    const racing: CircleStore = { ...real, joinWithLink: async () => gone, requestJoin: async () => gone };
    for (const approval of [false, true]) {
      const { w, id } = await team({ store: racing, limits: { joinMissesPerHour: 1 } });
      const made = await link(w, id, { approval, uses: 3 });
      expect(await w.controller.join(fay, { token: made.token }, { clientKey: 'x' })).toEqual(NO_LINK);
      expect(await code(w.controller.previewJoin(fay, { token: made.token }, { clientKey: 'x' })), `approval ${approval}`).toBe('THROTTLED');
    }
  });

  it('with no client given, all such callers share one allowance', async () => {
    const { w } = await team({ limits: { joinMissesPerHour: 2 } });
    await w.controller.previewJoin(fay, { token: bad(1) });
    await w.controller.previewJoin(fay, { token: bad(2) });
    expect(await code(w.controller.previewJoin(fay, { token: bad(3) }))).toBe('THROTTLED');
  });
});

describe('joining by a link that needs no approval', () => {
  it('adds the person at the link\'s role, shows the circle as they now see it, and counts the use', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'observer', approval: false, uses: 2 });
    const joined = await must(w.controller.join(fay, { token: made.token }));
    expect(joined.state).toBe('joined');
    expect((joined as { circle: object }).circle).toMatchObject({ id, name: 'Team', role: 'observer', memberCount: 5 });
    expect(Object.isFrozen(joined)).toBe(true);
    expect((await w.store.membershipOf(id, w.id('fay')))?.role).toBe('observer');
    expect(await uses(w, id)).toEqual([1]);
  });

  it('a one-use link serves one person; the next gets the miss answer', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { approval: false });
    await must(w.controller.join(fay, { token: made.token }));
    expect(await w.controller.join(eve, { token: made.token })).toEqual(NO_LINK);
    expect(await w.store.membershipOf(id, w.id('eve'))).toBeUndefined();
  });

  it('someone already in is told so, keeps their role, and costs no use', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'observer', approval: false });
    for (const token of [ann, bob, cat]) expect((await must(w.controller.join(token, { token: made.token }))).state).toBe('member');
    expect((await w.store.membershipOf(id, w.id('ann')))?.role).toBe('owner');
    expect((await w.store.membershipOf(id, w.id('bob')))?.role).toBe('manager');
    expect(await uses(w, id)).toEqual([0]);
    const again = await must(w.controller.join(ann, { token: made.token }));
    expect((again as { circle: { role: string } }).circle.role).toBe('owner');
  });

  it('a full circle or a person in the most circles allowed gets a limit and the use is not spent', async () => {
    const { w, id } = await team({ limits: { maxMembersPerCircle: 4 } });
    const made = await link(w, id, { approval: false, uses: 3 });
    expect(await code(w.controller.join(fay, { token: made.token }))).toBe('LIMIT_REACHED');
    expect(await uses(w, id)).toEqual([0]);
    const small = await team({ limits: { maxCirclesPerUser: 1 } });
    const link2 = await link(small.w, small.id, { approval: false, uses: 3 });
    await must(small.w.controller.create(fay, { name: 'Mine' }));
    expect(await code(small.w.controller.join(fay, { token: link2.token }))).toBe('LIMIT_REACHED');
    expect(await uses(small.w, small.id)).toEqual([0]);
  });

  it('eight people at once on a one-use link make exactly one member', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { approval: false });
    const names = ['eve', 'fay', 'gus', 'hal', 'ivy', 'jon'];
    const results = await Promise.all(names.map((n) => w.controller.join(`tok-${n}`, { token: made.token })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'NOT_FOUND')).toHaveLength(5);
    expect(await countMembers(w, id)).toBe(5);
  });
});

const countMembers = async (w: W, id: string): Promise<number> => (await must(w.controller.members(ann, id, { limit: 100 }))).items.length;

describe('joining by a link that needs approval', () => {
  it('makes a waiting request, not a member, and counts the use; the answer names the circle and the role only', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { role: 'member', uses: 3 });
    const asked = await must(w.controller.join(fay, { token: made.token }));
    expect(asked).toEqual({ state: 'requested', circle: { name: 'Team' }, role: 'member', expiresAt: T0 + 7 * DAY });
    expect(JSON.stringify(asked)).not.toContain(id);
    expect(await w.store.membershipOf(id, w.id('fay'))).toBeUndefined();
    expect(await uses(w, id)).toEqual([1]);
    const waiting = await w.store.listJoinRequests(id, T0, { limit: 10, cursor: null });
    expect(waiting.items.map((r) => [r.userId, r.role])).toEqual([[w.id('fay'), 'member']]);
  });

  it('asking again says waiting, with the same end time, and counts nothing', async () => {
    const { w, id } = await team();
    const made = await link(w, id, { uses: 3 });
    const first = await must(w.controller.join(fay, { token: made.token }));
    w.now.value = T0 + 3 * DAY;
    const again = await must(w.controller.join(fay, { token: made.token }));
    expect(again).toEqual({ ...first, state: 'waiting' });
    expect(await uses(w, id)).toEqual([1]);
  });

  it('a one-use link makes one request; the next person gets the miss answer', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    await must(w.controller.join(fay, { token: made.token }));
    expect(await w.controller.join(eve, { token: made.token })).toEqual(NO_LINK);
  });

  it('a member using it is told they are in, and nothing is asked or spent', async () => {
    const { w, id } = await team();
    const made = await link(w, id);
    expect((await must(w.controller.join(cat, { token: made.token }))).state).toBe('member');
    expect(await uses(w, id)).toEqual([0]);
    expect((await w.store.listJoinRequests(id, T0, { limit: 10, cursor: null })).items).toEqual([]);
  });

  it('a request waits as long as the setting says, and a circle holds only so many', async () => {
    const { w, id } = await team({ limits: { joinRequestDays: 2, maxPendingJoinRequestsPerCircle: 2 } });
    const made = await link(w, id, { uses: 10 });
    expect(((await must(w.controller.join(eve, { token: made.token }))) as { expiresAt: number }).expiresAt).toBe(T0 + 2 * DAY);
    await must(w.controller.join(fay, { token: made.token }));
    expect(await code(w.controller.join('tok-gus', { token: made.token }))).toBe('LIMIT_REACHED');
    expect(await uses(w, id)).toEqual([2]);
    w.now.value = T0 + 3 * DAY;
    expect(await code(w.controller.join('tok-gus', { token: made.token }))).toBeUndefined();
  });

  it('a request id that is already used is replaced by a fresh one', async () => {
    const ids = ['rdup', 'rdup', 'rfresh'];
    const { w, id } = await team({ more: { newJoinRequestId: () => ids.shift() ?? 'rlast' } });
    const made = await link(w, id, { uses: 5 });
    await must(w.controller.join(eve, { token: made.token }));
    expect(await code(w.controller.join(fay, { token: made.token }))).toBeUndefined();
    expect((await w.store.listJoinRequests(id, T0, { limit: 10, cursor: null })).items.map((r) => r.id).sort()).toEqual(['rdup', 'rfresh']);
  });
});

describe('failures', () => {
  const broken = (message: string): CircleStore => {
    const real = createMemoryCircleStore();
    const fail = async (): Promise<never> => {
      throw new Error(message);
    };
    return { ...real, createJoinLink: fail, listJoinLinks: fail, revokeJoinLink: fail, getJoinLinkByHash: fail, joinWithLink: fail, requestJoin: fail };
  };

  it('a store that breaks is the one fixed storage message, never its own words', async () => {
    const real = createMemoryCircleStore();
    const { w, id } = await team({ store: real });
    const good = await link(w, id);
    const w2 = world({ store: broken('SECRET /var/path failure') });
    const made = await must(w2.controller.create(ann, { name: 'X' }));
    for (const call of [() => w2.controller.createJoinLink(ann, made.id, { label: 'x' }), () => w2.controller.listJoinLinks(ann, made.id), () => w2.controller.revokeJoinLink(ann, made.id, 'j1'), () => w2.controller.previewJoin(fay, { token: good.token }), () => w2.controller.join(fay, { token: good.token })]) {
      const r = await call();
      expect(r).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
    }
  });

  it('a store that reports a storage error in its own words is replaced by the fixed message', async () => {
    const real = createMemoryCircleStore();
    const own: CircleStore = { ...real, createJoinLink: async () => ({ ok: false, error: { code: 'STORAGE_ERROR', message: 'database is locked at /var/x.db' } as never }) };
    const { w, id } = await team({ store: own });
    const r = await w.controller.createJoinLink(ann, id, { label: 'x' });
    expect(r).toEqual({ ok: false, error: { code: 'STORAGE_ERROR', message: 'the circle service could not complete the request' } });
  });

  it('the new limits are checked when the controller is made', () => {
    for (const name of ['maxLiveJoinLinksPerCircle', 'maxPendingJoinRequestsPerCircle', 'joinRequestDays', 'joinMissesPerHour']) {
      for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => world({ limits: { [name]: bad } as never }), `${name} ${bad}`).toThrow(TypeError);
    }
  });
});
