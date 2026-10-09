// What the capture screen shows and does (R-007): which model files the note, the one current proposal and
// its preview, approving and rejecting it. Pure logic over the notes client; the page only draws what this says.
//
// - One request at a time. An answer that arrives after `reset()` is dropped.
// - Nothing is written until `approve`; a refused write keeps the proposal for another try or a reject.
// - A proposal that has expired, or that the service no longer has (it was forgotten on a restart), is said in
//   words and the person starts again; nothing is retried by itself.
// - A proposal is held in memory only and forgotten by `reset()` (sign-out, or leaving the screen).
// - The mode comes from the service; until it is known nothing can be proposed (`canPropose` is false).

import { failed } from './circles-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
/** What an answer that arrives after `reset()` becomes: nothing happens and nobody is told. */
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });

export function createCaptureSession({ client, onSignedOut, onWritten }) {
  if (!client || typeof client.propose !== 'function') throw new TypeError('createCaptureSession needs a notes client');
  let epoch = 0;
  let busy = false;
  let mode = { status: 'unknown', value: null, error: null };
  let proposal = null;
  let outcome = null; // what happened to the last proposal: written, rejected, expired or gone
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      mode: Object.freeze({ ...mode }),
      proposal,
      outcome,
      phase: proposal !== null ? 'preview' : outcome !== null ? 'done' : 'form',
      canPropose: mode.status === 'known' && proposal === null && !busy,
      busy,
    });

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

  async function exclusive(work) {
    if (busy) return BUSY;
    busy = true;
    const mine = epoch;
    notify();
    try {
      const result = await work(mine);
      if (result.kind === 'signed-out' && typeof onSignedOut === 'function') {
        try {
          onSignedOut();
        } catch {
          // ignored
        }
      }
      return result;
    } finally {
      if (mine === epoch) busy = false;
      notify();
    }
  }

  const gone = (error) => ({ kind: error.kind === 'expired' ? 'expired' : 'gone', message: error.message });

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Forget everything (sign-out, or leaving the capture screen). Answers still on their way are dropped. */
    reset() {
      epoch += 1;
      busy = false;
      mode = { status: 'unknown', value: null, error: null };
      proposal = null;
      outcome = null;
      notify();
    },

    /** Ask which model files notes. Calling it again is the way to try after a failure. */
    loadMode: () =>
      exclusive(async (mine) => {
        mode = { status: 'loading', value: null, error: null };
        notify();
        const r = await client.mode();
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          mode = { status: 'error', value: null, error: r.error.message };
          return failed(r.error);
        }
        mode = { status: 'known', value: r.value.mode, error: null };
        return { ok: true };
      }),

    /** Ask the model how to file a note. Needs the mode to be known; the note is checked first by the client. Nothing is written. */
    propose(text) {
      if (mode.status !== 'known') return Promise.resolve({ ok: false, kind: 'mode-unknown', message: 'Could not tell which model files your notes.' });
      if (proposal !== null) return Promise.resolve({ ok: false, kind: 'pending', message: 'Approve or reject the current proposal first.' });
      return exclusive(async (mine) => {
        const r = await client.propose(text);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) return r.error.field === undefined ? failed(r.error) : { ...failed(r.error), errors: { [r.error.field]: r.error.message } };
        proposal = r.value;
        outcome = null;
        return { ok: true, proposal: r.value };
      });
    },

    /** Write the current proposal. A refused write keeps it; a gone or expired one ends it in words. */
    approve() {
      if (proposal === null) return Promise.resolve({ ok: false, kind: 'nothing-pending', message: 'There is nothing to approve.' });
      const held = proposal;
      return exclusive(async (mine) => {
        const r = await client.approve(held.id);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' || r.error.kind === 'expired') {
            proposal = null;
            outcome = gone(r.error);
          }
          return failed(r.error);
        }
        proposal = null;
        outcome = { kind: 'written', applied: r.value.applied, summary: r.value.summary };
        if (typeof onWritten === 'function') {
          try {
            onWritten();
          } catch {
            // ignored
          }
        }
        return { ok: true, applied: r.value.applied, summary: r.value.summary };
      });
    },

    /** Discard the current proposal. Nothing is written. */
    reject() {
      if (proposal === null) return Promise.resolve({ ok: false, kind: 'nothing-pending', message: 'There is nothing to reject.' });
      const held = proposal;
      return exclusive(async (mine) => {
        const r = await client.reject(held.id);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' || r.error.kind === 'expired') {
            proposal = null;
            outcome = gone(r.error);
          }
          return failed(r.error);
        }
        proposal = null;
        outcome = { kind: 'rejected' };
        return { ok: true };
      });
    },

    /** Close the outcome and show the form again. Nothing is sent. */
    startAgain() {
      if (busy || proposal !== null) return false;
      outcome = null;
      notify();
      return true;
    },
  });
}
