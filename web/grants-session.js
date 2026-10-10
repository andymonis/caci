// What the "What you share" part of a circle's screen shows and does (R-008): for each other member of the
// circle, which of your categories you share with them, choosing different ones, and stopping. Pure logic over
// the sharing, circles and notes clients; the page only draws what this says.
//
// - Sharing is one direction and per person: you choose from your own categories, the service replaces the set.
// - One request at a time. An answer for a circle that is no longer open is dropped.
// - Every change reloads what it changed; a view is as old as its last load.
// - The picker is page state (nothing is sent until Save); stopping is two steps: ask, then confirm or cancel.
// - Your own categories are loaded when the first picker opens, and on each `open`.

import { failed } from './circles-session.js';
import { MAX_SHARED_CATEGORIES } from './sharing-client.js';

const PAGE = 100;
const MAX_PAGES = 10;
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const NOT_A_MEMBER = 'That person is not one of the other members of this circle.';

const nameOf = (person) => person.displayName ?? person.username ?? 'that person';

export function createGrantsSession({ sharing, circles, notes, onSignedOut }) {
  if (!sharing || typeof sharing.setGrant !== 'function' || !circles || typeof circles.listMembers !== 'function' || !notes || typeof notes.categories !== 'function') {
    throw new TypeError('createGrantsSession needs a sharing client, a circles client and a notes client');
  }
  let epoch = 0;
  let busy = false;
  let circleId = null;
  let selfId = null;
  let status = 'idle'; // idle | loading | loaded | gone | error
  let message = null;
  let people = []; // other members, each { userId, username?, displayName?, shared: [{id, name?}] }
  let mine = { status: 'idle', items: [], capped: false, error: null };
  let editing = null; // { userId, draft: string[] }
  let asking = null; // userId
  let notice = null;
  let problem = null;
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      circleId,
      status,
      message,
      people: Object.freeze(people.map((p) => Object.freeze({ ...p, shared: Object.freeze([...p.shared]) }))),
      mine: Object.freeze({ ...mine, items: Object.freeze([...mine.items]) }),
      editing: editing === null ? null : Object.freeze({ userId: editing.userId, draft: Object.freeze([...editing.draft]) }),
      asking,
      notice,
      problem,
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

  function gone(error) {
    status = 'gone';
    message = error.message;
    people = [];
    editing = null;
    asking = null;
    notice = null;
    problem = null;
  }

  /** Every page of a list, up to a cap; `undefined` plus the error if any page fails. */
  async function everything(token, first) {
    const items = [];
    let cursor;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await first({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      if (token !== epoch) return { dropped: true };
      if (!r.ok) return { error: r.error };
      items.push(...r.value.items);
      if (r.value.nextCursor === null) return { items, capped: false };
      cursor = r.value.nextCursor;
    }
    return { items, capped: true };
  }

  /** The other members and what is shared with each, from the service. */
  async function loadPeople(token) {
    const roster = await everything(token, (page) => circles.listMembers(circleId, page));
    if (roster.dropped) return DROPPED;
    if (roster.error) return loadFailed(roster.error);
    const grants = await everything(token, (page) => sharing.listGrants(circleId, page));
    if (grants.dropped) return DROPPED;
    if (grants.error) return loadFailed(grants.error);
    const shared = new Map(grants.items.map((g) => [g.userId, g.categories]));
    people = roster.items.filter((m) => m.userId !== selfId).map((m) => ({ userId: m.userId, ...(m.username === undefined ? {} : { username: m.username }), ...(m.displayName === undefined ? {} : { displayName: m.displayName }), shared: [...(shared.get(m.userId) ?? [])] }));
    status = 'loaded';
    message = null;
    return { ok: true };
  }

  function loadFailed(error) {
    if (error.kind === 'not-found') gone(error);
    else {
      status = 'error';
      message = error.message;
      people = [];
    }
    return failed(error);
  }

  async function loadMine(token) {
    mine = { ...mine, status: 'loading', error: null };
    notify();
    const own = await everything(token, (page) => notes.categories(page));
    if (own.dropped) return DROPPED;
    if (own.error) {
      mine = { status: 'error', items: [], capped: false, error: own.error.message };
      return failed(own.error);
    }
    mine = { status: 'loaded', items: own.items.map((c) => ({ id: c.id, ...(c.name === undefined ? {} : { name: c.name }) })), capped: own.capped, error: null };
    return { ok: true };
  }

  /** After a change or a refusal: reload, keeping the words that say what happened. */
  async function reloadAfter(token, words, error) {
    const reload = await loadPeople(token);
    if (reload.kind === 'dropped') return DROPPED;
    if (status === 'loaded') {
      if (error === undefined) notice = words;
      else problem = words;
    }
    return error === undefined ? reload : failed(error);
  }

  const personOf = (userId) => people.find((p) => p.userId === userId);

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    reset() {
      epoch += 1;
      busy = false;
      circleId = null;
      selfId = null;
      status = 'idle';
      message = null;
      people = [];
      mine = { status: 'idle', items: [], capped: false, error: null };
      editing = null;
      asking = null;
      notice = null;
      problem = null;
      notify();
    },

    /** Start on a circle (and reload): the other members with what is shared with each. `selfUserId` is left out of the list. */
    open(id, selfUserId) {
      epoch += 1;
      busy = false;
      circleId = id;
      selfId = selfUserId;
      status = 'loading';
      message = null;
      people = [];
      mine = { status: 'idle', items: [], capped: false, error: null };
      editing = null;
      asking = null;
      notice = null;
      problem = null;
      return exclusive((token) => loadPeople(token));
    },

    refresh: () =>
      exclusive(async (token) => {
        editing = null;
        asking = null;
        notice = null;
        problem = null;
        mine = { status: 'idle', items: [], capped: false, error: null };
        return loadPeople(token);
      }),

    /** Open the picker for one person: your own categories (loaded now if not yet), with what is shared ticked. */
    edit: (userId) =>
      exclusive(async (token) => {
        const person = personOf(userId);
        if (person === undefined) return { ok: false, kind: 'not-found', what: 'member', message: NOT_A_MEMBER };
        asking = null;
        notice = null;
        problem = null;
        editing = { userId, draft: person.shared.map((c) => c.id) };
        notify();
        if (mine.status === 'loaded') return { ok: true };
        const loaded = await loadMine(token);
        if (loaded.ok === false && loaded.kind !== 'dropped') {
          editing = null;
          problem = loaded.message;
        }
        return loaded;
      }),

    /** Tick or untick one of your categories in the open picker. Nothing is sent. */
    toggle(categoryId) {
      if (busy || editing === null || !mine.items.some((c) => c.id === categoryId)) return false;
      problem = null;
      if (editing.draft.includes(categoryId)) editing = { ...editing, draft: editing.draft.filter((id) => id !== categoryId) };
      else if (editing.draft.length >= MAX_SHARED_CATEGORIES) {
        problem = `You can share at most ${MAX_SHARED_CATEGORIES} categories with one person.`;
        notify();
        return false;
      } else editing = { ...editing, draft: [...editing.draft, categoryId] };
      notify();
      return true;
    },

    cancelEdit() {
      if (busy || editing === null) return false;
      editing = null;
      problem = null;
      notify();
      return true;
    },

    /** Sends the ticked categories as the whole set for this person (none ticked stops sharing). */
    save: () =>
      exclusive(async (token) => {
        if (editing === null) return { ok: false, kind: 'invalid', message: 'Choose a person first.' };
        const { userId, draft } = editing;
        const person = personOf(userId);
        const who = person === undefined ? 'that person' : nameOf(person);
        const r = await sharing.setGrant(circleId, userId, draft);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            gone(r.error);
            return failed(r.error);
          }
          if (r.error.kind === 'not-found' || r.error.field === 'categories') {
            // the person left, or a category was removed since the list was loaded: start from what the service says now
            editing = null;
            mine = { status: 'idle', items: [], capped: false, error: null };
            return reloadAfter(token, r.error.message, r.error);
          }
          problem = r.error.message;
          return failed(r.error);
        }
        editing = null;
        problem = null;
        const words = r.value.grant === null ? `Stopped sharing with ${who}.` : `Now sharing ${r.value.grant.categories.length === 1 ? '1 category' : `${r.value.grant.categories.length} categories`} with ${who}.`;
        return reloadAfter(token, words);
      }),

    /** Ask before stopping everything for one person; nothing is sent until `confirmStop`. */
    askStop(userId) {
      if (busy || personOf(userId) === undefined) return false;
      editing = null;
      notice = null;
      problem = null;
      asking = userId;
      notify();
      return true;
    },

    cancel() {
      if (busy || asking === null) return false;
      asking = null;
      notify();
      return true;
    },

    confirmStop: () =>
      exclusive(async (token) => {
        if (asking === null) return { ok: false, kind: 'invalid', message: 'Nothing is being asked.' };
        const userId = asking;
        const person = personOf(userId);
        const who = person === undefined ? 'that person' : nameOf(person);
        asking = null;
        const r = await sharing.withdrawGrant(circleId, userId);
        if (token !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            gone(r.error);
            return failed(r.error);
          }
          if (r.error.kind === 'not-found') return reloadAfter(token, r.error.message, r.error);
          problem = r.error.message;
          return failed(r.error);
        }
        return reloadAfter(token, `Stopped sharing with ${who}.`);
      }),
  });
}
