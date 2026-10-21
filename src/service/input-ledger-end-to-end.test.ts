import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { exportBrain } from './brain-export.js';
import { exportBrainCommand } from './export-command.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';

// R-017 as people meet it: the real service on real SQLite files over real HTTP with the demo model. root is the first account (the
// administrator); ann owns "Club"; bob is a member, cat an observer; dan is in nothing.

const PW = 'correct horse 7 staple';
const dirs: string[] = [];
const running: RunningService[] = [];
const seen: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  const all = seen.join('\n');
  expect(seen.length).toBeGreaterThan(20);
  for (const leak of [PW, 'scrypt$', 'passwordHash', 'caci_session', '@example.test', 'user-u', 'circle-c']) expect(all, `something held "${leak}"`).not.toContain(leak);
});

interface Reply { status: number; json: any; text: string } // eslint-disable-line @typescript-eslint/no-explicit-any
interface Person {
  readonly name: string;
  call(method: string, path: string, body?: unknown, record?: boolean): Promise<Reply>;
}
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'caci-input-ledger-'));
  dirs.push(dir);
  const service = await startService(baseConfig(join(dir, 'data')));
  running.push(service);
  const mk = async (name: string): Promise<Person> => {
    let cookie: string | undefined;
    const call = async (method: string, path: string, body?: unknown, record = true): Promise<Reply> => {
      const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = res.headers.get('set-cookie');
      if (set !== null) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      if (record && !path.startsWith('/api/register') && !path.startsWith('/api/login')) seen.push(text);
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text), text };
    };
    await call('POST', '/api/register', { username: name, displayName: `Display ${name}`, password: PW, email: `${name}@example.test` }, false);
    await call('POST', '/api/login', { username: name, password: PW }, false);
    return { call, name };
  };
  const p = { root: await mk('root'), ann: await mk('ann'), bob: await mk('bob'), cat: await mk('cat'), dan: await mk('dan') };
  const circle = (await p.ann.call('POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const [who, role] of [[p.bob, 'member'], [p.cat, 'observer']] as const) {
    await p.ann.call('POST', `/api/circles/${circle}/invitations`, { username: who.name, role });
    const inv = (await who.call('GET', '/api/invitations')).json.items[0].id as string;
    expect((await who.call('POST', `/api/invitations/${inv}/accept`)).status).toBe(200);
  }
  const send = async (who: Person, text: string, circleId?: string) => {
    const made = await who.call('POST', '/api/capture/propose', { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
    expect(made.status, made.text).toBe(201);
    expect((await who.call('POST', `/api/capture/proposals/${made.json.proposal.id}/approve`)).status).toBe(200);
  };
  return { dir, data: join(dir, 'data'), service, p, circle, send };
}
const inputs = (r: Reply): Array<{ text: string; by?: { username: string } }> => (r.json.items as Array<{ kind: string; text: string; by?: { username: string } }>).filter((e) => e.kind === 'input');

describe('the words of each update, in the change log', () => {
  it('a person\'s update and a circle\'s update each show the words typed and who typed them, beside the facts, and a replacement shows both', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Mum takes 2 x Tablet A a day for her blood pressure.');
    await w.send(w.p.ann, 'Mum now takes tablet day blood morning.');
    await w.send(w.p.bob, 'Bin collection moved to Thursday MARK-CIRCLE', w.circle);
    const own = await w.p.ann.call('GET', '/api/ledger');
    expect(inputs(own).map((e) => e.text)).toEqual(['Mum now takes tablet day blood morning.', 'Mum takes 2 x Tablet A a day for her blood pressure.']);
    const kinds = (own.json.items as Array<{ kind: string; action: string }>).map((e) => `${e.action} ${e.kind}`);
    expect(kinds).toEqual(['added item', 'added category', 'removed item', 'removed category', 'added input', 'added item', 'added category', 'added input']);
    const club = await w.p.ann.call('GET', `/api/ledger?scope=circle:${w.circle}`);
    expect(inputs(club)).toEqual([expect.objectContaining({ text: 'Bin collection moved to Thursday MARK-CIRCLE', by: { username: 'bob', displayName: 'Display bob' } })]);
    expect(own.text).not.toContain('MARK-CIRCLE');
  });

  it('every member and the observer read the same words; a stranger, the administrator and a made-up circle get the identical 404', async () => {
    const w = await world();
    await w.send(w.p.bob, 'Bin collection moved to Thursday MARK-CIRCLE', w.circle);
    const path = `/api/ledger?scope=circle:${w.circle}`;
    const texts = [];
    for (const who of [w.p.ann, w.p.bob, w.p.cat]) {
      const r = await who.call('GET', path);
      expect(r.status).toBe(200);
      texts.push(inputs(r)[0]?.text);
    }
    expect(new Set(texts)).toEqual(new Set(['Bin collection moved to Thursday MARK-CIRCLE']));
    const made = await w.p.dan.call('GET', '/api/ledger?scope=circle:c0000000000000999');
    for (const who of [w.p.dan, w.p.root]) {
      const r = await who.call('GET', path);
      expect(r.status).toBe(404);
      expect(r.json).toEqual(made.json);
      expect(r.text).not.toContain('MARK-CIRCLE');
    }
  });

  it('a question, a pulse and a rejected proposal leave no words behind', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning ONLY-THIS', w.circle);
    await w.p.ann.call('POST', '/api/status', { text: 'QUESTION-WORDS what is on?' });
    await w.p.ann.call('POST', '/api/status', { pulse: true, scope: { kind: 'circle', circleId: w.circle } });
    const made = await w.p.ann.call('POST', '/api/capture/propose', { text: 'REJECTED-WORDS some other note' });
    await w.p.ann.call('POST', `/api/capture/proposals/${made.json.proposal.id}/reject`);
    const all = JSON.stringify([(await w.p.ann.call('GET', '/api/ledger')).json, (await w.p.ann.call('GET', `/api/ledger?scope=circle:${w.circle}`)).json]);
    expect(all).toContain('ONLY-THIS');
    expect(all).not.toContain('QUESTION-WORDS');
    expect(all).not.toContain('REJECTED-WORDS');
    const exported = await exportBrain({ dataDir: w.data, target: { kind: 'circle', circleId: w.circle } });
    expect(JSON.stringify(exported)).not.toContain('QUESTION-WORDS');
  });
});

describe('exporting the brains of the running service', () => {
  it('the export of a person and of a circle holds the same words and facts as the change log shows, and nothing of the other brain', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning OWN-WORDS');
    await w.send(w.p.bob, 'Bin collection moved to Thursday CIRCLE-WORDS', w.circle);
    const own = await exportBrain({ dataDir: w.data, target: { kind: 'user', username: 'ann' } });
    const club = await exportBrain({ dataDir: w.data, target: { kind: 'circle', circleId: w.circle } });
    if (!own.ok || !club.ok) throw new Error('export failed');
    const shownOwn = inputs(await w.p.ann.call('GET', '/api/ledger')).map((e) => e.text);
    const shownClub = inputs(await w.p.ann.call('GET', `/api/ledger?scope=circle:${w.circle}`)).map((e) => e.text);
    expect(own.value.ledger.filter((e) => e.kind === 'input').map((e) => e.text)).toEqual(shownOwn);
    expect(club.value.ledger.filter((e) => e.kind === 'input').map((e) => e.text)).toEqual(shownClub);
    expect(JSON.stringify(own.value)).not.toContain('CIRCLE-WORDS');
    expect(JSON.stringify(club.value)).not.toContain('OWN-WORDS');
    expect(club.value.facts.map((f) => f.author)).toEqual(['bob']);
    const everything = JSON.stringify([own.value, club.value]);
    for (const leak of [PW, 'scrypt$', 'passwordHash', '@example.test', 'user-u', 'circle-c', 'caci_session']) expect(everything, leak).not.toContain(leak);
  });

  it('the command writes the same document to an owner-only file, and a scenario draft built from it can be used', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Mum takes 2 x Tablet A a day for her blood pressure.');
    await w.send(w.p.ann, 'Mum now takes tablet day blood morning.');
    const where = mkdtempSync(join(tmpdir(), 'caci-input-ledger-out-'));
    dirs.push(where);
    const out: string[] = [];
    const code = await exportBrainCommand(['--user', 'ann', '--out', join(where, 'ann.json'), '--format', 'scenario', '--data-dir', w.data], {}, { stdout: (t) => out.push(t), stderr: (t) => out.push(t) });
    expect(code).toBe(0);
    const draft = JSON.parse(readFileSync(join(where, 'ann.json'), 'utf8'));
    expect(draft.notes.map((n: { text: string }) => n.text)).toEqual(['Mum takes 2 x Tablet A a day for her blood pressure.', 'Mum now takes tablet day blood morning.']);
    expect(draft.questions).toEqual([]);
  });

  it('after an account and a circle are deleted their words are in no later export, and the person is no longer found', async () => {
    const w = await world();
    await w.send(w.p.bob, 'Dentist appointment BOB-OWN-WORDS');
    await w.send(w.p.bob, 'Bin collection moved to Thursday BOB-CIRCLE-WORDS', w.circle);
    expect((await w.p.bob.call('DELETE', '/api/me', { password: PW })).status).toBe(204);
    expect(await exportBrain({ dataDir: w.data, target: { kind: 'user', username: 'bob' } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const club = await exportBrain({ dataDir: w.data, target: { kind: 'circle', circleId: w.circle } });
    expect(club.ok && JSON.stringify(club.value)).toContain('BOB-CIRCLE-WORDS'); // what was added to a circle stays, without a name
    expect(club.ok && club.value.ledger.every((e) => e.by === undefined)).toBe(true);
    expect((await w.p.ann.call('DELETE', `/api/circles/${w.circle}`)).status).toBe(204);
    expect(await exportBrain({ dataDir: w.data, target: { kind: 'circle', circleId: w.circle } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const ann = await exportBrain({ dataDir: w.data, target: { kind: 'user', username: 'ann' } });
    expect(JSON.stringify(ann)).not.toContain('BOB-');
  });
});

describe('keeping and forgetting', () => {
  it('a restart keeps the words, and the retention setting removes old ones at start-up', async () => {
    const w = await world();
    await w.send(w.p.ann, 'Dentist appointment on Friday morning KEPT-WORDS');
    await w.service.close();
    running.splice(0);
    const again = await startService(baseConfig(w.data));
    running.push(again);
    const exported = await exportBrain({ dataDir: w.data, target: { kind: 'user', username: 'ann' } });
    expect(JSON.stringify(exported)).toContain('KEPT-WORDS');
    await again.close();
    running.splice(0);
    const later = await startService({ ...baseConfig(w.data), ledgerDays: 1 }, { clock: () => Date.now() + 3 * 86_400_000 });
    running.push(later);
    const purged = await exportBrain({ dataDir: w.data, target: { kind: 'user', username: 'ann' } });
    // the change log's entries (and so the typed words) are gone; the fact itself is still in the brain
    expect(purged.ok && purged.value.counts).toMatchObject({ facts: 1, entries: 0, inputs: 0 });
    expect(purged.ok && purged.value.ledger).toEqual([]);
  });
});
