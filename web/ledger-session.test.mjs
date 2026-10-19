import { describe, expect, it } from 'vitest';
import { createLedgerSession } from './ledger-session.js';

const C = 'cabcdefghij012345';
const entry = (n, extra = {}) => ({ id: `l${n}`, at: n, action: 'added', kind: 'item', subject: `n${n}`, ...extra });
const okp = (items, nextCursor = null) => ({ ok: true, value: { items, nextCursor } });
const bad = (kind, message = kind) => ({ ok: false, error: { kind, message } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function make(script, options = {}) {
  const calls = [];
  const client = { list: (...args) => (calls.push(args), Promise.resolve(typeof script === 'function' ? script(...args) : script)) };
  return { calls, s: createLedgerSession({ client, ...options }) };
}

describe('the change-log session', () => {
  it('requests nothing until opened', () => {
    const { s, calls } = make(okp([]));
    expect(calls).toEqual([]);
    expect(s.getState()).toMatchObject({ status: 'idle', items: [], hasMore: false, busy: false });
  });

  it('opens the personal log: first page, newest first as given, a frozen snapshot', async () => {
    const { s, calls } = make(okp([entry(2), entry(1)], 'c1'));
    expect(await s.open()).toEqual({ ok: true });
    expect(calls).toEqual([[undefined, { limit: 50 }]]);
    const st = s.getState();
    expect(st).toMatchObject({ status: 'loaded', hasMore: true, nextCursor: 'c1', scope: undefined, busy: false, error: null });
    expect(st.items.map((e) => e.id)).toEqual(['l2', 'l1']);
    expect(Object.isFrozen(st) && Object.isFrozen(st.items)).toBe(true);
  });

  it('opens a circle, sending only its kind and id', async () => {
    const { s, calls } = make(okp([entry(1)]));
    await s.open({ kind: 'circle', circleId: C, circleName: 'Club', junk: 1 });
    expect(calls[0][0]).toEqual({ kind: 'circle', circleId: C });
    expect(s.getState().scope).toEqual({ kind: 'circle', circleId: C });
    expect(s.isShowing({ kind: 'circle', circleId: C })).toBe(true);
    expect(s.isShowing(undefined)).toBe(false);
  });

  it('shows more: appends the next page with the cursor, and says when there is none', async () => {
    const pages = [okp([entry(3)], 'c1'), okp([entry(2)], null)];
    const { s, calls } = make(() => pages.shift());
    await s.open();
    expect((await s.more()).ok).toBe(true);
    expect(calls[1]).toEqual([undefined, { limit: 50, cursor: 'c1' }]);
    expect(s.getState().items.map((e) => e.id)).toEqual(['l3', 'l2']);
    expect(s.getState().hasMore).toBe(false);
    expect(await s.more()).toMatchObject({ ok: false, kind: 'none' });
    expect(calls).toHaveLength(2);
  });

  it('more does nothing before anything is loaded', async () => {
    const { s, calls } = make(okp([]));
    expect(await s.more()).toMatchObject({ ok: false, kind: 'none' });
    expect(calls).toEqual([]);
  });

  it('a failed "show more" keeps what was shown; a failed first load shows the words and no entries', async () => {
    const script = [okp([entry(2)], 'c1'), bad('server', 'oops')];
    const { s } = make(() => script.shift());
    await s.open();
    expect(await s.more()).toMatchObject({ ok: false, kind: 'server' });
    expect(s.getState()).toMatchObject({ status: 'loaded', error: 'oops', hasMore: true });
    expect(s.getState().items).toHaveLength(1);
    const failing = make(bad('server', 'down'));
    await failing.s.open();
    expect(failing.s.getState()).toMatchObject({ status: 'error', error: 'down', items: [] });
  });

  it('a refresh that fails keeps the entries already shown', async () => {
    const script = [okp([entry(1)]), bad('network', 'offline')];
    const { s } = make(() => script.shift());
    await s.open();
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'loaded', error: 'offline' });
    expect(s.getState().items).toHaveLength(1);
  });

  it('refresh reloads from the newest for the same scope and replaces the entries', async () => {
    const script = [okp([entry(1)], 'c1'), okp([entry(2), entry(1)])];
    const { s, calls } = make(() => script.shift());
    await s.open({ kind: 'circle', circleId: C });
    await s.refresh();
    expect(calls[1]).toEqual([{ kind: 'circle', circleId: C }, { limit: 50 }]);
    expect(s.getState().items.map((e) => e.id)).toEqual(['l2', 'l1']);
  });

  it('a circle that cannot be read is lost with the one set of words, and own notes can be shown instead', async () => {
    const script = [bad('not-found', 'No such circle, or you are not in it.'), okp([entry(9)])];
    const { s, calls } = make(() => script.shift());
    await s.open({ kind: 'circle', circleId: C });
    expect(s.getState()).toMatchObject({ status: 'lost', error: 'No such circle, or you are not in it.', items: [], hasMore: false });
    await s.useOwn();
    expect(calls[1][0]).toBeUndefined();
    expect(s.getState()).toMatchObject({ status: 'loaded', error: null, scope: undefined });
  });

  it('one request at a time: a second call meanwhile sends nothing', async () => {
    const d = deferred();
    const { s, calls } = make(() => d.promise);
    const first = s.open();
    expect(s.getState().busy).toBe(true);
    expect(await s.open()).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.refresh()).toMatchObject({ ok: false, kind: 'busy' });
    expect(calls).toHaveLength(1);
    d.resolve(okp([]));
    await first;
    expect(s.getState().busy).toBe(false);
  });

  it('reset forgets everything and drops an answer still on its way', async () => {
    const d = deferred();
    const { s } = make(() => d.promise);
    const pending = s.open();
    s.reset();
    d.resolve(okp([entry(1)]));
    expect(await pending).toMatchObject({ ok: false, kind: 'dropped' });
    expect(s.getState()).toMatchObject({ status: 'idle', items: [], busy: false });
  });

  it('reset forgets the scope and the entries that were shown', async () => {
    const { s } = make(okp([entry(1)], 'c1'));
    await s.open({ kind: 'circle', circleId: C });
    s.reset();
    expect(s.getState()).toMatchObject({ status: 'idle', scope: undefined, items: [], nextCursor: null, hasMore: false });
  });

  it('an old request finishing after a reset does not clear a newer request\'s busy mark', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const queue = [d1, d2];
    const { s } = make(() => queue.shift().promise);
    const old = s.open();
    s.reset();
    const fresh = s.open();
    d1.resolve(okp([entry(1)]));
    await old;
    expect(s.getState().busy).toBe(true);
    d2.resolve(okp([entry(2)]));
    await fresh;
    expect(s.getState().items.map((e) => e.id)).toEqual(['l2']);
  });

  it('reports a signed-out answer, and a throwing handler or client does not break it', async () => {
    let told = 0;
    const out = make(bad('signed-out', 'ended'), { onSignedOut: () => told++ });
    await out.s.open();
    expect(told).toBe(1);
    const thrower = make(bad('signed-out'), { onSignedOut: () => { throw new Error('x'); } });
    await expect(thrower.s.open()).resolves.toMatchObject({ ok: false });
    const other = make(bad('server'), { onSignedOut: () => told++ });
    await other.s.open();
    expect(told).toBe(1);
    const crash = createLedgerSession({ client: { list: () => Promise.reject(new Error('boom')) } });
    expect(await crash.open()).toMatchObject({ ok: false, kind: 'server' });
    expect(crash.getState()).toMatchObject({ status: 'error', busy: false });
  });

  it('listeners hear the loading step and the result; a broken one does not matter; unsubscribing works', async () => {
    const { s } = make(okp([entry(1)]));
    const seen = [];
    const un = s.subscribe((v) => seen.push(v.status));
    s.subscribe(() => { throw new Error('x'); });
    await s.open();
    expect(seen).toEqual(['loading', 'loaded']);
    un();
    await s.refresh();
    expect(seen).toHaveLength(2);
  });

  it('refuses to be built without a client', () => {
    expect(() => createLedgerSession({})).toThrow(TypeError);
  });
});
