// What the "Shared with you" part of a circle's screen shows (R-008): who in the circle has shared part of their
// brain with you, then that person's shared categories, a category's items and one item. Read-only. Pure logic
// over the sharing client; the page only draws what this says.
//
// - The selection (a person, a category, an item) is page state, never an address: ids are opaque.
// - One request at a time. An answer that arrives after `open()` or `reset()` is dropped.
// - A view is as old as its last load. When the service says what you were looking at is no longer shared
//   (one set of words for every reason), the view says so and the list of people is reloaded.
// - Nothing is stored; `reset()` forgets everything (sign-out, or leaving the circle's screen).

import { failed } from './circles-session.js';

const PAGE = 50;
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });

const emptyList = () => ({ status: 'idle', items: [], nextCursor: null, error: null });

export function createSharedSession({ client, onSignedOut }) {
  if (!client || typeof client.sharedWithMe !== 'function') throw new TypeError('createSharedSession needs a sharing client');
  let epoch = 0;
  let busy = false;
  let circleId = null;
  let status = 'idle'; // idle | loading | loaded | gone | error
  let message = null;
  let people = emptyList();
  let owner = null; // { userId, username?, displayName? }
  let categories = emptyList();
  let category = null; // { id, name?, status: loading | loaded | gone | error, items, nextCursor, error }
  let item = null; // { id, status: loading | loaded | gone | error, detail, error }
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      circleId,
      status,
      message,
      view: item !== null ? 'item' : category !== null ? 'category' : owner !== null ? 'categories' : 'people',
      people: Object.freeze({ ...people, items: Object.freeze([...people.items]) }),
      owner: owner === null ? null : Object.freeze({ ...owner }),
      categories: Object.freeze({ ...categories, items: Object.freeze([...categories.items]) }),
      category: category === null ? null : Object.freeze({ ...category, items: Object.freeze([...category.items]) }),
      item: item === null ? null : Object.freeze({ ...item }),
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

  /** The circle itself is gone (or you are not in it): everything is dropped and the view says so. */
  function circleGone(error) {
    status = 'gone';
    message = error.message;
    people = emptyList();
    owner = null;
    categories = emptyList();
    category = null;
    item = null;
  }

  async function loadPeople(mine, cursor) {
    const r = await client.sharedWithMe(circleId, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      if (r.error.kind === 'not-found') circleGone(r.error);
      else {
        status = cursor === undefined ? 'error' : status;
        message = r.error.message;
        people = { ...people, status: cursor === undefined ? 'error' : people.status, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      }
      return failed(r.error);
    }
    status = 'loaded';
    message = null;
    people = { status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...people.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  /** What you were looking at is no longer shared: say so, and reload who has shared. */
  async function lostSight(mine, error, mark) {
    mark(error.message);
    const reload = await loadPeople(mine);
    return reload.kind === 'dropped' ? DROPPED : failed(error);
  }

  async function loadCategories(mine, cursor) {
    const r = await client.sharedCategories(circleId, owner.userId, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      if (r.error.kind === 'not-found' && r.error.what === 'circle') {
        circleGone(r.error);
        return failed(r.error);
      }
      if (r.error.kind === 'not-found') {
        // not shared (any more): back to the list of people, with the words
        owner = null;
        categories = emptyList();
        category = null;
        item = null;
        const words = r.error.message;
        const reload = await loadPeople(mine);
        if (reload.kind === 'dropped') return DROPPED;
        message = words;
        return failed(r.error);
      }
      categories = { ...categories, status: cursor === undefined ? 'error' : categories.status, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    categories = { status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...categories.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  async function loadCategoryItems(mine, id, cursor) {
    const r = await client.sharedCategoryItems(circleId, owner.userId, id, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      if (r.error.kind === 'not-found' && r.error.what === 'circle') {
        circleGone(r.error);
        return failed(r.error);
      }
      if (r.error.kind === 'not-found') return lostSight(mine, r.error, (words) => (category = { id, status: 'gone', items: [], nextCursor: null, error: words }));
      if (category !== null) category = { ...category, status: cursor === undefined ? 'error' : 'loaded', error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    const name = r.value.category.name ?? category?.name;
    category = { id, ...(name === undefined ? {} : { name }), status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...(category?.items ?? []), ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Forget everything (sign-out, or leaving the screen). Answers still on their way are dropped. */
    reset() {
      epoch += 1;
      busy = false;
      circleId = null;
      status = 'idle';
      message = null;
      people = emptyList();
      owner = null;
      categories = emptyList();
      category = null;
      item = null;
      notify();
    },

    /** Start on a circle: forget what was shown and load who has shared with you. */
    open(id) {
      epoch += 1;
      busy = false;
      circleId = id;
      status = 'loading';
      message = null;
      people = emptyList();
      owner = null;
      categories = emptyList();
      category = null;
      item = null;
      return exclusive((mine) => loadPeople(mine));
    },

    /** Reload who has shared with you and go back to that list. */
    refresh: () =>
      exclusive(async (mine) => {
        owner = null;
        categories = emptyList();
        category = null;
        item = null;
        return loadPeople(mine);
      }),
    morePeople: () => exclusive((mine) => (people.nextCursor === null ? Promise.resolve({ ok: true }) : loadPeople(mine, people.nextCursor))),

    /** Open one person's shared categories. */
    selectPerson: (userId) =>
      exclusive(async (mine) => {
        const known = people.items.find((p) => p.userId === userId);
        owner = { userId, ...(known?.username === undefined ? {} : { username: known.username }), ...(known?.displayName === undefined ? {} : { displayName: known.displayName }) };
        categories = { status: 'loading', items: [], nextCursor: null, error: null };
        category = null;
        item = null;
        notify();
        return loadCategories(mine);
      }),
    moreCategories: () => exclusive((mine) => (owner === null || categories.nextCursor === null ? Promise.resolve({ ok: true }) : loadCategories(mine, categories.nextCursor))),

    selectCategory: (id) =>
      exclusive(async (mine) => {
        if (owner === null) return { ok: false, kind: 'not-found', message: 'Choose a person first.' };
        item = null;
        const known = categories.items.find((c) => c.id === id);
        category = { id, ...(known?.name === undefined ? {} : { name: known.name }), status: 'loading', items: [], nextCursor: null, error: null };
        notify();
        return loadCategoryItems(mine, id);
      }),
    moreItems: () =>
      exclusive((mine) => (owner === null || category === null || category.nextCursor === null ? Promise.resolve({ ok: true }) : loadCategoryItems(mine, category.id, category.nextCursor))),

    selectItem: (id) =>
      exclusive(async (mine) => {
        if (owner === null) return { ok: false, kind: 'not-found', message: 'Choose a person first.' };
        item = { id, status: 'loading', detail: null, error: null };
        notify();
        const r = await client.sharedItem(circleId, owner.userId, id);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          if (r.error.kind === 'not-found' && r.error.what === 'circle') {
            circleGone(r.error);
            return failed(r.error);
          }
          if (r.error.kind === 'not-found') return lostSight(mine, r.error, (words) => (item = { id, status: 'gone', detail: null, error: words }));
          item = { id, status: 'error', detail: null, error: r.error.message };
          return failed(r.error);
        }
        item = { id, status: 'loaded', detail: r.value, error: null };
        return { ok: true };
      }),

    /** One step back: item to its category, category to the person's categories, those to the people. Nothing is sent. */
    back() {
      if (busy) return false;
      if (item !== null) item = null;
      else if (category !== null) category = null;
      else if (owner !== null) {
        owner = null;
        categories = emptyList();
      } else return false;
      notify();
      return true;
    },
  });
}
