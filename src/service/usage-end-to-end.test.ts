import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { err } from '../graph_store/index.js';
import { createDemoModelClient, llmError, type ModelClient } from '../llm/index.js';
import { openDb } from '../sqlite/db.js';
import { createSqliteUsageStore } from '../usage/sqlite/index.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';
import { usageCommand } from './usage-command.js';

vi.setConfig({ testTimeout: 60_000 }); // each test starts a service and makes several accounts, which is slow when the whole gate runs at once

// Usage metering (R-024) as it happens: the real service on real SQLite files over real HTTP with the demo model. ann owns the circle
// "Club"; bob is a member; cat is an observer. A counting wrapper around the model client keeps the provider's own token counts, so the
// report can be checked against them (UM-NFR-03).

const PW = 'correct horse 7 staple';
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Tally { calls: number; input: number; output: number }
/** The demo model, counting every answer it gives (the provider's own figures), and failing on demand. */
function provider() {
  const inner = createDemoModelClient();
  const tally: Tally = { calls: 0, input: 0, output: 0 };
  const control = { failNext: false };
  const client: ModelClient = {
    complete: async (request) => {
      if (control.failNext) {
        control.failNext = false;
        return err(llmError('TIMEOUT', 'the provider did not answer'));
      }
      const r = await inner.complete(request);
      if (r.ok) {
        tally.calls++;
        tally.input += r.value.usage.inputTokens;
        tally.output += r.value.usage.outputTokens;
      }
      return r;
    },
  };
  return { client, tally, control };
}

interface Reply { status: number; json: any; text: string } // eslint-disable-line @typescript-eslint/no-explicit-any
function person(getPort: () => number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    },
    async signIn(name: string): Promise<string> {
      const r = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return r.json.user.id as string;
    },
  };
}

async function world(options: { usageDays?: number; agentAccess?: boolean; clock?: () => number; onWarning?: (m: string) => void; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'caci-usage-e2e-'));
  if (options.dir === undefined) dirs.push(dir);
  const p = provider();
  const service = await startService({ ...baseConfig(dir), proposalsPerHour: 100, usageDays: options.usageDays ?? 400, agentAccess: options.agentAccess ?? false }, { llmClient: p.client, clock: options.clock ?? (() => NOW), ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }) });
  running.push(service);
  const get = () => service.port;
  const people = { root: person(get), ann: person(get), bob: person(get), cat: person(get) };
  const ids: Record<string, string> = {};
  for (const [name, who] of Object.entries(people)) ids[name] = await who.signIn(name);
  return { dir, service, p, people, ids };
}
type World = Awaited<ReturnType<typeof world>>;

async function club(w: World): Promise<string> {
  const { ann, bob, cat } = w.people;
  const id = (await ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const [member, name, role] of [[bob, 'bob', 'member'], [cat, 'cat', 'observer']] as const) {
    await ann.call('POST', `/api/circles/${id}/invitations`, { username: name, role });
    const inv = (await member.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await member.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  }
  return id;
}
const file = (w: World): string => join(w.dir, 'users.db');
const sums = async (w: World) => {
  const store = createSqliteUsageStore({ path: file(w) });
  try {
    const rows = await store.aggregate({ from: 0, to: Date.UTC(2100, 0, 1) });
    return { rows, attempts: rows.reduce((n, r) => n + r.attempts, 0), input: rows.reduce((n, r) => n + r.inputTokens, 0), output: rows.reduce((n, r) => n + r.outputTokens, 0) };
  } finally {
    store.close();
  }
};
const note = (who: ReturnType<typeof person>, text: string, circleId?: string) => who.call('POST', '/api/capture/propose', { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });

describe('usage metering through the real service', () => {
  it('records what each person did, charged to the asker, and the totals equal the provider\'s own counts', async () => {
    const w = await world();
    const circle = await club(w);
    const { ann, bob } = w.people;
    expect((await note(ann, 'Mum takes 2 tablets daily after breakfast')).status).toBe(201);
    expect((await note(bob, 'Hospital visit moved to Monday', circle)).status).toBe(201);
    expect((await ann.call('POST', '/api/status', { text: 'Give me a morning status check' })).status).toBe(200);
    expect((await ann.call('POST', '/api/status', { check: 'pulse' })).status).toBe(200);
    expect((await bob.call('POST', '/api/status', { check: 'coming-up', scope: { kind: 'circle', circleId: circle } })).status).toBe(200);
    const s = await sums(w);
    expect(w.p.tally.calls).toBe(5);
    expect(s.attempts).toBe(5);
    expect(s.input).toBe(w.p.tally.input);
    expect(s.output).toBe(w.p.tally.output);
    const view = s.rows.map((r) => [r.userId === w.ids.ann ? 'ann' : r.userId === w.ids.bob ? 'bob' : '?', r.capability, r.scope.kind]).sort().map((x) => x.join(':'));
    expect(view).toEqual(['ann:categorise:personal', 'ann:check:personal', 'ann:status:personal', 'bob:categorise:circle', 'bob:check:circle'].sort());
  });

  it('a refusal before a model is asked records nothing: an observer, a stranger\'s circle, a bad request', async () => {
    const w = await world();
    const circle = await club(w);
    const { cat, ann } = w.people;
    expect((await note(cat, 'an observer cannot file', circle)).status).toBe(404);
    expect((await note(ann, 'x', 'c9999999999999999')).status).toBe(404);
    expect((await ann.call('POST', '/api/status', { text: '' })).status).toBe(422);
    expect((await cat.call('POST', '/api/status', { text: 'hello', scope: { kind: 'circle', circleId: 'c9999999999999999' } })).status).toBe(404);
    expect((await sums(w)).attempts).toBe(0);
    expect(w.p.tally.calls).toBe(0);
  });

  it('a call whose model fails is one record with the error kind, and the person gets the usual model error', async () => {
    const w = await world();
    w.p.control.failNext = true;
    const r = await note(w.people.ann, 'Dentist on Friday at 9');
    expect(r.status).toBe(502);
    const s = await sums(w);
    expect(s.attempts).toBe(1);
    expect(s.rows[0]).toMatchObject({ failed: 1, inputTokens: 0, capability: 'categorise' });
  });

  it('the report command shows the same people and figures from the same files', async () => {
    const w = await world();
    const circle = await club(w);
    await note(w.people.ann, 'Mum takes 2 tablets daily after breakfast');
    await note(w.people.bob, 'Hospital visit moved to Monday', circle);
    await w.people.bob.call('POST', '/api/status', { text: 'What is on?' });
    const out: string[] = [];
    const prices = join(w.dir, '..', `prices-${Date.now()}.json`);
    writeFileSync(prices, JSON.stringify({ asOf: '2026-11-12', currency: 'USD', note: '', models: { demo: { input: 1, output: 1 } } }));
    dirs.push(prices);
    const code = await usageCommand(['--month', '2026-11', '--prices', prices, '--data-dir', w.dir], {}, { stdout: (t) => void out.push(t), stderr: () => undefined, now: () => NOW });
    expect(code).toBe(0);
    const text = out.join('');
    const s = await sums(w);
    expect(text).toMatch(/ann\s+1\s+1/);
    expect(text).toMatch(/bob\s+2\s+2/);
    expect(text).toContain((s.input + s.output) / 1_000_000 > 0 ? ((s.input + s.output) / 1_000_000).toFixed(4) : '0.0000');
    expect(text).not.toContain('Models with no price');
  });

  it('keeps the records across a restart and drops the person from them when the account is deleted', async () => {
    const w = await world();
    await note(w.people.ann, 'Dentist on Friday at 9');
    await note(w.people.bob, 'Mum takes tablets');
    await w.service.close();
    running.splice(0);
    const restarted = await startService({ ...baseConfig(w.dir), allowRegistration: false }, { clock: () => NOW });
    running.push(restarted);
    expect((await sums(w)).attempts).toBe(2);
    const ann = person(() => restarted.port);
    expect((await ann.call('POST', '/api/login', { username: 'ann', password: PW })).status).toBe(200);
    expect((await ann.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    const s = await sums(w);
    expect(s.attempts).toBe(2);
    expect(s.rows.map((r) => r.userId === null ? 'gone' : 'bob').sort()).toEqual(['bob', 'gone']);
  });

  it('removes records older than CACI_USAGE_DAYS at start-up', async () => {
    const w = await world({ usageDays: 3 });
    await note(w.people.ann, 'Dentist on Friday at 9');
    expect((await sums(w)).attempts).toBe(1);
    await w.service.close();
    running.splice(0);
    const later = await startService({ ...baseConfig(w.dir), usageDays: 3, allowRegistration: false }, { clock: () => NOW + 2 * 86_400_000 });
    running.push(later);
    expect((await sums(w)).attempts).toBe(1); // two days: kept
    await later.close();
    running.splice(0);
    const muchLater = await startService({ ...baseConfig(w.dir), usageDays: 3, allowRegistration: false }, { clock: () => NOW + 4 * 86_400_000 });
    running.push(muchLater);
    expect((await sums(w)).attempts).toBe(0); // four days: gone
  });

  it('an agent\'s pulse is recorded as an agent-check charged to the token\'s person', async () => {
    const w = await world({ agentAccess: true });
    const made = await w.people.ann.call('POST', '/api/me/agent-tokens', { name: 'helper', scopes: ['personal'], checks: true, days: 30 });
    expect(made.status).toBe(201);
    const rpc = async (method: string, params: unknown) => (await fetch(`http://127.0.0.1:${w.service.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.json.token as string}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as Promise<{ error?: unknown; result?: unknown }>;
    expect((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).error).toBeUndefined();
    const called = await rpc('tools/call', { name: 'pulse', arguments: { check: 'pulse' } });
    expect(called.error).toBeUndefined();
    const s = await sums(w);
    expect(s.rows.map((r) => [r.userId === w.ids.ann ? 'ann' : '?', r.capability, r.scope.kind, r.attempts])).toEqual([['ann', 'agent-check', 'personal', 1]]);
    expect(s.input).toBe(w.p.tally.input);
  });

  it('a clean stop leaves exactly the two database files', async () => {
    const w = await world();
    await note(w.people.ann, 'Dentist on Friday at 9');
    await w.service.close();
    running.splice(0);
    expect(readdirSync(w.dir).sort()).toEqual(['graphs.db', 'users.db']);
  });

  it('holds no text: a record has only its fixed columns and none of the words used', async () => {
    const w = await world();
    await note(w.people.ann, 'Secret dentist appointment for Zebediah on Friday');
    const db = openDb({ path: file(w) });
    try {
      const rows = db.all<Record<string, unknown>>('SELECT * FROM usage');
      expect(rows).toHaveLength(1);
      const json = JSON.stringify(rows);
      for (const word of ['Secret', 'dentist', 'Zebediah', 'Friday', 'ann']) expect(json).not.toContain(word);
    } finally {
      db.close();
    }
  });

  it('a broken usage table never fails a call, and the operator is warned once in fixed words', async () => {
    const warnings: string[] = [];
    const w = await world({ onWarning: (m) => void warnings.push(m) });
    const db = openDb({ path: file(w) });
    db.exec('DROP TABLE usage');
    db.close();
    const r = await note(w.people.ann, 'Dentist on Friday at 9');
    expect(r.status).toBe(201);
    expect((await w.people.ann.call('POST', `/api/capture/proposals/${r.json.proposal.id}/approve`)).status).toBe(200);
    expect(warnings).toEqual(['usage records could not be saved']);
    expect((await w.people.ann.call('GET', '/api/graph')).json.summary.itemCount).toBe(1); // the note itself was filed
  });
});
