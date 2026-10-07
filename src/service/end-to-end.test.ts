import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { describeGraph, write } from '../graph_store/index.js';
import type { ServiceConfig } from './config.js';
import { recoverAdmin } from './recover.js';
import { startService, type RunningService } from './service.js';

// The whole stack, as a person would use it: the real service on real SQLite files, over real HTTP.
// Nothing is mocked and nothing is reached around except where the test says so (it reads the
// graph file directly, because the routes for writing notes belong to a later piece of work).

const PW = 'correct horse 7 staple';
const NEW_PW = 'brand new long passphrase 5';
const ADMIN_PW = 'another long admin passphrase 8';

const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (dataDir: string): ServiceConfig => ({ port: 0, bind: '127.0.0.1', dataDir, allowRegistration: true, cookieSecure: false, trustedProxies: 1, allowInsecure: false, llm: 'demo', proposalsPerHour: 30, maxPendingPerUser: 10, maxCirclesPerUser: 20, maxMembersPerCircle: 50, invitationDays: 7 });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string | undefined;
  text: string;
}
const tokens = new Set<string>();
let clientNumber = 0;
/** One request from a browser-like client at its own (proxied) address, carrying the cookie it was given. */
async function call(port: number, method: string, path: string, { body, cookie, client }: { body?: unknown; cookie?: string | undefined; client?: string } = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }), 'x-forwarded-for': client ?? `198.51.100.${(clientNumber++ % 250) + 1}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie')?.split(';')[0];
  if (setCookie !== undefined && !/=$/.test(setCookie)) tokens.add(setCookie.split('=')[1] as string);
  return { status: res.status, json: text === '' ? undefined : JSON.parse(text), cookie: setCookie, text };
}
const register = (port: number, username: string, password = PW) => call(port, 'POST', '/api/register', { body: { username, displayName: `Display ${username}`, password } });
const login = (port: number, username: string, password = PW) => call(port, 'POST', '/api/login', { body: { username, password } });

describe('the whole thing, as people would use it', () => {
  it('registers, signs in, keeps people apart, resets, deletes, restarts, and leaves no secret in the files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-e2e-'));
    dirs.push(dir);
    const first = await startService(config(dir));
    running.push(first);
    const port = first.port;
    const secrets = new Set([PW, NEW_PW, ADMIN_PW]);

    // 1. the first account is the admin, the second an ordinary user
    const ann = await register(port, 'ann');
    const bob = await register(port, 'bob');
    expect([ann.status, bob.status]).toEqual([201, 201]);
    expect(ann.json.user.role).toBe('admin');
    expect(bob.json.user.role).toBe('user');

    // 2. each signs in and gets a different graph of their own
    const annIn = await login(port, 'ann');
    const bobIn = await login(port, 'bob');
    const annMe = await call(port, 'GET', '/api/me', { cookie: annIn.cookie });
    const bobMe = await call(port, 'GET', '/api/me', { cookie: bobIn.cookie });
    expect(annMe.json.user.id).toBe(ann.json.user.id);
    expect(bobMe.json.user.id).toBe(bob.json.user.id);
    expect(annMe.json.graphId).toBe(`user-${ann.json.user.id}`);
    expect(bobMe.json.graphId).toBe(`user-${bob.json.user.id}`);
    expect(annMe.json.graphId).not.toBe(bobMe.json.graphId);

    // 3. bob cannot see or change ann's account, list people, or promote himself
    for (const [method, path, body] of [
      ['GET', `/api/users/${ann.json.user.id}`, undefined],
      ['PATCH', `/api/users/${ann.json.user.id}`, { displayName: 'Hacked' }],
      ['DELETE', `/api/users/${ann.json.user.id}`, undefined],
      ['POST', `/api/users/${ann.json.user.id}/password`, { newPassword: NEW_PW }],
      ['GET', '/api/users', undefined],
      ['PATCH', `/api/users/${bob.json.user.id}`, { role: 'admin' }],
    ] as const) {
      expect((await call(port, method, path, { cookie: bobIn.cookie, ...(body === undefined ? {} : { body }) })).status, `${method} ${path}`).toBe(403);
    }
    expect((await call(port, 'GET', `/api/users/${ann.json.user.id}`, { cookie: annIn.cookie })).json.user.displayName).toBe('Display ann'); // untouched

    // 4. their graphs are separate: a note in ann's graph is not in bob's (written through a second connection on the file, as the capture route will)
    const annGraph = annMe.json.graphId as string;
    const bobGraph = bobMe.json.graphId as string;
    const graphFile = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    try {
      const wrote = await write(graphFile, { version: 1, kind: 'mutation', graphId: annGraph, ops: [{ op: 'upsertNode', partition: 'item', id: 'ann-note', data: { title: 'only for ann' } }] });
      expect(wrote.ok).toBe(true);
      expect(await describeGraph(graphFile, annGraph)).toMatchObject({ ok: true, value: { itemCount: 1 } });
      expect(await describeGraph(graphFile, bobGraph)).toMatchObject({ ok: true, value: { itemCount: 0 } });
    } finally {
      await graphFile.close();
    }

    // 5. the admin lists both
    const list = await call(port, 'GET', '/api/users', { cookie: annIn.cookie });
    expect(list.json.items.map((u: { username: string }) => u.username)).toEqual(['ann', 'bob']);

    // 6. the admin resets bob's password: his old password and old session stop, the new password works
    expect((await call(port, 'POST', `/api/users/${bob.json.user.id}/password`, { cookie: annIn.cookie, body: { newPassword: NEW_PW } })).status).toBe(200);
    expect((await call(port, 'GET', '/api/me', { cookie: bobIn.cookie })).status).toBe(401);
    expect((await login(port, 'bob', PW)).status).toBe(401);
    const bobAgain = await login(port, 'bob', NEW_PW);
    expect(bobAgain.status).toBe(200);

    // 7. bob deletes his account: his graph goes, ann's stays with its note
    expect((await call(port, 'DELETE', '/api/me', { cookie: bobAgain.cookie, body: { password: NEW_PW } })).status).toBe(204);
    expect((await call(port, 'GET', '/api/me', { cookie: bobAgain.cookie })).status).toBe(401);
    expect((await login(port, 'bob', NEW_PW)).status).toBe(401);
    const check = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    try {
      expect(await describeGraph(check, bobGraph)).toMatchObject({ ok: false, error: { code: 'GRAPH_NOT_FOUND' } });
      expect(await describeGraph(check, annGraph)).toMatchObject({ ok: true, value: { itemCount: 1 } });
    } finally {
      await check.close();
    }
    expect((await call(port, 'GET', '/api/users', { cookie: annIn.cookie })).json.items.map((u: { username: string }) => u.username)).toEqual(['ann']);

    // 8. the last admin cannot be removed, by herself or by a crowd (eight more admins, all deleting the next at once). Over HTTP the requests
    // arrive one after another, so the strict race is pinned in controller-admin.test.ts; this checks the end state through the real stack.
    const crowd: Array<{ id: string; cookie: string }> = [];
    for (let i = 0; i < 8; i++) {
      const made = await register(port, `crowd${i}`, ADMIN_PW);
      expect(made.status, `crowd${i}`).toBe(201);
      expect((await call(port, 'PATCH', `/api/users/${made.json.user.id}`, { cookie: annIn.cookie, body: { role: 'admin' } })).status).toBe(200);
      const session = await login(port, `crowd${i}`, ADMIN_PW);
      crowd.push({ id: made.json.user.id, cookie: session.cookie as string });
    }
    expect((await call(port, 'DELETE', '/api/me', { cookie: annIn.cookie, body: { password: PW } })).status).toBe(204); // ann leaves: eight admins remain
    const outcomes = await Promise.all(crowd.map((member, i) => call(port, 'DELETE', `/api/users/${(crowd[(i + 1) % crowd.length] as { id: string }).id}`, { cookie: member.cookie })));
    const statuses = outcomes.map((o) => o.status);
    expect(statuses.every((s) => [204, 401, 403, 404, 409].includes(s)), JSON.stringify(statuses)).toBe(true);

    // whoever is left: at least one admin, and every account has a graph and every graph an account
    let remaining: Array<{ id: string; role: string; username: string }> = [];
    for (const member of crowd) {
      const view = await call(port, 'GET', '/api/users', { cookie: member.cookie });
      if (view.status === 200) {
        remaining = view.json.items;
        break;
      }
    }
    expect(remaining.filter((u) => u.role === 'admin').length).toBeGreaterThanOrEqual(1);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    const audit = createSqliteAdapter({ path: join(dir, 'graphs.db') });
    try {
      for (const user of remaining) expect(await describeGraph(audit, `user-${user.id}`), user.username).toMatchObject({ ok: true });
    } finally {
      await audit.close();
    }

    // 9. a clean stop leaves two files, with no password and no session token in either (and the hash of a token is there)
    const keeper = remaining[0] as { id: string; username: string };
    const keeperIn = await login(port, keeper.username, ADMIN_PW);
    expect(keeperIn.status).toBe(200);
    await first.close();
    running.length = 0;
    expect(readdirSync(dir).sort()).toEqual(['graphs.db', 'users.db']);
    const bytes = Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), `a password is in the files: ${secret.slice(0, 6)}…`).toBe(false);
    expect(tokens.size).toBeGreaterThan(10);
    for (const token of tokens) {
      expect(bytes.includes(Buffer.from(token)), 'a session token is in the files').toBe(false);
      expect(bytes.includes(Buffer.from(token, 'base64url')), 'a session token (as bytes) is in the files').toBe(false);
    }
    expect(bytes.includes(Buffer.from(createHash('sha256').update(keeperIn.cookie?.split('=')[1] ?? '').digest('hex')))).toBe(true);
    expect(bytes.includes(Buffer.from('scrypt$'))).toBe(true); // hashes are stored, as hashes

    // 10. after a restart on the same files the accounts, graphs and a signed-in session are still there
    const second = await startService(config(dir));
    running.push(second);
    const back = await call(second.port, 'GET', '/api/me', { cookie: keeperIn.cookie });
    expect(back.status).toBe(200);
    expect(back.json.user.id).toBe(keeper.id);
    expect((await login(second.port, keeper.username, ADMIN_PW)).status).toBe(200);
  }, 180_000);

  it('the recovery command gets a locked-out admin back in without touching anyone else (UA-AC-12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caci-e2e-recover-'));
    dirs.push(dir);
    const service = await startService(config(dir));
    await register(service.port, 'owner');
    await register(service.port, 'guest');
    const guestIn = await login(service.port, 'guest');
    await service.close();
    const out: string[] = [];
    expect(await recoverAdmin(['owner'], { CACI_DATA_DIR: dir }, { stdout: (t) => out.push(t), stderr: (t) => out.push(t), readPassword: async () => NEW_PW })).toBe(0);
    const again = await startService(config(dir));
    running.push(again);
    expect((await login(again.port, 'owner', NEW_PW)).status).toBe(200);
    expect((await login(again.port, 'owner', PW)).status).toBe(401);
    expect((await call(again.port, 'GET', '/api/me', { cookie: guestIn.cookie })).status).toBe(200);
  }, 60_000);
});
