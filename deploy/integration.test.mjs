import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunner } from './exec.mjs';
import { LAYOUT } from './layout.mjs';
import { main } from './run.mjs';

// The whole deploy over a real git repository, real node, real HTTP and the real runner. Only `npm` and `systemctl`
// are stand-in programs (a script each, first on the path); the health check talks to a small server that answers
// from the checkout's VERSION file, so "the new version does not come up" can be arranged by committing it.

const dirs = [];
const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const BACKUP = `import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const dest = process.argv[process.argv.indexOf('--dest') + 1];
const folder = join(dest, 'snap-' + Date.now());
mkdirSync(folder, { recursive: true });
process.stdout.write('Snapshot ' + folder + '\\n');
`;
const RESTORE = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_LOG, 'restore ' + process.argv[2] + ' ' + process.argv[3] + '\\n');
`;
const NPM = `#!/bin/sh
echo "npm $*" >> "$STUB_LOG"
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  if grep -q badbuild VERSION; then echo "tsc: error" >&2; exit 1; fi
  mkdir -p dist; cp VERSION dist/built
fi
exit 0
`;
const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >> "$STUB_LOG"
exit 0
`;

async function world() {
  const base = mkdtempSync(join(tmpdir(), 'caci-deploy-'));
  dirs.push(base);
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  const app = join(base, 'app');
  const bin = join(base, 'bin');
  const log = join(base, 'stub.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), NPM);
  writeFileSync(join(bin, 'systemctl'), SYSTEMCTL);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  writeFileSync(log, '');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  execFileSync('git', ['clone', origin, work], { env: GIT_ENV, stdio: 'ignore' });
  mkdirSync(join(work, 'scripts'));
  writeFileSync(join(work, 'scripts', 'backup.mjs'), BACKUP);
  writeFileSync(join(work, 'scripts', 'restore.mjs'), RESTORE);
  writeFileSync(join(work, '.gitignore'), 'dist/\n');
  writeFileSync(join(work, 'VERSION'), 'good-1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'first');
  git(work, 'push', 'origin', 'main');
  execFileSync('git', ['clone', origin, app], { env: GIT_ENV, stdio: 'ignore' });
  const first = git(app, 'rev-parse', 'HEAD');

  const server = createServer((req, res) => {
    const version = readFileSync(join(app, 'VERSION'), 'utf8');
    if (version.includes('badhealth')) return void res.writeHead(500).end('broken');
    if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html></html>');
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }).end('{"error":{"code":"UNAUTHENTICATED"}}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;

  const layout = { ...LAYOUT, user: undefined, appDir: app, dataDir: join(base, 'data'), envFile: join(base, 'caci.env'), backupDir: join(base, 'backups') };
  writeFileSync(layout.envFile, `CACI_PORT=${port}\nCACI_ALLOWED_HOSTS=127.0.0.1:${port}\nANTHROPIC_API_KEY=sk-ant-api03-integrationkey1234567890\n`);
  const run = createRunner({ execFileFn: (file, args, options, cb) => execFile(file, args, { ...options, env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log } }, cb) });
  const out = [];
  const err = [];
  const deploy = (argv) => main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), layout, run, isRoot: true, hostOptions: { healthDeadlineMs: 2500, healthEveryMs: 50 } });
  const push = (version, extra = {}) => {
    writeFileSync(join(work, 'VERSION'), `${version}\n`);
    for (const [f, c] of Object.entries(extra)) writeFileSync(join(work, f), c);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', version);
    git(work, 'push', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const tag = (name) => {
    git(work, 'tag', name);
    git(work, 'push', 'origin', name);
  };
  return { app, layout, log, first, tag, deploy, push, out, err, head: () => git(app, 'rev-parse', 'HEAD'), logText: () => readFileSync(log, 'utf8'), built: () => readFileSync(join(app, 'dist', 'built'), 'utf8').trim() };
}

describe('a whole deploy over a real git repository', () => {
  it('pulls the new commit, builds, restarts, checks health and says so (exit 0)', async () => {
    const w = await world();
    const next = w.push('good-2');
    expect(await w.deploy([])).toBe(0);
    expect(w.head()).toBe(next);
    expect(w.built()).toBe('good-2');
    const log = w.logText();
    expect(log).toContain('npm ci');
    expect(log).toContain('npm run build');
    expect(log).toContain('systemctl restart caci.service');
    expect(log).not.toContain('restore');
    expect(readdirSync(w.layout.backupDir)).toHaveLength(1);
    expect(w.out.join('')).toContain('Deployed origin/main');
  }, 30_000);

  it('a build that fails leaves the old commit in place, rebuilt, and the service never restarted (exit 10)', async () => {
    const w = await world();
    w.push('badbuild');
    expect(await w.deploy([])).toBe(10);
    expect(w.head()).toBe(w.first);
    expect(w.built()).toBe('good-1');
    expect(w.logText()).not.toContain('systemctl');
    expect(w.logText()).not.toContain('restore');
  }, 30_000);

  it('a version that does not come up is rolled back with its data restored, and the old one answers again (exit 10)', async () => {
    const w = await world();
    w.push('badhealth');
    expect(await w.deploy(['main'])).toBe(10);
    expect(w.head()).toBe(w.first);
    expect(w.built()).toBe('good-1');
    const lines = w.logText().trim().split('\n');
    const snapshot = readdirSync(w.layout.backupDir)[0];
    expect(lines.filter((l) => l.startsWith('systemctl')).map((l) => l.split(' ')[1])).toEqual(['restart', 'stop', 'start']);
    expect(lines.find((l) => l.startsWith('restore'))).toContain(join(w.layout.backupDir, snapshot));
    expect(lines.find((l) => l.startsWith('restore'))).toMatch(/--yes$/);
  }, 30_000);

  it('a ref that does not exist changes nothing and does not restart (exit 10)', async () => {
    const w = await world();
    expect(await w.deploy(['no-such-branch'])).toBe(10);
    expect(w.head()).toBe(w.first);
    expect(w.logText()).not.toContain('systemctl');
    expect(w.out.join('')).toContain('no-such-branch');
  }, 30_000);

  it('a tag and a commit id can be deployed too', async () => {
    const w = await world();
    const next = w.push('good-2');
    w.tag('v2');
    expect(await w.deploy(['v2'])).toBe(0);
    expect(w.head()).toBe(next);
    const later = w.push('good-3');
    expect(await w.deploy([later])).toBe(0);
    expect(w.head()).toBe(later);
    expect(w.built()).toBe('good-3');
  }, 30_000);

  it('local changes in the checkout refuse the deploy before anything happens (exit 12)', async () => {
    const w = await world();
    writeFileSync(join(w.app, 'VERSION'), 'hand edited\n');
    w.push('good-2');
    expect(await w.deploy([])).toBe(12);
    expect(existsSync(w.layout.backupDir)).toBe(false);
    expect(w.logText()).toBe('');
    expect(readFileSync(join(w.app, 'VERSION'), 'utf8')).toBe('hand edited\n');
  }, 30_000);

  it('a ref that tries to be a git option is refused and nothing is run', async () => {
    const w = await world();
    const marker = join(w.layout.appDir, '..', 'pwned');
    expect(await w.deploy([`--upload-pack=touch ${marker}`])).toBe(12);
    expect(await w.deploy([`x;touch ${marker}`])).toBe(12);
    expect(existsSync(marker)).toBe(false);
    expect(w.logText()).toBe('');
  }, 30_000);

  it('never prints the key', async () => {
    const w = await world();
    w.push('badhealth');
    await w.deploy([]);
    expect(w.out.join('') + w.err.join('')).not.toContain('integrationkey');
  }, 30_000);
});
