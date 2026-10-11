import { describe, expect, it } from 'vitest';
import { EXIT, MIN_NODE, nodeAtLeast, runDeploy, validateRef } from './deploy.mjs';

const OLD = 'aaaaaaa1111111111111111111111111111111aa';
const NEW = 'bbbbbbb2222222222222222222222222222222bb';

/** A pretend machine: it records every operation, and `plan` says which ones fail, throw or hang. */
function machine(plan = {}) {
  const calls = [];
  const state = { commit: OLD, running: true };
  const act = (name, fn = () => ({ ok: true })) => async (...args) => {
    calls.push(args.length === 0 ? name : `${name}(${args.join(',')})`);
    const p = plan[name];
    if (Array.isArray(p)) {
      const next = p.shift(); // a list gives each call its own fate
      if (next === 'throw') throw new Error(`${name} exploded`);
      if (next === 'hang') return new Promise(() => {});
      if (next === 'ok') return fn(...args);
      if (typeof next === 'string') return { ok: false, detail: next };
    } else if (p === 'throw') throw new Error(`${name} exploded`);
    else if (p === 'hang') return new Promise(() => {});
    else if (typeof p === 'string') return { ok: false, detail: p };
    return fn(...args);
  };
  const host = {
    nodeVersion: async () => (calls.push('nodeVersion'), plan.node ?? 'v22.19.0'),
    sqliteLoads: act('sqliteLoads'),
    workingTreeClean: act('workingTreeClean'),
    currentCommit: act('currentCommit', () => ({ ok: true, commit: state.commit })),
    snapshot: act('snapshot', () => ({ ok: true, folder: '/b/20261011T020000Z' })),
    fetchAndCheckout: act('fetchAndCheckout', () => ((state.commit = NEW), { ok: true })),
    checkout: act('checkout', (sha) => ((state.commit = sha), { ok: true })),
    install: act('install'),
    build: act('build'),
    stopService: act('stopService', () => ((state.running = false), { ok: true })),
    startService: act('startService', () => ((state.running = true), { ok: true })),
    restartService: act('restartService', () => ((state.running = true), { ok: true })),
    waitHealthy: act('waitHealthy'),
    restore: act('restore'),
  };
  return { host, calls, state };
}
const go = async (plan, options = {}) => {
  const m = machine(plan);
  const lines = [];
  const result = await runDeploy({ ref: 'main', host: m.host, log: (l) => lines.push(l), timeoutMs: { other: 50, install: 50, build: 50, health: 50 }, ...options });
  return { ...m, lines, result };
};
const mutating = (calls) => calls.filter((c) => /^(fetchAndCheckout|checkout|install|build|stopService|startService|restartService|restore)/.test(c));

describe('a ref', () => {
  it.each(['main', 'v1.2.3', 'origin/main', 'release/2026-10', 'a1b2c3d', 'feature_x-1'])('%s is accepted', (ref) => expect(validateRef(ref)).toBeUndefined());
  it.each(['', ' ', '-f', '--upload-pack=x', 'a b', 'a;b', 'a$(x)', 'a`x`', 'a|b', 'a&b', 'a\nb', '../x', 'a/../b', 'a//b', 'a/', 'a.', 'x.lock', 'a@{1}', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '.hidden', '/abs', 'x'.repeat(201), 'ünï'])('%j is refused', (ref) => expect(validateRef(ref)).toBeTypeOf('string'));
  it('only text is a ref', () => {
    for (const bad of [undefined, null, 7, {}, ['main'], Symbol('x')]) expect(validateRef(bad)).toBeTypeOf('string');
  });
});

describe('the Node version', () => {
  it('22.13 and later', () => {
    expect(MIN_NODE).toEqual([22, 13]);
    for (const ok of ['v22.13.0', 'v22.19.0', 'v23.0.0', 'v24.1.2', '22.13.0']) expect(nodeAtLeast(ok), ok).toBe(true);
    for (const no of ['v22.12.9', 'v22.0.0', 'v20.18.0', 'v18.0.0', '', 'v', 'banana', 'v22', 'v22.13']) expect(nodeAtLeast(no), no).toBe(false);
    expect(nodeAtLeast(undefined)).toBe(false);
  });
});

describe('a deploy that works', () => {
  it('runs the steps in order: checks, snapshot, prepare, restart, health, and reports exit 0', async () => {
    const { calls, result, state } = await go();
    expect(result.code).toBe(EXIT.DEPLOYED);
    expect(calls).toEqual(['nodeVersion', 'sqliteLoads', 'workingTreeClean', 'currentCommit', 'snapshot', 'fetchAndCheckout(main)', 'install', 'build', 'currentCommit', 'restartService', 'waitHealthy']);
    expect(state.commit).toBe(NEW);
    expect(result.previous).toBe(OLD);
    expect(result.current).toBe(NEW);
    expect(result.snapshot).toBe('/b/20261011T020000Z');
    expect(result.message).toContain('Deployed main');
  });
  it('never touches the running service before the new version is built', async () => {
    const { calls } = await go();
    expect(calls.indexOf('restartService')).toBeGreaterThan(calls.indexOf('build'));
    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('fetchAndCheckout(main)'));
  });
});

describe('a deploy refused before anything changes (exit 12)', () => {
  it.each([['-f'], ['a b'], ['']])('the ref %j', async (ref) => {
    const { calls, result } = await go({}, { ref });
    expect(result.code).toBe(EXIT.REFUSED);
    expect(calls).toEqual([]);
  });
  it('Node too old', async () => {
    const { calls, result } = await go({ node: 'v20.1.0' });
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.message).toContain('too old');
    expect(mutating(calls)).toEqual([]);
    expect(calls).not.toContain('snapshot');
  });
  it('node:sqlite missing', async () => {
    const { calls, result } = await go({ sqliteLoads: 'no driver' });
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.message).toContain('node:sqlite');
    expect(calls).not.toContain('snapshot');
  });
  it('local changes in the checkout', async () => {
    const { calls, result } = await go({ workingTreeClean: 'M web/app.js' });
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.message).toContain('local changes');
    expect(calls).not.toContain('snapshot');
  });
  it('an unreadable current commit', async () => {
    const m = machine();
    m.host.currentCommit = async () => ({ ok: true, commit: 'not a sha' });
    const result = await runDeploy({ ref: 'main', host: m.host, log: () => {} });
    expect(result.code).toBe(EXIT.REFUSED);
  });
  it('reports every problem at once', async () => {
    const { result } = await go({ node: 'v18.0.0', sqliteLoads: 'x', workingTreeClean: 'y' });
    expect(result.message).toMatch(/too old[\s\S]*node:sqlite[\s\S]*local changes/);
  });
  it('a snapshot that cannot be made: no deploy', async () => {
    const { calls, result } = await go({ snapshot: 'disk full' });
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.message).toContain('disk full');
    expect(mutating(calls)).toEqual([]);
  });
  it('a snapshot that reports no folder is no snapshot', async () => {
    const m = machine();
    m.host.snapshot = async () => ({ ok: true });
    const result = await runDeploy({ ref: 'main', host: m.host, log: () => {} });
    expect(result.code).toBe(EXIT.REFUSED);
  });
});

describe('a deploy that fails while preparing the new version', () => {
  it.each([['fetchAndCheckout', 'no such ref'], ['install', 'npm ci failed'], ['build', 'tsc found errors']])('%s: the service is never stopped or restarted, the previous version is put back, exit 10', async (name, why) => {
    const { calls, result, state } = await go({ [name]: [why] });
    expect(result.code).toBe(EXIT.ROLLED_BACK);
    expect(calls).not.toContain('restartService');
    expect(calls).not.toContain('stopService');
    expect(calls).not.toContain('restore');
    expect(calls.slice(calls.findIndex((c) => c.startsWith(name)) + 1)).toEqual([`checkout(${OLD})`, 'install', 'build']);
    expect(state.commit).toBe(OLD);
    expect(state.running).toBe(true);
    expect(result.message).toContain('was not touched');
  });
  it('and if the previous version cannot be rebuilt either: exit 11 with what to do by hand', async () => {
    const { result, calls } = await go({ build: ['tsc found errors', 'still broken'] });
    expect(result.code).toBe(EXIT.ROLLBACK_FAILED);
    expect(result.message).toContain(OLD);
    expect(result.message).toContain('npm run restore');
    expect(calls).not.toContain('restartService');
  });
  it('a step that throws, or hangs, is a failure like any other', async () => {
    const thrown = await go({ build: ['throw'] });
    expect(thrown.result.code).toBe(EXIT.ROLLED_BACK);
    const hung = await go({ install: ['hang'] });
    expect(hung.result.code).toBe(EXIT.ROLLED_BACK);
    expect(hung.lines.join('\n')).toContain('timed out');
  });
});

describe('a deploy whose new version does not come up', () => {
  it('stops, puts the previous code back, restores the snapshot, starts, checks: exit 10', async () => {
    const { calls, result, state } = await go({ waitHealthy: ['the page returned 502'] });
    expect(result.code).toBe(EXIT.ROLLED_BACK);
    const after = calls.slice(calls.indexOf('restartService'));
    expect(after).toEqual(['restartService', 'waitHealthy', 'stopService', `checkout(${OLD})`, 'install', 'build', 'restore(/b/20261011T020000Z)', 'startService', 'waitHealthy']);
    expect(state.commit).toBe(OLD);
    expect(state.running).toBe(true);
    expect(result.message).toContain('is running again');
    expect(result.message).toContain('502');
  });
  it('a restart that fails is handled the same way', async () => {
    const { calls, result } = await go({ restartService: ['systemd said no'] });
    expect(result.code).toBe(EXIT.ROLLED_BACK);
    expect(calls[calls.indexOf('restartService') + 1]).toBe('stopService');
    expect(calls).toContain('restore(/b/20261011T020000Z)');
  });
  it.each([
    ['stopService', 'cannot stop'],
    ['install', 'npm broke'],
    ['restore', 'snapshot unreadable'],
    ['startService', 'will not start'],
  ])('a rollback that fails at %s: exit 11 and what to do by hand', async (name, why) => {
    const plan = { waitHealthy: ['down'], [name]: name === 'install' ? ['ok', why] : [why] };
    // the first install (the new build) must work; the second (the rollback) fails
    const { result } = await go(plan);
    expect(result.code, name).toBe(EXIT.ROLLBACK_FAILED);
    expect(result.message).toContain(why);
    expect(result.message).toContain('By hand');
    expect(result.message).toContain('/b/20261011T020000Z');
  });
  it('a rollback whose restarted service still does not answer: exit 11', async () => {
    const { result } = await go({ waitHealthy: ['down', 'still down'] });
    expect(result.code).toBe(EXIT.ROLLBACK_FAILED);
    expect(result.message).toContain('still down');
  });
  it('a health check that hangs is a failure and is rolled back', async () => {
    const { result } = await go({ waitHealthy: ['hang'] });
    expect(result.code).toBe(EXIT.ROLLED_BACK);
  });
});

describe('what is printed', () => {
  it('never contains a secret the caller names, nor anything shaped like an Anthropic key', async () => {
    const secret = 'my-very-secret-value-123';
    const { lines, result } = await go({ build: [`error with ${secret} and sk-ant-api03-abcdefghijklmnop in it`, 'still broken'] }, { secrets: [secret] });
    const everything = lines.join('\n') + result.message;
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('sk-ant');
    expect(everything).toContain('[hidden]');
  });
  it('a logger that throws does not stop the deploy', async () => {
    const m = machine();
    const result = await runDeploy({ ref: 'main', host: m.host, log: () => { throw new Error('disk full'); } });
    expect(result.code).toBe(EXIT.DEPLOYED);
  });
  it('very short "secrets" are ignored rather than blanking ordinary words', async () => {
    const { result } = await go({}, { secrets: ['a', ''] });
    expect(result.message).toContain('Deployed');
  });
});
