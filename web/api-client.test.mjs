import { describe, expect, it } from 'vitest';
import { cleanMessage, createApiClient, parseRetryAfter } from './api-client.js';

const USER = { id: 'u1234567890abcdef', username: 'ann', displayName: 'Ann A', email: 'ann@example.com', role: 'admin', createdAt: 1, updatedAt: 2 };

/** A stand-in for the browser's fetch: records every call and answers with what the test says. */
function fake(answer) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    const a = typeof answer === 'function' ? answer(path, init, calls.length) : answer;
    if (a instanceof Error) throw a;
    return {
      status: a.status,
      headers: { get: (name) => (a.headers && a.headers[name.toLowerCase()]) ?? null },
      text: async () => {
        if (a.textFails) throw new Error('body stream failed');
        return a.raw !== undefined ? a.raw : a.body === undefined ? '' : JSON.stringify(a.body);
      },
    };
  };
  return { calls, client: createApiClient({ fetchFn }) };
}
const err = (status, error, headers) => ({ status, body: { error }, ...(headers ? { headers } : {}) });

describe('what is sent', () => {
  it('every request goes to the same address by path only, with the cookie left to the browser and no cache', async () => {
    const { calls, client } = fake({ status: 200, body: { user: USER } });
    await client.me();
    await client.login({ username: 'ann', password: 'secret password 1' });
    await client.register({ username: 'ann', displayName: 'Ann A', email: 'a@b.co', password: 'secret password 1' });
    await client.logout();
    expect(calls.map((c) => [c.init.method, c.path])).toEqual([['GET', '/api/me'], ['POST', '/api/login'], ['POST', '/api/register'], ['POST', '/api/logout']]);
    for (const { path, init } of calls) {
      expect(path.startsWith('/api/')).toBe(true);
      expect(path).not.toMatch(/^[a-z]+:\/\//);
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
      expect(Object.keys(init.headers).sort().filter((h) => !['accept', 'content-type'].includes(h))).toEqual([]); // no Authorization, no token
      expect(init.headers.accept).toBe('application/json');
    }
  });

  it('a body is JSON with the JSON content type; a request without a body has neither', async () => {
    const { calls, client } = fake({ status: 200, body: { user: USER } });
    await client.me();
    await client.logout();
    await client.login({ username: 'ann', password: 'pw' });
    expect('body' in calls[0].init).toBe(false);
    expect('content-type' in calls[0].init.headers).toBe(false);
    expect('body' in calls[1].init).toBe(false);
    expect(calls[2].init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[2].init.body)).toEqual({ username: 'ann', password: 'pw' });
  });

  it('register sends the four fields, and leaves the email out when there is none', async () => {
    const { calls, client } = fake({ status: 201, body: { user: USER } });
    await client.register({ username: 'ann', displayName: 'Ann A', email: '', password: 'pw' });
    await client.register({ username: 'ann', displayName: 'Ann A', password: 'pw' });
    await client.register({ username: 'ann', displayName: 'Ann A', email: 'a@b.co', password: 'pw' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ username: 'ann', displayName: 'Ann A', password: 'pw' });
    expect(JSON.parse(calls[1].init.body)).toEqual({ username: 'ann', displayName: 'Ann A', password: 'pw' });
    expect(JSON.parse(calls[2].init.body)).toEqual({ username: 'ann', displayName: 'Ann A', email: 'a@b.co', password: 'pw' });
  });

  it('sends only the fields it is meant to, whatever else it is handed', async () => {
    const { calls, client } = fake({ status: 200, body: { user: USER } });
    await client.login({ username: 'ann', password: 'pw', role: 'admin', graphId: 'x' });
    await client.register({ username: 'ann', displayName: 'A', password: 'pw', role: 'admin', id: 'u1' });
    expect(Object.keys(JSON.parse(calls[0].init.body))).toEqual(['username', 'password']);
    expect(Object.keys(JSON.parse(calls[1].init.body))).toEqual(['username', 'displayName', 'password']);
  });

  it('needs a fetch function', () => {
    for (const bad of [undefined, null, 'fetch', {}]) expect(() => createApiClient({ fetchFn: bad })).toThrow(TypeError);
  });
});

describe('what comes back when it works', () => {
  it('me, login and register give the user with only id, username and display name', async () => {
    const { client } = fake({ status: 200, body: { user: USER, graphId: 'user-u1234567890abcdef' } });
    for (const r of [await client.me(), await client.login({ username: 'ann', password: 'pw' }), await client.register({ username: 'ann', displayName: 'Ann A', password: 'pw' })]) {
      expect(r).toEqual({ ok: true, value: { id: 'u1234567890abcdef', username: 'ann', displayName: 'Ann A' } });
      expect(Object.isFrozen(r.value)).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/email|graph|role|example\.com/);
    }
  });

  it('a redirect or an informational answer is never a success, even with a user in it', async () => {
    for (const status of [100, 199, 301, 302, 304, 399]) {
      const r = await fake({ status, body: { user: USER } }).client.me();
      expect(r.ok, String(status)).toBe(false);
      expect(r.error.kind, String(status)).toBe('server');
    }
    for (const status of [200, 201, 202, 299]) expect((await fake({ status, body: { user: USER } }).client.me()).ok, String(status)).toBe(true);
  });

  it('logout is done on any 2xx, with or without a body', async () => {
    for (const a of [{ status: 204 }, { status: 200, body: {} }, { status: 200 }]) expect(await fake(a).client.logout()).toEqual({ ok: true, value: true });
  });

  it('an answer that is not shaped like a user is a server problem, not a crash', async () => {
    for (const raw of ['', '{}', '{"user":null}', '{"user":5}', '{"user":{}}', '{"user":{"id":"","username":"a","displayName":"b"}}', '{"user":{"id":"u1","username":"","displayName":"b"}}', '{"user":{"id":1,"username":"a","displayName":"b"}}', '{"user":{"id":"u1","username":"a"}}', 'not json', '[]', 'null', '"ann"']) {
      const r = await fake({ status: 200, raw }).client.me();
      expect(r.ok, raw).toBe(false);
      expect(r.error.kind, raw).toBe('server');
    }
  });
});

describe('what a person is told when it does not work', () => {
  it('not signed in is not an error to show: kind signed-out, for me and for anything else', async () => {
    const { client } = fake(err(401, { code: 'UNAUTHENTICATED', message: 'not signed in' }));
    expect((await client.me()).error.kind).toBe('signed-out');
    expect((await client.logout()).error.kind).toBe('signed-out');
  });

  it('a wrong sign-in shows the service\'s one message', async () => {
    const r = await fake(err(401, { code: 'UNAUTHENTICATED', message: 'wrong username or password' })).client.login({ username: 'a', password: 'b' });
    expect(r).toEqual({ ok: false, error: { kind: 'credentials', message: 'wrong username or password' } });
    expect((await fake({ status: 401 }).client.login({ username: 'a', password: 'b' })).error.message).toBe('Wrong username or password.');
  });

  it('422 shows the service\'s message and names the field when it is one the forms have', async () => {
    for (const field of ['username', 'displayName', 'email', 'password']) {
      const r = await fake(err(422, { code: 'INVALID_INPUT', message: `bad ${field}`, field })).client.register({});
      expect(r.error).toEqual({ kind: 'invalid', message: `bad ${field}`, field });
    }
    for (const field of ['role', 'body', '__proto__', 'currentPassword', 5, undefined]) {
      const r = await fake(err(422, { code: 'INVALID_INPUT', message: 'bad', field })).client.register({});
      expect(r.error.field, String(field)).toBeUndefined();
      expect(r.error.kind).toBe('invalid');
    }
    expect((await fake({ status: 422 }).client.register({})).error.message).toBe('Please check what you typed.');
  });

  it('409 on register is a taken username on the username field', async () => {
    const r = await fake(err(409, { code: 'CONFLICT', message: 'that username is taken', field: 'username' })).client.register({});
    expect(r.error).toEqual({ kind: 'taken', message: 'that username is taken', field: 'username' });
    expect((await fake({ status: 409 }).client.register({})).error.message).toBe('That username is taken.');
    expect((await fake({ status: 409 }).client.login({})).error.kind).toBe('server'); // a 409 anywhere else is not "taken"
  });

  it('403 on register is closed registration; 403 elsewhere is a plain refusal', async () => {
    const r = await fake(err(403, { code: 'FORBIDDEN', message: 'registration is closed' })).client.register({});
    expect(r.error).toEqual({ kind: 'closed', message: 'Registration is closed on this service.' });
    expect((await fake(err(403, { code: 'FORBIDDEN', message: 'x' })).client.login({})).error).toEqual({ kind: 'forbidden', message: 'The service refused that request.' });
    expect((await fake({ status: 403 }).client.logout()).error.kind).toBe('forbidden');
  });

  it('429 says how long to wait, from Retry-After, as a whole number of seconds', async () => {
    const wait = async (value) => (await fake(err(429, { code: 'THROTTLED', message: 'x' }, value === undefined ? undefined : { 'retry-after': value })).client.login({})).error;
    expect(await wait('30')).toEqual({ kind: 'throttled', message: 'Too many tries. Wait 30 seconds and try again.', retryAfterSeconds: 30 });
    expect((await wait('1')).message).toBe('Too many tries. Wait 1 second and try again.');
    expect((await wait('900000')).retryAfterSeconds).toBe(86_400);
    for (const bad of [undefined, '', 'soon', '-5', '1.5', '1e3', '0x10', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const e = await wait(bad);
      expect(e.kind, String(bad)).toBe('throttled');
      expect(e.retryAfterSeconds, String(bad)).toBeUndefined();
      expect(e.message, String(bad)).toBe('Too many tries. Wait a little and try again.');
    }
    expect((await wait('0')).retryAfterSeconds).toBe(1);
  });

  it('anything else (404, 500, 502, 503, odd codes) is one "something went wrong", with nothing from inside', async () => {
    for (const status of [400, 404, 405, 413, 415, 500, 502, 503, 504, 418, 301, 100]) {
      const r = await fake({ status, body: { error: { code: 'INTERNAL_ERROR', message: 'secret path /var/db/users.db' } } }).client.login({});
      expect(r.error, String(status)).toEqual({ kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
    }
  });

  it('a service that cannot be reached, or whose answer cannot be read, is kind network', async () => {
    const down = fake(new TypeError('Failed to fetch'));
    for (const r of [await down.client.me(), await down.client.login({}), await down.client.register({}), await down.client.logout()]) {
      expect(r.error).toEqual({ kind: 'network', message: 'Cannot reach the service. Check your connection and try again.' });
    }
    expect((await fake({ status: 200, textFails: true }).client.me()).error.kind).toBe('network');
  });

  it('never throws, whatever fetch gives back', async () => {
    for (const odd of [undefined, null, 5, 'x', {}, { status: 'ok' }]) {
      const client = createApiClient({ fetchFn: async () => odd });
      expect((await client.me()).error.kind, String(odd)).toBe('server'); // not a response at all
    }
    for (const odd of [undefined, null, 5, 'x', {}, { status: 'ok' }, { status: 200 }, { status: 200, text: 5 }, { status: 200, headers: 5, text: async () => '{}' }]) {
      const client = createApiClient({ fetchFn: async () => odd });
      for (const call of [() => client.me(), () => client.login({}), () => client.register({}), () => client.logout()]) {
        const r = await call();
        expect(typeof r.ok).toBe('boolean');
      }
    }
    // a Retry-After that cannot be read
    const throwing = createApiClient({ fetchFn: async () => ({ status: 429, headers: { get: () => { throw new Error('no'); } }, text: async () => '{}' }) });
    expect((await throwing.login({})).error.kind).toBe('throttled');
  });

  it('errors are frozen', async () => {
    const r = await fake({ status: 500 }).client.me();
    expect(Object.isFrozen(r.error)).toBe(true);
  });
});

describe('the words shown', () => {
  it('the service\'s message has control characters removed and is cut to a sensible length', () => {
    expect(cleanMessage('line one\nline two\tend\u0000x', 'fb')).toBe('line one line two end x');
    expect(cleanMessage(`${'a'.repeat(400)}`, 'fb')).toHaveLength(300);
    expect(cleanMessage(`${'a'.repeat(400)}`, 'fb').endsWith('…')).toBe(true);
    expect(cleanMessage('  spaced   out  ', 'fb')).toBe('spaced out');
    for (const bad of [undefined, null, 5, {}, '', '   ', '\n\t']) expect(cleanMessage(bad, 'fb')).toBe('fb');
  });

  it('removes every kind of control, separator and invisible mark', () => {
    const chr = String.fromCharCode;
    for (const code of [0, 7, 9, 10, 13, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029, 0xfeff]) expect(cleanMessage(`a${chr(code)}b`, 'fb'), String(code)).toBe('a b');
    expect(cleanMessage(`a${chr(0xa0)}b`, 'fb')).toBe(`a${chr(0xa0)}b`); // an ordinary no-break space is text
  });

  it('markup in a message stays markup: it is returned as the text it is, never changed into anything', () => {
    expect(cleanMessage('<img src=x onerror=alert(1)>', 'fb')).toBe('<img src=x onerror=alert(1)>');
  });

  it('a service message is used for 422 and 401-on-login only after cleaning', async () => {
    const r = await fake(err(422, { code: 'INVALID_INPUT', message: 'a\nb\u0007c', field: 'username' })).client.register({});
    expect(r.error.message).toBe('a b c');
  });

  it('parses Retry-After strictly', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(' 5 ')).toBe(5);
    expect(parseRetryAfter('000')).toBe(1);
    expect(parseRetryAfter('1000000')).toBeUndefined(); // seven digits
    expect(parseRetryAfter(5)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
