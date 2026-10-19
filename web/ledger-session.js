// What the change-log screen shows and does (R-014): the entries of one brain, newest first, a page at a time. Pure logic
// over the ledger client; the page only draws what this says.
//
// - Nothing is requested until `open` is called (the page does that when the person asks, not on load).
// - The scope is page state: the person's own notes or one circle. A circle that cannot be read any more (the person left,
//   or it was deleted) is `lost` with the one set of words; `useOwn()` falls back to their own notes.
// - One request at a time; an answer that arrives after `reset()` or after another `open` is dropped.
// - Entries are held in memory only and forgotten by `reset()` (sign-out, or leaving the screen).
// - A failed "show more" keeps what was already shown.

import { failed } from './circles-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const PAGE = 50;

const sameScope = (a, b) => (a?.kind === 'circle' ? b?.kind === 'circle' && a.circleId === b.circleId : b?.kind !== 'circle');

export function createLedgerSession({ client, onSignedOut }) {
  if (!client || typeof client.list !== 'function') throw new TypeError('createLedgerSession needs a ledger client');
  let epoch = 0;
  let busy = false;
  let status = 'idle'; // idle | loading | loaded | error | lost
  let error = null;
  let scope; // undefined = own notes
  let items = [];
  let nextCursor = null;
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      status,
      error,
      scope,
      items: Object.freeze([...items]),
      nextCursor,
      hasMore: nextCursor !== null,
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

  function signedOut(e) {
    if (e.kind !== 'signed-out' || typeof onSignedOut !== 'function') return;
    try {
      onSignedOut();
    } catch {
      // ignored
    }
  }

  /** Loads the first page of `target` (replacing what is shown) or the next page of the current scope. */
  async function load(target, append) {
    if (busy) return BUSY;
    busy = true;
    const mine = epoch;
    const before = { status, error };
    status = 'loading';
    error = null;
    notify();
    try {
      const r = await client.list(target, append ? { limit: PAGE, cursor: nextCursor } : { limit: PAGE });
      if (mine !== epoch) return DROPPED;
      if (!r.ok) {
        if (r.error.kind === 'not-found') {
          scope = target;
          items = [];
          nextCursor = null;
          status = 'lost';
          error = r.error.message;
        } else {
          status = append || before.status === 'loaded' ? 'loaded' : 'error';
          error = r.error.message;
          if (!append && before.status !== 'loaded') {
            items = [];
            nextCursor = null;
          }
        }
        signedOut(r.error);
        return failed(r.error);
      }
      scope = target;
      items = append ? [...items, ...r.value.items] : [...r.value.items];
      nextCursor = r.value.nextCursor;
      status = 'loaded';
      return { ok: true };
    } catch {
      if (mine !== epoch) return DROPPED;
      status = 'error';
      error = 'Something went wrong on the service. Try again in a moment.';
      return { ok: false, kind: 'server', message: error };
    } finally {
      if (mine === epoch) busy = false;
      notify();
    }
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Forget everything (sign-out, or leaving the screen). A request still on its way is dropped. */
    reset() {
      epoch += 1;
      busy = false;
      status = 'idle';
      error = null;
      scope = undefined;
      items = [];
      nextCursor = null;
      notify();
    },
    /** Show the log of `target` (undefined or personal = own notes), from the newest. */
    open: (target) => load(target?.kind === 'circle' ? { kind: 'circle', circleId: target.circleId } : undefined, false),
    /** Load the log again for the scope being shown. */
    refresh: () => load(scope, false),
    /** The next older page, when there is one. */
    more() {
      if (nextCursor === null) return Promise.resolve(Object.freeze({ ok: false, kind: 'none', message: 'There are no older entries.' }));
      return load(scope, true);
    },
    /** After a lost circle: show the person's own notes instead. */
    useOwn: () => load(undefined, false),
    isShowing: (target) => sameScope(scope, target),
  });
}
