// What the page is doing and what it shows (R-005): loading, signed out, signed in, or unable to
// reach the service. Pure logic over an API client; the page only draws what this says.
//
// - Signed in means `GET /api/me` said so. Nothing is stored: no storage, no cookie access.
// - A form cannot be sent twice at once.
// - After registering the person is signed in with the same values (D10).
// - A password passes through a call and is not kept: it is in no state, no listener argument, no result.

import { checkLogin, checkRegister } from './forms.js';

const snapshot = (state) => Object.freeze({ screen: state.screen, user: state.user, busy: state.busy, notice: state.notice });

/** Turns an API error into what a form shows: a message per field, or a general one. */
function shown(error) {
  const base = { ok: false, kind: error.kind, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) };
  return error.field === undefined ? { ...base, message: error.message } : { ...base, errors: { [error.field]: error.message }, message: error.message };
}

export function createSession({ api }) {
  if (!api || typeof api.me !== 'function') throw new TypeError('createSession needs an API client');
  let state = { screen: 'loading', user: null, busy: false, notice: null };
  const listeners = new Set();

  function change(next) {
    state = { ...state, ...next };
    const view = snapshot(state);
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        // a broken listener must not stop the others or the session
      }
    }
  }

  /** Runs `work` as the one request in flight; a second call meanwhile is refused. */
  async function exclusive(work) {
    if (state.busy) return { ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' };
    change({ busy: true });
    try {
      return await work();
    } finally {
      change({ busy: false });
    }
  }

  return Object.freeze({
    getState: () => snapshot(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Finds out who is signed in. Also the way to try again after the service could not be reached. */
    async start() {
      change({ screen: 'loading', notice: null });
      const r = await api.me();
      if (r.ok) change({ screen: 'signed-in', user: r.value, notice: null });
      else if (r.error.kind === 'signed-out') change({ screen: 'signed-out', user: null, notice: null });
      else change({ screen: 'unreachable', user: null, notice: r.error.message });
    },

    register: (input) =>
      exclusive(async () => {
        const checked = checkRegister(input);
        if (!checked.ok) return { ok: false, kind: 'invalid', errors: checked.errors };
        const { username, displayName, email, password } = checked.value;
        const made = await api.register({ username, displayName, ...(email === undefined ? {} : { email }), password });
        if (!made.ok) return shown(made.error);
        const signedIn = await api.login({ username, password });
        if (!signedIn.ok) {
          change({ screen: 'signed-out', user: null, notice: null });
          return { ok: false, kind: 'signin-after-register', accountCreated: true, message: `Your account was made, but signing you in failed: ${signedIn.error.message} Try signing in.` };
        }
        change({ screen: 'signed-in', user: signedIn.value, notice: null });
        return { ok: true };
      }),

    signIn: (input) =>
      exclusive(async () => {
        const checked = checkLogin(input);
        if (!checked.ok) return { ok: false, kind: 'invalid', errors: checked.errors };
        const r = await api.login({ username: checked.value.username, password: checked.value.password });
        if (!r.ok) return shown(r.error);
        change({ screen: 'signed-in', user: r.value, notice: null });
        return { ok: true };
      }),

    /** Signed out is signed out, also if the service says you already were. If it cannot be reached you may still be signed in, and the page says so. */
    signOut: () =>
      exclusive(async () => {
        const r = await api.logout();
        if (r.ok || r.error.kind === 'signed-out') {
          change({ screen: 'signed-out', user: null, notice: null });
          return { ok: true };
        }
        change({ notice: `Could not sign you out: ${r.error.message} You may still be signed in.` });
        return shown(r.error);
      }),
  });
}
