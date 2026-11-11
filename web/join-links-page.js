// Puts "Join links" and "Waiting to join" on a circle's screen (R-023), and a person's own waiting requests on the Invitations
// screen. Like the other pages it only sets text, `hidden`, `disabled`, attributes, values and the focus; rows come from
// `<template>` elements. Nothing is requested until the person asks, the section shows only to owners and managers (a hint: the
// service decides), a new link's address is in the page only while it is shown, and nothing is kept when the screen is left.

import { createJoinLinksSession, createMyRequestsSession } from './join-links-session.js';
import { JOIN_CREATED_WORDS, JOIN_NO_LINKS, JOIN_NO_REQUESTS, JOIN_NOTE, joinLinkRow, joinRequestRow, joinUrl, MY_REQUESTS_NONE, MY_REQUESTS_NOTE, myRequestRow } from './circles-view.js';

const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out' || r.kind === 'dropped' || r.kind === 'not-open';
const FIELDS = ['label', 'role', 'days', 'uses', 'approval'];
const DEFAULTS = Object.freeze({ label: '', role: 'observer', days: '7', uses: '1', approval: 'yes' });

const slot = (row, name) => {
  const element = row.querySelector(`[data-slot="${name}"]`);
  if (!element) throw new Error(`a row template has no slot "${name}"`);
  return element;
};
const rowOf = (template) => template.content.firstElementChild.cloneNode(true);

/** `"7"` is 7; anything that is not whole digits is not a number (so the form check names the field). */
const whole = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

export function mountJoinLinksPage(document, { client, onSignedOut, onChanged, origin }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createJoinLinksSession({ client, onSignedOut, onChanged });

  const section = $('join-section');
  const heading = $('join-heading');
  $('join-note').textContent = JOIN_NOTE;
  const load = $('join-load');
  const status = $('join-status');
  const error = $('join-error');
  const notice = $('join-notice');
  const body = $('join-body');
  const form = $('join-form');
  const formError = $('join-form-error');
  const submit = $('join-submit');
  const inputs = Object.fromEntries(FIELDS.map((f) => [f, { input: $(`join-${f}`), error: $(`join-${f}-error`) }]));
  const created = $('join-created');
  const createdWords = $('join-created-words');
  const createdUrl = $('join-created-url');
  const createdDone = $('join-created-done');
  const linksEmpty = $('join-links-empty');
  const linksList = $('join-links-list');
  const requestsHeading = $('join-requests-heading');
  const requestsEmpty = $('join-requests-empty');
  const requestsList = $('join-requests-list');
  const refresh = $('join-refresh');
  const linkTemplate = $('join-link-row-template');
  const requestTemplate = $('join-request-row-template');

  let circleId = null;
  let allowed = false;

  const rowFor = (list, id) => [...list.children].find((row) => row.getAttribute('data-id') === id);

  function setText(target, text) {
    target.textContent = text;
    target.hidden = text === '';
  }
  function clearFields() {
    for (const { input, error: e } of Object.values(inputs)) {
      input.removeAttribute('aria-invalid');
      setText(e, '');
    }
    setText(formError, '');
  }
  function resetForm() {
    for (const f of FIELDS) inputs[f].input.value = DEFAULTS[f];
    clearFields();
  }
  /** Problems beside their fields; the first takes the focus. A problem with no field is the form's top message. */
  function showProblems(errors, general) {
    clearFields();
    let first = null;
    for (const f of FIELDS) {
      if (errors[f] === undefined) continue;
      setText(inputs[f].error, errors[f]);
      inputs[f].input.setAttribute('aria-invalid', 'true');
      first ??= inputs[f].input;
    }
    if (first !== null) first.focus();
    else if (general) {
      setText(formError, general);
      formError.focus();
    }
  }

  function render(state) {
    section.hidden = !allowed;
    const started = state.status !== 'idle';
    load.hidden = started;
    status.textContent = state.status === 'loading' ? 'Loading…' : '';
    status.hidden = state.status !== 'loading';
    const loaded = state.status === 'loaded';
    const top = state.status === 'gone' || state.status === 'error' || state.status === 'unavailable' ? state.message : state.problem !== null && state.problemField === null ? state.problem : '';
    setText(error, top ?? '');
    setText(notice, state.notice ?? '');
    body.hidden = !loaded;
    submit.disabled = state.busy;
    refresh.disabled = state.busy;
    createdDone.disabled = state.busy;
    form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    if (!loaded) {
      // nothing of a circle that is not shown stays in the page, and no link's address ever does
      linksList.replaceChildren();
      requestsList.replaceChildren();
      createdUrl.textContent = '';
      created.hidden = true;
      return;
    }
    created.hidden = state.created === null;
    createdWords.textContent = state.created === null ? '' : JOIN_CREATED_WORDS;
    createdUrl.textContent = state.created === null ? '' : joinUrl(origin, state.created.token);

    linksEmpty.textContent = JOIN_NO_LINKS;
    linksEmpty.hidden = state.links.length > 0;
    const linkRows = state.links.map((l) => {
      const view = joinLinkRow(l);
      const row = rowOf(linkTemplate);
      row.setAttribute('data-id', l.id);
      slot(row, 'title').textContent = view.title;
      slot(row, 'meta').textContent = view.meta;
      const asked = state.asking === l.id;
      const revoke = slot(row, 'revoke');
      revoke.hidden = asked;
      revoke.disabled = state.busy;
      revoke.setAttribute('aria-label', view.revokeLabel);
      revoke.addEventListener('click', () => {
        if (session.askRevoke(l.id)) slot(rowFor(linksList, l.id), 'no').focus();
      });
      slot(row, 'ask').hidden = !asked;
      slot(row, 'askText').textContent = view.askText;
      const yes = slot(row, 'yes');
      yes.disabled = state.busy;
      yes.addEventListener('click', () => void withdraw());
      const no = slot(row, 'no');
      no.disabled = state.busy;
      no.addEventListener('click', () => {
        session.cancel();
        slot(rowFor(linksList, l.id), 'revoke').focus();
      });
      return row;
    });
    linksList.replaceChildren(...linkRows);
    linksList.hidden = linkRows.length === 0;

    requestsEmpty.textContent = JOIN_NO_REQUESTS;
    requestsEmpty.hidden = state.requests.length > 0;
    const requestRows = state.requests.map((r) => {
      const view = joinRequestRow(r);
      const row = rowOf(requestTemplate);
      row.setAttribute('data-id', r.id);
      slot(row, 'title').textContent = view.title;
      slot(row, 'meta').textContent = view.meta;
      const approve = slot(row, 'approve');
      approve.disabled = state.busy;
      approve.setAttribute('aria-label', view.approveLabel);
      approve.addEventListener('click', () => void settle('approve', r.id));
      const decline = slot(row, 'decline');
      decline.disabled = state.busy;
      decline.setAttribute('aria-label', view.declineLabel);
      decline.addEventListener('click', () => void settle('decline', r.id));
      return row;
    });
    requestsList.replaceChildren(...requestRows);
    requestsList.hidden = requestRows.length === 0;
  }

  async function withdraw() {
    const r = await session.confirmRevoke();
    if (r.ok) notice.focus();
    else if (!quiet(r)) error.focus();
  }

  async function settle(action, id) {
    const r = await session[action](id);
    if (r.ok) notice.focus();
    else if (!quiet(r)) (session.getState().status === 'loaded' ? requestsHeading : error).focus();
  }

  load.addEventListener('click', async () => {
    if (circleId === null) return;
    const r = await session.open(circleId);
    if (r.ok) heading.focus();
    else if (!quiet(r)) error.focus();
  });
  refresh.addEventListener('click', async () => {
    const r = await session.refresh();
    if (r.ok) heading.focus();
    else if (!quiet(r)) error.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFields();
    const r = await session.create({
      label: inputs.label.input.value,
      role: inputs.role.input.value,
      days: whole(inputs.days.input.value),
      uses: whole(inputs.uses.input.value),
      approval: inputs.approval.input.value === 'yes' ? true : inputs.approval.input.value === 'no' ? false : undefined,
    });
    if (r.ok) {
      resetForm();
      createdUrl.focus();
    } else if (!quiet(r)) {
      const errors = r.errors ?? (r.field !== undefined && FIELDS.includes(r.field) ? { [r.field]: r.message } : {});
      showProblems(errors, Object.keys(errors).length === 0 ? r.message : '');
    }
  });
  createdDone.addEventListener('click', () => {
    if (session.dismissCreated()) inputs.label.input.focus();
  });

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The circle screen is shown for `id`; nothing is requested until the person asks. */
    show(id) {
      session.reset();
      circleId = id;
      resetForm();
      render(session.getState());
    },
    /** Whether the person's role may manage links (a hint: the service decides). */
    setAllowed(value) {
      allowed = value === true;
      render(session.getState());
    },
    /** Signed out, or off this screen: forget everything, a new link's address included. */
    reset() {
      circleId = null;
      allowed = false;
      resetForm();
      session.reset();
    },
  });
}

/** "Waiting to join" on the Invitations screen: the person's own waiting requests, loaded when they ask. */
export function mountMyRequestsPage(document, { client, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createMyRequestsSession({ client, onSignedOut });
  const heading = $('my-requests-heading');
  $('my-requests-note').textContent = MY_REQUESTS_NOTE;
  const load = $('my-requests-load');
  const status = $('my-requests-status');
  const error = $('my-requests-error');
  const empty = $('my-requests-empty');
  const list = $('my-requests-list');
  const template = $('my-request-row-template');

  function render(state) {
    const started = state.status !== 'idle';
    load.hidden = false;
    load.textContent = started ? 'Refresh my waiting requests' : 'Show my waiting requests';
    load.disabled = state.busy;
    status.textContent = state.status === 'loading' ? 'Loading…' : '';
    status.hidden = state.status !== 'loading';
    error.textContent = state.status === 'error' || state.status === 'unavailable' ? state.message ?? '' : '';
    error.hidden = error.textContent === '';
    empty.textContent = MY_REQUESTS_NONE;
    empty.hidden = !(state.status === 'loaded' && state.items.length === 0);
    const rows = state.status === 'loaded' ? state.items.map((r) => {
      const view = myRequestRow(r);
      const row = rowOf(template);
      slot(row, 'title').textContent = view.title;
      slot(row, 'meta').textContent = view.meta;
      return row;
    }) : [];
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
  }

  load.addEventListener('click', async () => {
    const r = await session.open();
    if (r.ok) heading.focus();
    else if (!quiet(r)) error.focus();
  });

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The Invitations screen is shown; nothing is requested until the person asks. */
    show() {
      session.reset();
    },
    reset() {
      session.reset();
    },
  });
}
