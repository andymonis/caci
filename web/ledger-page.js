// Puts the change-log screen on the page (R-014): which brain, its entries newest first, Show more. Read-only, and nothing is
// requested until the person opens the screen. Like the other page modules it only sets text, `hidden`, `disabled`, attributes
// and the focus; rows come from a `<template>`; everything in an entry (names, titles, what a removed note said) is only text.

import { NO_CIRCLE_WAYS, LOST_CIRCLE_NOTE } from './brain-view.js';
import { createLedgerSession } from './ledger-session.js';
import { entryText, LEDGER_EMPTY, LEDGER_LOADING, LEDGER_NOTICE, ledgerScopeHint } from './ledger-view.js';
import { NO_CIRCLE } from './notes-client.js';
import { createScopeSession } from './scope-session.js';

export function mountLedgerPage(document, { ledger, notes, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createLedgerSession({ client: ledger, onSignedOut });
  const scopes = createScopeSession({ client: notes, onSignedOut });

  const heading = $('ledger-heading');
  const notice = $('ledger-notice');
  const scopeSelect = $('ledger-scope');
  const scopeHintEl = $('ledger-scope-hint');
  const optionTemplate = $('capture-scope-option-template');
  const rowTemplate = $('capture-line-template');
  const status = $('ledger-status');
  const error = $('ledger-error');
  const gone = $('ledger-gone');
  const goneHint = $('ledger-gone-hint');
  const goneBack = $('ledger-gone-back');
  const refresh = $('ledger-refresh');
  const empty = $('ledger-empty');
  const list = $('ledger-list');
  const more = $('ledger-more');

  notice.textContent = LEDGER_NOTICE;
  empty.textContent = LEDGER_EMPTY;

  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };
  const rowOf = (value) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const slot = row.querySelector('[data-slot="text"]');
    if (!slot) throw new Error('a row template has no slot "text"');
    slot.textContent = value;
    return row;
  };

  let optionKeys = '';
  let lost = false; // the circle that was being read is no longer on the person's list
  function renderScopes(state) {
    const s = scopes.getState();
    const choices = s.scopes.length > 0 ? s.scopes : [{ key: 'personal', label: 'My own notes', scope: { kind: 'personal' } }];
    const signature = choices.map((x) => `${x.key}\n${x.label}`).join('\n\n');
    if (signature !== optionKeys) {
      optionKeys = signature;
      scopeSelect.replaceChildren(
        ...choices.map((x) => {
          const option = optionTemplate.content.firstElementChild.cloneNode(true);
          option.value = x.key;
          option.textContent = x.label;
          return option;
        }),
      );
    }
    scopeSelect.value = s.browseKey;
    scopeSelect.disabled = state.busy || s.busy;
    scopeHintEl.textContent = ledgerScopeHint(s.browseKey, s.scopes);
    const circleGone = state.status === 'lost';
    gone.hidden = !(circleGone || lost);
    goneHint.textContent = circleGone ? `${state.error ?? NO_CIRCLE} ${NO_CIRCLE_WAYS}` : lost ? `${NO_CIRCLE} ${LOST_CIRCLE_NOTE}` : '';
    goneBack.hidden = !circleGone;
  }

  function render(state) {
    renderScopes(state);
    const loading = state.busy && state.status !== 'loaded';
    status.textContent = loading ? LEDGER_LOADING : '';
    status.hidden = !loading;
    setError(error, state.status === 'error' || (state.status === 'loaded' && state.error !== null) ? state.error : '');
    refresh.disabled = state.busy || scopes.getState().busy;
    const showing = state.status === 'loaded' || (state.status === 'loading' && state.items.length > 0);
    list.hidden = !showing || state.items.length === 0;
    list.replaceChildren(...(showing ? state.items.map((entry) => rowOf(entryText(entry))) : []));
    empty.hidden = !(state.status === 'loaded' && state.items.length === 0);
    more.hidden = !(state.status === 'loaded' && state.hasMore);
  }

  /** Make the log show what the scope choice says. */
  function apply() {
    void session.open(scopes.getState().browseScope);
  }
  async function relist() {
    const before = scopes.getState().browseKey;
    const r = await scopes.load();
    if (r.kind === 'dropped') return r;
    lost = r.ok === true && before.startsWith('circle:') && scopes.getState().browseKey !== before;
    render(session.getState());
    return r;
  }

  scopeSelect.addEventListener('change', () => {
    lost = false;
    if (!scopes.chooseBrowse(scopeSelect.value)) scopeSelect.value = scopes.getState().browseKey;
    apply();
  });
  goneBack.addEventListener('click', () => {
    lost = false;
    scopes.chooseBrowse('personal');
    apply();
    heading.focus();
  });
  refresh.addEventListener('click', async () => {
    await relist();
    apply();
  });
  more.addEventListener('click', () => void session.more());

  scopes.subscribe(() => render(session.getState()));
  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The screen has been shown: ask for the person's circles, then load the log of the chosen one. */
    show() {
      void relist().then((r) => {
        if (r.kind !== 'dropped') apply();
      });
    },
    /** Signed out, or off this screen: forget everything. */
    reset() {
      lost = false;
      session.reset();
      scopes.reset();
    },
  });
}
