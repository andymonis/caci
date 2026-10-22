import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServiceConfig } from '../src/service/config.ts';
import { loadCheckTexts, loadControlsFolder, loadPulseText } from '../src/service/controls-files.ts';
import { shippedFiles } from '../src/llm/testing/shipped-controls.test-util.ts';
import { createProbes } from './doctor-host.mjs';
import { LAYOUT } from './layout.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const OK = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', detail: stdout.trim() });
const FAIL = () => ({ ok: false, code: 1, stdout: '', stderr: '', detail: 'no' });

function setup(over = {}) {
  const base = mkdtempSync(join(tmpdir(), 'caci-doctor-'));
  dirs.push(base);
  const layout = { ...LAYOUT, appDir: join(base, 'app'), controlsDir: join(base, 'controls'), dataDir: join(base, 'data'), envFile: join(base, 'caci.env'), backupDir: join(base, 'backups') };
  const calls = [];
  const run = over.run ?? (async (file, args) => {
    calls.push([file, ...args].join(' '));
    return OK();
  });
  const probes = createProbes({ layout, run, parseServiceConfig, loadControls: loadControlsFolder, hashOnce: async () => {}, ...over.deps });
  return { base, layout, probes, calls };
}

describe('the controls probe', () => {
  it('reports the folder when the six files are good, with no contents', async () => {
    const { layout, probes } = setup();
    const files = shippedFiles();
    mkdirSync(layout.controlsDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(layout.controlsDir, name.split('/')[0]), { recursive: true });
      writeFileSync(join(layout.controlsDir, ...name.split('/')), text);
    }
    expect(await probes.controls()).toEqual({ ok: true, dir: layout.controlsDir });
  });
  it('reports the problems, naming files, when the folder is bad or missing', async () => {
    const { layout, probes } = setup();
    expect(await probes.controls()).toMatchObject({ ok: false, dir: layout.controlsDir, problems: [expect.stringContaining('does not exist')] });
    const files = { ...shippedFiles(), 'status/system.txt': 'x {{bad}}' };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(layout.controlsDir, name.split('/')[0]), { recursive: true });
      writeFileSync(join(layout.controlsDir, ...name.split('/')), text);
    }
    const r = await probes.controls();
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('status/system.txt'))).toBe(true);
  });
  it('is the real layout\'s controls folder in the checkout', () => {
    expect(LAYOUT.controlsDir).toBe(`${LAYOUT.appDir}/controls`);
  });
});

describe('the controls probe and the pulse text', () => {
  const write = (layout, pulse) => {
    for (const [name, text] of Object.entries(shippedFiles())) {
      mkdirSync(join(layout.controlsDir, name.split('/')[0]), { recursive: true });
      writeFileSync(join(layout.controlsDir, ...name.split('/')), text);
    }
    if (pulse !== undefined) writeFileSync(join(layout.controlsDir, 'pulse.txt'), pulse);
  };
  it('is good with a good pulse file', async () => {
    const { layout, probes } = setup({ deps: { loadPulse: loadPulseText } });
    write(layout, 'Give the circle status.');
    expect(await probes.controls()).toEqual({ ok: true, dir: layout.controlsDir });
  });
  it('with the three check texts, names coming-up.txt or long-range.txt when either is missing', async () => {
    const { layout, probes } = setup({ deps: { loadPulse: loadCheckTexts } });
    write(layout, 'Give the circle status.');
    const r = await probes.controls();
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/^coming-up\.txt: is missing/), expect.stringMatching(/^long-range\.txt: is missing/)]);
    writeFileSync(join(layout.controlsDir, 'coming-up.txt'), 'Month?');
    writeFileSync(join(layout.controlsDir, 'long-range.txt'), 'Year?');
    expect(await probes.controls()).toEqual({ ok: true, dir: layout.controlsDir });
  });
  it('names pulse.txt when it is missing or bad, with the other problems', async () => {
    const { layout, probes } = setup({ deps: { loadPulse: loadPulseText } });
    write(layout, undefined);
    const missing = await probes.controls();
    expect(missing.ok).toBe(false);
    expect(missing.problems.some((p) => p.startsWith('pulse.txt'))).toBe(true);
    writeFileSync(join(layout.controlsDir, 'pulse.txt'), 'two\nlines');
    expect((await probes.controls()).problems).toEqual([expect.stringContaining('pulse.txt: must be one paragraph')]);
  });
});

describe('the settings probe', () => {
  it('reads mode, owner and the parsed configuration, and says only whether the key is set', async () => {
    const { layout, probes } = setup();
    writeFileSync(layout.envFile, 'CACI_PORT=9090\nCACI_BIND=0.0.0.0\nCACI_ALLOW_INSECURE=true\nCACI_ALLOWED_HOSTS=a.local:9090\nCACI_LLM=anthropic\nANTHROPIC_API_KEY=sk-ant-api03-thisIsTheSecretKey1234567890\n');
    chmodSync(layout.envFile, 0o640);
    const s = await probes.settings();
    expect(s).toMatchObject({ exists: true, readable: true, mode: 0o640, keyPresent: true });
    expect(s.config.ok).toBe(true);
    expect(s.config.value).toMatchObject({ port: 9090, llm: 'anthropic', allowedHosts: ['a.local:9090'] });
    expect(JSON.stringify(s)).not.toContain('thisIsTheSecretKey');
  });
  it('reports a missing key, invalid settings (by name, no values) and a missing file', async () => {
    const { layout, probes } = setup();
    writeFileSync(layout.envFile, 'CACI_LLM=anthropic\nANTHROPIC_API_KEY=\nCACI_PORT=banana\n');
    const s = await probes.settings();
    expect(s.keyPresent).toBe(false);
    expect(s.config.ok).toBe(false);
    expect(s.config.errors.map((e) => e.variable)).toContain('CACI_PORT');
    expect(JSON.stringify(s)).not.toContain('banana');
    rmSync(layout.envFile);
    expect(await probes.settings()).toEqual({ exists: false, path: layout.envFile });
  });
  it('an unreadable file is reported as exists but not readable', async () => {
    if (process.getuid?.() === 0) return;
    const { layout, probes } = setup();
    writeFileSync(layout.envFile, 'CACI_PORT=1\n');
    chmodSync(layout.envFile, 0o000);
    const s = await probes.settings();
    chmodSync(layout.envFile, 0o600);
    expect(s).toEqual({ exists: true, readable: false, path: layout.envFile });
  });
});

describe('the data folder probe', () => {
  it('lists the databases with their modes, and the folder\'s mode', async () => {
    const { layout, probes } = setup();
    mkdirSync(layout.dataDir, { mode: 0o700 });
    chmodSync(layout.dataDir, 0o700);
    writeFileSync(join(layout.dataDir, 'users.db'), 'x', { mode: 0o600 });
    writeFileSync(join(layout.dataDir, 'graphs.db'), 'x', { mode: 0o644 });
    chmodSync(join(layout.dataDir, 'graphs.db'), 0o644);
    writeFileSync(join(layout.dataDir, 'graphs.db-wal'), 'x');
    expect(await probes.dataDir()).toEqual({ exists: true, path: layout.dataDir, mode: 0o700, files: [{ name: 'graphs.db', mode: 0o644 }, { name: 'users.db', mode: 0o600 }] });
  });
  it('a missing folder', async () => {
    const { layout, probes } = setup();
    expect(await probes.dataDir()).toEqual({ exists: false, path: layout.dataDir });
  });
});

describe('snapshots, disk and the network', () => {
  it('counts only complete, timestamp-named snapshot folders', async () => {
    const { layout, probes } = setup();
    expect(await probes.snapshots()).toEqual([]);
    for (const name of ['20261010T023000Z', '20261011T023000Z-2', 'pre-restore-20261011', '20261009T023000Z']) mkdirSync(join(layout.backupDir, name), { recursive: true });
    for (const name of ['20261010T023000Z', '20261011T023000Z-2', 'pre-restore-20261011']) for (const f of ['graphs.db', 'users.db']) writeFileSync(join(layout.backupDir, name, f), 'x');
    writeFileSync(join(layout.backupDir, '20261009T023000Z', 'graphs.db'), 'x'); // incomplete
    expect((await probes.snapshots()).sort()).toEqual(['20261010T023000Z', '20261011T023000Z-2']);
  });
  it('free bytes from the data folder\'s file system, and from / when it does not exist yet', async () => {
    const asked = [];
    const { layout, probes } = setup({ deps: { statfs: (p) => (asked.push(p), { bavail: 1000n, bsize: 4096n }) } });
    expect(await probes.freeBytes()).toBe(4_096_000);
    mkdirSync(layout.dataDir);
    await probes.freeBytes();
    expect(asked).toEqual(['/', layout.dataDir]);
  });
  it('only non-loopback IPv4 addresses', async () => {
    const { probes } = setup({ deps: { interfaces: () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], wlan0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.60', internal: false }], eth0: undefined }) } });
    expect(await probes.addresses()).toEqual(['192.168.1.60']);
  });
  it('passes a request to the injected getter unchanged', async () => {
    const seen = [];
    const { probes } = setup({ deps: { get: async (r) => (seen.push(r), { status: 200, headers: {} }) } });
    await probes.get({ address: '1.2.3.4', port: 80, host: 'x:80', path: '/' });
    expect(seen).toEqual([{ address: '1.2.3.4', port: 80, host: 'x:80', path: '/' }]);
  });
});

describe('programs and time', () => {
  it('the commit: short id, commit time, and whether tracked files changed', async () => {
    const cwds = [];
    const run = async (file, args, options) => (cwds.push(options?.cwd), args.includes('--short') ? OK('abc1234\n') : args[0] === 'log' ? OK('1760000000\n') : OK(' M x\n'));
    const { probes, layout } = setup({ run });
    expect(await probes.commit()).toEqual({ sha: 'abc1234', committedAtMs: 1_760_000_000_000, dirty: true });
    expect(cwds).toEqual([layout.appDir, layout.appDir, layout.appDir]);
    const clean = setup({ run: async (f, a) => (a.includes('--short') ? OK('abc1234') : a[0] === 'log' ? OK('1760000000') : OK('')) });
    expect((await clean.probes.commit()).dirty).toBe(false);
    await expect(setup({ run: async () => FAIL() }).probes.commit()).rejects.toThrow();
  });
  it('service state from systemctl', async () => {
    const run = async (file, args) => (args[0] === 'is-active' ? OK('active\n') : FAIL());
    expect(await setup({ run }).probes.serviceState('caci.service')).toEqual({ active: true, enabled: false });
    const down = async (file, args) => (args[0] === 'is-active' ? { ...FAIL(), stdout: 'inactive' } : OK('enabled'));
    expect(await setup({ run: down }).probes.serviceState('caci.service')).toEqual({ active: false, enabled: true });
    const odd = async (file, args) => (args[0] === 'is-active' ? OK('activating\n') : OK());
    expect((await setup({ run: odd }).probes.serviceState('x')).active).toBe(false);
  });
  it('whether the clock is synchronised, or unknown', async () => {
    expect(await setup({ run: async () => OK('yes\n') }).probes.ntpSynced()).toBe(true);
    expect(await setup({ run: async () => OK('no\n') }).probes.ntpSynced()).toBe(false);
    expect(await setup({ run: async () => FAIL() }).probes.ntpSynced()).toBeUndefined();
  });
  it('node: the running version, and whether node:sqlite loads', async () => {
    const { probes } = setup();
    expect(await probes.nodeVersion()).toBe(process.version);
    expect(await probes.sqliteLoads()).toBe(true);
    expect(await setup({ deps: { importSqlite: async () => { throw new Error('no'); } } }).probes.sqliteLoads()).toBe(false);
  });
  it('the time one hash takes, by the clock it is given, hashing a password that is not a real one', async () => {
    let t = 1000;
    const hashed = [];
    const { probes } = setup({ deps: { clock: () => t, hashOnce: async (p) => { hashed.push(p); t += 345; } } });
    expect(await probes.hashMs()).toBe(345);
    expect(hashed).toEqual(['doctor timing password 123']);
  });
  it('now', async () => {
    expect(await setup({ deps: { now: () => 42 } }).probes.nowMs()).toBe(42);
  });
});
