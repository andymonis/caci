// What the join screen of the everyday app shows and does (R-023): a person opens a link they were sent, sees which circle it is for
// and what role it offers, and joins (or asks to). Pure logic over the join client; the page only draws what this says.
//
// - **The token is held in memory only**, never in the state a page can read, in no storage and in no address after the page has
//   cleaned it; it is forgotten as soon as it is not needed (a miss, an answer, a reset).
// - Nothing is sent but the token in a request body, and only when `open` is called (a person has to be signed in).
// - One request at a time (joining is only possible from `ready`, so a second press while one is out has nothing to do); an answer
//   for a link that is no longer open is dropped.
// - A link that does not work, for any reason, is `miss`, and the person's own waiting requests are then listed (a one-use link is
//   spent by asking, so opening it again is a miss while the request waits).

import { failed } from './circles-session.js';

const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const NOT_READY = Object.freeze({ ok: false, kind: 'not-ready', message: 'There is no link to join by.' });

export function createJoinSession({ client, onSignedOut }) {
  if (!client || typeof client.preview !== 'function' || typeof client.join !== 'function' || typeof client.myRequests !== 'function') throw new TypeError('createJoinSession needs a join client');
  let epoch = 0;
  let busy = false;
  let token = null;
  let status = 'idle'; // idle | loading | ready | joining | joined | member | requested | waiting | miss | unavailable | error
  let preview = null;
  let result = null;
  let message = null;
  let problem = null;
  let mine = { status: 'idle', items: [], message: null };
  const listeners = new Set();

  const snapshot = () => Object.freeze({ status, preview, result, message, problem, mine: Object.freeze({ status: mine.status, items: Object.freeze([...mine.items]), message: mine.message }), busy });

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
    if (error.kind === 'signed-out' && typeof onSignedOut === 'function') {
      try {
        onSignedOut();
      } catch {
        // ignored
      }
    }
  }

  async function exclusive(work) {
    busy = true;
    const mineEpoch = epoch;
    notify();
    try {
      return await work(mineEpoch);
    } finally {
      if (mineEpoch === epoch) busy = false;
      notify();
    }
  }

  /** The person's own waiting requests: shown after a miss, an ask or a wait. A failure here is shown, never a reason to fail the step before it. */
  async function loadMine(mineEpoch) {
    mine = { status: 'loading', items: [], message: null };
    const r = await client.myRequests({ limit: 100 });
    if (mineEpoch !== epoch) return;
    if (r.ok) mine = { status: 'loaded', items: [...r.value.items], message: null };
    else {
      mine = { status: r.error.kind === 'unavailable' ? 'unavailable' : 'error', items: [], message: r.error.message };
      signedOut(r.error);
    }
  }

  async function miss(mineEpoch) {
    token = null;
    preview = null;
    status = 'miss';
    message = null;
    await loadMine(mineEpoch);
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The person opened a link: ask the service what it is for. */
    open(link) {
      epoch++;
      busy = false;
      token = typeof link === 'string' ? link : null;
      status = 'loading';
      preview = null;
      result = null;
      message = null;
      problem = null;
      mine = { status: 'idle', items: [], message: null };
      return exclusive(async (mineEpoch) => {
        const r = await client.preview(token);
        if (mineEpoch !== epoch) return DROPPED;
        if (!r.ok) {
          signedOut(r.error);
          if (r.error.kind === 'not-found') {
            await miss(mineEpoch);
            return mineEpoch === epoch ? failed(r.error) : DROPPED;
          }
          token = null;
          status = r.error.kind === 'unavailable' ? 'unavailable' : 'error';
          message = r.error.message;
          return failed(r.error);
        }
        preview = r.value;
        status = 'ready';
        return { ok: true };
      });
    },

    /** The person chose to join (or to ask). */
    join() {
      if (token === null || status !== 'ready') return Promise.resolve(NOT_READY);
      problem = null;
      return exclusive(async (mineEpoch) => {
        status = 'joining';
        notify();
        const r = await client.join(token);
        if (mineEpoch !== epoch) return DROPPED;
        if (!r.ok) {
          signedOut(r.error);
          if (r.error.kind === 'not-found') {
            await miss(mineEpoch);
            return mineEpoch === epoch ? failed(r.error) : DROPPED;
          }
          status = 'ready'; // a limit, a wait or a failure: the person may try again
          problem = r.error.message;
          return failed(r.error);
        }
        token = null;
        result = r.value;
        status = r.value.state;
        preview = null;
        if (r.value.state === 'requested' || r.value.state === 'waiting') await loadMine(mineEpoch);
        return mineEpoch === epoch ? { ok: true } : DROPPED;
      });
    },

    /** Signed out, or off this screen: forget everything, the token included. */
    reset() {
      epoch++;
      busy = false;
      token = null;
      status = 'idle';
      preview = null;
      result = null;
      message = null;
      problem = null;
      mine = { status: 'idle', items: [], message: null };
      notify();
    },
  });
}
