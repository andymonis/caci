// The everyday app's chat (R-016): a thread of messages in memory, an update field that files a note and a question field that
// asks CaCi. Pure logic over the notes client; the page only draws what this says.
//
// - **Send**: the note is checked, then (if the person may capture into a circle) CaCi asks "is this for you or a circle?" in the
//   thread; the answer picks the scope. The note is then proposed AND approved in one go (no preview, no Undo, D5) and the thread
//   says which brain it was recorded against, the facts recorded and any fact replaced (D6). Any problem, refusal or failure
//   records nothing, says why in the service's words, and rejects the proposal so no place is held.
// - **Ask**: `POST /api/status` as it is: it reads every brain the person can read. The answer comes with where each point came from.
// - One request at a time. The thread is in memory only: `reset()` (sign-out, leaving) clears it and drops late answers.
// - Nothing is written to the browser; nothing the person or CaCi wrote is treated as anything but text.

import { withWait } from './capture-view.js';
import { sourcesText, STATUS_NOTHING } from './status-view.js';
import { browserTimeZone } from './status-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const NOT_READY = Object.freeze({ ok: false, kind: 'mode-unknown', message: 'Wait until CaCi has said which model it uses.' });
const CHOOSE = Object.freeze({ ok: false, kind: 'choose', message: 'Choose where the last update goes first.' });
const PERSONAL = Object.freeze({ kind: 'personal' });

export const WHO_QUESTION = 'Is this for you or a circle?';
export const RECORDED_PERSONAL = 'Recorded against your brain';
export const recordedCircle = (name) => `Recorded against the circle "${typeof name === 'string' && name !== '' ? name : 'this circle'}"`;

export function createChatSession({ notes, onSignedOut, timeZone = browserTimeZone }) {
  for (const m of ['mode', 'scopes', 'propose', 'approve', 'reject', 'status']) if (!notes || typeof notes[m] !== 'function') throw new TypeError(`createChatSession needs a notes client with ${m}()`);
  let epoch = 0;
  let busy = false;
  let counter = 0;
  let mode = { status: 'unknown', value: null, error: null };
  let messages = [];
  let pending = null; // { text, choices } while CaCi waits to hear whose brain a note is for
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      mode: Object.freeze({ ...mode }),
      messages: Object.freeze([...messages]),
      busy,
      choosing: pending !== null,
      canSend: mode.status === 'known' && !busy && pending === null,
    });
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
  function say(from, kind, text, extra = {}) {
    messages.push(Object.freeze({ id: ++counter, from, kind, text, lines: Object.freeze(extra.lines ?? []), ...(extra.choices === undefined ? {} : { choices: Object.freeze(extra.choices.map((c) => Object.freeze({ ...c }))) }) }));
  }
  function signedOut(error) {
    if (error.kind !== 'signed-out' || typeof onSignedOut !== 'function') return;
    try {
      onSignedOut();
    } catch {
      // ignored
    }
  }
  const words = (error) => withWait(error.message, error.retryAfterSeconds);

  /** Runs one request: `body()` returns a promise; anything late after a reset is dropped. */
  async function exclusive(body) {
    busy = true;
    const mine = epoch;
    notify();
    try {
      const r = await body(mine);
      return mine === epoch ? r : DROPPED;
    } catch {
      if (mine !== epoch) return DROPPED;
      say('cacci', 'error', 'Something went wrong on the service. Try again in a moment.');
      return Object.freeze({ ok: false, kind: 'server', message: 'Something went wrong on the service. Try again in a moment.' });
    } finally {
      if (mine === epoch) busy = false;
      notify();
    }
  }

  /** The note is checked by the notes client's own rules (1 to 8,000 characters after trimming). */
  const noteProblem = (text) => {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t === '') return 'Type an update first.';
    if ([...t].length > 8000) return 'An update is at most 8,000 characters.';
    return undefined;
  };

  async function file(text, scope, mine, label) {
    const made = await notes.propose(text, scope.kind === 'personal' ? undefined : { kind: 'circle', circleId: scope.circleId });
    if (mine !== epoch) return DROPPED;
    if (!made.ok) {
      signedOut(made.error);
      say('cacci', 'error', `Not recorded: ${words(made.error)}`);
      return Object.freeze({ ok: false, kind: made.error.kind, message: made.error.message });
    }
    const proposal = made.value;
    if (proposal.summary.problems.length > 0) {
      await notes.reject(proposal.id);
      if (mine !== epoch) return DROPPED;
      say('cacci', 'error', 'Not recorded: the filing did not fit what is already there. Try again.');
      return Object.freeze({ ok: false, kind: 'refused', message: 'Not recorded' });
    }
    const done = await notes.approve(proposal.id);
    if (mine !== epoch) return DROPPED;
    if (!done.ok) {
      // a refused write keeps the proposal pending in the service; it is discarded so it holds no place
      if (done.error.kind !== 'not-found' && done.error.kind !== 'expired') await notes.reject(proposal.id);
      if (mine !== epoch) return DROPPED;
      signedOut(done.error);
      say('cacci', 'error', `Not recorded: ${words(done.error)}`);
      return Object.freeze({ ok: false, kind: done.error.kind, message: done.error.message });
    }
    const facts = proposal.summary.facts.map((f) => (f.summary === '' ? f.title : f.title === '' ? f.summary : `${f.title}: ${f.summary}`));
    const replaced = proposal.summary.removed.map((r) => `Replaced: ${r.summary === '' ? r.title : r.title === '' ? r.summary : `${r.title}: ${r.summary}`}`);
    say('cacci', 'recorded', label, { lines: [...facts, ...replaced] });
    return Object.freeze({ ok: true });
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Forget the thread, the model and anything half done (sign-out, or leaving). An answer still on its way is dropped. */
    reset() {
      epoch += 1;
      busy = false;
      pending = null;
      messages = [];
      mode = { status: 'unknown', value: null, error: null };
      notify();
    },
    /** Ask which model files notes and answers. Calling it again is the way to try after a failure. */
    async loadMode() {
      if (busy) return BUSY;
      mode = { status: 'loading', value: null, error: null };
      return exclusive(async (mine) => {
        const r = await notes.mode();
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          mode = { status: 'error', value: null, error: r.error.message };
          signedOut(r.error);
          return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
        }
        mode = { status: 'known', value: r.value.mode, error: null };
        return Object.freeze({ ok: true });
      });
    },
    /** An update from the person. Asks whose brain it is for when there is a choice. */
    async send(text) {
      if (busy) return BUSY;
      if (pending !== null) return CHOOSE;
      if (mode.status !== 'known') return NOT_READY;
      const problem = noteProblem(text);
      if (problem !== undefined) return Object.freeze({ ok: false, kind: 'invalid', message: problem });
      const note = text.trim();
      say('me', 'text', note);
      return exclusive(async (mine) => {
        const listed = await notes.scopes();
        if (mine !== epoch) return DROPPED;
        if (!listed.ok) {
          signedOut(listed.error);
          say('cacci', 'error', `Not recorded: ${words(listed.error)}`);
          return Object.freeze({ ok: false, kind: listed.error.kind, message: listed.error.message });
        }
        const places = listed.value.items.filter((s) => s.canCapture === true && s.scope.kind === 'circle');
        if (places.length === 0) return file(note, PERSONAL, mine, RECORDED_PERSONAL);
        const choices = [{ key: 'personal', label: 'Me' }, ...places.map((s) => ({ key: `circle:${s.scope.circleId}`, label: s.scope.circleName })), { key: 'cancel', label: 'Cancel' }];
        pending = { text: note, places: new Map(places.map((s) => [`circle:${s.scope.circleId}`, s.scope])), choices };
        say('cacci', 'choice', WHO_QUESTION, { choices });
        return Object.freeze({ ok: true, asked: true });
      });
    },
    /** The answer to "for you or a circle?": a key from the choices, or `cancel`. */
    async choose(key) {
      if (busy) return BUSY;
      if (pending === null || !pending.choices.some((c) => c.key === key)) return Object.freeze({ ok: false, kind: 'invalid', message: 'There is nothing to choose.' });
      const { text, places, choices } = pending;
      const label = choices.find((c) => c.key === key).label;
      pending = null;
      say('me', 'text', label);
      if (key === 'cancel') {
        say('cacci', 'text', 'Not recorded.');
        notify();
        return Object.freeze({ ok: true, cancelled: true });
      }
      return exclusive(async (mine) => {
        if (key === 'personal') return file(text, PERSONAL, mine, RECORDED_PERSONAL);
        const scope = places.get(key);
        return file(text, { kind: 'circle', circleId: scope.circleId }, mine, recordedCircle(scope.circleName));
      });
    },
    /** A question from the person. */
    async ask(text) {
      if (busy) return BUSY;
      if (pending !== null) return CHOOSE;
      if (mode.status !== 'known') return NOT_READY;
      const t = typeof text === 'string' ? text.trim() : '';
      if (t === '') return Object.freeze({ ok: false, kind: 'invalid', message: 'Type a question first.' });
      if ([...t].length > 500) return Object.freeze({ ok: false, kind: 'invalid', message: 'A question is at most 500 characters.' });
      say('me', 'text', t);
      return exclusive(async (mine) => {
        const r = await notes.status(t, timeZone());
        if (mine !== epoch) return DROPPED;
        if (!r.ok) {
          signedOut(r.error);
          say('cacci', 'error', words(r.error));
          return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
        }
        const a = r.value;
        const lines = a.nothing || a.points.length === 0 ? [STATUS_NOTHING] : a.points.map((p) => `${p.text}${sourcesText(p.sources) === '' ? '' : ` (${sourcesText(p.sources)})`}`);
        say('cacci', 'answer', a.headline, { lines });
        return Object.freeze({ ok: true });
      });
    },
  });
}
