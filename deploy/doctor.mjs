// The on-Pi doctor (R-010): one line per check, pass / warn / fail, and what to do. Every fact about the machine
// comes from an injected `probes` object, so each judgement is tested without a Pi. It never reads or prints the
// Anthropic key: the settings probe says only whether it is present.
import { judge } from './host.mjs';
import { nodeAtLeast } from './deploy.mjs';

export const EXAMPLE_HOSTS = 'pi.local:8080,192.168.1.50:8080';
export const SNAPSHOT_STALE_MS = 36 * 3600_000;
export const SLOW_HASH_MS = 2000;
export const LOW_DISK = 500 * 1024 * 1024;
export const VERY_LOW_DISK = 50 * 1024 * 1024;

const pass = (name, text) => ({ status: 'pass', name, text });
const warn = (name, text, fix) => ({ status: 'warn', name, text, fix });
const fail = (name, text, fix) => ({ status: 'fail', name, text, fix });
const octal = (mode) => (mode & 0o777).toString(8).padStart(3, '0');
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/** `20261011T020000Z` to milliseconds, or undefined. */
export function snapshotTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(String(name));
  return m === null ? undefined : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const ago = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} hours` : `${Math.round(ms / 86_400_000)} days`);

export async function runDoctor({ probes, log }) {
  const results = [];
  /** Runs one check; a probe that throws is a failed check, never a crash. */
  async function check(name, body) {
    try {
      const out = await body();
      for (const r of [].concat(out)) results.push(r);
    } catch (cause) {
      results.push(fail(name, `could not be checked (${cause instanceof Error ? cause.message : String(cause)})`));
    }
  }

  await check('Node', async () => {
    const version = await probes.nodeVersion();
    if (!nodeAtLeast(version)) return fail('Node', `${version} is too old: node:sqlite needs 22.13 or later`, 'Install Node 22 system-wide (see the runbook), then run the deploy command again.');
    return (await probes.sqliteLoads()) ? pass('Node', `${version}, and node:sqlite loads`) : fail('Node', `${version}, but node:sqlite does not load`, 'Use a Node build that includes node:sqlite (22.13 or later from nodejs.org or NodeSource).');
  });

  const commit = await (async () => {
    try {
      return await probes.commit();
    } catch {
      return undefined;
    }
  })();
  await check('Version', async () => {
    if (commit === undefined) return warn('Version', 'the current commit could not be read', 'Run the doctor from the application folder.');
    const when = new Date(commit.committedAtMs).toISOString().slice(0, 10);
    return commit.dirty ? warn('Version', `${commit.sha} (committed ${when}) with local changes`, 'A deploy refuses a checkout with local changes: undo them with git checkout -- .') : pass('Version', `${commit.sha}, committed ${when}`);
  });

  const s = await (async () => {
    try {
      return await probes.settings();
    } catch (cause) {
      results.push(fail('Settings', `could not be read (${cause instanceof Error ? cause.message : String(cause)})`));
      return undefined;
    }
  })();
  await check('Settings', async () => {
    if (s === undefined) return [];
    if (!s.exists) return fail('Settings', `${s.path} does not exist`, 'Run the install script (sudo bash deploy/install.sh), then edit the file.');
    if (!s.readable) return fail('Settings', `${s.path} cannot be read by this account`, 'Run the doctor as the caci account or with sudo.');
    const out = [];
    if ((s.mode & 0o007) !== 0) out.push(fail('Settings file mode', `${s.path} is mode ${octal(s.mode)}: everyone can read the Anthropic key`, `sudo chmod 640 ${s.path} && sudo chown root:caci ${s.path}`));
    else if ((s.mode & ~0o640) !== 0) out.push(warn('Settings file mode', `${s.path} is mode ${octal(s.mode)}; 640 is expected`, `sudo chmod 640 ${s.path}`));
    else out.push(pass('Settings file mode', `${s.path} is mode ${octal(s.mode)}, not readable by others`));
    if (s.uid !== 0) out.push(warn('Settings file owner', `${s.path} is not owned by root, so the service account could change its own settings`, `sudo chown root:caci ${s.path}`));
    if (!s.config.ok) {
      out.push(fail('Settings valid', s.config.errors.map((e) => `${e.variable}: ${e.message}`).join('; '), `Edit ${s.path}; the service refuses to start with these.`));
      return out;
    }
    const c = s.config.value;
    out.push(pass('Settings valid', `the service accepts them (port ${c.port}, binds ${c.bind}, ${c.llm} model)`));
    out.push(c.llm === 'anthropic' ? (s.keyPresent ? pass('Anthropic key', 'set (not shown)') : fail('Anthropic key', 'CACI_LLM is anthropic but ANTHROPIC_API_KEY is empty', `Put the key in ${s.path}.`)) : pass('Anthropic key', 'not needed: the demo model is selected'));
    if (c.allowedHosts === undefined) out.push(warn('Allowed hosts', 'CACI_ALLOWED_HOSTS is not set: any Host header is accepted', 'List the exact names and addresses the family types, each with its port.'));
    else if (c.allowedHosts.join(',') === EXAMPLE_HOSTS) out.push(warn('Allowed hosts', 'still the example values (pi.local and 192.168.1.50)', 'Set CACI_ALLOWED_HOSTS to your Pi\'s real name and fixed address, each with its port.'));
    else out.push(pass('Allowed hosts', c.allowedHosts.join(', ')));
    out.push(c.allowRegistration ? warn('Registration', 'open: anyone who can reach the service can make an account', 'When the family has accounts: CACI_ALLOW_REGISTRATION=false, then sudo systemctl restart caci.') : pass('Registration', 'closed'));
    return out;
  });

  await check('LLM controls', async () => {
    const c = await probes.controls();
    if (c.ok) return pass('LLM controls', `${c.dir}: the six files and the three check texts load and check out`);
    return fail('LLM controls', `${c.dir}: ${c.problems.slice(0, 5).join('; ')}${c.problems.length > 5 ? ` (and ${c.problems.length - 5} more)` : ''}`, `Fix the file named above (git diff controls/ in ${c.dir.replace(/\/controls\/?$/, '')} shows what changed), or undo it with git checkout -- controls/, then: sudo systemctl restart caci`);
  });

  await check('Data folder', async () => {
    const d = await probes.dataDir();
    if (!d.exists) return fail('Data folder', `${d.path} does not exist`, 'Run the install script, then start the service.');
    const out = [];
    if ((d.mode & 0o077) !== 0) out.push(fail('Data folder mode', `${d.path} is mode ${octal(d.mode)}: others can enter it`, `sudo chmod 700 ${d.path}`));
    else out.push(pass('Data folder mode', `${d.path} is mode ${octal(d.mode)}`));
    const loose = d.files.filter((f) => (f.mode & 0o077) !== 0);
    if (loose.length > 0) out.push(warn('Data files', `${loose.map((f) => `${f.name} (${octal(f.mode)})`).join(', ')} readable beyond the owner`, `sudo chmod 600 ${d.path}/*.db`));
    else if (d.files.length === 0) out.push(warn('Data files', 'no database files yet', 'They are created when the service first starts.'));
    else out.push(pass('Data files', `${d.files.map((f) => f.name).join(' and ')} owner-only`));
    return out;
  });

  await check('Service', async () => {
    const state = await probes.serviceState('caci.service');
    const out = [];
    out.push(state.active ? pass('Service', 'caci.service is running') : fail('Service', 'caci.service is not running', 'sudo systemctl start caci; if it stops again: sudo journalctl -u caci -n 50'));
    if (!state.enabled) out.push(warn('Service at boot', 'caci.service will not start after a power cut', 'sudo systemctl enable caci'));
    return out;
  });

  await check('Reach', async () => {
    if (s === undefined || !s.exists || !s.readable || !s.config.ok) return warn('Reach', 'skipped: the settings could not be read', 'Fix the settings first.');
    const c = s.config.value;
    const hosts = c.allowedHosts ?? [`127.0.0.1:${c.port}`];
    const lan = await probes.addresses();
    const out = [];
    const ask = async (address, host, path) => {
      try {
        return { ok: true, ...(await probes.get({ address, port: c.port, host, path })) };
      } catch (cause) {
        return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    };
    const loop = await ask('127.0.0.1', hosts[0], '/');
    const loopApi = loop.ok ? await ask('127.0.0.1', hosts[0], '/api/me') : loop;
    if (!loop.ok || !loopApi.ok) out.push(fail('Service answers', `nothing answers on 127.0.0.1:${c.port} (${loop.ok ? loopApi.reason : loop.reason})`, 'sudo systemctl status caci; sudo journalctl -u caci -n 50'));
    else {
      const problem = judge(loop, loopApi);
      out.push(problem === undefined ? pass('Service answers', 'the page and the API answer on this machine') : fail('Service answers', problem, 'sudo journalctl -u caci -n 50'));
    }
    if (lan.length === 0) {
      out.push(warn('Network address', 'no address besides loopback was found: the family cannot reach it', 'Check the Wi-Fi or cable; the Pi needs a fixed address.'));
      return out;
    }
    for (const address of lan) {
      const r = await ask(address, hosts[0], '/');
      out.push(r.ok && r.status === 200 ? pass('Reachable on the network', `${address}:${c.port} answers`) : fail('Reachable on the network', `${address}:${c.port} does not answer (${r.ok ? `status ${r.status}` : r.reason})`, `CACI_BIND must be 0.0.0.0 (it is ${c.bind}), and the firewall must allow the port from the home network.`));
    }
    if (c.allowedHosts !== undefined) {
      for (const host of c.allowedHosts) {
        const r = await ask(lan[0], host, '/');
        out.push(r.ok && r.status === 200 ? pass(`Host ${host}`, 'accepted') : fail(`Host ${host}`, `refused (${r.ok ? `status ${r.status}` : r.reason}): typing it in a browser would not work`, 'Check CACI_ALLOWED_HOSTS: names and ports must match what is typed exactly.'));
      }
      const other = await ask(lan[0], `doctor-check.invalid:${c.port}`, '/');
      out.push(other.ok && other.status === 403 ? pass('Other hosts refused', 'a Host that is not listed gets 403') : warn('Other hosts refused', `a Host that is not listed was not refused (${other.ok ? `status ${other.status}` : other.reason})`, 'Check CACI_ALLOWED_HOSTS.'));
    }
    return out;
  });

  await check('Snapshots', async () => {
    const names = (await probes.snapshots()).slice().sort().reverse();
    const timer = await probes.serviceState('caci-backup.timer');
    const out = [];
    const newest = names.map((n) => ({ n, t: snapshotTime(n) })).find((x) => x.t !== undefined);
    if (newest === undefined) out.push(warn('Snapshots', 'there is no snapshot yet', 'sudo systemctl start caci-backup.service, then check the folder.'));
    else {
      const age = (await probes.nowMs()) - newest.t;
      out.push(age > SNAPSHOT_STALE_MS ? warn('Snapshots', `the newest is ${ago(age)} old (${newest.n})`, 'Check the timer: systemctl list-timers caci-backup.timer; sudo journalctl -u caci-backup -n 30') : pass('Snapshots', `the newest is ${ago(Math.max(0, age))} old; ${names.length} kept`));
    }
    out.push(timer.active ? pass('Snapshot timer', 'caci-backup.timer is active') : warn('Snapshot timer', 'caci-backup.timer is not active: no nightly snapshot', 'sudo systemctl start caci-backup.timer'));
    return out;
  });

  await check('Disk', async () => {
    const free = await probes.freeBytes();
    const mb = Math.round(free / 1024 / 1024);
    if (free < VERY_LOW_DISK) return fail('Disk', `only ${mb} MB free beside the data`, 'Free space: the databases cannot grow.');
    if (free < LOW_DISK) return warn('Disk', `${mb} MB free beside the data`, 'Free some space soon.');
    return pass('Disk', `${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`} free beside the data`);
  });

  await check('Clock', async () => {
    const now = await probes.nowMs();
    const out = [];
    if (commit !== undefined && now < commit.committedAtMs) out.push(fail('Clock', `the date is ${new Date(now).toISOString().slice(0, 10)}, before the last commit: the clock is wrong (a Pi has no battery)`, 'sudo timedatectl set-ntp true; check with timedatectl'));
    else out.push(pass('Clock', `${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC`));
    const ntp = await probes.ntpSynced();
    if (ntp === false) out.push(warn('Clock sync', 'the clock is not synchronised with a time server', 'sudo timedatectl set-ntp true'));
    return out;
  });

  await check('Password hashing', async () => {
    const ms = await probes.hashMs();
    return ms > SLOW_HASH_MS ? warn('Password hashing', `one hash takes ${(ms / 1000).toFixed(1)} s: every login and registration will feel slow`, 'A faster Pi, or ask for the cost to be made configurable.') : pass('Password hashing', `one hash takes ${Math.round(ms)} ms`);
  });

  const clean = (text) => String(text ?? '').replace(KEY_SHAPE, '[hidden]');
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  for (const r of results) {
    log(`[${mark[r.status]}] ${clean(r.name)}: ${clean(r.text)}`);
    if (r.fix !== undefined && r.status !== 'pass') log(`       -> ${clean(r.fix)}`);
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  log(`${count('pass')} passed, ${count('warn')} warning${count('warn') === 1 ? '' : 's'}, ${count('fail')} failed.`);
  return { code: count('fail') === 0 ? 0 : 1, results };
}
