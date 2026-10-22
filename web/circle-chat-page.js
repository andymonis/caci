// The chat on a Circle screen (R-016 D18 to D22): an update field with Send (recorded against this circle's brain) and a Pulse button
// (a status of this circle only, with the predefined text the service holds); no question field. Each circle has its own thread, kept in
// memory while the person is signed in. Like the other pages it only sets text, `hidden`, `disabled`, values, a few ARIA attributes and the
// focus; thread rows come from the same `<template>` elements as Home; anything anyone wrote is text.

import { createChatSession } from './chat-session.js';
import { chatModeNotice, CIRCLE_READ_ONLY, CIRCLE_VISIBLE } from './chat-view.js';
import { createThreadDrawer } from './thread-view.js';

export function mountCircleChat(document, notes, onSignedOut, ledger) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const modelNotice = $('circle-model-notice');
  const visible = $('circle-visible');
  const readOnly = $('circle-readonly');
  const modeError = $('circle-mode-error');
  const retry = $('circle-retry');
  const form = $('circle-update-form');
  const text = $('circle-update-text');
  const error = $('circle-update-error');
  const send = $('circle-update-send');
  const pulse = $('circle-pulse');
  const comingUp = $('circle-coming-up');
  const longRange = $('circle-long-range');
  const showSource = async (id, index) => {
    if (active === undefined) return;
    const result = await active.showSource(id, index);
    if (result.ok) drawer.focusLast();
  };
  const drawer = createThreadDrawer({ thread: $('circle-thread'), msgTemplate: $('msg-template'), lineTemplate: $('msg-line-template'), onShowSource: ledger === undefined ? undefined : showSource });

  const sessions = new Map(); // circle id -> { session, name, canCapture }
  let active;
  let unsubscribe;

  const setError = (message) => {
    error.textContent = message;
    error.hidden = message === '';
  };

  function sessionFor(circle) {
    const have = sessions.get(circle.circleId);
    // a renamed circle, or a changed right, starts a fresh thread: the words and the buttons must follow the service
    if (have && have.name === circle.circleName && have.canCapture === circle.canCapture) return have.session;
    const session = createChatSession({ notes, ledger, onSignedOut, circle: { circleId: circle.circleId, circleName: circle.circleName, canCapture: circle.canCapture } });
    sessions.set(circle.circleId, { session, name: circle.circleName, canCapture: circle.canCapture });
    return session;
  }

  function render(state) {
    modelNotice.textContent = chatModeNotice(state.mode);
    visible.textContent = CIRCLE_VISIBLE;
    const canAdd = state.circle !== undefined && state.circle.canCapture;
    readOnly.textContent = canAdd ? '' : CIRCLE_READ_ONLY;
    readOnly.hidden = canAdd;
    modeError.textContent = state.mode.status === 'error' && typeof state.mode.error === 'string' ? state.mode.error : '';
    modeError.hidden = modeError.textContent === '';
    retry.hidden = state.mode.status !== 'error';
    drawer.draw(state.messages, state.busy);
    text.disabled = !canAdd;
    send.disabled = !state.canSend;
    pulse.disabled = !state.canAsk;
    comingUp.disabled = !state.canAsk;
    longRange.disabled = !state.canAsk;
    form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (active === undefined) return;
    setError('');
    const result = await active.send(text.value);
    if (result.ok) {
      text.value = '';
      text.focus();
    } else if (result.kind === 'invalid' || result.kind === 'mode-unknown' || result.kind === 'read-only') {
      setError(result.message);
      text.focus();
    }
  });
  pulse.addEventListener('click', async () => {
    if (active === undefined) return;
    setError('');
    await active.pulse(); // its failures are in the thread; the button is disabled until the model is known
  });
  for (const [name, button] of [['coming-up', comingUp], ['long-range', longRange]]) {
    button.addEventListener('click', async () => {
      if (active === undefined) return;
      setError('');
      await active.check(name);
    });
  }
  retry.addEventListener('click', () => void active?.loadMode());

  return Object.freeze({
    /** Shows this circle's thread (made on first use), asking which model answers if that is not yet known. */
    show(circle) {
      const session = sessionFor(circle);
      unsubscribe?.();
      active = session;
      drawer.clear();
      setError('');
      text.value = '';
      unsubscribe = session.subscribe(render);
      render(session.getState());
      if (session.getState().mode.status === 'unknown') void session.loadMode();
    },
    /** Another screen: stop listening (the threads stay while signed in). */
    hide() {
      unsubscribe?.();
      unsubscribe = undefined;
      active = undefined;
    },
    /** Sign-out: every thread and the model are forgotten; answers still on their way are dropped. */
    reset() {
      for (const { session } of sessions.values()) session.reset();
      sessions.clear();
      this.hide();
      drawer.clear();
      text.value = '';
      setError('');
    },
  });
}
