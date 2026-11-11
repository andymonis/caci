// The join screen of the everyday app (R-023): the page a person lands on after opening a link they were sent
// (`#/join/<token>`). Like the other pages it only sets text, `hidden`, `disabled`, attributes and the focus, and builds rows from a
// `<template>`. The token is held in memory only and the address is cleaned as soon as it has been read; nothing is kept when the
// screen is left or the person signs out. Returns the hook `user-mount.js` calls: `route(name, param)` and `reset()`.

import { JOIN_MINE_NOTE, JOIN_MISS, JOIN_NO_LINK, JOIN_WARNING, joinPreviewWords, joinResultWords, myRequestRow } from './circles-view.js';
import { createJoinSession } from './join-session.js';

const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out' || r.kind === 'dropped' || r.kind === 'not-ready';

export function mountUserJoin(document, client, { go, recheck, replace }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createJoinSession({ client, onSignedOut: recheck });

  const status = $('join-status');
  const error = $('join-error');
  const miss = $('join-miss');
  const previewBox = $('join-preview');
  const previewText = $('join-preview-text');
  const warning = $('join-warning');
  const confirm = $('join-confirm');
  const cancel = $('join-cancel');
  const resultBox = $('join-result');
  const resultText = $('join-result-text');
  const openCircle = $('join-open-circle');
  const mineBox = $('join-mine');
  const mineNote = $('join-mine-note');
  const mineError = $('join-mine-error');
  const mineList = $('join-mine-list');
  const mineTemplate = $('join-mine-template');
  warning.textContent = JOIN_WARNING;
  mineNote.textContent = JOIN_MINE_NOTE;

  function setText(target, text) {
    target.textContent = text;
    target.hidden = text === '';
  }

  function render(state) {
    const s = state.status;
    setText(status, s === 'loading' ? 'Looking at the link…' : s === 'joining' ? 'Joining…' : '');
    setText(error, s === 'error' || s === 'unavailable' ? state.message ?? '' : s === 'ready' && state.problem !== null ? state.problem : '');
    setText(miss, s === 'miss' ? JOIN_MISS : s === 'idle' ? JOIN_NO_LINK : '');
    const showPreview = (s === 'ready' || s === 'joining') && state.preview !== null;
    previewBox.hidden = !showPreview;
    previewText.textContent = showPreview ? joinPreviewWords(state.preview) : '';
    confirm.disabled = state.busy;
    cancel.disabled = state.busy;
    const done = state.result !== null && (s === 'joined' || s === 'member' || s === 'requested' || s === 'waiting');
    resultBox.hidden = !done;
    resultText.textContent = done ? joinResultWords(state.result) : '';
    const inside = done && (s === 'joined' || s === 'member');
    openCircle.hidden = !inside;
    if (inside) openCircle.setAttribute('href', `#/circle/${state.result.circle.id}`);
    const m = state.mine;
    mineBox.hidden = m.status === 'idle';
    setText(mineError, m.status === 'error' || m.status === 'unavailable' ? m.message ?? '' : '');
    const rows = m.items.map((r) => {
      const row = mineTemplate.content.firstElementChild.cloneNode(true);
      const slot = row.querySelector('[data-slot="text"]');
      if (!slot) throw new Error('the join template has no slot "text"');
      const view = myRequestRow(r);
      slot.textContent = `${view.title}: ${view.meta}`;
      return row;
    });
    mineList.replaceChildren(...rows);
    mineList.hidden = rows.length === 0;
  }

  confirm.addEventListener('click', async () => {
    const r = await session.join();
    if (r.ok) resultText.focus();
    else if (r.kind === 'not-found') miss.focus();
    else if (!quiet(r)) error.focus();
  });
  cancel.addEventListener('click', () => go('#/')); // leaving the screen forgets the link

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** A screen change: on the join screen with a token, read it, clean the address and look at the link; anywhere else, forget everything. */
    route(name, param) {
      if (name !== 'join') {
        session.reset();
        return;
      }
      if (param === undefined) return; // the address was cleaned after the token was read: what is in memory stays
      replace('#/join');
      void session.open(param).then((r) => {
        if (r.ok || quiet(r)) return;
        (r.kind === 'not-found' ? miss : error).focus();
      });
    },
    reset() {
      session.reset();
    },
  });
}
