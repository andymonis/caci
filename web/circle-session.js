// What one circle's screen shows and does (R-006): the circle, its roster, for owners and managers its open
// invitations, and managing it. Pure logic over the circles client; the page only draws what this says.
//
// - One request at a time; an answer for a circle that is no longer open is dropped.
// - The person's own role is whatever the service last said (`circle.role`), so a demotion shows on the next
//   load; the buttons come from `permissions.js` and are a hint only. A refusal for lack of rights is shown in
//   the service's words and the whole view is refreshed.
// - Every action reloads what it changed. A view is as old as its last load.
// - Delete, remove and leave are two steps: ask (the state says what is being asked), then confirm or cancel.
// - Inviting never says whether the account exists: the notice names the username and nothing more.

import { checkCircle, failed } from './circles-session.js';
import { circleControls, personControls, rolesToOffer } from './permissions.js';

const PAGE = 50;
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const GONE_WORDS = 'No such circle, or you are not in it.';
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const SIGNED_OUT = Object.freeze({ ok: false, kind: 'signed-out', message: 'Your session has ended. Sign in again.' });

/** Early feedback for the invite form; the service is the authority and may say more. */
export function checkInvite(input, allowedRoles) {
  const errors = {};
  const raw = input && typeof input === 'object' ? input : {};
  const username = typeof raw.username === 'string' ? raw.username.trim().toLowerCase() : '';
  if (username === '') errors.username = 'Enter the username to invite.';
  else if (!USERNAME.test(username)) errors.username = 'A username is 3 to 32 characters: letters, digits, ".", "_" and "-".';
  if (typeof raw.role !== 'string' || !allowedRoles.includes(raw.role)) errors.role = 'Choose a role you may give.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { username, role: raw.role } };
}

const emptyMembers = () => ({ items: [], nextCursor: null, error: null });
const emptyInvitations = () => ({ visible: false, items: [], nextCursor: null, error: null });

export function createCircleSession({ client, onSignedOut }) {
  if (!client || typeof client.getCircle !== 'function') throw new TypeError('createCircleSession needs a circles client');
  let epoch = 0;
  let busy = false;
  let circleId = null;
  let selfId = null;
  let status = 'idle'; // idle | loading | loaded | gone | error | deleted | left
  let message = null;
  let circle = null;
  let members = emptyMembers();
  let invitations = emptyInvitations();
  let confirm = null;
  const listeners = new Set();

  const myRole = () => (circle === null ? undefined : circle.role);

  const snapshot = () => {
    const role = myRole();
    return Object.freeze({
      circleId,
      status,
      message,
      circle,
      controls: circleControls(role),
      rolesToOffer: Object.freeze(rolesToOffer(role)),
      members: Object.freeze({
        items: Object.freeze(members.items.map((m) => Object.freeze({ ...m, self: m.userId === selfId, controls: personControls(role, m.role, m.userId === selfId) }))),
        nextCursor: members.nextCursor,
        error: members.error,
      }),
      invitations: Object.freeze({ visible: invitations.visible, items: Object.freeze([...invitations.items]), nextCursor: invitations.nextCursor, error: invitations.error }),
      confirm,
      busy,
    });
  };

  function notify() {
    const view = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  async function exclusive(work) {
    if (busy) return BUSY;
    busy = true;
    const mine = epoch;
    notify();
    try {
      const result = await work(mine);
      if (result.kind === 'signed-out' && typeof onSignedOut === 'function') {
        try {
          onSignedOut();
        } catch {
          // ignored
        }
      }
      return result;
    } finally {
      if (mine === epoch) busy = false;
      notify();
    }
  }

  const mineStill = (mine) => mine === epoch;

  /** Loads the circle itself. A circle that cannot be found is `gone`, with the same words whatever the reason. */
  async function loadCircle(mine) {
    const r = await client.getCircle(circleId);
    if (!mineStill(mine)) return SIGNED_OUT;
    if (!r.ok) {
      if (r.error.kind === 'not-found') {
        status = 'gone';
        message = GONE_WORDS;
        circle = null;
        members = emptyMembers();
        invitations = emptyInvitations();
        confirm = null;
      } else if (r.error.kind !== 'signed-out') {
        status = circle === null ? 'error' : status;
        message = r.error.message;
      }
      return failed(r.error);
    }
    circle = r.value;
    status = 'loaded';
    message = null;
    if (!circleControls(circle.role).invite) invitations = emptyInvitations();
    return { ok: true };
  }

  async function loadMembers(mine, cursor) {
    const r = await client.listMembers(circleId, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (!mineStill(mine)) return SIGNED_OUT;
    if (!r.ok) {
      members = { ...members, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    members = { items: cursor === undefined ? [...r.value.items] : [...members.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  async function loadInvitations(mine, cursor) {
    if (circle === null || !circleControls(circle.role).invite) {
      invitations = emptyInvitations();
      return { ok: true };
    }
    const r = await client.listInvitations(circleId, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (!mineStill(mine)) return SIGNED_OUT;
    if (!r.ok) {
      invitations = { ...invitations, visible: true, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    invitations = { visible: true, items: cursor === undefined ? [...r.value.items] : [...invitations.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null };
    return { ok: true };
  }

  /** Reloads the circle, then its roster, then (for owners and managers) its invitations. Stops at a circle that has gone. */
  async function loadAll(mine) {
    const c = await loadCircle(mine);
    if (!c.ok) return c;
    const m = await loadMembers(mine);
    if (m.kind === 'signed-out') return m;
    const i = await loadInvitations(mine);
    if (i.kind === 'signed-out') return i;
    return { ok: true, ...(m.ok && i.ok ? {} : { listProblem: (m.ok ? i : m).message }) };
  }

  /** What to do after a refusal: for lack of rights, or about a person or invitation who has gone, show the service's words and bring the view up to date. */
  async function afterRefusal(mine, r, what) {
    const result = failed(r.error);
    if (r.error.kind === 'forbidden') {
      await loadAll(mine);
    } else if (r.error.kind === 'not-found' && r.error.what === 'circle') {
      await loadCircle(mine);
    } else if (r.error.kind === 'not-found' && what === 'member') {
      await loadMembers(mine);
      await loadCircle(mine);
    } else if (r.error.kind === 'not-found' && what === 'invitation') {
      await loadInvitations(mine);
    }
    return result;
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Forget everything (sign-out or leaving the screen). Answers still on their way are dropped. */
    reset() {
      epoch += 1;
      busy = false;
      circleId = null;
      selfId = null;
      status = 'idle';
      message = null;
      circle = null;
      members = emptyMembers();
      invitations = emptyInvitations();
      confirm = null;
      notify();
    },

    /** Show a circle: its details, roster and (for owners and managers) open invitations. `self` is the signed-in person's user id. */
    open(id, self) {
      epoch += 1;
      busy = false;
      circleId = id;
      selfId = typeof self === 'string' ? self : null;
      status = 'loading';
      message = null;
      circle = null;
      members = emptyMembers();
      invitations = emptyInvitations();
      confirm = null;
      return exclusive((mine) => loadAll(mine));
    },
    /** Reload everything for the open circle (a refusal that shows the view was stale does this by itself). */
    refresh: () => (circleId === null ? Promise.resolve(BUSY) : exclusive((mine) => loadAll(mine))),
    moreMembers: () => exclusive((mine) => (members.nextCursor === null ? Promise.resolve({ ok: true }) : loadMembers(mine, members.nextCursor))),
    moreInvitations: () => exclusive((mine) => (invitations.nextCursor === null ? Promise.resolve({ ok: true }) : loadInvitations(mine, invitations.nextCursor))),

    /** Rename and describe; an empty description removes it. The new values are the service's answer. */
    update(input) {
      const checked = checkCircle(input);
      if (!checked.ok) return Promise.resolve({ ok: false, kind: 'invalid', errors: checked.errors });
      return exclusive(async (mine) => {
        const r = await client.updateCircle(circleId, { name: checked.value.name, description: checked.value.description === undefined ? null : checked.value.description });
        if (!mineStill(mine)) return SIGNED_OUT;
        if (!r.ok) {
          const result = await afterRefusal(mine, r, 'circle');
          return r.error.field === undefined ? result : { ...result, errors: { [r.error.field]: r.error.message } };
        }
        circle = r.value;
        return { ok: true };
      });
    },

    /** Invite by username and role. The notice never says whether the account exists. */
    invite(input) {
      const checked = checkInvite(input, rolesToOffer(myRole()));
      if (!checked.ok) return Promise.resolve({ ok: false, kind: 'invalid', errors: checked.errors });
      return exclusive(async (mine) => {
        const r = await client.invite(circleId, checked.value);
        if (!mineStill(mine)) return SIGNED_OUT;
        if (!r.ok) {
          const result = await afterRefusal(mine, r, 'circle');
          return r.error.field === undefined ? result : { ...result, errors: { [r.error.field]: r.error.message } };
        }
        const again = await loadInvitations(mine);
        return { ok: true, notice: `Invitation recorded for "${checked.value.username}".`, ...(again.ok ? {} : { listProblem: again.message }) };
      });
    },

    withdraw: (invitationId) =>
      exclusive(async (mine) => {
        const r = await client.withdrawInvitation(circleId, invitationId);
        if (!mineStill(mine)) return SIGNED_OUT;
        if (!r.ok) return afterRefusal(mine, r, 'invitation');
        const again = await loadInvitations(mine);
        return again.ok ? { ok: true } : { ok: true, listProblem: again.message };
      }),

    changeRole: (userId, role) =>
      exclusive(async (mine) => {
        const r = await client.changeRole(circleId, userId, role);
        if (!mineStill(mine)) return SIGNED_OUT;
        if (!r.ok) return afterRefusal(mine, r, 'member');
        const again = await loadMembers(mine);
        return again.ok ? { ok: true } : { ok: true, listProblem: again.message };
      }),

    /** Ask before removing someone, leaving or deleting; nothing is sent until `confirmAction`. */
    askRemove(userId) {
      if (busy || circle === null) return false;
      confirm = Object.freeze({ action: 'remove', userId });
      notify();
      return true;
    },
    askLeave() {
      if (busy || circle === null) return false;
      confirm = Object.freeze({ action: 'leave' });
      notify();
      return true;
    },
    askDelete() {
      if (busy || circle === null) return false;
      confirm = Object.freeze({ action: 'delete' });
      notify();
      return true;
    },
    cancel() {
      if (confirm === null) return;
      confirm = null;
      notify();
    },

    /** Do what was asked. The question is closed whatever the answer; on delete or leave success the page goes to the list. */
    confirmAction() {
      if (confirm === null) return Promise.resolve({ ok: false, kind: 'nothing-asked', message: 'There is nothing to confirm.' });
      const asked = confirm;
      return exclusive(async (mine) => {
        confirm = null;
        if (asked.action === 'remove') {
          const r = await client.removeMember(circleId, asked.userId);
          if (!mineStill(mine)) return SIGNED_OUT;
          if (!r.ok) return afterRefusal(mine, r, 'member');
          const m = await loadMembers(mine);
          await loadCircle(mine);
          return m.ok ? { ok: true } : { ok: true, listProblem: m.message };
        }
        const r = asked.action === 'delete' ? await client.deleteCircle(circleId) : await client.leaveCircle(circleId);
        if (!mineStill(mine)) return SIGNED_OUT;
        if (!r.ok) return afterRefusal(mine, r, 'circle');
        status = asked.action === 'delete' ? 'deleted' : 'left';
        circle = null;
        members = emptyMembers();
        invitations = emptyInvitations();
        return { ok: true, goTo: 'list' };
      });
    },
  });
}
