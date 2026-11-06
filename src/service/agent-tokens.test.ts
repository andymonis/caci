import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from './config.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';

const PW = 'correct horse battery staple';
const running: RunningService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(extra: Partial<ServiceConfig> = {}, dir?: string): Promise<{ service: RunningService; dir: string }> {
  const folder = dir ?? mkdtempSync(join(tmpdir(), 'caci-agent-svc-'));
  if (dir === undefined) dirs.push(folder);
  const service = await startService({ ...baseConfig(folder), ...extra });
  running.push(service);
  return { service, dir: folder };
}
function browser(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: name, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}

describe('agent tokens through the running service (R-022)', () => {
  it('are off by default: the routes do not exist', async () => {
    const { service } = await start();
    const ann = browser(service.port);
    await ann.signIn('ann');
    for (const [method, path] of [['GET', '/api/me/agent-tokens'], ['POST', '/api/me/agent-tokens'], ['DELETE', '/api/me/agent-tokens/t0000000000000000']] as const) {
      const r = await ann.call(method, path, method === 'POST' ? { name: 'a', scopes: ['personal'] } : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // the routes are not merely refusing: they are not there (a wrong method on a route that exists is a 405, and a signed-out call a 401)
    expect((await ann.call('PUT', '/api/me/agent-tokens')).status).toBe(404);
    expect((await browser(service.port).call('GET', '/api/me/agent-tokens')).status).toBe(404);
  });

  it('switched on, the routes exist: a wrong method is 405 and a signed-out call is 401', async () => {
    const { service } = await start({ agentAccess: true });
    expect((await browser(service.port).call('PUT', '/api/me/agent-tokens')).status).toBe(405);
    expect((await browser(service.port).call('GET', '/api/me/agent-tokens')).status).toBe(401);
  });

  it('a token asked for without the checks flag has it off', async () => {
    const { service } = await start({ agentAccess: true });
    const ann = browser(service.port);
    await ann.signIn('ann');
    expect((await ann.call('POST', '/api/me/agent-tokens', { name: 'a', scopes: ['personal'] })).json.agentToken.checks).toBe(false);
  });

  it('clear a stale cookie with Secure when the service is set to secure cookies', async () => {
    const { service } = await start({ agentAccess: true, cookieSecure: true });
    const res = await fetch(`http://127.0.0.1:${service.port}/api/me/agent-tokens`, { headers: { cookie: `caci_session=${'A'.repeat(43)}` } });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0.*Secure|Secure.*Max-Age=0/);
  });

  it('switched on: make, list and end a token; the token is shown once and never listed', async () => {
    const { service } = await start({ agentAccess: true });
    const ann = browser(service.port);
    await ann.signIn('ann');
    const made = await ann.call('POST', '/api/me/agent-tokens', { name: 'Desk agent', scopes: ['personal'] });
    expect(made.status).toBe(201);
    const listed = await ann.call('GET', '/api/me/agent-tokens');
    expect(listed.json.items).toHaveLength(1);
    expect(listed.text).not.toContain(made.json.token);
    expect((await ann.call('DELETE', `/api/me/agent-tokens/${made.json.agentToken.id}`)).status).toBe(204);
    expect((await ann.call('GET', '/api/me/agent-tokens')).json.items).toEqual([]);
  });

  it('each person sees only their own tokens', async () => {
    const { service } = await start({ agentAccess: true });
    const ann = browser(service.port);
    const bob = browser(service.port);
    await ann.signIn('ann');
    await bob.signIn('bob');
    await ann.call('POST', '/api/me/agent-tokens', { name: 'ann agent', scopes: ['personal'] });
    expect((await bob.call('GET', '/api/me/agent-tokens')).json.items).toEqual([]);
  });

  it('changing the password ends every token, and an agent token is not a credential on any route', async () => {
    const { service } = await start({ agentAccess: true });
    const ann = browser(service.port);
    await ann.signIn('ann');
    const made = await ann.call('POST', '/api/me/agent-tokens', { name: 'a', scopes: ['personal'] });
    const token = made.json.token as string;
    for (const path of ['/api/me', '/api/graph', '/api/graph/categories']) expect((await browser(service.port).call('GET', path, undefined, { authorization: `Bearer ${token}` })).status, path).toBe(401);
    const change = await ann.call('POST', '/api/me/password', { currentPassword: PW, newPassword: 'another long passphrase 42' });
    expect(change.status).toBe(200);
    expect((await ann.call('GET', '/api/me/agent-tokens')).json.items).toEqual([]);
  });

  it('are kept across a restart, and the file holds only the hash of the token', async () => {
    const first = await start({ agentAccess: true });
    const ann = browser(first.service.port);
    await ann.signIn('ann');
    const token = (await ann.call('POST', '/api/me/agent-tokens', { name: 'a', scopes: ['personal'] })).json.token as string;
    await first.service.close();
    running.splice(running.indexOf(first.service), 1);
    const bytes = Buffer.concat(readdirSync(first.dir).map((name) => readFileSync(join(first.dir, name))));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token.slice(5), 'base64url'))).toBe(false);
    const second = await start({ agentAccess: true }, first.dir);
    const again = browser(second.service.port);
    await again.call('POST', '/api/login', { username: 'ann', password: PW });
    expect((await again.call('GET', '/api/me/agent-tokens')).json.items).toHaveLength(1);
  });

  it('deleting the account removes its tokens (the database does it)', async () => {
    const { service } = await start({ agentAccess: true });
    const root = browser(service.port);
    const ann = browser(service.port);
    await root.signIn('root'); // the first account is the administrator and cannot delete itself
    await ann.signIn('ann');
    await ann.call('POST', '/api/me/agent-tokens', { name: 'a', scopes: ['personal'] });
    expect((await ann.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    const again = browser(service.port);
    await again.call('POST', '/api/register', { username: 'ann', displayName: 'ann', password: PW });
    await again.call('POST', '/api/login', { username: 'ann', password: PW });
    expect((await again.call('GET', '/api/me/agent-tokens')).json.items).toEqual([]); // a new account of the same name starts with none
  });
});
