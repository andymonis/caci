import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { policyProblem, type Route } from './router.js';
import { createApiServer, type ApiServer } from './server.js';
import { createWebRoutes, WEB_POLICY, type WebFile } from './web-routes.js';

const FILES: readonly WebFile[] = [
  { path: '/', kind: 'html', text: '<!doctype html>\n<title>CaCi</title>\n<script src="/app.js"></script>\n' },
  { path: '/app.js', kind: 'js', text: "console.log('café 😀');\n" },
  { path: '/style.css', kind: 'css', text: 'body { margin: 0 }\n' },
  { path: '/notes.txt', kind: 'text', text: 'plain' },
];

let running: ApiServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}
function request(port: number, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function start(extra: readonly Route[] = [], files: readonly WebFile[] = FILES): Promise<number> {
  running = createApiServer({ routes: [...extra, ...createWebRoutes({ files })] });
  return running.listen(0);
}

describe('the policy', () => {
  it('is exactly the one the spec names, and passes the kit\'s own check', () => {
    expect(WEB_POLICY).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(policyProblem(WEB_POLICY)).toBeUndefined();
    expect(WEB_POLICY).not.toMatch(/unsafe|\*|https?:/);
  });
});

describe('serving the files', () => {
  it('serves each listed file at its path with exactly its bytes, its kind\'s type and the web policy', async () => {
    const port = await start();
    const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', text: 'text/plain; charset=utf-8' };
    for (const file of FILES) {
      const r = await request(port, file.path);
      expect(r.status, file.path).toBe(200);
      expect(r.text, file.path).toBe(file.text);
      expect(r.headers['content-type'], file.path).toBe(types[file.kind as keyof typeof types]);
      expect(r.headers['content-security-policy'], file.path).toBe(WEB_POLICY);
      expect(r.headers['cache-control'], file.path).toBe('no-store');
      expect(r.headers['x-content-type-options'], file.path).toBe('nosniff');
      expect(r.headers['referrer-policy'], file.path).toBe('no-referrer');
      expect(r.headers['content-length'], file.path).toBe(String(Buffer.byteLength(file.text)));
    }
  });

  it('serves the same page every time', async () => {
    const port = await start();
    const first = await request(port, '/');
    for (let i = 0; i < 3; i++) expect((await request(port, '/')).text).toBe(first.text);
  });

  it('only GET: HEAD, OPTIONS, POST, PUT and DELETE are 405 with Allow: GET', async () => {
    const port = await start();
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/', '/app.js']) {
        const withBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const r = await request(port, path, { method, ...(withBody ? { headers: { 'content-type': 'application/json', 'content-length': '2' }, body: '{}' } : {}) });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow, `${method} ${path}`).toBe('GET');
        expect(r.headers['content-security-policy']).toBe("default-src 'none'");
      }
    }
  });

  it('nothing else is served: unlisted names, other cases, folders, dot segments, encodings and tricks are plain JSON 404s', async () => {
    const port = await start();
    const paths = ['/secret.txt', '/app.js/', '/app.JS', '/APP.JS', '/style.css.map', '/web', '/web/app.js', '/..', '/../app.js', '/./app.js', '/%2e%2e/app.js', '/app.js%00', '/app.js%2f', '/app%2ejs', '//app.js', '/index.html', '/favicon.ico', '/api/me', '/.env', '/package.json', '/src/api/server.ts', '/app.js?x=1/../../x', `/${'a'.repeat(300)}`];
    for (const path of paths) {
      const r = await request(port, path);
      if (path.startsWith('/app.js?')) {
        expect(r.status, path).toBe(200); // a query string is not part of the path
        continue;
      }
      expect(r.status, path).toBe(404);
      expect(r.headers['content-type'], path).toBe('application/json; charset=utf-8');
      expect(r.headers['content-security-policy'], path).toBe("default-src 'none'");
      expect(r.text, path).not.toContain('CaCi');
    }
  });

  it('lives beside the API routes without touching them: API answers keep the lock-down and stay JSON', async () => {
    const api: Route = { method: 'GET', path: '/api/ping', handler: () => ({ status: 200, body: { pong: true } }) };
    const port = await start([api]);
    const r = await request(port, '/api/ping');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'");
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.text).toBe('{"pong":true}');
    expect((await request(port, '/')).headers['content-security-policy']).toBe(WEB_POLICY);
  });

  it('the Host rule applies to the page too: a look-alike host does not get it', async () => {
    const port = await start();
    const r = await request(port, '/', { headers: { host: 'evil.example' } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('CaCi');
  });
});

describe('the list is checked when the routes are made', () => {
  const page: WebFile = { path: '/', kind: 'html', text: 'x' };

  it('needs a page, and only the page is html', () => {
    expect(() => createWebRoutes({ files: [] })).toThrow(/no page/);
    expect(() => createWebRoutes({ files: [{ path: '/app.js', kind: 'js', text: 'x' }] })).toThrow(/no page/);
    expect(() => createWebRoutes({ files: [{ path: '/', kind: 'js', text: 'x' }] })).toThrow(TypeError);
    expect(() => createWebRoutes({ files: [page, { path: '/other.html', kind: 'html', text: 'x' }] })).toThrow(TypeError);
  });

  it('refuses odd paths', () => {
    for (const path of ['', 'app.js', '/a/b.js', '/.hidden', '/a..b', '/APP.JS', '/a b', '/a.', '/-a', '/_a', '/a/', '/a%2fb', '/é', `/${'a'.repeat(65)}`, '//', '/app.js?x', 5 as never]) {
      expect(() => createWebRoutes({ files: [page, { path, kind: 'js', text: 'x' }] }), String(path)).toThrow(TypeError);
    }
    for (const path of ['/a', '/app.js', '/style.v2.css', '/a_b-c.d', '/0.js', `/${'a'.repeat(64)}`]) {
      expect(() => createWebRoutes({ files: [page, { path, kind: 'js', text: 'x' }] }), path).not.toThrow();
    }
  });

  it('refuses a repeated path, a kind that is not a page, script, style sheet or text, and text that is not text or too large', () => {
    expect(() => createWebRoutes({ files: [page, page] })).toThrow(/twice/);
    for (const kind of ['json', 'xml', '', 'constructor', undefined]) expect(() => createWebRoutes({ files: [page, { path: '/a.js', kind: kind as never, text: 'x' }] }), String(kind)).toThrow(TypeError);
    for (const text of [5, null, undefined, Buffer.from('x')]) expect(() => createWebRoutes({ files: [page, { path: '/a.js', kind: 'js', text: text as never }] })).toThrow(TypeError);
    expect(() => createWebRoutes({ files: [page, { path: '/big.js', kind: 'js', text: 'x'.repeat(512 * 1024) }] })).not.toThrow();
    expect(() => createWebRoutes({ files: [page, { path: '/big.js', kind: 'js', text: 'x'.repeat(512 * 1024 + 1) }] })).toThrow(TypeError);
  });

  it('makes one GET route per file and nothing more', () => {
    const routes = createWebRoutes({ files: FILES });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /', 'GET /app.js', 'GET /style.css', 'GET /notes.txt']);
  });
});
