// Puts the chat (R-016) on the Home screen. Like the other pages it only sets text, `hidden`, `disabled`, values, a few ARIA
// attributes and the focus; thread rows come from `<template>` elements; anything the person, the service or the model wrote is text.
// It returns the hooks `user-mount.js` calls: `route(name)` when the screen changes and `reset()` on sign-out.

import { createChatSession } from './chat-session.js';
import { chatModeNotice, messageClass } from './chat-view.js';

export function mountChatPage(document, notes, onSignedOut) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const chat = createChatSession({ notes, onSignedOut });
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
  const choiceTemplate = $('msg-choice-template');

  const clone = (template) => template.content.firstElementChild.cloneNode(true);
  const slot = (row, name) => {
    const found = row.querySelector(`[data-slot="${name}"]`);
    if (!found) throw new Error(`a row template has no slot "${name}"`);
    return found;
  };
  const setError = (target, message) => {
    target.textContent = message;
    target.hidden = message === '';
  };

  let drawn = '';
  let choiceButtons = [];
  let wantChoiceFocus = false;

  function draw(state) {
    const last = state.messages.at(-1);
    const key = `${state.messages.length}:${last ? last.id : 0}:${state.choosing}`;
    if (key === drawn) return;
    drawn = key;
    choiceButtons = [];
    const lastChoiceId = state.choosing ? [...state.messages].reverse().find((m) => m.kind === 'choice')?.id : undefined;
    const rows = state.messages.map((message) => {
      const row = clone(msgTemplate);
      row.setAttribute('class', messageClass(message));
      slot(row, 'text').textContent = message.text;
      const lines = slot(row, 'lines');
      lines.replaceChildren(
        ...message.lines.map((line) => {
          const item = clone(lineTemplate);
          slot(item, 'text').textContent = line;
          return item;
        }),
      );
      lines.hidden = message.lines.length === 0;
      const choices = slot(row, 'choices');
      const offered = message.id === lastChoiceId && message.choices ? message.choices : [];
      choices.replaceChildren(
        ...offered.map((choice) => {
          const wrap = clone(choiceTemplate);
          const button = slot(wrap, 'button');
          button.textContent = choice.label;
          button.addEventListener('click', () => void pick(choice.key));
          choiceButtons.push(button);
          return wrap;
        }),
      );
      choices.hidden = offered.length === 0;
      return row;
    });
    thread.replaceChildren(...rows);
    thread.scrollTop = thread.scrollHeight;
    if (wantChoiceFocus && choiceButtons.length > 0) {
      wantChoiceFocus = false;
      choiceButtons[0].focus();
    }
  }

  function render(state) {
    notice.textContent = chatModeNotice(state.mode);
    setError(modeError, state.mode.status === 'error' && typeof state.mode.error === 'string' ? state.mode.error : '');
    retry.hidden = state.mode.status !== 'error';
    retry.disabled = state.busy;
    draw(state);
    const idle = state.canSend;
    updateSend.disabled = !idle;
    questionAsk.disabled = !idle;
    updateForm.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    questionForm.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  async function pick(key) {
    await chat.choose(key);
    updateText.focus();
  }

  updateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(updateError, '');
    setError(questionError, '');
    wantChoiceFocus = true;
    const result = await chat.send(updateText.value);
    wantChoiceFocus = false;
    if (result.ok) {
      updateText.value = '';
      if (!result.asked) updateText.focus();
      return;
    }
    if (result.kind === 'invalid' || result.kind === 'mode-unknown' || result.kind === 'choose') {
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
    if (result.kind === 'invalid' || result.kind === 'mode-unknown' || result.kind === 'choose') {
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
      drawn = '';
      updateText.value = '';
      questionText.value = '';
      setError(updateError, '');
      setError(questionError, '');
    },
  });
}
