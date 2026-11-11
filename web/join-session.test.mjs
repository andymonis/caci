import { describe, expect, it } from 'vitest';
import { createJoinSession } from './join-session.js';

const TOKEN = `cjoin_${'Ab1_-'.repeat(8)}Abc`;
const PREVIEW = { circle: { name: 'Club' }, role: 'member', createdBy: { displayName: 'Ann' } };
const CIRCLE = { id: 'c0000000000000001', name: 'Club', role: 'member', memberCount: 3, createdAt: 1, updatedAt: 2 };
const mine = (n) => ({ id: `r${String(n).padStart(16, '0')}`, circle: { name: `Circle ${n}` }, role: 'member', createdAt: 1, expiresAt: 2 });
const ok = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });

function fake(answers = {}) {
  const calls = [];
  const next = (name, fallback) => (...args) => {
    calls.push([name, ...args]);
    const a = answers[name];
    return Promise.resolve(typeof a === 'function' ? a(...args) : a ?? fallback);
  };
  return { calls, client: { preview: next('preview', ok(PREVIEW)), join: next('join', ok({ state: 'joined', circle: CIRCLE })), myRequests: next('myRequests', ok({ items: [mine(1)], nextCursor: null })) } };
}
const make = (f, extra = {}) => createJoinSession({ client: f.client, ...extra });
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

describe('opening a link', () => {
  it('asks nothing until opened, then previews with the token and shows the preview ready', async () => {
    const f = fake();
    const s = make(f);
    expect(f.calls).toEqual([]);
    expect(s.getState()).toMatchObject({ status: 'idle', preview: null, result: null, message: null, problem: null, busy: false });
    expect(await s.open(TOKEN)).toEqual({ ok: true });
    expect(f.calls).toEqual([['preview', TOKEN]]);
    expect(s.getState()).toMatchObject({ status: 'ready', preview: PREVIEW, busy: false });
    expect(Object.isFrozen(s.getState()) && Object.isFrozen(s.getState().mine)).toBe(true);
  });

  it('the token is in no state the page can read', async () => {
    const f = fake();
    const s = make(f);
    await s.open(TOKEN);
    expect(JSON.stringify(s.getState())).not.toContain('cjoin_');
    await s.join();
    expect(JSON.stringify(s.getState())).not.toContain('cjoin_');
  });

  it('a link that does not work is a miss: nothing is shown of it, and the person\'s own waiting requests are listed', async () => {
    const f = fake({ preview: bad('not-found', 'This link does not work.') });
    const s = make(f);
    expect(await s.open(TOKEN)).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.getState()).toMatchObject({ status: 'miss', preview: null, message: null });
    expect(f.calls).toEqual([['preview', TOKEN], ['myRequests', { limit: 100 }]]);
    expect(s.getState().mine).toMatchObject({ status: 'loaded' });
    expect(s.getState().mine.items).toHaveLength(1);
    expect(await s.join()).toMatchObject({ ok: false, kind: 'not-ready' }); // the token was forgotten with the miss
    expect(f.calls.filter((c) => c[0] === 'join')).toEqual([]);
  });

  it('join links being off, or any other failure, shows the words and keeps no token', async () => {
    for (const [error, status] of [[bad('unavailable', 'Not switched on.'), 'unavailable'], [bad('throttled', 'Wait a bit.'), 'error'], [bad('server', 'Broke.'), 'error']]) {
      const f = fake({ preview: error });
      const s = make(f);
      await s.open(TOKEN);
      expect(s.getState()).toMatchObject({ status, message: error.error.message, preview: null });
      expect(await s.join()).toMatchObject({ kind: 'not-ready' });
      expect(f.calls).toEqual([['preview', TOKEN]]);
    }
  });

  it('a value that is not text is a miss without asking anything about it that the client would not refuse', async () => {
    const f = fake({ preview: bad('not-found', 'x') });
    const s = make(f);
    await s.open(undefined);
    expect(s.getState().status).toBe('miss');
    expect(f.calls[0]).toEqual(['preview', null]);
  });

  it('a signed-out answer to listing the waiting requests is reported too', async () => {
    let out = 0;
    const s = make(fake({ preview: bad('not-found', 'x'), myRequests: bad('signed-out', 'x') }), { onSignedOut: () => out++ });
    await s.open(TOKEN);
    expect(out).toBe(1);
    expect(s.getState().mine.status).toBe('error');
  });

  it('opening a link clears what an earlier try left (a limit shown, a result, the waiting requests)', async () => {
    const f = fake({ join: bad('limit', 'a circle may have at most 4 people') });
    const s = make(f);
    await s.open(TOKEN);
    await s.join();
    expect(s.getState().problem).toBe('a circle may have at most 4 people');
    await s.open(TOKEN);
    expect(s.getState()).toMatchObject({ problem: null, status: 'ready', result: null, mine: { status: 'idle' } });
  });

  it('a signed-out answer is reported once', async () => {
    let out = 0;
    const s = make(fake({ preview: bad('signed-out', 'Your session has ended.') }), { onSignedOut: () => out++ });
    await s.open(TOKEN);
    expect(out).toBe(1);
    expect(s.getState().status).toBe('error');
  });
});

describe('joining', () => {
  it('needs a link that was opened and is ready', async () => {
    const f = fake();
    const s = make(f);
    expect(await s.join()).toMatchObject({ ok: false, kind: 'not-ready' });
    expect(f.calls).toEqual([]);
  });

  it('joined and member show the circle and forget the token and the preview', async () => {
    for (const state of ['joined', 'member']) {
      const f = fake({ join: ok({ state, circle: CIRCLE }) });
      const s = make(f);
      await s.open(TOKEN);
      expect(await s.join()).toEqual({ ok: true });
      expect(f.calls.map((c) => c[0])).toEqual(['preview', 'join']);
      expect(f.calls[1]).toEqual(['join', TOKEN]);
      expect(s.getState()).toMatchObject({ status: state, result: { state, circle: CIRCLE }, preview: null });
      expect(await s.join()).toMatchObject({ kind: 'not-ready' });
    }
  });

  it('requested and waiting show the answer and list the person\'s own waiting requests', async () => {
    for (const state of ['requested', 'waiting']) {
      const result = { state, circle: { name: 'Club' }, role: 'member', expiresAt: 9 };
      const f = fake({ join: ok(result) });
      const s = make(f);
      await s.open(TOKEN);
      await s.join();
      expect(f.calls.map((c) => c[0])).toEqual(['preview', 'join', 'myRequests']);
      expect(s.getState()).toMatchObject({ status: state, result });
      expect(s.getState().mine).toMatchObject({ status: 'loaded' });
    }
  });

  it('a failure listing the waiting requests is shown there, and the join still counts', async () => {
    const f = fake({ join: ok({ state: 'requested', circle: { name: 'Club' }, role: 'member', expiresAt: 9 }), myRequests: bad('server', 'List broke.') });
    const s = make(f);
    await s.open(TOKEN);
    expect(await s.join()).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ status: 'requested', mine: { status: 'error', message: 'List broke.', items: [] } });
    const off = make(fake({ join: ok({ state: 'waiting', circle: { name: 'C' }, role: 'member', expiresAt: 9 }), myRequests: bad('unavailable', 'Off.') }));
    await off.open(TOKEN);
    await off.join();
    expect(off.getState().mine.status).toBe('unavailable');
  });

  it('a limit or a wait leaves the person on the preview with the service\'s words, and they may try again', async () => {
    let answer = bad('limit', 'a circle may have at most 4 people');
    const f = fake({ join: () => answer });
    const s = make(f);
    await s.open(TOKEN);
    expect(await s.join()).toMatchObject({ ok: false, kind: 'limit' });
    expect(s.getState()).toMatchObject({ status: 'ready', problem: 'a circle may have at most 4 people', preview: PREVIEW });
    answer = ok({ state: 'joined', circle: CIRCLE });
    expect(await s.join()).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ status: 'joined', problem: null });
  });

  it('a link that has been used up in the moment between looking and joining becomes a miss', async () => {
    const f = fake({ join: bad('not-found', 'x') });
    const s = make(f);
    await s.open(TOKEN);
    expect(await s.join()).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.getState()).toMatchObject({ status: 'miss', preview: null });
    expect(f.calls.some((c) => c[0] === 'myRequests')).toBe(true);
    expect(await s.join()).toMatchObject({ kind: 'not-ready' });
  });

  it('a signed-out answer is reported', async () => {
    let out = 0;
    const s = make(fake({ join: bad('signed-out', 'x') }), { onSignedOut: () => out++ });
    await s.open(TOKEN);
    await s.join();
    expect(out).toBe(1);
  });
});

describe('one at a time, late answers, reset', () => {
  it('a second join while one is out is refused and sends nothing', async () => {
    const g = gate();
    const f = fake({ join: () => g.promise.then(() => ok({ state: 'joined', circle: CIRCLE })) });
    const s = make(f);
    await s.open(TOKEN);
    const first = s.join();
    expect(s.getState()).toMatchObject({ status: 'joining', busy: true });
    expect(await s.join()).toMatchObject({ kind: 'not-ready' });
    g.release();
    await first;
    expect(f.calls.filter((c) => c[0] === 'join')).toHaveLength(1);
    expect(s.getState().busy).toBe(false);
  });

  it('an answer after a reset is dropped and nothing is shown', async () => {
    const g = gate();
    const f = fake({ preview: () => g.promise.then(() => ok(PREVIEW)) });
    const s = make(f);
    const pending = s.open(TOKEN);
    s.reset();
    g.release();
    expect(await pending).toMatchObject({ kind: 'dropped' });
    expect(s.getState()).toMatchObject({ status: 'idle', preview: null, busy: false });
    expect(await s.join()).toMatchObject({ kind: 'not-ready' });
  });

  it('opening another link starts over, and only the newer answer counts', async () => {
    const g = gate();
    let n = 0;
    const f = fake({ preview: () => (++n === 1 ? g.promise.then(() => ok({ ...PREVIEW, circle: { name: 'Old' } })) : ok(PREVIEW)) });
    const s = make(f);
    const first = s.open(TOKEN);
    expect(await s.open(TOKEN)).toEqual({ ok: true });
    g.release();
    expect(await first).toMatchObject({ kind: 'dropped' });
    expect(s.getState().preview.circle.name).toBe('Club');
    expect(s.getState().busy).toBe(false);
  });

  it('a late answer after a reset does not clear a newer request\'s busy mark', async () => {
    const g = gate();
    let n = 0;
    const f = fake({ preview: () => (++n === 1 ? g.promise.then(() => ok(PREVIEW)) : new Promise(() => {})) });
    const s = make(f);
    const old = s.open(TOKEN);
    s.reset();
    void s.open(TOKEN);
    expect(s.getState().busy).toBe(true);
    g.release();
    await old;
    expect(s.getState().busy).toBe(true);
  });

  it('a late answer while joining, after a reset, shows nothing and asks nothing more', async () => {
    const g = gate();
    const f = fake({ join: () => g.promise.then(() => ok({ state: 'requested', circle: { name: 'C' }, role: 'member', expiresAt: 9 })) });
    const s = make(f);
    await s.open(TOKEN);
    const joining = s.join();
    s.reset();
    g.release();
    expect(await joining).toMatchObject({ kind: 'dropped' });
    expect(s.getState()).toMatchObject({ status: 'idle', result: null });
    expect(f.calls.some((c) => c[0] === 'myRequests')).toBe(false);
  });

  it('a late answer while listing the person\'s own requests, after a reset, shows nothing', async () => {
    const g = gate();
    const f = fake({ preview: bad('not-found', 'x'), myRequests: () => g.promise.then(() => ok({ items: [mine(1)], nextCursor: null })) });
    const s = make(f);
    const opening = s.open(TOKEN);
    await Promise.resolve();
    await Promise.resolve();
    s.reset();
    g.release();
    await opening;
    expect(s.getState()).toMatchObject({ status: 'idle', mine: { status: 'idle', items: [] } });
  });

  it('a broken listener does not matter, and reset forgets everything', async () => {
    const f = fake();
    const s = make(f);
    let heard = 0;
    s.subscribe(() => {
      throw new Error('broken');
    });
    const off = s.subscribe(() => heard++);
    await s.open(TOKEN);
    expect(heard).toBeGreaterThan(0);
    off();
    s.reset();
    expect(s.getState()).toMatchObject({ status: 'idle', preview: null, result: null, message: null, problem: null, mine: { status: 'idle', items: [] } });
  });

  it('refuses to be made without a join client', () => {
    expect(() => createJoinSession({ client: {} })).toThrow(TypeError);
    expect(() => createJoinSession({})).toThrow(TypeError);
  });
});
