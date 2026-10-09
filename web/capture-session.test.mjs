import { describe, expect, it } from 'vitest';
import { createCaptureSession } from './capture-session.js';

const P = 'prop-0abc12345-00-abcdef';
const SUMMARY = { newItems: ['n'], updatedItems: [], newCategories: ['c'], updatedCategories: [], reusedCategories: [], newLinks: [], problems: [], notes: [] };
const proposal = (extra = {}) => ({ id: P, createdAt: 10, expiresAt: 900_010, mode: 'demo', text: 'New items…', summary: SUMMARY, operations: [], ...extra });
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function fakeClient(script = {}) {
  const calls = [];
  const client = new Proxy({}, {
    get: (_, name) => (...args) => {
      calls.push({ name, args });
      const entry = script[name];
      const value = typeof entry === 'function' ? entry(...args) : Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      return Promise.resolve(value).then((v) => v ?? okv(true));
    },
  });
  return { client, calls };
}
const known = async (script, options = {}) => {
  const f = fakeClient({ mode: okv({ mode: 'demo' }), ...script });
  const s = createCaptureSession({ client: f.client, ...options });
  await s.loadMode();
  return { s, ...f };
};
const names = (calls) => calls.map((c) => c.name);

describe('which model files the note', () => {
  it('starts unknown and nothing can be proposed; loading the mode makes it known', async () => {
    const { client, calls } = fakeClient({ mode: okv({ mode: 'anthropic' }), propose: okv(proposal()) });
    const s = createCaptureSession({ client });
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown', value: null }, canPropose: false, phase: 'form', proposal: null, outcome: null, busy: false });
    expect(await s.propose('a note')).toMatchObject({ ok: false, kind: 'mode-unknown' });
    expect(names(calls)).toEqual([]); // not even the model is asked
    const p = s.loadMode();
    expect(s.getState().mode.status).toBe('loading');
    expect(await p).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ mode: { status: 'known', value: 'anthropic', error: null }, canPropose: true });
  });

  it('a failure to read it shows the words, keeps proposing disabled, and trying again works', async () => {
    const { client } = fakeClient({ mode: [bad('network', 'Offline.'), okv({ mode: 'demo' })] });
    const s = createCaptureSession({ client });
    expect(await s.loadMode()).toMatchObject({ ok: false, kind: 'network', message: 'Offline.' });
    expect(s.getState()).toMatchObject({ mode: { status: 'error', value: null, error: 'Offline.' }, canPropose: false });
    expect(await s.loadMode()).toEqual({ ok: true });
    expect(s.getState().canPropose).toBe(true);
  });
});

describe('proposing', () => {
  it('holds the one current proposal and shows the preview; nothing is approved', async () => {
    const { s, calls } = await known({ propose: okv(proposal({ rationale: 'because' })) });
    const r = await s.propose('a note');
    expect(r).toMatchObject({ ok: true, proposal: { id: P } });
    expect(calls.find((c) => c.name === 'propose').args).toEqual(['a note']);
    expect(s.getState()).toMatchObject({ phase: 'preview', proposal: { id: P, rationale: 'because' }, canPropose: false, outcome: null });
    expect(names(calls)).not.toContain('approve');
  });

  it('a second proposal is refused while one is pending and nothing is sent', async () => {
    const { s, calls } = await known({ propose: okv(proposal()) });
    await s.propose('a note');
    expect(await s.propose('another')).toMatchObject({ ok: false, kind: 'pending' });
    expect(calls.filter((c) => c.name === 'propose')).toHaveLength(1);
  });

  it('a refusal shows the service\'s words; a field problem is returned beside its field; no proposal is held', async () => {
    const { s } = await known({ propose: [bad('invalid', 'Write a note first.', { field: 'text' }), bad('limit', 'you have made the most proposals allowed in an hour', { retryAfterSeconds: 1800 }), bad('model', 'the model took too long: try again', { reason: 'timeout' })] });
    expect(await s.propose('')).toMatchObject({ ok: false, kind: 'invalid', message: 'Write a note first.', errors: { text: 'Write a note first.' } });
    expect(await s.propose('x')).toMatchObject({ ok: false, kind: 'limit', retryAfterSeconds: 1800 });
    expect(await s.propose('x')).toMatchObject({ ok: false, kind: 'model' });
    expect(s.getState()).toMatchObject({ phase: 'form', proposal: null, canPropose: true });
  });

  it('a signed-out answer calls onSignedOut', async () => {
    let n = 0;
    const { s } = await known({ propose: bad('signed-out', 'Your session has ended. Sign in again.') }, { onSignedOut: () => n++ });
    expect(await s.propose('x')).toMatchObject({ kind: 'signed-out' });
    expect(n).toBe(1);
  });

  it('a throwing onSignedOut does not matter', async () => {
    const { s } = await known({ propose: bad('signed-out') }, { onSignedOut: () => { throw new Error('x'); } });
    expect((await s.propose('x')).kind).toBe('signed-out');
  });
});

describe('approving', () => {
  it('writes, says how many operations and what they were, clears the proposal, and tells the page the brain changed', async () => {
    let written = 0;
    const { s, calls } = await known({ propose: okv(proposal()), approve: okv({ id: P, applied: 3, summary: SUMMARY }) }, { onWritten: () => written++ });
    await s.propose('a note');
    const r = await s.approve();
    expect(r).toEqual({ ok: true, applied: 3, summary: SUMMARY });
    expect(calls.find((c) => c.name === 'approve').args).toEqual([P]);
    expect(s.getState()).toMatchObject({ phase: 'done', proposal: null, outcome: { kind: 'written', applied: 3, summary: SUMMARY }, canPropose: true });
    expect(written).toBe(1);
  });

  it('with no proposal there is nothing to approve and nothing is sent', async () => {
    const { s, calls } = await known({});
    expect(await s.approve()).toMatchObject({ ok: false, kind: 'nothing-pending' });
    expect(names(calls)).toEqual(['mode']);
  });

  it('a refused write keeps the proposal, in the service\'s words, so it can be retried or rejected; onWritten is not called', async () => {
    let written = 0;
    const { s } = await known({ propose: okv(proposal()), approve: [bad('refused', 'this proposal can no longer be applied'), okv({ id: P, applied: 1, summary: SUMMARY })] }, { onWritten: () => written++ });
    await s.propose('a note');
    expect(await s.approve()).toMatchObject({ ok: false, kind: 'refused', message: 'this proposal can no longer be applied' });
    expect(s.getState()).toMatchObject({ phase: 'preview', proposal: { id: P }, outcome: null });
    expect(written).toBe(0);
    expect(await s.approve()).toMatchObject({ ok: true });
    expect(written).toBe(1);
  });

  it('a proposal that has expired, and one the service no longer has, end in words and nothing is written', async () => {
    for (const [error, kind] of [[bad('expired', 'That proposal is gone or has expired. Make it again.', { what: 'proposal' }), 'expired'], [bad('not-found', 'That proposal is gone or has expired. Make it again.', { what: 'proposal' }), 'gone']]) {
      let written = 0;
      const { s } = await known({ propose: okv(proposal()), approve: error }, { onWritten: () => written++ });
      await s.propose('a note');
      expect(await s.approve()).toMatchObject({ ok: false });
      expect(s.getState()).toMatchObject({ phase: 'done', proposal: null, outcome: { kind, message: 'That proposal is gone or has expired. Make it again.' } });
      expect(written).toBe(0);
    }
  });

  it('other failures (the service is down, the person is signed out) keep the proposal', async () => {
    for (const kind of ['server', 'network', 'signed-out']) {
      const { s } = await known({ propose: okv(proposal()), approve: bad(kind) });
      await s.propose('a note');
      expect((await s.approve()).kind).toBe(kind);
      expect(s.getState()).toMatchObject({ phase: 'preview', proposal: { id: P } });
    }
  });
});

describe('rejecting', () => {
  it('discards the proposal, writes nothing, and says so', async () => {
    let written = 0;
    const { s, calls } = await known({ propose: okv(proposal()) }, { onWritten: () => written++ });
    await s.propose('a note');
    expect(await s.reject()).toEqual({ ok: true });
    expect(calls.find((c) => c.name === 'reject').args).toEqual([P]);
    expect(s.getState()).toMatchObject({ phase: 'done', proposal: null, outcome: { kind: 'rejected' } });
    expect(written).toBe(0);
    expect(names(calls)).not.toContain('approve');
  });

  it('with nothing pending there is nothing to reject', async () => {
    const { s, calls } = await known({});
    expect(await s.reject()).toMatchObject({ ok: false, kind: 'nothing-pending' });
    expect(names(calls)).toEqual(['mode']);
  });

  it('a gone or expired proposal ends in words; other failures keep it', async () => {
    const a = await known({ propose: okv(proposal()), reject: bad('not-found', 'gone', { what: 'proposal' }) });
    await a.s.propose('x');
    await a.s.reject();
    expect(a.s.getState()).toMatchObject({ proposal: null, outcome: { kind: 'gone' } });
    const b = await known({ propose: okv(proposal()), reject: bad('expired', 'gone', { what: 'proposal' }) });
    await b.s.propose('x');
    await b.s.reject();
    expect(b.s.getState().outcome.kind).toBe('expired');
    const c = await known({ propose: okv(proposal()), reject: bad('network') });
    await c.s.propose('x');
    expect((await c.s.reject()).kind).toBe('network');
    expect(c.s.getState()).toMatchObject({ phase: 'preview', proposal: { id: P } });
  });
});

describe('starting again', () => {
  it('closes the outcome and shows the form; nothing is sent; not while a proposal is pending or a request is out', async () => {
    const g = deferred();
    const { s, calls } = await known({ propose: okv(proposal()), reject: () => g.promise });
    await s.propose('x');
    expect(s.startAgain()).toBe(false); // a proposal is pending
    const p = s.reject();
    expect(s.startAgain()).toBe(false); // a request is out
    g.resolve(okv(true));
    await p;
    const sent = calls.length;
    expect(s.getState().phase).toBe('done');
    expect(s.startAgain()).toBe(true);
    expect(s.getState()).toMatchObject({ phase: 'form', outcome: null, canPropose: true });
    expect(calls).toHaveLength(sent);
  });

  it('a new proposal after an outcome clears the outcome', async () => {
    const { s } = await known({ propose: okv(proposal()), reject: okv(true) });
    await s.propose('x');
    await s.reject();
    await s.propose('y');
    expect(s.getState()).toMatchObject({ phase: 'preview', outcome: null });
  });
});

describe('one request at a time', () => {
  it('every action is refused while one is out, and nothing is sent', async () => {
    const g = deferred();
    const { s, calls } = await known({ propose: () => g.promise });
    const first = s.propose('a note');
    expect(s.getState()).toMatchObject({ busy: true, canPropose: false });
    for (const r of [await s.propose('b'), await s.loadMode()]) expect(r.kind).toBe('busy');
    g.resolve(okv(proposal()));
    await first;
    expect(calls.filter((c) => c.name === 'propose')).toHaveLength(1);
    expect(s.getState().busy).toBe(false);
  });

  it('approve and reject are refused while one is out', async () => {
    const g = deferred();
    const { s } = await known({ propose: okv(proposal()), approve: () => g.promise });
    await s.propose('x');
    const first = s.approve();
    expect((await s.approve()).kind).toBe('busy');
    expect((await s.reject()).kind).toBe('busy');
    g.resolve(okv({ id: P, applied: 1, summary: SUMMARY }));
    await first;
  });

  it('busy is cleared after a failure', async () => {
    const { s } = await known({ propose: bad('server') });
    await s.propose('x');
    expect(s.getState().busy).toBe(false);
  });
});

describe('leaving the screen or signing out', () => {
  it('reset forgets everything, and an answer that arrives afterwards is dropped quietly', async () => {
    const g = deferred();
    let n = 0;
    const { s } = await known({ propose: () => g.promise }, { onSignedOut: () => n++ });
    const p = s.propose('x');
    s.reset();
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown' }, proposal: null, outcome: null, busy: false, phase: 'form' });
    g.resolve(okv(proposal()));
    expect(await p).toMatchObject({ ok: false, kind: 'dropped' });
    expect(s.getState().proposal).toBeNull();
    expect(n).toBe(0);
  });

  it('an old request finishing after a reset does not clear the busy mark of a newer one', async () => {
    const a = deferred();
    const b = deferred();
    const queue = [a, b];
    const { client } = fakeClient({ mode: () => queue.shift().promise });
    const s = createCaptureSession({ client });
    const old = s.loadMode();
    s.reset();
    const fresh = s.loadMode();
    a.resolve(okv({ mode: 'demo' }));
    await old;
    expect(s.getState().busy).toBe(true);
    b.resolve(okv({ mode: 'anthropic' }));
    await fresh;
    expect(s.getState()).toMatchObject({ busy: false, mode: { value: 'anthropic' } });
  });

  it('a pending proposal is gone after a reset, and the mode must be read again', async () => {
    const { s } = await known({ propose: okv(proposal()) });
    await s.propose('x');
    s.reset();
    expect(s.getState()).toMatchObject({ proposal: null, canPropose: false });
    expect(await s.approve()).toMatchObject({ kind: 'nothing-pending' });
  });
});

describe('listeners and construction', () => {
  it('listeners hear changes, can leave, and a broken one does not matter', async () => {
    const { client } = fakeClient({ mode: okv({ mode: 'demo' }) });
    const s = createCaptureSession({ client });
    const seen = [];
    const off = s.subscribe((v) => seen.push(v.busy));
    s.subscribe(() => { throw new Error('x'); });
    await s.loadMode();
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
    const n = seen.length;
    off();
    await s.loadMode();
    expect(seen).toHaveLength(n);
  });

  it('snapshots are frozen', async () => {
    const { s } = await known({});
    const st = s.getState();
    expect(Object.isFrozen(st) && Object.isFrozen(st.mode)).toBe(true);
  });

  it('a throwing onWritten does not matter', async () => {
    const { s } = await known({ propose: okv(proposal()), approve: okv({ id: P, applied: 1, summary: SUMMARY }) }, { onWritten: () => { throw new Error('x'); } });
    await s.propose('x');
    expect((await s.approve()).ok).toBe(true);
  });

  it('needs a client', () => {
    expect(() => createCaptureSession({})).toThrow(TypeError);
    expect(() => createCaptureSession({ client: {} })).toThrow(TypeError);
  });
});
