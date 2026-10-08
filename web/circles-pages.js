// Puts the circles list, the create form, the invitations and the home page's invitation count on the page
// (R-006). Like `mount.js` it only sets text, `hidden`, `disabled`, attributes and the focus; rows are cloned
// from `<template>` elements and filled with `textContent`, so nothing a person or the service wrote is ever
// read as markup. `document` and the circles client are given, so it all runs against a stand-in page.

import { createCirclesSession } from './circles-session.js';
import { circleRow, countText, EMPTY_CIRCLES, EMPTY_INVITATIONS, invitationRow, headingIdFor } from './circles-view.js';

export function mountCirclesPages(document, { client, go, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createCirclesSession({ client, onSignedOut });

  const count = $('home-invitations-count');
  const refresh = $('home-refresh');
  const circlesStatus = $('circles-status');
  const circlesError = $('circles-error');
  const circlesEmpty = $('circles-empty');
  const circlesList = $('circles-list');
  const circlesMore = $('circles-more');
  const circleTemplate = $('circle-row-template');
  const create = {
    form: $('create-form'),
    general: $('create-error'),
    submit: $('create-submit'),
    fields: { name: { input: $('create-name'), error: $('create-name-error') }, description: { input: $('create-description'), error: $('create-description-error') } },
  };
  const invitationsStatus = $('invitations-status');
  const invitationsError = $('invitations-error');
  const invitationsEmpty = $('invitations-empty');
  const invitationsList = $('invitations-list');
  const invitationsMore = $('invitations-more');
  const invitationTemplate = $('invitation-row-template');

  let invitationsNotice = '';

  const slot = (row, name) => {
    const element = row.querySelector(`[data-slot="${name}"]`);
    if (!element) throw new Error(`a row template has no slot "${name}"`);
    return element;
  };
  const rowOf = (template) => template.content.firstElementChild.cloneNode(true);

  function renderCircles(state) {
    const c = state.circles;
    const loading = state.busy.circles && c.status !== 'loaded';
    circlesStatus.textContent = loading ? 'Loading…' : '';
    circlesStatus.hidden = !loading;
    circlesError.textContent = c.error === null ? '' : c.error;
    circlesError.hidden = c.error === null;
    circlesEmpty.textContent = EMPTY_CIRCLES;
    circlesEmpty.hidden = !(c.status === 'loaded' && c.items.length === 0);
    const rows = c.items.map((circle) => {
      const view = circleRow(circle);
      const row = rowOf(circleTemplate);
      const link = slot(row, 'link');
      link.textContent = view.name;
      link.setAttribute('href', view.href);
      link.setAttribute('aria-label', view.label);
      slot(row, 'meta').textContent = view.meta;
      return row;
    });
    circlesList.replaceChildren(...rows);
    circlesList.hidden = rows.length === 0;
    circlesMore.hidden = c.nextCursor === null;
    circlesMore.disabled = state.busy.circles;
    create.submit.disabled = state.busy.circles;
    create.form.setAttribute('aria-busy', state.busy.circles ? 'true' : 'false');
  }

  function renderInvitations(state) {
    const inv = state.invitations;
    count.textContent = countText(inv);
    refresh.disabled = state.busy.invitations;
    const loading = state.busy.invitations && inv.status !== 'loaded';
    invitationsStatus.textContent = loading ? 'Loading…' : '';
    invitationsStatus.hidden = !loading;
    const message = invitationsNotice !== '' ? invitationsNotice : inv.error === null ? '' : inv.error;
    invitationsError.textContent = message;
    invitationsError.hidden = message === '';
    invitationsEmpty.textContent = EMPTY_INVITATIONS;
    invitationsEmpty.hidden = !(inv.status === 'loaded' && inv.items.length === 0);
    const rows = inv.items.map((invitation) => {
      const view = invitationRow(invitation);
      const row = rowOf(invitationTemplate);
      slot(row, 'circle').textContent = view.circle;
      slot(row, 'meta').textContent = view.meta;
      slot(row, 'roleWords').textContent = view.roleWords;
      slot(row, 'from').textContent = view.from;
      slot(row, 'ends').textContent = view.ends;
      const accept = slot(row, 'accept');
      const decline = slot(row, 'decline');
      accept.setAttribute('aria-label', view.acceptLabel);
      decline.setAttribute('aria-label', view.declineLabel);
      accept.disabled = state.busy.invitations;
      decline.disabled = state.busy.invitations;
      accept.addEventListener('click', () => void acceptOne(invitation.id));
      decline.addEventListener('click', () => void declineOne(invitation.id));
      return row;
    });
    invitationsList.replaceChildren(...rows);
    invitationsList.hidden = rows.length === 0;
    invitationsMore.hidden = inv.nextCursor === null;
    invitationsMore.disabled = state.busy.invitations;
  }

  const render = (state) => {
    renderCircles(state);
    renderInvitations(state);
  };

  async function acceptOne(id) {
    invitationsNotice = '';
    const r = await session.acceptInvitation(id);
    if (r.ok) go({ name: 'circle', id: r.circle.id });
    else if (r.kind !== 'busy' && r.kind !== 'signed-out') {
      invitationsNotice = r.message;
      render(session.getState());
      invitationsError.focus();
    }
  }

  async function declineOne(id) {
    invitationsNotice = '';
    const r = await session.declineInvitation(id);
    if (r.ok) $(headingIdFor({ name: 'invitations' })).focus();
    else if (r.kind !== 'busy' && r.kind !== 'signed-out') {
      invitationsNotice = r.message;
      render(session.getState());
      invitationsError.focus();
    }
  }

  function clearCreate() {
    create.general.textContent = '';
    create.general.hidden = true;
    for (const { input, error } of Object.values(create.fields)) {
      error.textContent = '';
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  create.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearCreate();
    const r = await session.createCircle({ name: create.fields.name.input.value, description: create.fields.description.input.value });
    if (r.ok) {
      create.fields.name.input.value = '';
      create.fields.description.input.value = '';
      go({ name: 'circle', id: r.circle.id });
      return;
    }
    if (r.kind === 'busy' || r.kind === 'signed-out') return;
    const errors = r.errors ?? {};
    let first = null;
    for (const field of ['name', 'description']) {
      if (errors[field] === undefined) continue;
      create.fields[field].error.textContent = errors[field];
      create.fields[field].error.hidden = false;
      create.fields[field].input.setAttribute('aria-invalid', 'true');
      first ??= field;
    }
    if (first !== null) create.fields[first].input.focus();
    else {
      create.general.textContent = r.message;
      create.general.hidden = false;
      create.general.focus();
    }
  });
  circlesMore.addEventListener('click', () => void session.moreCircles());
  invitationsMore.addEventListener('click', () => void session.moreInvitations());
  refresh.addEventListener('click', () => void session.refreshCount());
  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** A screen has been shown: load what it needs. Lists are as old as their last load, so a visit loads again. */
    show(route) {
      invitationsNotice = '';
      if (route.name === 'circles') void session.loadCircles();
      else if (route.name === 'invitations') void session.loadInvitations();
      else if (route.name === 'home') void session.loadInvitations();
    },
    /** Signed out: forget everything. */
    reset() {
      invitationsNotice = '';
      clearCreate();
      create.fields.name.input.value = '';
      create.fields.description.input.value = '';
      session.reset();
    },
  });
}
