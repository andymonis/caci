import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAdapter } from '../graph_store/adapters/sqlite/index.js';
import { write } from '../graph_store/index.js';
import { createSqliteLedgerStore } from '../ledger/sqlite/index.js';
import { exportBrain, type BrainExport } from './brain-export.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';

// R-017 D11, D12: exporting one brain from the data folder, against the real service on real SQLite files over real HTTP.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Person {
  call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  id: string;
}
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-export-test-'));
  dirs.push(dir);
  const service = await startService(baseConfig(dir));
  running.push(service);
  const mk = async (name: string): Promise<Person> => {
    let cookie: string | undefined;
    const call: Person['call'] = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const t = await res.text();
      return { status: res.status, json: t === '' ? undefined : JSON.parse(t) };
    };
    const r = await call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW, email: `${name}@example.test` });
    await call('POST', '/api/login', { username: name, password: PW });
    return { call, id: r.json.user.id as string };
  };
  const p = { root: await mk('root'), ann: await mk('ann'), bob: await mk('bob'), cat: await mk('cat') };
  const circle = (await p.ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const [who, role] of [[p.bob, 'member'], [p.cat, 'observer']] as const) {
    await p.ann.call('POST', `/api/circles/${circle}/invitations`, { username: who === p.bob ? 'bob' : 'cat', role });
    const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
    await who.call('POST', `/api/invitations/${inv}/accept`);
  }
  const send = async (who: Person, text: string, circleId?: string) => {
    const made = await who.call('POST', '/api/capture/propose', { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect((await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
  };
  return { dir, service, p, circle, send };
}
const doc = async (dir: string, target: Parameters<typeof exportBrain>[0]['target']): Promise<BrainExport> => {
  const r = await exportBrain({ dataDir: dir, target, now: () => 1_700_000_000_000 });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const hashes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, `${statSync(join(dir, f)).size}:${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}`]));
const tempFolders = (): number => readdirSync(tmpdir()).filter((n) => n.startsWith('caci-export-') && !n.startsWith('caci-export-test-')).length;

describe('exporting a person\'s own brain', () => {
  it('holds the facts, categories, links and the change log with the words typed and who entered them', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Mum takes 2 x Tablet A a day for her blood pressure.');
    await w.send(w.p.ann, 'Mum now takes tablet day blood morning.'); // replaces the first
    const d = await doc(w.dir, { kind: 'user', username: 'ann' });
    expect(d).toMatchObject({ format: 'caci-brain-export', version: 1, exportedAt: 1_700_000_000_000, brain: { kind: 'personal', name: 'ann' } });
    expect(d.counts).toMatchObject({ facts: 1, inputs: 2 });
    expect(d.facts).toHaveLength(1);
    expect(d.facts[0]).toMatchObject({ title: expect.stringContaining('Mum now takes'), categories: [{ id: expect.any(String), weight: expect.any(Number) }] });
    expect(d.categories.length).toBeGreaterThan(0);
    expect(d.counts.links).toBe(d.facts[0]?.categories.length);
    expect(d.ledger.filter((e) => e.kind === 'input').map((e) => e.text)).toEqual(['Mum now takes tablet day blood morning.', 'Mum takes 2 x Tablet A a day for her blood pressure.']);
    expect(d.ledger.some((e) => e.action === 'removed' && e.kind === 'item' && (e.summary ?? '').includes('2 x Tablet A'))).toBe(true);
    expect(d.ledger.every((e) => e.by === 'ann')).toBe(true);
    expect(d.ledger.filter((e) => e.kind === 'input').every((e) => !('subject' in e))).toBe(true);
  });

  it('is found by username in any case and never holds a password, hash, session, email or user id', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning');
    const d = await doc(w.dir, { kind: 'user', username: 'ANN' });
    const json = JSON.stringify(d);
    for (const leak of [PW, 'scrypt$', 'passwordHash', 'password_hash', '@example.test', w.p.ann.id, w.p.bob.id, 'user-u', 'circle-c', 'caci_session', 'sessions']) expect(json, leak).not.toContain(leak);
    expect(Object.keys(d).sort()).toEqual(['brain', 'categories', 'counts', 'exportedAt', 'facts', 'format', 'ledger', 'version']);
  });

  it('another person\'s brain with the same words never mixes in', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning ANN-ONLY');
    await w.send(w.p.bob, 'Dentist appointment on Friday morning BOB-ONLY');
    const a = JSON.stringify(await doc(w.dir, { kind: 'user', username: 'ann' }));
    const b = JSON.stringify(await doc(w.dir, { kind: 'user', username: 'bob' }));
    expect(a).toContain('ANN-ONLY');
    expect(a).not.toContain('BOB-ONLY');
    expect(b).toContain('BOB-ONLY');
    expect(b).not.toContain('ANN-ONLY');
  });
});

describe('exporting a circle\'s brain', () => {
  it('holds the circle\'s facts with their authors as usernames and the words each member typed, and nothing personal', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning PERSONAL-ANN');
    await w.send(w.p.bob, 'Bin collection moved to Thursday CIRCLE-BOB', w.circle);
    await w.send(w.p.ann, 'Club meets on Monday evening CIRCLE-ANN', w.circle);
    const d = await doc(w.dir, { kind: 'circle', circleId: w.circle });
    expect(d.brain).toEqual({ kind: 'circle', name: 'Club', circleId: w.circle });
    expect(d.facts.map((f) => f.author).sort()).toEqual(['ann', 'bob']);
    expect(d.facts.every((f) => typeof f.at === 'number')).toBe(true);
    expect(d.ledger.filter((e) => e.kind === 'input').map((e) => [e.by, e.text]).sort()).toEqual([['ann', 'Club meets on Monday evening CIRCLE-ANN'], ['bob', 'Bin collection moved to Thursday CIRCLE-BOB']]);
    expect(JSON.stringify(d)).not.toContain('PERSONAL-ANN');
    expect(JSON.stringify(await doc(w.dir, { kind: 'user', username: 'ann' }))).not.toContain('CIRCLE-');
  });

  it('after an account is deleted the circle keeps what the person added, without a name, and their own brain is no longer found', async () => {
    const w = await world();
    await w.send(w.p.bob, 'Bin collection moved to Thursday CIRCLE-BOB', w.circle);
    await w.send(w.p.bob, 'Dentist appointment BOB-PERSONAL');
    expect((await w.p.bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    const d = await doc(w.dir, { kind: 'circle', circleId: w.circle });
    expect(d.facts).toHaveLength(1);
    expect(d.facts[0]?.author).toBeUndefined();
    expect(d.ledger.every((e) => e.by === undefined)).toBe(true);
    const gone = await exportBrain({ dataDir: w.dir, target: { kind: 'user', username: 'bob' } });
    expect(gone).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a deleted circle is no longer found, and its words are in no later export', async () => {
    const w = await world();
    await w.send(w.p.bob, 'Bin collection moved to Thursday CIRCLE-WORDS', w.circle);
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.circle}`)).status).toBe(204);
    expect(await exportBrain({ dataDir: w.dir, target: { kind: 'circle', circleId: w.circle } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(JSON.stringify(await doc(w.dir, { kind: 'user', username: 'bob' }))).not.toContain('CIRCLE-WORDS');
  });
});

describe('what it refuses and what it leaves alone', () => {
  it('a missing user or circle is a clear refusal that creates nothing', async () => {
    const w = await world();
    const before = hashes(w.dir);
    expect(await exportBrain({ dataDir: w.dir, target: { kind: 'user', username: 'nobody' } })).toEqual({ ok: false, code: 'NOT_FOUND', message: 'there is no such user' });
    expect(await exportBrain({ dataDir: w.dir, target: { kind: 'circle', circleId: 'c0000000000000999' } })).toEqual({ ok: false, code: 'NOT_FOUND', message: 'there is no such circle' });
    expect(await exportBrain({ dataDir: w.dir, target: { kind: 'user', username: '../etc/passwd' } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(Object.keys(hashes(w.dir))).toEqual(Object.keys(before)); // no new file beside the databases
  });

  it('a data folder with no databases is refused and nothing is created', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'caci-export-test-'));
    dirs.push(empty);
    const r = await exportBrain({ dataDir: empty, target: { kind: 'user', username: 'ann' } });
    expect(r).toMatchObject({ ok: false, code: 'MISSING_DATABASE' });
    expect(readdirSync(empty)).toEqual([]);
    expect(await exportBrain({ dataDir: join(empty, 'nowhere'), target: { kind: 'user', username: 'ann' } })).toMatchObject({ ok: false, code: 'MISSING_DATABASE' });
  });

  it('the live files are never changed, and no temporary folder is left, whether it works or refuses', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning');
    await w.service.close();
    running.splice(0);
    const files = hashes(w.dir);
    const folders = tempFolders();
    await doc(w.dir, { kind: 'user', username: 'ann' });
    await exportBrain({ dataDir: w.dir, target: { kind: 'user', username: 'nobody' } });
    await exportBrain({ dataDir: w.dir, target: { kind: 'circle', circleId: w.circle } });
    expect(hashes(w.dir)).toEqual(files);
    expect(tempFolders()).toBe(folders);
  });

  it('works while the service is running and holds only what had happened by then', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning BEFORE');
    const before = await doc(w.dir, { kind: 'user', username: 'ann' });
    await w.send(w.p.ann, 'Garden fence needs painting AFTER');
    const after = await doc(w.dir, { kind: 'user', username: 'ann' });
    expect(JSON.stringify(before)).not.toContain('AFTER');
    expect(before.counts.facts).toBe(1);
    expect(after.counts.facts).toBe(2);
    expect((await w.p.ann.call('GET', '/api/me')).status).toBe(200); // the service is still fine
  });
});

describe('big and odd brains', () => {
  it('more than a page of facts and entries all come out, in a stable order, with odd ids and text kept exactly', async () => {
    const w = await world();
    await w.service.close();
    running.splice(0);
    const graphs = createSqliteAdapter({ path: join(w.dir, 'graphs.db') });
    const ledger = createSqliteLedgerStore({ path: join(w.dir, 'users.db') });
    const lone = `x${String.fromCharCode(0xd800)}y`;
    const userGraph = `user-${w.p.ann.id}`;
    for (let start = 0; start < 450; start += 150) {
      const ops: unknown[] = [];
      for (let i = start; i < start + 150; i++) ops.push({ op: 'upsertNode', partition: 'item', id: `item ${i} / ${i % 2 === 0 ? 'a?b&c#d' : '😀'}`, data: { title: `Fact ${i}`, summary: i === 7 ? lone : `s${i}`, key: `k${i}` } });
      if (start === 0) ops.push({ op: 'upsertNode', partition: 'category', id: 'cat <b>', data: { name: 'Name 😀' } }, { op: 'link', item: 'item 0 / a?b&c#d', category: 'cat <b>', weight: 0.5 });
      const r = await write(graphs, { version: 1, kind: 'mutation', graphId: userGraph, ops } as never);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    await graphs.close();
    const entries = Array.from({ length: 250 }, (_, i) => ({ id: `lbig${String(i).padStart(12, '0')}`, at: 1000 + i, scope: { kind: 'personal' as const, userId: w.p.ann.id }, actor: w.p.ann.id, action: 'added' as const, kind: 'input' as const, subject: `prop-${i}`, text: i === 3 ? `typed ${lone}` : `words ${i}`, proposalId: `prop-${i}` }));
    expect((await ledger.append(entries)).ok).toBe(true);
    ledger.close();
    const d = await doc(w.dir, { kind: 'user', username: 'ann' });
    expect(d.counts).toMatchObject({ facts: 450, categories: 1, links: 1, entries: 250, inputs: 250 });
    expect(d.facts.find((f) => f.id === 'item 0 / a?b&c#d')?.categories).toEqual([{ id: 'cat <b>', weight: 0.5 }]);
    expect(d.facts.find((f) => f.title === 'Fact 7')?.summary).toBe(lone);
    expect(d.categories).toEqual([{ id: 'cat <b>', name: 'Name 😀' }]);
    expect(d.ledger.map((e) => e.at)).toEqual([...d.ledger.map((e) => e.at)].sort((a, b) => b - a)); // newest first
    expect(d.ledger.find((e) => e.text === `typed ${lone}`)).toBeDefined();
    expect(new Set(d.facts.map((f) => f.id)).size).toBe(450);
  }, 60_000);
});
