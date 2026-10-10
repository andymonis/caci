// Puts "What you share" on a circle's screen (R-008): for each other member, what you share with them, a picker
// of your own categories, and stopping. Like the other pages it only sets text, `hidden`, `disabled`,
// attributes, `checked` and the focus; rows come from `<template>` elements. Nothing is requested until the
// person presses "Show what I share", and nothing is kept when the screen is left.

import { createGrantsSession } from './grants-session.js';
import { choiceLabel, SHARE_CAPPED, SHARE_LOADING_MINE, SHARE_NO_CATEGORIES, SHARE_NOBODY, shareRow } from './circles-view.js';

export function mountSharePage(document, { sharing, circles, notes, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createGrantsSession({ sharing, circles, notes, onSignedOut });

  const heading = $('share-heading');
  const load = $('share-load');
  const status = $('share-status');
  const error = $('share-error');
  const notice = $('share-notice');
  const empty = $('share-empty');
  const list = $('share-list');
  const rowTemplate = $('share-row-template');
  const choiceTemplate = $('share-choice-template');

  let circleId = null;
  let selfId = null;
  let focusBox = null; // { userId, id }: the tick to put the focus back on after a redraw

  const slot = (row, name) => {
    const element = row.querySelector(`[data-slot="${name}"]`);
    if (!element) throw new Error(`a row template has no slot "${name}"`);
    return element;
  };
  const rowOf = (template) => template.content.firstElementChild.cloneNode(true);
  const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out' || r.kind === 'dropped';
  const rowFor = (userId) => [...list.children].find((row) => row.getAttribute('data-user') === userId);

  function setText(target, text) {
    target.textContent = text;
    target.hidden = text === '';
  }

  function render(state) {
    const started = circleId !== null && state.status !== 'idle';
    load.hidden = started;
    status.textContent = state.status === 'loading' ? 'Loading…' : '';
    status.hidden = state.status !== 'loading';
    const loaded = state.status === 'loaded';
    const topProblem = state.status === 'gone' || state.status === 'error' ? state.message : state.problem !== null && state.editing === null ? state.problem : '';
    setText(error, topProblem ?? '');
    setText(notice, state.notice ?? '');
    empty.textContent = SHARE_NOBODY;
    empty.hidden = !(loaded && state.people.length === 0);
    if (!loaded) {
      list.replaceChildren();
      list.hidden = true;
      return;
    }

    const rows = state.people.map((p) => {
      const view = shareRow(p);
      const row = rowOf(rowTemplate);
      row.setAttribute('data-user', p.userId);
      slot(row, 'name').textContent = view.name;
      slot(row, 'meta').textContent = view.meta;
      const picking = state.editing !== null && state.editing.userId === p.userId;
      const asked = state.asking === p.userId;

      const change = slot(row, 'change');
      change.hidden = picking || asked;
      change.disabled = state.busy;
      change.setAttribute('aria-label', view.changeLabel);
      change.addEventListener('click', () => void choose(p.userId));

      const stop = slot(row, 'stop');
      stop.hidden = p.shared.length === 0 || asked || picking;
      stop.disabled = state.busy;
      stop.setAttribute('aria-label', view.stopLabel);
      stop.addEventListener('click', () => {
        if (session.askStop(p.userId)) slot(rowFor(p.userId), 'stopNo').focus();
      });

      slot(row, 'stopAsk').hidden = !asked;
      slot(row, 'stopText').textContent = view.stopText;
      const yes = slot(row, 'stopYes');
      yes.disabled = state.busy;
      yes.addEventListener('click', () => void stopSharing());
      const no = slot(row, 'stopNo');
      no.disabled = state.busy;
      no.addEventListener('click', () => {
        session.cancel();
        slot(rowFor(p.userId), 'stop').focus();
      });

      slot(row, 'picker').hidden = !picking;
      const help = slot(row, 'pickerHelp');
      help.textContent = state.mine.status === 'loading' ? SHARE_LOADING_MINE : state.mine.status === 'loaded' && state.mine.items.length === 0 ? SHARE_NO_CATEGORIES : `${view.help}${state.mine.capped ? SHARE_CAPPED : ''}`;
      setText(slot(row, 'pickerError'), picking && state.problem !== null ? state.problem : '');
      const choices = picking
        ? state.mine.items.map((c) => {
            const item = rowOf(choiceTemplate);
            const box = slot(item, 'box');
            box.checked = state.editing.draft.includes(c.id);
            box.disabled = state.busy;
            slot(item, 'label').textContent = choiceLabel(c);
            box.addEventListener('change', () => {
              focusBox = { userId: p.userId, id: c.id };
              session.toggle(c.id);
              focusBox = null;
            });
            item.setAttribute('data-category', c.id);
            return item;
          })
        : [];
      slot(row, 'choices').replaceChildren(...choices);
      const save = slot(row, 'save');
      save.disabled = state.busy;
      save.setAttribute('aria-label', view.saveLabel);
      save.addEventListener('click', () => void save_());
      const cancel = slot(row, 'cancel');
      cancel.disabled = state.busy;
      cancel.setAttribute('aria-label', view.cancelLabel);
      cancel.addEventListener('click', () => {
        session.cancelEdit();
        slot(rowFor(p.userId), 'change').focus();
      });
      return row;
    });
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;

    if (focusBox !== null) {
      const row = rowFor(focusBox.userId);
      const item = row === undefined ? undefined : [...slot(row, 'choices').children].find((c) => c.getAttribute('data-category') === focusBox.id);
      if (item !== undefined) slot(item, 'box').focus();
    }
  }

  async function choose(userId) {
    const r = await session.edit(userId);
    if (!r.ok) {
      if (!quiet(r)) error.focus();
      return;
    }
    const row = rowFor(userId);
    if (row === undefined) return;
    const first = [...slot(row, 'choices').children][0];
    (first === undefined ? slot(row, 'cancel') : slot(first, 'box')).focus();
  }

  async function save_() {
    const editing = session.getState().editing;
    const r = await session.save();
    if (r.ok) notice.focus();
    else if (!quiet(r)) {
      const row = editing === null ? undefined : rowFor(editing.userId);
      const still = session.getState().editing !== null && row !== undefined;
      (still ? slot(row, 'pickerError') : error).focus();
    }
  }

  async function stopSharing() {
    const r = await session.confirmStop();
    if (r.ok) notice.focus();
    else if (!quiet(r)) error.focus();
  }

  load.addEventListener('click', async () => {
    if (circleId === null) return;
    const r = await session.open(circleId, selfId);
    if (r.ok) heading.focus();
    else if (!quiet(r)) error.focus();
  });

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The circle screen is shown for `id`; nothing is requested until the person asks. */
    show(id, self) {
      session.reset();
      circleId = id;
      selfId = self;
    },
    /** Signed out, or off this screen: forget everything. */
    reset() {
      circleId = null;
      selfId = null;
      session.reset();
    },
  });
}
