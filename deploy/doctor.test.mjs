import { describe, expect, it } from 'vitest';
import { EXAMPLE_HOSTS, runDoctor, snapshotTime } from './doctor.mjs';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const PAGE = { status: 200, headers: { 'content-type': 'text/html' } };
const API = { status: 401, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } };
const config = (extra = {}) => ({ ok: true, value: { port: 8080, bind: '0.0.0.0', llm: 'anthropic', allowRegistration: false, allowedHosts: ['kitchen.local:8080', '192.168.1.60:8080'], ...extra } });

/** Probes for a healthy Pi; each test changes what it is about. */
function good(over = {}) {
  const asked = [];
  const probes = {
    nodeVersion: async () => 'v22.19.0',
    sqliteLoads: async () => true,
    commit: async () => ({ sha: 'abc1234', committedAtMs: NOW - 86_400_000, dirty: false }),
    settings: async () => ({ exists: true, readable: true, path: '/etc/caci/caci.env', mode: 0o640, uid: 0, config: config(), keyPresent: true }),
    controls: async () => ({ ok: true, dir: '/opt/caci/app/controls' }),
    dataDir: async () => ({ exists: true, path: '/var/lib/caci', mode: 0o700, files: [{ name: 'graphs.db', mode: 0o600 }, { name: 'users.db', mode: 0o600 }] }),
    serviceState: async () => ({ active: true, enabled: true }),
    addresses: async () => ['192.168.1.60'],
    get: async (r) => {
      asked.push(r);
      if (r.host.startsWith('doctor-check.invalid')) return { status: 403, headers: {} };
      return r.path === '/' ? PAGE : API;
    },
    snapshots: async () => ['20261010T023000Z', '20261009T023000Z'],
    freeBytes: async () => 8 * 1024 ** 3,
    nowMs: async () => NOW,
    ntpSynced: async () => true,
    hashMs: async () => 120,
    ...over,
  };
  return { probes, asked };
}
async function doctor(over) {
  const { probes, asked } = good(over);
  const lines = [];
  const result = await runDoctor({ probes, log: (l) => lines.push(l) });
  return { ...result, lines, text: lines.join('\n'), asked };
}
const statusOf = (r, name) => r.results.find((x) => x.name === name)?.status;

describe('a healthy Pi', () => {
  it('passes everything, exits 0, and says so in a summary line', async () => {
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.results.every((x) => x.status === 'pass'), r.text).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^\d+ passed, 0 warnings, 0 failed\.$/);
    expect(r.lines.filter((l) => l.startsWith('[')).length).toBe(r.results.length);
  });
  it('asks the service on this machine and on its network address, with each allowed Host and one that is not listed', async () => {
    const r = await doctor();
    const asks = r.asked.map((a) => `${a.address}|${a.host}|${a.path}`);
    expect(asks).toContain('127.0.0.1|kitchen.local:8080|/');
    expect(asks).toContain('127.0.0.1|kitchen.local:8080|/api/me');
    expect(asks).toContain('192.168.1.60|kitchen.local:8080|/');
    expect(asks).toContain('192.168.1.60|192.168.1.60:8080|/');
    expect(asks).toContain('192.168.1.60|doctor-check.invalid:8080|/');
  });
});

describe('Node', () => {
  it('too old, or no node:sqlite', async () => {
    expect(statusOf(await doctor({ nodeVersion: async () => 'v20.1.0' }), 'Node')).toBe('fail');
    expect(statusOf(await doctor({ sqliteLoads: async () => false }), 'Node')).toBe('fail');
    const r = await doctor({ nodeVersion: async () => 'v18.0.0' });
    expect(r.code).toBe(1);
    expect(r.text).toContain('-> Install Node 22');
  });
});

describe('the LLM controls', () => {
  it('load: one pass line naming the folder', async () => {
    const r = await doctor();
    expect(r.results.find((x) => x.name === 'LLM controls')).toMatchObject({ status: 'pass', text: '/opt/caci/app/controls: the six files load and check out' });
  });
  it('a bad file fails the doctor, names the problems and says how to undo a bad edit', async () => {
    const r = await doctor({ controls: async () => ({ ok: false, dir: '/opt/caci/app/controls', problems: ['status/system.txt: line 2: unknown slot "x"', 'status/settings.json: "maxPoints" is 99, outside 1 to 20'] }) });
    expect(statusOf(r, 'LLM controls')).toBe('fail');
    expect(r.code).toBe(1);
    expect(r.text).toContain('status/system.txt: line 2: unknown slot "x"; status/settings.json');
    expect(r.text).toContain('git checkout -- controls/');
    expect(r.text).toContain('git diff controls/ in /opt/caci/app');
    expect(r.text).toContain('sudo systemctl restart caci');
  });
  it('only the first five problems are shown, with a count of the rest', async () => {
    const problems = Array.from({ length: 7 }, (_, i) => `f${i}: bad`);
    const r = await doctor({ controls: async () => ({ ok: false, dir: '/c/controls', problems }) });
    expect(r.text).toContain('f4: bad (and 2 more)');
    expect(r.text).not.toContain('f5: bad');
    const six = await doctor({ controls: async () => ({ ok: false, dir: '/c/controls', problems: problems.slice(0, 6) }) });
    expect(six.text).toContain('f4: bad (and 1 more)');
    const five = await doctor({ controls: async () => ({ ok: false, dir: '/c/controls', problems: problems.slice(0, 5) }) });
    expect(five.text).toContain('f4: bad');
    expect(five.text).not.toContain('more)');
  });
  it('a probe that throws is one failed check, not a crash', async () => {
    const r = await doctor({ controls: async () => { throw new Error('boom'); } });
    expect(statusOf(r, 'LLM controls')).toBe('fail');
    expect(r.text).toContain('could not be checked (boom)');
  });
});

describe('the settings file', () => {
  const s = (over) => async () => ({ exists: true, readable: true, path: '/etc/caci/caci.env', mode: 0o640, uid: 0, config: config(), keyPresent: true, ...over });
  it('missing, or unreadable by this account', async () => {
    expect(statusOf(await doctor({ settings: async () => ({ exists: false, path: '/etc/caci/caci.env' }) }), 'Settings')).toBe('fail');
    const r = await doctor({ settings: async () => ({ exists: true, readable: false, path: '/etc/caci/caci.env' }) });
    expect(r.text).toContain('cannot be read by this account');
  });
  it('readable by everyone is a failure that says how to fix it; 600 is fine; another mode is a warning', async () => {
    const world = await doctor({ settings: s({ mode: 0o644 }) });
    expect(statusOf(world, 'Settings file mode')).toBe('fail');
    expect(world.text).toContain('chmod 640');
    expect(world.code).toBe(1);
    expect(statusOf(await doctor({ settings: s({ mode: 0o600 }) }), 'Settings file mode')).toBe('pass');
    expect(statusOf(await doctor({ settings: s({ mode: 0o660 }) }), 'Settings file mode')).toBe('warn');
    expect(statusOf(await doctor({ settings: s({ mode: 0o604 }) }), 'Settings file mode')).toBe('fail');
  });
  it('not owned by root is a warning', async () => {
    expect(statusOf(await doctor({ settings: s({ uid: 1000 }) }), 'Settings file owner')).toBe('warn');
  });
  it('invalid settings are listed by name and fail, without values', async () => {
    const r = await doctor({ settings: s({ config: { ok: false, errors: [{ variable: 'CACI_PORT', message: 'must be a port' }, { variable: 'CACI_LLM', message: 'must be demo or anthropic' }] } }) });
    expect(statusOf(r, 'Settings valid')).toBe('fail');
    expect(r.text).toContain('CACI_PORT: must be a port; CACI_LLM: must be demo or anthropic');
    expect(r.code).toBe(1);
  });
  it('the key: set (never shown), missing, or not needed with the demo model', async () => {
    const set = await doctor();
    expect(set.results.find((x) => x.name === 'Anthropic key').text).toBe('set (not shown)');
    expect(statusOf(await doctor({ settings: s({ keyPresent: false }) }), 'Anthropic key')).toBe('fail');
    const demo = await doctor({ settings: s({ config: config({ llm: 'demo' }), keyPresent: false }) });
    expect(statusOf(demo, 'Anthropic key')).toBe('pass');
    expect(demo.results.find((x) => x.name === 'Anthropic key').text).toContain('demo');
  });
  it('allowed hosts: unset or still the example is a warning; real ones pass', async () => {
    expect(statusOf(await doctor({ settings: s({ config: config({ allowedHosts: undefined }) }) }), 'Allowed hosts')).toBe('warn');
    const example = await doctor({ settings: s({ config: config({ allowedHosts: EXAMPLE_HOSTS.split(',') }) }) });
    expect(statusOf(example, 'Allowed hosts')).toBe('warn');
    expect(example.text).toContain('still the example');
    expect(statusOf(await doctor(), 'Allowed hosts')).toBe('pass');
  });
  it('registration open is a reminder, closed passes', async () => {
    expect(statusOf(await doctor({ settings: s({ config: config({ allowRegistration: true }) }) }), 'Registration')).toBe('warn');
    expect(statusOf(await doctor(), 'Registration')).toBe('pass');
  });
});

describe('the data folder', () => {
  const d = (over) => async () => ({ exists: true, path: '/var/lib/caci', mode: 0o700, files: [{ name: 'graphs.db', mode: 0o600 }, { name: 'users.db', mode: 0o600 }], ...over });
  it('missing, open to others, with loose files, or with no databases yet', async () => {
    expect(statusOf(await doctor({ dataDir: async () => ({ exists: false, path: '/var/lib/caci' }) }), 'Data folder')).toBe('fail');
    const open = await doctor({ dataDir: d({ mode: 0o755 }) });
    expect(statusOf(open, 'Data folder mode')).toBe('fail');
    expect(open.text).toContain('chmod 700');
    const loose = await doctor({ dataDir: d({ files: [{ name: 'users.db', mode: 0o644 }] }) });
    expect(statusOf(loose, 'Data files')).toBe('warn');
    expect(loose.text).toContain('users.db (644)');
    expect(statusOf(await doctor({ dataDir: d({ files: [] }) }), 'Data files')).toBe('warn');
  });
});

describe('the service', () => {
  it('not running is a failure with how to look at it; not enabled is a warning', async () => {
    const down = await doctor({ serviceState: async (u) => (u === 'caci.service' ? { active: false, enabled: true } : { active: true, enabled: true }) });
    expect(statusOf(down, 'Service')).toBe('fail');
    expect(down.text).toContain('journalctl -u caci');
    const noBoot = await doctor({ serviceState: async (u) => (u === 'caci.service' ? { active: true, enabled: false } : { active: true, enabled: true }) });
    expect(statusOf(noBoot, 'Service at boot')).toBe('warn');
  });
});

describe('reaching it', () => {
  it('nothing answering on this machine is a failure', async () => {
    const r = await doctor({ get: async () => { throw new Error('connect ECONNREFUSED'); } });
    expect(statusOf(r, 'Service answers')).toBe('fail');
    expect(r.results.find((x) => x.name === 'Service answers').text).toContain('ECONNREFUSED');
  });
  it('a page that is not the app\'s is a failure with the reason', async () => {
    const r = await doctor({ get: async (q) => (q.path === '/' ? { status: 502, headers: {} } : API) });
    expect(r.text).toContain('502');
    expect(statusOf(r, 'Service answers')).toBe('fail');
  });
  it('answering on this machine but not on the network address points at the bind and the firewall', async () => {
    const r = await doctor({ get: async (q) => { if (q.address !== '127.0.0.1') throw new Error('connect ETIMEDOUT'); return q.path === '/' ? PAGE : API; } });
    expect(statusOf(r, 'Reachable on the network')).toBe('fail');
    expect(r.text).toContain('CACI_BIND must be 0.0.0.0');
    expect(r.text).toContain('firewall');
  });
  it('no network address at all is a warning, and skips the network checks', async () => {
    const r = await doctor({ addresses: async () => [] });
    expect(statusOf(r, 'Network address')).toBe('warn');
    expect(r.results.some((x) => x.name === 'Reachable on the network')).toBe(false);
  });
  it('checks every network address it has', async () => {
    const r = await doctor({ addresses: async () => ['192.168.1.60', '10.0.0.7'] });
    expect(r.results.filter((x) => x.name === 'Reachable on the network').map((x) => x.text)).toEqual(['192.168.1.60:8080 answers', '10.0.0.7:8080 answers']);
  });
  it('an allowed Host that is refused is a failure, and a Host that is not listed but accepted is a warning', async () => {
    const r1 = await doctor({ get: async (q) => (q.host === '192.168.1.60:8080' && q.address !== '127.0.0.1' ? { status: 403, headers: {} } : q.host.startsWith('doctor-check') ? { status: 403, headers: {} } : q.path === '/' ? PAGE : API) });
    expect(statusOf(r1, 'Host 192.168.1.60:8080')).toBe('fail');
    const r2 = await doctor({ get: async (q) => (q.path === '/' ? PAGE : API) });
    expect(statusOf(r2, 'Other hosts refused')).toBe('warn');
  });
  it('without a list of allowed hosts it asks with the loopback Host and skips the Host checks', async () => {
    const r = await doctor({ settings: async () => ({ exists: true, readable: true, path: 'p', mode: 0o640, uid: 0, config: config({ allowedHosts: undefined }), keyPresent: true }) });
    expect(r.asked.every((a) => a.host === '127.0.0.1:8080')).toBe(true);
    expect(r.results.some((x) => x.name.startsWith('Host '))).toBe(false);
  });
  it('is skipped, with a warning, when the settings could not be read', async () => {
    const r = await doctor({ settings: async () => ({ exists: false, path: 'p' }) });
    expect(statusOf(r, 'Reach')).toBe('warn');
    expect(r.asked).toEqual([]);
  });
});

describe('snapshots', () => {
  it('none yet, stale, or fresh; and the timer', async () => {
    expect(statusOf(await doctor({ snapshots: async () => [] }), 'Snapshots')).toBe('warn');
    const stale = await doctor({ snapshots: async () => ['20261008T023000Z'] });
    expect(statusOf(stale, 'Snapshots')).toBe('warn');
    expect(stale.text).toMatch(/3 days old/);
    const fresh = await doctor({ snapshots: async () => ['20261011T023000Z'], nowMs: async () => NOW });
    expect(statusOf(fresh, 'Snapshots')).toBe('pass');
    expect(statusOf(await doctor({ serviceState: async (u) => (u === 'caci-backup.timer' ? { active: false, enabled: false } : { active: true, enabled: true }) }), 'Snapshot timer')).toBe('warn');
  });
  it('uses the newest by name, whatever order they come in, and exactly 36 hours is still fine', async () => {
    const r = await doctor({ snapshots: async () => ['20261001T023000Z', '20261011T000000Z', '20260901T023000Z'], nowMs: async () => Date.UTC(2026, 9, 12, 12, 0, 0) });
    expect(statusOf(r, 'Snapshots')).toBe('pass');
    const over = await doctor({ snapshots: async () => ['20261011T000000Z'], nowMs: async () => Date.UTC(2026, 9, 12, 12, 0, 1) });
    expect(statusOf(over, 'Snapshots')).toBe('warn');
  });
  it('snapshot names are read as UTC times', () => {
    expect(snapshotTime('20261011T020000Z')).toBe(Date.UTC(2026, 9, 11, 2, 0, 0));
    expect(snapshotTime('20261011T020000Z-2')).toBe(Date.UTC(2026, 9, 11, 2, 0, 0));
    expect(snapshotTime('pre-restore-1')).toBeUndefined();
  });
});

describe('disk, clock and hashing', () => {
  it('low and very low disk', async () => {
    expect(statusOf(await doctor({ freeBytes: async () => 400 * 1024 ** 2 }), 'Disk')).toBe('warn');
    expect(statusOf(await doctor({ freeBytes: async () => 10 * 1024 ** 2 }), 'Disk')).toBe('fail');
    expect(statusOf(await doctor({ freeBytes: async () => 500 * 1024 ** 2 }), 'Disk')).toBe('pass');
    expect(statusOf(await doctor({ freeBytes: async () => 50 * 1024 ** 2 }), 'Disk')).toBe('warn');
  });
  it('a clock before the last commit is a failure; unsynchronised is a warning', async () => {
    const past = await doctor({ nowMs: async () => NOW - 10 * 86_400_000 });
    expect(statusOf(past, 'Clock')).toBe('fail');
    expect(past.text).toContain('timedatectl set-ntp true');
    expect(statusOf(await doctor({ ntpSynced: async () => false }), 'Clock sync')).toBe('warn');
    expect(await doctor({ ntpSynced: async () => undefined }).then((r) => r.results.some((x) => x.name === 'Clock sync'))).toBe(false);
  });
  it('a slow hash is a warning above two seconds, not at exactly two', async () => {
    expect(statusOf(await doctor({ hashMs: async () => 2001 }), 'Password hashing')).toBe('warn');
    expect(statusOf(await doctor({ hashMs: async () => 2000 }), 'Password hashing')).toBe('pass');
  });
  it('the version line says what is deployed, and warns about local changes', async () => {
    const clean = await doctor();
    expect(clean.results.find((x) => x.name === 'Version').text).toBe('abc1234, committed 2026-10-10');
    expect(statusOf(await doctor({ commit: async () => ({ sha: 'abc1234', committedAtMs: NOW - 1000, dirty: true }) }), 'Version')).toBe('warn');
    expect(statusOf(await doctor({ commit: async () => { throw new Error('no git'); } }), 'Version')).toBe('warn');
  });
});

describe('robustness and secrecy', () => {
  it('a probe that throws is one failed check, not a crash, and the others still run', async () => {
    const r = await doctor({ freeBytes: async () => { throw new Error('statfs failed'); } });
    expect(statusOf(r, 'Disk')).toBe('fail');
    expect(r.text).toContain('statfs failed');
    expect(r.results.length).toBeGreaterThan(10);
    expect(r.code).toBe(1);
  });
  it('a failing settings probe is reported and the rest carries on', async () => {
    const r = await doctor({ settings: async () => { throw new Error('EACCES'); } });
    expect(statusOf(r, 'Settings')).toBe('fail');
    expect(r.text).toContain('EACCES');
  });
  it('never prints anything shaped like a key, wherever it sneaks in', async () => {
    const key = 'sk-ant-api03-theverysecretkeyvalue123456';
    const r = await doctor({ dataDir: async () => { throw new Error(`leaked ${key}`); } });
    expect(r.text).not.toContain(key);
    expect(r.text).toContain('[hidden]');
  });
  it('exits non-zero exactly when something fails, and warnings alone do not', async () => {
    expect((await doctor({ freeBytes: async () => 100 * 1024 ** 2 })).code).toBe(0);
    expect((await doctor({ freeBytes: async () => 1 })).code).toBe(1);
  });
  it('a fix line appears under warnings and failures only', async () => {
    const r = await doctor({ freeBytes: async () => 100 * 1024 ** 2 });
    expect(r.lines.some((l) => l.startsWith('       -> '))).toBe(true);
    const clean = await doctor();
    expect(clean.lines.some((l) => l.startsWith('       -> '))).toBe(false);
  });
  it('a summary pluralises warnings', async () => {
    const one = await doctor({ freeBytes: async () => 100 * 1024 ** 2 });
    expect(one.lines.at(-1)).toMatch(/1 warning, 0 failed/);
    const two = await doctor({ freeBytes: async () => 100 * 1024 ** 2, hashMs: async () => 5000 });
    expect(two.lines.at(-1)).toMatch(/2 warnings/);
  });
});
