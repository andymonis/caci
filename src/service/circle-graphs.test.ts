import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { createGraph, describeGraph, listGraphs, write } from '../graph_store/index.js';
import type { ReconcileReport, ScopesResult } from '../scopes/index.js';
import { describeReconcile, serve } from './cli.js';
import type { ServiceConfig } from './config.js';
import { startService, type RunningService } from './service.js';

// Circle records (users.db) and circle graphs (graphs.db) kept together by the real service, on real files, over real HTTP.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'caci-circle-graphs-'));
  dirs.push(dir);
  return dir;
};
const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 0, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7, maxBrainScopes: 25, statusPerHour: 20, ledgerDays: 90, sessionIdleDays: 7, sessionDays: 30 });
async function start(dir: string, reports: Array<ScopesResult<ReconcileReport>> = []): Promise<RunningService> {
  const s = await startService(config(dir), { onReconcile: (r) => void reports.push(r) });
  running.push(s);
  return s;
}
async function stop(s: RunningService): Promise<void> {
  running.splice(running.indexOf(s), 1);
  await s.close();
}

function browser(getPort: () => number) {
  let cookie: string | undefined;
  return {
    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${getPort()}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, json: (text === '' ? undefined : JSON.parse(text)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    async signIn(name: string): Promise<string> {
      const r = await this.call('POST', '/api/register', { username: name, displayName: name, password: PW });
      await this.call('POST', '/api/login', { username: name, password: PW });
      return r.json.user.id as string;
    },
  };
}

/** The circle graphs in graphs.db, through a second connection. */
async function circleGraphs(dir: string): Promise<string[]> {
  const adapter = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    const r = await listGraphs(adapter, { limit: 500 });
    return r.ok ? r.value.items.filter((g) => g.startsWith('circle-')).sort() : [];
  } finally {
    await adapter.close();
  }
}
async function withGraphs<T>(dir: string, body: (adapter: ReturnType<typeof createSqliteAdapter>) => Promise<T>): Promise<T> {
  const adapter = createSqliteAdapter({ path: join(dir, 'graphs.db') });
  try {
    return await body(adapter);
  } finally {
    await adapter.close();
  }
}
const note = (adapter: ReturnType<typeof createSqliteAdapter>, graphId: string) =>
  write(adapter, { version: 1, kind: 'mutation', graphId, ops: [{ op: 'upsertNode', partition: 'item', id: 'n1', data: { title: 'note' } }] } as never);
const invite = async (owner: ReturnType<typeof browser>, who: ReturnType<typeof browser>, circle: string, name: string) => {
  await owner.call('POST', `/api/circles/${circle}/invitations`, { username: name, role: 'member' });
  const id = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
  expect((await who.call('POST', `/api/invitations/${id}/accept`)).status).toBe(200);
};

describe('circle graphs in the running service', () => {
  it('creating a circle makes its graph, deleting it drops the graph and its notes, and other graphs are untouched', async () => {
    const dir = tmp();
    const service = await start(dir);
    const ann = browser(() => service.port);
    const annId = await ann.signIn('ann');
    expect(await circleGraphs(dir)).toEqual([]);
    const a = (await ann.call('POST', '/api/circles', { name: 'A' })).json.circle.id as string;
    const b = (await ann.call('POST', '/api/circles', { name: 'B' })).json.circle.id as string;
    expect(await circleGraphs(dir)).toEqual([`circle-${a}`, `circle-${b}`].sort());
    await withGraphs(dir, async (g) => void (await note(g, `circle-${a}`)));
    expect((await ann.call('DELETE', `/api/circles/${a}`)).status).toBe(204);
    expect(await circleGraphs(dir)).toEqual([`circle-${b}`]);
    await withGraphs(dir, async (g) => expect(await describeGraph(g, `user-${annId}`)).toMatchObject({ ok: true }));
    // a refused request makes and removes nothing
    expect((await ann.call('POST', '/api/circles', { name: '' })).status).toBe(422);
    expect((await ann.call('DELETE', `/api/circles/${a}`)).status).toBe(404);
    expect(await circleGraphs(dir)).toEqual([`circle-${b}`]);
  });

  it('someone who may not delete a circle cannot drop its graph', async () => {
    const dir = tmp();
    const service = await start(dir);
    const ann = browser(() => service.port);
    const bob = browser(() => service.port);
    const cat = browser(() => service.port);
    await ann.signIn('ann');
    await bob.signIn('bob');
    await cat.signIn('cat');
    const c = (await ann.call('POST', '/api/circles', { name: 'A' })).json.circle.id as string;
    await invite(ann, bob, c, 'bob');
    await withGraphs(dir, async (g) => void (await note(g, `circle-${c}`)));
    expect((await bob.call('DELETE', `/api/circles/${c}`)).status).toBe(403);
    expect((await cat.call('DELETE', `/api/circles/${c}`)).status).toBe(404);
    await withGraphs(dir, async (g) => expect(await describeGraph(g, `circle-${c}`)).toMatchObject({ ok: true, value: { itemCount: 1 } }));
  });

  it('deleting an account that alone belonged to a circle removes the circle\'s graph (by the owner, and by an admin), and a circle with another member keeps its graph', async () => {
    const dir = tmp();
    const service = await start(dir);
    const root = browser(() => service.port);
    const bob = browser(() => service.port);
    const cat = browser(() => service.port);
    const dan = browser(() => service.port);
    await root.signIn('root'); // the administrator
    await bob.signIn('bob');
    await cat.signIn('cat');
    const danId = await dan.signIn('dan');
    const alone = (await bob.call('POST', '/api/circles', { name: 'Alone' })).json.circle.id as string;
    const shared = (await cat.call('POST', '/api/circles', { name: 'Shared' })).json.circle.id as string;
    await invite(cat, bob, shared, 'bob');
    const danAlone = (await dan.call('POST', '/api/circles', { name: 'Dan alone' })).json.circle.id as string;
    await withGraphs(dir, async (g) => {
      await note(g, `circle-${alone}`);
      await note(g, `circle-${shared}`);
    });
    expect(await circleGraphs(dir)).toEqual([`circle-${alone}`, `circle-${shared}`, `circle-${danAlone}`].sort());

    // bob deletes himself: the circle he was alone in goes, the one he shared with cat stays (handed to cat)
    expect((await bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(await circleGraphs(dir)).toEqual([`circle-${shared}`, `circle-${danAlone}`].sort());
    await withGraphs(dir, async (g) => expect(await describeGraph(g, `circle-${shared}`)).toMatchObject({ ok: true, value: { itemCount: 1 } }));

    // the administrator deletes dan: his circle's graph goes before the answer comes back
    expect((await root.call('DELETE', `/api/users/${danId}`)).status).toBe(204);
    expect(await circleGraphs(dir)).toEqual([`circle-${shared}`]);
  });

  it('at start-up a circle with no graph gets one, a graph with no circle is dropped, and nothing else changes', async () => {
    const dir = tmp();
    const first = await start(dir);
    const ann = browser(() => first.port);
    const annId = await ann.signIn('ann');
    const keep = (await ann.call('POST', '/api/circles', { name: 'Keep' })).json.circle.id as string;
    const lost = (await ann.call('POST', '/api/circles', { name: 'Lost graph' })).json.circle.id as string;
    await stop(first);
    const orphan = 'circle-c0000000000000009';
    await withGraphs(dir, async (g) => {
      await note(g, `circle-${keep}`);
      await g.graphs.drop(`circle-${lost}`);
      await createGraph(g, orphan);
      await note(g, orphan);
    });
    const reports: Array<ScopesResult<ReconcileReport>> = [];
    const again = await start(dir, reports);
    expect(reports).toEqual([{ ok: true, value: { created: [lost], dropped: ['c0000000000000009'], skipped: [] } }]);
    expect(await circleGraphs(dir)).toEqual([`circle-${keep}`, `circle-${lost}`].sort());
    await withGraphs(dir, async (g) => {
      expect(await describeGraph(g, `circle-${keep}`)).toMatchObject({ ok: true, value: { itemCount: 1 } });
      expect(await describeGraph(g, `user-${annId}`)).toMatchObject({ ok: true });
    });
    // the circle is usable again through the API
    const token = browser(() => again.port);
    await token.call('POST', '/api/login', { username: 'ann', password: PW });
    expect((await token.call('GET', `/api/circles/${lost}`)).status).toBe(200);
  });

  it('a service on a database from before circle graphs existed gives every circle its graph on the first start', async () => {
    const dir = tmp();
    const first = await start(dir);
    const ann = browser(() => first.port);
    await ann.signIn('ann');
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await ann.call('POST', '/api/circles', { name: n })).json.circle.id as string);
    await stop(first);
    await withGraphs(dir, async (g) => {
      for (const id of ids) await g.graphs.drop(`circle-${id}`);
    });
    expect(await circleGraphs(dir)).toEqual([]);
    const reports: Array<ScopesResult<ReconcileReport>> = [];
    await start(dir, reports);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, value: { dropped: [] } });
    expect(await circleGraphs(dir)).toEqual(ids.map((i) => `circle-${i}`).sort());
  });

  it('a fresh start with nothing to do reports an empty reconcile, and a throwing observer does not stop the service', async () => {
    const dir = tmp();
    const reports: Array<ScopesResult<ReconcileReport>> = [];
    await start(dir, reports);
    expect(reports).toEqual([{ ok: true, value: { created: [], dropped: [], skipped: [] } }]);
    const dir2 = tmp();
    const s = await startService(config(dir2), { onReconcile: () => { throw new Error('observer broke'); } });
    running.push(s);
    expect(s.port).toBeGreaterThan(0);
  });
});

describe('what `npm run serve` says about circle graphs', () => {
  const sink = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
  };
  it('says nothing when there is nothing to do, says what it did, and warns when too many are left over', async () => {
    const dir = tmp();
    const quiet = sink();
    const first = await serve({ CACI_PORT: '0', CACI_DATA_DIR: dir }, quiet.io);
    expect(first.code).toBe(0);
    if (first.code === 0) await first.service.close();
    expect(quiet.out.join('')).not.toContain('Circle graphs');
    expect(quiet.err).toEqual([]);

    await withGraphs(dir, async (g) => void (await createGraph(g, 'circle-c0000000000000001')));
    const did = sink();
    const second = await serve({ CACI_PORT: '0', CACI_DATA_DIR: dir }, did.io);
    if (second.code === 0) await second.service.close();
    expect(did.out.join('')).toContain('Circle graphs brought in step: 0 made, 1 removed.');
    expect(did.err).toEqual([]);

    await withGraphs(dir, async (g) => {
      for (let n = 1; n <= 101; n++) await createGraph(g, `circle-c${String(n).padStart(16, '0')}`);
    });
    const warned = sink();
    const third = await serve({ CACI_PORT: '0', CACI_DATA_DIR: dir }, warned.io);
    if (third.code === 0) await third.service.close();
    expect(warned.err.join('')).toContain('101 circle graphs belong to no circle but were not removed');
    expect(await circleGraphs(dir)).toHaveLength(101);
  }, 30_000);

  it('describeReconcile: nothing for nothing, counts for work, a warning for a failure and for leftovers', () => {
    const report = (created: string[], dropped: string[], skipped: string[]) => ({ ok: true as const, value: { created, dropped, skipped } });
    expect(describeReconcile(report([], [], []))).toEqual({ err: [] });
    expect(describeReconcile(report(['a', 'b'], [], []))).toEqual({ out: 'Circle graphs brought in step: 2 made, 0 removed.\n', err: [] });
    expect(describeReconcile(report([], ['a'], []))).toEqual({ out: 'Circle graphs brought in step: 0 made, 1 removed.\n', err: [] });
    expect(describeReconcile(report([], [], ['a'])).err[0]).toContain('1 circle graphs belong to no circle');
    expect(describeReconcile(report([], [], ['a', 'b', 'c'])).err[0]).toContain('3 circle graphs belong to no circle but were not removed');
    const failed = describeReconcile({ ok: false, error: { code: 'STORAGE_ERROR', message: 'x' } as never });
    expect(failed.out).toBeUndefined();
    expect(failed.err[0]).toContain('could not check that every circle has its notes graph');
  });
});
