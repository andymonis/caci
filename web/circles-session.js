// What the circles list, creating a circle and my invitations show (R-006). Pure logic over the circles
// client; the page only draws what this says.
//
// - Two areas, each with ONE request at a time: "circles" (the list, creating, leaving) and "invitations"
//   (the list, the count, accepting, declining). A second call while one is out sends nothing.
// - Views are as old as their last load. Every change reloads what it changed.
// - The invitation count is only ever a number the last answer gave: `items.length` of the answer, with
//   `atLeast` when there is more than the page. If the last attempt failed there is no number.
// - Nothing is stored anywhere; `reset()` forgets it all (sign-out) and an answer that arrives after a
//   reset is dropped.

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
const PAGE = 50;
const COUNT_PAGE = 100;

const length = (text) => [...text].length;
const hasControl = (text) => {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return true;
  }
  return false;
};

/** Early feedback for the create form; the service is the authority. */
export function checkCircle(input) {
  const errors = {};
  const raw = input && typeof input === 'object' ? input : {};
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') errors.name = 'Enter a name for the circle.';
  else if (length(name) > NAME_MAX) errors.name = `A circle name is at most ${NAME_MAX} characters.`;
  else if (hasControl(name)) errors.name = 'A circle name cannot contain control characters.';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (raw.description !== undefined && typeof raw.description !== 'string') errors.description = 'Please check the description.';
  else if (length(description) > DESCRIPTION_MAX) errors.description = `A description is at most ${DESCRIPTION_MAX} characters.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, ...(description === '' ? {} : { description }) } };
}

const emptyList = () => ({ status: 'idle', items: [], nextCursor: null, error: null, stale: false });
const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
export const failed = (error) => ({ ok: false, kind: error.kind, message: error.message, ...(error.what === undefined ? {} : { what: error.what }), ...(error.field === undefined ? {} : { field: error.field }), ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) });

export function createCirclesSession({ client, onSignedOut }) {
  if (!client || typeof client.listCircles !== 'function') throw new TypeError('createCirclesSession needs a circles client');
  let epoch = 0;
  let circles = emptyList();
  let invitations = { ...emptyList(), count: null, atLeast: false };
  const busy = { circles: false, invitations: false };
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      circles: Object.freeze({ ...circles, items: Object.freeze([...circles.items]) }),
      invitations: Object.freeze({ status: invitations.status, items: Object.freeze([...invitations.items]), nextCursor: invitations.nextCursor, error: invitations.error, count: invitations.count, atLeast: invitations.atLeast }),
      busy: Object.freeze({ ...busy }),
    });

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

  /** Runs `work` as the one request in flight in `area`; answers after a reset are dropped. */
  async function exclusive(area, work) {
    if (busy[area]) return BUSY;
    busy[area] = true;
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
      if (mine === epoch) busy[area] = false;
      notify();
    }
  }

  const stillMine = (mine) => mine === epoch;

  async function loadCircles(mine, cursor) {
    const r = await client.listCircles({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
    if (!r.ok) {
      circles = { ...circles, status: cursor === undefined ? 'error' : circles.status, error: r.error.message, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    circles = { status: 'loaded', items: cursor === undefined ? [...r.value.items] : [...circles.items, ...r.value.items], nextCursor: r.value.nextCursor, error: null, stale: false };
    return { ok: true };
  }

  async function loadInvitations(mine, cursor) {
    const r = await client.myInvitations({ limit: COUNT_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
    if (!r.ok) {
      // the last answer did not give a number, so none is shown
      invitations = { ...invitations, status: 'error', error: r.error.message, count: null, atLeast: false, ...(cursor === undefined ? { items: [], nextCursor: null } : {}) };
      return failed(r.error);
    }
    const items = cursor === undefined ? [...r.value.items] : [...invitations.items, ...r.value.items];
    invitations = { status: 'loaded', items, nextCursor: r.value.nextCursor, error: null, count: items.length, atLeast: r.value.nextCursor !== null };
    return { ok: true };
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Forget everything (sign-out). Answers still on their way are dropped. */
    reset() {
      epoch += 1;
      circles = emptyList();
      invitations = { ...emptyList(), count: null, atLeast: false };
      busy.circles = false;
      busy.invitations = false;
      notify();
    },

    /** (Re)load my circles from the start. */
    loadCircles: () => exclusive('circles', (mine) => loadCircles(mine)),
    /** "Show more": the next page, if there is one. */
    moreCircles: () => exclusive('circles', (mine) => (circles.nextCursor === null ? Promise.resolve({ ok: true }) : loadCircles(mine, circles.nextCursor))),

    /** Make a circle; on success the list is marked out of date and the new circle is returned for the page to go to. */
    createCircle: (input) => {
      const checked = checkCircle(input);
      if (!checked.ok) return Promise.resolve({ ok: false, kind: 'invalid', errors: checked.errors });
      return exclusive('circles', async (mine) => {
        const r = await client.createCircle(checked.value);
        if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
        if (!r.ok) return r.error.field === undefined ? failed(r.error) : { ...failed(r.error), errors: { [r.error.field]: r.error.message } };
        circles = { ...circles, stale: true };
        return { ok: true, circle: r.value };
      });
    },

    /** Leave a circle, then reload the list (also when the circle turned out to be gone). */
    leaveCircle: (circleId) =>
      exclusive('circles', async (mine) => {
        const r = await client.leaveCircle(circleId);
        if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
        if (!r.ok && r.error.kind !== 'not-found' && r.error.kind !== 'forbidden') return failed(r.error);
        const again = await loadCircles(mine);
        if (!r.ok) return failed(r.error);
        return again.ok ? { ok: true } : { ok: true, listProblem: again.message };
      }),

    /** The circle list is out of date (something changed it elsewhere on the page). */
    markCirclesStale() {
      circles = { ...circles, stale: true };
      notify();
    },

    /** Load my invitations, and with them the count. Calling it again is the Refresh button. */
    loadInvitations: () => exclusive('invitations', (mine) => loadInvitations(mine)),
    refreshCount: () => exclusive('invitations', (mine) => loadInvitations(mine)),
    moreInvitations: () => exclusive('invitations', (mine) => (invitations.nextCursor === null ? Promise.resolve({ ok: true }) : loadInvitations(mine, invitations.nextCursor))),

    /** Accept: on success the circle list is out of date, the invitations and count are reloaded, and the circle is returned. */
    acceptInvitation: (invitationId) =>
      exclusive('invitations', async (mine) => {
        const r = await client.acceptInvitation(invitationId);
        if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
        if (r.ok) circles = { ...circles, stale: true };
        else if (r.error.kind !== 'not-found' && r.error.kind !== 'limit') return failed(r.error);
        const again = await loadInvitations(mine);
        if (!r.ok) return failed(r.error);
        return { ok: true, circle: r.value, ...(again.ok ? {} : { listProblem: again.message }) };
      }),

    /** Decline: the row goes (the list is reloaded) and the count follows. */
    declineInvitation: (invitationId) =>
      exclusive('invitations', async (mine) => {
        const r = await client.declineInvitation(invitationId);
        if (!stillMine(mine)) return { ok: false, kind: 'signed-out', message: '' };
        if (!r.ok && r.error.kind !== 'not-found') return failed(r.error);
        const again = await loadInvitations(mine);
        if (!r.ok) return failed(r.error);
        return again.ok ? { ok: true } : { ok: true, listProblem: again.message };
      }),
  });
}
