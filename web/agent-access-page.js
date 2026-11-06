// The Agent access part of the everyday app's Settings (R-022): make, list and stop the keys that let the person's own agent read their
// notes, one way. Like the other pages it only sets text, `hidden`, `disabled`, values, a few ARIA attributes and the focus, and
// builds rows from `<template>` elements. The part shows only when the service has agent access switched on. Returns
// `route(name)` (called whenever a screen is shown) and `reset()` (sign-out): both forget the new key's text.

import { createAgentAccessSession } from './agent-access-session.js';
import { formatTime } from './capture-view.js';
import { formatDate } from './circles-view.js';

export const EXPLAIN = 'Let your own agent (an assistant that works for you) read your notes, one way: it can search and read them, and it can never change anything. Each key names the notes it may read and stops on the date shown. You can stop one at any time.';
export const WARNING = "Anything your agent reads is sent to your agent's provider, the company that runs it. CaCi cannot take it back.";
export const CREATED_WORDS = (name) => `Your new key for "${name}". It is shown only now: copy it and keep it safe. It cannot be shown again.`;
export const NO_KEYS = 'You have not made any access keys.';
export const REVOKE_QUESTION = (name) => `Stop "${name}"? Whatever uses this key will be refused from now on.`;

/** `Can read: ...`, when it ends, when it was last used, and whether it may ask for attention checks. */
export function keyDetails(key, labels) {
  const reads = key.scopes.map((s) => labels.get(s) ?? (s === 'personal' ? 'My own notes' : 'A circle you were in')).join(', ');
  const used = key.lastUsedAt === null ? 'Not used yet.' : `Last used ${formatTime(key.lastUsedAt)}.`;
  return `Can read: ${reads}. ${key.checks ? 'May also ask CaCi for attention checks. ' : ''}Ends ${formatDate(key.expiresAt)}. ${used}`;
}

export function mountAgentAccess(document, { client, circles, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const section = $('agent-access');
  $('agent-explain').textContent = EXPLAIN;
  $('agent-warning').textContent = WARNING;
  const errorLine = $('agent-error');
  const noticeLine = $('agent-notice');
  const createdBox = $('agent-created');
  const createdWords = $('agent-created-words');
  const createdToken = $('agent-created-token');
  const createdDone = $('agent-created-done');
  const form = $('agent-form');
  const nameInput = $('agent-name');
  const nameError = $('agent-name-error');
  const brains = $('agent-brains');
  const brainsError = $('agent-brains-error');
  const brainTemplate = $('agent-brain-template');
  const checksBox = $('agent-checks');
  const daysSelect = $('agent-days');
  const daysError = $('agent-days-error');
  const submit = $('agent-submit');
  const list = $('agent-list');
  const empty = $('agent-empty');
  const rowTemplate = $('agent-row-template');
  const confirm = $('agent-revoke-confirm');
  const confirmText = $('agent-revoke-text');
  const confirmYes = $('agent-revoke-yes');
  const confirmNo = $('agent-revoke-no');

  const session = createAgentAccessSession({ client, onSignedOut });
  let drawnChoices = '';
  let boxes = []; // the tick boxes of the notes to choose from: [{ key, box }]
  let focusAfter;

  const show = (element, text) => {
    element.textContent = text;
    element.hidden = text === '';
  };

  function drawChoices(choices) {
    const key = JSON.stringify(choices.map((c) => c.key));
    if (key === drawnChoices) return; // the ticks the person made stay while nothing changed
    drawnChoices = key;
    boxes = [];
    brains.replaceChildren(
      ...choices.map((c) => {
        const row = brainTemplate.content.firstElementChild.cloneNode(true);
        const box = row.querySelector('[data-slot="box"]');
        const label = row.querySelector('[data-slot="label"]');
        if (!box || !label) throw new Error('the brain template has no slots "box" and "label"');
        box.setAttribute('data-scope', c.key);
        box.checked = false;
        boxes.push({ key: c.key, box });
        label.textContent = c.label;
        return row;
      }),
    );
  }
  const chosenScopes = () => boxes.filter((b) => b.box.checked).map((b) => b.key);

  function render(state) {
    section.hidden = state.status !== 'ready';
    if (state.status !== 'ready') {
      createdToken.value = '';
      return;
    }
    show(errorLine, state.error);
    show(noticeLine, state.notice);
    if (state.created === undefined) {
      createdBox.hidden = true;
      createdToken.value = '';
    } else {
      createdBox.hidden = false;
      createdWords.textContent = CREATED_WORDS(state.created.name);
      createdToken.value = state.created.token;
    }
    drawChoices(state.choices);
    const labels = new Map(state.choices.map((c) => [c.key, c.label]));
    list.replaceChildren(
      ...state.items.map((key) => {
        const row = rowTemplate.content.firstElementChild.cloneNode(true);
        const name = row.querySelector('[data-slot="name"]');
        const details = row.querySelector('[data-slot="details"]');
        const stop = row.querySelector('[data-slot="revoke"]');
        if (!name || !details || !stop) throw new Error('the key template has no slots "name", "details" and "revoke"');
        name.textContent = key.name;
        details.textContent = keyDetails(key, labels);
        stop.setAttribute('aria-label', `Stop the key ${key.name}`);
        stop.disabled = state.busy;
        stop.addEventListener('click', () => {
          if (session.askRevoke(key.id)) {
            focusAfter = stop;
            confirmNo.focus();
          }
        });
        return row;
      }),
    );
    empty.hidden = state.items.length > 0;
    empty.textContent = NO_KEYS;
    const asked = state.asking === undefined ? undefined : state.items.find((i) => i.id === state.asking);
    confirm.hidden = asked === undefined;
    if (asked !== undefined) confirmText.textContent = REVOKE_QUESTION(asked.name);
    for (const control of [submit, confirmYes, confirmNo, createdDone]) control.disabled = state.busy;
    form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }
  session.subscribe(render);
  render(session.getState());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    for (const e of [nameError, brainsError, daysError]) show(e, '');
    nameInput.removeAttribute('aria-invalid');
    const result = await session.create({ name: nameInput.value, scopes: chosenScopes(), checks: checksBox.checked === true, days: Number(daysSelect.value) });
    if (result.ok) {
      nameInput.value = '';
      checksBox.checked = false;
      for (const b of boxes) b.box.checked = false;
      createdToken.focus();
      return;
    }
    const where = result.errors === undefined ? undefined : Object.keys(result.errors)[0];
    if (where === 'name') {
      show(nameError, result.message);
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.focus();
    } else if (where === 'scopes' || where === 'checks') {
      show(brainsError, result.message);
      boxes[0]?.box.focus();
    } else if (where === 'days') {
      show(daysError, result.message);
      daysSelect.focus();
    } else if (result.message !== undefined) errorLine.focus();
  });
  createdDone.addEventListener('click', () => {
    session.dismissCreated();
    nameInput.focus();
  });
  confirmYes.addEventListener('click', async () => {
    const r = await session.confirmRevoke();
    (r.ok ? $('agent-heading') : focusAfter)?.focus?.();
  });
  confirmNo.addEventListener('click', () => {
    session.cancel();
    focusAfter?.focus?.();
  });

  return Object.freeze({
    /** `after` is the navigation's read of the circles, which this waits for so the choices are the latest known. */
    route(name, after) {
      if (name !== 'settings') return session.reset();
      void (async () => {
        try {
          await after;
        } catch {
          // the circles could not be read: the choices stay as they were known
        }
        await session.open(circles());
      })();
    },
    reset: () => session.reset(),
  });
}
