import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiServer } from './server.js';

let api: ApiServer | undefined;
const logs: string[] = [];
afterEach(async () => {
  await api?.close();
  api = undefined;
  logs.length = 0;
});

async function start() {
  api = createApiServer({
    log: (e) => logs.push(JSON.stringify(e)),
    routes: [
      { method: 'POST', path: '/mcp', bearer: true, handler: (ctx) => ({ status: 200, body: { bearer: ctx.bearer ?? null, hasKey: 'bearer' in ctx, cookie: ctx.cookies.caci_session ?? null } }) },
      { method: 'GET', path: '/plain', handler: (ctx) => ({ status: 200, body: { bearer: ctx.bearer ?? null, hasKey: 'bearer' in ctx } }) },
      { method: 'POST', path: '/note', bearer: true, handler: () => ({ status: 202 }) },
    ],
  });
  return api.listen(0);
}
/** A raw request, so a header can be sent twice or in an odd spelling. */
function raw(port: number, method: string, path: string, headers: Array<[string, string]>, body?: string): Promise<{ status: number; json: any; text: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const flat: string[] = ['host', `127.0.0.1:${port}`];
    for (const [k, v] of headers) flat.push(k, v); // the flat form keeps every header as written, so a repeated one stays repeated
    if (body !== undefined) flat.push('content-type', 'application/json');
    const req = request({ port, method, path, headers: flat as never }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, json: text === '' ? undefined : JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const TOKEN = 'cpat_' + 'A'.repeat(43);
const mcp = (port: number, authorization?: string) => raw(port, 'POST', '/mcp', authorization === undefined ? [] : [['authorization', authorization]], '{}');

describe('the opt-in Bearer of a route (R-022 D17)', () => {
  it('hands a route that asked for it the token of an exact Bearer header', async () => {
    const port = await start();
    const r = await mcp(port, `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ bearer: TOKEN, hasKey: true, cookie: null });
  });

  it('accepts the scheme in any case (RFC 7235) but nothing else about the header\'s shape', async () => {
    const port = await start();
    for (const scheme of ['bearer', 'BEARER', 'bEaReR']) expect((await mcp(port, `${scheme} ${TOKEN}`)).json.bearer, scheme).toBe(TOKEN);
    for (const bad of [`Beare ${TOKEN}`, `Basic ${TOKEN}`, `Token ${TOKEN}`, `Bearer  ${TOKEN}`, `Bearer\t${TOKEN}`, 'Bearer ', 'Bearer', TOKEN, `Bearer ${TOKEN} extra`, `Bearer ${TOKEN},Bearer ${TOKEN}`, 'Bearer tok en', 'Bearer a=b', 'Bearer a.b', 'Bearer a+b', 'Bearer a/b', `Bearer ${'x'.repeat(129)}`, `Bearer é${TOKEN}`]) {
      const r = await mcp(port, bad);
      expect(r.status, bad).toBe(200);
      expect(r.json.bearer, bad).toBeNull();
      expect(r.json.hasKey, bad).toBe(false);
    }
    expect((await mcp(port, `Bearer ${'x'.repeat(128)}`)).json.bearer).toBe('x'.repeat(128));
    expect((await mcp(port, 'Bearer a')).json.bearer).toBe('a');
  });

  it('gives nothing when the header is missing, and when it is sent twice', async () => {
    const port = await start();
    expect((await mcp(port)).json).toMatchObject({ bearer: null, hasKey: false });
    const twice = await raw(port, 'POST', '/mcp', [['authorization', `Bearer ${TOKEN}`], ['authorization', `Bearer ${TOKEN}`]], '{}');
    expect(twice.json.bearer).toBeNull();
    const mixed = await raw(port, 'POST', '/mcp', [['Authorization', `Bearer ${TOKEN}`], ['authorization', `Bearer ${'B'.repeat(10)}`]], '{}');
    expect(mixed.json.bearer).toBeNull();
  });

  it('is not even looked at on a route that did not ask for it: no key at all', async () => {
    const port = await start();
    const r = await raw(port, 'GET', '/plain', [['authorization', `Bearer ${TOKEN}`]]);
    expect(r.json).toEqual({ bearer: null, hasKey: false });
  });

  it('leaves the cookie alone: both can arrive, and they are separate', async () => {
    const port = await start();
    const r = await raw(port, 'POST', '/mcp', [['authorization', `Bearer ${TOKEN}`], ['cookie', 'caci_session=abc']], '{}');
    expect(r.json).toEqual({ bearer: TOKEN, hasKey: true, cookie: 'abc' });
  });

  it('never logs the token, and a route may answer 202 with no body', async () => {
    const port = await start();
    await mcp(port, `Bearer ${TOKEN}`);
    const note = await raw(port, 'POST', '/note', [['authorization', `Bearer ${TOKEN}`]], '{}');
    expect(note.status).toBe(202);
    expect(note.text).toBe('');
    expect(logs.length).toBeGreaterThan(1);
    for (const line of logs) expect(line).not.toContain(TOKEN.slice(5));
    for (const line of logs) expect(Object.keys(JSON.parse(line)).sort()).toEqual(['method', 'ms', 'path', 'status'].sort());
  });
});
