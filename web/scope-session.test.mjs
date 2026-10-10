import { describe, expect, it } from 'vitest';
import { createScopeSession, MINE_LABEL, PERSONAL_LABEL } from './scope-session.js';

const C1 = 'c0123456789abcdef';
const C2 = 'cabcdefghij012345';
const ME = { kind: 'personal' };
const IN = (id, name) => ({ kind: 'circle', circleId: id, circleName: name });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const LIST = okv({ items: [{ scope: ME, canCapture: true }, { scope: IN(C1, 'Parent'), role: 'member', canCapture: true }, { scope: IN(C2, 'In-law'), role: 'observer', canCapture: false }] });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const make = (answer = LIST, options = {}) => {
  const calls = [];
  const client = { scopes: () => (calls.push('scopes'), Promise.resolve(typeof answer === 'function' ? answer() : answer)) };
  return { s: createScopeSession({ client, ...options }), calls };
};
const loaded = async (answer = LIST, options = {}) => {
  const m = make(answer, options);
  await m.s.load();
  return m;
};

describe('the list of scopes', () => {
  it('starts idle with the person\'s own notes chosen for both, and loads the list with labels, roles and rights', async () => {
    const { s } = make();
    expect(s.getState()).toMatchObject({ status: 'idle', captureKey: 'personal', browseKey: 'personal', scopes: [], captureScope: undefined, browseScope: undefined, busy: false });
    expect(await s.load()).toEqual({ ok: true });
    const v = s.getState();
    expect(v.status).toBe('loaded');
    expect(v.scopes.map((x) => [x.key, x.label, x.role, x.canCapture])).toEqual([['personal', PERSONAL_LABEL, undefined, true], [`circle:${C1}`, 'Parent', 'member', true], [`circle:${C2}`, 'In-law', 'observer', false]]);
    expect(v.scopes[1]?.scope).toEqual(IN(C1, 'Parent'));
    expect(Object.isFrozen(v) && Object.isFrozen(v.scopes) && Object.isFrozen(v.scopes[1])).toBe(true);
  });

  it('says it is loading, and a failure shows the words and leaves only the person\'s own notes', async () => {
    const d = deferred();
    const { s } = make(() => d.promise);
    const pending = s.load();
    expect(s.getState()).toMatchObject({ status: 'loading', busy: true });
    d.resolve(bad('server', 'Something went wrong'));
    expect(await pending).toMatchObject({ ok: false, kind: 'server' });
    expect(s.getState()).toMatchObject({ status: 'error', error: 'Something went wrong', scopes: [], busy: false, captureKey: 'personal', browseKey: 'personal' });
  });

  it('too many circles is the service\'s words, on scope, and nothing is offered', async () => {
    const { s } = await loaded(bad('invalid', 'choose one circle', { field: 'scope' }));
    expect(s.getState()).toMatchObject({ status: 'error', error: 'choose one circle', scopes: [] });
  });

  it('one request at a time, a signed-out answer is reported once, and a late answer after reset is dropped', async () => {
    const d = deferred();
    let n = 0;
    const m = make(() => (n++ === 0 ? d.promise : LIST));
    const first = m.s.load();
    expect(await m.s.load()).toMatchObject({ kind: 'busy' });
    expect(m.calls).toHaveLength(1);
    d.resolve(LIST);
    await first;
    let out = 0;
    const gone = await loaded(bad('signed-out', 'Your session has ended. Sign in again.'), { onSignedOut: () => out++ });
    expect(out).toBe(1);
    expect(gone.s.getState().busy).toBe(false);
    const late = deferred();
    const l = make(() => late.promise);
    const pending = l.s.load();
    l.s.reset();
    late.resolve(LIST);
    expect(await pending).toMatchObject({ kind: 'dropped' });
    expect(l.s.getState()).toMatchObject({ status: 'idle', scopes: [] });
  });

  it('a throwing sign-out hook or listener does not matter, and unsubscribing works', async () => {
    const seen = [];
    const m = make(bad('signed-out', 'x'), { onSignedOut: () => { throw new Error('boom'); } });
    m.s.subscribe(() => { throw new Error('bad'); });
    const off = m.s.subscribe((v) => seen.push(v.status));
    await m.s.load();
    off();
    const n = seen.length;
    m.s.reset();
    expect(seen).toHaveLength(n);
    expect(n).toBeGreaterThan(1);
  });

  it('needs a client with scopes', () => {
    expect(() => createScopeSession({})).toThrow(TypeError);
    expect(() => createScopeSession({ client: {} })).toThrow(TypeError);
  });
});

describe('choosing', () => {
  it('capture can be pointed at a scope the person may capture into: their own, or a circle; the scope to send is nothing for their own brain', async () => {
    const { s } = await loaded();
    expect(s.chooseCapture(`circle:${C1}`)).toBe(true);
    expect(s.getState()).toMatchObject({ captureKey: `circle:${C1}`, captureScope: IN(C1, 'Parent') });
    expect(s.chooseCapture('personal')).toBe(true);
    expect(s.getState().captureScope).toBeUndefined();
  });

  it('capture is refused for an observer\'s circle, a circle not on the list and nonsense, and nothing changes', async () => {
    const { s } = await loaded();
    s.chooseCapture(`circle:${C1}`);
    for (const bad of [`circle:${C2}`, 'circle:cunknown000000000', 'mine', '', undefined, null, 5, {}]) {
      expect(s.chooseCapture(bad), String(bad)).toBe(false);
      expect(s.getState().captureKey).toBe(`circle:${C1}`);
    }
  });

  it('reading can be pointed at any scope on the list (an observer\'s circle too) or at mine', async () => {
    const { s } = await loaded();
    expect(s.chooseBrowse(`circle:${C2}`)).toBe(true);
    expect(s.getState()).toMatchObject({ browseKey: `circle:${C2}`, browseScope: IN(C2, 'In-law') });
    expect(s.chooseBrowse('mine')).toBe(true);
    expect(s.getState().browseScope).toBe('mine');
    expect(s.chooseBrowse('personal')).toBe(true);
    expect(s.getState().browseScope).toBeUndefined();
    for (const bad of ['circle:cunknown000000000', '', undefined, 5, {}]) expect(s.chooseBrowse(bad), String(bad)).toBe(false);
    expect(s.getState().browseKey).toBe('personal');
  });

  it('a choice that is no longer possible falls back to the person\'s own notes at the next load, and mine stays', async () => {
    let answer = LIST;
    const { s } = make(() => answer);
    await s.load();
    s.chooseCapture(`circle:${C1}`);
    s.chooseBrowse(`circle:${C2}`);
    answer = okv({ items: [{ scope: ME, canCapture: true }, { scope: IN(C1, 'Parent'), role: 'observer', canCapture: false }] });
    await s.load();
    expect(s.getState()).toMatchObject({ captureKey: 'personal', browseKey: 'personal' });
    s.chooseBrowse('mine');
    await s.load();
    expect(s.getState().browseKey).toBe('mine');
    answer = LIST;
    await s.load();
    s.chooseCapture(`circle:${C1}`);
    await s.load();
    expect(s.getState().captureKey).toBe(`circle:${C1}`); // still allowed: kept
  });

  it('a failed load drops the choices; reset forgets everything', async () => {
    let answer = LIST;
    const { s } = make(() => answer);
    await s.load();
    s.chooseCapture(`circle:${C1}`);
    answer = bad('network', 'Cannot reach');
    await s.load();
    expect(s.getState()).toMatchObject({ captureKey: 'personal', browseKey: 'personal', scopes: [] });
    answer = LIST;
    await s.load();
    s.chooseBrowse('mine');
    s.reset();
    expect(s.getState()).toMatchObject({ status: 'idle', scopes: [], captureKey: 'personal', browseKey: 'personal' });
  });

  it('the labels are plain words', () => {
    expect(PERSONAL_LABEL).toBe('My own notes');
    expect(MINE_LABEL).toBe('My Brain (my notes and my circles together)');
  });
});
