// What the "Join links" and "Waiting to join" parts of a circle's screen show and do (R-023): making a link (and showing its
// token once), the live links with their uses, withdrawing one, and the waiting requests with Approve and Decline. Pure logic over
// the join client; the page only draws what this says.
//
// - Nothing is requested until `open`. One request at a time. An answer for a circle that is no longer open is dropped.
// - **A new link's token is held in memory until it is dismissed, replaced or the screen is left**; it is in no list, no notice, and
//   never in any browser storage.
// - Withdrawing a link is two steps: ask, then confirm or cancel. Approving and declining act at once.
// - Every change reloads what it changed; a view is as old as its last load.

import { failed } from './circles-session.js';

const PAGE = 100;
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const NOT_OPEN = Object.freeze({ ok: false, kind: 'not-open', message: 'Show the join links first.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
export const LABEL_MAX = 80;
export const MAX_DAYS = 30;
export const MAX_USES = 100;
export const LINK_ROLES = Object.freeze(['member', 'observer']);

export const CREATED_NOTICE = 'Link made. Copy it now: it is shown only this once and cannot be recovered.';

const hasControl = (text) => {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return true;
  }
  return false;
};

/** Early feedback for the form that makes a link; the service is the authority and may say more. */
export function checkJoinLink(input) {
  const errors = {};
  const raw = input && typeof input === 'object' ? input : {};
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label === '') errors.label = 'Give the link a name, so you can tell your links apart.';
  else if ([...label].length > LABEL_MAX) errors.label = `A name is at most ${LABEL_MAX} characters.`;
  else if (hasControl(label)) errors.label = 'A name cannot contain control characters.';
  if (typeof raw.role !== 'string' || !LINK_ROLES.includes(raw.role)) errors.role = 'Choose member or observer.';
  if (!Number.isInteger(raw.days) || raw.days < 1 || raw.days > MAX_DAYS) errors.days = `Days is a whole number from 1 to ${MAX_DAYS}.`;
  if (!Number.isInteger(raw.uses) || raw.uses < 1 || raw.uses > MAX_USES) errors.uses = `Uses is a whole number from 1 to ${MAX_USES}.`;
  if (typeof raw.approval !== 'boolean') errors.approval = 'Choose whether each person needs approval.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { label, role: raw.role, days: raw.days, uses: raw.uses, approval: raw.approval } };
}

export function createJoinLinksSession({ client, onSignedOut, onChanged }) {
  if (!client || typeof client.createLink !== 'function' || typeof client.listRequests !== 'function') throw new TypeError('createJoinLinksSession needs a join client');
  let epoch = 0;
  let busy = false;
  let circleId = null;
  let status = 'idle'; // idle | loading | loaded | unavailable | gone | error
  let message = null;
  let links = [];
  let requests = [];
  let created = null; // { token, link }
  let asking = null; // a link id
  let notice = null;
  let problem = null;
  let problemField = null;
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      circleId,
      status,
      message,
      links: Object.freeze([...links]),
      requests: Object.freeze([...requests]),
      created,
      asking,
      notice,
      problem,
      problemField,
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
    const token = epoch;
    notify();
    try {
      const result = await work(token);
      if (result.kind === 'signed-out' && typeof onSignedOut === 'function') {
        try {
          onSignedOut();
        } catch {
          // ignored
        }
      }
      return result;
    } finally {
      if (token === epoch) busy = false;
      notify();
    }
  }

  function problemOf(error) {
    problem = error.message;
    problemField = error.field ?? null;
  }

  function ended(error) {
    links = [];
    requests = [];
    created = null;
    asking = null;
    notice = null;
    problem = null;
    problemField = null;
    message = error.message;
    status = error.kind === 'unavailable' ? 'unavailable' : error.kind === 'not-found' ? 'gone' : 'error';
  }

  /** The links and the waiting requests, both from the service (a page of 100 holds all either can have). */
  async function loadBoth(token) {
    const l = await client.listLinks(circleId, { limit: PAGE });
    if (token !== epoch) return DROPPED;
    if (!l.ok) {
      ended(l.error);
      return failed(l.error);
    }
    const r = await client.listRequests(circleId, { limit: PAGE });
    if (token !== epoch) return DROPPED;
    if (!r.ok) {
      ended(r.error);
      return failed(r.error);
    }
    links = [...l.value.items];
    requests = [...r.value.items];
    status = 'loaded';
    message = null;
    return { ok: true };
  }

  /** After an action: reload what it changed. A failed reload is the person's problem to see; the action still counts. */
  async function reloaded(token, kind) {
    if (kind === 'links') {
      const l = await client.listLinks(circleId, { limit: PAGE });
      if (token !== epoch) return DROPPED;
      if (l.ok) links = [...l.value.items];
      else problemOf(l.error);
      return l.ok ? { ok: true } : failed(l.error);
    }
    const r = await client.listRequests(circleId, { limit: PAGE });
    if (token !== epoch) return DROPPED;
    if (r.ok) requests = [...r.value.items];
    else problemOf(r.error);
    return r.ok ? { ok: true } : failed(r.error);
  }

  function changed() {
    if (typeof onChanged === 'function') {
      try {
        onChanged();
      } catch {
        // ignored
      }
    }
  }

  const clearMessages = () => {
    notice = null;
    problem = null;
    problemField = null;
  };

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    open(id) {
      epoch++;
      busy = false;
      circleId = id;
      status = 'loading';
      message = null;
      links = [];
      requests = [];
      created = null;
      asking = null;
      clearMessages();
      return exclusive((token) => loadBoth(token));
    },

    /** Makes a link from the form's values; the token is held until it is dismissed. */
    create(input) {
      if (circleId === null || status !== 'loaded') return Promise.resolve(NOT_OPEN);
      const checked = checkJoinLink(input);
      clearMessages();
      if (!checked.ok) {
        const [field, text] = Object.entries(checked.errors)[0];
        problem = text;
        problemField = field;
        notify();
        return Promise.resolve({ ok: false, kind: 'invalid', field, message: text, errors: checked.errors });
      }
      return exclusive(async (token) => {
        asking = null;
        const r = await client.createLink(circleId, checked.value);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') ended(r.error);
          else problemOf(r.error);
          return failed(r.error);
        }
        created = { token: r.value.token, link: r.value.link };
        notice = CREATED_NOTICE;
        await reloaded(token, 'links');
        return { ok: true };
      });
    },

    /** The person has copied the link: forget the token. */
    dismissCreated() {
      if (created === null) return false;
      created = null;
      notice = null;
      notify();
      return true;
    },

    askRevoke(linkId) {
      if (busy || status !== 'loaded' || !links.some((l) => l.id === linkId)) return false;
      clearMessages();
      asking = linkId;
      notify();
      return true;
    },
    cancel() {
      if (asking === null) return false;
      asking = null;
      notify();
      return true;
    },
    confirmRevoke() {
      if (asking === null || circleId === null) return Promise.resolve(NOT_OPEN);
      const linkId = asking;
      return exclusive(async (token) => {
        asking = null;
        clearMessages();
        const r = await client.revokeLink(circleId, linkId);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            ended(r.error);
            return failed(r.error);
          }
          problemOf(r.error);
          if (r.error.kind === 'not-found') await reloaded(token, 'links'); // already gone: show what is there now
          return failed(r.error);
        }
        notice = 'Link withdrawn: it no longer works. Requests already made stay waiting.';
        await reloaded(token, 'links');
        return { ok: true };
      });
    },

    approve(requestId) {
      if (circleId === null || status !== 'loaded') return Promise.resolve(NOT_OPEN);
      const person = requests.find((r) => r.id === requestId)?.person.displayName;
      return exclusive(async (token) => {
        clearMessages();
        const r = await client.approve(circleId, requestId);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            ended(r.error);
            return failed(r.error);
          }
          problemOf(r.error);
          if (r.error.kind === 'not-found') await reloaded(token, 'requests'); // already dealt with by someone else
          return failed(r.error);
        }
        notice = `Approved: ${person ?? 'the person'} is now a ${r.value.role}.`;
        await reloaded(token, 'requests');
        changed();
        return { ok: true };
      });
    },

    decline(requestId) {
      if (circleId === null || status !== 'loaded') return Promise.resolve(NOT_OPEN);
      const person = requests.find((r) => r.id === requestId)?.person.displayName;
      return exclusive(async (token) => {
        clearMessages();
        const r = await client.decline(circleId, requestId);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            ended(r.error);
            return failed(r.error);
          }
          problemOf(r.error);
          if (r.error.kind === 'not-found') await reloaded(token, 'requests');
          return failed(r.error);
        }
        notice = `Declined: ${person ?? 'the person'} was not added.`;
        await reloaded(token, 'requests');
        return { ok: true };
      });
    },

    /** Refreshes both lists. */
    refresh() {
      if (circleId === null) return Promise.resolve(NOT_OPEN);
      clearMessages();
      return exclusive((token) => loadBoth(token));
    },

    /** Signed out, or off this circle: forget everything, the token included. */
    reset() {
      epoch++;
      busy = false;
      circleId = null;
      status = 'idle';
      message = null;
      links = [];
      requests = [];
      created = null;
      asking = null;
      clearMessages();
      notify();
    },
  });
}

/**
 * A person's own waiting requests (the Invitations screen): nothing is requested until `open`; one page of 100 holds all anyone can
 * have in practice (each circle holds at most 20 waiting, and a person asks into few). A service with join links off says so.
 */
export function createMyRequestsSession({ client, onSignedOut }) {
  if (!client || typeof client.myRequests !== 'function') throw new TypeError('createMyRequestsSession needs a join client');
  let epoch = 0;
  let busy = false;
  let status = 'idle'; // idle | loading | loaded | unavailable | error
  let message = null;
  let items = [];
  const listeners = new Set();
  const snapshot = () => Object.freeze({ status, message, items: Object.freeze([...items]), busy });
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
  async function load() {
    if (busy) return BUSY;
    busy = true;
    status = 'loading';
    message = null;
    const token = epoch;
    notify();
    try {
      const r = await client.myRequests({ limit: PAGE });
      if (token !== epoch) return DROPPED;
      if (!r.ok) {
        items = [];
        message = r.error.message;
        status = r.error.kind === 'unavailable' ? 'unavailable' : 'error';
        if (r.error.kind === 'signed-out' && typeof onSignedOut === 'function') {
          try {
            onSignedOut();
          } catch {
            // ignored
          }
        }
        return failed(r.error);
      }
      items = [...r.value.items];
      status = 'loaded';
      return { ok: true };
    } finally {
      if (token === epoch) busy = false;
      notify();
    }
  }
  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Loads (or reloads) the person's waiting requests. */
    open() {
      epoch++;
      busy = false;
      return load();
    },
    /** Signed out, or off this screen: forget everything. */
    reset() {
      epoch++;
      busy = false;
      status = 'idle';
      message = null;
      items = [];
      notify();
    },
  });
}
