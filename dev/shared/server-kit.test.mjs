import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertLocalDevelopment, createLoopbackServer, DEFAULT_MAX_BODY_BYTES, HttpError, LOOPBACK, readJson, send } from './server-kit.mjs';

let dir;
let tool;
let port;

/** A tiny tool: two static files, and an API that echoes, fails and throws on request. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'server-kit-'));
  writeFileSync(join(dir, 'page.html'), '<h1>hi</h1>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'not for serving');
  tool = createLoopbackServer({
    publicDir: dir,
    files: { '/': ['page.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] },
    maxBodyBytes: 100,
    api: async (req, res, url, kit) => {
      if (url.pathname === '/api/echo') return kit.send(res, 200, { method: req.method, body: req.method === 'GET' ? null : await kit.readJson(req) });
      if (url.pathname === '/api/teapot') throw new kit.HttpError(418, 'short and stout');
      if (url.pathname === '/api/boom') throw new Error('kaboom');
      throw new kit.HttpError(404, 'no such API route');
    },
  });
  port = await tool.listen(0);
});
afterEach(async () => {
  await tool.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A raw request, so headers like Host and Origin can be set freely. */
const raw = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: LOOPBACK, port, path, method, headers: { host: `${LOOPBACK}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
const post = (path, body, headers = { 'content-type': 'application/json' }) => raw(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('where it listens', () => {
  it('binds the loopback address and nothing wider', () => {
    expect(tool.server.address().address).toBe('127.0.0.1');
    expect(LOOPBACK).toBe('127.0.0.1');
  });

  it('answers 127.0.0.1 and localhost on its own port, and no other Host (DNS rebinding)', async () => {
    expect((await raw('/')).status).toBe(200);
    expect((await raw('/', { headers: { host: `localhost:${port}` } })).status).toBe(200);
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `192.168.1.5:${port}`, `localhost.evil.example:${port}`, `127.0.0.1:${port}.evil.example`, `127.0.0.1:${port}9`, `localhost:${port}.evil.example`]) {
      expect((await raw('/', { headers: { host } })).status, host).toBe(403);
    }
  });

  it('refuses a request with no Host header at all', async () => {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(port, LOOPBACK, () => socket.write('GET / HTTP/1.0\r\n\r\n'));
      let text = '';
      socket.on('data', (c) => (text += c));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it('checks the host for the API as well as for files', async () => {
    expect((await raw('/api/echo', { headers: { host: 'evil.example' } })).status).toBe(403);
  });
});

describe('static files', () => {
  it('serves the listed files with their type, uncached and not sniffed', async () => {
    const r = await raw('/');
    expect(r).toMatchObject({ status: 200, text: '<h1>hi</h1>' });
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw('/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('serves nothing else, however the path is written', async () => {
    for (const path of ['/secret.txt', '/page.html', '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '//etc/passwd', '/app.js/', '/constructor', '/__proto__', '/toString', '/APP.JS', '/app.js%00', '/app.js%2f']) {
      const r = await raw(path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain('not for serving');
    }
  });

  it('ignores a query string on a listed file', async () => {
    expect((await raw('/app.js?x=1')).status).toBe(200);
  });

  it('serves files only to GET', async () => {
    expect((await raw('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await raw('/app.js', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('writes (against CSRF from another page)', () => {
  it('accepts a same-origin JSON post, and one with no Origin header', async () => {
    expect((await post('/api/echo', { a: 1 })).status).toBe(200);
    expect((await post('/api/echo', { a: 1 }, { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await post('/api/echo', { a: 1 }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  });

  it('refuses a cross-origin post, delete or put', async () => {
    const origin = 'https://evil.example';
    expect((await post('/api/echo', {}, { 'content-type': 'application/json', origin })).status).toBe(403);
    expect((await raw('/api/echo', { method: 'DELETE', headers: { origin } })).status).toBe(403);
    expect((await raw('/api/echo', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('refuses an origin that only looks similar', async () => {
    for (const origin of [`http://localhost:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.evil.example`, 'null']) {
      expect((await post('/api/echo', {}, { 'content-type': 'application/json', origin })).status, origin).toBe(403);
    }
  });

  it('refuses a post that is not JSON (a plain HTML form cannot send it)', async () => {
    for (const type of ['text/plain', 'text/json', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain; note=application/json', 'xapplication/json']) {
      expect((await post('/api/echo', 'a=1', { 'content-type': type })).status, type).toBe(415);
    }
    expect((await post('/api/echo', '{}', {})).status).toBe(415);
  });

  it('does not require JSON or an origin for GET', async () => {
    expect((await raw('/api/echo', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });
});

describe('request bodies', () => {
  it('reads JSON, and an empty body as an empty object', async () => {
    expect(JSON.parse((await post('/api/echo', { a: [1, { b: 2 }] })).text).body).toEqual({ a: [1, { b: 2 }] });
    expect(JSON.parse((await post('/api/echo', '')).text).body).toEqual({});
  });

  it('refuses a body over the limit with 413, and accepts one exactly at it', async () => {
    const exact = JSON.stringify({ k: 'x'.repeat(100 - '{"k":""}'.length) });
    expect(Buffer.byteLength(exact)).toBe(100);
    expect((await post('/api/echo', exact)).status).toBe(200);
    expect((await post('/api/echo', exact.replace('x', 'xx'))).status).toBe(413);
    expect((await post('/api/echo', JSON.stringify({ k: 'x'.repeat(5000) }))).status).toBe(413);
  });

  it('refuses JSON that does not parse with 400', async () => {
    for (const body of ['{', 'nope', '{"a":}', '[1,']) expect((await post('/api/echo', body)).status, body).toBe(400);
  });

  it('measures the limit in bytes, not characters', async () => {
    expect((await post('/api/echo', JSON.stringify({ k: '😀'.repeat(30) }))).status).toBe(413); // 120 bytes
    expect((await post('/api/echo', JSON.stringify({ k: '😀'.repeat(20) }))).status).toBe(200); // 80 bytes + overhead
  });

  it('has a default limit of one megabyte', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_000_000);
  });
});

describe('errors', () => {
  it('an HttpError reaches the browser with its status and message', async () => {
    const r = await raw('/api/teapot');
    expect(r.status).toBe(418);
    expect(JSON.parse(r.text)).toEqual({ error: 'short and stout' });
  });

  it('any other error is a 500 that says so', async () => {
    const r = await raw('/api/boom');
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({ error: 'internal error', detail: 'kaboom' });
  });

  it('only paths under /api/ reach the tool, whatever the method', async () => {
    for (const path of ['/api', '/apix', '/apiary/echo', '/API/echo', '/x/api/echo']) {
      for (const method of ['GET', 'POST']) {
        const r = await raw(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(JSON.parse(r.text), `${method} ${path}`).toEqual({ error: 'not found' });
      }
    }
  });

  it('an unknown path is 404, with the tool deciding for /api/', async () => {
    expect((await raw('/nothing')).status).toBe(404);
    expect(JSON.parse((await raw('/api/missing')).text)).toEqual({ error: 'no such API route' });
  });

  it('keeps serving after an error', async () => {
    await raw('/api/boom');
    expect((await raw('/')).status).toBe(200);
  });
});

describe('listen and close', () => {
  it('refuses to listen twice on the same port', async () => {
    const other = createLoopbackServer({ publicDir: dir, files: {}, api: async () => undefined });
    await expect(other.listen(port)).rejects.toThrow(/EADDRINUSE/);
  });

  it('closes cleanly', async () => {
    const other = createLoopbackServer({ publicDir: dir, files: {}, api: async () => undefined });
    await other.listen(0);
    await other.close();
    await expect(fetch(`http://127.0.0.1:${other.server.address()?.port ?? 1}/`)).rejects.toThrow();
  });
});

describe('assertLocalDevelopment', () => {
  it('refuses NODE_ENV=production and names the tool', () => {
    expect(() => assertLocalDevelopment('The LLM lab', { NODE_ENV: 'production' })).toThrow('The LLM lab is a local development tool and must not run with NODE_ENV=production.');
  });
  it('allows anything else', () => {
    expect(() => assertLocalDevelopment('x', { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertLocalDevelopment('x', { NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertLocalDevelopment('x', {})).not.toThrow();
  });
  it('reads the real environment by default', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => assertLocalDevelopment('x')).toThrow(/local development/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('helpers', () => {
  it('HttpError carries a status', () => {
    const e = new HttpError(409, 'nope');
    expect(e).toMatchObject({ status: 409, message: 'nope' });
    expect(e).toBeInstanceOf(Error);
  });
  it('send and readJson are exported for tools that need them directly', () => {
    expect(typeof send).toBe('function');
    expect(typeof readJson).toBe('function');
  });
});
