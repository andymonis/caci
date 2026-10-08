import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { serialiseCookie } from './cookies.js';
import { DOCUMENT_TYPES, documentResponse, policyProblem, type ApiResponse, type Route } from './router.js';
import { createApiServer, type ApiServer } from './server.js';

// Non-JSON answers (R-005): a page, a script, a style sheet. A route names a kind from a fixed list,
// never a header value, and the kit still adds the security headers to every one.

const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
function get(port: number, path: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const route = (path: string, response: ApiResponse | (() => ApiResponse)): Route => ({ method: 'GET', path, handler: () => (typeof response === 'function' ? response() : response) });
async function start(routes: readonly Route[]): Promise<number> {
  running = createApiServer({ routes });
  return running.listen(0);
}

describe('documentResponse', () => {
  it('has one fixed content type for each kind, and no others', () => {
    expect(DOCUMENT_TYPES).toEqual({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', text: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8' });
    expect(Object.isFrozen(DOCUMENT_TYPES)).toBe(true);
  });

  it('builds a frozen reply with the text, the kind, the status and the policy', () => {
    const r = documentResponse({ kind: 'html', text: '<p>hi</p>', policy: PAGE_POLICY });
    expect(r).toEqual({ status: 200, document: { kind: 'html', text: '<p>hi</p>', policy: PAGE_POLICY } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.document)).toBe(true);
    expect(documentResponse({ kind: 'text', text: '' }, 404).status).toBe(404);
  });

  it('refuses at once (TypeError) a kind that does not exist, text that is not text, and a status that cannot carry a body', () => {
    for (const kind of ['', 'xml', 'application/javascript', '__proto__', 'constructor', 'toString', 5, undefined, null]) expect(() => documentResponse({ kind: kind as never, text: 'x' }), String(kind)).toThrow(TypeError);
    for (const text of [5, null, undefined, {}, Buffer.from('x')]) expect(() => documentResponse({ kind: 'html', text: text as never })).toThrow(TypeError);
    for (const status of [204, 304, 199, 600, 200.5, Number.NaN]) expect(() => documentResponse({ kind: 'html', text: 'x' }, status), String(status)).toThrow(TypeError);
  });

  it('refuses a policy that could split a reply, is not plain text, or is not the start of a lock-down', () => {
    for (const policy of ["default-src 'none'\r\nSet-Cookie: x=1", "default-src 'none'\nX-Evil: 1", "default-src 'none'\0", "default-src 'none'; img-src é", "default-src 'none'; \tscript-src 'self'", "default-src 'none';\nscript-src 'self'", "default-src 'none'; img-src 'self'\r", "default-src 'none'; \x01", "default-src 'none'; x\x7f", "default-src 'none'; \x00", '', 'x'.repeat(2049), "default-src 'self'", "script-src 'self'", "  default-src 'none'", "DEFAULT-SRC 'none'", "default-src 'none'x"]) {
      expect(() => documentResponse({ kind: 'html', text: 'x', policy }), JSON.stringify(policy).slice(0, 50)).toThrow(TypeError);
    }
  });

  it('refuses a policy that allows inline or evaluated code, a wildcard origin, or a whole scheme', () => {
    for (const extra of ["script-src 'unsafe-inline'", "script-src 'self' 'unsafe-eval'", "style-src 'unsafe-hashes'", "script-src 'wasm-unsafe-eval'", 'script-src *', 'img-src *', 'connect-src https:', 'connect-src http:', 'script-src *.example.com', "script-src 'UNSAFE-INLINE'"]) {
      expect(policyProblem(`default-src 'none'; ${extra}`), extra).toBeDefined();
    }
  });

  it('accepts the web app\'s own policy, the bare lock-down, and a tighter one', () => {
    expect(policyProblem(PAGE_POLICY)).toBeUndefined();
    expect(policyProblem("default-src 'none'")).toBeUndefined();
    expect(policyProblem("default-src 'none'; script-src 'self'")).toBeUndefined();
    expect(policyProblem("default-src 'none'; ".padEnd(2048, 'x'))).toBeUndefined();
    expect(policyProblem("default-src 'none'; ".padEnd(2049, 'x'))).toBeDefined();
    for (const bad of [5, null, undefined, {}]) expect(policyProblem(bad)).toBeDefined();
  });
});

describe('sending a document', () => {
  it('sends the text with its fixed content type, the route\'s policy and the kit\'s security headers', async () => {
    const port = await start([route('/page', documentResponse({ kind: 'html', text: '<!doctype html><title>x</title>', policy: PAGE_POLICY }))]);
    const r = await get(port, '/page');
    expect(r.status).toBe(200);
    expect(r.text).toBe('<!doctype html><title>x</title>');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe(PAGE_POLICY);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(r.text)));
  });

  it('sends every kind with its own type', async () => {
    const routes = (['html', 'js', 'css', 'text', 'json'] as const).map((kind) => route(`/k-${kind}`, documentResponse({ kind, text: kind === 'json' ? '{}' : 'x' })));
    const port = await start(routes);
    for (const kind of ['html', 'js', 'css', 'text', 'json'] as const) expect((await get(port, `/k-${kind}`)).headers['content-type'], kind).toBe(DOCUMENT_TYPES[kind]);
  });

  it('without a policy the API\'s own lock-down stands', async () => {
    const port = await start([route('/p', documentResponse({ kind: 'js', text: 'x' }))]);
    expect((await get(port, '/p')).headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('sends text that is not ASCII as UTF-8 with the right length', async () => {
    const port = await start([route('/u', documentResponse({ kind: 'html', text: 'café 😀 <b>' }))]);
    const r = await get(port, '/u');
    expect(r.text).toBe('café 😀 <b>');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength('café 😀 <b>')));
  });

  it('keeps the status, and can carry a cookie', async () => {
    const port = await start([route('/gone', documentResponse({ kind: 'text', text: 'gone' }, 410)), route('/c', { ...documentResponse({ kind: 'text', text: 'ok' }), cookies: [serialiseCookie('a', 'b', { secure: false })] })]);
    expect((await get(port, '/gone')).status).toBe(410);
    expect((await get(port, '/c')).headers['set-cookie']).toEqual([expect.stringContaining('a=b')]);
  });

  it('API answers still say "load nothing" and are still JSON', async () => {
    const port = await start([route('/api', { status: 200, body: { ok: true } }), route('/page', documentResponse({ kind: 'html', text: 'x', policy: PAGE_POLICY }))]);
    const r = await get(port, '/api');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'");
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.text).toBe('{"ok":true}');
  });

  it('errors keep the lock-down and stay JSON, also for a path that is only a document route elsewhere', async () => {
    const port = await start([route('/page', documentResponse({ kind: 'html', text: 'x', policy: PAGE_POLICY }))]);
    for (const [path, status] of [['/nothing', 404], ['/page/', 404], ['/page/../x', 404]] as const) {
      const r = await get(port, path);
      expect(r.status, path).toBe(status);
      expect(r.headers['content-security-policy']).toBe("default-src 'none'");
      expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    }
    const post = await new Promise<Reply>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/page', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.end('{}');
    });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET');
    expect(post.headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('HEAD and OPTIONS on a page are 405 with Allow, as for every route', async () => {
    const port = await start([route('/page', documentResponse({ kind: 'html', text: 'x', policy: PAGE_POLICY }))]);
    for (const method of ['HEAD', 'OPTIONS']) {
      const r = await get(port, '/page', { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET');
    }
  });

  it('the Host and Origin rules apply to pages as to everything else', async () => {
    const port = await start([route('/page', documentResponse({ kind: 'html', text: 'secret page', policy: PAGE_POLICY }))]);
    const rebinding = await get(port, '/page', { headers: { host: 'evil.example' } });
    expect(rebinding.status).toBe(403);
    expect(rebinding.text).not.toContain('secret page');
    expect((await get(port, '/page', { headers: { host: `localhost:${port}` } })).status).toBe(200);
  });
});

describe('a mistake is never sent', () => {
  const cases: Array<[string, ApiResponse]> = [
    ['a body and a document together', { status: 200, body: { a: 1 }, document: { kind: 'html', text: 'x' } }],
    ['a kind that does not exist', { status: 200, document: { kind: 'evil' as never, text: 'x' } }],
    ['text that is not a string', { status: 200, document: { kind: 'html', text: 5 as never } }],
    ['a policy that splits the reply', { status: 200, document: { kind: 'html', text: 'x', policy: "default-src 'none'\r\nSet-Cookie: x=1" } }],
    ['a policy that allows inline code', { status: 200, document: { kind: 'html', text: 'x', policy: "default-src 'none'; script-src 'unsafe-inline'" } }],
    ['a document with status 204', { status: 204, document: { kind: 'html', text: 'x' } }],
  ];
  it.each(cases)('%s becomes a plain 500 "internal error" and nothing of it leaks', async (_name, response) => {
    const port = await start([route('/bad', response)]);
    const r = await get(port, '/bad');
    expect(r.status).toBe(500);
    expect(r.text).toBe('{"error":{"code":"INTERNAL_ERROR","message":"internal error"}}');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'");
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});
