import { describe, expect, it } from 'vitest';
import { browserTimeZone, createStatusSession } from './status-session.js';

const VIEW = { headline: 'H', points: [], nothing: true, generatedAt: 1, mode: 'demo', entriesUsed: 0, entriesLeftOut: 0 };
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fakeClient(script, mode = okv({ mode: 'demo' })) {
  const calls = [];
  const modeCalls = [];
  return {
    calls,
    modeCalls,
    client: {
      status: (...args) => (calls.push(args), Promise.resolve(typeof script === 'function' ? script(...args) : script)),
      mode: () => (modeCalls.push(1), Promise.resolve(typeof mode === 'function' ? mode() : mode)),
    },
  };
}
const make = (script, options = {}, mode) => {
  const f = fakeClient(script, mode);
  return { ...f, s: createStatusSession({ client: f.client, timeZone: () => 'Europe/London', ...options }) };
};
/** A session whose mode is already known. */
const ready = async (script, options, mode) => {
  const m = make(script, options, mode);
  expect(await m.s.loadMode()).toEqual({ ok: true });
  return m;
};

describe('which model answers', () => {
  it('starts unknown and nothing can be asked, not even a request; loading the mode makes it known', async () => {
    const { s, calls, modeCalls } = make(okv(VIEW), {}, okv({ mode: 'anthropic' }));
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown', value: null, error: null }, canAsk: false });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'mode-unknown' });
    expect(calls).toEqual([]);
    const p = s.loadMode();
    expect(s.getState()).toMatchObject({ mode: { status: 'loading' }, canAsk: false, busy: true });
    expect(await p).toEqual({ ok: true });
    expect(modeCalls).toHaveLength(1);
    expect(s.getState()).toMatchObject({ mode: { status: 'known', value: 'anthropic', error: null }, canAsk: true });
  });

  it('a failure to read it shows the words, keeps asking disabled, and trying again works', async () => {
    let n = 0;
    const { s } = make(okv(VIEW), {}, () => (n++ === 0 ? bad('network', 'Offline.') : okv({ mode: 'demo' })));
    expect(await s.loadMode()).toMatchObject({ ok: false, kind: 'network', message: 'Offline.' });
    expect(s.getState()).toMatchObject({ mode: { status: 'error', value: null, error: 'Offline.' }, canAsk: false });
    expect(await s.ask('x')).toMatchObject({ kind: 'mode-unknown' });
    expect(await s.loadMode()).toEqual({ ok: true });
    expect(s.getState().canAsk).toBe(true);
  });

  it('is reported as a sign-out when the session ended, and refused while a request is out', async () => {
    let out = 0;
    const { s } = make(okv(VIEW), { onSignedOut: () => out++ }, bad('signed-out', 'Sign in.'));
    expect(await s.loadMode()).toMatchObject({ ok: false, kind: 'signed-out' });
    expect(out).toBe(1);
    const d = deferred();
    const m = make(okv(VIEW), {}, () => d.promise);
    const first = m.s.loadMode();
    expect(await m.s.loadMode()).toMatchObject({ ok: false, kind: 'busy' });
    expect(m.modeCalls).toHaveLength(1);
    d.resolve(okv({ mode: 'demo' }));
    await first;
  });

  it('reset forgets it, and a mode answer that arrives after a reset is dropped', async () => {
    const d = deferred();
    const { s } = make(okv(VIEW), {}, () => d.promise);
    const p = s.loadMode();
    s.reset();
    d.resolve(okv({ mode: 'demo' }));
    expect(await p).toEqual({ ok: false, kind: 'dropped', message: '' });
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown' }, canAsk: false, busy: false });
    const r = await ready(okv(VIEW));
    r.s.reset();
    expect(r.s.getState().mode.status).toBe('unknown');
  });
});

describe('asking for a status', () => {
  it('starts empty, sends the text and the time zone, and holds the one answer in memory', async () => {
    const { s, calls } = await ready(okv(VIEW));
    expect(s.getState()).toMatchObject({ answer: null, asked: '', busy: false });
    const r = await s.ask('  status please  ');
    expect(r).toEqual({ ok: true, status: VIEW });
    expect(calls).toEqual([['  status please  ', 'Europe/London']]);
    expect(s.getState()).toMatchObject({ answer: VIEW, asked: 'status please', busy: false });
  });

  it('sends no time zone when the browser cannot say', async () => {
    const { s, calls } = await ready(okv(VIEW), { timeZone: () => undefined });
    await s.ask('x');
    expect(calls).toEqual([['x']]);
    const none = await ready(okv(VIEW), { timeZone: null });
    await none.s.ask('x');
    expect(none.calls).toEqual([['x']]);
  });

  it('a field problem comes back beside the field and changes nothing', async () => {
    const { s } = await ready(bad('invalid', 'Say what you would like a status on.', { field: 'text' }));
    expect(await s.ask('')).toEqual({ ok: false, kind: 'invalid', message: 'Say what you would like a status on.', field: 'text', errors: { text: 'Say what you would like a status on.' } });
    expect(s.getState()).toMatchObject({ answer: null, asked: '', busy: false });
  });

  it('a failure keeps the last good answer and says why, with the wait when there is one', async () => {
    let n = 0;
    const { s } = await ready(() => (n++ === 0 ? okv(VIEW) : bad('limit', 'Too many.', { retryAfterSeconds: 60 })));
    await s.ask('first');
    expect(await s.ask('second')).toEqual({ ok: false, kind: 'limit', message: 'Too many.', retryAfterSeconds: 60 });
    expect(s.getState()).toMatchObject({ answer: VIEW, asked: 'first', busy: false });
  });

  it('model failures carry their kind and reason words through', async () => {
    const { s } = await ready(bad('model', 'The model took too long.', { reason: 'timeout' }));
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'model', message: 'The model took too long.' });
  });

  it('one request at a time: a second ask meanwhile is refused as busy and sends nothing', async () => {
    const d = deferred();
    const { s, calls } = await ready(() => d.promise);
    const first = s.ask('one');
    expect(s.getState().busy).toBe(true);
    expect(await s.ask('two')).toMatchObject({ ok: false, kind: 'busy' });
    expect(calls).toHaveLength(1);
    d.resolve(okv(VIEW));
    await first;
    expect(s.getState().busy).toBe(false);
  });

  it('busy is cleared after a failure and after a client that throws', async () => {
    const { s } = await ready(() => {
      throw new Error('boom');
    });
    await expect(s.ask('x')).rejects.toThrow('boom');
    expect(s.getState().busy).toBe(false);
  });
});

describe('forgetting', () => {
  it('reset forgets the answer, and an answer still on its way is dropped quietly', async () => {
    const d = deferred();
    let out = 0;
    const { s } = await ready(() => d.promise, { onSignedOut: () => out++ });
    const p = s.ask('x');
    s.reset();
    d.resolve(bad('signed-out', 'Your session has ended.'));
    expect(await p).toEqual({ ok: false, kind: 'dropped', message: '' });
    expect(out).toBe(0);
    expect(s.getState()).toMatchObject({ answer: null, asked: '', busy: false });
  });

  it('a late answer does not clear a newer request\'s busy mark', async () => {
    const a = deferred();
    const b = deferred();
    let n = 0;
    const { s } = await ready(() => (n++ === 0 ? a.promise : b.promise));
    const first = s.ask('one');
    s.reset();
    await s.loadMode();
    const second = s.ask('two');
    a.resolve(okv(VIEW));
    await first;
    expect(s.getState().busy).toBe(true);
    b.resolve(okv({ ...VIEW, headline: 'second' }));
    await second;
    expect(s.getState().answer.headline).toBe('second');
  });

  it('reset drops an answer that was already held', async () => {
    const { s } = await ready(okv(VIEW));
    await s.ask('x');
    s.reset();
    expect(s.getState().answer).toBeNull();
  });

  it('clear closes the answer and sends nothing, but not while a request is out', async () => {
    const d = deferred();
    let n = 0;
    const { s, calls } = await ready(() => (n++ === 0 ? okv(VIEW) : d.promise));
    await s.ask('x');
    expect(s.clear()).toBe(true);
    expect(s.getState()).toMatchObject({ answer: null, asked: '', busy: false });
    expect(calls).toHaveLength(1);
    const p = s.ask('y');
    expect(s.clear()).toBe(false);
    d.resolve(okv(VIEW));
    await p;
    expect(s.getState().answer).toEqual(VIEW);
  });
});

describe('signing out', () => {
  it('is reported once per signed-out answer, and a throwing handler does not matter', async () => {
    let out = 0;
    const { s } = await ready(bad('signed-out', 'Sign in.'), { onSignedOut: () => { out++; throw new Error('x'); } });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'signed-out' });
    expect(out).toBe(1);
  });
});

describe('other failures', () => {
  it('are not a sign-out', async () => {
    let out = 0;
    const { s } = await ready(bad('server', 'Oops.'), { onSignedOut: () => out++ });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'server' });
    expect(out).toBe(0);
  });
});

describe('listeners', () => {
  it('hear busy and the answer, can unsubscribe, and a broken one does not stop the others', async () => {
    const { s } = await ready(okv(VIEW));
    const seen = [];
    s.subscribe(() => { throw new Error('broken'); });
    const off = s.subscribe((v) => seen.push([v.busy, v.answer !== null]));
    await s.ask('x');
    expect(seen).toEqual([[true, false], [false, true]]);
    off();
    s.reset();
    expect(seen).toHaveLength(2);
  });

  it('snapshots are frozen', () => {
    expect(Object.isFrozen(make(okv(VIEW)).s.getState())).toBe(true);
  });
});

describe('the time zone', () => {
  it('comes from the browser as an IANA name, or nothing', () => {
    const zone = browserTimeZone();
    expect(zone === undefined || (typeof zone === 'string' && zone.length > 0)).toBe(true);
  });
  it('needs a notes client', () => {
    expect(() => createStatusSession({ client: {} })).toThrow(TypeError);
    expect(() => createStatusSession({})).toThrow(TypeError);
  });
});
