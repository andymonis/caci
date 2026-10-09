// Puts the Brain screen on the page (R-007): the categories, the items in one, one item. Read-only. Like the
// other page modules it only sets text, `hidden`, `disabled`, attributes and the focus; rows come from
// `<template>` elements; everything the person or the model wrote is only ever text.

import { createBrainSession } from './brain-session.js';
import { categoryRow, dataEntries, EMPTY_BRAIN, EMPTY_CATEGORY, itemCategoryRow, itemRow, MORE_CATEGORIES, SHORTENED } from './brain-view.js';

export function mountBrainPage(document, { client, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createBrainSession({ client, onSignedOut });

  const status = $('brain-status');
  const error = $('brain-error');
  const refresh = $('brain-refresh');
  const categoriesSection = $('brain-categories');
  const empty = $('brain-empty');
  const categoriesList = $('brain-categories-list');
  const categoriesMore = $('brain-categories-more');
  const categorySection = $('brain-category');
  const categoryBack = $('brain-category-back');
  const categoryHeading = $('brain-category-heading');
  const categoryError = $('brain-category-error');
  const itemsEmpty = $('brain-items-empty');
  const itemsList = $('brain-items-list');
  const itemsMore = $('brain-items-more');
  const itemSection = $('brain-item');
  const itemBack = $('brain-item-back');
  const itemHeading = $('brain-item-heading');
  const itemError = $('brain-item-error');
  const itemData = $('brain-item-data');
  const itemShortened = $('brain-item-shortened');
  const itemCategories = $('brain-item-categories');
  const itemMore = $('brain-item-more');
  const heading = $('brain-heading');
  const templates = { category: $('category-row-template'), item: $('item-row-template'), itemCategory: $('item-category-row-template'), data: $('data-row-template') };

  const slot = (row, name) => {
    const element = row.querySelector(`[data-slot="${name}"]`);
    if (!element) throw new Error(`a row template has no slot "${name}"`);
    return element;
  };
  const rowOf = (template) => template.content.firstElementChild.cloneNode(true);
  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };

  function render(state) {
    const loading = state.busy && state.categories.status !== 'loaded';
    status.textContent = loading ? 'Loading…' : '';
    status.hidden = !loading;
    setError(error, state.view === 'categories' && state.categories.error !== null ? state.categories.error : '');
    refresh.disabled = state.busy;
    categoriesSection.hidden = state.view !== 'categories';
    categorySection.hidden = state.view !== 'category';
    itemSection.hidden = state.view !== 'item';

    // the categories
    const c = state.categories;
    empty.textContent = EMPTY_BRAIN;
    empty.hidden = !(c.status === 'loaded' && c.items.length === 0);
    const rows = c.items.map((category) => {
      const view = categoryRow(category);
      const row = rowOf(templates.category);
      slot(row, 'name').textContent = view.name;
      slot(row, 'count').textContent = view.count;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.disabled = state.busy;
      open.addEventListener('click', () => void openCategory(category.id));
      return row;
    });
    categoriesList.replaceChildren(...rows);
    categoriesList.hidden = rows.length === 0;
    categoriesMore.hidden = c.nextCursor === null;
    categoriesMore.disabled = state.busy;

    // one category
    const k = state.category;
    categoryHeading.textContent = k === null ? 'Category' : k.name ?? k.id;
    setError(categoryError, k !== null && k.error !== null ? k.error : '');
    categoryBack.disabled = state.busy;
    itemsEmpty.textContent = EMPTY_CATEGORY;
    itemsEmpty.hidden = !(k !== null && k.status === 'loaded' && k.items.length === 0);
    const itemRows = (k === null ? [] : k.items).map((item) => {
      const view = itemRow(item);
      const row = rowOf(templates.item);
      slot(row, 'title').textContent = view.title;
      slot(row, 'summary').textContent = view.summary;
      slot(row, 'shortened').textContent = view.shortened;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.disabled = state.busy;
      open.addEventListener('click', () => void openItem(item.id));
      return row;
    });
    itemsList.replaceChildren(...itemRows);
    itemsList.hidden = itemRows.length === 0;
    itemsMore.hidden = !(k !== null && k.nextCursor !== null);
    itemsMore.disabled = state.busy;

    // one item
    const i = state.item;
    const detail = i === null ? null : i.detail;
    itemHeading.textContent = i === null ? 'Item' : detail === null ? 'Item' : itemRow(detail.item).title;
    setError(itemError, i !== null && i.error !== null ? i.error : '');
    itemBack.disabled = state.busy;
    itemData.replaceChildren(...(detail === null ? [] : dataEntries(detail.item.data)).map((entry) => {
      const row = rowOf(templates.data);
      slot(row, 'key').textContent = entry.key;
      slot(row, 'value').textContent = entry.value;
      return row;
    }));
    itemShortened.textContent = SHORTENED;
    itemShortened.hidden = !(detail !== null && detail.item.dataTruncated === true);
    itemCategories.replaceChildren(...(detail === null ? [] : detail.categories).map((category) => {
      const view = itemCategoryRow(category);
      const row = rowOf(templates.itemCategory);
      slot(row, 'name').textContent = view.name;
      slot(row, 'weight').textContent = view.weight;
      const open = slot(row, 'open');
      open.setAttribute('aria-label', view.label);
      open.disabled = state.busy;
      open.addEventListener('click', () => void openCategory(category.id));
      return row;
    }));
    itemMore.textContent = MORE_CATEGORIES;
    itemMore.hidden = !(detail !== null && detail.moreCategories === true);
  }

  async function openCategory(id) {
    await session.selectCategory(id);
    categoryHeading.focus();
  }
  async function openItem(id) {
    await session.selectItem(id);
    itemHeading.focus();
  }
  categoryBack.addEventListener('click', () => {
    if (session.back()) heading.focus();
  });
  itemBack.addEventListener('click', () => {
    if (session.back()) categoryHeading.focus();
  });
  categoriesMore.addEventListener('click', () => void session.moreCategories());
  itemsMore.addEventListener('click', () => void session.moreItems());
  refresh.addEventListener('click', () => void session.load());

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The Brain screen has been shown: load the categories if they were never loaded or a note was written since. */
    show() {
      if (session.getState().needsLoad) void session.load();
    },
    /** A note was written: the next visit reloads. */
    markStale: () => session.markStale(),
    /** Signed out: forget everything. */
    reset: () => session.reset(),
  });
}
