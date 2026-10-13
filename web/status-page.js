// Puts the status screen on the page (R-011): which model answers, what is sent, the request box with a few
// suggestions, and the answer as a card. Like the other page modules it only sets text, `hidden`, `disabled`,
// attributes, values and the focus; list rows come from a `<template>`; the answer is only ever text.

import { createStatusSession } from './status-session.js';
import { metaLine, pointText, requestCount, STATUS_CONTEXT, STATUS_LEFT_OUT, STATUS_NOT_SAVED, STATUS_NOTHING, STATUS_SUGGESTIONS, statusModeNotice, withWait } from './status-view.js';

export function mountStatusPage(document, { client, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createStatusSession({ client, onSignedOut });

  const notice = $('status-mode-notice');
  const context = $('status-context-notice');
  const retry = $('status-mode-retry');
  const form = $('status-form');
  const general = $('status-error');
  const request = $('status-request');
  const count = $('status-count');
  const requestError = $('status-request-error');
  const submit = $('status-submit');
  const suggestions = STATUS_SUGGESTIONS.map((_, i) => $(`status-suggest-${i}`));
  const answerSection = $('status-answer');
  const answerHeading = $('status-answer-heading');
  const headline = $('status-headline');
  const points = $('status-points');
  const nothing = $('status-nothing');
  const leftOut = $('status-left-out');
  const meta = $('status-meta');
  const notSaved = $('status-not-saved');
  const clear = $('status-clear');
  const lineTemplate = $('capture-line-template');

  context.textContent = STATUS_CONTEXT;
  notSaved.textContent = STATUS_NOT_SAVED;
  STATUS_SUGGESTIONS.forEach((words, i) => {
    suggestions[i].textContent = words;
  });

  const rowOf = (value) => {
    const row = lineTemplate.content.firstElementChild.cloneNode(true);
    const slot = row.querySelector('[data-slot="text"]');
    if (!slot) throw new Error('a row template has no slot "text"');
    slot.textContent = value;
    return row;
  };
  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };

  function render(state) {
    notice.textContent = statusModeNotice(state.mode);
    retry.hidden = !(state.mode.status === 'error' || state.mode.status === 'unknown');
    submit.disabled = !state.canAsk;
    request.disabled = state.busy;
    for (const button of suggestions) button.disabled = state.busy;
    clear.disabled = state.busy;
    form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    count.textContent = requestCount([...request.value].length);

    const answer = state.answer;
    answerSection.hidden = answer === null;
    if (answer !== null) {
      headline.textContent = answer.headline;
      points.replaceChildren(...answer.points.map((point) => rowOf(pointText(point))));
      points.hidden = answer.points.length === 0;
      nothing.textContent = STATUS_NOTHING;
      nothing.hidden = !answer.nothing;
      leftOut.textContent = STATUS_LEFT_OUT;
      leftOut.hidden = answer.entriesLeftOut === 0;
      meta.textContent = metaLine(answer);
    } else {
      points.replaceChildren();
    }
  }

  const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out' || r.kind === 'dropped';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(general, '');
    setError(requestError, '');
    request.removeAttribute('aria-invalid');
    const r = await session.ask(request.value);
    if (r.ok) {
      answerHeading.focus();
      return;
    }
    if (quiet(r)) return;
    if (r.errors && r.errors.text !== undefined) {
      setError(requestError, r.errors.text);
      request.setAttribute('aria-invalid', 'true');
      request.focus();
      return;
    }
    // the request stays in the box so it can be sent again; any earlier answer stays shown
    setError(general, withWait(r.message, r.retryAfterSeconds));
    general.focus();
  });
  request.addEventListener('input', () => {
    count.textContent = requestCount([...request.value].length);
  });
  suggestions.forEach((button, i) => {
    button.addEventListener('click', () => {
      if (session.getState().busy) return;
      request.value = STATUS_SUGGESTIONS[i];
      setError(requestError, '');
      request.removeAttribute('aria-invalid');
      count.textContent = requestCount([...request.value].length);
      request.focus();
    });
  });
  clear.addEventListener('click', () => {
    if (session.clear()) request.focus();
  });
  retry.addEventListener('click', () => void session.loadMode());

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The status screen has been shown: find out which model answers. */
    show() {
      void session.loadMode();
    },
    /** Signed out, or off this screen: forget the answer and the typed request. */
    reset() {
      request.value = '';
      setError(general, '');
      setError(requestError, '');
      request.removeAttribute('aria-invalid');
      session.reset();
    },
  });
}
