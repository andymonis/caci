// What the Brain screen shows (R-007): the person's categories, the items in one, and one item. Read-only.
// Pure logic over the notes client; the page only draws what this says.
//
// - The selection is state, not an address: category and item ids are opaque, so they never go in the address bar.
// - One request at a time. An answer that arrives after `reset()` is dropped.
// - A view is as old as its last load. `markStale()` (a note was approved elsewhere) makes the next visit reload.
// - Data the service shortened stays marked as shortened; an id that is gone reads "not found" in one set of words.
// - Nothing is stored; `reset()` forgets everything (sign-out, or leaving the screen).

import { failed } from './circles-session.js';

const PAGE = 50;
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });

const emptyCategories = () => ({ status: 'idle', items: [], nextCursor: null, error: null, stale: false });

export function createBrainSession({ client, onSignedOut }) {
  if (!client || typeof client.categories !== 'function') throw new TypeError('createBrainSession needs a notes client');
  let epoch = 0;
  let busy = false;
  let categories = emptyCategories();
  let category = null; // { id, name?, status: loading | loaded | gone | error, items, nextCursor, error }
  let item = null; // { id, status: loading | loaded | gone | error, detail, error }
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      view: item !== null ? 'item' : category !== null ? 'category' : 'categories',
      needsLoad: categories.status === 'idle' || categories.stale,
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

  async function loadCategories(mine, cursor) {
    const r = await client.categories({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      categories = { ...categories, status: cursor === undefined ? 'error' : categories.status, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    categories = { status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...categories.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null, stale: false };
    return { ok: true };
  }

  async function loadCategoryItems(mine, id, cursor) {
    const r = await client.categoryItems(id, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      if (r.error.kind === 'not-found') category = { id, status: 'gone', items: [], nextCursor: null, error: r.error.message };
      else if (category !== null) category = { ...category, status: cursor === undefined ? 'error' : 'loaded', error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
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
      categories = emptyCategories();
      category = null;
      item = null;
      notify();
    },

    /** A note was approved elsewhere: the next visit reloads. */
    markStale() {
      categories = { ...categories, stale: true };
      notify();
    },

    /** (Re)load the categories from the start and go back to the list. */
    load: () =>
      exclusive(async (mine) => {
        category = null;
        item = null;
        return loadCategories(mine);
      }),
    moreCategories: () => exclusive((mine) => (categories.nextCursor === null ? Promise.resolve({ ok: true }) : loadCategories(mine, categories.nextCursor))),

    /** Open one category: its first page of items. Leaves any open item. */
    selectCategory: (id) =>
      exclusive(async (mine) => {
        item = null;
        const known = categories.items.find((c) => c.id === id);
        category = { id, ...(known?.name === undefined ? {} : { name: known.name }), status: 'loading', items: [], nextCursor: null, error: null };
        notify();
        return loadCategoryItems(mine, id);
      }),
    moreItems: () =>
      exclusive((mine) => (category === null || category.nextCursor === null ? Promise.resolve({ ok: true }) : loadCategoryItems(mine, category.id, category.nextCursor))),

    /** Open one item: its data and the categories it is filed under. */
    selectItem: (id) =>
      exclusive(async (mine) => {
        item = { id, status: 'loading', detail: null, error: null };
        notify();
        const r = await client.item(id);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          item = { id, status: r.error.kind === 'not-found' ? 'gone' : 'error', detail: null, error: r.error.message };
          return failed(r.error);
        }
        item = { id, status: 'loaded', detail: r.value, error: null };
        return { ok: true };
      }),

    /** One step back: from an item to its list, from a list to the categories. Nothing is sent. */
    back() {
      if (busy) return false;
      if (item !== null) item = null;
      else if (category !== null) category = null;
      else return false;
      notify();
      return true;
    },
  });
}
