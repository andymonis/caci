// Puts "Shared with you" on a circle's screen (R-008): who in the circle has shared part of their brain with you,
// then that person's shared categories, a category's items and one item, all read-only. Like the Brain page it only
// sets text, `hidden`, `disabled`, attributes and the focus; rows come from `<template>` elements (the Brain
// screen's, plus one for a person); everything anyone wrote is only ever text. Nothing is requested until the
// person presses "Show what is shared with me", and nothing is kept when the screen is left.

import { categoryRow, dataEntries, EMPTY_CATEGORY, itemCategoryRow, itemRow, SHORTENED } from './brain-view.js';
import { SHARED_NO_CATEGORIES, SHARED_NOBODY, sharedOwnerWords, sharedPersonRow } from './circles-view.js';
import { createSharedSession } from './shared-session.js';

export function mountSharedPage(document, { client, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createSharedSession({ client, onSignedOut });

  const heading = $('shared-heading');
  const load = $('shared-load');
  const status = $('shared-status');
  const error = $('shared-error');
  const message = $('shared-message');
  const people = $('shared-people');
  const empty = $('shared-empty');
  const peopleList = $('shared-people-list');
  const peopleMore = $('shared-people-more');
  const refresh = $('shared-refresh');
  const categories = $('shared-categories');
  const categoriesBack = $('shared-categories-back');
  const ownerHeading = $('shared-owner-heading');
  const readonly = $('shared-readonly');
  const categoriesError = $('shared-categories-error');
  const categoriesEmpty = $('shared-categories-empty');
  const categoriesList = $('shared-categories-list');
  const categoriesMore = $('shared-categories-more');
  const category = $('shared-category');
  const categoryBack = $('shared-category-back');
  const categoryHeading = $('shared-category-heading');
  const categoryError = $('shared-category-error');
  const itemsEmpty = $('shared-items-empty');
  const itemsList = $('shared-items-list');
  const itemsMore = $('shared-items-more');
  const item = $('shared-item');
  const itemBack = $('shared-item-back');
  const itemHeading = $('shared-item-heading');
  const itemError = $('shared-item-error');
  const itemData = $('shared-item-data');
  const itemShortened = $('shared-item-shortened');
  const itemCategories = $('shared-item-categories');
  const templates = { person: $('shared-person-row-template'), category: $('category-row-template'), item: $('item-row-template'), itemCategory: $('item-category-row-template'), data: $('data-row-template') };

  let circleId = null;

  const slot = (row, name) => {
    const element = row.querySelector(`[data-slot="${name}"]`);
    if (!element) throw new Error(`a row template has no slot "${name}"`);
    return element;
  };
  const rowOf = (template) => template.content.firstElementChild.cloneNode(true);
  const setText = (target, text) => {
    target.textContent = text;
    target.hidden = text === '';
  };
  /** Whether the focus should move after this result: yes for a success or a real problem, no for a refused double press, a sign-out or a dropped answer. */
  const worth = (r) => r.ok || !['busy', 'signed-out', 'dropped'].includes(r.kind);

  function render(state) {
    const started = circleId !== null && state.status !== 'idle';
    const loaded = state.status === 'loaded';
    load.hidden = started;
    const loadingNow =
      state.status === 'loading' ||
      (state.busy && ((state.view === 'categories' && state.categories.status === 'loading') || (state.view === 'category' && state.category !== null && state.category.status === 'loading') || (state.view === 'item' && state.item !== null && state.item.status === 'loading')));
    setText(status, loadingNow ? 'Loading…' : '');
    setText(error, state.status === 'gone' || state.status === 'error' ? state.message : loaded && state.view === 'people' && state.people.error !== null ? state.people.error : '');
    setText(message, loaded && state.view === 'people' && state.message !== null ? state.message : '');

    people.hidden = !(loaded && state.view === 'people');
    categories.hidden = !(loaded && state.view === 'categories');
    category.hidden = !(loaded && state.view === 'category');
    item.hidden = !(loaded && state.view === 'item');
    refresh.disabled = state.busy;
    if (!loaded) {
      for (const list of [peopleList, categoriesList, itemsList, itemData, itemCategories]) list.replaceChildren();
      for (const list of [peopleList, categoriesList, itemsList]) list.hidden = true;
      return;
    }

    // who has shared
    empty.textContent = SHARED_NOBODY;
    empty.hidden = !(state.people.status === 'loaded' && state.people.items.length === 0);
    const personRows = state.people.items.map((p) => {
      const view = sharedPersonRow(p);
      const row = rowOf(templates.person);
      slot(row, 'name').textContent = view.name;
      slot(row, 'meta').textContent = view.meta;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.addEventListener('click', () => void openPerson(p.userId));
      return row;
    });
    peopleList.replaceChildren(...personRows);
    peopleList.hidden = personRows.length === 0;
    peopleMore.hidden = state.people.nextCursor === null;
    peopleMore.disabled = state.busy;

    // one person's shared categories
    const words = sharedOwnerWords(state.owner);
    ownerHeading.textContent = words.heading;
    readonly.textContent = words.readonly;
    setText(categoriesError, state.categories.error ?? '');
    categoriesBack.disabled = state.busy;
    categoriesEmpty.textContent = SHARED_NO_CATEGORIES;
    categoriesEmpty.hidden = !(state.categories.status === 'loaded' && state.categories.items.length === 0);
    const categoryRows = state.categories.items.map((c) => {
      const view = categoryRow(c);
      const row = rowOf(templates.category);
      slot(row, 'name').textContent = view.name;
      slot(row, 'count').textContent = view.count;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.disabled = state.busy;
      open.addEventListener('click', () => void openCategory(c.id));
      return row;
    });
    categoriesList.replaceChildren(...categoryRows);
    categoriesList.hidden = categoryRows.length === 0;
    categoriesMore.hidden = state.categories.nextCursor === null;
    categoriesMore.disabled = state.busy;

    // one category
    const k = state.category;
    categoryHeading.textContent = k === null ? 'Category' : k.name ?? k.id;
    setText(categoryError, k !== null && k.error !== null ? k.error : '');
    categoryBack.disabled = state.busy;
    itemsEmpty.textContent = EMPTY_CATEGORY;
    itemsEmpty.hidden = !(k !== null && k.status === 'loaded' && k.items.length === 0);
    const itemRows = (k === null ? [] : k.items).map((it) => {
      const view = itemRow(it);
      const row = rowOf(templates.item);
      slot(row, 'title').textContent = view.title;
      slot(row, 'summary').textContent = view.summary;
      slot(row, 'shortened').textContent = view.shortened;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.disabled = state.busy;
      open.addEventListener('click', () => void openItem(it.id));
      return row;
    });
    itemsList.replaceChildren(...itemRows);
    itemsList.hidden = itemRows.length === 0;
    itemsMore.hidden = !(k !== null && k.nextCursor !== null);
    itemsMore.disabled = state.busy;

    // one item
    const i = state.item;
    const detail = i === null ? null : i.detail;
    itemHeading.textContent = detail === null ? 'Item' : itemRow(detail.item).title;
    setText(itemError, i !== null && i.error !== null ? i.error : '');
    itemBack.disabled = state.busy;
    itemData.replaceChildren(
      ...(detail === null ? [] : dataEntries(detail.item.data)).map((entry) => {
        const row = rowOf(templates.data);
        slot(row, 'key').textContent = entry.key;
        slot(row, 'value').textContent = entry.value;
        return row;
      }),
    );
    itemShortened.textContent = SHORTENED;
    itemShortened.hidden = !(detail !== null && detail.item.dataTruncated === true);
    itemCategories.replaceChildren(
      ...(detail === null ? [] : detail.categories).map((c) => {
        const view = itemCategoryRow(c);
        const row = rowOf(templates.itemCategory);
        slot(row, 'name').textContent = view.name;
        slot(row, 'weight').textContent = view.weight;
        const open = slot(row, 'open');
        open.setAttribute('aria-label', view.label);
        open.disabled = state.busy;
        open.addEventListener('click', () => void openCategory(c.id));
        return row;
      }),
    );
  }

  /** After a step, the focus goes to what the view now shows (a person no longer sharing returns to the list, with the words). */
  function focusView() {
    const state = session.getState();
    if (state.status === 'gone' || state.status === 'error') error.focus();
    else if (state.view === 'people') (state.message !== null ? message : heading).focus();
    else if (state.view === 'categories') ownerHeading.focus();
    else if (state.view === 'category') categoryHeading.focus();
    else itemHeading.focus();
  }
  async function openPerson(userId) {
    const r = await session.selectPerson(userId);
    if (worth(r)) focusView();
  }
  async function openCategory(id) {
    const r = await session.selectCategory(id);
    if (worth(r)) focusView();
  }
  async function openItem(id) {
    const r = await session.selectItem(id);
    if (worth(r)) focusView();
  }

  load.addEventListener('click', async () => {
    if (circleId === null) return;
    const r = await session.open(circleId);
    if (worth(r)) focusView();
  });
  refresh.addEventListener('click', async () => {
    const r = await session.refresh();
    if (worth(r)) heading.focus();
  });
  categoriesBack.addEventListener('click', () => {
    if (session.back()) heading.focus();
  });
  categoryBack.addEventListener('click', () => {
    if (session.back()) ownerHeading.focus();
  });
  itemBack.addEventListener('click', () => {
    if (session.back()) categoryHeading.focus();
  });
  peopleMore.addEventListener('click', () => void session.morePeople());
  categoriesMore.addEventListener('click', () => void session.moreCategories());
  itemsMore.addEventListener('click', () => void session.moreItems());

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The circle screen is shown for `id`; nothing is requested until the person asks. */
    show(id) {
      session.reset();
      circleId = id;
    },
    /** Signed out, or off this screen: forget everything. */
    reset() {
      circleId = null;
      session.reset();
    },
  });
}
