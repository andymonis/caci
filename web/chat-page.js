// Puts the chat (R-016) on the Home screen. Like the other pages it only sets text, `hidden`, `disabled`, values, a few ARIA
// attributes and the focus; thread rows come from `<template>` elements; anything the person, the service or the model wrote is text.
// It returns the hooks `user-mount.js` calls: `route(name)` when the screen changes and `reset()` on sign-out.

import { createChatSession } from './chat-session.js';
import { chatModeNotice } from './chat-view.js';
import { createThreadDrawer } from './thread-view.js';

export function mountChatPage(document, notes, onSignedOut, ledger) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const chat = createChatSession({ notes, ledger, onSignedOut });
  const notice = $('chat-notice');
  const modeError = $('chat-mode-error');
  const retry = $('chat-retry');
  const thread = $('chat-thread');
  const updateForm = $('update-form');
  const updateText = $('update-text');
  const updateError = $('update-error');
  const updateSend = $('update-send');
  const questionForm = $('question-form');
  const questionText = $('question-text');
  const questionError = $('question-error');
  const questionAsk = $('question-ask');
  const msgTemplate = $('msg-template');
  const lineTemplate = $('msg-line-template');

  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };

  const showSource = async (id, index) => {
    const result = await chat.showSource(id, index);
    if (result.ok) drawer.focusLast();
  };
  const drawer = createThreadDrawer({ thread, msgTemplate, lineTemplate, onShowSource: ledger === undefined ? undefined : showSource });

  function render(state) {
    notice.textContent = chatModeNotice(state.mode);
    setError(modeError, state.mode.status === 'error' && typeof state.mode.error === 'string' ? state.mode.error : '');
    retry.hidden = state.mode.status !== 'error';
    retry.disabled = state.busy;
    drawer.draw(state.messages, state.busy);
    updateSend.disabled = !state.canSend;
    questionAsk.disabled = !state.canAsk;
    updateForm.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    questionForm.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  updateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(updateError, '');
    setError(questionError, '');
    const result = await chat.send(updateText.value);
    if (result.ok) {
      updateText.value = '';
      updateText.focus();
      return;
    }
    if (result.kind === 'invalid' || result.kind === 'mode-unknown') {
      setError(updateError, result.message);
      updateText.focus();
    }
  });
  questionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(updateError, '');
    setError(questionError, '');
    const result = await chat.ask(questionText.value);
    if (result.ok) {
      questionText.value = '';
      questionText.focus();
      return;
    }
    if (result.kind === 'invalid' || result.kind === 'mode-unknown') {
      setError(questionError, result.message);
      questionText.focus();
    }
  });
  retry.addEventListener('click', () => void chat.loadMode());
  chat.subscribe(render);
  render(chat.getState());

  return Object.freeze({
    chat,
    route(name) {
      if (name !== 'home') return;
      const mode = chat.getState().mode;
      if (mode.status === 'unknown') void chat.loadMode();
    },
    reset() {
      chat.reset();
      drawer.clear();
      updateText.value = '';
      questionText.value = '';
      setError(updateError, '');
      setError(questionError, '');
    },
  });
}
