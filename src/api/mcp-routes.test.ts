import { afterEach, describe, expect, it } from 'vitest';
import type { AgentToolInfo, AgentToolOutcome, AgentTools } from '../agent/index.js';
import { createMcpRoutes, MCP_PROTOCOL_VERSIONS } from './mcp-routes.js';
import { createApiServer, type ApiServer } from './server.js';

const GOOD = 'cpat_' + 'G'.repeat(43);
/** A token that is live when the request starts and gone when the tool runs (revoked in between). */
const VANISHING = 'cpat_' + 'V'.repeat(43);
const INFOS: readonly AgentToolInfo[] = [{ name: 'echo', title: 'Echo', description: 'Says back what it is given.', inputSchema: { type: 'object', properties: { word: { type: 'string' } }, additionalProperties: false } }];
const calls: Array<{ name: unknown; args: unknown }> = [];
const tools: AgentTools = {
  list: async (b) => (b === GOOD || b === VANISHING ? INFOS : undefined),
  call: async (b, name, args): Promise<AgentToolOutcome> => {
    if (b !== GOOD) return { kind: 'unauthenticated' };
    calls.push({ name, args });
    if (name === 'echo') return { kind: 'result', result: { isError: false, data: { said: (args as { word?: string } | undefined)?.word ?? null }, text: JSON.stringify({ said: (args as { word?: string } | undefined)?.word ?? null }) } };
    if (name === 'bad') return { kind: 'result', result: { isError: true, data: { error: 'word is wrong' }, text: '{"error":"word is wrong"}' } };
    if (name === 'boom') throw new Error('secret path /var/db');
    return { kind: 'unknown-tool' };
  },
};

let api: ApiServer | undefined;
const logs: string[] = [];
afterEach(async () => {
  await api?.close();
  api = undefined;
  logs.length = 0;
  calls.length = 0;
});
async function start(options: { badTokensPerHour?: number; trustedProxies?: number } = {}) {
  const routes = createMcpRoutes({ tools, ...(options.badTokensPerHour === undefined ? {} : { badTokensPerHour: options.badTokensPerHour }) });
  api = createApiServer({ routes, log: (e) => logs.push(JSON.stringify(e)), ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }) });
  const port = await api.listen(0);
  const rpc = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${GOOD}` }, method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text === '' ? undefined : (JSON.parse(text) as any), headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { port, rpc };
}
const req = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('the MCP route (R-022)', () => {
  it('answers initialize with the version asked for when it is supported, the newest otherwise, and the tools capability', async () => {
    const { rpc } = await start();
    for (const version of MCP_PROTOCOL_VERSIONS) {
      const r = await rpc(req('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'caci', title: 'CaCi brain', version: '1.0.0' } } });
    }
    for (const asked of ['1999-01-01', 5, null, undefined]) expect((await rpc(req('initialize', { protocolVersion: asked }))).json.result.protocolVersion, String(asked)).toBe(MCP_PROTOCOL_VERSIONS[0]);
    expect((await rpc(req('initialize'))).json.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]); // no params at all
  });

  it('answers ping, and lists the tools it was given as read-only, with their schemas', async () => {
    const { rpc } = await start();
    expect((await rpc(req('ping', undefined, 'abc'))).json).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} });
    const listed = await rpc(req('tools/list'));
    expect(listed.json.result.tools).toEqual([{ name: 'echo', title: 'Echo', description: 'Says back what it is given.', inputSchema: INFOS[0]?.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } }]);
  });

  it('answers a notification (no id) with 202 and nothing, whatever the method', async () => {
    const { rpc } = await start();
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'tools/list', 'anything/else']) {
      const r = await rpc({ jsonrpc: '2.0', method });
      expect(r.status, method).toBe(202);
      expect(r.text, method).toBe('');
    }
    expect(calls).toEqual([]); // a call without an id is never run
    expect((await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { word: 'x' } } })).status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('runs a tool and gives content (text) and structuredContent, or an error result with no structured part', async () => {
    const { rpc } = await start();
    const ok = await rpc(req('tools/call', { name: 'echo', arguments: { word: 'hello' } }, 7));
    expect(ok.json).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '{"said":"hello"}' }], structuredContent: { said: 'hello' }, isError: false } });
    expect(calls).toEqual([{ name: 'echo', args: { word: 'hello' } }]);
    const noArgs = await rpc(req('tools/call', { name: 'echo' }));
    expect(noArgs.json.result.structuredContent).toEqual({ said: null });
    const bad = await rpc(req('tools/call', { name: 'bad', arguments: {} }));
    expect(bad.json.result).toEqual({ content: [{ type: 'text', text: '{"error":"word is wrong"}' }], isError: true });
  });

  it('refuses what it does not speak with a fixed JSON-RPC error', async () => {
    const { rpc } = await start();
    for (const method of ['resources/list', 'prompts/list', 'logging/setLevel', 'completion/complete', 'tools', 'Initialize', '']) expect((await rpc(req(method))).json.error, method).toEqual({ code: -32601, message: 'method not found' });
    expect((await rpc(req('tools/call', { name: 'nope' }))).json.error).toEqual({ code: -32602, message: 'unknown tool' });
    for (const params of [{}, { name: 5 }, { name: 'x'.repeat(65) }, { name: 'echo', arguments: 'word' }, { name: 'echo', arguments: ['a'] }, { name: 'echo', arguments: null }]) expect((await rpc(req('tools/call', params))).json.error, JSON.stringify(params)).toEqual({ code: -32602, message: 'invalid params' });
    for (const params of [[], 'x', 5, null]) expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping', params })).json.error, JSON.stringify(params)).toEqual({ code: -32602, message: 'invalid params' });
  });

  it('refuses a request that is not JSON-RPC 2.0 with 400 and a null id', async () => {
    const { rpc } = await start();
    const invalid = { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
    for (const body of [{ id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, method: 5 }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: true, method: 'ping' }, { jsonrpc: '2.0', id: '', method: 'ping' }, { jsonrpc: '2.0', id: 'i'.repeat(129), method: 'ping' }, {}]) {
      const r = await rpc(body);
      expect({ status: r.status, json: r.json }, JSON.stringify(body)).toEqual(invalid);
    }
    expect((await rpc({ jsonrpc: '2.0', id: 'i'.repeat(128), method: 'ping' })).status).toBe(200);
    expect((await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' })).json.id).toBe(0);
    expect((await rpc('')).status).toBe(400); // an empty body: there is nothing to answer
  });

  it('is a plain 401 for no token, a wrong one, a malformed header and a cookie; the same body every time; no cookie set', async () => {
    const { rpc } = await start();
    const first = await rpc(req('ping'), {});
    expect(first.status).toBe(401);
    expect(first.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    for (const headers of [{ authorization: 'Bearer ' + 'cpat_' + 'X'.repeat(43) }, { authorization: 'Basic abc' }, { authorization: GOOD }, { cookie: `caci_session=${GOOD}` }, { authorization: `Bearer ${GOOD.slice(0, -1)}` }]) {
      const r = await rpc(req('ping'), headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.json).toEqual(first.json);
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect((await rpc(req('tools/list'), {})).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, {})).status).toBe(401); // even a notification needs a token
  });

  it('counts bad tokens per client: after the limit even a good token is turned away with Retry-After, and another client is not affected', async () => {
    const { port } = await start({ badTokensPerHour: 3, trustedProxies: 1 });
    const send = (authorization: string, client: string) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': client, authorization }, body: JSON.stringify(req('ping')) });
    for (let i = 0; i < 3; i++) expect((await send('Bearer wrong', '10.0.0.1')).status).toBe(401);
    const blocked = await send(`Bearer ${GOOD}`, '10.0.0.1');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(3500); // about an hour
    expect(await blocked.json()).toEqual({ error: { code: 'THROTTLED', message: 'too many requests with a bad token: wait and try again' } });
    expect((await send(`Bearer ${GOOD}`, '10.0.0.2')).status).toBe(200);
  });

  it('the default allowance is 30 bad requests an hour', async () => {
    const { rpc } = await start();
    for (let i = 0; i < 30; i++) expect((await rpc(req('ping'), { authorization: 'Bearer nope' })).status, String(i)).toBe(401);
    expect((await rpc(req('ping'))).status).toBe(429);
  });

  it('a token that goes between the check and the call is the same 401, and counts as a bad one', async () => {
    const { rpc } = await start({ badTokensPerHour: 1 });
    const gone = await rpc(req('tools/call', { name: 'echo' }), { authorization: `Bearer ${VANISHING}` });
    expect(gone.status).toBe(401);
    expect(gone.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    expect((await rpc(req('ping'))).status).toBe(429); // that miss used the allowance
  });

  it('a good token is never counted', async () => {
    const { rpc } = await start({ badTokensPerHour: 2 });
    for (let i = 0; i < 20; i++) expect((await rpc(req('ping'))).status).toBe(200);
  });

  it('allows POST only: GET and others are 405 with Allow, and a body that is not JSON is refused before the protocol', async () => {
    const { rpc, port } = await start();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rpc(undefined, { authorization: `Bearer ${GOOD}` }, method);
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toMatch(/POST/);
    }
    const form = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${GOOD}` }, body: 'x' });
    expect(form.status).toBe(415);
    expect((await rpc([req('ping')])).status).toBe(400); // a batch (an array) is not accepted
  });

  it('refuses a request from another website (Origin) and answers nothing with a cross-site header', async () => {
    const { rpc } = await start();
    const r = await rpc(req('ping'), { authorization: `Bearer ${GOOD}`, origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('turns a tool that throws into a fixed internal error: nothing of what failed', async () => {
    const { rpc } = await start();
    const r = await rpc(req('tools/call', { name: 'boom' }));
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
    expect(r.text).not.toContain('secret');
  });

  it('never logs the token, and sets the usual no-store and nosniff headers', async () => {
    const { rpc } = await start();
    const r = await rpc(req('ping'));
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    await rpc(req('ping'), { authorization: 'Bearer wrong-token-value' });
    expect(logs.length).toBeGreaterThan(1);
    for (const line of logs) expect(line).not.toMatch(/GGGGGG|wrong-token-value/);
  });
});
