// The update sequence of R-010, as logic with nothing global: every operation that touches the machine is a
// function of the `host` it is given (git, npm, systemctl, the snapshot, the restore, the health check), so the whole
// sequence and every failure branch can be tested with fakes. `run.mjs` (T-176) supplies the real host.
//
// Exit codes: 0 deployed; 10 failed and rolled back (the old version is running again, with the snapshot restored if
// the service had been restarted); 11 failed and the rollback also failed (the message says what to do by hand);
// 12 refused before anything changed.

export const EXIT = Object.freeze({ DEPLOYED: 0, ROLLED_BACK: 10, ROLLBACK_FAILED: 11, REFUSED: 12 });
export const MIN_NODE = Object.freeze([22, 13]);

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A ref (branch, tag or commit) is a short word of plain characters: nothing that could be read as an option or a path trick. */
export function validateRef(ref) {
  if (typeof ref !== 'string' || !REF.test(ref)) return 'the ref must be 1 to 200 letters, digits, dots, dashes, underscores or slashes, starting with a letter or digit';
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return 'the ref has a shape git refuses or that could name something else';
  return undefined;
}

/** `v22.19.0` is at least 22.13. */
export function nodeAtLeast(version, [major, minor] = MIN_NODE) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

const DEFAULT_TIMEOUTS = Object.freeze({ install: 20 * 60_000, build: 10 * 60_000, health: 90_000, other: 5 * 60_000 });

/**
 * @param {object} options
 * @param {string} options.ref what to deploy
 * @param {object} options.host the operations (see `FAKE` in the tests for the shape); each returns `{ ok, detail? }` or throws
 * @param {(line: string) => void} options.log
 * @param {readonly string[]} [options.secrets] strings that must never be printed (replaced by [hidden])
 * @param {Partial<typeof DEFAULT_TIMEOUTS>} [options.timeoutMs]
 */
export async function runDeploy({ ref, host, log, secrets = [], timeoutMs = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeoutMs };
  const hidden = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const clean = (text) => {
    let out = String(text ?? '').replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[hidden]');
    for (const s of hidden) out = out.split(s).join('[hidden]');
    return out;
  };
  const say = (line) => {
    try {
      log(clean(line));
    } catch {
      // a broken logger must not stop a deploy
    }
  };

  /** Runs one named operation with a time limit; never throws; a throw, a refusal and a hang are all `{ ok: false }`. */
  async function step(name, limit, op) {
    say(`-> ${name}`);
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(op),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${Math.round(limit / 1000)} s` }), limit);
        }),
      ]);
      const ok = result !== null && typeof result === 'object' && result.ok === true;
      if (!ok) say(`   failed: ${clean(result?.detail ?? 'no reason given')}`);
      return { ok, detail: ok ? result.detail : (result?.detail ?? 'failed'), value: result };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      say(`   failed: ${clean(detail)}`);
      return { ok: false, detail };
    } finally {
      clearTimeout(timer);
    }
  }
  const finish = (code, message, extra = {}) => {
    say(message);
    return { code, message: clean(message), ...extra };
  };

  // 1. Refuse before anything changes.
  const refProblem = validateRef(ref);
  if (refProblem !== undefined) return finish(EXIT.REFUSED, `Refused: ${refProblem}. Nothing was changed.`);
  const problems = [];
  const node = await step('check the Node version', limits.other, async () => ({ ok: true, detail: await host.nodeVersion() }));
  if (!node.ok || !nodeAtLeast(node.detail)) problems.push(`Node ${node.detail ?? '?'} is too old: node:sqlite needs ${MIN_NODE.join('.')} or later`);
  const sqlite = await step('check that node:sqlite loads', limits.other, () => host.sqliteLoads());
  if (!sqlite.ok) problems.push(`node:sqlite does not load (${sqlite.detail})`);
  const tree = await step('check the checkout has no local changes', limits.other, () => host.workingTreeClean());
  if (!tree.ok) problems.push(`the checkout has local changes or cannot be read (${tree.detail})`);
  const head = await step('note the current commit', limits.other, () => host.currentCommit());
  const previous = head.ok ? head.value.commit : undefined;
  if (typeof previous !== 'string' || !/^[0-9a-f]{7,64}$/.test(previous)) problems.push('the current commit could not be read');
  if (problems.length > 0) return finish(EXIT.REFUSED, `Refused:\n  ${problems.join('\n  ')}\nNothing was changed.`);

  // 2. A snapshot first: no snapshot, no deploy.
  const snap = await step('snapshot the data', limits.other, () => host.snapshot());
  const snapshot = snap.ok ? snap.value.folder : undefined;
  if (!snap.ok || typeof snapshot !== 'string' || snapshot === '') return finish(EXIT.REFUSED, `Refused: the data could not be snapshotted (${snap.detail ?? 'no folder reported'}). Nothing was changed.`);

  /** Puts the previous commit back and rebuilds it. Used by both failure paths. */
  async function rebuildPrevious() {
    for (const [name, limit, op] of [
      [`check out ${previous}`, limits.other, () => host.checkout(previous)],
      ['install the previous dependencies', limits.install, () => host.install()],
      ['rebuild the previous version', limits.build, () => host.build()],
    ]) {
      const r = await step(name, limit, op);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  const byHand = (what) => `${what}\nBy hand: check out ${previous} in the checkout, run npm ci and npm run build, restore the snapshot ${snapshot} with npm run restore -- ${snapshot} --yes (service stopped), then start the service.`;

  // 3. Prepare the new version without touching the running service.
  for (const [name, limit, op] of [
    [`fetch and check out ${ref}`, limits.other, () => host.fetchAndCheckout(ref)],
    ['install the dependencies (npm ci)', limits.install, () => host.install()],
    ['build', limits.build, () => host.build()],
  ]) {
    const r = await step(name, limit, op);
    if (r.ok) continue;
    const back = await rebuildPrevious();
    return back.ok
      ? finish(EXIT.ROLLED_BACK, `Failed at "${name}". The running service was not touched and the previous version (${previous}) is in place again.`, { previous, snapshot })
      : finish(EXIT.ROLLBACK_FAILED, byHand(`Failed at "${name}", and the previous version could not be put back (${back.detail}). The running service has not been restarted.`), { previous, snapshot });
  }
  const now = await step('note the new commit', limits.other, () => host.currentCommit());
  const current = now.ok ? now.value.commit : undefined;

  // 4. Switch, and check the family can use it.
  const restart = await step('restart the service', limits.other, () => host.restartService());
  const healthy = restart.ok ? await step('wait for the service to answer', limits.health, () => host.waitHealthy()) : restart;
  if (healthy.ok) return finish(EXIT.DEPLOYED, `Deployed ${ref}${current === undefined ? '' : ` (${current})`}. The previous version was ${previous}; the snapshot ${snapshot} is kept.`, { previous, current, snapshot });

  // 5. Undo: stop, put the previous code back, restore the data it understands, start, check.
  say('Rolling back.');
  const failed = (what, r) => finish(EXIT.ROLLBACK_FAILED, byHand(`The new version did not come up (${healthy.detail}), and the rollback failed at "${what}" (${r.detail}).`), { previous, snapshot });
  const stop = await step('stop the service', limits.other, () => host.stopService());
  if (!stop.ok) return failed('stop the service', stop);
  const back = await rebuildPrevious();
  if (!back.ok) return failed('put the previous version back', back);
  const restored = await step(`restore the snapshot ${snapshot}`, limits.other, () => host.restore(snapshot));
  if (!restored.ok) return failed('restore the snapshot', restored);
  const start = await step('start the service', limits.other, () => host.startService());
  if (!start.ok) return failed('start the service', start);
  const again = await step('wait for the service to answer', limits.health, () => host.waitHealthy());
  if (!again.ok) return failed('check the service answers', again);
  return finish(EXIT.ROLLED_BACK, `The new version did not come up (${healthy.detail}). The previous version (${previous}) is running again with the data of the snapshot ${snapshot}.`, { previous, snapshot });
}
