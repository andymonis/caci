// What the status screen shows and does (R-011): ask CaCi for a status update, show the one answer. Pure logic
// over the notes client; the page only draws what this says.
//
// - One request at a time. An answer that arrives after `reset()` is dropped.
// - The answer is held in memory only and forgotten by `reset()` (sign-out, or leaving the screen).
// - Asking again replaces the answer; a failed ask keeps the last good answer and says why.
// - The person's time zone comes from the browser (`Intl`) and is sent only as a hint; the service checks it.
// - The mode (which model answers) comes from the service; until it is known nothing can be asked, so the notice
//   is always shown before the first request is sent.
// - Nothing here writes anything: a status is not filed in any brain.

import { failed } from './circles-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });

/** The browser's time zone, or `undefined` when it cannot say. */
export function browserTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

export function createStatusSession({ client, onSignedOut, timeZone = browserTimeZone }) {
  if (!client || typeof client.status !== 'function') throw new TypeError('createStatusSession needs a notes client');
  let epoch = 0;
  let busy = false;
  let mode = { status: 'unknown', value: null, error: null };
  let answer = null;
  let asked = '';
  const listeners = new Set();

  const snapshot = () => Object.freeze({ mode: Object.freeze({ ...mode }), answer, asked, busy, canAsk: mode.status === 'known' && !busy });

  function notify() {
    const view = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(view);
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

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Forget everything (sign-out, or leaving the screen). An answer still on its way is dropped. */
    reset() {
      epoch += 1;
      busy = false;
      mode = { status: 'unknown', value: null, error: null };
      answer = null;
      asked = '';
      notify();
    },

    /** Ask which model answers. Calling it again is the way to try after a failure. */
    async loadMode() {
      if (busy) return BUSY;
      busy = true;
      const mine = epoch;
      mode = { status: 'loading', value: null, error: null };
      notify();
      try {
        const r = await client.mode();
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          mode = { status: 'error', value: null, error: r.error.message };
          signedOut(r.error);
          return failed(r.error);
        }
        mode = { status: 'known', value: r.value.mode, error: null };
        return { ok: true };
      } finally {
        if (mine === epoch) busy = false;
        notify();
      }
    },

    /** Closes the answer and shows the empty form again. Nothing is sent. */
    clear() {
      if (busy) return false;
      answer = null;
      asked = '';
      notify();
      return true;
    },

    /** Asks for a status. The text is checked first by the client; a field problem comes back beside its field. */
    async ask(text) {
      if (mode.status !== 'known') return { ok: false, kind: 'mode-unknown', message: 'Could not tell which model answers.' };
      if (busy) return BUSY;
      busy = true;
      const mine = epoch;
      notify();
      try {
        const zone = typeof timeZone === 'function' ? timeZone() : undefined;
        const r = zone === undefined ? await client.status(text) : await client.status(text, zone);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          signedOut(r.error);
          return r.error.field === undefined ? failed(r.error) : { ...failed(r.error), errors: { [r.error.field]: r.error.message } };
        }
        answer = r.value;
        asked = typeof text === 'string' ? text.trim() : '';
        return { ok: true, status: r.value };
      } finally {
        if (mine === epoch) busy = false;
        notify();
      }
    },
  });
}
