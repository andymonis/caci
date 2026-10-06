import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { llmError, type ModelClient } from '../llm/index.js';
import { serve } from './cli.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService, type ServiceOptions } from './service.js';

const PW = 'correct horse 7 staple';
const KEY = 'sk-ant-api03-SERVICE-TEST-SECRET-KEY-0123456789';
const dirs: string[] = [];
const running: RunningService[] = [];
const everythingSeen: string[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = everythingSeen.join('\n');
  expect(everythingSeen.length).toBeGreaterThan(40);
  expect(all.includes(KEY), 'the API key appeared in a response, a log line or printed output').toBe(false);
  expect(all).not.toContain('SERVICE-TEST-SECRET');
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-capture-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, ...extra });
async function start(dataDir: string, extra: Partial<ServiceConfig> = {}, options: ServiceOptions = {}): Promise<RunningService> {
  const service = await startService(config(dataDir, extra), { log: (e) => everythingSeen.push(JSON.stringify(e)), ...options });
  running.push(service);
  return service;
}

/** A browser: remembers the cookie, records what the server said. */
function browser(port: number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      everythingSeen.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), headers: res.headers };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: name, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
    get cookie() {
      return cookie;
    },
  };
}

/** A stand-in for the provider: answers the real client's requests the way the Messages API does, and records them. */
function fakeAnthropic(handler?: (call: number) => Response | undefined) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> & { system?: string } }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { system?: string };
    seen.push({ url: String(input), headers, body });
    const forced = handler?.(seen.length);
    if (forced !== undefined) return forced;
    const itemId = /The note's own id is "([^"]+)"/.exec(body.system ?? '')?.[1] as string;
    const reply = { ops: [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: 'From the provider', summary: 'filed by the stand-in' } }, { op: 'upsertNode', partition: 'category', id: 'provider-made', data: { name: 'Provider made' } }, { op: 'link', item: itemId, category: 'provider-made', weight: 0.7 }], rationale: 'because the stand-in said so' };
    const message = { id: 'msg_x', type: 'message', role: 'assistant', model: String(body.model), content: [{ type: 'text', text: JSON.stringify(reply), citations: null }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 123, output_tokens: 45, cache_creation_input_tokens: null, cache_read_input_tokens: null } };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchFn, seen };
}
const providerError = (status: number, type: string, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('capture through the running service, with the demo model', () => {
  it('propose, preview, approve, browse: the whole path over HTTP, and nothing was written before approval', async () => {
    const service = await start(tmp());
    const web = browser(service.port);
    await web.signIn('ann');
    const proposed = await web.call('POST', '/api/capture/propose', { text: 'Dr Patel booked my blood test' });
    expect(proposed.status).toBe(201);
    expect(proposed.json.proposal.mode).toBe('demo');
    expect((await web.call('GET', '/api/graph')).json.summary).toEqual({ itemCount: 0, categoryCount: 0, edgeCount: 0 });
    expect((await web.call('POST', `/api/capture/proposals/${proposed.json.proposal.id}/approve`)).status).toBe(200);
    expect((await web.call('GET', '/api/graph')).json.summary).toEqual({ itemCount: 1, categoryCount: 1, edgeCount: 1 });
    const categories = (await web.call('GET', '/api/graph/categories')).json.items;
    expect(categories).toHaveLength(1);
    const items = (await web.call('GET', `/api/graph/category?id=${encodeURIComponent(categories[0].id)}`)).json.items;
    expect(items[0].data.title).toContain('Dr Patel');
    expect((await web.call('GET', `/api/graph/item?id=${encodeURIComponent(items[0].id)}`)).json.categories[0].id).toBe(categories[0].id);
  }, 30_000);

  it('a restart keeps what was approved and forgets what was pending', async () => {
    const dir = tmp();
    const first = await start(dir);
    const web = browser(first.port);
    await web.signIn('ann');
    const approved = (await web.call('POST', '/api/capture/propose', { text: 'approved before the restart' })).json.proposal;
    await web.call('POST', `/api/capture/proposals/${approved.id}/approve`);
    const pending = (await web.call('POST', '/api/capture/propose', { text: 'pending at the restart' })).json.proposal;
    const cookie = web.cookie as string;
    await first.close();

    const second = await start(dir);
    const after = await fetch(`http://127.0.0.1:${second.port}/api/graph`, { headers: { cookie } });
    expect(((await after.json()) as { summary: { itemCount: number } }).summary.itemCount).toBe(1);
    const gone = await fetch(`http://127.0.0.1:${second.port}/api/capture/proposals/${pending.id}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
    const again = await fetch(`http://127.0.0.1:${second.port}/api/capture/proposals/${pending.id}/approve`, { method: 'POST', headers: { cookie } });
    expect(again.status).toBe(404);
  }, 30_000);

  it('a clean close still leaves only the two database files', async () => {
    const dir = tmp();
    const service = await start(dir);
    const web = browser(service.port);
    await web.signIn('ann');
    const made = (await web.call('POST', '/api/capture/propose', { text: 'a note' })).json.proposal;
    await web.call('POST', `/api/capture/proposals/${made.id}/approve`);
    await service.close();
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
  }, 30_000);

  it('the limits come from the settings: two proposals an hour, one waiting at a time', async () => {
    const service = await start(tmp(), { proposalsPerHour: 2, maxPendingPerUser: 1 });
    const web = browser(service.port);
    await web.signIn('ann');
    const first = await web.call('POST', '/api/capture/propose', { text: 'first note' });
    expect(first.status).toBe(201);
    const second = await web.call('POST', '/api/capture/propose', { text: 'second note' });
    expect(second.status).toBe(429);
    expect(second.json.error.code).toBe('TOO_MANY_PENDING');
    await web.call('POST', `/api/capture/proposals/${first.json.proposal.id}/reject`);
    expect((await web.call('POST', '/api/capture/propose', { text: 'second note' })).status).toBe(201);
  }, 30_000);

  it('the hourly limit comes from the settings too: the third proposal in an hour is 429 THROTTLED', async () => {
    const service = await start(tmp(), { proposalsPerHour: 2, maxPendingPerUser: 10 });
    const web = browser(service.port);
    await web.signIn('ann');
    expect((await web.call('POST', '/api/capture/propose', { text: 'first note' })).status).toBe(201);
    expect((await web.call('POST', '/api/capture/propose', { text: 'second note' })).status).toBe(201);
    const third = await web.call('POST', '/api/capture/propose', { text: 'third note' });
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('THROTTLED');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 30_000);

  it('with secure cookies, a stale session on the capture and read routes is cleared with the Secure attribute too', async () => {
    const service = await start(tmp(), { cookieSecure: true });
    for (const [method, path] of [['POST', '/api/capture/propose'], ['GET', '/api/graph'], ['GET', '/api/capture/proposals/prop-x']] as const) {
      const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { cookie: `caci_session=${'A'.repeat(43)}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify({ text: 'x' }) } : {}) });
      expect(res.status, path).toBe(401);
      expect(res.headers.get('set-cookie'), path).toMatch(/Max-Age=0.*; Secure|Secure.*Max-Age=0/);
    }
  });

  it('two accounts are kept apart all the way through', async () => {
    const service = await start(tmp());
    const ann = browser(service.port);
    const bob = browser(service.port);
    await ann.signIn('ann');
    await bob.signIn('bob');
    const made = (await ann.call('POST', '/api/capture/propose', { text: 'ann only writes about gardening' })).json.proposal;
    expect((await bob.call('GET', `/api/capture/proposals/${made.id}`)).status).toBe(404);
    expect((await bob.call('POST', `/api/capture/proposals/${made.id}/approve`)).status).toBe(404);
    await ann.call('POST', `/api/capture/proposals/${made.id}/approve`);
    expect((await bob.call('GET', '/api/graph')).json.summary.itemCount).toBe(0);
    expect((await bob.call('GET', '/api/graph/categories')).json.items).toEqual([]);
    expect((await ann.call('GET', '/api/graph')).json.summary.itemCount).toBe(1);
  }, 30_000);
});

describe('the real model, through a stand-in provider (no network)', () => {
  it('the note and the category names go to the provider, the key goes only in its header, and the proposal comes back', async () => {
    const dir = tmp();
    const provider = fakeAnthropic();
    const service = await start(dir, { llm: 'anthropic' }, { apiKey: KEY, anthropic: { fetch: provider.fetch } });
    const web = browser(service.port);
    await web.signIn('ann');
    // a first note, so that a category exists; then a second whose request must show it
    const first = (await web.call('POST', '/api/capture/propose', { text: 'my very private first note about boats' })).json.proposal;
    expect(first.mode).toBe('anthropic');
    expect(first.summary.newCategories).toEqual(['provider-made']);
    await web.call('POST', `/api/capture/proposals/${first.id}/approve`);
    await web.call('POST', '/api/capture/propose', { text: 'a second private note about sailing' });
    expect(provider.seen).toHaveLength(2);
    const firstSent = JSON.stringify(provider.seen[0]?.body);
    const secondSent = JSON.stringify(provider.seen[1]?.body);
    expect(firstSent).toContain('my very private first note about boats');
    expect(secondSent).toContain('a second private note about sailing');
    expect(secondSent).toContain('provider-made'); // the existing category's name goes too
    expect(provider.seen[0]?.url).toMatch(/^https:\/\/api\.anthropic\.com\//);
    // the key: in the header, and nowhere else the provider can see
    expect(provider.seen[0]?.headers['x-api-key']).toBe(KEY);
    for (const sent of provider.seen) {
      expect(JSON.stringify(sent.body)).not.toContain(KEY);
      expect(sent.url).not.toContain(KEY);
      expect(Object.entries(sent.headers).filter(([name, value]) => value.includes(KEY) && name !== 'x-api-key')).toEqual([]);
    }
    await service.close();
    // and not in any file
    const bytes = Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
    expect(bytes.includes(Buffer.from(KEY))).toBe(false);
  }, 30_000);

  it('the model\'s failures reach the person as fixed messages, even when the provider\'s error repeats the key', async () => {
    const provider = fakeAnthropic((n) => {
      if (n === 1) return providerError(401, 'authentication_error', `invalid x-api-key: ${KEY}`);
      if (n === 2) return providerError(429, 'rate_limit_error', 'slow down', { 'retry-after': '9' });
      if (n === 3) return providerError(500, 'api_error', `internal: ${KEY} at /srv/provider/trace`);
      return undefined;
    });
    const service = await start(tmp(), { llm: 'anthropic', proposalsPerHour: 100 }, { apiKey: KEY, anthropic: { fetch: provider.fetch } });
    const web = browser(service.port);
    await web.signIn('ann');
    const rejected = await web.call('POST', '/api/capture/propose', { text: 'one' });
    const busy = await web.call('POST', '/api/capture/propose', { text: 'two' });
    const broken = await web.call('POST', '/api/capture/propose', { text: 'three' });
    expect([rejected.status, busy.status, broken.status]).toEqual([500, 503, 502]); // our own configuration problem (the provider refused the key), the provider is busy, the provider failed
    expect(busy.headers.get('retry-after')).toBe('9');
    for (const r of [rejected, busy, broken]) expect(JSON.stringify(r.json)).not.toMatch(/sk-ant|SECRET|\/srv\//);
    expect((await web.call('POST', '/api/capture/propose', { text: 'four' })).status).toBe(201); // and it recovers
  }, 30_000);

  it('a model client given by the caller is used as it is', async () => {
    const calls: string[] = [];
    const client: ModelClient = { complete: async (request) => (calls.push(request.model), { ok: false, error: llmError('REFUSED', 'no') }) };
    const service = await start(tmp(), {}, { llmClient: client });
    const web = browser(service.port);
    await web.signIn('ann');
    expect((await web.call('POST', '/api/capture/propose', { text: 'a note' })).status).toBe(502);
    expect(calls).toHaveLength(1);
  }, 30_000);
});

describe('starting the model', () => {
  it('the real model without its key stops the start, names the variable, and leaves nothing behind', async () => {
    const root = tmp();
    const dir = join(root, 'data');
    await expect(startService(config(dir, { llm: 'anthropic' }))).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(readdirSync(root)).toEqual([]); // not even the data folder
  });

  it('the demo model never loads the provider\'s SDK; the real one loads it only when asked for', async () => {
    vi.resetModules();
    vi.doMock('../llm/anthropic/index.js', () => {
      throw new Error('the provider SDK was loaded');
    });
    try {
      const fresh = await import('./service.js');
      const demo = await fresh.startService(config(tmp()));
      await demo.close();
      await expect(fresh.startService(config(tmp(), { llm: 'anthropic' }), { apiKey: KEY })).rejects.toThrow(); // loading it was attempted, and refused by the mock: it is loaded only on this path
    } finally {
      vi.doUnmock('../llm/anthropic/index.js');
      vi.resetModules();
    }
  });
});

describe('serve says which model is in use', () => {
  const sink = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => (out.push(t), everythingSeen.push(t)), stderr: (t: string) => (err.push(t), everythingSeen.push(t)) } };
  };

  it('the demo model: nothing leaves this machine', async () => {
    const { out, io } = sink();
    const r = await serve({ CACI_PORT: '0', CACI_DATA_DIR: tmp() }, io);
    if (r.code === 0) running.push(r.service);
    expect(out.join('')).toContain('Model: the free demo model. Nothing leaves this machine.');
    expect(out.join('')).not.toMatch(/Anthropic/);
  });

  it('the real model: says so, says what is sent, says nothing is anonymised, and never prints the key', async () => {
    const { out, err, io } = sink();
    const r = await serve({ CACI_PORT: '0', CACI_DATA_DIR: tmp(), CACI_LLM: 'anthropic', ANTHROPIC_API_KEY: KEY }, io);
    expect(r.code).toBe(0);
    if (r.code === 0) running.push(r.service);
    const text = out.join('');
    expect(text).toContain('Model: Anthropic (the real model).');
    expect(text).toMatch(/notes, and the names of their categories, are sent to Anthropic, and nothing is anonymised/);
    expect(text + err.join('')).not.toContain(KEY);
  });

  it('the real model with no key: exit code 2 naming the variable, nothing created', async () => {
    const root = tmp();
    const { err, io } = sink();
    expect(await serve({ CACI_PORT: '0', CACI_DATA_DIR: join(root, 'd'), CACI_LLM: 'anthropic' }, io)).toEqual({ code: 2 });
    expect(err.join('')).toContain('ANTHROPIC_API_KEY');
    expect(readdirSync(root)).toEqual([]);
  });
});
