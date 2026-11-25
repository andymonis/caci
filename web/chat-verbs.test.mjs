import { describe, expect, it } from 'vitest';
import { createChatSession, NO_ANSWER, NO_VERBS, NOT_A_COMMAND } from './chat-session.js';
import { world } from './sharing-world.test-util.mjs';

// R-025 VR-FR-11 and VR-FR-12: a line starting with `/` is a command, never a note and never a question; `/verb N` maps the Nth point to
// the fact references held for that answer.

const C1 = 'c0123456789abcdef';
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const VERBS = [{ name: 'clear', effect: 'clear', help: 'Clear this for me.' }, { name: 'pay', effect: 'clear', help: 'Mark this as paid.' }, { name: 'remove', effect: 'remove', help: 'Remove this fact for everyone.' }];
const FACT_A = { scope: { kind: 'circle', circleId: C1 }, id: 'yoga-1' };
const FACT_B = { scope: { kind: 'circle', circleId: C1 }, id: 'bins-1' };
const FACT_C = { scope: { kind: 'personal' }, id: 'note-9' };
const ANSWER = (points) => okv({ headline: 'This week.', nothing: false, points: points.map((facts, i) => ({ text: `Point ${i + 1}`, sources: [{ kind: 'personal' }], facts })) });

function fake({ points = [[FACT_A], [FACT_B, FACT_C], []], resolve, verbs } = {}) {
  const calls = [];
  const rec = (name, fn) => (...a) => (calls.push([name, ...a]), Promise.resolve(fn(...a)));
  const notes = {
    mode: rec('mode', () => okv({ mode: 'demo' })),
    propose: rec('propose', () => okv({ id: 'p', summary: { newItems: [], facts: [], removed: [], problems: [], notes: [] } })),
    approve: rec('approve', () => okv({ id: 'p', applied: 1 })),
    reject: rec('reject', () => okv(true)),
    status: rec('status', () => ANSWER(points)),
    check: rec('check', () => ANSWER(points)),
    pulse: rec('pulse', () => ANSWER(points)),
  };
  const facts = {
    verbs: rec('verbs', verbs ?? (() => okv({ items: VERBS }))),
    resolve: rec('resolve', resolve ?? ((fact, verb) => okv({ fact, verb, effect: verb === 'remove' ? 'remove' : 'clear', result: verb === 'remove' || fact.scope.kind === 'personal' ? 'deleted' : 'hidden' }))),
  };
  return { calls, notes, facts };
}
const names = (f) => f.calls.map((c) => c[0]);
const make = async (over = {}, options = {}) => {
  const f = fake(over);
  const s = createChatSession({ notes: f.notes, facts: f.facts, timeZone: () => 'UTC', ...options });
  await s.loadMode();
  return { ...f, s };
};
const lastText = (s) => s.getState().messages.at(-1).text;

describe('a line starting with a slash is never a note or a question', () => {
  it('on Home, through Send and through Ask: nothing is proposed, approved or asked', async () => {
    const { s, calls } = await make();
    await s.ask('What is on?');
    const before = calls.length;
    for (const text of ['/pay 1', '/nonsense', '/', '  /clear 2.1', '/PAY 1', '/pay one']) {
      for (const how of ['send', 'ask']) await s[how](text);
    }
    const notesCalls = calls.slice(before).map((c) => c[0]);
    for (const banned of ['propose', 'approve', 'status', 'check', 'pulse']) expect(notesCalls).not.toContain(banned);
  });

  it('on a circle screen too, and it works before the model is known', async () => {
    const f = fake();
    const s = createChatSession({ notes: f.notes, facts: f.facts, circle: { circleId: C1, circleName: 'Yoga', canCapture: true } });
    await s.send('/pay 1');
    expect(names(f)).not.toContain('propose');
    expect(lastText(s)).toBe(NO_ANSWER);
  });

  it('the typed command is in the thread as the person\'s own words, and the reply follows', async () => {
    const { s } = await make();
    await s.ask('What is on?');
    await s.send('/pay 1');
    const msgs = s.getState().messages;
    expect(msgs.at(-2)).toMatchObject({ from: 'me', kind: 'text', text: '/pay 1' });
    expect(msgs.at(-1)).toMatchObject({ from: 'cacci', kind: 'resolved' });
  });
});

describe('mapping a number to a fact', () => {
  it('/pay 1 applies the verb to the fact of point 1 of the last answer, by its exact reference', async () => {
    const { s, calls } = await make();
    await s.ask('What is on?');
    const r = await s.send('/pay 1');
    expect(r).toEqual({ ok: true, result: 'hidden' });
    expect(calls.filter((c) => c[0] === 'resolve')).toEqual([['resolve', FACT_A, 'pay']]);
    expect(lastText(s)).toBe('Mark this as paid: done for point 1; it will stay out of your checks.');
    expect(s.isResolved(s.getState().messages.find((m) => m.kind === 'answer').id, 0)).toBe(true);
    expect(s.getState().resolved).toHaveLength(1);
  });

  it('uses the last answer: a later one replaces the numbering', async () => {
    const { s, calls } = await make();
    await s.ask('first');
    await s.ask('second');
    await s.send('/clear 1');
    expect(calls.filter((c) => c[0] === 'resolve')).toHaveLength(1);
    const answers = s.getState().messages.filter((m) => m.kind === 'answer');
    expect(s.isResolved(answers[1].id, 0)).toBe(true);
    expect(s.isResolved(answers[0].id, 0)).toBe(false);
  });

  it('/verb alone applies to the only point that has a fact; with several it asks which', async () => {
    const one = await make({ points: [[], [FACT_A], []] });
    await one.s.ask('x');
    expect(await one.s.send('/pay')).toMatchObject({ ok: true });
    expect(one.calls.find((c) => c[0] === 'resolve')[1]).toEqual(FACT_A);
    const many = await make();
    await many.s.ask('x');
    expect(await many.s.send('/pay')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(lastText(many.s)).toBe('The last answer has 2 points: say which, for example /pay 1.');
    expect(names(many)).not.toContain('resolve');
    const none = await make({ points: [[], []] });
    await none.s.ask('x');
    await none.s.send('/pay');
    expect(lastText(none.s)).toBe('Nothing in the last answer has a fact behind it.');
  });

  it('a point citing several facts asks which, and N.M picks one', async () => {
    const { s, calls } = await make();
    await s.ask('x');
    expect(await s.send('/pay 2')).toMatchObject({ ok: false });
    expect(lastText(s)).toBe('Point 2 cites 2 facts: say which, from /pay 2.1 to /pay 2.2.');
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
    expect(await s.send('/pay 2.2')).toMatchObject({ ok: true, result: 'deleted' });
    expect(calls.find((c) => c[0] === 'resolve')).toEqual(['resolve', FACT_C, 'pay']);
    expect(lastText(s)).toBe('Mark this as paid: done for point 2.2; the fact was removed.');
    const answer = s.getState().messages.find((m) => m.kind === 'answer');
    expect(s.isResolved(answer.id, 1, 1)).toBe(true);
    expect(s.isResolved(answer.id, 1, 0)).toBe(false);
  });

  it('a number that is not a point, a point without a fact, or a fact number that is not there says why and sends nothing', async () => {
    const { s, calls } = await make();
    await s.ask('x');
    for (const [text, said] of [['/pay 9', 'There is no point 9 in the last answer.'], ['/pay 0', 'There is no point 0 in the last answer.'], ['/pay 3', 'Point 3 has no fact behind it.'], ['/pay 1.2', 'Point 1 does not cite a fact numbered 2.'], ['/pay 2.0', 'Point 2 does not cite a fact numbered 0.']]) {
      await s.send(text);
      expect(lastText(s), text).toBe(said);
    }
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('nothing in the thread to apply it to is said plainly', async () => {
    const { s, calls } = await make();
    await s.send('/pay 1');
    expect(lastText(s)).toBe(NO_ANSWER);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });
});

describe('what is not a command', () => {
  it('an unknown verb lists the known ones; a malformed command says how to write one', async () => {
    const { s, calls } = await make();
    await s.ask('x');
    await s.send('/dance 1');
    expect(lastText(s)).toBe('There is no verb "dance". The verbs are: /clear, /pay, /remove.');
    for (const text of ['/', '/pay one', '/PAY 1', '/pay 1 2', '/pay 1.2.3', '/pay -1', '/pay 1000', '/' + 'a'.repeat(21)]) {
      await s.send(text);
      expect(lastText(s), text).toBe(NOT_A_COMMAND);
    }
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('a verb vocabulary that cannot be had is said, and nothing is sent', async () => {
    const { s, calls } = await make({ verbs: () => bad('server', 'down') });
    await s.ask('x');
    expect(await s.send('/pay 1')).toMatchObject({ ok: false });
    expect(lastText(s)).toBe(NO_VERBS);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
    const f = fake();
    const bare = createChatSession({ notes: f.notes, timeZone: () => 'UTC' });
    await bare.loadMode();
    await bare.ask('x');
    await bare.send('/pay 1');
    expect(bare.getState().messages.at(-1).text).toBe(NO_VERBS);
  });

  it('the vocabulary is asked for once', async () => {
    const { s, calls } = await make();
    await s.ask('x');
    await s.send('/pay 1');
    await s.send('/clear 1');
    await s.loadVerbs();
    expect(calls.filter((c) => c[0] === 'verbs')).toHaveLength(1);
    expect(s.getState().verbs).toMatchObject({ status: 'known' });
    expect(s.getState().verbs.items.map((v) => v.name)).toEqual(['clear', 'pay', 'remove']);
  });
});

describe('what the service says back', () => {
  it('a fact that has gone says to ask again, and marks nothing as done', async () => {
    const { s } = await make({ resolve: () => bad('not-found', 'That fact is no longer there. Ask again for a fresh answer.') });
    await s.ask('x');
    const r = await s.send('/pay 1');
    expect(r).toMatchObject({ ok: false, kind: 'not-found' });
    expect(lastText(s)).toBe('That fact is no longer there. Ask again for a fresh answer.');
    expect(s.getState().resolved).toEqual([]);
  });

  it('an owner-only verb refused is said in the service\'s fixed words; a signed-out answer calls the hook', async () => {
    let out = 0;
    const { s } = await make({ resolve: () => bad('forbidden', 'Only the owner can remove a fact for everyone.') }, { onSignedOut: () => out++ });
    await s.ask('x');
    await s.send('/remove 1');
    expect(lastText(s)).toBe('Only the owner can remove a fact for everyone.');
    const second = await make({ resolve: () => bad('signed-out', 'Your session has ended. Sign in again.') }, { onSignedOut: () => out++ });
    await second.s.ask('x');
    await second.s.send('/pay 1');
    expect(out).toBe(1);
  });

  it('a request that throws is a plain server message, and the session still works', async () => {
    let n = 0;
    const { s } = await make({ resolve: (fact, verb) => { if (++n === 1) throw new Error('boom'); return okv({ fact, verb, effect: 'clear', result: 'hidden' }); } });
    await s.ask('x');
    expect(await s.send('/pay 1')).toMatchObject({ ok: false, kind: 'server' });
    expect(await s.send('/pay 1')).toMatchObject({ ok: true });
  });
});

describe('buttons use the same path, and everything goes with the answer', () => {
  it('applyVerb does what the command does, for a named verb, line and fact', async () => {
    const { s, calls } = await make();
    await s.ask('x');
    await s.loadVerbs();
    const id = s.getState().messages.find((m) => m.kind === 'answer').id;
    expect(await s.applyVerb('pay', id, 0)).toEqual({ ok: true, result: 'hidden' });
    expect(calls.filter((c) => c[0] === 'resolve')).toEqual([['resolve', FACT_A, 'pay']]);
    expect(await s.applyVerb('pay', id, 1, 1)).toMatchObject({ ok: true });
    expect(s.getState().messages.at(-1).text).toContain('done for point 2.2');
    expect(await s.applyVerb('dance', id, 0)).toMatchObject({ ok: false });
    expect(await s.applyVerb('pay', id, 2)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await s.applyVerb('pay', 9999, 0)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(calls.filter((c) => c[0] === 'resolve')).toHaveLength(2);
  });

  it('reset forgets the thread, the references, what was done and the verbs, and a late answer is dropped', async () => {
    let release;
    const { s, calls } = await make({ resolve: (fact, verb) => new Promise((r) => (release = () => r(okv({ fact, verb, effect: 'clear', result: 'hidden' })))) });
    await s.ask('x');
    const pending = s.send('/pay 1');
    await new Promise((r) => setTimeout(r, 0));
    s.reset();
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'dropped' });
    expect(s.getState()).toMatchObject({ messages: [], resolved: [], verbs: { status: 'unknown' } });
    await s.loadMode();
    await s.send('/pay 1');
    expect(s.getState().messages.at(-1).text).toBe(NO_ANSWER);
    expect(calls.filter((c) => c[0] === 'resolve')).toHaveLength(1);
  });

  it('one request at a time: a command while another is out is refused', async () => {
    let release;
    const f = fake();
    f.notes.status = () => new Promise((r) => (release = () => r(ANSWER([[FACT_A]]))));
    const s = createChatSession({ notes: f.notes, facts: f.facts, timeZone: () => 'UTC' });
    await s.loadMode();
    const asking = s.ask('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.send('/pay 1')).toMatchObject({ ok: false, kind: 'busy' });
    release();
    await asking;
  });
});

describe('against the real service', () => {
  it('a pulse, then /pay 1, then the next pulse leaves the fact out, and a stranger cannot reach it', async () => {
    const w = await world();
    const made = await w.ann.notes.propose('Pay for this week yoga class by Friday MARK-YOGA', { kind: 'circle', circleId: w.circle });
    expect((await w.ann.notes.approve(made.value.id)).ok).toBe(true);
    const session = (who) => createChatSession({ notes: who.notes, facts: who.facts, circle: { circleId: w.circle, circleName: 'Club', canCapture: true } });
    const bob = session(w.bob);
    await bob.loadMode();
    await bob.pulse();
    const answer = bob.getState().messages.find((m) => m.kind === 'answer');
    expect(answer.lines.join(' ')).toContain('MARK-YOGA');
    expect(answer.lineFacts[0]).toHaveLength(1);
    expect(await bob.send('/pay 1')).toMatchObject({ ok: true, result: 'hidden' });
    await bob.pulse();
    const next = bob.getState().messages.filter((m) => m.kind === 'answer').at(-1);
    expect(next.lines.join(' ')).not.toContain('MARK-YOGA');
    const cat = session(w.cat);
    await cat.loadMode();
    await cat.pulse();
    expect(cat.getState().messages.find((m) => m.kind === 'answer').lines.join(' ')).toContain('MARK-YOGA');
    // a person outside the circle who somehow holds a reference gets the made-up-circle answer
    const dan = createChatSession({ notes: w.dan.notes, facts: w.dan.facts });
    await dan.loadMode();
    const stray = await w.dan.facts.resolve(answer.lineFacts[0][0], 'pay');
    expect(stray.error).toMatchObject({ kind: 'not-found', what: 'circle' });
    void dan;
  });
});
