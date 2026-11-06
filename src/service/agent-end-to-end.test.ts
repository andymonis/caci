import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from './config.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';

const PW = 'correct horse battery staple';
const DAY = 86_400_000;
const running: RunningService[] = [];
const dirs: string[] = [];
const seen: string[] = []; // everything an agent was ever told or sent, scanned for secrets at the end
const secrets = new Set<string>();
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}
function browser(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, text, json: text === '' ? undefined : JSON.parse(text), headers: res.headers };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      const login = await this.call('POST', '/api/login', { username: name, password: PW });
      if (login.status !== 200) throw new Error(`login failed for ${name}: ${login.text}`);
    },
    async file(text: string, scope?: unknown): Promise<void> {
      const made = await this.call('POST', '/api/capture/propose', { text, ...(scope === undefined ? {} : { scope }) });
      if (made.status !== 201) throw new Error(`propose failed: ${made.text}`);
      const approved = await this.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`);
      if (approved.status !== 200) throw new Error(`approve failed: ${approved.text}`);
    },
    async token(options: Record<string, unknown>): Promise<string> {
      const made = await this.call('POST', '/api/me/agent-tokens', options);
      if (made.status !== 201) throw new Error(`token failed: ${made.text}`);
      secrets.add(made.json.token as string);
      return made.json.token as string;
    },
  };
}
/** An MCP client: JSON-RPC over POST /mcp with a Bearer token. */
function agent(port: number, token: string | undefined) {
  let id = 0;
  const post = async (body: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    seen.push(text);
    return { status: res.status, text, json: text === '' ? undefined : JSON.parse(text), headers: res.headers };
  };
  return {
    post,
    rpc: (method: string, params?: unknown) => post({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }),
    /** The structured result of a tool call, or the error text. */
    async tool(name: string, args: unknown = {}): Promise<{ ok: boolean; data: any; text: string; status: number }> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await this.rpc('tools/call', { name, arguments: args });
      const result = r.json?.result;
      return { ok: result !== undefined && result.isError === false, data: result?.structuredContent ?? (result === undefined ? r.json : JSON.parse(result.content[0].text)), text: result?.content?.[0]?.text ?? r.text, status: r.status };
    },
  };
}

async function start(extra: Partial<ServiceConfig> = {}, options: { clock?: () => number } = {}, dir?: string) {
  const folder = dir ?? mkdtempSync(join(tmpdir(), 'caci-agent-e2e-'));
  if (dir === undefined) dirs.push(folder);
  const service = await startService({ ...baseConfig(folder), agentAccess: true, ...extra }, options);
  running.push(service);
  return { service, dir: folder, port: service.port };
}

/** root is the administrator; ann owns Club (bob is a member, cat an observer) and has her own notes; dan is a stranger. */
async function world(extra: Partial<ServiceConfig> = {}, options: { clock?: () => number } = {}) {
  const s = await start(extra, options);
  const [root, ann, bob, cat, dan] = ['root', 'ann', 'bob', 'cat', 'dan'].map(() => browser(s.port)) as [ReturnType<typeof browser>, ReturnType<typeof browser>, ReturnType<typeof browser>, ReturnType<typeof browser>, ReturnType<typeof browser>];
  for (const [b, name] of [[root, 'root'], [ann, 'ann'], [bob, 'bob'], [cat, 'cat'], [dan, 'dan']] as const) await b.signIn(name);
  const club = (await ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  const secret = (await ann.call('POST', '/api/circles', { name: 'Secret' })).json.circle.id as string;
  for (const [who, name, role] of [[bob, 'bob', 'member'], [cat, 'cat', 'observer']] as const) {
    expect((await ann.call('POST', `/api/circles/${club}/invitations`, { username: name, role })).status).toBe(202);
    const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await who.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  }
  await ann.file('Dentist appointment on Tuesday at four');
  await bob.file('Garden club meets on Wednesday evening', { kind: 'circle', circleId: club });
  await ann.file('Hidden budget for the secret project', { kind: 'circle', circleId: secret });
  return { ...s, root, ann, bob, cat, dan, club, secret };
}

describe('the agent surface through the running service (R-022)', () => {
  it('is off by default: /mcp is a plain 404', async () => {
    const { port } = await start({ agentAccess: false });
    const r = await agent(port, 'cpat_' + 'A'.repeat(43)).rpc('ping');
    expect(r.status).toBe(404);
  });

  it('an agent connects, sees five read tools, and reads the brains its token lists with provenance', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'Desk agent', scopes: ['personal', `circle:${w.club}`] });
    const a = agent(w.port, token);
    const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.json.result.serverInfo.name).toBe('caci');
    expect((await a.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const listed = await a.rpc('tools/list');
    expect(listed.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes']);
    expect((await a.tool('list_brains')).data.brains).toEqual([{ scope: 'personal', name: 'Your own notes' }, { scope: `circle:${w.club}`, name: 'Club', role: 'owner' }]);
    const found = await a.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden club wednesday' });
    expect(found.ok).toBe(true);
    expect(found.data.brain).toEqual({ scope: `circle:${w.club}`, name: 'Club' });
    expect(found.data.facts).toHaveLength(1);
    expect(found.data.facts[0]).toMatchObject({ entered_by: { username: 'bob', display_name: 'Display bob' } });
    const factId = found.data.facts[0].id as string;
    const fact = await a.tool('get_fact', { scope: `circle:${w.club}`, id: factId });
    expect(fact.data).toMatchObject({ current: true, source: { entered_by: { username: 'bob' }, words: 'Garden club meets on Wednesday evening', words_kept: true, replaced_later: false } });
    const mine = await a.tool('search_facts', { scope: 'personal', text: 'dentist tuesday' });
    expect(mine.data.facts).toHaveLength(1);
    expect(mine.data.facts[0].entered_by).toBeUndefined();
    const cats = await a.tool('browse', { scope: `circle:${w.club}` });
    expect(cats.data.categories.length).toBeGreaterThan(0);
    const inCat = await a.tool('browse', { scope: `circle:${w.club}`, category: cats.data.categories[0].id });
    expect(inCat.data.facts.length).toBeGreaterThan(0);
    const changes = await a.tool('changes', { scope: `circle:${w.club}`, since: '1970-01-01T00:00:00Z' });
    expect(changes.data.changes.some((c: { words?: string }) => c.words === 'Garden club meets on Wednesday evening')).toBe(true);
    expect((await a.tool('changes', { scope: `circle:${w.club}`, since: new Date(Date.now() + DAY).toISOString() })).data.changes).toEqual([]);
  });

  it('a token sees only what it lists: another circle the person is in, the personal brain, and a made-up circle are all the one answer', async () => {
    const w = await world();
    const clubOnly = agent(w.port, await w.ann.token({ name: 'club only', scopes: [`circle:${w.club}`] }));
    const outside = await clubOnly.tool('search_facts', { scope: `circle:${w.secret}`, text: 'budget secret' });
    expect(outside.ok).toBe(false);
    expect(outside.data).toEqual({ error: 'no such circle' });
    for (const scope of ['personal', 'circle:c0000000000000099']) expect((await clubOnly.tool('search_facts', { scope, text: 'budget' })).data, scope).toEqual(outside.data);
    for (const [tool, args] of [['browse', { scope: `circle:${w.secret}` }], ['changes', { scope: `circle:${w.secret}`, since: '1970-01-01' }], ['get_fact', { scope: `circle:${w.secret}`, id: 'x' }]] as const) expect((await clubOnly.tool(tool, args)).data, tool).toEqual(outside.data);
    expect((await clubOnly.tool('list_brains')).data.brains).toEqual([{ scope: `circle:${w.club}`, name: 'Club', role: 'owner' }]);
  });

  it('a stranger\'s token that names a circle gets the made-up answer, and the administrator has no more than a member', async () => {
    const w = await world();
    const stranger = agent(w.port, await w.dan.token({ name: 'dan', scopes: ['personal', `circle:${w.club}`] }));
    const r = await stranger.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden club' });
    expect(r.data).toEqual({ error: 'no such circle' });
    const root = agent(w.port, await w.root.token({ name: 'root', scopes: [`circle:${w.club}`, `circle:${w.secret}`] }));
    expect((await root.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden' })).data).toEqual({ error: 'no such circle' });
    expect((await root.tool('list_brains')).data.brains).toEqual([]);
    expect((await stranger.tool('search_facts', { scope: 'personal', text: 'dentist' })).data.facts).toEqual([]); // dan's own brain is empty: not ann's
  });

  it('an observer\'s token reads the circle, and a removed member\'s token stops reading it at once', async () => {
    const w = await world();
    const cat = agent(w.port, await w.cat.token({ name: 'cat', scopes: [`circle:${w.club}`] }));
    expect((await cat.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden club' })).data.facts).toHaveLength(1);
    const members = (await w.ann.call('GET', `/api/circles/${w.club}/members`)).json.items as Array<{ userId: string; username: string }>;
    const catId = members.find((m) => m.username === 'cat')?.userId as string;
    expect((await w.ann.call('DELETE', `/api/circles/${w.club}/members/${catId}`)).status).toBe(204);
    expect((await cat.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden club' })).data).toEqual({ error: 'no such circle' });
  });

  it('a session cookie is not accepted on /mcp, and a token is not a credential anywhere else', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'a', scopes: ['personal'] });
    const viaCookie = await fetch(`http://127.0.0.1:${w.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `caci_session=${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(viaCookie.status).toBe(401);
    const anon = await agent(w.port, undefined).rpc('ping');
    expect(anon.status).toBe(401);
    for (const path of ['/api/me', '/api/graph', '/api/graph/categories', '/api/brain', '/api/ledger', '/api/circles', '/api/me/agent-tokens']) {
      expect((await browser(w.port).call('GET', path, undefined, { authorization: `Bearer ${token}` })).status, path).toBe(401);
      expect((await browser(w.port).call('GET', `${path}?token=${token}`)).status, `${path} with the token in the query`).toBe(401);
    }
  });

  it('revoking a token, changing the password and a token\'s expiry each stop it at once', async () => {
    const clock = { value: Date.now() };
    const w = await world({}, { clock: () => clock.value });
    const t1 = await w.ann.token({ name: 'one', scopes: ['personal'] });
    const t2 = await w.ann.token({ name: 'two', scopes: ['personal'] });
    const shortLived = await w.bob.token({ name: 'short', scopes: ['personal'], days: 1 });
    const longLived = await w.bob.token({ name: 'long', scopes: ['personal'], days: 30 });
    expect((await agent(w.port, t1).tool('list_brains')).ok).toBe(true);
    const id = (await w.ann.call('GET', '/api/me/agent-tokens')).json.items.find((i: { name: string }) => i.name === 'one').id as string;
    expect((await w.ann.call('DELETE', `/api/me/agent-tokens/${id}`)).status).toBe(204);
    expect((await agent(w.port, t1).rpc('ping')).status).toBe(401);
    expect((await agent(w.port, t2).tool('list_brains')).ok).toBe(true);
    expect((await w.ann.call('POST', '/api/me/password', { currentPassword: PW, newPassword: 'another long passphrase 42' })).status).toBe(200);
    expect((await agent(w.port, t2).rpc('ping')).status).toBe(401);
    clock.value += DAY - 1;
    expect((await agent(w.port, shortLived).tool('list_brains')).ok).toBe(true);
    clock.value += 1;
    expect((await agent(w.port, shortLived).rpc('ping')).status).toBe(401);
    expect((await agent(w.port, longLived).tool('list_brains')).ok).toBe(true);
  });

  it('an agent can write nothing: no write tool exists, and every brain is the same after every call', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'a', scopes: ['personal', `circle:${w.club}`, `circle:${w.secret}`], checks: true });
    const a = agent(w.port, token);
    const snapshot = async () => JSON.stringify([(await w.ann.call('GET', '/api/graph')).json, (await w.ann.call('GET', '/api/brain?scope=circle:' + w.club)).json, (await w.ann.call('GET', '/api/brain?scope=circle:' + w.secret)).json, (await w.ann.call('GET', '/api/ledger')).json]);
    const before = await snapshot();
    const names = (await a.rpc('tools/list')).json.result.tools.map((t: { name: string }) => t.name) as string[];
    expect(names).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes', 'pulse']);
    for (const bad of ['file_note', 'propose', 'approve', 'reject', 'delete_fact', 'update', 'create']) expect((await a.rpc('tools/call', { name: bad, arguments: { text: 'x', scope: 'personal' } })).json.error).toEqual({ code: -32602, message: 'unknown tool' });
    for (const scope of ['personal', `circle:${w.club}`, `circle:${w.secret}`]) {
      await a.tool('search_facts', { scope, text: 'meets budget dentist' });
      await a.tool('browse', { scope });
      await a.tool('changes', { scope, since: '1970-01-01' });
    }
    await a.tool('pulse', { check: 'long-range' });
    expect(await snapshot()).toBe(before);
  });

  it('pulse needs the checks flag, uses only the token\'s scopes, and has an hourly allowance', async () => {
    const w = await world({ statusPerHour: 2 });
    const plain = agent(w.port, await w.ann.token({ name: 'plain', scopes: ['personal'] }));
    expect((await plain.rpc('tools/call', { name: 'pulse', arguments: { check: 'pulse' } })).json.error).toEqual({ code: -32602, message: 'unknown tool' });
    const checks = agent(w.port, await w.ann.token({ name: 'checks', scopes: [`circle:${w.club}`], checks: true }));
    const first = await checks.tool('pulse', { check: 'pulse' });
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({ nothing: expect.any(Boolean), notes_read: expect.any(Number) });
    expect(JSON.stringify(first.data)).not.toMatch(/Hidden budget|Dentist/); // the other brains are not read
    expect((await checks.tool('pulse', { check: 'coming-up' })).ok).toBe(true);
    const third = await checks.tool('pulse', { check: 'long-range' });
    expect(third.ok).toBe(false);
    expect(third.data.error).toMatch(/most statuses allowed in an hour/);
    expect((await checks.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden' })).ok).toBe(true); // reading is not limited by it
  });

  it('keeps working across a restart, and a flood of bad tokens is turned away per client', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'a', scopes: ['personal'] });
    expect((await agent(w.port, token).tool('list_brains')).ok).toBe(true);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    const again = await start({}, {}, w.dir);
    expect((await agent(again.port, token).tool('list_brains')).ok).toBe(true);
    const bad = agent(again.port, 'cpat_' + 'B'.repeat(43));
    for (let i = 0; i < 30; i++) expect((await bad.rpc('ping')).status).toBe(401);
    const blocked = await bad.rpc('ping');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
  });

  it('the throttle on bad tokens uses the service clock: an hour later the client is let in again', async () => {
    const clock = { value: Date.now() };
    const { port } = await start({}, { clock: () => clock.value });
    const bad = agent(port, 'cpat_' + 'C'.repeat(43));
    for (let i = 0; i < 30; i++) await bad.rpc('ping');
    expect((await bad.rpc('ping')).status).toBe(429);
    clock.value += 60 * 60_000 + 1;
    expect((await bad.rpc('ping')).status).toBe(401);
  });

  it('a clean stop leaves the two database files, and the file holds only the hash of each token', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'a', scopes: ['personal'] });
    await agent(w.port, token).tool('list_brains');
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    expect(readdirSync(w.dir).sort()).toEqual(['graphs.db', 'users.db']);
    const bytes = Buffer.concat(readdirSync(w.dir).map((n) => readFileSync(join(w.dir, n))));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token.slice(5)))).toBe(false);
  });

  it('nothing an agent was told holds a token, a password, a hash, a graph id or a user id', async () => {
    const w = await world();
    const token = await w.ann.token({ name: 'a', scopes: ['personal', `circle:${w.club}`], checks: true });
    const a = agent(w.port, token);
    await a.rpc('initialize', { protocolVersion: '2025-06-18' });
    await a.rpc('tools/list');
    await a.tool('list_brains');
    await a.tool('search_facts', { scope: `circle:${w.club}`, text: 'garden' });
    await a.tool('search_facts', { scope: 'personal', text: 'dentist' });
    await a.tool('browse', { scope: 'personal' });
    await a.tool('changes', { scope: `circle:${w.club}`, since: '1970-01-01' });
    await a.tool('pulse', { check: 'pulse' });
    const members = (await w.ann.call('GET', `/api/circles/${w.club}/members`)).json.items as Array<{ userId: string }>;
    const all = seen.join('\n');
    expect(seen.length).toBeGreaterThan(8);
    for (const leak of [...secrets, PW, 'scrypt$', 'passwordHash', 'user-u', 'circle-c', ...members.map((m) => m.userId)]) expect(all.includes(leak), leak.slice(0, 12)).toBe(false);
  });
});
