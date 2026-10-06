import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { serialiseCookie } from './cookies.js';
import type { Route } from './router.js';
import { createApiServer, type ApiServer, type ApiServerOptions } from './server.js';

let running: ApiServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const echo: Route = { method: 'POST', path: '/api/echo', handler: (c) => ({ status: 200, body: { body: c.body ?? null, query: { ...c.query }, cookies: { ...c.cookies }, client: c.clientKey } }) };
const baseRoutes: readonly Route[] = [
  echo,
  { method: 'GET', path: '/api/ping', handler: () => ({ status: 200, body: { pong: true } }) },
  { method: 'GET', path: '/api/things/:id', handler: (c) => ({ status: 200, body: { id: c.params.id ?? null } }) },
  { method: 'DELETE', path: '/api/things/:id', handler: (c) => ({ status: 200, body: { deleted: c.params.id ?? null, body: c.body ?? null } }) },
  { method: 'GET', path: '/api/empty', handler: () => ({ status: 204 }) },
  { method: 'GET', path: '/api/cookie', handler: () => ({ status: 200, body: {}, cookies: [serialiseCookie('session', 'abc', { secure: false }), serialiseCookie('other', 'x', { secure: false })] }) },
  { method: 'GET', path: '/api/slow-down', handler: () => ({ status: 429, body: { wait: true }, retryAfterSeconds: 2.2 }) },
  { method: 'GET', path: '/api/boom', handler: () => { throw new Error('secret internal detail: /var/db/users.db'); } },
  { method: 'GET', path: '/api/async-boom', handler: async () => { throw new Error('secret async detail'); } },
];

async function start(options: Partial<ApiServerOptions> = {}): Promise<{ base: string; port: number; api: ApiServer }> {
  const api = createApiServer({ routes: baseRoutes, ...options });
  running = api;
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, port, api };
}

interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}
/** A raw request, so any header (Host, Origin, odd ones) and any body can be sent exactly as written. */
function raw(port: number, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const framed = body === undefined ? headers : { 'content-length': String(Buffer.byteLength(body)), ...headers }; // say how long the body is, as a browser does even for DELETE
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: framed }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const json = (r: Raw): unknown => JSON.parse(r.text);
const POST = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;
const WITH_JSON = { headers: { 'content-type': 'application/json' } } as const;

describe('a good request', () => {
  it('routes, parses and answers JSON, with the security headers', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/echo?a=1&b=two', { ...POST, body: '{"x":[1,2],"y":{"z":true}}' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json(r)).toMatchObject({ body: { x: [1, 2], y: { z: true } }, query: { a: '1', b: 'two' } });
  });

  it('puts the security headers on every kind of reply: success, no content, each error', async () => {
    const { port } = await start();
    const replies = [
      await raw(port, '/api/ping'),
      await raw(port, '/api/empty'),
      await raw(port, '/api/nothing'),
      await raw(port, '/api/ping', { ...POST, body: '{}' }),
      await raw(port, '/api/echo', { method: 'POST', body: '{}' }),
      await raw(port, '/api/echo', { ...POST, body: '{' }),
      await raw(port, '/api/boom'),
      await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, origin: 'http://evil.example' }, body: '{}' }),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 204, 404, 405, 415, 400, 500, 403]);
    for (const r of replies) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toBe("default-src 'none'");
      expect(r.headers['access-control-allow-origin']).toBeUndefined(); // no CORS
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('204 has no body and no content type', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/empty');
    expect(r.text).toBe('');
    expect(r.headers['content-type']).toBeUndefined();
  });

  it('gives a handler the path parameters, and the body of a DELETE (the password for deleting your account)', async () => {
    const { port } = await start();
    expect(json(await raw(port, '/api/things/u123'))).toEqual({ id: 'u123' });
    const deleted = await raw(port, '/api/things/u123', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"password":"x"}' });
    expect(json(deleted)).toEqual({ deleted: 'u123', body: { password: 'x' } });
    expect(json(await raw(port, '/api/things/u123', { method: 'DELETE' }))).toEqual({ deleted: 'u123', body: null });
  });

  it('no body at all is fine for a POST (logout has none)', async () => {
    const { port } = await start();
    expect(json(await raw(port, '/api/echo', { method: 'POST' }))).toMatchObject({ body: null });
  });

  it('sets cookies exactly as the handler gave them, one header each', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/cookie');
    expect(r.headers['set-cookie']).toEqual(['session=abc; Path=/; HttpOnly; SameSite=Strict', 'other=x; Path=/; HttpOnly; SameSite=Strict']);
  });

  it('reads cookies sent by the browser', async () => {
    const { port } = await start();
    expect(json(await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, cookie: 'session=tok; theme=dark' }, body: '{}' }))).toMatchObject({ cookies: { session: 'tok', theme: 'dark' } });
  });

  it('turns retryAfterSeconds into a whole Retry-After of at least one second', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/slow-down');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('3');
  });
});

describe('errors are uniform and tell nothing about the inside', () => {
  it('a handler that throws is a 500 with a fixed message: no stack, no path, no detail', async () => {
    const { port } = await start();
    for (const path of ['/api/boom', '/api/async-boom']) {
      const r = await raw(port, path);
      expect(r.status).toBe(500);
      expect(json(r)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
      expect(r.text).not.toMatch(/secret|\/var\/|at |Error/);
    }
  });

  it('every failure has the shape { error: { code, message } }', async () => {
    const { port } = await start();
    for (const r of [await raw(port, '/api/zzz'), await raw(port, '/api/ping', { ...POST, body: '{}' }), await raw(port, '/api/echo', { method: 'POST', body: 'x' })]) {
      const body = json(r) as { error: { code: string; message: string } };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
      expect(body.error.code).toMatch(/^[A-Z_]+$/);
    }
  });

  it('unknown routes are 404, wrong methods are 405 with Allow, and OPTIONS and HEAD are not special', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/nope')).status).toBe(404);
    const wrong = await raw(port, '/api/things/u1', { ...WITH_JSON, method: 'PUT', body: '{}' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET, DELETE');
    for (const method of ['OPTIONS', 'HEAD']) {
      const r = await raw(port, '/api/ping', { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET');
      expect(r.headers['access-control-allow-methods']).toBeUndefined();
    }
    expect((await raw(port, '/api/nope', { method: 'OPTIONS' })).status).toBe(404);
  });
});

describe('writes must be from this site, and JSON', () => {
  it('refuses a cross-origin write with 403, including the null origin, and does not run the handler', async () => {
    let ran = 0;
    const { port } = await start({ routes: [{ method: 'POST', path: '/api/act', handler: () => (++ran, { status: 200 }) }] });
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1.evil.example:${port}`, `https://127.0.0.1:${port}x`, 'not a url', 'http://localhost:1', `http://[::1]:${port}`, `ftp://127.0.0.1:${port}`, `chrome-extension://127.0.0.1:${port}`]) {
      const r = await raw(port, '/api/act', { ...POST, headers: { ...POST.headers, origin }, body: '{}' });
      expect(r.status, origin).toBe(403);
    }
    expect(ran).toBe(0);
  });

  it('accepts a write whose Origin is this server, or that has no Origin (not a browser cross-site request)', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, origin: `http://127.0.0.1:${port}` }, body: '{}' })).status).toBe(200);
    expect((await raw(port, '/api/echo', { ...POST, body: '{}' })).status).toBe(200);
  });

  it('does not check Origin on a read (GET changes nothing)', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/ping', { headers: { origin: 'http://evil.example' } })).status).toBe(200);
  });

  it('a body that is not JSON-typed is 415, whatever it holds', async () => {
    const { port } = await start();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/xml']) {
      expect((await raw(port, '/api/echo', { method: 'POST', headers: { 'content-type': type }, body: 'a=b' })).status, type).toBe(415);
    }
    expect((await raw(port, '/api/echo', { method: 'POST', body: '{"a":1}' })).status).toBe(415); // no type at all
  });

  it('the Origin check comes before the body is read: a refused write is not parsed', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, origin: 'http://evil.example' }, body: '{not json' });
    expect(r.status).toBe(403);
  });
});

describe('hostile input', () => {
  it('invalid JSON, non-objects, prototype keys and deep nesting are 400, and nothing pollutes Object.prototype', async () => {
    const { port } = await start();
    for (const body of ['{', '[]', '"x"', 'null', '{"__proto__":{"admin":true}}', '{"a":{"constructor":1}}', '{"a":'.repeat(30) + '1' + '}'.repeat(30), '\u0000']) {
      expect((await raw(port, '/api/echo', { ...POST, body })).status, body.slice(0, 30)).toBe(400);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('a body over 16 KB is 413: by its declared length, and when the length is not declared', async () => {
    const { port } = await start();
    const big = JSON.stringify({ a: 'x'.repeat(17_000) });
    expect((await raw(port, '/api/echo', { ...POST, body: big })).status).toBe(413);
    // chunked: no content-length, the server counts what arrives
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/echo', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      for (let i = 0; i < 20; i++) req.write(Buffer.alloc(1000, 0x20));
      req.end();
    });
    expect(status).toBe(413);
    expect((await raw(port, '/api/echo', { ...POST, body: JSON.stringify({ a: 'x'.repeat(16_000) }) })).status).toBe(200); // just under is fine
  });

  it('a body limit can be set', async () => {
    const { port } = await start({ maxBodyBytes: 50 });
    expect((await raw(port, '/api/echo', { ...POST, body: JSON.stringify({ a: 'x'.repeat(60) }) })).status).toBe(413);
    expect((await raw(port, '/api/echo', { ...POST, body: '{"a":1}' })).status).toBe(200);
  });

  it('a declared body length over the limit is refused at once, without waiting for the body to arrive', async () => {
    const { port } = await start();
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{`));
      let data = '';
      socket.on('data', (c) => {
        data += c.toString();
        socket.destroy();
        resolve(data);
      });
      setTimeout(() => resolve('no reply within a second'), 1000);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 413/);
  });

  it('the header size limit can be set', async () => {
    const { port } = await start({ maxHeaderBytes: 2000 });
    const r = await raw(port, '/api/ping', { headers: { 'x-big': 'a'.repeat(3000) } }).catch(() => ({ status: 431 }));
    expect(r.status).toBe(431);
    expect((await raw(port, '/api/ping', { headers: { 'x-ok': 'a'.repeat(500) } })).status).toBe(200);
  });

  it('huge headers are refused (431) and the server carries on', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/ping', { headers: { 'x-big': 'a'.repeat(30_000) } }).catch(() => ({ status: 431 }));
    expect(r.status).toBe(431);
    expect((await raw(port, '/api/ping')).status).toBe(200);
  });

  it('path tricks are 404 and never reach a handler', async () => {
    let reached = 0;
    const { port } = await start({ routes: [{ method: 'GET', path: '/api/things/:id', handler: () => (++reached, { status: 200 }) }] });
    for (const path of ['/api/things/..', '/api/things/%2e%2e', '/api/things/a%2Fb', '/api/things//x', '/api/things/x/', '/api/things/a%00b', '/api/../api/things/x', '/api/things/' + 'a'.repeat(200)]) {
      expect((await raw(port, path)).status, path).toBe(404);
    }
    expect(reached).toBe(0);
  });

  it('bad cookies are skipped, and a hostile cookie name is just a name', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, cookie: '__proto__=1; =x; a b=2; good=ok; constructor=3' }, body: '{}' });
    expect((json(r) as { cookies: object }).cookies).toEqual({ good: 'ok', constructor: '3', ['__proto__']: '1' });
    expect(({} as Record<string, unknown>)['1']).toBeUndefined();
  });

  it('a long or odd query string is refused with 400, a normal one passes, repeated names keep the first', async () => {
    const { port } = await start();
    expect(json(await raw(port, '/api/echo?a=1&a=2&__proto__=x', { ...POST, body: '{}' }))).toMatchObject({ query: { a: '1', ['__proto__']: 'x' } });
    expect((await raw(port, '/api/echo?' + Array.from({ length: 30 }, (_, i) => `p${i}=1`).join('&'), { ...POST, body: '{}' })).status).toBe(400);
    expect((await raw(port, '/api/echo?v=' + 'x'.repeat(600), { ...POST, body: '{}' })).status).toBe(400);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('a garbage request line is turned away by the HTTP parser and the server survives', async () => {
    const { port } = await start();
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GARBAGE\r\n\r\n'));
      let data = '';
      socket.on('data', (c) => (data += c.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect((await raw(port, '/api/ping')).status).toBe(200);
  });

  it('a client that sends headers and then nothing is cut off by the request time limit', async () => {
    const { port } = await start({ requestTimeoutMs: 300, headersTimeoutMs: 300 });
    const closedAfter = await new Promise<number>((resolve) => {
      const started = Date.now();
      const socket = connect(port, '127.0.0.1', () => socket.write(`POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`));
      socket.on('close', () => resolve(Date.now() - started));
      socket.on('error', () => undefined);
      socket.resume(); // read the server's 408, or the close is never seen
    });
    expect(closedAfter).toBeLessThan(3000);
    expect((await raw(port, '/api/ping')).status).toBe(200);
  }, 10_000);
});

describe('who is asking', () => {
  it('a forwarded address that is not an address is not trusted even when proxies are', async () => {
    const { port } = await start({ trustedProxies: 1 });
    for (const forwarded of ['203.0.113.9; DROP', 'a', '<b>', 'x'.repeat(100), '1.2.3.4.5.6.7.8.9.10.11.12.13.14.15.16.17.18.19.20.21.22.23.24.25.26.27.28']) {
      const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, 'x-forwarded-for': forwarded }, body: '{}' });
      expect((json(r) as { client: string }).client, forwarded).toBe('127.0.0.1');
    }
  });

  it('uses the socket address, and ignores X-Forwarded-For unless a proxy is trusted', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, 'x-forwarded-for': '6.6.6.6' }, body: '{}' });
    expect((json(r) as { client: string }).client).toBe('127.0.0.1');
  });

  it('with one trusted proxy uses the last entry, the one the proxy wrote, not what the client claimed first', async () => {
    const { port } = await start({ trustedProxies: 1 });
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, body: '{}' });
    expect((json(r) as { client: string }).client).toBe('203.0.113.9');
  });

  it('with two trusted proxies the second from the end', async () => {
    const { port } = await start({ trustedProxies: 2 });
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }, body: '{}' });
    expect((json(r) as { client: string }).client).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is missing, too short or not an address', async () => {
    const { port } = await start({ trustedProxies: 2 });
    for (const forwarded of [undefined, '203.0.113.9', 'not-an-address, also not', '<script>, x']) {
      const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }) }, body: '{}' });
      expect((json(r) as { client: string }).client, String(forwarded)).toBe('127.0.0.1');
    }
  });

  it('shows an IPv6 address mapped from IPv4 as the plain IPv4 address', async () => {
    const { port } = await start({ trustedProxies: 1 });
    const r = await raw(port, '/api/echo', { ...POST, headers: { ...POST.headers, 'x-forwarded-for': '::ffff:203.0.113.9' }, body: '{}' });
    expect((json(r) as { client: string }).client).toBe('203.0.113.9');
  });
});

describe('where it listens and who it answers', () => {
  it('listens on 127.0.0.1 unless told otherwise', async () => {
    const { api } = await start();
    expect((api.server.address() as { address: string }).address).toBe('127.0.0.1');
  });

  it('answers only to its own loopback names by default (against DNS rebinding)', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/ping', { headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await raw(port, '/api/ping', { headers: { host: `localhost:${port}` } })).status).toBe(200);
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1:1', '192.168.1.5:' + port]) {
      expect((await raw(port, '/api/ping', { headers: { host } })).status, host).toBe(403);
    }
  });

  it('a request with no Host header at all is refused too', async () => {
    const { port } = await start();
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GET /api/ping HTTP/1.0\r\n\r\n'));
      let data = '';
      socket.on('data', (c) => (data += c.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.[01] 403/);
  });

  it('with allowedHosts, answers to exactly those names', async () => {
    const { port } = await start({ allowedHosts: ['notes.home.example'] });
    expect((await raw(port, '/api/ping', { headers: { host: 'notes.home.example' } })).status).toBe(200);
    expect((await raw(port, '/api/ping', { headers: { host: `127.0.0.1:${port}` } })).status).toBe(403);
    expect((await raw(port, '/api/ping', { headers: { host: 'other.example' } })).status).toBe(403);
  });

  it('behind a trusted proxy the Host check is off unless allowedHosts says otherwise (the public name is not known here)', async () => {
    const { port } = await start({ trustedProxies: 1 });
    expect((await raw(port, '/api/ping', { headers: { host: 'notes.home.example' } })).status).toBe(200);
  });

  it('a write is accepted when its Origin matches the public Host name behind a proxy', async () => {
    const { port } = await start({ trustedProxies: 1, allowedHosts: ['notes.home.example'] });
    const headers = { ...POST.headers, host: 'notes.home.example', origin: 'https://notes.home.example' };
    expect((await raw(port, '/api/echo', { ...POST, headers, body: '{}' })).status).toBe(200);
    expect((await raw(port, '/api/echo', { ...POST, headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
  });
});

describe('logging', () => {
  it('reports method, path, status and time, and never the query, a body or a cookie', async () => {
    const events: Array<{ method: string; path: string; status: number; ms: number }> = [];
    const { port } = await start({ log: (e) => events.push(e) });
    await raw(port, '/api/echo?token=SECRET-IN-QUERY', { ...POST, headers: { ...POST.headers, cookie: 'session=SECRET-COOKIE' }, body: '{"password":"SECRET-BODY"}' });
    await raw(port, '/api/nope');
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => [e.method, e.path, e.status])).toEqual([['POST', '/api/echo', 200], ['GET', '/api/nope', 404]]);
    expect(JSON.stringify(events)).not.toMatch(/SECRET/);
    for (const e of events) expect(e.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('making a server', () => {
  it('refuses nonsense settings with a TypeError', () => {
    for (const bad of [{ maxBodyBytes: 0 }, { maxBodyBytes: 1.5 }, { maxHeaderBytes: -1 }, { headersTimeoutMs: 0 }, { requestTimeoutMs: Number.NaN }, { trustedProxies: -1 }, { trustedProxies: 6 }, { trustedProxies: 1.5 }, { host: '' }]) {
      expect(() => createApiServer({ routes: baseRoutes, ...bad }), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('refuses a bad route table', () => {
    expect(() => createApiServer({ routes: [{ method: 'GET', path: 'no-slash', handler: () => ({ status: 200 }) }] })).toThrow(TypeError);
  });

  it('does not listen until asked, and close is safe to call twice', async () => {
    const api = createApiServer({ routes: baseRoutes });
    expect(api.server.listening).toBe(false);
    await api.close();
    const port = await api.listen(0);
    expect(port).toBeGreaterThan(0);
    await api.close();
    running = undefined;
  });
});
