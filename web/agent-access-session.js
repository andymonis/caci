// What the Agent access part of Settings does (R-022): list the person's access keys, make one (shown once), stop one (asks first).
// Pure logic over the keys client; the circles to choose from are handed to `open` (the page already knows them from the navigation, so
// Settings asks for nothing twice). The page only draws this.
//
// - Nothing is requested until `open()`. A service with agent access switched off says `unavailable`, and then the page shows nothing.
// - One request at a time; a second call meanwhile sends nothing (`busy`).
// - A new key lives in memory only, in `created`, until the person dismisses it or leaves: it is never listed, kept or sent again.
// - Early checks only help; the service decides.

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const ERROR = 'Something went wrong on the service. Try again in a moment.';

export function createAgentAccessSession({ client, onSignedOut }) {
  if (!client || typeof client.list !== 'function' || typeof client.create !== 'function' || typeof client.revoke !== 'function') throw new TypeError('createAgentAccessSession needs an agent tokens client');
  let epoch = 0;
  let busy = false;
  let status = 'idle'; // idle | loading | unavailable | ready | error
  let items = [];
  let choices = [{ key: 'personal', label: 'My own notes' }];
  let created; // { token, name }, in memory only
  let asking; // the id of the key a question is about
  let error = '';
  let notice = '';
  const listeners = new Set();
  const snapshot = () => Object.freeze({ status, items: Object.freeze([...items]), choices: Object.freeze([...choices]), created, asking, busy, error, notice });
  function notify() {
    const view = snapshot();
    for (const l of [...listeners]) {
      try {
        l(view);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }
  function signedOut(e) {
    if (e?.kind !== 'signed-out' || typeof onSignedOut !== 'function') return;
    try {
      onSignedOut();
    } catch {
      // ignored
    }
  }

  async function load(mine, circles) {
    if (circles !== undefined) choices = [{ key: 'personal', label: 'My own notes' }, ...circles.map((c) => ({ key: `circle:${c.circleId}`, label: `Circle "${c.circleName}"` }))];
    const list = await client.list();
    if (mine !== epoch) return { ok: false, kind: 'dropped' };
    if (!list.ok) {
      signedOut(list.error);
      if (list.error.kind === 'unavailable') status = 'unavailable';
      else {
        status = status === 'ready' ? 'ready' : 'error';
        error = list.error.message;
      }
      return { ok: false, kind: list.error.kind };
    }
    items = [...list.value.items];
    status = 'ready';
    return { ok: true };
  }

  async function run(body) {
    if (busy) return BUSY;
    const mine = epoch;
    busy = true;
    error = '';
    notice = '';
    notify();
    try {
      return await body(mine);
    } catch {
      if (mine === epoch) error = ERROR;
      return Object.freeze({ ok: false, kind: 'server', message: ERROR });
    } finally {
      if (mine === epoch) busy = false;
      notify();
    }
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Loads the keys, and takes the circles to choose from (`[{ circleId, circleName }]`) as the page last knew them. Called each time Settings is shown. */
    open(circles) {
      if (status === 'unavailable') return Promise.resolve(Object.freeze({ ok: false, kind: 'unavailable' }));
      return run(async (mine) => {
        if (status === 'idle') status = 'loading';
        const r = await load(mine, circles);
        return Object.freeze(r);
      });
    },
    /** Makes a key. `input` is `{ name, scopes, checks, days }`. On success `created` holds the key until `dismissCreated`. */
    create(input) {
      return run(async (mine) => {
        const made = await client.create(input);
        if (mine !== epoch) return Object.freeze({ ok: false, kind: 'dropped' });
        if (!made.ok) {
          signedOut(made.error);
          if (made.error.kind === 'unavailable') status = 'unavailable';
          error = made.error.message;
          return Object.freeze({ ok: false, kind: made.error.kind, message: made.error.message, ...(made.error.field === undefined ? {} : { errors: Object.freeze({ [made.error.field]: made.error.message }) }) });
        }
        created = Object.freeze({ token: made.value.token, name: made.value.agentToken.name });
        notice = `Made the key "${made.value.agentToken.name}". Copy it now: it is shown only this once.`;
        await load(mine);
        return Object.freeze({ ok: true });
      });
    },
    /** Forgets the new key's text. */
    dismissCreated() {
      created = undefined;
      notice = '';
      notify();
    },
    /** Starts the question "stop this key?" (nothing is sent). */
    askRevoke(id) {
      if (busy || !items.some((i) => i.id === id)) return false;
      asking = id;
      notify();
      return true;
    },
    cancel() {
      if (asking === undefined) return;
      asking = undefined;
      notify();
    },
    /** Stops the key the question was about. The question closes whatever the answer. */
    confirmRevoke() {
      const id = asking;
      if (id === undefined) return Promise.resolve(Object.freeze({ ok: false, kind: 'nothing-asked' }));
      return run(async (mine) => {
        const name = items.find((i) => i.id === id)?.name;
        asking = undefined;
        const r = await client.revoke(id);
        if (mine !== epoch) return Object.freeze({ ok: false, kind: 'dropped' });
        if (!r.ok && r.error.kind !== 'not-found') {
          signedOut(r.error);
          error = r.error.message;
          return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
        }
        notice = name === undefined ? 'That access key is stopped.' : `Stopped "${name}": it can no longer read anything.`;
        await load(mine);
        return Object.freeze({ ok: true });
      });
    },
    /** Forgets everything, the new key included, and drops answers still on their way. */
    reset() {
      epoch++;
      busy = false;
      status = 'idle';
      items = [];
      choices = [{ key: 'personal', label: 'My own notes' }];
      created = undefined;
      asking = undefined;
      error = '';
      notice = '';
      notify();
    },
  });
}
