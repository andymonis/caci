import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each test builds a real git repository and runs bash; under the load of the whole gate that can pass five seconds.
vi.setConfig({ testTimeout: 60_000 });
import { LAYOUT } from './layout.mjs';

// install.sh run for real in a scratch folder: every path is put under CACI_INSTALL_ROOT, and the few commands that need
// root (useradd, runuser, systemctl, getent, and `install -o/-g`) are stand-in scripts that log what they were asked.
// git, cmp, node and the rest are the real programs.

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'install.sh');
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

const STUBS = {
  useradd: '#!/bin/sh\necho "useradd $*" >> "$STUB_LOG"\ntouch "$STUB_STATE/user"\n',
  getent: '#!/bin/sh\n[ -e "$STUB_STATE/user" ]\n',
  runuser: '#!/bin/sh\necho "runuser $*" >> "$STUB_LOG"\nshift 3\nexec "$@"\n', // runuser -u caci -- cmd...
  systemctl: '#!/bin/sh\necho "systemctl $*" >> "$STUB_LOG"\ncase "$1" in\n  enable) shift; for u in "$@"; do touch "$STUB_STATE/enabled-$u"; done ;;\n  is-enabled) shift; shift; [ -e "$STUB_STATE/enabled-$1" ]; exit $? ;;\nesac\nexit 0\n',
  // install without the ownership options (a test cannot chown to another account)
  install: '#!/bin/sh\necho "install $*" >> "$STUB_LOG"\nargs=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in -o|-g) shift 2 ;; *) args="$args \\"$1\\""; shift ;; esac\ndone\neval "exec /usr/bin/install $args"\n',
};

function world() {
  const base = mkdtempSync(join(tmpdir(), 'caci-install-'));
  dirs.push(base);
  const bin = join(base, 'bin');
  const state = join(base, 'state');
  const root = join(base, 'root');
  const log = join(base, 'stub.log');
  for (const d of [bin, state, root]) mkdirSync(d);
  writeFileSync(log, '');
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  // the repository the script clones: the project's real deploy files
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed], { env: { ...process.env, ...GIT_ENV } });
  mkdirSync(join(seed, 'deploy'));
  for (const f of ['caci.service', 'caci-backup.service', 'caci-backup.timer', 'caci.env.example']) cpSync(join(here, f), join(seed, 'deploy', f));
  execFileSync('git', ['-C', seed, 'add', '-A'], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'x'], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main'], { env: { ...process.env, ...GIT_ENV } });
  const env = (extra = {}) => ({ ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_STATE: state, CACI_INSTALL_ROOT: root, CACI_INSTALL_ASSUME_ROOT: '1', ...extra });
  const run = (args = [], extra = {}) => {
    const r = spawnSync('bash', [SCRIPT, '--repo', origin, ...args], { env: env(extra), encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const at = (p) => join(root, p);
  const mode = (p) => statSync(at(p)).mode & 0o777;
  const logLines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const clearLog = () => writeFileSync(log, '');
  return { base, root, origin, seed, run, at, mode, logLines, clearLog, env, state };
}
/** Every file and folder under a path, with mode and (for files) content, so "nothing changed" is a comparison. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      out[p.slice(dir.length)] = `${(st.mode & 0o777).toString(8)}${st.isDirectory() ? '' : `:${readFileSync(p, 'base64')}`}`;
      if (st.isDirectory() && name !== '.git') walk(p);
    }
  };
  walk(dir);
  return out;
}

describe('the arguments', () => {
  it('--help prints the usage and exits 0', () => {
    const w = world();
    const r = w.run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: sudo bash deploy/install.sh');
  });
  it.each([[['--nope']], [['--repo']], [['--repo', '-x']], [['--repo', 'a b']], [['--deploy-key']], [['--deploy-key', '/no/such/file']], [['extra']]])('%j is refused with the usage and exit 2, changing nothing', (args) => {
    const w = world();
    const r = spawnSync('bash', [SCRIPT, ...args], { env: w.env(), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
    expect(readdirSync(w.root)).toEqual([]);
    expect(w.logLines()).toEqual([]);
  });
});

describe('who may run it', () => {
  it('a real run by someone who is not root is refused, before anything changes', () => {
    if (process.getuid?.() === 0) return;
    const w = world();
    const r = w.run([], { CACI_INSTALL_ASSUME_ROOT: '' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('as root');
    expect(readdirSync(w.root)).toEqual([]);
    expect(w.logLines()).toEqual([]);
  });
  it('a missing tool is named', () => {
    const w = world();
    const r = spawnSync('bash', [SCRIPT, '--dry-run'], { env: { ...w.env(), PATH: `${join(w.base, 'bin')}:/usr/bin:/bin`.replace('/usr/bin', '/nonexistent') }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is needed and was not found/);
  });
});

describe('Node', () => {
  it('a Node older than 22.13 stops the install before anything changes, saying which was found', () => {
    const w = world();
    writeFileSync(join(w.base, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v20.1.0; exit 0; fi\nexit 1\n');
    chmodSync(join(w.base, 'bin', 'node'), 0o755);
    const r = w.run();
    expect(r.code).toBe(1);
    expect(r.err).toContain('Node 22.13 or later');
    expect(r.err).toContain('v20.1.0');
    expect(readdirSync(w.root)).toEqual([]);
    expect(w.logLines()).toEqual([]);
  });
});

describe('a dry run', () => {
  it('prints what it would do and changes nothing, even for someone who is not root', () => {
    const w = world();
    const r = w.run(['--dry-run'], { CACI_INSTALL_ASSUME_ROOT: '' });
    expect(r.code).toBe(0);
    const would = r.out.split('\n').filter((l) => l.startsWith('would: '));
    expect(would.length).toBeGreaterThan(10);
    expect(would.some((l) => l.includes('useradd --system --user-group'))).toBe(true);
    expect(would.some((l) => l.includes('git clone'))).toBe(true);
    expect(would.some((l) => l.includes('systemctl daemon-reload'))).toBe(true);
    expect(would.some((l) => l.includes('systemctl enable caci.service'))).toBe(true);
    expect(readdirSync(w.root)).toEqual([]);
    expect(w.logLines().filter((l) => !l.startsWith('systemctl is-enabled'))).toEqual([]);
  });
  it('every action it announces is one of a short list of verbs', () => {
    const r = world().run(['--dry-run']);
    for (const line of r.out.split('\n').filter((l) => l.startsWith('would: '))) expect(line, line).toMatch(/^would: (useradd|install|runuser|systemctl)\b/);
  });
});

describe('a real run', () => {
  it('creates the account, the folders with their modes, the checkout, the units and the settings file, and enables but does not start', () => {
    const w = world();
    const r = w.run();
    expect(r.code, r.err).toBe(0);
    const log = w.logLines();
    expect(log.filter((l) => l.startsWith('useradd'))).toEqual([`useradd --system --user-group --home-dir ${LAYOUT.appDir.replace('/app', '')} --shell /usr/sbin/nologin caci`]);
    expect(w.mode(LAYOUT.dataDir)).toBe(0o700);
    expect(w.mode(LAYOUT.backupDir)).toBe(0o700);
    expect(w.mode('/etc/caci')).toBe(0o750);
    expect(w.mode('/opt/caci')).toBe(0o755);
    expect(existsSync(w.at(`${LAYOUT.appDir}/.git`))).toBe(true);
    for (const unit of [LAYOUT.service, LAYOUT.backupService, LAYOUT.backupTimer]) {
      expect(readFileSync(w.at(`/etc/systemd/system/${unit}`), 'utf8')).toBe(readFileSync(join(here, unit), 'utf8'));
      expect(w.mode(`/etc/systemd/system/${unit}`)).toBe(0o644);
    }
    expect(readFileSync(w.at(LAYOUT.envFile), 'utf8')).toBe(readFileSync(join(here, 'caci.env.example'), 'utf8'));
    expect(w.mode(LAYOUT.envFile)).toBe(0o640);
    expect(log).toContain('systemctl daemon-reload');
    expect(log).toContain('systemctl enable caci.service');
    expect(log).toContain('systemctl enable caci-backup.timer');
    expect(log.some((l) => /systemctl (start|restart)/.test(l))).toBe(false);
    expect(log.some((l) => l.startsWith('runuser -u caci -- git clone'))).toBe(true);
  });
  it('says what is left to do, by hand, including the key, the allowed hosts and registering first', () => {
    const r = world().run();
    for (const phrase of ['ANTHROPIC_API_KEY', 'CACI_ALLOWED_HOSTS', 'systemctl start caci', 'npm run doctor', 'Register yourself first', 'caci-backup.timer', 'deploy/run.mjs']) expect(r.out, phrase).toContain(phrase);
  });
  it('the settings file is the example, which holds no key', () => {
    const w = world();
    w.run();
    expect(readFileSync(w.at(LAYOUT.envFile), 'utf8')).toMatch(/^ANTHROPIC_API_KEY=$/m);
  });
});

describe('running it again', () => {
  it('changes nothing: no new account, clone, reload or enable, and every file is as it was', () => {
    const w = world();
    expect(w.run().code).toBe(0);
    const before = snapshot(w.root);
    w.clearLog();
    const again = w.run();
    expect(again.code, again.err).toBe(0);
    expect(snapshot(w.root)).toEqual(before);
    const verbs = w.logLines().filter((l) => /^(useradd|systemctl (daemon-reload|enable)|runuser)/.test(l));
    expect(verbs).toEqual([]);
    expect(again.out).toContain('ok: the account caci exists');
    expect(again.out).toContain('ok: caci.service is up to date');
    expect(again.out).toContain('(not touched)');
  });
  it('never overwrites a settings file the owner has edited, nor touches data or snapshots', () => {
    const w = world();
    w.run();
    writeFileSync(w.at(LAYOUT.envFile), 'ANTHROPIC_API_KEY=sk-ant-api03-mine1234567890\nCACI_PORT=9999\n');
    writeFileSync(w.at(`${LAYOUT.dataDir}/graphs.db`), 'precious');
    mkdirSync(w.at(`${LAYOUT.backupDir}/20261011T020000Z`));
    expect(w.run().code).toBe(0);
    expect(readFileSync(w.at(LAYOUT.envFile), 'utf8')).toContain('CACI_PORT=9999');
    expect(readFileSync(w.at(`${LAYOUT.dataDir}/graphs.db`), 'utf8')).toBe('precious');
    expect(existsSync(w.at(`${LAYOUT.backupDir}/20261011T020000Z`))).toBe(true);
  });
  it('a unit that changed in the checkout is updated and the manager reloaded; the others are left alone', () => {
    const w = world();
    w.run();
    writeFileSync(w.at(`${LAYOUT.appDir}/deploy/caci.service`), `${readFileSync(w.at(`${LAYOUT.appDir}/deploy/caci.service`), 'utf8')}# changed\n`);
    w.clearLog();
    const r = w.run();
    expect(r.code).toBe(0);
    expect(readFileSync(w.at(`/etc/systemd/system/${LAYOUT.service}`), 'utf8')).toContain('# changed');
    const installs = w.logLines().filter((l) => l.startsWith('install') && l.includes('/etc/systemd/system/'));
    expect(installs).toHaveLength(1);
    expect(w.logLines()).toContain('systemctl daemon-reload');
  });
  it('a checkout without a unit file is a clear failure, not a half install', () => {
    const w = world();
    w.run();
    rmSync(w.at(`${LAYOUT.appDir}/deploy/caci-backup.timer`));
    rmSync(w.at(`/etc/systemd/system/${LAYOUT.backupTimer}`));
    const r = w.run();
    expect(r.code).toBe(1);
    expect(r.err).toContain('deploy/caci-backup.timer');
  });
});

describe('a deploy key for a private repository', () => {
  it('is copied once, owner-only, never printed, and set as the checkout\'s ssh command; a second key does not replace it', () => {
    const w = world();
    const key = join(w.base, 'mykey');
    writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n');
    const r = w.run(['--deploy-key', key]);
    expect(r.code, r.err).toBe(0);
    expect(w.mode('/opt/caci/.ssh')).toBe(0o700);
    expect(w.mode('/opt/caci/.ssh/deploy_key')).toBe(0o600);
    expect(readFileSync(w.at('/opt/caci/.ssh/deploy_key'), 'utf8')).toContain('SECRETKEYMATERIAL');
    expect(r.out + r.err).not.toContain('SECRETKEYMATERIAL');
    const config = execFileSync('git', ['-C', w.at(LAYOUT.appDir), 'config', 'core.sshCommand'], { encoding: 'utf8' });
    expect(config).toContain('-i /opt/caci/.ssh/deploy_key');
    expect(config).toContain('IdentitiesOnly=yes');
    writeFileSync(key, 'ANOTHER');
    const again = w.run(['--deploy-key', key]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('not replaced');
    expect(readFileSync(w.at('/opt/caci/.ssh/deploy_key'), 'utf8')).toContain('SECRETKEYMATERIAL');
  });
  it('without a key, no .ssh folder is made', () => {
    const w = world();
    w.run();
    expect(existsSync(w.at('/opt/caci/.ssh'))).toBe(false);
  });
});

describe('the script itself', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });
  it('stops at the first error and on unset variables', () => {
    expect(text).toContain('set -euo pipefail');
  });
  it('downloads nothing to run, runs no eval, and makes nothing world-writable or recursive', () => {
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const bad of [/\bcurl\b/, /\bwget\b/, /\|\s*(ba)?sh\b/, /\beval\b/, /chmod\s+(-R\s+)?[0-7]*[2367][0-7]?\b/, /chmod\s+-R/, /\bchown\s+-R/, /0\.0\.0\.0/, /777/]) expect(code, String(bad)).not.toMatch(bad);
  });
  it('uses no mode that is writable by group or others', () => {
    for (const m of text.matchAll(/-m\s+(0[0-7]{3})\b/g)) expect(Number.parseInt(m[1], 8) & 0o022, m[1]).toBe(0);
  });
  it('agrees with the layout on every path and name', () => {
    const v = (name) => new RegExp(`^${name}=(\\S+)$`, 'm').exec(text)?.[1];
    expect(v('APP_USER')).toBe(LAYOUT.user);
    expect(v('APP_DIR')).toBe(LAYOUT.appDir);
    expect(v('DATA_DIR')).toBe(LAYOUT.dataDir);
    expect(v('ENV_FILE')).toBe(LAYOUT.envFile);
    expect(v('BACKUP_DIR')).toBe(LAYOUT.backupDir);
    expect(/^UNITS=\((.*)\)$/m.exec(text)?.[1].split(/\s+/)).toEqual([LAYOUT.service, LAYOUT.backupService, LAYOUT.backupTimer]);
    expect(LAYOUT.envFile.startsWith(`${v('ENV_DIR')}/`)).toBe(true);
    expect(LAYOUT.appDir.startsWith(`${v('APP_HOME')}/`)).toBe(true);
  });
  it('is executable', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});
