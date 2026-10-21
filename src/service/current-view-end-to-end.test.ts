import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../sqlite/db.js';
import { createSqliteLedgerStore } from '../ledger/sqlite/index.js';
import { defaultControlsDir } from './controls-files.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService, type ServiceOptions } from './service.js';

// The current-view brain as people use it (R-014): the real service on real SQLite files over real HTTP, with the demo model.
// root is the first account (the administrator); ann owns a circle; bob is a member; cat an observer; dan is a stranger.

const PW = 'correct horse 7 staple';
const OLD = 'Mum takes 2 x Tablet A a day for her blood pressure.';
const CHANGE = 'Mum now takes tablet day blood morning.';
const dirs: string[] = [];
const running: RunningService[] = [];
const seen: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = seen.join('\n');
  expect(seen.length).toBeGreaterThan(25);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'user-u', 'circle-c', 'prop-', 'proposalId']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 100, maxPendingPerUser: 20, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90 });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}
type Person = ReturnType<typeof person>;
function person(getPort: () => number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (path.startsWith('/api/ledger') || path.startsWith('/api/brain') || path.startsWith('/api/graph') || path.startsWith('/api/status')) seen.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    },
    async signIn(name: string): Promise<string> {
      const r = await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return r.json.user.id as string;
    },
    async signInAgain(name: string): Promise<void> {
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}

async function start(dir: string, extra: Partial<ServiceConfig> = {}, options: ServiceOptions = {}) {
  const service = await startService({ ...config(dir), ...extra }, options);
  running.push(service);
  return service;
}
async function world(extra: Partial<ServiceConfig> = {}, options: ServiceOptions = {}, dirOverride?: string) {
  const dir = dirOverride ?? mkdtempSync(join(tmpdir(), 'caci-current-view-'));
  if (dirOverride === undefined) dirs.push(dir);
  const service = await start(dir, extra, options);
  const port = { value: service.port };
  const get = () => port.value;
  const p = { root: person(get), ann: person(get), bob: person(get), cat: person(get), dan: person(get) };
  const ids: Record<string, string> = {};
  for (const [name, who] of Object.entries(p)) ids[name] = await who.signIn(name);
  const circleId = (await p.ann.call('POST', '/api/circles', { name: 'Parent' })).json.circle.id as string;
  for (const [member, role] of [['bob', 'member'], ['cat', 'observer']] as const) {
    await p.ann.call('POST', `/api/circles/${circleId}/invitations`, { username: member, role });
    const inv = (await p[member].call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await p[member].call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  }
  const capture = async (who: Person, text: string, scope?: unknown) => {
    const made = await who.call('POST', '/api/capture/propose', { text, ...(scope === undefined ? {} : { scope }) });
    expect(made.status, made.text).toBe(201);
    const done = await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`);
    expect(done.status, done.text).toBe(200);
    return { proposal: made.json.proposal, written: done.json.written };
  };
  const circle = { kind: 'circle', circleId };
  return { dir, service, port, p, ids, circleId, circle, capture };
}
const notes = async (who: Person, scope = 'personal'): Promise<string[]> => {
  const cats = (await who.call('GET', `/api/brain/categories?scope=${scope}&limit=100`)).json.items as Array<{ id: string }>;
  const out: string[] = [];
  for (const c of cats) for (const i of (await who.call('GET', `/api/brain/category?scope=${scope}&id=${encodeURIComponent(c.id)}`)).json.items) out.push(i.data.summary as string);
  return [...new Set(out)].sort();
};
const NO_CIRCLE = { code: 'NOT_FOUND', message: 'no such circle' };

describe('in a personal brain', () => {
  it('the new dose replaces the old: browse and status no longer show the old dose, and the change log shows what happened', async () => {
    const w = await world();
    await w.capture(w.p.ann, OLD);
    expect(await notes(w.p.ann)).toEqual([expect.stringContaining('2 x Tablet A')]);
    const { proposal, written } = await w.capture(w.p.ann, CHANGE);
    expect(proposal.summary.removed).toHaveLength(1);
    expect(proposal.text).toContain('this note replaces, and these will be removed when you approve:'.replace('this', 'This'));
    expect(written.tidied).toEqual([{ id: 'pressure', name: 'Pressure' }]);
    const after = await notes(w.p.ann);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('tablet day blood morning');
    expect(JSON.stringify(after)).not.toContain('2 x Tablet A');
    expect((await w.p.ann.call('GET', '/api/graph')).json.summary).toMatchObject({ itemCount: 1, categoryCount: 1 });
    const status = await w.p.ann.call('POST', '/api/status', { text: 'what tablets does Mum take?' });
    expect(status.status).toBe(200);
    expect(status.text).not.toContain('2 x Tablet A');
    expect(status.json.status.entriesUsed).toBe(1);

    const log = await w.p.ann.call('GET', '/api/ledger');
    expect(log.status).toBe(200);
    const rows = log.json.items as Array<{ action: string; kind: string; summary?: string; by?: { username: string } }>;
    expect(rows.map((r) => `${r.action} ${r.kind}`)).toEqual(['added item', 'added category', 'removed item', 'removed category', 'added input', 'added item', 'added category', 'added input']);
    // the words typed for each update are kept beside the facts they made (R-017)
    expect(rows.filter((r) => r.kind === 'input').map((r) => (r as { text?: string }).text)).toEqual([expect.stringContaining('Mum now takes tablet day blood morning'), expect.stringContaining('2 x Tablet A')]);
    expect(rows[2]?.summary).toContain('2 x Tablet A');
    expect(rows.every((r) => r.by?.username === 'ann')).toBe(true);
  });

  it('a note that only adds replaces nothing and records only additions', async () => {
    const w = await world();
    await w.capture(w.p.ann, OLD);
    const { proposal } = await w.capture(w.p.ann, 'Hospital appointment on Tuesday morning here.');
    expect(proposal.summary.removed).toEqual([]);
    expect(await notes(w.p.ann)).toHaveLength(2);
    expect((await w.p.ann.call('GET', '/api/ledger')).json.items.every((r: { action: string }) => r.action === 'added')).toBe(true);
  });

  it('nobody else\'s notes are touched, shown, or logged: the same words in another person\'s brain stay', async () => {
    const w = await world();
    await w.capture(w.p.dan, OLD);
    await w.capture(w.p.ann, OLD);
    await w.capture(w.p.ann, CHANGE);
    expect(await notes(w.p.dan)).toEqual([expect.stringContaining('2 x Tablet A')]);
    const danLog = (await w.p.dan.call('GET', '/api/ledger')).json.items as Array<{ action: string }>;
    expect(danLog.map((r) => r.action)).toEqual(['added', 'added', 'added']);
  });

  it('a restart keeps the new state and the log', async () => {
    const w = await world();
    await w.capture(w.p.ann, OLD);
    await w.capture(w.p.ann, CHANGE);
    const before = (await w.p.ann.call('GET', '/api/ledger')).json;
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    const again = await start(w.dir);
    w.port.value = again.port;
    await w.p.ann.signInAgain('ann');
    expect((await w.p.ann.call('GET', '/api/ledger')).json).toEqual(before);
    expect(await notes(w.p.ann)).toHaveLength(1);
  });

  it('an account deleted takes its personal log with it; a circle deleted takes its log', async () => {
    const w = await world();
    await w.capture(w.p.bob, OLD);
    await w.capture(w.p.bob, OLD, w.circle);
    const store = createSqliteLedgerStore({ path: join(w.dir, 'users.db') });
    const rows = async (scope: Parameters<typeof store.list>[0]) => (await store.list(scope, { limit: 100, cursor: null })).items.length;
    const bobId = w.ids.bob as string;
    expect(await rows({ kind: 'personal', userId: bobId })).toBe(3); // the note, its category and the words typed
    expect(await rows({ kind: 'circle', circleId: w.circleId })).toBe(3);
    expect((await w.p.bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(await rows({ kind: 'personal', userId: bobId })).toBe(0);
    expect(await rows({ kind: 'circle', circleId: w.circleId })).toBe(3); // what bob added to the circle stays in its log
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.circleId}`)).status).toBe(204);
    expect(await rows({ kind: 'circle', circleId: w.circleId })).toBe(0);
    store.close();
  });
});

describe('in a circle', () => {
  it('a member replaces another member\'s note; everyone who can read the circle sees the log; an observer cannot capture; strangers and the administrator get the made-up-circle answer', async () => {
    const w = await world();
    await w.capture(w.p.ann, OLD, w.circle);
    const { proposal } = await w.capture(w.p.bob, CHANGE, w.circle);
    expect(proposal.summary.removed).toHaveLength(1);
    expect(await notes(w.p.ann, `circle:${w.circleId}`)).toHaveLength(1);
    const asAnn = (await w.p.ann.call('GET', `/api/ledger?scope=circle:${w.circleId}`)).json;
    expect(asAnn.scope).toEqual({ kind: 'circle', circleId: w.circleId, circleName: 'Parent' });
    expect(asAnn.items.filter((r: { action: string }) => r.action === 'removed')).toHaveLength(2);
    expect(asAnn.items[0].by.username).toBe('bob');
    expect((await w.p.bob.call('GET', `/api/ledger?scope=circle:${w.circleId}`)).json).toEqual(asAnn);
    expect((await w.p.cat.call('GET', `/api/ledger?scope=circle:${w.circleId}`)).json).toEqual(asAnn);
    const observer = await w.p.cat.call('POST', '/api/capture/propose', { text: CHANGE, scope: w.circle });
    expect(observer.status).toBe(404);
    expect(observer.json.error).toEqual(NO_CIRCLE);
    const strangers = [await w.p.dan.call('GET', `/api/ledger?scope=circle:${w.circleId}`), await w.p.root.call('GET', `/api/ledger?scope=circle:${w.circleId}`), await w.p.dan.call('GET', '/api/ledger?scope=circle:c9999999999999999')];
    for (const r of strangers) {
      expect(r.status).toBe(404);
      expect(r.json.error).toEqual(NO_CIRCLE);
    }
    expect(new Set(strangers.map((r) => r.text)).size).toBe(1);
    // the personal logs of the people involved hold none of it
    for (const who of [w.p.ann, w.p.bob, w.p.cat]) expect((await who.call('GET', '/api/ledger')).json.items).toEqual([]);
  });
});

describe('the settings and the off switch', () => {
  it('the log is kept for CACI_LEDGER_DAYS: older entries are removed at start-up, newer ones stay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-current-view-'));
    dirs.push(dir);
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 5, 1);
    const clock = { value: t0 };
    const w = await world({ ledgerDays: 3 }, { clock: () => clock.value }, dir);
    await w.capture(w.p.ann, OLD);
    clock.value += 2 * day;
    await w.capture(w.p.ann, 'Dentist appointment on Friday at the surgery today.');
    expect((await w.p.ann.call('GET', '/api/ledger?limit=100')).json.items).toHaveLength(6);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    clock.value = t0 + 3 * day + 1000; // the first note is now older than 3 days, the second is not
    const again = await start(dir, { ledgerDays: 3 }, { clock: () => clock.value });
    w.port.value = again.port;
    await w.p.ann.signInAgain('ann');
    const rest = (await w.p.ann.call('GET', '/api/ledger?limit=100')).json.items as Array<{ title?: string }>;
    expect(rest).toHaveLength(3);
    expect(rest.filter((r) => (r as { kind?: string }).kind !== 'input').every((r) => r.title !== undefined)).toBe(true);
    expect(JSON.stringify(rest)).not.toContain('2 x Tablet A');
  });

  it('with replacing switched off in the controls (maxReplaces 0) every note is only added and the preview says nothing about removing', async () => {
    const controls = mkdtempSync(join(tmpdir(), 'caci-controls-'));
    dirs.push(controls);
    cpSync(defaultControlsDir(), controls, { recursive: true });
    const file = join(controls, 'categorise', 'settings.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"maxReplaces": 5', '"maxReplaces": 0'));
    const w = await world({}, { controlsDir: controls });
    await w.capture(w.p.ann, OLD);
    const { proposal } = await w.capture(w.p.ann, CHANGE);
    expect(proposal.summary.removed).toEqual([]);
    expect(proposal.text).not.toContain('replaces');
    expect(await notes(w.p.ann)).toHaveLength(2);
  });

  it('no warnings are raised in normal use', async () => {
    const warnings: string[] = [];
    const w = await world({}, { onWarning: (m) => void warnings.push(m) });
    await w.capture(w.p.ann, OLD);
    await w.capture(w.p.ann, CHANGE);
    expect(warnings).toEqual([]);
  });
});

describe('when something that must not fail a request does', () => {
  it('a change log that cannot record: the note is still filed, the operator is told once, with no notes or ids in the sentence', async () => {
    const warnings: string[] = [];
    const w = await world({}, { onWarning: (m) => void warnings.push(m) });
    const db = openDb({ path: join(w.dir, 'users.db') });
    db.exec('DROP TABLE ledger');
    db.close();
    const { written } = await w.capture(w.p.ann, OLD);
    expect(written.applied).toBeGreaterThan(0);
    expect(await notes(w.p.ann)).toHaveLength(1);
    expect(warnings).toEqual(['the change was made but could not be recorded in the change log']);
  });
  it('a warning hook that throws changes nothing', async () => {
    const w = await world({}, { onWarning: () => { throw new Error('x'); } });
    const db = openDb({ path: join(w.dir, 'users.db') });
    db.exec('DROP TABLE ledger');
    db.close();
    expect((await w.capture(w.p.ann, OLD)).written.applied).toBeGreaterThan(0);
  });
  it('the service\'s clock is the one used for expiry and for the log', async () => {
    const t = Date.UTC(2026, 6, 1);
    const w = await world({}, { clock: () => t });
    const { proposal } = await w.capture(w.p.ann, OLD);
    expect(proposal.createdAt).toBe(t);
    expect(proposal.expiresAt).toBe(t + 15 * 60_000);
    expect((await w.p.ann.call('GET', '/api/ledger')).json.items[0].at).toBeGreaterThanOrEqual(t);
  });
  it('a clean stop closes the change log\'s connection too: only the two database files are left', async () => {
    const w = await world();
    await w.capture(w.p.ann, OLD);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    expect(readdirSync(w.dir).sort()).toEqual(['graphs.db', 'users.db']);
  });
});
