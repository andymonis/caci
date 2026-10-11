import { describe, expect, it } from 'vitest';
import { main, USAGE } from './run.mjs';
import { LAYOUT } from './layout.mjs';

const OK = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', detail: stdout.trim() });

function harness({ isRoot = true, envText = 'CACI_PORT=8080\nANTHROPIC_API_KEY=sk-ant-api03-reallysecretkeyvalue1234567890\n', run } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const fakeRun = run ?? (async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (args.includes('--version')) return OK('v22.19.0\n');
    if (args.includes('rev-parse')) return OK('a'.repeat(40) + '\n');
    if (args.includes('status')) return OK('');
    if (args.includes('scripts/backup.mjs')) return OK('Snapshot /var/backups/caci/20261011T020000Z\n');
    return OK();
  });
  const options = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), run: fakeRun, isRoot, readFile: () => { if (envText === null) throw new Error('no file'); return envText; }, hostOptions: { get: async (r) => (r.path === '/' ? { status: 200, headers: { 'content-type': 'text/html' } } : { status: 401, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } }), sleep: async () => {} } };
  return { options, out, err, calls };
}

describe('the deploy command', () => {
  it('refuses more than one argument, or a bad ref, with the usage and exit 12, doing nothing', async () => {
    for (const argv of [['a', 'b'], ['--force'], ['-x'], ['a b']]) {
      const h = harness();
      expect(await main(argv, h.options), argv.join(' ')).toBe(12);
      expect(h.err.join('')).toContain('Usage: sudo node deploy/run.mjs');
      expect(h.calls).toEqual([]);
    }
    expect(USAGE).toContain(LAYOUT.defaultRef);
  });
  it('refuses when not run as root', async () => {
    const h = harness({ isRoot: false });
    expect(await main([], h.options)).toBe(12);
    expect(h.err.join('')).toContain('as root');
    expect(h.calls).toEqual([]);
  });
  it('refuses when the settings file cannot be read', async () => {
    const h = harness({ envText: null });
    expect(await main([], h.options)).toBe(12);
    expect(h.err.join('')).toContain(LAYOUT.envFile);
    expect(h.calls).toEqual([]);
  });
  it('deploys the default ref when none is given, and a named one when it is', async () => {
    const h = harness();
    expect(await main([], h.options)).toBe(0);
    expect(h.calls.some((c) => c.includes('origin/main^{commit}'))).toBe(true);
    const h2 = harness();
    expect(await main(['v1.0.0'], h2.options)).toBe(0);
    expect(h2.calls.some((c) => c.includes('origin/v1.0.0^{commit}'))).toBe(true);
  });
  it('never prints the key, even when a program reports it', async () => {
    const key = 'sk-ant-api03-reallysecretkeyvalue1234567890';
    const h = harness({
      run: async (file, args) => {
        if (args.includes('--version')) return OK('v22.19.0\n');
        if (args.includes('status')) return OK('');
        if (args.includes('rev-parse')) return OK('a'.repeat(40));
        if (args.includes('scripts/backup.mjs')) return OK('Snapshot /b/20261011T020000Z\n');
        if (args.includes('build')) return { ok: false, code: 1, stdout: '', stderr: `leaked ${key}`, detail: `leaked ${key}` };
        return OK();
      },
    });
    const code = await main([], h.options);
    expect([10, 11]).toContain(code);
    expect(h.out.join('') + h.err.join('')).not.toContain(key);
    expect(h.out.join('')).toContain('[hidden]');
  });
  it('hides any setting whose name says it is a secret, whatever it looks like', async () => {
    const h = harness({
      envText: 'CACI_PORT=8080\nSOME_TOKEN=plain-looking-value-42\nOTHER_PASSWORD=hunter2hunter2\nPLAIN=notsecret\n',
      run: async (file, args) => {
        if (args.includes('--version')) return OK('v22.19.0\n');
        if (args.includes('status')) return OK('');
        if (args.includes('rev-parse')) return OK('a'.repeat(40));
        if (args.includes('scripts/backup.mjs')) return OK('Snapshot /b/20261011T020000Z\n');
        if (args.includes('build')) return { ok: false, code: 1, stdout: '', stderr: 'x', detail: 'saw plain-looking-value-42 and hunter2hunter2 and notsecret' };
        return OK();
      },
    });
    await main([], h.options);
    const text = h.out.join('');
    expect(text).not.toContain('plain-looking-value-42');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).toContain('notsecret');
  });
  it('passes the exit code of the deploy through', async () => {
    const h = harness({ run: async (file, args) => (args.includes('--version') ? OK('v18.0.0') : OK('x')) });
    expect(await main([], h.options)).toBe(12);
  });
});
