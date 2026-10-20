import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { describeGraph, listGraphs } from '../graph_store/index.js';
import type { ServiceConfig } from './config.js';
import { defaultControlsDir } from './controls-files.js';
import { startService, type RunningService } from './service.js';

// Status updates as people use them (R-011): the real service on real SQLite files over real HTTP. root is the
// first account (the administrator); ann owns "Parent" and "In-law"; bob is a member of both; cat is an observer
// of Parent; dan is in nothing and keeps his own notes.

const PW = 'correct horse 7 staple';
const KEY = 'sk-ant-api03-STATUS-E2E-KEY-0123456789abcdef';
const dirs: string[] = [];
const running: RunningService[] = [];
const everything: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = everything.join('\n');
  expect(everything.length).toBeGreaterThan(40);
  for (const leak of [PW, KEY, 'scrypt$', 'passwordHash', 'user-u', 'circle-c', 'inputTokens', '<entries>']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
});

const config = (dataDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 100, maxPendingPerUser: 20, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, ...extra });

interface Reply { status: number; json: any; text: string; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
type Person = ReturnType<typeof person>;
function person(getPort: () => number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (!path.startsWith('/api/register') && !path.startsWith('/api/login')) everything.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text, headers: res.headers };
    },
    async signIn(name: string): Promise<string> {
      const r = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return r.json.user.id as string;
    },
  };
}

async function world(extra: Partial<ServiceConfig> = {}, options: Parameters<typeof startService>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caci-status-'));
  dirs.push(dir);
  const service = await startService(config(dir, extra), options);
  running.push(service);
  const get = () => service.port;
  const p = { root: person(get), ann: person(get), bob: person(get), cat: person(get), dan: person(get) };
  for (const [name, who] of Object.entries(p)) await who.signIn(name);
  const circle = async (owner: Person, name: string): Promise<string> => (await owner.call('POST', '/api/circles', { name })).json.circle.id as string;
  const accept = async (owner: Person, member: Person, id: string, username: string, role: string) => {
    await owner.call('POST', `/api/circles/${id}/invitations`, { username, role });
    const inv = (await member.call('GET', '/api/invitations')).json.items.find((i: { circle: { id: string } }) => i.circle.id === id).id as string;
    expect((await member.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  };
  const parent = await circle(p.ann, 'Parent');
  const inlaw = await circle(p.ann, 'In-law');
  await accept(p.ann, p.bob, parent, 'bob', 'member');
  await accept(p.ann, p.bob, inlaw, 'bob', 'member');
  await accept(p.ann, p.cat, parent, 'cat', 'observer');
  const capture = async (who: Person, text: string, circleId?: string) => {
    const made = await who.call('POST', '/api/capture/propose', { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
    expect(made.status, made.text).toBe(201);
    expect((await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
  };
  await capture(p.ann, 'Dentist appointment on Friday morning MARK-ANN');
  await capture(p.ann, 'Mum new tablets one a day with food MARK-PARENT', parent);
  await capture(p.bob, 'Hospital visit moved to Monday MARK-INLAW', inlaw);
  await capture(p.dan, 'Holiday plan in Spain MARK-DAN');
  return { dir, service, p, parent, inlaw, capture, get };
}
const ask = (who: Person, text = 'Give me a morning status check', extra: Record<string, unknown> = {}) => who.call('POST', '/api/status', { text, ...extra });
const sources = (r: Reply): string[] => r.json.status.points.flatMap((pt: { sources: Array<{ kind: string; circleName?: string }> }) => pt.sources.map((s) => (s.kind === 'personal' ? 'personal' : s.circleName)));

/** The shape of every graph in graphs.db, read through a second connection. */
async function shape(dir: string): Promise<Record<string, unknown>> {
  const adapter = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    const out: Record<string, unknown> = {};
    const listed = await listGraphs(adapter, { limit: 100 });
    for (const id of listed.ok ? listed.value.items : []) {
      const d = await describeGraph(adapter, id);
      out[id] = d.ok ? d.value : d.error;
    }
    return out;
  } finally {
    await adapter.close();
  }
}

describe('status updates over the real service, with the demo model', () => {
  it('uses the personal brain and every circle the person is in, and names each source', async () => {
    const w = await world();
    const r = await ask(w.p.ann, 'How is Mum doing with her tablets?', { timeZone: 'Europe/London' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.status.mode).toBe('demo');
    expect(r.json.status.entriesUsed).toBe(3);
    const text = JSON.stringify(r.json.status.points);
    for (const m of ['MARK-ANN', 'MARK-PARENT', 'MARK-INLAW']) expect(text).toContain(m);
    expect(sources(r).sort()).toEqual(['In-law', 'Parent', 'personal']);
    expect(r.json.status.points[0].text).toContain('MARK-PARENT');
  });

  it('an observer can ask and reads the same context as a member of that circle; a stranger and another circle never appear', async () => {
    const w = await world();
    const cat = await ask(w.p.cat);
    expect(cat.json.status.entriesUsed).toBe(1);
    expect(sources(cat)).toEqual(['Parent']);
    expect(cat.text).toContain('MARK-PARENT');
    for (const m of ['MARK-ANN', 'MARK-INLAW', 'MARK-DAN']) expect(cat.text).not.toContain(m);
    const bob = await ask(w.p.bob);
    expect(bob.text).toContain('MARK-PARENT');
    expect(bob.text).toContain('MARK-INLAW');
    expect(bob.text).not.toContain('MARK-DAN');
    const dan = await ask(w.p.dan);
    expect(dan.json.status.entriesUsed).toBe(1);
    for (const m of ['MARK-ANN', 'MARK-PARENT', 'MARK-INLAW']) expect(dan.text).not.toContain(m);
    // the administrator has no special reading rights: their own brain is empty and so is their answer
    const root = await ask(w.p.root);
    expect(root.json.status.nothing).toBe(true);
    expect(root.json.status.entriesUsed).toBe(0);
  });

  it('a member removed from a circle gets an answer without that circle on the next request', async () => {
    const w = await world();
    expect((await ask(w.p.bob)).text).toContain('MARK-PARENT');
    const ids = (await w.p.ann.call('GET', `/api/circles/${w.parent}/members`)).json.items as Array<{ userId: string; username: string }>;
    const bobId = ids.find((m) => m.username === 'bob')?.userId;
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.parent}/members/${bobId}`)).status).toBe(204);
    const after = await ask(w.p.bob);
    expect(after.status).toBe(200);
    expect(after.text).not.toContain('MARK-PARENT');
    expect(after.text).toContain('MARK-INLAW');
  });

  it('writes nothing: every graph is exactly as it was after any number of status requests, and no proposal is held', async () => {
    const w = await world();
    const before = await shape(w.dir);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(5);
    for (const who of [w.p.ann, w.p.bob, w.p.cat, w.p.dan, w.p.ann, w.p.bob]) expect((await ask(who)).status).toBe(200);
    expect(await shape(w.dir)).toEqual(before);
    const categories = (await w.p.ann.call('GET', '/api/graph/categories')).json.items;
    expect(JSON.stringify(categories)).not.toContain('status');
  });

  it('refuses bad input with the field named, needs a session, and has the same cross-origin and form rules as the other writes', async () => {
    const w = await world();
    expect((await ask(w.p.ann, '')).json.error.field).toBe('text');
    expect((await ask(w.p.ann, 'x', { timeZone: 'Mars/Base' })).json.error.field).toBe('timeZone');
    expect((await ask(w.p.ann, 'x', { scope: 'mine' })).json.error.field).toBe('scope');
    expect((await person(w.get).call('POST', '/api/status', { text: 'x' })).status).toBe(401);
    expect((await w.p.ann.call('GET', '/api/status')).status).toBe(405);
    const form = await fetch(`http://127.0.0.1:${w.service.port}/api/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=x' });
    expect(form.status).toBe(415);
    const cross = await fetch(`http://127.0.0.1:${w.service.port}/api/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"text":"x"}' });
    expect(cross.status).toBe(403);
  });

  it('the hourly limit comes from CACI_STATUS_PER_HOUR and is per account', async () => {
    const w = await world({ statusPerHour: 2 });
    expect((await ask(w.p.ann)).status).toBe(200);
    expect((await ask(w.p.ann)).status).toBe(200);
    const third = await ask(w.p.ann);
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('THROTTLED');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await ask(w.p.bob)).status).toBe(200);
  });

  it('a stale cookie on the status route is cleared with the Secure flag when the service uses secure cookies', async () => {
    const w = await world({ cookieSecure: true, allowInsecure: true });
    const res = await fetch(`http://127.0.0.1:${w.service.port}/api/status`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `caci_session=${'A'.repeat(43)}` }, body: '{"text":"x"}' });
    expect(res.status).toBe(401);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain('Max-Age=0');
    expect(set).toContain('Secure');
  });

  it('a restart keeps the notes that feed a status and the sessions', async () => {
    const w = await world();
    const dir = w.dir;
    await w.service.close();
    running.splice(0);
    const again = await startService(config(dir));
    running.push(again);
    const get = () => again.port;
    const ann = person(get);
    expect((await ann.call('POST', '/api/login', { username: 'ann', password: PW })).status).toBe(200);
    const r = await ask(ann);
    expect(r.json.status.entriesUsed).toBe(3);
    await again.close();
    running.splice(0);
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
  });
});

describe('status updates with the real model, through a stand-in provider (no network)', () => {
  function provider(delayMs = 0) {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> & { system?: string; messages?: Array<{ content: unknown }> } }> = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = JSON.parse(String(init?.body)) as (typeof seen)[number]['body'];
      seen.push({ headers, body });
      const system = body.system ?? '';
      if (delayMs > 0 && system.startsWith('You are the status assistant')) await new Promise((r) => setTimeout(r, delayMs));
      const reply = system.startsWith('You are the status assistant')
        ? { headline: 'A quiet morning.', points: [{ text: 'Mum has new tablets.', refs: [1] }], nothing: false }
        : (() => {
            const itemId = /the first fact is "([^"]+)"/.exec(system)?.[1] as string;
            const content = body.messages?.[0]?.content;
            const note = /<note>\n([\s\S]*?)\n<\/note>/.exec(typeof content === 'string' ? content : '')?.[1] ?? 'note';
            return { ops: [{ op: 'upsertNode', partition: 'item', id: itemId, data: { title: note.slice(0, 100), summary: 'by the stand-in' } }, { op: 'upsertNode', partition: 'category', id: 'provider-made', data: { name: 'Provider made' } }, { op: 'link', item: itemId, category: 'provider-made', weight: 0.7 }], rationale: 'stand-in' };
          })();
      const message = { id: 'msg_x', type: 'message', role: 'assistant', model: String(body.model), content: [{ type: 'text', text: JSON.stringify(reply), citations: null }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null } };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch: fetchFn, seen };
  }

  it('the request holds only what the person may read, the answer maps the numbers to the circle, and the key goes only in the header', async () => {
    const p = provider();
    const w = await world({ llm: 'anthropic' }, { apiKey: KEY, anthropic: { fetch: p.fetch } });
    const before = p.seen.length;
    const r = await ask(w.p.cat, 'Give me a morning status check');
    expect(r.status, r.text).toBe(200);
    expect(r.json.status.mode).toBe('anthropic');
    expect(r.json.status.headline).toBe('A quiet morning.');
    expect(sources(r)).toEqual(['Parent']); // the server, not the model, says where entry 1 came from
    const statusRequests = p.seen.slice(before);
    expect(statusRequests).toHaveLength(1);
    const sent = JSON.stringify(statusRequests[0]?.body);
    expect(sent).toContain('MARK-PARENT');
    for (const m of ['MARK-ANN', 'MARK-INLAW', 'MARK-DAN']) expect(sent, m).not.toContain(m);
    expect(statusRequests[0]?.headers['x-api-key']).toBe(KEY);
    for (const s of p.seen) {
      expect(JSON.stringify(s.body)).not.toContain(KEY);
      expect(Object.entries(s.headers).filter(([name, value]) => value.includes(KEY) && name !== 'x-api-key')).toEqual([]);
    }
    await w.service.close();
    running.splice(0);
    const bytes = Buffer.concat(readdirSync(w.dir).map((name) => readFileSync(join(w.dir, name))));
    expect(bytes.includes(Buffer.from(KEY))).toBe(false);
  }, 30_000);

  it('one at a time per account: a second request while one is being made is a 429 THROTTLED, and the first still answers', async () => {
    const p = provider(300);
    const w = await world({ llm: 'anthropic' }, { apiKey: KEY, anthropic: { fetch: p.fetch } });
    const [a, b] = await Promise.all([ask(w.p.ann), ask(w.p.ann)]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const refused = a.status === 429 ? a : b;
    expect(refused.json.error.code).toBe('THROTTLED');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await ask(w.p.ann)).status).toBe(200); // and it is free again afterwards
    expect(p.seen.filter((s) => (s.body.system ?? '').startsWith('You are the status assistant'))).toHaveLength(2);
  }, 30_000);

  it('a provider failure reaches the person as fixed words even when its error repeats the key', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { system?: string };
      if ((body.system ?? '').startsWith('You are the status assistant')) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `boom ${KEY}` } }), { status: 500, headers: { 'content-type': 'application/json' } });
      return provider().fetch(_input, init);
    };
    const w = await world({ llm: 'anthropic' }, { apiKey: KEY, anthropic: { fetch: fetchFn } });
    const r = await ask(w.p.ann);
    expect(r.status).toBe(502);
    expect(r.json.error.message).toBe('the model could not make your status: try again');
    expect(r.text).not.toContain(KEY);
  }, 30_000);
});

describe('a circle\'s pulse over HTTP (R-016 D19 to D21)', () => {
  const PULSE = 'Provide a status update for the circle. Keep the answer factual, stick to the point and be concise.';
  const pulse = (who: Person, circleId: string, extra: Record<string, unknown> = {}) => who.call('POST', '/api/status', { pulse: true, scope: { kind: 'circle', circleId }, ...extra });

  it('a member and an observer get a pulse of that circle only; a stranger and a made-up circle get the same 404; the pulse is not filed', async () => {
    const w = await world();
    const before = await shape(w.dir);
    for (const who of [w.p.bob, w.p.cat, w.p.ann]) {
      const r = await pulse(who, w.parent);
      expect(r.status, r.text).toBe(200);
      expect(r.json.status.entriesUsed).toBe(1);
      expect(sources(r)).toEqual(['Parent']);
      expect(r.text).not.toMatch(/MARK-ANN|MARK-INLAW|MARK-DAN/);
    }
    const stranger = await pulse(w.p.dan, w.parent);
    const made = await pulse(w.p.dan, 'c0000000000000999');
    const rootAdmin = await pulse(w.p.root, w.parent);
    for (const r of [stranger, made, rootAdmin]) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such circle' } });
    }
    expect(await shape(w.dir)).toEqual(before);
  });

  it('is refused by name with text, with no circle, with a personal scope or with a value that is not a boolean', async () => {
    const w = await world();
    const bad = async (body: Record<string, unknown>, field: string) => {
      const r = await w.p.ann.call('POST', '/api/status', body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error.field).toBe(field);
    };
    await bad({ pulse: true, text: 'my own words', scope: { kind: 'circle', circleId: w.parent } }, 'text');
    await bad({ pulse: true }, 'scope');
    await bad({ pulse: true, scope: { kind: 'personal' } }, 'scope');
    await bad({ pulse: 'true', scope: { kind: 'circle', circleId: w.parent } }, 'pulse');
  });

  it('an edited pulse file is what the provider is asked, and the browser never sends the words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-pulse-controls-'));
    dirs.push(dir);
    cpSync(defaultControlsDir(), dir, { recursive: true });
    writeFileSync(join(dir, 'pulse.txt'), 'EDITED-PULSE-WORDS: how is the circle?\n');
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { system?: string; messages: Array<{ content: string }>; model: string };
      seen.push(`${body.system}\n${body.messages.map((m) => m.content).join('\n')}`);
      const system = body.system ?? '';
      const reply = system.startsWith('You are the status assistant')
        ? { headline: 'Quiet.', points: [], nothing: true }
        : { ops: [{ op: 'upsertNode', partition: 'item', id: /the first fact is "([^"]+)"/.exec(system)?.[1] ?? '', data: { title: 't', summary: 's' } }, { op: 'upsertNode', partition: 'category', id: 'misc', data: { name: 'Misc' } }, { op: 'link', item: /the first fact is "([^"]+)"/.exec(system)?.[1] ?? '', category: 'misc', weight: 0.5 }] };
      const message = { id: 'm', type: 'message', role: 'assistant', model: String(body.model), content: [{ type: 'text', text: JSON.stringify(reply), citations: null }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null } };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const w = await world({ llm: 'anthropic' }, { apiKey: KEY, anthropic: { fetch: fetchFn }, controlsDir: dir });
    seen.length = 0;
    const r = await pulse(w.p.ann, w.parent);
    expect(r.status, r.text).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('<request>\nEDITED-PULSE-WORDS: how is the circle?\n</request>');
    expect(seen[0]).not.toContain(PULSE);
  }, 30_000);

  it('a bad pulse file stops the start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-pulse-bad-'));
    dirs.push(dir);
    cpSync(defaultControlsDir(), dir, { recursive: true });
    writeFileSync(join(dir, 'pulse.txt'), '');
    await expect(startService(config(join(dir, 'data')), { controlsDir: dir })).rejects.toThrow(/pulse text .* is not valid[\s\S]*pulse\.txt: is empty/);
  });
});
