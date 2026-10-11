import { request as httpRequest } from 'node:http';
import { LAYOUT } from './layout.mjs';

// The real operations behind `runDeploy`'s `host` (R-010). Programs are run through an injected `run` (see exec.mjs),
// as the service account when `layout.user` is set (via `sudo -n -H -u <user> -- env CACI_DATA_DIR=... <program>`; the
// only setting passed on the command line is the data folder, never the key), and `systemctl` as the caller (root).

/** How `waitHealthy` talks to the service: one GET, answering `{ status, headers, body }` or throwing. */
export function httpGet({ address = '127.0.0.1', port, host, path, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: address, port, path, method: 'GET', headers: { host }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** The port and the Host header the service expects, from the settings (`CACI_PORT`, first of `CACI_ALLOWED_HOSTS`). */
export function healthTarget(settings, layout = LAYOUT) {
  const port = Number(settings.CACI_PORT ?? layout.defaultPort);
  const first = String(settings.CACI_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).find((h) => h !== '');
  return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : layout.defaultPort, host: first ?? `127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : layout.defaultPort}` };
}

/**
 * The checks that say the family can use the service: the page answers 200 as HTML, and `/api/me` without a session
 * answers a JSON 401 that carries the API's lock-down headers.
 */
export function judge(page, api) {
  if (page.status !== 200) return `the page answered ${page.status}, not 200`;
  if (!/text\/html/.test(String(page.headers['content-type'] ?? ''))) return 'the page is not HTML';
  if (api.status !== 401) return `/api/me answered ${api.status}, not 401`;
  if (!/application\/json/.test(String(api.headers['content-type'] ?? ''))) return '/api/me did not answer JSON';
  if (api.headers['x-content-type-options'] !== 'nosniff' || !/no-store/.test(String(api.headers['cache-control'] ?? ''))) return '/api/me lacks the API\'s security headers';
  return undefined;
}

export function createHost({ run, layout = LAYOUT, settings = {}, get = httpGet, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, healthDeadlineMs = 80_000, healthEveryMs = 1000 }) {
  const asUser = (file, args, options = {}) => {
    if (layout.user === undefined || layout.user === null) return run(file, args, { cwd: layout.appDir, ...options });
    const wrapped = ['-n', '-H', '-u', layout.user, '--', 'env', `CACI_DATA_DIR=${layout.dataDir}`, file, ...args];
    return run('sudo', wrapped, { cwd: layout.appDir, ...options });
  };
  const result = (r, okDetail) => ({ ok: r.ok, detail: r.ok ? okDetail ?? r.detail : r.detail });
  const git = (...args) => asUser('git', args);
  const target = healthTarget(settings, layout);

  return Object.freeze({
    nodeVersion: async () => {
      const r = await asUser('node', ['--version']);
      if (!r.ok) throw new Error(r.detail);
      return r.stdout.trim();
    },
    sqliteLoads: async () => result(await asUser('node', ['-e', "import('node:sqlite').then(() => process.exit(0), () => process.exit(1))"]), 'loads'),
    workingTreeClean: async () => {
      const r = await git('status', '--porcelain', '--untracked-files=no');
      if (!r.ok) return { ok: false, detail: r.detail };
      return r.stdout.trim() === '' ? { ok: true } : { ok: false, detail: r.stdout.trim().split('\n').slice(0, 5).join('; ') };
    },
    currentCommit: async () => {
      const r = await git('rev-parse', 'HEAD');
      return r.ok ? { ok: true, commit: r.stdout.trim() } : { ok: false, detail: r.detail };
    },
    fetchAndCheckout: async (ref) => {
      const fetched = await git('fetch', '--tags', '--prune', 'origin');
      if (!fetched.ok) return { ok: false, detail: fetched.detail };
      const candidates = ref.startsWith('origin/') ? [ref] : [`origin/${ref}`, ref];
      for (const candidate of candidates) {
        const found = await git('rev-parse', '--verify', '--quiet', `${candidate}^{commit}`);
        if (found.ok && /^[0-9a-f]{40,64}$/.test(found.stdout.trim())) return result(await git('checkout', '--detach', found.stdout.trim()), `checked out ${candidate}`);
      }
      return { ok: false, detail: `no branch, tag or commit called "${ref}" on origin` };
    },
    checkout: async (sha) => (/^[0-9a-f]{7,64}$/.test(sha) ? result(await git('checkout', '--detach', sha)) : { ok: false, detail: 'not a commit id' }),
    install: async () => result(await asUser('npm', ['ci', '--no-audit', '--no-fund'], { timeoutMs: 20 * 60_000 })),
    build: async () => result(await asUser('npm', ['run', 'build'], { timeoutMs: 10 * 60_000 })),
    stopService: async () => result(await run('systemctl', ['stop', layout.service], { timeoutMs: 120_000 })),
    startService: async () => result(await run('systemctl', ['start', layout.service], { timeoutMs: 120_000 })),
    restartService: async () => result(await run('systemctl', ['restart', layout.service], { timeoutMs: 120_000 })),
    snapshot: async () => {
      const r = await asUser('node', ['scripts/backup.mjs', '--dest', layout.backupDir, '--keep', String(layout.keep)]);
      if (!r.ok) return { ok: false, detail: r.detail };
      const line = r.stdout.split('\n').find((l) => l.startsWith('Snapshot '));
      return line === undefined ? { ok: false, detail: 'the backup did not say where the snapshot is' } : { ok: true, folder: line.slice('Snapshot '.length).trim() };
    },
    restore: async (folder) => result(await asUser('node', ['scripts/restore.mjs', folder, '--yes'])),
    waitHealthy: async () => {
      const deadline = now() + healthDeadlineMs;
      let last;
      for (;;) {
        try {
          const page = await get({ port: target.port, host: target.host, path: '/' });
          const api = await get({ port: target.port, host: target.host, path: '/api/me' });
          const problem = judge(page, api);
          if (problem === undefined) return { ok: true, detail: 'the page and the API answer' };
          last = problem;
        } catch (cause) {
          last = cause instanceof Error ? cause.message : String(cause);
        }
        if (now() + healthEveryMs >= deadline) return { ok: false, detail: last ?? 'no answer' };
        await sleep(healthEveryMs);
      }
    },
  });
}

