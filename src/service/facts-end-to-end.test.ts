import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { describeGraph } from '../graph_store/index.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// R-025 over the real service on real SQLite files over real HTTP (VR-AC-12): the owner posts the weekly yoga fact, a member pays it with
// `pay`, their Pulse no longer shows it and another member's still does, the owner posts next week's fact and it appears fresh.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
const everything: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = everything.join('\n');
  expect(everything.length).toBeGreaterThan(20);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'user-u', 'circle-c', 'inputTokens']) expect(all.includes(leak), `a response held "${leak}"`).toBe(false);
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 100, maxPendingPerUser: 20, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 50, ledgerDays: 90, usageDays: 400, sessionIdleDays: 7, sessionDays: 30, agentAccess: false, joinLinks: false });

interface Reply { status: number; json: any; text: string } // eslint-disable-line @typescript-eslint/no-explicit-any
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
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    },
    async signIn(name: string): Promise<void> {
      await this.call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
    },
  };
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-facts-'));
  dirs.push(dir);
  const service = await startService(config(dir));
  running.push(service);
  const get = () => service.port;
  const p = { root: person(get), ann: person(get), bob: person(get), cat: person(get), eve: person(get) };
  for (const [name, who] of Object.entries(p)) await who.signIn(name);
  const circle = (await p.ann.call('POST', '/api/circles', { name: 'Yoga' })).json.circle.id as string;
  const accept = async (member: Person, username: string, role: string) => {
    await p.ann.call('POST', `/api/circles/${circle}/invitations`, { username, role });
    const inv = (await member.call('GET', '/api/invitations')).json.items.find((i: { circle: { id: string } }) => i.circle.id === circle).id as string;
    expect((await member.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  };
  await accept(p.bob, 'bob', 'member');
  await accept(p.cat, 'cat', 'observer');
  /** Files a note into the circle and gives the id of the fact it made. */
  const post = async (who: Person, text: string): Promise<string> => {
    const made = await who.call('POST', '/api/capture/propose', { text, scope: { kind: 'circle', circleId: circle } });
    expect(made.status, made.text).toBe(201);
    expect((await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
    return made.json.proposal.summary.newItems[0] as string;
  };
  const pulse = (who: Person) => who.call('POST', '/api/status', { pulse: true, scope: { kind: 'circle', circleId: circle } });
  const scope = { kind: 'circle', circleId: circle };
  return { dir, service, p, circle, post, pulse, scope };
}

describe('a recurring request, paid and cleared from one person\'s Pulse (VR-AC-12)', () => {
  it('the weekly yoga story', async () => {
    const w = await world();
    const week1 = await w.post(w.p.ann, 'Pay for this week yoga class by Friday MARK-WEEK1');
    for (const who of [w.p.bob, w.p.cat, w.p.ann]) expect((await w.pulse(who)).text).toContain('MARK-WEEK1');

    // bob pays it: the fact leaves bob's Pulse only
    const paid = await w.p.bob.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'pay' });
    expect(paid.status, paid.text).toBe(200);
    expect(paid.json.resolved).toMatchObject({ verb: 'pay', effect: 'clear', result: 'hidden' });
    const bobPulse = await w.pulse(w.p.bob);
    expect(bobPulse.text).not.toContain('MARK-WEEK1');
    expect(bobPulse.json.status).toMatchObject({ entriesUsed: 0, entriesResolved: 1, nothing: true });
    for (const who of [w.p.cat, w.p.ann]) expect((await w.pulse(who)).text).toContain('MARK-WEEK1');

    // next week's request is a new fact: it appears fresh for bob, and this week's stays cleared
    const week2 = await w.post(w.p.ann, 'Pay for next week yoga class by Friday MARK-WEEK2');
    expect(week2).not.toBe(week1);
    const next = await w.pulse(w.p.bob);
    expect(next.text).toContain('MARK-WEEK2');
    expect(next.text).not.toContain('MARK-WEEK1');
    expect(next.json.status).toMatchObject({ entriesUsed: 1, entriesResolved: 1 });

    // bob takes it back and it is there again
    expect((await w.p.bob.call('POST', '/api/facts/unresolve', { scope: w.scope, id: week1 })).status).toBe(200);
    expect((await w.pulse(w.p.bob)).json.status).toMatchObject({ entriesUsed: 2, entriesResolved: 0 });

    // bob's list shows only bob's record, and nobody else's
    await w.p.bob.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'pay' });
    expect((await w.p.bob.call('GET', '/api/facts/resolutions')).json.items).toHaveLength(1);
    for (const who of [w.p.ann, w.p.cat, w.p.eve]) expect((await who.call('GET', '/api/facts/resolutions')).json.items).toEqual([]);
  });

  it('only the owner can delete the request for everyone, and it goes from everyone\'s Pulse and the graph', async () => {
    const w = await world();
    const week1 = await w.post(w.p.ann, 'Pay for this week yoga class by Friday MARK-WEEK1');
    for (const who of [w.p.bob, w.p.cat]) expect((await who.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'remove' })).status).toBe(403);
    const removed = await w.p.ann.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'remove' });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.json.resolved.result).toBe('deleted');
    for (const who of [w.p.bob, w.p.cat, w.p.ann]) expect((await w.pulse(who)).text).not.toContain('MARK-WEEK1');
    const adapter = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    try {
      const d = await describeGraph(adapter, `circle-${w.circle}`);
      expect(d.ok && d.value.itemCount).toBe(0);
    } finally {
      await adapter.close();
    }
    const log = await w.p.ann.call('GET', `/api/ledger?scope=circle:${w.circle}`);
    expect(JSON.stringify(log.json)).toContain('"removed"');
  });

  it('a stranger, the administrator and a made-up circle get the same 404 as each other', async () => {
    const w = await world();
    const week1 = await w.post(w.p.ann, 'Pay for this week yoga class by Friday MARK-WEEK1');
    const replies = [
      await w.p.eve.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'pay' }),
      await w.p.root.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'pay' }),
      await w.p.bob.call('POST', '/api/facts/resolve', { scope: { kind: 'circle', circleId: 'c9999999999999999' }, id: week1, verb: 'pay' }),
    ];
    for (const r of replies) expect(r.status).toBe(404);
    expect(new Set(replies.map((r) => r.text)).size).toBe(1);
  });

  it('resolutions live in the users database and go with the circle', async () => {
    const w = await world();
    const week1 = await w.post(w.p.ann, 'Pay for this week yoga class by Friday MARK-WEEK1');
    await w.p.bob.call('POST', '/api/facts/resolve', { scope: w.scope, id: week1, verb: 'pay' });
    expect((await w.p.bob.call('GET', '/api/facts/resolutions')).json.items).toHaveLength(1);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(w.dir, 'users.db'));
    try {
      expect((db.prepare('SELECT count(*) AS n FROM fact_resolutions').get() as { n: number }).n).toBe(1);
      db.exec("DELETE FROM circles WHERE name = 'Yoga'");
      expect((db.prepare('SELECT count(*) AS n FROM fact_resolutions').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('resolutions of facts that are gone are cleaned (VR-AC-10)', () => {
  const countRows = async (dir: string): Promise<number> => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'users.db'));
    try {
      return (db.prepare('SELECT count(*) AS n FROM fact_resolutions').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('at start-up: a record whose fact was deleted while the service was stopped is removed, and a record of a live fact stays', async () => {
    const w = await world();
    const live = await w.post(w.p.ann, 'Pay for this week yoga class by Friday MARK-LIVE');
    const dead = await w.post(w.p.ann, 'Bring a mat to the next class MARK-DEAD');
    for (const id of [live, dead]) expect((await w.p.bob.call('POST', '/api/facts/resolve', { scope: w.scope, id, verb: 'clear' })).status).toBe(200);
    expect(await countRows(w.dir)).toBe(2);
    await w.service.close();
    running.splice(running.indexOf(w.service), 1);
    const adapter = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    try {
      await adapter.transaction(`circle-${w.circle}`, async (tx) => tx.deleteNodes('item', [dead]));
    } finally {
      await adapter.close();
    }
    const again = await startService(config(w.dir));
    running.push(again);
    expect(await countRows(w.dir)).toBe(1);
  });

  it('once a day while it runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const w = await world();
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(w.dir, 'users.db'));
      try {
        // a record of a fact that does not exist, put in behind the service's back
        db.exec(`INSERT INTO fact_resolutions (user_id, scope_kind, scope_id, fact_id, verb, at) VALUES ('u0000000000000001', 'circle', '${w.circle}', 'never-was', 'pay', 1)`);
        expect(await countRows(w.dir)).toBe(1);
        await vi.advanceTimersByTimeAsync(86_400_000);
        for (let i = 0; i < 50 && (await countRows(w.dir)) > 0; i++) await new Promise((r) => setTimeout(r, 20));
        expect(await countRows(w.dir)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
