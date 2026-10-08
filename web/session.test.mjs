import { describe, expect, it } from 'vitest';
import { createSession } from './session.js';

const USER = { id: 'u1', username: 'ann', displayName: 'Ann' };
const PW = 'correct horse 7 staple';
const NETWORK = { ok: false, error: { kind: 'network', message: 'Cannot reach the service. Check your connection and try again.' } };
const SERVER = { ok: false, error: { kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' } };
const SIGNED_OUT = { ok: false, error: { kind: 'signed-out', message: 'You are not signed in.' } };

/** A scripted API client: each method returns what the test queued (or a default), and records its arguments. */
function scripted(script = {}) {
  const calls = [];
  const gates = {};
  const api = {};
  for (const name of ['me', 'register', 'login', 'logout']) {
    api[name] = async (...args) => {
      calls.push([name, ...args]);
      if (gates[name]) await gates[name];
      const next = script[name];
      const r = typeof next === 'function' ? next(...args) : next;
      return r ?? { ok: true, value: USER };
    };
  }
  return { api, calls, gates };
}
const record = (session) => {
  const seen = [];
  session.subscribe((s) => seen.push(s));
  return seen;
};
const valid = { username: 'Ann', displayName: 'Ann', email: '', password: PW };

describe('starting', () => {
  it('begins loading', () => {
    const s = createSession({ api: scripted().api });
    expect(s.getState()).toEqual({ screen: 'loading', user: null, busy: false, notice: null });
  });

  it('signed in when the service says so', async () => {
    const s = createSession({ api: scripted({ me: { ok: true, value: USER } }).api });
    await s.start();
    expect(s.getState()).toEqual({ screen: 'signed-in', user: USER, busy: false, notice: null });
  });

  it('signed out on "not signed in", with no notice', async () => {
    const s = createSession({ api: scripted({ me: SIGNED_OUT }).api });
    await s.start();
    expect(s.getState()).toEqual({ screen: 'signed-out', user: null, busy: false, notice: null });
  });

  it('unreachable on a network or server failure, with the words to show; trying again works', async () => {
    let answer = NETWORK;
    const s = createSession({ api: scripted({ me: () => answer }).api });
    await s.start();
    expect(s.getState()).toMatchObject({ screen: 'unreachable', user: null, notice: NETWORK.error.message });
    answer = SERVER;
    await s.start();
    expect(s.getState()).toMatchObject({ screen: 'unreachable', notice: SERVER.error.message });
    answer = { ok: true, value: USER };
    await s.start();
    expect(s.getState()).toMatchObject({ screen: 'signed-in', notice: null });
  });

  it('shows loading while it asks', async () => {
    const { api, gates } = scripted();
    let open;
    gates.me = new Promise((resolve) => (open = resolve));
    const s = createSession({ api });
    const seen = record(s);
    const started = s.start();
    expect(s.getState().screen).toBe('loading');
    open();
    await started;
    expect(seen.map((v) => v.screen)).toEqual(['loading', 'signed-in']);
  });

  it('needs an API client', () => {
    for (const bad of [undefined, null, {}, { me: 5 }]) expect(() => createSession({ api: bad })).toThrow(TypeError);
  });
});

describe('registering', () => {
  it('registers with the cleaned values, then signs in with the same username and password, and shows the signed-in screen', async () => {
    const { api, calls } = scripted();
    const s = createSession({ api });
    expect(await s.register(valid)).toEqual({ ok: true });
    expect(calls).toEqual([['register', { username: 'ann', displayName: 'Ann', password: PW }], ['login', { username: 'ann', password: PW }]]);
    expect(s.getState()).toEqual({ screen: 'signed-in', user: USER, busy: false, notice: null });
  });

  it('signs in with the password exactly as it was typed, spaces and all', async () => {
    const { api, calls } = scripted();
    await createSession({ api }).register({ ...valid, password: '  twelve chars  ' });
    expect(calls[0][1].password).toBe('  twelve chars  ');
    expect(calls[1][1].password).toBe('  twelve chars  ');
  });

  it('passes the email on when there is one', async () => {
    const { api, calls } = scripted();
    await createSession({ api }).register({ ...valid, email: 'ann@example.com' });
    expect(calls[0][1]).toEqual({ username: 'ann', displayName: 'Ann', email: 'ann@example.com', password: PW });
  });

  it('a form that does not pass the early checks is not sent, and says which fields are wrong', async () => {
    const { api, calls } = scripted();
    const s = createSession({ api });
    const r = await s.register({ username: 'a', displayName: '', password: 'short' });
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
    expect(Object.keys(r.errors).sort()).toEqual(['displayName', 'password', 'username']);
    expect(calls).toEqual([]);
    expect(s.getState().busy).toBe(false);
  });

  it('a taken username comes back on the username field, and nothing is signed in', async () => {
    const { api, calls } = scripted({ register: { ok: false, error: { kind: 'taken', message: 'that username is taken', field: 'username' } } });
    const s = createSession({ api });
    const r = await s.register(valid);
    expect(r).toEqual({ ok: false, kind: 'taken', errors: { username: 'that username is taken' }, message: 'that username is taken' });
    expect(calls.map((c) => c[0])).toEqual(['register']);
    expect(s.getState().screen).toBe('loading'); // unchanged: the page is on the signed-out screen already
  });

  it('closed registration, a throttle with its wait, a server answer with a field, and a network failure are each passed on', async () => {
    const cases = [
      [{ kind: 'closed', message: 'Registration is closed on this service.' }, { kind: 'closed', message: 'Registration is closed on this service.' }],
      [{ kind: 'throttled', message: 'Too many tries. Wait 30 seconds and try again.', retryAfterSeconds: 30 }, { kind: 'throttled', message: 'Too many tries. Wait 30 seconds and try again.', retryAfterSeconds: 30 }],
      [{ kind: 'invalid', message: 'bad password', field: 'password' }, { kind: 'invalid', message: 'bad password', errors: { password: 'bad password' } }],
      [NETWORK.error, { kind: 'network', message: NETWORK.error.message }],
    ];
    for (const [error, expected] of cases) {
      const r = await createSession({ api: scripted({ register: { ok: false, error } }).api }).register(valid);
      expect(r).toEqual({ ok: false, ...expected });
    }
  });

  it('if the account is made but signing in fails, it says so and offers sign-in, and is signed out', async () => {
    const s = createSession({ api: scripted({ login: NETWORK }).api });
    const r = await s.register(valid);
    expect(r).toMatchObject({ ok: false, kind: 'signin-after-register', accountCreated: true });
    expect(r.message).toBe(`Your account was made, but signing you in failed: ${NETWORK.error.message} Try signing in.`);
    expect(s.getState()).toMatchObject({ screen: 'signed-out', user: null });
  });
});

describe('signing in', () => {
  it('signs in with the cleaned username and the password as typed', async () => {
    const { api, calls } = scripted();
    const s = createSession({ api });
    expect(await s.signIn({ username: ' ANN ', password: '  pw  ' })).toEqual({ ok: true });
    expect(calls).toEqual([['login', { username: 'ann', password: '  pw  ' }]]);
    expect(s.getState()).toMatchObject({ screen: 'signed-in', user: USER });
  });

  it('missing fields are not sent', async () => {
    const { api, calls } = scripted();
    const r = await createSession({ api }).signIn({ username: '', password: '' });
    expect(r).toEqual({ ok: false, kind: 'invalid', errors: { username: 'Enter your username.', password: 'Enter your password.' } });
    expect(calls).toEqual([]);
  });

  it('a wrong pair shows the service\'s message and stays signed out; being held back shows the wait', async () => {
    const wrong = createSession({ api: scripted({ login: { ok: false, error: { kind: 'credentials', message: 'wrong username or password' } } }).api });
    expect(await wrong.signIn({ username: 'ann', password: 'x' })).toEqual({ ok: false, kind: 'credentials', message: 'wrong username or password' });
    expect(wrong.getState().screen).not.toBe('signed-in');
    const held = createSession({ api: scripted({ login: { ok: false, error: { kind: 'throttled', message: 'Too many tries. Wait 12 seconds and try again.', retryAfterSeconds: 12 } } }).api });
    expect(await held.signIn({ username: 'ann', password: 'x' })).toEqual({ ok: false, kind: 'throttled', message: 'Too many tries. Wait 12 seconds and try again.', retryAfterSeconds: 12 });
  });
});

describe('signing out', () => {
  async function signedIn(extra) {
    const set = scripted({ me: { ok: true, value: USER }, ...extra });
    const s = createSession({ api: set.api });
    await s.start();
    return { s, ...set };
  }

  it('goes to the signed-out screen when the service says done', async () => {
    const { s } = await signedIn({ logout: { ok: true, value: true } });
    expect(await s.signOut()).toEqual({ ok: true });
    expect(s.getState()).toEqual({ screen: 'signed-out', user: null, busy: false, notice: null });
  });

  it('also when the service says you were not signed in', async () => {
    const { s } = await signedIn({ logout: SIGNED_OUT });
    expect(await s.signOut()).toEqual({ ok: true });
    expect(s.getState().screen).toBe('signed-out');
  });

  it('if the service cannot be reached you stay signed in and are told you may still be', async () => {
    const { s } = await signedIn({ logout: NETWORK });
    const r = await s.signOut();
    expect(r).toMatchObject({ ok: false, kind: 'network' });
    expect(s.getState()).toMatchObject({ screen: 'signed-in', user: USER });
    expect(s.getState().notice).toBe(`Could not sign you out: ${NETWORK.error.message} You may still be signed in.`);
  });

  it('the notice goes when the next thing succeeds', async () => {
    let answer = NETWORK;
    const { s } = await signedIn({ logout: () => answer });
    await s.signOut();
    answer = { ok: true, value: true };
    await s.signOut();
    expect(s.getState()).toMatchObject({ screen: 'signed-out', notice: null });
  });
});

describe('one request at a time', () => {
  it('a second call while one is being sent is refused with "busy", and sends nothing', async () => {
    const { api, calls, gates } = scripted();
    let open;
    gates.login = new Promise((resolve) => (open = resolve));
    const s = createSession({ api });
    const first = s.signIn({ username: 'ann', password: 'pw' });
    expect(s.getState().busy).toBe(true);
    const second = await s.signIn({ username: 'ann', password: 'pw' });
    const third = await s.register(valid);
    const fourth = await s.signOut();
    for (const r of [second, third, fourth]) expect(r).toMatchObject({ ok: false, kind: 'busy' });
    open();
    expect(await first).toEqual({ ok: true });
    expect(calls.filter((c) => c[0] === 'login')).toHaveLength(1);
    expect(s.getState().busy).toBe(false);
  });

  it('is free again after a failure, and even after an API that throws', async () => {
    const throwing = createSession({ api: { me: async () => ({ ok: true, value: USER }), login: async () => { throw new Error('boom'); }, register: async () => ({ ok: true, value: USER }), logout: async () => ({ ok: true, value: true }) } });
    await expect(throwing.signIn({ username: 'ann', password: 'pw' })).rejects.toThrow('boom');
    expect(throwing.getState().busy).toBe(false);
    const failing = createSession({ api: scripted({ login: NETWORK }).api });
    await failing.signIn({ username: 'ann', password: 'pw' });
    expect(failing.getState().busy).toBe(false);
  });
});

describe('listeners and secrets', () => {
  it('everyone who subscribed hears every change, in order, with a frozen snapshot; unsubscribing stops it; a broken listener does not matter', async () => {
    const s = createSession({ api: scripted().api });
    const a = record(s);
    const stop = s.subscribe(() => {
      throw new Error('broken listener');
    });
    const b = record(s);
    await s.signIn({ username: 'ann', password: 'pw' });
    expect(a.map((v) => [v.screen, v.busy])).toEqual([['loading', true], ['signed-in', true], ['signed-in', false]]);
    expect(b).toEqual(a);
    expect(a.every((v) => Object.isFrozen(v))).toBe(true);
    stop();
    const unsub = s.subscribe(() => {});
    unsub();
    const count = a.length;
    await s.signOut();
    expect(a.length).toBeGreaterThan(count);
  });

  it('a listener that has unsubscribed hears nothing more', async () => {
    const s = createSession({ api: scripted().api });
    const heard = [];
    const stop = s.subscribe((v) => heard.push(v));
    await s.start();
    const before = heard.length;
    expect(before).toBeGreaterThan(0);
    stop();
    await s.signIn({ username: 'ann', password: 'pw' });
    await s.signOut();
    expect(heard).toHaveLength(before);
  });

  it('the password is in no state, no snapshot and no result, whatever happens', async () => {
    const secret = 'a-very-distinct-password-9183';
    const outcomes = [
      scripted(),
      scripted({ register: { ok: false, error: { kind: 'invalid', message: 'bad', field: 'password' } } }),
      scripted({ login: NETWORK }),
      scripted({ register: NETWORK }),
    ];
    for (const set of outcomes) {
      const s = createSession({ api: set.api });
      const seen = record(s);
      const results = [await s.register({ username: 'ann', displayName: 'Ann', password: secret }), await s.signIn({ username: 'ann', password: secret })];
      expect(JSON.stringify([seen, results, s.getState()])).not.toContain(secret);
    }
  });

  it('the state holds only the screen, the person (id, username, display name), whether it is busy, and a notice', async () => {
    const s = createSession({ api: scripted({ me: { ok: true, value: USER } }).api });
    await s.start();
    expect(Object.keys(s.getState()).sort()).toEqual(['busy', 'notice', 'screen', 'user']);
    expect(Object.keys(s.getState().user).sort()).toEqual(['displayName', 'id', 'username']);
  });
});
