// What the Brain screen shows (R-007, R-009): the person's categories, the items in one, and one item. Read-only.
// Pure logic over the notes client; the page only draws what this says.
//
// - The selection is page state, not an address: category and item ids are opaque, so they never go in the address bar.
// - It reads one scope: the person's own brain (the default, exactly as before R-009), one circle's, or `mine`, all of
//   them together. In `mine` every row says where it is, and a category or an item is chosen by that place and its id.
// - One request at a time. An answer that arrives after `reset()` (or after the scope is changed) is dropped.
// - A view is as old as its last load. `markStale()` (a note was approved elsewhere) makes the next visit reload.
// - Data the service shortened stays marked as shortened; an id that is gone reads "not found" in one set of words.
// - Nothing is stored; `reset()` forgets everything (sign-out, or leaving the screen).

import { failed } from './circles-session.js';

const PAGE = 50;
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const NEEDS_SOURCE = Object.freeze({ ok: false, kind: 'invalid', message: 'Choose it from the list, which says where it is.' });

const emptyCategories = () => ({ status: 'idle', items: [], nextCursor: null, error: null, stale: false });
const sameSource = (a, b) => a !== undefined && b !== undefined && a !== null && b !== null && a.kind === b.kind && (a.kind === 'personal' || a.circleId === b.circleId);
const keyOf = (scope) => (scope === undefined ? 'personal' : scope === 'mine' ? 'mine' : `circle:${scope.circleId}`);
const isObject = (value) => value !== null && typeof value === 'object';

/** `undefined` for the person's own brain, `'mine'`, or a circle scope; anything else is not a scope. */
function normalise(scope) {
  if (scope === undefined || scope === 'personal' || (isObject(scope) && scope.kind === 'personal')) return { ok: true, value: undefined };
  if (scope === 'mine') return { ok: true, value: 'mine' };
  if (isObject(scope) && scope.kind === 'circle' && typeof scope.circleId === 'string' && scope.circleId !== '') {
    return { ok: true, value: Object.freeze({ kind: 'circle', circleId: scope.circleId, ...(typeof scope.circleName === 'string' ? { circleName: scope.circleName } : {}) }) };
  }
  return { ok: false };
}

export function createBrainSession({ client, onSignedOut }) {
  if (!client || typeof client.categories !== 'function') throw new TypeError('createBrainSession needs a notes client');
  let epoch = 0;
  let busy = false;
  let scope; // undefined (the person's own brain), 'mine', or a circle scope
  let categories = emptyCategories();
  let category = null; // { id, source?, name?, status: loading | loaded | gone | error, items, nextCursor, error }
  let item = null; // { id, source?, status: loading | loaded | gone | error, detail, error }
  const listeners = new Set();

  const inMine = () => scope === 'mine';
  const inCircle = () => scope !== undefined && scope !== 'mine';
  const fetchCategories = (page) => (inMine() ? client.mineCategories(page) : inCircle() ? client.categoriesIn(scope, page) : client.categories(page));
  const fetchItems = (id, page, source) => (inMine() ? client.mineCategoryItems(source, id, page) : inCircle() ? client.categoryItemsIn(scope, id, page) : client.categoryItems(id, page));
  const fetchItem = (id, source) => (inMine() ? client.mineItem(source, id) : inCircle() ? client.itemIn(scope, id) : client.item(id));

  const snapshot = () =>
    Object.freeze({
      scope: scope === undefined ? 'personal' : scope,
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
    const r = await fetchCategories({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      const circleGone = r.error.kind === 'not-found' && r.error.what === 'circle';
      categories = { ...categories, status: circleGone ? 'gone' : cursor === undefined ? 'error' : categories.status, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    categories = { status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...categories.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null, stale: false, ...(r.value.scope === undefined ? {} : { where: r.value.scope }) };
    return { ok: true };
  }

  async function loadCategoryItems(mine, id, source, cursor) {
    const r = await fetchItems(id, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) }, source);
    if (mine !== epoch) return DROPPED;
    const where = source === undefined ? {} : { source };
    if (!r.ok) {
      if (r.error.kind === 'not-found') category = { id, ...where, status: 'gone', items: [], nextCursor: null, error: r.error.message };
      else if (category !== null) category = { ...category, status: cursor === undefined ? 'error' : 'loaded', error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    const name = r.value.category.name ?? category?.name;
    category = { id, ...where, ...(r.value.scope === undefined ? {} : { where: r.value.scope }), ...(name === undefined ? {} : { name }), status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...(category?.items ?? []), ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Forget everything (sign-out, or leaving the screen). Answers still on their way are dropped. The scope goes back to the person's own brain. */
    reset() {
      epoch += 1;
      busy = false;
      scope = undefined;
      categories = emptyCategories();
      category = null;
      item = null;
      notify();
    },

    /**
     * Read another scope: `undefined` or `{ kind: 'personal' }` (the person's own brain), `{ kind: 'circle', circleId }` or
     * `'mine'`. Everything shown is forgotten and the next visit loads; answers still on their way are dropped. Returns
     * whether anything changed (the same scope again changes nothing; something that is not a scope is refused).
     */
    setScope(next) {
      const n = normalise(next);
      if (!n.ok || keyOf(n.value) === keyOf(scope)) return false;
      epoch += 1;
      busy = false;
      scope = n.value;
      categories = emptyCategories();
      category = null;
      item = null;
      notify();
      return true;
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

    /** Open one category: its first page of items. Leaves any open item. In `mine`, `source` (where it is) is needed and is the row's `scope`. */
    selectCategory(id, source) {
      if (inMine() && !isObject(source)) return Promise.resolve(NEEDS_SOURCE);
      return exclusive(async (mine) => {
        item = null;
        const known = categories.items.find((c) => c.id === id && (!inMine() || sameSource(c.scope, source)));
        category = { id, ...(inMine() ? { source } : {}), ...(known?.name === undefined ? {} : { name: known.name }), status: 'loading', items: [], nextCursor: null, error: null };
        notify();
        return loadCategoryItems(mine, id, inMine() ? source : undefined);
      });
    },
    moreItems: () =>
      exclusive((mine) => (category === null || category.nextCursor === null ? Promise.resolve({ ok: true }) : loadCategoryItems(mine, category.id, category.source, category.nextCursor))),

    /** Open one item: its data and the categories it is filed under. In `mine`, `source` is the row's `scope`. */
    selectItem(id, source) {
      if (inMine() && !isObject(source)) return Promise.resolve(NEEDS_SOURCE);
      return exclusive(async (mine) => {
        item = { id, ...(inMine() ? { source } : {}), status: 'loading', detail: null, error: null };
        notify();
        const r = await fetchItem(id, inMine() ? source : undefined);
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          item = { id, ...(inMine() ? { source } : {}), status: r.error.kind === 'not-found' ? 'gone' : 'error', detail: null, error: r.error.message };
          return failed(r.error);
        }
        item = { id, ...(inMine() ? { source } : {}), status: 'loaded', detail: r.value, error: null };
        return { ok: true };
      });
    },

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
