import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController } from '../caci/index.js';
import { createMemoryAdapter } from '../graph_store/adapters/memory/index.js';
import { write } from '../graph_store/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController } from '../users/index.js';
import { createCaptureRoutes } from './capture-routes.js';
import { createReadRoutes } from './read-routes.js';
import { createAccountRoutes } from './routes.js';
import { createApiServer, type ApiServer } from './server.js';

const PW = 'correct horse 7 staple';
const COOKIE = 'caci_session';
const seen: string[] = [];
const sessionTokens = new Set<string>();

interface App {
  api: ApiServer;
  port: number;
  graphs: ReturnType<typeof createMemoryAdapter>;
  graphIds: Record<string, string>;
  tokens: Record<string, string>;
}
let app: App | undefined;
afterEach(async () => {
  await app?.api.close();
  app = undefined;
});

type Op = Record<string, unknown>;
const cat = (id: string, name?: string): Op => ({ op: 'upsertNode', partition: 'category', id, ...(name === undefined ? {} : { data: { name } }) });
const item = (id: string, data: Record<string, unknown> = { title: id }): Op => ({ op: 'upsertNode', partition: 'item', id, data });
const link = (i: string, c: string, weight?: number): Op => ({ op: 'link', item: i, category: c, ...(weight === undefined ? {} : { weight }) });

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string | undefined;
}
function call(port: number, method: string, path: string, { body, token }: { body?: unknown; token?: string | undefined } = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token !== undefined) headers.cookie = `${COOKIE}=${token}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        seen.push(text);
        const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE}=`));
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: text === '' ? undefined : JSON.parse(text), cookie: setCookie });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const q = (params: Record<string, string | number>): string => '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

async function start(people: string[] = ['ann', 'bob']): Promise<App> {
  const graphs = createMemoryAdapter();
  const users = createUserController({
    users: createMemoryUserStore(),
    sessions: createMemorySessionStore(),
    graphAdapter: graphs,
    hasher: createPasswordHasher({ params: { N: 16, r: 1, p: 1 } }),
    loginThrottle: createLoginThrottle(),
    registrationThrottle: createRegistrationThrottle({ max: 1000 }),
  });
  const capture = createController({ adapter: graphs, llm: createLlm({ client: createDemoModelClient() }) });
  const caci = createCaciController({ users, capture, graphAdapter: graphs });
  const api = createApiServer({ routes: [...createAccountRoutes({ controller: users }), ...createCaptureRoutes({ caci }), ...createReadRoutes({ caci })] });
  const port = await api.listen(0);
  const a: App = { api, port, graphs, graphIds: {}, tokens: {} };
  app = a;
  for (const name of people) {
    await call(port, 'POST', '/api/register', { body: { username: name, displayName: name, password: PW } });
    const login = await call(port, 'POST', '/api/login', { body: { username: name, password: PW } });
    const token = login.cookie?.split(';')[0]?.slice(COOKIE.length + 1) as string;
    sessionTokens.add(token);
    a.tokens[name] = token;
    a.graphIds[name] = login.json.graphId;
  }
  return a;
}
async function seed(a: App, who: string, ops: Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 500) {
    const r = await write(a.graphs, { version: 1, kind: 'mutation', graphId: a.graphIds[who] as string, ops: ops.slice(i, i + 500) });
    if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
  }
}
async function populated(): Promise<App> {
  const a = await start();
  await seed(a, 'ann', [cat('health', 'Health'), cat('travel', 'Travel plans'), item('n1', { title: 'Blood test' }), item('n2', { title: 'Flight' }), item('n3', { title: 'Passport' }), link('n1', 'health', 0.9), link('n2', 'travel', 0.9), link('n3', 'travel', 0.6), link('n3', 'health', 0.3)]);
  return a;
}

describe('GET /api/graph', () => {
  it('gives the counts of the signed-in person\'s graph', async () => {
    const a = await populated();
    const r = await call(a.port, 'GET', '/api/graph', { token: a.tokens.ann });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ summary: { itemCount: 3, categoryCount: 2, edgeCount: 4 } });
    expect((await call(a.port, 'GET', '/api/graph', { token: a.tokens.bob })).json).toEqual({ summary: { itemCount: 0, categoryCount: 0, edgeCount: 0 } });
  });
});

describe('GET /api/graph/categories', () => {
  it('lists the categories with names and item counts', async () => {
    const a = await populated();
    const r = await call(a.port, 'GET', '/api/graph/categories', { token: a.tokens.ann });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [{ id: 'health', name: 'Health', itemCount: 2 }, { id: 'travel', name: 'Travel plans', itemCount: 2 }], nextCursor: null });
  });

  it('pages with limit and cursor from the query string', async () => {
    const a = await start(['ann']);
    await seed(a, 'ann', Array.from({ length: 7 }, (_, i) => cat(`cat-${i}`)));
    const seenIds: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const r: Reply = await call(a.port, 'GET', `/api/graph/categories${q({ limit: 3, ...(cursor === null ? {} : { cursor }) })}`, { token: a.tokens.ann });
      expect(r.status).toBe(200);
      seenIds.push(...r.json.items.map((c: { id: string }) => c.id));
      cursor = r.json.nextCursor;
      if (cursor === null) break;
    }
    expect(seenIds).toEqual(Array.from({ length: 7 }, (_, i) => `cat-${i}`));
  });

  it('refuses a bad limit or cursor with 422 naming it, and a parameter it does not know', async () => {
    const a = await populated();
    for (const limit of ['0', '101', 'abc', '', '1.5', '-1', ' ']) {
      const r = await call(a.port, 'GET', `/api/graph/categories${q({ limit })}`, { token: a.tokens.ann });
      expect(r.status, `limit=${limit}`).toBe(422);
      expect(r.json.error).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
    }
    expect((await call(a.port, 'GET', `/api/graph/categories${q({ cursor: 'not a cursor' })}`, { token: a.tokens.ann })).json.error).toMatchObject({ field: 'cursor' });
    for (const stray of ['limt', 'graphId', 'userId', 'id', 'offset']) {
      const r = await call(a.port, 'GET', `/api/graph/categories${q({ [stray]: 'x' })}`, { token: a.tokens.ann });
      expect(r.status, stray).toBe(422);
      expect(r.json.error.field).toBe(stray);
    }
  });
});

describe('GET /api/graph/category', () => {
  it('lists the items under one category, paged', async () => {
    const a = await start(['ann']);
    await seed(a, 'ann', [cat('big', 'Big'), ...Array.from({ length: 6 }, (_, i) => item(`i${i}`)), ...Array.from({ length: 6 }, (_, i) => link(`i${i}`, 'big'))]);
    const first = await call(a.port, 'GET', `/api/graph/category${q({ id: 'big', limit: 4 })}`, { token: a.tokens.ann });
    expect(first.status).toBe(200);
    expect(first.json.category).toEqual({ id: 'big', name: 'Big' });
    expect(first.json.items.map((i: { id: string }) => i.id)).toEqual(['i0', 'i1', 'i2', 'i3']);
    const second = await call(a.port, 'GET', `/api/graph/category${q({ id: 'big', limit: 4, cursor: first.json.nextCursor })}`, { token: a.tokens.ann });
    expect(second.json.items.map((i: { id: string }) => i.id)).toEqual(['i4', 'i5']);
    expect(second.json.nextCursor).toBeNull();
  });

  it('needs an id: missing or empty is 422 naming id; one that does not exist is 404', async () => {
    const a = await populated();
    for (const path of ['/api/graph/category', `/api/graph/category${q({ id: '' })}`]) {
      const r = await call(a.port, 'GET', path, { token: a.tokens.ann });
      expect(r.status, path).toBe(422);
      expect(r.json.error.field).toBe('id');
    }
    const missing = await call(a.port, 'GET', `/api/graph/category${q({ id: 'nothing' })}`, { token: a.tokens.ann });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such category' } });
  });
});

describe('GET /api/graph/item', () => {
  it('shows an item and where it is filed', async () => {
    const a = await populated();
    const r = await call(a.port, 'GET', `/api/graph/item${q({ id: 'n3' })}`, { token: a.tokens.ann });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ item: { id: 'n3', data: { title: 'Passport' } }, categories: [{ id: 'health', name: 'Health', weight: 0.3 }, { id: 'travel', name: 'Travel plans', weight: 0.6 }] });
  });

  it('is 404 for a missing item, a category\'s id, and another account\'s item, all with the same body', async () => {
    const a = await populated();
    await seed(a, 'bob', [item('bobs-secret', { title: 'bob only' })]);
    const missing = await call(a.port, 'GET', `/api/graph/item${q({ id: 'nothing' })}`, { token: a.tokens.ann });
    expect(missing.status).toBe(404);
    for (const id of ['health', 'bobs-secret', 'N1', 'x'.repeat(300)]) {
      const r = await call(a.port, 'GET', `/api/graph/item${q({ id })}`, { token: a.tokens.ann });
      expect(r.status, id.slice(0, 20)).toBe(404);
      expect(r.json, id.slice(0, 20)).toEqual(missing.json);
    }
    expect(missing.text).not.toContain('bob');
  });

  it('refuses any parameter but id', async () => {
    const a = await populated();
    expect((await call(a.port, 'GET', `/api/graph/item${q({ id: 'n1', limit: 5 })}`, { token: a.tokens.ann })).json.error.field).toBe('limit');
  });
});

describe('ids are opaque text, in the query string', () => {
  const ODD = ['has spaces', 'UPPER Case', 'café ☕', '名前を忘れないように', 'a/b?c=d&e#f', '😀', '..', 'x'.repeat(128), '<script>alert(1)</script>', "o'brien", 'quote"d', '100%', '+plus+', 'semi;colon'];

  it('every kind of id round-trips through category listing, a category\'s items and an item', async () => {
    const a = await start(['ann']);
    const ops: Op[] = [];
    ODD.forEach((id, i) => ops.push(cat(id, `Name ${i}`), item(`item ${id}`), link(`item ${id}`, id)));
    await seed(a, 'ann', ops);
    const listed = await call(a.port, 'GET', `/api/graph/categories${q({ limit: 100 })}`, { token: a.tokens.ann });
    expect(listed.json.items.map((c: { id: string }) => c.id).sort()).toEqual([...ODD].sort());
    for (const id of ODD) {
      const items = await call(a.port, 'GET', `/api/graph/category${q({ id })}`, { token: a.tokens.ann });
      expect(items.status, id).toBe(200);
      expect(items.json.category.id).toBe(id);
      const detail = await call(a.port, 'GET', `/api/graph/item${q({ id: items.json.items[0].id })}`, { token: a.tokens.ann });
      expect(detail.status, id).toBe(200);
      expect(detail.json.categories.map((c: { id: string }) => c.id)).toEqual([id]);
    }
  });

  it('an id in the path is simply not a route', async () => {
    const a = await populated();
    for (const path of ['/api/graph/category/health', '/api/graph/item/n1', '/api/graph/categories/health']) expect((await call(a.port, 'GET', path, { token: a.tokens.ann })).status, path).toBe(404);
  });
});

describe('only your own graph, only with a session', () => {
  it('two people with the same ids see their own data', async () => {
    const a = await start();
    await seed(a, 'ann', [cat('shared', 'Ann\'s'), item('same', { title: 'ann secret' }), link('same', 'shared')]);
    await seed(a, 'bob', [cat('shared', 'Bob\'s'), item('same', { title: 'bob secret' }), link('same', 'shared')]);
    const annSees = (await call(a.port, 'GET', `/api/graph/item${q({ id: 'same' })}`, { token: a.tokens.ann })).text + (await call(a.port, 'GET', `/api/graph/category${q({ id: 'shared' })}`, { token: a.tokens.ann })).text;
    const bobSees = (await call(a.port, 'GET', `/api/graph/item${q({ id: 'same' })}`, { token: a.tokens.bob })).text;
    expect(annSees).toContain('ann secret');
    expect(annSees).not.toContain('bob');
    expect(bobSees).toContain('bob secret');
    expect(bobSees).not.toContain('ann');
  });

  it('every route is 401 without a session, and 401 with a stale cookie that is cleared', async () => {
    const a = await populated();
    for (const path of ['/api/graph', '/api/graph/categories', `/api/graph/category${q({ id: 'health' })}`, `/api/graph/item${q({ id: 'n1' })}`]) {
      expect((await call(a.port, 'GET', path)).status, path).toBe(401);
      const stale = await call(a.port, 'GET', path, { token: 'A'.repeat(43) });
      expect(stale.status, path).toBe(401);
      expect(stale.cookie, path).toMatch(/Max-Age=0/);
    }
  });

  it('after logging out the same session reads nothing', async () => {
    const a = await populated();
    await call(a.port, 'POST', '/api/logout', { token: a.tokens.ann });
    expect((await call(a.port, 'GET', '/api/graph', { token: a.tokens.ann })).status).toBe(401);
  });

  it('only GET: anything else is 405 with Allow', async () => {
    const a = await populated();
    for (const path of ['/api/graph', '/api/graph/categories', '/api/graph/category', '/api/graph/item']) {
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        const r = await call(a.port, method, path, { token: a.tokens.ann, ...(method === 'DELETE' ? {} : { body: {} }) });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe('GET');
      }
    }
  });

  it('a graph that has gone is a fixed 500, with nothing from inside', async () => {
    const a = await populated();
    await a.graphs.graphs.drop(a.graphIds.ann as string);
    const r = await call(a.port, 'GET', '/api/graph', { token: a.tokens.ann });
    expect(r.status).toBe(500);
    expect(r.json.error).toEqual({ code: 'STORAGE_ERROR', message: 'your notes could not be read or saved: try again' });
  });
});

describe('what a response contains', () => {
  it('has the data and flags it as the controller shortened it, and no graph id', async () => {
    const a = await start(['ann']);
    await seed(a, 'ann', [cat('c'), item('big', { title: 'b', summary: 'y'.repeat(6000) }), link('big', 'c')]);
    const r = await call(a.port, 'GET', `/api/graph/category${q({ id: 'c' })}`, { token: a.tokens.ann });
    expect(r.json.items[0]).toMatchObject({ id: 'big', dataTruncated: true });
    expect(r.json.items[0].data.summary).toHaveLength(300);
    expect(r.text).not.toMatch(/user-u|graphId/);
    expect(JSON.stringify((await call(a.port, 'GET', '/api/graph', { token: a.tokens.ann })).json)).not.toMatch(/user-u|graphId/);
  });

  it('and nothing in any response of this file holds a session token or a password', () => {
    expect(seen.length).toBeGreaterThan(40);
  });
});

afterAll(() => {
  const everything = seen.join('\n');
  for (const token of sessionTokens) expect(everything.includes(token), 'a response held a session token').toBe(false);
  expect(everything).not.toContain(PW);
  expect(everything).not.toMatch(/scrypt|passwordHash/);
});
