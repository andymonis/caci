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
function fakeClient(script) {
  const calls = [];
  return { calls, client: { status: (...args) => (calls.push(args), Promise.resolve(typeof script === 'function' ? script(...args) : script)) } };
}
const make = (script, options = {}) => {
  const f = fakeClient(script);
  return { ...f, s: createStatusSession({ client: f.client, timeZone: () => 'Europe/London', ...options }) };
};

describe('asking for a status', () => {
  it('starts empty, sends the text and the time zone, and holds the one answer in memory', async () => {
    const { s, calls } = make(okv(VIEW));
    expect(s.getState()).toEqual({ answer: null, asked: '', busy: false });
    const r = await s.ask('  status please  ');
    expect(r).toEqual({ ok: true, status: VIEW });
    expect(calls).toEqual([['  status please  ', 'Europe/London']]);
    expect(s.getState()).toEqual({ answer: VIEW, asked: 'status please', busy: false });
  });

  it('sends no time zone when the browser cannot say', async () => {
    const { s, calls } = make(okv(VIEW), { timeZone: () => undefined });
    await s.ask('x');
    expect(calls).toEqual([['x']]);
    const none = make(okv(VIEW), { timeZone: null });
    await none.s.ask('x');
    expect(none.calls).toEqual([['x']]);
  });

  it('a field problem comes back beside the field and changes nothing', async () => {
    const { s } = make(bad('invalid', 'Say what you would like a status on.', { field: 'text' }));
    expect(await s.ask('')).toEqual({ ok: false, kind: 'invalid', message: 'Say what you would like a status on.', field: 'text', errors: { text: 'Say what you would like a status on.' } });
    expect(s.getState()).toEqual({ answer: null, asked: '', busy: false });
  });

  it('a failure keeps the last good answer and says why, with the wait when there is one', async () => {
    let n = 0;
    const { s } = make(() => (n++ === 0 ? okv(VIEW) : bad('limit', 'Too many.', { retryAfterSeconds: 60 })));
    await s.ask('first');
    expect(await s.ask('second')).toEqual({ ok: false, kind: 'limit', message: 'Too many.', retryAfterSeconds: 60 });
    expect(s.getState()).toEqual({ answer: VIEW, asked: 'first', busy: false });
  });

  it('model failures carry their kind and reason words through', async () => {
    const { s } = make(bad('model', 'The model took too long.', { reason: 'timeout' }));
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'model', message: 'The model took too long.' });
  });

  it('one request at a time: a second ask meanwhile is refused as busy and sends nothing', async () => {
    const d = deferred();
    const { s, calls } = make(() => d.promise);
    const first = s.ask('one');
    expect(s.getState().busy).toBe(true);
    expect(await s.ask('two')).toMatchObject({ ok: false, kind: 'busy' });
    expect(calls).toHaveLength(1);
    d.resolve(okv(VIEW));
    await first;
    expect(s.getState().busy).toBe(false);
  });

  it('busy is cleared after a failure and after a client that throws', async () => {
    const { s } = make(() => {
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
    const { s } = make(() => d.promise, { onSignedOut: () => out++ });
    const p = s.ask('x');
    s.reset();
    d.resolve(bad('signed-out', 'Your session has ended.'));
    expect(await p).toEqual({ ok: false, kind: 'dropped', message: '' });
    expect(out).toBe(0);
    expect(s.getState()).toEqual({ answer: null, asked: '', busy: false });
  });

  it('a late answer does not clear a newer request\'s busy mark', async () => {
    const a = deferred();
    const b = deferred();
    let n = 0;
    const { s } = make(() => (n++ === 0 ? a.promise : b.promise));
    const first = s.ask('one');
    s.reset();
    const second = s.ask('two');
    a.resolve(okv(VIEW));
    await first;
    expect(s.getState().busy).toBe(true);
    b.resolve(okv({ ...VIEW, headline: 'second' }));
    await second;
    expect(s.getState().answer.headline).toBe('second');
  });

  it('reset drops an answer that was already held', async () => {
    const { s } = make(okv(VIEW));
    await s.ask('x');
    s.reset();
    expect(s.getState().answer).toBeNull();
  });

  it('clear closes the answer and sends nothing, but not while a request is out', async () => {
    const d = deferred();
    let n = 0;
    const { s, calls } = make(() => (n++ === 0 ? okv(VIEW) : d.promise));
    await s.ask('x');
    expect(s.clear()).toBe(true);
    expect(s.getState()).toEqual({ answer: null, asked: '', busy: false });
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
    const { s } = make(bad('signed-out', 'Sign in.'), { onSignedOut: () => { out++; throw new Error('x'); } });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'signed-out' });
    expect(out).toBe(1);
  });
});

describe('other failures', () => {
  it('are not a sign-out', async () => {
    let out = 0;
    const { s } = make(bad('server', 'Oops.'), { onSignedOut: () => out++ });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'server' });
    expect(out).toBe(0);
  });
});

describe('listeners', () => {
  it('hear busy and the answer, can unsubscribe, and a broken one does not stop the others', async () => {
    const { s } = make(okv(VIEW));
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
