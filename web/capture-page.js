// Puts the capture screen on the page (R-007): which model files the note, the note box, the preview of a
// proposal, and approve or reject. Like the other page modules it only sets text, `hidden`, `disabled`,
// attributes, values and the focus; list rows come from `<template>` elements; the model's output and the
// person's note are only ever text.

import { createCaptureSession } from './capture-session.js';
import { countText, expiresText, modeNotice, noteLines, opText, outcomeText, previewNotice, problemLines, readOnlyLine, replaceLines, scopeLine, scopeNotice, withWait } from './capture-view.js';
import { createScopeSession, PERSONAL_LABEL } from './scope-session.js';

export function mountCapturePage(document, { client, onWritten, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createCaptureSession({ client, onSignedOut, onWritten });
  const scopes = createScopeSession({ client, onSignedOut });

  const notice = $('capture-mode-notice');
  const retry = $('capture-mode-retry');
  const formSection = $('capture-form-section');
  const form = $('capture-form');
  const general = $('capture-error');
  const scopeSelect = $('capture-scope');
  const scopeNoticeEl = $('capture-scope-notice');
  const scopeReadOnly = $('capture-scope-readonly');
  const scopeError = $('capture-scope-error');
  const scopeOptionTemplate = $('capture-scope-option-template');
  const previewScope = $('capture-preview-scope');
  const previewScopeNotice = $('capture-preview-scope-notice');
  const note = $('capture-note');
  const count = $('capture-count');
  const noteError = $('capture-note-error');
  const submit = $('capture-submit');
  const preview = $('capture-preview');
  const previewHeading = $('capture-preview-heading');
  const previewNoticeEl = $('capture-preview-notice');
  const text = $('capture-text');
  const ops = $('capture-ops');
  const rationale = $('capture-rationale');
  const lines = $('capture-lines');
  const expires = $('capture-expires');
  const actionError = $('capture-action-error');
  const approve = $('capture-approve');
  const reject = $('capture-reject');
  const outcomeSection = $('capture-outcome');
  const outcomeHeading = $('capture-outcome-heading');
  const outcomeText_ = $('capture-outcome-text');
  const again = $('capture-again');
  const opTemplate = $('capture-op-template');
  const lineTemplate = $('capture-line-template');

  const rowOf = (template, value) => {
    const row = template.content.firstElementChild.cloneNode(true);
    const slot = row.querySelector('[data-slot="text"]');
    if (!slot) throw new Error('a row template has no slot "text"');
    slot.textContent = value;
    return row;
  };
  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };

  let optionKeys = '';
  /** The scope choice: only the places the person may capture into; rebuilt only when that list changes. */
  function renderScopes(state) {
    const s = scopes.getState();
    const offered = s.scopes.filter((x) => x.canCapture);
    const list = offered.length > 0 ? offered : [{ key: 'personal', label: PERSONAL_LABEL }];
    const signature = list.map((x) => `${x.key}\n${x.label}`).join('\n\n');
    if (signature !== optionKeys) {
      optionKeys = signature;
      scopeSelect.replaceChildren(
        ...list.map((x) => {
          const option = scopeOptionTemplate.content.firstElementChild.cloneNode(true);
          option.value = x.key;
          option.textContent = x.label;
          return option;
        }),
      );
    }
    scopeSelect.value = s.captureKey;
    scopeSelect.disabled = state.busy || state.proposal !== null || s.busy;
    scopeNoticeEl.textContent = scopeNotice(s.captureScope, state.mode.value);
    const readOnly = readOnlyLine(s.scopes);
    scopeReadOnly.textContent = readOnly;
    scopeReadOnly.hidden = readOnly === '';
    scopeError.textContent = s.status === 'error' ? `Could not list your circles (${s.error}). Notes go to your own notes.` : '';
    scopeError.hidden = s.status !== 'error';
  }

  function render(state) {
    renderScopes(state);
    const proposal = state.proposal;
    notice.textContent = modeNotice(state.mode);
    notice.hidden = false;
    retry.hidden = !(state.mode.status === 'error' || state.mode.status === 'unknown');
    formSection.hidden = state.phase !== 'form';
    submit.disabled = !state.canPropose;
    note.disabled = state.busy;
    form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    count.textContent = countText([...note.value].length);

    preview.hidden = proposal === null;
    if (proposal !== null) {
      previewScope.textContent = scopeLine(proposal.scope);
      previewScopeNotice.textContent = scopeNotice(proposal.scope, proposal.mode);
      previewNoticeEl.textContent = previewNotice(proposal);
      text.textContent = proposal.text;
      ops.replaceChildren(...proposal.operations.map((op) => rowOf(opTemplate, opText(op))));
      rationale.textContent = typeof proposal.rationale === 'string' ? `Why: ${proposal.rationale}` : '';
      rationale.hidden = typeof proposal.rationale !== 'string';
      lines.replaceChildren(...[...replaceLines(proposal.summary), ...problemLines(proposal.summary), ...noteLines(proposal.summary)].map((line) => rowOf(lineTemplate, line)));
      expires.textContent = expiresText(proposal.expiresAt);
      approve.disabled = state.busy;
      reject.disabled = state.busy;
    } else {
      ops.replaceChildren();
      lines.replaceChildren();
    }

    outcomeSection.hidden = !(state.phase === 'done' && state.outcome !== null);
    outcomeText_.textContent = state.outcome === null ? '' : outcomeText(state.outcome);
  }

  const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out' || r.kind === 'dropped';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(general, '');
    setError(noteError, '');
    note.removeAttribute('aria-invalid');
    const r = await session.propose(note.value, scopes.getState().captureScope);
    if (r.ok) {
      previewHeading.focus();
      return;
    }
    if (quiet(r)) return;
    if (r.errors && r.errors.text !== undefined) {
      setError(noteError, r.errors.text);
      note.setAttribute('aria-invalid', 'true');
      note.focus();
      return;
    }
    // the note stays in the box so it can be sent again; a circle that is no longer there is dropped from the choice
    if (r.kind === 'not-found') void scopes.load();
    setError(general, withWait(r.message, r.retryAfterSeconds));
    general.focus();
  });
  note.addEventListener('input', () => {
    count.textContent = countText([...note.value].length);
  });
  retry.addEventListener('click', () => void session.loadMode());

  approve.addEventListener('click', async () => {
    setError(actionError, '');
    const r = await session.approve();
    if (r.ok) {
      note.value = '';
      outcomeHeading.focus();
      return;
    }
    if (quiet(r)) return;
    if (session.getState().proposal === null) {
      outcomeHeading.focus(); // gone or expired: the outcome says so
      return;
    }
    setError(actionError, withWait(r.message, r.retryAfterSeconds));
    actionError.focus();
  });
  reject.addEventListener('click', async () => {
    setError(actionError, '');
    const r = await session.reject();
    if (r.ok || session.getState().proposal === null) {
      if (r.ok || !quiet(r)) outcomeHeading.focus();
      return;
    }
    if (quiet(r)) return;
    setError(actionError, withWait(r.message, r.retryAfterSeconds));
    actionError.focus();
  });
  again.addEventListener('click', () => {
    if (session.startAgain()) note.focus();
  });

  scopeSelect.addEventListener('change', () => {
    if (!scopes.chooseCapture(scopeSelect.value)) scopeSelect.value = scopes.getState().captureKey;
  });
  scopes.subscribe(() => render(session.getState()));
  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The capture screen has been shown: find out which model files notes. */
    show() {
      void session.loadMode();
      void scopes.load();
    },
    /** Signed out, or off this screen: forget the proposal and the typed note. */
    reset() {
      note.value = '';
      setError(general, '');
      setError(noteError, '');
      setError(actionError, '');
      note.removeAttribute('aria-invalid');
      session.reset();
      scopes.reset();
    },
  });
}
