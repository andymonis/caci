// Which brain the Capture and Brain screens are pointed at (R-009): the person's own, one circle's, or (to read)
// all of them together as My Brain. Pure logic over the notes client; the page only draws what this says.
//
// - The list of scopes comes from the service, which says where the person may read and where they may capture
//   (an observer reads and cannot capture). The choice is page state: nothing is kept in the browser.
// - A choice that is no longer on the list (the person left a circle) falls back to their own notes at the next load.
// - One request at a time; an answer after `reset()` is dropped.

import { failed } from './circles-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
export const PERSONAL_LABEL = 'My own notes';
export const MINE_LABEL = 'My Brain (my notes and my circles together)';

const keyOf = (scope) => (scope.kind === 'personal' ? 'personal' : `circle:${scope.circleId}`);

export function createScopeSession({ client, onSignedOut }) {
  if (!client || typeof client.scopes !== 'function') throw new TypeError('createScopeSession needs a notes client');
  let epoch = 0;
  let busy = false;
  let status = 'idle'; // idle | loading | loaded | error
  let error = null;
  let scopes = [];
  let captureKey = 'personal';
  let browseKey = 'personal';
  const listeners = new Set();

  const find = (key) => scopes.find((s) => s.key === key);
  const snapshot = () =>
    Object.freeze({
      status,
      error,
      scopes: Object.freeze(scopes.map((s) => Object.freeze({ ...s }))),
      captureKey,
      browseKey,
      /** The scope to send with a note: nothing for the person's own brain. */
      captureScope: captureKey === 'personal' ? undefined : find(captureKey)?.scope,
      /** The scope to read: `mine`, or a scope object (undefined for the person's own brain). */
      browseScope: browseKey === 'mine' ? 'mine' : browseKey === 'personal' ? undefined : find(browseKey)?.scope,
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

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    reset() {
      epoch += 1;
      busy = false;
      status = 'idle';
      error = null;
      scopes = [];
      captureKey = 'personal';
      browseKey = 'personal';
      notify();
    },

    /** (Re)load the list of scopes. Choices that are no longer possible fall back to the person's own notes. */
    async load() {
      if (busy) return BUSY;
      busy = true;
      const mine = epoch;
      status = 'loading';
      error = null;
      notify();
      try {
        const r = await client.scopes();
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          status = 'error';
          error = r.error.message;
          scopes = [];
          captureKey = 'personal';
          browseKey = 'personal';
          if (r.error.kind === 'signed-out' && typeof onSignedOut === 'function') {
            try {
              onSignedOut();
            } catch {
              // ignored
            }
          }
          return failed(r.error);
        }
        scopes = r.value.items.map((s) => ({
          key: keyOf(s.scope),
          scope: s.scope.kind === 'personal' ? { kind: 'personal' } : { kind: 'circle', circleId: s.scope.circleId, circleName: s.scope.circleName },
          label: s.scope.kind === 'personal' ? PERSONAL_LABEL : s.scope.circleName,
          ...(s.role === undefined ? {} : { role: s.role }),
          canCapture: s.canCapture,
        }));
        status = 'loaded';
        if (find(captureKey)?.canCapture !== true) captureKey = 'personal';
        if (browseKey !== 'mine' && find(browseKey) === undefined) browseKey = 'personal';
        return { ok: true };
      } finally {
        if (mine === epoch) busy = false;
        notify();
      }
    },

    /** Point capture at a scope the person may capture into; anything else is refused and nothing changes. */
    chooseCapture(key) {
      if (find(key)?.canCapture !== true) return false;
      captureKey = key;
      notify();
      return true;
    },

    /** Point reading at a scope on the list, or at `mine`. */
    chooseBrowse(key) {
      if (key !== 'mine' && find(key) === undefined) return false;
      browseKey = key;
      notify();
      return true;
    },
  });
}
