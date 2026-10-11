import { describe, expect, it } from 'vitest';
import { createHost, healthTarget, judge } from './host.mjs';
import { LAYOUT } from './layout.mjs';

const OK = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', detail: stdout.trim() });
const FAIL = (detail = 'failed') => ({ ok: false, code: 1, stdout: '', stderr: detail, detail });

/** A runner that records what it is asked and answers from `answer(file, args)`. */
function recorder(answer = () => OK()) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    return answer(file, args);
  };
  return { run, calls };
}
const layout = { ...LAYOUT, user: undefined };
const asCaci = { ...LAYOUT };

describe('running as the service account', () => {
  it('wraps git, npm and node in sudo -n -H -u caci -- env CACI_DATA_DIR=..., and passes nothing else', async () => {
    const r = recorder();
    await createHost({ run: r.run, layout: asCaci }).install();
    expect(r.calls[0]).toMatchObject({ file: 'sudo', args: ['-n', '-H', '-u', 'caci', '--', 'env', 'CACI_DATA_DIR=/var/lib/caci', 'npm', 'ci', '--no-audit', '--no-fund'] });
    expect(r.calls[0].options.cwd).toBe('/opt/caci/app');
    expect(r.calls[0].options.env).toBeUndefined();
  });
  it('runs programs directly, in the app folder, when no account is named', async () => {
    const r = recorder();
    await createHost({ run: r.run, layout }).build();
    expect(r.calls[0]).toMatchObject({ file: 'npm', args: ['run', 'build'] });
    expect(r.calls[0].options.cwd).toBe('/opt/caci/app');
  });
  it('runs systemctl as the caller, never through sudo, by the unit name in the layout', async () => {
    const r = recorder();
    const host = createHost({ run: r.run, layout: asCaci });
    await host.stopService();
    await host.startService();
    await host.restartService();
    expect(r.calls.map((c) => [c.file, ...c.args])).toEqual([['systemctl', 'stop', 'caci.service'], ['systemctl', 'start', 'caci.service'], ['systemctl', 'restart', 'caci.service']]);
  });
});

describe('the operations', () => {
  it('node version and node:sqlite', async () => {
    const r = recorder((file, args) => (args.includes('--version') ? OK('v22.19.0\n') : OK()));
    const host = createHost({ run: r.run, layout });
    expect(await host.nodeVersion()).toBe('v22.19.0');
    expect(await host.sqliteLoads()).toMatchObject({ ok: true });
    expect(r.calls[1].args.join(' ')).toContain("import('node:sqlite')");
    const bad = createHost({ run: recorder(() => FAIL('no node')).run, layout });
    await expect(bad.nodeVersion()).rejects.toThrow('no node');
    expect(await bad.sqliteLoads()).toMatchObject({ ok: false });
  });

  it('a clean tree is an empty status of tracked files; changes are named', async () => {
    const clean = recorder(() => OK(''));
    expect(await createHost({ run: clean.run, layout }).workingTreeClean()).toEqual({ ok: true });
    expect(clean.calls[0].args).toEqual(['status', '--porcelain', '--untracked-files=no']);
    const dirty = recorder(() => OK(' M web/app.js\n M README.md\n'));
    const r = await createHost({ run: dirty.run, layout }).workingTreeClean();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('web/app.js');
    expect(await createHost({ run: recorder(() => FAIL('not a repo')).run, layout }).workingTreeClean()).toMatchObject({ ok: false });
  });

  it('the current commit', async () => {
    const r = recorder(() => OK('abc1234def\n'));
    expect(await createHost({ run: r.run, layout }).currentCommit()).toEqual({ ok: true, commit: 'abc1234def' });
    expect(r.calls[0].args).toEqual(['rev-parse', 'HEAD']);
    expect(await createHost({ run: recorder(() => FAIL()).run, layout }).currentCommit()).toMatchObject({ ok: false });
  });

  it('fetch and check out: a branch name means the branch on origin, a tag or commit means itself, and the exact commit is checked out detached', async () => {
    const sha = 'a'.repeat(40);
    const r = recorder((file, args) => (args[0] === 'rev-parse' && args.some((a) => a === 'origin/main^{commit}') ? OK(`${sha}\n`) : args[0] === 'rev-parse' ? FAIL('unknown') : OK()));
    const host = createHost({ run: r.run, layout });
    expect(await host.fetchAndCheckout('main')).toMatchObject({ ok: true });
    expect(r.calls.map((c) => c.args)).toEqual([['fetch', '--tags', '--prune', 'origin'], ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], ['checkout', '--detach', sha]]);
    const r2 = recorder((file, args) => (args[0] === 'rev-parse' && args.includes('v1.2^{commit}') ? OK(`${sha}\n`) : args[0] === 'rev-parse' ? FAIL('unknown') : OK()));
    expect(await createHost({ run: r2.run, layout }).fetchAndCheckout('v1.2')).toMatchObject({ ok: true });
    expect(r2.calls.map((c) => c.args[0])).toContain('checkout');
    const r3 = recorder((file, args) => (args[0] === 'rev-parse' && args.includes('origin/main^{commit}') ? OK(`${sha}\n`) : OK()));
    await createHost({ run: r3.run, layout }).fetchAndCheckout('origin/main');
    expect(r3.calls.filter((c) => c.args[0] === 'rev-parse')).toHaveLength(1);
  });
  it('fetch fails, unknown ref, or a checkout that fails', async () => {
    expect(await createHost({ run: recorder((f, a) => (a[0] === 'fetch' ? FAIL('no network') : OK())).run, layout }).fetchAndCheckout('main')).toMatchObject({ ok: false, detail: 'no network' });
    const unknown = await createHost({ run: recorder((f, a) => (a[0] === 'rev-parse' ? FAIL() : OK())).run, layout }).fetchAndCheckout('nope');
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.detail).toContain('"nope"');
    const odd = await createHost({ run: recorder((f, a) => (a[0] === 'rev-parse' ? OK('not-a-sha\n') : OK())).run, layout }).fetchAndCheckout('x');
    expect(odd.ok).toBe(false);
    const sha = 'b'.repeat(40);
    expect(await createHost({ run: recorder((f, a) => (a[0] === 'rev-parse' ? OK(`${sha}\n`) : a[0] === 'checkout' ? FAIL('conflict') : OK())).run, layout }).fetchAndCheckout('main')).toMatchObject({ ok: false, detail: 'conflict' });
  });

  it('checkout of a commit id, and nothing else', async () => {
    const r = recorder();
    const host = createHost({ run: r.run, layout });
    expect(await host.checkout('abc1234')).toMatchObject({ ok: true });
    expect(r.calls[0].args).toEqual(['checkout', '--detach', 'abc1234']);
    for (const bad of ['--force', 'main', 'abc;rm', '', 'ABC1234']) expect(await host.checkout(bad)).toMatchObject({ ok: false });
    expect(r.calls).toHaveLength(1);
  });

  it('install and build report the program\'s failure text', async () => {
    const host = createHost({ run: recorder(() => FAIL('npm ERR! boom')).run, layout });
    expect(await host.install()).toMatchObject({ ok: false, detail: 'npm ERR! boom' });
    expect(await host.build()).toMatchObject({ ok: false, detail: 'npm ERR! boom' });
  });

  it('install and build have long time limits of their own', async () => {
    const r = recorder();
    const host = createHost({ run: r.run, layout });
    await host.install();
    await host.build();
    expect(r.calls[0].options.timeoutMs).toBe(20 * 60_000);
    expect(r.calls[1].options.timeoutMs).toBe(10 * 60_000);
  });

  it('snapshot runs the backup script with the backup folder and the keep count, and finds the folder it printed', async () => {
    const r = recorder(() => OK('Snapshot /var/backups/caci/20261011T020000Z\n  graphs.db: 1 bytes\nKept 3 snapshots.\n'));
    const out = await createHost({ run: r.run, layout }).snapshot();
    expect(out).toEqual({ ok: true, folder: '/var/backups/caci/20261011T020000Z' });
    expect(r.calls[0]).toMatchObject({ file: 'node', args: ['scripts/backup.mjs', '--dest', '/var/backups/caci', '--keep', '14'] });
    expect(await createHost({ run: recorder(() => OK('nothing useful')).run, layout }).snapshot()).toMatchObject({ ok: false });
    expect(await createHost({ run: recorder(() => FAIL('disk full')).run, layout }).snapshot()).toMatchObject({ ok: false, detail: 'disk full' });
  });

  it('restore passes the folder and --yes', async () => {
    const r = recorder();
    await createHost({ run: r.run, layout }).restore('/var/backups/caci/20261011T020000Z');
    expect(r.calls[0]).toMatchObject({ file: 'node', args: ['scripts/restore.mjs', '/var/backups/caci/20261011T020000Z', '--yes'] });
  });
});

describe('the health check', () => {
  const good = (path) => (path === '/' ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } } : { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  };

  it('judges the page and the API', () => {
    expect(judge(good('/'), good('/api/me'))).toBeUndefined();
    expect(judge({ status: 502, headers: {} }, good('/api/me'))).toContain('502');
    expect(judge({ status: 200, headers: { 'content-type': 'text/plain' } }, good('/api/me'))).toContain('not HTML');
    expect(judge(good('/'), { status: 200, headers: {} })).toContain('200');
    expect(judge(good('/'), { status: 401, headers: { 'content-type': 'text/html' } })).toContain('JSON');
    expect(judge(good('/'), { status: 401, headers: { 'content-type': 'application/json' } })).toContain('security headers');
    expect(judge(good('/'), { status: 401, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } })).toContain('security headers');
    expect(judge(good('/'), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })).toContain('security headers');
  });

  it('asks the right port with the right Host, and succeeds as soon as both answers are right', async () => {
    const asked = [];
    const get = async (request) => (asked.push(request), good(request.path));
    const clock = fakeClock();
    const host = createHost({ run: recorder().run, layout, settings: { CACI_PORT: '9090', CACI_ALLOWED_HOSTS: 'pi.local:9090,192.168.1.50:9090' }, get, ...clock });
    expect(await host.waitHealthy()).toMatchObject({ ok: true });
    expect(asked).toEqual([{ port: 9090, host: 'pi.local:9090', path: '/' }, { port: 9090, host: 'pi.local:9090', path: '/api/me' }]);
  });

  it('waits and tries again while the service comes up, and says what was wrong last when it gives up', async () => {
    let n = 0;
    const get = async (request) => {
      if (++n <= 4) throw new Error('connect ECONNREFUSED');
      return good(request.path);
    };
    const clock = fakeClock();
    const host = createHost({ run: recorder().run, layout, get, ...clock, healthEveryMs: 1000 });
    expect(await host.waitHealthy()).toMatchObject({ ok: true });
    const never = createHost({ run: recorder().run, layout, get: async () => { throw new Error('connect ECONNREFUSED'); }, ...fakeClock(), healthDeadlineMs: 5000, healthEveryMs: 1000 });
    const r = await never.waitHealthy();
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain('ECONNREFUSED');
    const wrong = createHost({ run: recorder().run, layout, get: async () => ({ status: 502, headers: {} }), ...fakeClock(), healthDeadlineMs: 3000, healthEveryMs: 1000 });
    expect((await wrong.waitHealthy()).detail).toContain('502');
  });

  it('gives up at the deadline and not before', async () => {
    let asks = 0;
    const clock = fakeClock();
    const host = createHost({ run: recorder().run, layout, get: async () => (asks++, { status: 500, headers: {} }), ...clock, healthDeadlineMs: 10_000, healthEveryMs: 1000 });
    await host.waitHealthy();
    expect(clock.now()).toBeGreaterThanOrEqual(8000);
    expect(clock.now()).toBeLessThan(10_000);
    expect(asks).toBeGreaterThan(5);
  });

  it('the target: the port and Host from the settings, with defaults', () => {
    expect(healthTarget({})).toEqual({ port: 8080, host: '127.0.0.1:8080' });
    expect(healthTarget({ CACI_PORT: '9000' })).toEqual({ port: 9000, host: '127.0.0.1:9000' });
    expect(healthTarget({ CACI_PORT: '9000', CACI_ALLOWED_HOSTS: ' pi.local:9000 , x:1' })).toEqual({ port: 9000, host: 'pi.local:9000' });
    expect(healthTarget({ CACI_PORT: 'banana' })).toEqual({ port: 8080, host: '127.0.0.1:8080' });
    expect(healthTarget({ CACI_PORT: '70000' }).port).toBe(8080);
    expect(healthTarget({ CACI_ALLOWED_HOSTS: ' , ' }).host).toBe('127.0.0.1:8080');
  });
});
