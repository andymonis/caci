import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServiceConfig, VARIABLES } from '../src/service/config.ts';
import { parseEnvFile } from './envfile.mjs';
import { LAYOUT } from './layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

/** A systemd unit as { section: { Key: [values...] } } (a key may repeat). */
export function parseUnit(text) {
  const unit = {};
  let section;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head !== null) {
      section = head[1];
      unit[section] ??= {};
      continue;
    }
    const kv = /^(\w+)=(.*)$/.exec(line);
    if (kv === null || section === undefined) throw new Error(`cannot read the unit line: ${line}`);
    (unit[section][kv[1]] ??= []).push(kv[2]);
  }
  return unit;
}
const one = (unit, section, key) => {
  const values = unit[section]?.[key];
  expect(values, `${section}/${key}`).toBeDefined();
  expect(values, `${section}/${key} is set once`).toHaveLength(1);
  return values[0];
};
const words = (text) => text.split(/\s+/).filter(Boolean);

const service = parseUnit(read('caci.service'));
const backup = parseUnit(read('caci-backup.service'));
const timer = parseUnit(read('caci-backup.timer'));
const HARDENING = { NoNewPrivileges: 'true', ProtectSystem: 'strict', ProtectHome: 'true', PrivateTmp: 'true', PrivateDevices: 'true', ProtectKernelTunables: 'true', ProtectKernelModules: 'true', ProtectControlGroups: 'true', LockPersonality: 'true', RestrictSUIDSGID: 'true', SystemCallArchitectures: 'native', CapabilityBoundingSet: '', UMask: '0077' };

describe('the layout and the files agree', () => {
  it('the unit names in the layout are files beside it', () => {
    for (const name of [LAYOUT.service, LAYOUT.backupService, LAYOUT.backupTimer, 'caci.env.example']) expect(existsSync(join(here, name)), name).toBe(true);
  });
  it('the layout is frozen, absolute and has the paths R-010 names', () => {
    expect(Object.isFrozen(LAYOUT)).toBe(true);
    expect(LAYOUT).toMatchObject({ user: 'caci', appDir: '/opt/caci/app', dataDir: '/var/lib/caci', envFile: '/etc/caci/caci.env', backupDir: '/var/backups/caci', keep: 14, defaultPort: 8080, defaultRef: 'origin/main' });
    for (const p of [LAYOUT.appDir, LAYOUT.dataDir, LAYOUT.envFile, LAYOUT.backupDir]) expect(p.startsWith('/')).toBe(true);
  });
});

describe('the service unit', () => {
  it('runs as the service account from the checkout, with the settings file, and node directly (never npm)', () => {
    expect(one(service, 'Service', 'User')).toBe(LAYOUT.user);
    expect(one(service, 'Service', 'Group')).toBe(LAYOUT.user);
    expect(one(service, 'Service', 'WorkingDirectory')).toBe(LAYOUT.appDir);
    expect(one(service, 'Service', 'EnvironmentFile')).toBe(LAYOUT.envFile); // no leading "-": a missing file stops the start
    const exec = one(service, 'Service', 'ExecStart');
    expect(exec).toContain('node scripts/serve.mjs');
    expect(exec).not.toMatch(/npm|build/);
    expect(one(service, 'Service', 'Type')).toBe('simple');
  });
  it('restarts after a failure and starts at boot after the network is up', () => {
    expect(one(service, 'Service', 'Restart')).toBe('on-failure');
    expect(Number(one(service, 'Service', 'RestartSec'))).toBeGreaterThanOrEqual(1);
    expect(one(service, 'Install', 'WantedBy')).toBe('multi-user.target');
    expect(one(service, 'Unit', 'After')).toContain('network-online.target');
    expect(one(service, 'Unit', 'Wants')).toContain('network-online.target');
  });
  it('gives a clean close time to finish, and no more than a minute', () => {
    const t = Number(one(service, 'Service', 'TimeoutStopSec'));
    expect(t).toBeGreaterThanOrEqual(10);
    expect(t).toBeLessThanOrEqual(60);
  });
  it('is hardened, and may write only to the data folder', () => {
    for (const [key, value] of Object.entries(HARDENING)) expect(one(service, 'Service', key), key).toBe(value);
    expect(words(one(service, 'Service', 'ReadWritePaths'))).toEqual([LAYOUT.dataDir]);
    expect(words(one(service, 'Service', 'RestrictAddressFamilies')).sort()).toEqual(['AF_INET', 'AF_INET6', 'AF_UNIX']);
  });
  it('does not allow memory that is both writable and executable to be forbidden (node needs its JIT)', () => {
    expect(service.Service.MemoryDenyWriteExecute).toBeUndefined();
  });
});

describe('the backup unit and timer', () => {
  it('a one-shot as the service account that takes a snapshot into the backup folder, keeping the layout\'s number', () => {
    expect(one(backup, 'Service', 'Type')).toBe('oneshot');
    expect(one(backup, 'Service', 'User')).toBe(LAYOUT.user);
    expect(one(backup, 'Service', 'WorkingDirectory')).toBe(LAYOUT.appDir);
    expect(one(backup, 'Service', 'ExecStart')).toBe(`/usr/bin/env node scripts/backup.mjs --dest ${LAYOUT.backupDir} --keep ${LAYOUT.keep}`);
    expect(one(backup, 'Service', 'Environment')).toBe(`CACI_DATA_DIR=${LAYOUT.dataDir}`);
  });
  it('never loads the settings file, so the process never sees the key', () => {
    expect(backup.Service.EnvironmentFile).toBeUndefined();
    expect(read('caci-backup.service')).not.toMatch(/ANTHROPIC|KEY|TOKEN|SECRET/i);
  });
  it('is hardened, may write only to the data and backup folders, and reaches no network', () => {
    for (const [key, value] of Object.entries(HARDENING)) expect(one(backup, 'Service', key), key).toBe(value);
    expect(words(one(backup, 'Service', 'ReadWritePaths')).sort()).toEqual([LAYOUT.backupDir, LAYOUT.dataDir].sort());
    expect(one(backup, 'Service', 'RestrictAddressFamilies')).toBe('AF_UNIX');
  });
  it('the timer runs it every night, makes up a missed night, and names the right unit', () => {
    expect(one(timer, 'Timer', 'OnCalendar')).toMatch(/^\*-\*-\* 0[0-5]:\d\d:00$/);
    expect(one(timer, 'Timer', 'Persistent')).toBe('true');
    expect(one(timer, 'Timer', 'Unit')).toBe(LAYOUT.backupService);
    expect(one(timer, 'Install', 'WantedBy')).toBe('timers.target');
    expect(one(timer, 'Timer', 'RandomizedDelaySec')).toMatch(/^\d+min$/);
  });
});

describe('no unit sets the key or the settings itself', () => {
  it.each(['caci.service', 'caci-backup.service', 'caci-backup.timer'])('%s has no Environment= with a secret, and no inline key', (name) => {
    const text = read(name);
    expect(text).not.toMatch(/sk-ant/i);
    for (const line of text.split('\n')) if (/^Environment=/.test(line)) expect(line).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
  });
});

describe('the unit parser used above', () => {
  it('reads sections, comments and repeated keys, and refuses a line it cannot read', () => {
    expect(parseUnit('[A]\n# c\nX=1\nX=2\nY=\n[B]\nZ=a b')).toEqual({ A: { X: ['1', '2'], Y: [''] }, B: { Z: ['a b'] } });
    expect(() => parseUnit('[A]\nnot a line')).toThrow();
    expect(() => parseUnit('X=1')).toThrow();
  });
});

describe('the example settings file', () => {
  const text = read('caci.env.example');
  const settings = parseEnvFile(text);
  const KEY = 'sk-ant-api03-' + 'x'.repeat(40);

  it('is valid configuration for the service once the key is filled in, and names the Pi layout', () => {
    const parsed = parseServiceConfig({ ...settings, ANTHROPIC_API_KEY: KEY });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.value).toMatchObject({ port: 8080, bind: '0.0.0.0', dataDir: LAYOUT.dataDir, allowInsecure: true, cookieSecure: false, trustedProxies: 0, llm: 'anthropic', allowRegistration: true });
    expect(parsed.value.allowedHosts).toEqual(['pi.local:8080', '192.168.1.50:8080']);
  });
  it('the service refuses to start until the key is set (so a forgotten key is loud, not silent)', () => {
    const parsed = parseServiceConfig({ ...settings });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.error)).toContain('ANTHROPIC_API_KEY');
  });
  it('holds no secret: the key line is empty and nothing looks like a key', () => {
    expect(settings.ANTHROPIC_API_KEY).toBe('');
    expect(text).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
  });
  it('uses only names the service reads (and the key), and the data folder is the layout\'s', () => {
    for (const name of Object.keys(settings)) expect(name === 'ANTHROPIC_API_KEY' || [...VARIABLES].includes(name), name).toBe(true);
    for (const m of text.matchAll(/^#\s*(CACI_[A-Z_]+)=/gm)) expect([...VARIABLES], m[1]).toContain(m[1]);
    expect(settings.CACI_DATA_DIR).toBe(LAYOUT.dataDir);
  });
  it('is in the systemd format: KEY=VALUE, no export, no spaces around the equals sign, no quotes', () => {
    for (const line of text.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue;
      expect(line, line).toMatch(/^[A-Z_]+=[^\s"']*$/);
    }
  });
  it('holds a commented tailnet block: uncommented, it is valid and lists the home names and the tailnet name, each with its port (R-010 D14, D-AC-12)', () => {
    const block = text.split('\n').find((l) => /^#\s*CACI_ALLOWED_HOSTS=.*ts\.net/.test(l));
    expect(block).toBeDefined();
    const uncommented = text.split('\n').map((l) => (l === block ? l.replace(/^#\s*/, '') : l.startsWith('CACI_ALLOWED_HOSTS=') ? `# ${l}` : l)).join('\n');
    const parsed = parseServiceConfig({ ...parseEnvFile(uncommented), ANTHROPIC_API_KEY: KEY });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.value.allowedHosts).toEqual(['pi.local:8080', '192.168.1.50:8080', 'pi.your-tailnet.ts.net:8080']);
    expect(parsed.value).toMatchObject({ port: 8080, bind: '0.0.0.0', cookieSecure: false, trustedProxies: 0, allowInsecure: true });
    for (const host of parsed.value.allowedHosts) expect(host).toMatch(/^[a-z0-9.-]+:8080$/);
  });
  it('the tailnet block says nothing else changes, names the restart, the runbook step and that Funnel is never used', () => {
    for (const phrase of ['Away from home with Tailscale (runbook step 13)', 'sudo systemctl restart caci', 'Nothing else changes', 'Never use Tailscale Funnel']) expect(text, phrase).toContain(phrase);
    expect(text.split('\n').filter((l) => /^CACI_ALLOWED_HOSTS=/.test(l))).toHaveLength(1);
    expect(settings.CACI_ALLOWED_HOSTS).toBe('pi.local:8080,192.168.1.50:8080');
    expect(settings.CACI_BIND).toBe('0.0.0.0');
    expect(settings.CACI_COOKIE_SECURE).toBe('false');
  });
  it('says plainly what leaves the house and what to change', () => {
    expect(text).toContain('go to Anthropic, unanonymised');
    expect(text).toContain('CHANGE THESE');
    expect(text).toContain('register yourself first');
  });
});
