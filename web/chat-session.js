// The everyday app's chat (R-016): a thread of messages in memory, an update field that files a note and a question field that
// asks CaCi. Pure logic over the notes client; the page only draws what this says.
//
// - **Home** (no `circle` given): **Send** records the note against the person's own brain (R-016 D16, no question), **Ask** is
//   `POST /api/status` reading every brain the person can read, with where each point came from.
// - **A circle's screen** (`circle` given: its id, name and whether the person may add to it): **Send** records the note against
//   that circle's brain (a read-only circle refuses it, the service decides in the end) and **Pulse** asks for a status of that
//   circle only, with the predefined text the service holds (D18 to D21). There is no question field there.
// - A note is proposed AND approved in one go (no preview, no Undo, D5) and the thread says which brain it was recorded against,
//   the facts recorded and any fact replaced (D6). Any problem, refusal or failure records nothing, says why in the service's
//   words, and rejects the proposal so no place is held.
// - One request at a time. The thread is in memory only: `reset()` (sign-out, leaving) clears it and drops late answers.
// - **Verbs** (R-025): text beginning with `/` is a command and is never filed or asked (D17): `/pay 2` applies the verb `pay` to the
//   fact behind point 2 of the last answer, `/pay` alone to a one-point answer, `/pay 2.1` to the first of several facts a point cites.
//   The page keeps the answer's fact references in memory only (they go with the answer) and the server never parses a number.
// - Nothing is written to the browser; nothing the person or CaCi wrote is treated as anything but text.

import { formatTime, withWait } from './capture-view.js';
import { CHECK_LABELS } from './notes-client.js';
import { sourcesText, STATUS_NOTHING } from './status-view.js';
import { browserTimeZone } from './status-session.js';

const BUSY = Object.freeze({ ok: false, kind: 'busy', message: 'Please wait: the last request is still being sent.' });
const DROPPED = Object.freeze({ ok: false, kind: 'dropped', message: '' });
const NOT_READY = Object.freeze({ ok: false, kind: 'mode-unknown', message: 'Wait until CaCi has said which model it uses.' });
const READ_ONLY = Object.freeze({ ok: false, kind: 'read-only', message: 'You can read this circle but not add to it.' });
const PERSONAL = Object.freeze({ kind: 'personal' });

export const RECORDED_PERSONAL = 'Recorded against your brain';
export const recordedCircle = (name) => `Recorded against the circle "${typeof name === 'string' && name !== '' ? name : 'this circle'}"`;

export const PULSE_LABEL = 'Pulse';

/** The thread's words for where a fact came from (R-017): who, when, the exact words, and whether it was replaced later. */
export function sourceLines(source) {
  const who = source.enteredBy === undefined ? 'someone who has since left' : source.enteredBy.displayName === '' ? source.enteredBy.username : source.enteredBy.displayName;
  const when = source.at === undefined ? '' : formatTime(source.at);
  const lines = [];
  if (source.words !== undefined) lines.push(`Entered by ${who}${when === '' ? '' : ` on ${when}`}: "${source.words}"`);
  else if (source.at !== undefined || source.enteredBy !== undefined) lines.push(`Entered by ${who}${when === '' ? '' : ` on ${when}`}.`);
  if (source.words === undefined && source.note !== undefined) lines.push(source.note);
  else if (source.words === undefined && source.at === undefined && source.enteredBy === undefined) lines.push(SOURCE_NOT_KEPT);
  if (source.replacedLater) lines.push('This fact was replaced later.');
  return lines;
}
export const SOURCE_NOT_KEPT = 'The words behind this fact are not kept: it was entered before they were recorded, or the change log no longer holds them.';

/** The slash that starts a command, written as an escape so it is not mistaken for a request path by the guard that lists them. */
const SLASH = '\u002f';
const COMMAND = /^\/([a-z0-9-]{1,20})(?:\s+(\d{1,3})(?:\.(\d{1,2}))?)?$/;
export const NO_VERBS = 'Verbs are not available here.';
export const NOT_A_COMMAND = 'That is not a command I know. Use a verb and the number of a point in the last answer, for example /pay 2.';
export const NO_ANSWER = 'There is no answer to apply that to. Ask or press a check first.';

export function createChatSession({ notes, ledger, facts, onSignedOut, timeZone = browserTimeZone, circle }) {
  for (const m of ['mode', 'propose', 'approve', 'reject', 'status', ...(circle === undefined ? [] : ['pulse'])]) if (!notes || typeof notes[m] !== 'function') throw new TypeError(`createChatSession needs a notes client with ${m}()`);
  let epoch = 0;
  let busy = false;
  let counter = 0;
  let mode = { status: 'unknown', value: null, error: null };
  let messages = [];
  let verbs = { status: 'unknown', items: Object.freeze([]) };
  /** Points already dealt with, as `messageId:lineIndex:factIndex`: in memory with the answer, gone with it. */
  const resolved = new Set();
  const place = circle === undefined ? undefined : Object.freeze({ circleId: circle.circleId, circleName: circle.circleName, canCapture: circle.canCapture === true });
  const listeners = new Set();

  const snapshot = () =>
    Object.freeze({
      mode: Object.freeze({ ...mode }),
      messages: Object.freeze([...messages]),
      verbs: Object.freeze({ status: verbs.status, items: verbs.items }),
      resolved: Object.freeze([...resolved]),
      busy,
      circle: place,
      canSend: mode.status === 'known' && !busy && (place === undefined || place.canCapture),
      canAsk: mode.status === 'known' && !busy,
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
    messages.push(Object.freeze({ id: ++counter, from, kind, text, lines: Object.freeze(extra.lines ?? []), lineFacts: Object.freeze((extra.lineFacts ?? []).map((f) => Object.freeze([...f]))) }));
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

  /** Puts a status answer (or its failure) in the thread. */
  function present(r, mine, focused = false) {
    if (mine !== epoch) return DROPPED;
    if (!r.ok) {
      signedOut(r.error);
      say('cacci', 'error', words(r.error));
      return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
    }
    const a = r.value;
    const empty = a.nothing || a.points.length === 0;
    // a focused check that finds nothing is silent: its headline is the whole answer (R-018 D1)
    const lines = empty ? (focused ? [] : [STATUS_NOTHING]) : a.points.map((p) => `${p.text}${sourcesText(p.sources) === '' ? '' : ` (${sourcesText(p.sources)})`}`);
    const lineFacts = empty ? (focused ? [] : [[]]) : a.points.map((p) => (Array.isArray(p.facts) ? p.facts : []));
    say('cacci', 'answer', a.headline, { lines, lineFacts });
    return Object.freeze({ ok: true });
  }

  const isCommand = (text) => typeof text === 'string' && text.trimStart().startsWith(SLASH);
  const invalid = (message) => Object.freeze({ ok: false, kind: 'invalid', message });
  const unknownVerb = (name) => `There is no verb "${name}". The verbs are: ${verbs.items.map((v) => `${SLASH}${v.name}`).join(', ')}.`;

  async function ensureVerbs() {
    if (verbs.status === 'known') return true;
    if (facts === undefined || typeof facts.verbs !== 'function') return false;
    const r = await facts.verbs();
    if (!r.ok) return false; // the vocabulary is only for the buttons: a failure here ends nothing, the next real request finds a sign-out
    verbs = { status: 'known', items: Object.freeze(r.value.items.map((v) => Object.freeze({ ...v }))) };
    return true;
  }

  /** Applies one verb to one fact of one line of an answer in the thread, and says what was done. */
  async function apply(verb, messageId, lineIndex, factIndex, label) {
    const message = messages.find((m) => m.id === messageId);
    const fact = message?.lineFacts[lineIndex]?.[factIndex];
    if (fact === undefined) return invalid('There is nothing for that verb to apply to.');
    return exclusive(async (mine) => {
      const r = await facts.resolve(fact, verb.name);
      if (mine !== epoch) return DROPPED;
      if (!r.ok) {
        signedOut(r.error);
        say('cacci', 'error', words(r.error));
        return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
      }
      resolved.add(`${messageId}:${lineIndex}:${factIndex}`);
      const done = r.value.result === 'deleted' ? 'the fact was removed' : 'it will stay out of your checks';
      say('cacci', 'resolved', `${verb.help.replace(/\.$/, '')}: done for point ${label}; ${done}.`);
      return Object.freeze({ ok: true, result: r.value.result });
    });
  }

  /** A line of text starting with `/`: never filed, never asked. Says in the thread what it did, or why it did nothing. */
  async function command(text) {
    const typed = text.trim();
    say('me', 'text', typed);
    const parsed = COMMAND.exec(typed);
    if (parsed === null) {
      say('cacci', 'error', NOT_A_COMMAND);
      return invalid(NOT_A_COMMAND);
    }
    if (!(await ensureVerbs())) {
      say('cacci', 'error', NO_VERBS);
      return invalid(NO_VERBS);
    }
    const verb = verbs.items.find((v) => v.name === parsed[1]);
    if (verb === undefined) {
      const m = unknownVerb(parsed[1]);
      say('cacci', 'error', m);
      return invalid(m);
    }
    const answer = [...messages].reverse().find((m) => m.kind === 'answer');
    if (answer === undefined) {
      say('cacci', 'error', NO_ANSWER);
      return invalid(NO_ANSWER);
    }
    const withFacts = answer.lineFacts.map((f, i) => (f.length > 0 ? i : -1)).filter((i) => i >= 0);
    let line;
    if (parsed[2] === undefined) {
      if (withFacts.length !== 1) {
        const m = withFacts.length === 0 ? 'Nothing in the last answer has a fact behind it.' : `The last answer has ${withFacts.length} points: say which, for example /${verb.name} ${withFacts[0] + 1}.`;
        say('cacci', 'error', m);
        return invalid(m);
      }
      line = withFacts[0];
    } else {
      line = Number(parsed[2]) - 1;
      if (line < 0 || line >= answer.lineFacts.length) {
        const m = `There is no point ${parsed[2]} in the last answer.`;
        say('cacci', 'error', m);
        return invalid(m);
      }
      if (answer.lineFacts[line].length === 0) {
        const m = `Point ${parsed[2]} has no fact behind it.`;
        say('cacci', 'error', m);
        return invalid(m);
      }
    }
    const behind = answer.lineFacts[line];
    let factIndex;
    if (parsed[3] === undefined) {
      if (behind.length > 1) {
        const m = `Point ${line + 1} cites ${behind.length} facts: say which, from /${verb.name} ${line + 1}.1 to /${verb.name} ${line + 1}.${behind.length}.`;
        say('cacci', 'error', m);
        return invalid(m);
      }
      factIndex = 0;
    } else {
      factIndex = Number(parsed[3]) - 1;
      if (factIndex < 0 || factIndex >= behind.length) {
        const m = `Point ${line + 1} does not cite a fact numbered ${parsed[3]}.`;
        say('cacci', 'error', m);
        return invalid(m);
      }
    }
    return apply(verb, answer.id, line, factIndex, behind.length > 1 ? `${line + 1}.${factIndex + 1}` : String(line + 1));
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
      messages = [];
      resolved.clear();
      verbs = { status: 'unknown', items: Object.freeze([]) };
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
    /** An update from the person: recorded against their own brain on Home, or against this circle's brain on a circle's screen. */
    async send(text) {
      if (busy) return BUSY;
      if (isCommand(text)) return exclusive(() => command(text));
      if (mode.status !== 'known') return NOT_READY;
      if (place !== undefined && !place.canCapture) return READ_ONLY;
      const problem = noteProblem(text);
      if (problem !== undefined) return Object.freeze({ ok: false, kind: 'invalid', message: problem });
      const note = text.trim();
      say('me', 'text', note);
      return exclusive((mine) => (place === undefined ? file(note, PERSONAL, mine, RECORDED_PERSONAL) : file(note, { kind: 'circle', circleId: place.circleId }, mine, recordedCircle(place.circleName))));
    },
    /** A question from the person (Home only: a circle's screen has the Pulse instead). */
    async ask(text) {
      if (busy) return BUSY;
      if (isCommand(text)) return exclusive(() => command(text));
      if (place !== undefined) return Object.freeze({ ok: false, kind: 'invalid', message: 'Use the Pulse button here.' });
      if (mode.status !== 'known') return NOT_READY;
      const t = typeof text === 'string' ? text.trim() : '';
      if (t === '') return Object.freeze({ ok: false, kind: 'invalid', message: 'Type a question first.' });
      if ([...t].length > 500) return Object.freeze({ ok: false, kind: 'invalid', message: 'A question is at most 500 characters.' });
      say('me', 'text', t);
      return exclusive(async (mine) => present(await notes.status(t, timeZone()), mine));
    },
    /** Asks the service for the vocabulary of verbs (once; a second call is free). The buttons are drawn from it. */
    async loadVerbs() {
      if (busy) return BUSY;
      return exclusive(async (mine) => {
        const ok = await ensureVerbs();
        return mine !== epoch ? DROPPED : ok ? Object.freeze({ ok: true }) : invalid(NO_VERBS);
      });
    },
    /** Applies a verb (by name) to one fact of one line of an answer: what a button does. The same path as `/verb N`. */
    async applyVerb(verbName, messageId, lineIndex, factIndex = 0) {
      if (busy) return BUSY;
      const verb = verbs.items.find((v) => v.name === verbName);
      if (verb === undefined || facts === undefined) return invalid(NO_VERBS);
      const label = (messages.find((m) => m.id === messageId)?.lineFacts[lineIndex]?.length ?? 0) > 1 ? `${lineIndex + 1}.${factIndex + 1}` : String(lineIndex + 1);
      return apply(verb, messageId, lineIndex, factIndex, label);
    },
    /** Whether the fact behind one line of an answer has been dealt with in this thread. */
    isResolved(messageId, lineIndex, factIndex = 0) {
      return resolved.has(`${messageId}:${lineIndex}:${factIndex}`);
    },
    /** Whether a line of an answer has facts behind it that can be traced. */
    canShowSource(messageId, lineIndex) {
      if (ledger === undefined || typeof ledger.source !== 'function') return false;
      const m = messages.find((x) => x.id === messageId);
      return m !== undefined && m.kind === 'answer' && Number.isInteger(lineIndex) && (m.lineFacts[lineIndex]?.length ?? 0) > 0;
    },
    /** Adds to the thread who entered the facts behind one line of an answer, when, and their words (R-017). */
    async showSource(messageId, lineIndex) {
      if (busy) return BUSY;
      if (!this.canShowSource(messageId, lineIndex)) return Object.freeze({ ok: false, kind: 'invalid', message: 'There is nothing to trace for that line.' });
      const facts = messages.find((x) => x.id === messageId).lineFacts[lineIndex];
      return exclusive(async (mine) => {
        const blocks = [];
        for (const f of facts) {
          const r = await ledger.source(f.scope, f.id);
          if (mine !== epoch) return DROPPED;
          if (!r.ok) {
            signedOut(r.error);
            say('cacci', 'error', words(r.error));
            return Object.freeze({ ok: false, kind: r.error.kind, message: r.error.message });
          }
          const fact = r.value.fact;
          const title = [fact.title, fact.summary].filter((x) => typeof x === 'string' && x !== '').join(': ');
          blocks.push(...(blocks.length > 0 || facts.length > 1 ? [title === '' ? 'A fact' : title] : []), ...sourceLines(r.value));
        }
        say('cacci', 'source', 'The source of this fact', { lines: blocks });
        return Object.freeze({ ok: true });
      });
    },
    /**
     * One of the three checks (R-018): `pulse`, `coming-up` or `long-range`. On a circle's screen it looks at that circle, on Home at
     * every brain the person can read. The service holds the words and works out the window; a silent answer is one line.
     */
    async check(name) {
      if (busy) return BUSY;
      if (typeof name !== 'string' || !Object.hasOwn(CHECK_LABELS, name) || typeof notes.check !== 'function') return Object.freeze({ ok: false, kind: 'invalid', message: 'Choose Pulse, Coming up or Long range.' });
      if (mode.status !== 'known') return NOT_READY;
      say('me', 'text', CHECK_LABELS[name]);
      return exclusive(async (mine) => present(await notes.check(name, place === undefined ? undefined : { kind: 'circle', circleId: place.circleId }, timeZone()), mine, true));
    },
    /** The Pulse (a circle's screen only): a status of this circle alone, with the predefined text the service holds. */
    async pulse() {
      if (busy) return BUSY;
      if (place === undefined) return Object.freeze({ ok: false, kind: 'invalid', message: 'The Pulse is on a circle\'s screen.' });
      if (mode.status !== 'known') return NOT_READY;
      say('me', 'text', PULSE_LABEL);
      return exclusive(async (mine) => present(await notes.pulse({ kind: 'circle', circleId: place.circleId }, timeZone()), mine, true));
    },
  });
}
