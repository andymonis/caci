// What the Settings screen does (R-016): change the display name and email, change the password. Pure logic over the account
// client; the page only draws what this says.
//
// - One request at a time; a second call meanwhile sends nothing (`busy`).
// - A blank field means "leave it as it is". The service is the authority on everything the early checks do not cover.
// - A password is never kept: not in the state, not in a result, not in a notice.
// - A change of password also ends the person's other sessions (the service does that); this session stays.

import { checkPasswordChange, checkProfile } from './forms.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });

export function createSettingsSession({ api, onSignedOut, onUser }) {
  if (!api || typeof api.updateMe !== 'function' || typeof api.changePassword !== 'function') throw new TypeError('createSettingsSession needs an account client');
  let busy = false;
  let notice = '';
  const listeners = new Set();
  const snapshot = () => Object.freeze({ busy, notice });
  function notify() {
    const view = snapshot();
    for (const l of [...listeners]) {
      try {
        l(view);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }
  function signedOut(error) {
    if (error.kind !== 'signed-out' || typeof onSignedOut !== 'function') return;
    try {
      onSignedOut();
    } catch {
      // ignored
    }
  }

  async function run(call, done) {
    if (busy) return BUSY;
    busy = true;
    notice = '';
    notify();
    try {
      const r = await call();
      if (!r.ok) {
        signedOut(r.error);
        return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message, ...(r.error.field === undefined ? {} : { errors: Object.freeze({ [r.error.field]: r.error.message }) }), ...(r.error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: r.error.retryAfterSeconds }) });
      }
      notice = done;
      if (typeof onUser === 'function') {
        try {
          onUser(r.value);
        } catch {
          // ignored
        }
      }
      return Object.freeze({ ok: true, user: r.value });
    } catch {
      return Object.freeze({ ok: false, kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
    } finally {
      busy = false;
      notify();
    }
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** `{ displayName?, email? }`: only what is filled in is changed. */
    saveProfile(input) {
      if (busy) return Promise.resolve(BUSY);
      const checked = checkProfile(input);
      if (!checked.ok) return Promise.resolve(Object.freeze({ ok: false, kind: 'invalid', message: 'Please check what you typed.', errors: checked.errors }));
      return run(() => api.updateMe(checked.value), 'Saved.');
    },
    /** Takes the email off the account. */
    removeEmail() {
      if (busy) return Promise.resolve(BUSY);
      return run(() => api.updateMe({ email: null }), 'Your email was removed.');
    },
    /** `{ currentPassword, newPassword }` */
    changePassword(input) {
      if (busy) return Promise.resolve(BUSY);
      const checked = checkPasswordChange(input);
      if (!checked.ok) return Promise.resolve(Object.freeze({ ok: false, kind: 'invalid', message: 'Please check what you typed.', errors: checked.errors }));
      return run(() => api.changePassword({ currentPassword: checked.value.currentPassword, newPassword: checked.value.newPassword }), 'Your password was changed. Your other devices were signed out.');
    },
    /** Forget the notice (leaving the screen, or signing out). */
    reset() {
      notice = '';
      notify();
    },
  });
}
