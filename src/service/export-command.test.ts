import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_USAGE, exportBrainCommand } from './export-command.js';
import { baseConfig } from './service.test-util.js';
import { startService, type RunningService } from './service.js';

// R-017 LX-FR-09: the command writes one brain as an owner-only JSON file and refuses everything unsafe.

const PW = 'correct horse 7 staple';
const SECRET_WORDS = 'Bin collection moved to Thursday SECRET-NOTE-WORDS';
const dirs: string[] = [];
const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'caci-export-cmd-'));
  dirs.push(d);
  return d;
};

async function world() {
  const dir = tmp();
  const service = await startService(baseConfig(join(dir, 'data')));
  running.push(service);
  const call = async (cookie: string | undefined, method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await res.text();
    return { res, json: t === '' ? undefined : JSON.parse(t) };
  };
  await call(undefined, 'POST', '/api/register', { username: 'root', displayName: 'Root', password: PW });
  await call(undefined, 'POST', '/api/register', { username: 'ann', displayName: 'Ann', password: PW });
  const login = await call(undefined, 'POST', '/api/login', { username: 'ann', password: PW });
  const cookie = (login.res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const circle = (await call(cookie, 'POST', '/api/circles', { name: 'Club' })).json.circle.id as string;
  for (const scope of [undefined, { kind: 'circle', circleId: circle }]) {
    const made = await call(cookie, 'POST', '/api/capture/propose', { text: SECRET_WORDS, ...(scope === undefined ? {} : { scope }) });
    await call(cookie, 'POST', `/api/capture/proposals/${made.json.proposal.id}/approve`);
  }
  return { dir, data: join(dir, 'data'), circle };
}
async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await exportBrainCommand(args, env, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), now: () => 1_700_000_000_000 });
  return { code, out: out.join(''), err: err.join('') };
}
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('arguments', () => {
  it('wrong arguments exit 2 with the usage and write nothing', async () => {
    const out = join(tmp(), 'x.json');
    const bad: string[][] = [
      [], ['--user', 'ann'], ['--out', out], ['--user', 'ann', '--circle', 'c0123456789abcdef', '--out', out], ['--user', 'ann', '--out', out, '--user', 'bob'], ['--user', '--out', out], ['--user', 'ann', '--out'],
      ['--user', 'ann', '--out', out, '--format', 'xml'], ['--user', 'ann', '--out', out, 'extra'], ['--circle', 'nope', '--out', out], ['--circle', 'C0123456789ABCDEF', '--out', out], ['--user', 'a\u0000b', '--out', out], ['--user', 'x'.repeat(65), '--out', out], ['--user', 'ann', '--out', ''],
    ];
    for (const args of bad) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain(EXPORT_USAGE);
    }
    expect(existsSync(out)).toBe(false);
  });
});

describe('writing the file', () => {
  it('writes the user brain as JSON, owner-only, and prints counts, the path and the warning but never the words', async () => {
    const w = await world();
    const out = join(tmp(), 'ann.json');
    const r = await run(['--user', 'ann', '--out', out, '--data-dir', w.data]);
    expect(r.code).toBe(0);
    expect(mode(out)).toBe(0o600);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc).toMatchObject({ format: 'caci-brain-export', version: 1, exportedAt: 1_700_000_000_000, brain: { kind: 'personal', name: 'ann' } });
    expect(JSON.stringify(doc)).toContain('SECRET-NOTE-WORDS');
    expect(r.out + r.err).not.toContain('SECRET-NOTE-WORDS');
    expect(r.out).toContain(`Written to ${out}`);
    expect(r.out).toContain('keep it out of the repository');
    expect(r.out).toMatch(/1 facts, \d+ categories, \d+ links, \d+ change-log entries \(1 with the words typed\)/);
  });

  it('writes a circle brain, and the username may be in any case; the data folder comes from the environment when not given', async () => {
    const w = await world();
    const a = join(tmp(), 'circle.json');
    const r = await run(['--circle', w.circle, '--out', a], { CACI_DATA_DIR: w.data });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(a, 'utf8')).brain).toEqual({ kind: 'circle', name: 'Club', circleId: w.circle });
    const b = join(tmp(), 'ann.json');
    expect((await run(['--user', 'ANN', '--out', b], { CACI_DATA_DIR: w.data })).code).toBe(0);
    expect(JSON.parse(readFileSync(b, 'utf8')).brain.name).toBe('ann');
  });

  it('is pretty-printed with a final new line', async () => {
    const w = await world();
    const out = join(tmp(), 'ann.json');
    await run(['--user', 'ann', '--out', out, '--data-dir', w.data]);
    const text = readFileSync(out, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "format"');
  });
});

describe('a brain-eval scenario draft', () => {
  it('--format scenario writes the typed words as dated notes with no questions, owner-only, and says it cannot run yet', async () => {
    const w = await world();
    const out = join(tmp(), 'draft.json');
    const r = await run(['--user', 'ann', '--out', out, '--format', 'scenario', '--data-dir', w.data]);
    expect(r.code).toBe(0);
    expect(mode(out)).toBe(0o600);
    const draft = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(draft).sort()).toEqual(['description', 'id', 'notes', 'questions', 'title']);
    expect(draft.questions).toEqual([]);
    expect(draft.id).toBe('brain-ann');
    expect(draft.notes).toEqual([{ id: 'n001', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/), text: SECRET_WORDS }]);
    expect(r.out).toContain('draft with no questions');
    expect(r.out + r.err).not.toContain('SECRET-NOTE-WORDS');
  });

  it('--format json is the default and says nothing about a draft', async () => {
    const w = await world();
    const r = await run(['--user', 'ann', '--out', join(tmp(), 'a.json'), '--format', 'json', '--data-dir', w.data]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('draft');
  });

  it('a brain with no notes cannot become a scenario, and nothing is written', async () => {
    const w = await world();
    const out = join(tmp(), 'root.json');
    const r = await run(['--user', 'root', '--out', out, '--format', 'scenario', '--data-dir', w.data]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no notes to turn into a scenario');
    expect(existsSync(out)).toBe(false);
    expect((await run(['--user', 'root', '--out', out, '--data-dir', w.data])).code).toBe(0); // the plain export of an empty brain is fine
  });
});

describe('what it refuses, leaving everything as it was', () => {
  it('an existing file (also a folder, or a link to nowhere) is never overwritten', async () => {
    const w = await world();
    const where = tmp();
    const file = join(where, 'taken.json');
    writeFileSync(file, 'precious');
    const r = await run(['--user', 'ann', '--out', file, '--data-dir', w.data]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('never overwrites');
    expect(readFileSync(file, 'utf8')).toBe('precious');
    const folder = join(where, 'folder');
    mkdirSync(folder);
    expect((await run(['--user', 'ann', '--out', folder, '--data-dir', w.data])).code).toBe(1);
    const link = join(where, 'link.json');
    symlinkSync(join(where, 'nowhere.json'), link);
    expect((await run(['--user', 'ann', '--out', link, '--data-dir', w.data])).code).toBe(1);
    expect(existsSync(join(where, 'nowhere.json'))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('a missing folder is not created', async () => {
    const w = await world();
    const where = tmp();
    const r = await run(['--user', 'ann', '--out', join(where, 'new', 'ann.json'), '--data-dir', w.data]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('folder for that file does not exist');
    expect(existsSync(join(where, 'new'))).toBe(false);
  });

  it('a path inside the project folder or inside the data folder is refused', async () => {
    const w = await world();
    const project = fileURLToPath(new URL('../../', import.meta.url));
    const inProject = join(project, 'brain-export-must-not-exist.json');
    const a = await run(['--user', 'ann', '--out', inProject, '--data-dir', w.data]);
    expect(a.code).toBe(1);
    expect(a.err).toContain('inside the project folder');
    expect(existsSync(inProject)).toBe(false);
    const inData = join(w.data, 'ann.json');
    const b = await run(['--user', 'ann', '--out', inData, '--data-dir', w.data]);
    expect(b.code).toBe(1);
    expect(b.err).toContain('inside the data folder');
    expect(readdirSync(w.data).includes('ann.json')).toBe(false);
    // a link that leads into the project is no way round it
    const link = join(tmp(), 'sneaky');
    symlinkSync(project, link);
    expect((await run(['--user', 'ann', '--out', join(link, 'brain-export-must-not-exist.json'), '--data-dir', w.data])).code).toBe(1);
    expect(existsSync(inProject)).toBe(false);
  });

  it('a user or circle that does not exist, or no databases, exits 1 and creates no file', async () => {
    const w = await world();
    const where = tmp();
    const none = join(where, 'none.json');
    expect((await run(['--user', 'nobody', '--out', none, '--data-dir', w.data])).code).toBe(1);
    expect((await run(['--circle', 'c0000000000000999', '--out', none, '--data-dir', w.data])).code).toBe(1);
    expect((await run(['--user', 'ann', '--out', none, '--data-dir', join(where, 'empty')])).code).toBe(1);
    const empty = join(where, 'emptydir');
    mkdirSync(empty);
    const r = await run(['--user', 'ann', '--out', none, '--data-dir', empty]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no graphs.db');
    expect(readdirSync(empty)).toEqual([]);
    expect(existsSync(none)).toBe(false);
  });
});

describe('the script', () => {
  it('is wired into npm, does not rebuild, and passes no secret on a command line', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['export-brain']).toBe('node scripts/export-brain.mjs');
    const script = readFileSync(new URL('../../scripts/export-brain.mjs', import.meta.url), 'utf8');
    expect(script).toContain("from '../dist/service/index.js'");
    expect(script).not.toMatch(/ANTHROPIC|password/i);
  });
});
