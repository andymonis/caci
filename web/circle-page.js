// Puts one circle's screen on the page (R-006): its details, the people in it, and the forms and buttons
// for the person's role. Like `circles-pages.js` it only sets text, `hidden`, `disabled`, attributes, values
// and the focus; rows come from `<template>` elements. Which controls show is a hint from `permissions.js`
// (through the session's state); the service decides, and its refusals are shown in its own words.

import { createCircleSession } from './circle-session.js';
import { circleInvitationRow, DELETE_TEXT, LEAVE_TEXT, memberRow, NO_INVITATIONS_HERE } from './circles-view.js';
import { can, ROLE_WORDS, ROLES } from './permissions.js';

export function mountCirclePage(document, { client, go, onSignedOut }) {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`the page has no element "${id}"`);
    return element;
  };
  const session = createCircleSession({ client, onSignedOut });

  const heading = $('circle-heading');
  const status = $('circle-status');
  const error = $('circle-error');
  const gone = $('circle-gone');
  const body = $('circle-body');
  const description = $('circle-description');
  const role = $('circle-role');
  const roleWords = $('circle-role-words');
  const refresh = $('circle-refresh');
  const renameSection = $('rename-section');
  const rename = {
    form: $('rename-form'),
    general: $('rename-error'),
    submit: $('rename-submit'),
    notice: $('rename-notice'),
    fields: { name: { input: $('rename-name'), error: $('rename-name-error') }, description: { input: $('rename-description'), error: $('rename-description-error') } },
  };
  const membersError = $('members-error');
  const membersList = $('members-list');
  const membersMore = $('members-more');
  const memberTemplate = $('member-row-template');
  const inviteSection = $('invite-section');
  const invite = {
    form: $('invite-form'),
    general: $('invite-error'),
    submit: $('invite-submit'),
    notice: $('invite-notice'),
    role: $('invite-role'),
    roleWords: $('invite-role-words'),
    options: Object.fromEntries(ROLES.map((r) => [r, $(`invite-role-${r}`)])),
    fields: { username: { input: $('invite-username'), error: $('invite-username-error') }, role: { input: $('invite-role'), error: $('invite-role-error') } },
  };
  const invSection = $('circle-invitations-section');
  const invHeading = $('circle-invitations-heading');
  const invError = $('circle-invitations-error');
  const invEmpty = $('circle-invitations-empty');
  const invList = $('circle-invitations-list');
  const invMore = $('circle-invitations-more');
  const invTemplate = $('circle-invitation-row-template');
  const membersHeading = $('members-heading');
  const ask = {
    leave: { button: $('leave-button'), panel: $('leave-confirm'), text: $('leave-confirm-text'), yes: $('leave-yes'), no: $('leave-no') },
    delete: { button: $('delete-button'), panel: $('delete-confirm'), text: $('delete-confirm-text'), yes: $('delete-yes'), no: $('delete-no') },
  };

  let populated = null; // which version of the circle the rename form was last filled from
  let message = ''; // a problem to show about people (a failed role change or removal)
  let invMessage = '';
  let topMessage = ''; // a problem with leaving or deleting

  const slot = (row, name) => {
    const element = row.querySelector(`[data-slot="${name}"]`);
    if (!element) throw new Error(`a row template has no slot "${name}"`);
    return element;
  };
  const rowOf = (template) => template.content.firstElementChild.cloneNode(true);

  function setError(target, text) {
    target.textContent = text;
    target.hidden = text === '';
  }

  function render(state) {
    const loaded = state.status === 'loaded' && state.circle !== null;
    const loading = state.status === 'loading';
    status.textContent = loading ? 'Loading…' : '';
    status.hidden = !loading;
    gone.textContent = state.status === 'gone' ? state.message : '';
    gone.hidden = state.status !== 'gone';
    setError(error, state.status === 'error' ? state.message : topMessage !== '' ? topMessage : loaded && state.message !== null ? state.message : '');
    body.hidden = !loaded;
    refresh.disabled = state.busy;
    heading.textContent = loaded ? state.circle.name : 'Circle';
    if (!loaded) {
      // nothing of a circle that is not shown stays in the page
      membersList.replaceChildren();
      invList.replaceChildren();
      return;
    }

    const c = state.circle;
    description.textContent = typeof c.description === 'string' ? c.description : '';
    description.hidden = typeof c.description !== 'string' || c.description === '';
    role.textContent = `Your role: ${c.role}`;
    roleWords.textContent = Object.hasOwn(ROLE_WORDS, c.role) ? ROLE_WORDS[c.role] : '';

    // rename form: filled from the service's answer, only when the circle changed, so typing is not overwritten
    renameSection.hidden = !state.controls.rename;
    const version = `${c.id}|${c.updatedAt}|${c.name}|${c.description ?? ''}`;
    if (version !== populated) {
      populated = version;
      rename.fields.name.input.value = c.name;
      rename.fields.description.input.value = typeof c.description === 'string' ? c.description : '';
    }
    rename.submit.disabled = state.busy;
    rename.form.setAttribute('aria-busy', state.busy ? 'true' : 'false');

    // the people
    setError(membersError, message !== '' ? message : state.members.error === null ? '' : state.members.error);
    const rows = state.members.items.map((m) => {
      const view = memberRow(m, m.self);
      const row = rowOf(memberTemplate);
      slot(row, 'name').textContent = view.name;
      slot(row, 'meta').textContent = view.meta;
      slot(row, 'roleWords').textContent = view.roleWords;
      const manageable = m.controls.changeRole || m.controls.remove;
      const asked = state.confirm !== null && state.confirm.action === 'remove' && state.confirm.userId === m.userId;
      slot(row, 'manage').hidden = !manageable || asked;
      const select = slot(row, 'role');
      select.setAttribute('aria-label', view.roleLabel);
      for (const r of ROLES) {
        const option = slot(row, `opt-${r}`);
        const allowed = can(c.role, 'changeRole', { target: m.role, role: r, self: false }) || r === m.role;
        option.hidden = !allowed;
        option.disabled = !allowed;
      }
      select.value = m.role;
      select.disabled = state.busy || !m.controls.changeRole;
      const save = slot(row, 'save');
      save.hidden = !m.controls.changeRole;
      save.disabled = state.busy;
      save.setAttribute('aria-label', view.saveLabel);
      save.addEventListener('click', () => void changeRole(m.userId, select.value));
      const remove = slot(row, 'remove');
      remove.hidden = !m.controls.remove;
      remove.disabled = state.busy;
      remove.setAttribute('aria-label', view.removeLabel);
      remove.addEventListener('click', () => {
        if (session.askRemove(m.userId)) slot(currentRow(m.userId), 'removeNo').focus();
      });
      slot(row, 'removeAsk').hidden = !asked;
      slot(row, 'removeText').textContent = view.removeText;
      slot(row, 'removeYes').addEventListener('click', () => void confirm('members'));
      slot(row, 'removeNo').addEventListener('click', () => {
        session.cancel();
        slot(currentRow(m.userId), 'remove').focus();
      });
      row.setAttribute('data-user', m.userId);
      return row;
    });
    membersList.replaceChildren(...rows);
    membersMore.hidden = state.members.nextCursor === null;
    membersMore.disabled = state.busy;

    // invite
    inviteSection.hidden = !state.controls.invite;
    for (const r of ROLES) {
      const allowed = state.rolesToOffer.includes(r);
      invite.options[r].hidden = !allowed;
      invite.options[r].disabled = !allowed;
    }
    if (!state.rolesToOffer.includes(invite.role.value) && state.rolesToOffer.length > 0) invite.role.value = state.rolesToOffer[0];
    invite.roleWords.textContent = Object.hasOwn(ROLE_WORDS, invite.role.value) ? ROLE_WORDS[invite.role.value] : '';
    invite.submit.disabled = state.busy;
    invite.form.setAttribute('aria-busy', state.busy ? 'true' : 'false');

    // open invitations
    invSection.hidden = !state.invitations.visible;
    setError(invError, invMessage !== '' ? invMessage : state.invitations.error === null ? '' : state.invitations.error);
    invEmpty.textContent = NO_INVITATIONS_HERE;
    invEmpty.hidden = !(state.invitations.visible && state.invitations.error === null && state.invitations.items.length === 0);
    const invRows = state.invitations.items.map((inv) => {
      const view = circleInvitationRow(inv);
      const row = rowOf(invTemplate);
      slot(row, 'who').textContent = view.who;
      slot(row, 'meta').textContent = view.meta;
      slot(row, 'from').textContent = view.from;
      slot(row, 'ends').textContent = view.ends;
      const withdraw = slot(row, 'withdraw');
      withdraw.hidden = !can(c.role, 'withdraw', { role: inv.role });
      withdraw.disabled = state.busy;
      withdraw.setAttribute('aria-label', view.withdrawLabel);
      withdraw.addEventListener('click', () => void withdrawOne(inv.id));
      return row;
    });
    invList.replaceChildren(...invRows);
    invList.hidden = invRows.length === 0;
    invMore.hidden = state.invitations.nextCursor === null;
    invMore.disabled = state.busy;

    // leave and delete: ask first
    for (const [name, text] of [['leave', LEAVE_TEXT], ['delete', DELETE_TEXT]]) {
      const parts = ask[name];
      const asked = state.confirm !== null && state.confirm.action === name;
      parts.text.textContent = text;
      parts.panel.hidden = !asked;
      parts.button.hidden = name === 'delete' ? !state.controls.delete || asked : asked;
      parts.button.disabled = state.busy;
    }
  }

  const currentRow = (userId) => [...membersList.children].find((row) => row.getAttribute('data-user') === userId) ?? membersList.children[0];

  function clear(form) {
    form.general.textContent = '';
    form.general.hidden = true;
    for (const { input, error: e } of Object.values(form.fields)) {
      e.textContent = '';
      e.hidden = true;
      input.removeAttribute('aria-invalid');
    }
    form.notice.textContent = '';
    form.notice.hidden = true;
  }

  /** Shows a form's problems: beside the fields the service named, else at the top; the first gets the focus. */
  function showProblems(form, r, order) {
    const errors = r.errors ?? {};
    let first = null;
    for (const field of order) {
      if (errors[field] === undefined) continue;
      form.fields[field].error.textContent = errors[field];
      form.fields[field].error.hidden = false;
      form.fields[field].input.setAttribute('aria-invalid', 'true');
      first ??= field;
    }
    if (first !== null) {
      form.fields[first].input.focus();
    } else {
      form.general.textContent = r.message;
      form.general.hidden = false;
      form.general.focus();
    }
  }

  const quiet = (r) => r.kind === 'busy' || r.kind === 'signed-out';

  rename.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(rename);
    const r = await session.update({ name: rename.fields.name.input.value, description: rename.fields.description.input.value });
    if (r.ok) {
      rename.notice.textContent = 'Saved.';
      rename.notice.hidden = false;
      rename.notice.focus();
    } else if (!quiet(r)) showProblems(rename, r, ['name', 'description']);
  });

  invite.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(invite);
    const r = await session.invite({ username: invite.fields.username.input.value, role: invite.role.value });
    if (r.ok) {
      invite.fields.username.input.value = '';
      invite.notice.textContent = r.notice;
      invite.notice.hidden = false;
      invite.notice.focus();
    } else if (!quiet(r)) showProblems(invite, r, ['username', 'role']);
  });
  invite.role.addEventListener('change', () => {
    invite.roleWords.textContent = Object.hasOwn(ROLE_WORDS, invite.role.value) ? ROLE_WORDS[invite.role.value] : '';
  });

  async function changeRole(userId, newRole) {
    message = '';
    const r = await session.changeRole(userId, newRole);
    if (r.ok) membersHeading.focus();
    else if (!quiet(r)) {
      message = r.message;
      render(session.getState());
      membersError.focus();
    }
  }

  async function withdrawOne(id) {
    invMessage = '';
    const r = await session.withdraw(id);
    if (r.ok) invHeading.focus();
    else if (!quiet(r)) {
      invMessage = r.message;
      render(session.getState());
      invError.focus();
    }
  }

  /** Do what was asked; `where` is the place a problem is shown. */
  async function confirm(where) {
    message = '';
    topMessage = '';
    const r = await session.confirmAction();
    if (r.ok && r.goTo === 'list') go({ name: 'circles' });
    else if (r.ok) membersHeading.focus();
    else if (!quiet(r)) {
      if (where === 'members') {
        message = r.message;
        render(session.getState());
        membersError.focus();
      } else {
        topMessage = r.message;
        render(session.getState());
        error.focus();
      }
    }
  }

  for (const name of ['leave', 'delete']) {
    const parts = ask[name];
    parts.button.addEventListener('click', () => {
      if (name === 'leave' ? session.askLeave() : session.askDelete()) parts.no.focus();
    });
    parts.no.addEventListener('click', () => {
      session.cancel();
      parts.button.focus();
    });
    parts.yes.addEventListener('click', () => void confirm('top'));
  }
  membersMore.addEventListener('click', () => void session.moreMembers());
  invMore.addEventListener('click', () => void session.moreInvitations());
  refresh.addEventListener('click', () => void session.refresh());

  session.subscribe(render);
  render(session.getState());

  return Object.freeze({
    session,
    /** The circle screen has been shown for `id`; `self` is the signed-in person's user id. */
    show(id, self) {
      populated = null;
      message = '';
      invMessage = '';
      topMessage = '';
      for (const form of [rename, invite]) clear(form);
      rename.fields.name.input.value = '';
      rename.fields.description.input.value = '';
      invite.fields.username.input.value = '';
      void session.open(id, self);
    },
    /** Signed out, or off this screen: forget everything. */
    reset() {
      populated = null;
      message = '';
      invMessage = '';
      topMessage = '';
      for (const form of [rename, invite]) clear(form);
      rename.fields.name.input.value = '';
      rename.fields.description.input.value = '';
      invite.fields.username.input.value = '';
      session.reset();
    },
  });
}
