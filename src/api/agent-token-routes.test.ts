import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { createMemoryAgentTokenStore, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createUserController, type AgentTokenStore } from '../users/index.js';
import { createAgentTokenRoutes } from './agent-token-routes.js';
import { createAccountRoutes } from './routes.js';
import { createApiServer, type ApiServer } from './server.js';

const PW = 'correct horse 7 staple';
let api: ApiServer | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  setCookie: string | null;
}
async function start(options: { tokens?: boolean; secure?: boolean } = {}) {
  const agentTokens: AgentTokenStore = createMemoryAgentTokenStore();
  const controller = createUserController({ users: createMemoryUserStore(), sessions: createMemorySessionStore(), ...(options.tokens === false ? {} : { agentTokens }), graphAdapter: createMemoryAdapter(), hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }) });
  const routes = [...createAccountRoutes({ controller }), ...(options.tokens === false ? [] : createAgentTokenRoutes({ controller, ...(options.secure === undefined ? {} : { secureCookies: options.secure }) }))];
  api = createApiServer({ routes });
  const port = await api.listen(0);
  const call = async (method: string, path: string, { body, cookie, headers = {} }: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie: `caci_session=${cookie}` }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, setCookie: res.headers.get('set-cookie') };
  };
  const signIn = async (name: string): Promise<string> => {
    await call('POST', '/api/register', { body: { username: name, displayName: name, password: PW } });
    const login = await call('POST', '/api/login', { body: { username: name, password: PW } });
    return /caci_session=([^;]+)/.exec(login.setCookie ?? '')?.[1] ?? '';
  };
  return { call, signIn, agentTokens, port };
}

describe('agent token routes (R-022)', () => {
  it('make a token (201, shown once), list it (never the token), and end it (204)', async () => {
    const { call, signIn } = await start();
    const session = await signIn('ann');
    const made = await call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: 'Desk agent', scopes: ['personal'], checks: true, days: 30 } });
    expect(made.status).toBe(201);
    expect(made.json.token).toMatch(/^cpat_[A-Za-z0-9_-]{43}$/);
    expect(made.json.agentToken).toMatchObject({ name: 'Desk agent', scopes: ['personal'], checks: true });
    const listed = await call('GET', '/api/me/agent-tokens', { cookie: session });
    expect(listed.status).toBe(200);
    expect(listed.json.items).toHaveLength(1);
    expect(listed.text).not.toContain(made.json.token);
    expect(listed.text).not.toContain('cpat_');
    const id = made.json.agentToken.id as string;
    expect((await call('DELETE', `/api/me/agent-tokens/${id}`, { cookie: session })).status).toBe(204);
    expect((await call('GET', '/api/me/agent-tokens', { cookie: session })).json.items).toEqual([]);
    expect((await call('DELETE', `/api/me/agent-tokens/${id}`, { cookie: session })).status).toBe(404);
  });

  it('send no-store and nothing but the one reply holds the token, and set no cookie', async () => {
    const { call, signIn, port } = await start();
    const session = await signIn('ann');
    const made = await fetch(`http://127.0.0.1:${port}/api/me/agent-tokens`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `caci_session=${session}` }, body: JSON.stringify({ name: 'a', scopes: ['personal'] }) });
    expect(made.status).toBe(201);
    expect(made.headers.get('cache-control')).toBe('no-store');
    expect(made.headers.get('set-cookie')).toBeNull();
    const listed = await call('GET', '/api/me/agent-tokens', { cookie: session });
    expect(listed.text).not.toMatch(/cpat_/);
  });

  it('need the session cookie: no cookie is 401 and sets nothing; a stale one is 401 and clears the cookie', async () => {
    const { call } = await start();
    const none = await call('GET', '/api/me/agent-tokens');
    expect(none.status).toBe(401);
    expect(none.setCookie).toBeNull();
    const stale = await call('GET', '/api/me/agent-tokens', { cookie: 'A'.repeat(43) });
    expect(stale.status).toBe(401);
    expect(stale.setCookie).toMatch(/Max-Age=0/);
  });

  it('ignore an Authorization header, a token in the URL and a token in the body: an agent token is not a credential here', async () => {
    const { call, signIn } = await start();
    const session = await signIn('ann');
    const made = await call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: 'a', scopes: ['personal'] } });
    const token = made.json.token as string;
    expect((await call('GET', '/api/me/agent-tokens', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call('GET', `/api/me/agent-tokens?token=${token}`)).status).toBe(401);
    expect((await call('GET', '/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call('POST', '/api/me/agent-tokens', { body: { name: 'b', scopes: ['personal'], token } })).status).toBe(401);
    expect((await call('GET', '/api/me/agent-tokens', { cookie: token })).status).toBe(401); // and as the cookie value
  });

  it('refuse unknown body fields and query parameters by name, and a body on DELETE', async () => {
    const { call, signIn } = await start();
    const session = await signIn('ann');
    const field = async (reply: Promise<Reply>, name: string): Promise<void> => {
      const r = await reply;
      expect(r.status).toBe(422);
      expect(r.json.error.field).toBe(name);
    };
    await field(call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: 'a', scopes: ['personal'], mode: 'write' } }), 'mode');
    await field(call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: 'a', scopes: ['personal'], userId: 'u1' } }), 'userId');
    await field(call('GET', '/api/me/agent-tokens?limit=5', { cookie: session }), 'limit');
    await field(call('DELETE', '/api/me/agent-tokens/t0000000000000000', { cookie: session, body: { x: 1 } }), 'x');
  });

  it('say which field is wrong (422), and a full list (409)', async () => {
    const { call, signIn } = await start();
    const session = await signIn('ann');
    for (const [body, field] of [[{ name: '', scopes: ['personal'] }, 'name'], [{ name: 'a', scopes: [] }, 'scopes'], [{ name: 'a', scopes: ['circle:x'] }, 'scopes'], [{ name: 'a', scopes: ['personal'], days: 400 }, 'days'], [{ name: 'a', scopes: ['personal'], checks: 'x' }, 'checks']] as const) {
      const r = await call('POST', '/api/me/agent-tokens', { cookie: session, body });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error.field).toBe(field);
    }
    for (let i = 0; i < 10; i++) expect((await call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: `n${i}`, scopes: ['personal'] } })).status).toBe(201);
    expect((await call('POST', '/api/me/agent-tokens', { cookie: session, body: { name: 'one more', scopes: ['personal'] } })).status).toBe(409);
  });

  it('one person cannot see or end another person\'s tokens: the same 404 as for a made-up id', async () => {
    const { call, signIn } = await start();
    const ann = await signIn('ann');
    const bob = await signIn('bob');
    const made = await call('POST', '/api/me/agent-tokens', { cookie: ann, body: { name: 'a', scopes: ['personal'] } });
    const id = made.json.agentToken.id as string;
    const theirs = await call('DELETE', `/api/me/agent-tokens/${id}`, { cookie: bob });
    const madeUp = await call('DELETE', '/api/me/agent-tokens/t0000000000000000', { cookie: bob });
    expect(theirs.status).toBe(404);
    expect(theirs.json).toEqual(madeUp.json);
    expect((await call('GET', '/api/me/agent-tokens', { cookie: bob })).json.items).toEqual([]);
    for (const odd of ['..', '%2e%2e', 'a%2fb', 'x'.repeat(200)]) expect((await call('DELETE', `/api/me/agent-tokens/${odd}`, { cookie: bob })).status).toBe(404);
  });

  it('with no token store the routes still exist but answer 404 (the service leaves them out entirely)', async () => {
    const { call, signIn } = await start({ tokens: false });
    const session = await signIn('ann');
    expect((await call('GET', '/api/me/agent-tokens', { cookie: session })).status).toBe(404);
  });

  it('other methods are 405', async () => {
    const { port } = await start();
    for (const method of ['PUT', 'PATCH']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/me/agent-tokens`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toMatch(/GET/);
    }
    expect((await fetch(`http://127.0.0.1:${port}/api/me/agent-tokens/t0000000000000000`, { method: 'GET' })).status).toBe(405);
  });
});
