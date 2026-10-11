import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from './envfile.mjs';
import { httpGet } from './host.mjs';
import { LAYOUT } from './layout.mjs';

// The real facts for the doctor: files, programs, the network. Everything that touches the machine is a parameter,
// so these are tested with scratch folders and stand-ins. The Anthropic key is read only to learn whether it is set.

const SNAPSHOT = /^\d{8}T\d{6}Z(?:-\d{1,3})?$/;

export function createProbes({
  layout = LAYOUT,
  run,
  parseServiceConfig,
  hashOnce,
  get = httpGet,
  now = Date.now,
  interfaces = networkInterfaces,
  statfs = statfsSync,
  clock = () => performance.now(),
  importSqlite = () => import('node:sqlite'),
}) {
  const git = (...args) => run('git', args, { cwd: layout.appDir });
  return {
    nodeVersion: async () => process.version,
    sqliteLoads: async () => {
      try {
        await importSqlite();
        return true;
      } catch {
        return false;
      }
    },
    commit: async () => {
      const sha = await git('rev-parse', '--short', 'HEAD');
      const when = await git('log', '-1', '--format=%ct');
      const status = await git('status', '--porcelain', '--untracked-files=no');
      if (!sha.ok || !when.ok) throw new Error(sha.detail || when.detail);
      return { sha: sha.stdout.trim(), committedAtMs: Number(when.stdout.trim()) * 1000, dirty: status.ok && status.stdout.trim() !== '' };
    },
    settings: async () => {
      const path = layout.envFile;
      if (!existsSync(path)) return { exists: false, path };
      let st;
      let text;
      try {
        st = statSync(path);
        text = readFileSync(path, 'utf8');
      } catch {
        return { exists: true, readable: false, path };
      }
      const values = parseEnvFile(text);
      const parsed = parseServiceConfig({ ...values });
      return {
        exists: true,
        readable: true,
        path,
        mode: st.mode & 0o777,
        uid: st.uid,
        config: parsed.ok ? { ok: true, value: parsed.value } : { ok: false, errors: parsed.error.map((e) => ({ variable: e.variable, message: e.message })) },
        keyPresent: String(values.ANTHROPIC_API_KEY ?? '').trim() !== '',
      };
    },
    dataDir: async () => {
      const path = layout.dataDir;
      if (!existsSync(path)) return { exists: false, path };
      const files = readdirSync(path).filter((n) => n.endsWith('.db')).sort().map((name) => ({ name, mode: statSync(join(path, name)).mode & 0o777 }));
      return { exists: true, path, mode: statSync(path).mode & 0o777, files };
    },
    serviceState: async (unit) => {
      const active = await run('systemctl', ['is-active', unit]);
      const enabled = await run('systemctl', ['is-enabled', unit]);
      return { active: active.ok && active.stdout.trim() === 'active', enabled: enabled.ok };
    },
    addresses: async () => Object.values(interfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address),
    get: (request) => get(request),
    snapshots: async () => {
      if (!existsSync(layout.backupDir)) return [];
      return readdirSync(layout.backupDir).filter((n) => SNAPSHOT.test(n) && existsSync(join(layout.backupDir, n, 'graphs.db')) && existsSync(join(layout.backupDir, n, 'users.db')));
    },
    freeBytes: async () => {
      const s = statfs(existsSync(layout.dataDir) ? layout.dataDir : '/');
      return Number(s.bavail) * Number(s.bsize);
    },
    nowMs: async () => now(),
    ntpSynced: async () => {
      const r = await run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']);
      return r.ok ? r.stdout.trim() === 'yes' : undefined;
    },
    hashMs: async () => {
      const started = clock();
      await hashOnce('doctor timing password 123');
      return clock() - started;
    },
  };
}
