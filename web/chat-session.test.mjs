import { describe, expect, it } from 'vitest';
import { createChatSession, PULSE_LABEL, RECORDED_PERSONAL, recordedCircle } from './chat-session.js';
import { world } from './sharing-world.test-util.mjs';

const C1 = 'c0123456789abcdef';
const okv = (value) => ({ ok: true, value });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });
const SUMMARY = (extra = {}) => ({ newItems: ['n1'], facts: [{ id: 'n1', title: 'Mum: phone', summary: '0770' }], removed: [], problems: [], notes: [], ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fakeNotes(over = {}) {
  const calls = [];
  const rec = (name, fn) => (...a) => (calls.push([name, ...a]), Promise.resolve(fn(...a)));
  return {
    calls,
    notes: {
      mode: rec('mode', () => okv({ mode: 'demo' })),
      propose: rec('propose', () => okv({ id: 'prop-1', summary: SUMMARY() })),
      approve: rec('approve', () => okv({ id: 'prop-1', applied: 3 })),
      reject: rec('reject', () => okv(true)),
      pulse: rec('pulse', () => okv({ headline: 'Circle is quiet.', nothing: false, points: [{ text: 'Bins on Thursday', sources: [{ kind: 'circle', circleId: C1, circleName: 'Parent care' }] }] })),
      status: rec('status', () => okv({ headline: 'A quiet day.', nothing: false, points: [{ text: 'Mum has new tablets.', sources: [{ kind: 'personal' }] }] })),
      ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, rec(k, v)])),
    },
  };
}
const CIRCLE = { circleId: C1, circleName: 'Parent care', canCapture: true };
const WATCH = { circleId: 'cabcdefghij012345', circleName: 'Read only', canCapture: false };
const make = async (over = {}, options = {}) => {
  const f = fakeNotes(over);
  const s = createChatSession({ notes: f.notes, timeZone: () => 'Europe/London', ...options });
  await s.loadMode();
  return { ...f, s };
};
const texts = (s) => s.getState().messages.map((m) => `${m.from}:${m.kind}:${m.text}`);
const names = (f) => f.calls.map((c) => c[0]);

describe('before anything is sent', () => {
  it('nothing can be sent or asked until the model is known, and no request is made', async () => {
    const f = fakeNotes();
    const s = createChatSession({ notes: f.notes });
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown' }, canSend: false, canAsk: false, messages: [] });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'mode-unknown' });
    expect(await s.ask('x')).toMatchObject({ ok: false, kind: 'mode-unknown' });
    expect(f.calls).toEqual([]);
    expect(await s.loadMode()).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ mode: { status: 'known', value: 'demo' }, canSend: true });
  });
  it('a mode that cannot be read says so and can be tried again', async () => {
    let n = 0;
    const { s } = await make({ mode: () => (++n === 1 ? bad('server', 'down') : okv({ mode: 'anthropic' })) });
    expect(s.getState().mode).toEqual({ status: 'error', value: null, error: 'down' });
    await s.loadMode();
    expect(s.getState().mode).toMatchObject({ status: 'known', value: 'anthropic' });
  });
  it('construction needs a full notes client', () => {
    expect(() => createChatSession({})).toThrow(TypeError);
    expect(() => createChatSession({ notes: { mode() {} } })).toThrow(TypeError);
  });
});

describe('sending an update', () => {
  it('with only your own brain it files straight away: proposes, approves, and says what was recorded', async () => {
    const { s, calls } = await make();
    expect(await s.send('  Mum phone 0770  ')).toEqual({ ok: true });
    expect(calls.map((c) => c[0])).toEqual(['mode', 'propose', 'approve']);
    expect(calls[1]).toEqual(['propose', 'Mum phone 0770', undefined]);
    expect(texts(s)).toEqual(['me:text:Mum phone 0770', `cacci:recorded:${RECORDED_PERSONAL}`]);
    expect(s.getState().messages[1].lines).toEqual(['Mum: phone: 0770']);
    expect(s.getState()).toMatchObject({ busy: false, canSend: true, canAsk: true });
  });
  it('lists every fact, and each fact replaced', async () => {
    const summary = SUMMARY({ facts: [{ id: 'a', title: 'Dad: ward', summary: 'ward C' }, { id: 'b', title: '', summary: 'only a summary' }, { id: 'c', title: 'only a title', summary: '' }], removed: [{ id: 'o', title: 'Dad: ward', summary: 'ward B' }, { id: 'p', title: 'old', summary: '' }] });
    const { s } = await make({ propose: () => okv({ id: 'p1', summary }) });
    await s.send('Dad moved to ward C');
    expect(s.getState().messages.at(-1).lines).toEqual(['Dad: ward: ward C', 'only a summary', 'only a title', 'Replaced: Dad: ward: ward B', 'Replaced: old']);
  });
  it('a blank update is refused beside the field and sends nothing; an update over 8,000 characters too', async () => {
    const { s, calls } = await make();
    expect(await s.send('   ')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await s.send('x'.repeat(8001))).toMatchObject({ ok: false, kind: 'invalid' });
    expect(names({ calls })).toEqual(['mode']);
    expect(s.getState().messages).toEqual([]);
    expect(await s.send('😀'.repeat(8000))).toMatchObject({ ok: true });
  });
});

describe('on a circle\'s screen', () => {
  const inCircle = (over = {}, circle = CIRCLE) => make(over, { circle });
  it('Send records against that circle, sending only its kind and id, and says its name', async () => {
    const { s, calls } = await inCircle();
    expect(await s.send('Bins on Thursday')).toEqual({ ok: true });
    expect(calls.map((c) => c[0])).toEqual(['mode', 'propose', 'approve']);
    expect(calls.find((c) => c[0] === 'propose')).toEqual(['propose', 'Bins on Thursday', { kind: 'circle', circleId: C1 }]);
    expect(texts(s)).toEqual(['me:text:Bins on Thursday', `cacci:recorded:${recordedCircle('Parent care')}`]);
    expect(recordedCircle('Parent care')).toBe('Recorded against the circle "Parent care"');
    expect(recordedCircle('')).toBe('Recorded against the circle "this circle"');
    expect(s.getState().circle).toEqual(CIRCLE);
  });
  it('a read-only circle refuses Send and sends nothing, but the Pulse still works', async () => {
    const { s, calls } = await inCircle({}, WATCH);
    expect(s.getState()).toMatchObject({ canSend: false, canAsk: true });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'read-only' });
    expect(names({ calls })).toEqual(['mode']);
    expect(await s.pulse()).toEqual({ ok: true });
  });
  it('the Pulse shows a Pulse message and the circle\'s answer with its sources, sending the circle and the time zone, not words', async () => {
    const { s, calls } = await inCircle();
    expect(await s.pulse()).toEqual({ ok: true });
    expect(calls.find((c) => c[0] === 'pulse')).toEqual(['pulse', { kind: 'circle', circleId: C1 }, 'Europe/London']);
    expect(PULSE_LABEL).toBe('Pulse');
    expect(texts(s)).toEqual(['me:text:Pulse', 'cacci:answer:Circle is quiet.']);
    expect(s.getState().messages.at(-1).lines).toEqual(['Bins on Thursday (From: "Parent care")']);
    expect(names({ calls })).not.toContain('status');
  });
  it('a pulse with nothing relevant, a limit or a missing circle is said in words', async () => {
    const quiet = await inCircle({ pulse: () => okv({ headline: 'Nothing.', nothing: true, points: [] }) });
    await quiet.s.pulse();
    expect(quiet.s.getState().messages.at(-1).lines).toEqual(['Nothing relevant was found in what you can read.']);
    const limited = await inCircle({ pulse: () => bad('limit', 'Too many.', { retryAfterSeconds: 60 }) });
    expect(await limited.s.pulse()).toMatchObject({ ok: false, kind: 'limit' });
    expect(texts(limited.s).at(-1)).toBe('cacci:error:Too many. Try again in 60 seconds.');
    const gone = await inCircle({ pulse: () => bad('not-found', 'No such circle, or you are not in it.') });
    await gone.s.pulse();
    expect(texts(gone.s).at(-1)).toBe('cacci:error:No such circle, or you are not in it.');
  });
  it('there is no question here, and Home has no Pulse', async () => {
    const circle = await inCircle();
    expect(await circle.s.ask('why')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(names(circle)).toEqual(['mode']);
    const home = await make();
    expect(await home.s.pulse()).toMatchObject({ ok: false, kind: 'invalid' });
    expect(names(home)).toEqual(['mode']);
    expect(home.s.getState().circle).toBeUndefined();
  });
  it('nothing can be pulsed or sent before the model is known, and a circle client needs pulse()', async () => {
    const f = fakeNotes();
    const s = createChatSession({ notes: f.notes, circle: CIRCLE });
    expect(await s.pulse()).toMatchObject({ kind: 'mode-unknown' });
    expect(await s.send('x')).toMatchObject({ kind: 'mode-unknown' });
    expect(f.calls).toEqual([]);
    const without = { ...f.notes };
    delete without.pulse;
    expect(() => createChatSession({ notes: without, circle: CIRCLE })).toThrow(TypeError);
    expect(() => createChatSession({ notes: without })).not.toThrow();
  });
  it('a circle name is only text, and a signed-out pulse is reported', async () => {
    let told = 0;
    const { s } = await make({ pulse: () => bad('signed-out', 'ended') }, { circle: { ...CIRCLE, circleName: '<b>Parent</b>' }, onSignedOut: () => told++ });
    await s.send('x');
    expect(texts(s).at(-1)).toBe('cacci:recorded:Recorded against the circle "<b>Parent</b>"');
    await s.pulse();
    expect(told).toBe(1);
  });
});

describe('when filing does not work, nothing is kept', () => {
  it('a model failure says why, with the wait, and nothing is approved', async () => {
    const { s, calls } = await make({ propose: () => bad('model', 'The model is busy.', { retryAfterSeconds: 30 }) });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'model' });
    expect(names({ calls })).toEqual(['mode', 'propose']);
    expect(texts(s).at(-1)).toBe('cacci:error:Not recorded: The model is busy. Try again in 30 seconds.');
  });
  it('a proposal with problems is rejected, not approved', async () => {
    const { s, calls } = await make({ propose: () => okv({ id: 'p9', summary: SUMMARY({ problems: ['a link would fail'] }) }) });
    expect(await s.send('x')).toMatchObject({ ok: false });
    expect(calls.filter((c) => c[0] === 'approve')).toEqual([]);
    expect(calls.find((c) => c[0] === 'reject')).toEqual(['reject', 'p9']);
    expect(texts(s).at(-1)).toContain('Not recorded');
    expect(texts(s).at(-1)).not.toContain('a link would fail');
  });
  it('a refused write is rejected so it holds no place, and the service\'s words are shown', async () => {
    const { s, calls } = await make({ approve: () => bad('refused', 'This proposal can no longer be applied.') });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'refused' });
    expect(calls.find((c) => c[0] === 'reject')).toEqual(['reject', 'prop-1']);
    expect(texts(s).at(-1)).toBe('cacci:error:Not recorded: This proposal can no longer be applied.');
    expect(s.getState()).toMatchObject({ busy: false, canSend: true });
  });
  it('a proposal that is already gone or expired is not rejected again', async () => {
    for (const kind of ['not-found', 'expired']) {
      const { s, calls } = await make({ approve: () => bad(kind, 'gone') });
      await s.send('x');
      expect(calls.filter((c) => c[0] === 'reject'), kind).toEqual([]);
    }
  });
  it('a client that throws is a fixed failure and the thread says so', async () => {
    const { s } = await make({ propose: () => { throw new Error('boom'); } });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'server' });
    expect(texts(s).at(-1)).toBe('cacci:error:Something went wrong on the service. Try again in a moment.');
    expect(s.getState().busy).toBe(false);
  });
  it('a signed-out answer is reported', async () => {
    let told = 0;
    const { s } = await make({ propose: () => bad('signed-out', 'ended') }, { onSignedOut: () => told++ });
    await s.send('x');
    expect(told).toBe(1);
    const t = await make({ propose: () => bad('signed-out') }, { onSignedOut: () => { throw new Error('x'); } });
    await expect(t.s.send('x')).resolves.toMatchObject({ ok: false });
  });
});

describe('asking a question', () => {
  it('shows the answer with where each point came from, and sends the browser time zone', async () => {
    const { s, calls } = await make({ status: () => okv({ headline: 'Morning', nothing: false, points: [{ text: 'Bins are Thursday', sources: [{ kind: 'circle', circleId: C1, circleName: 'Parent care' }] }, { text: 'Mum has tablets', sources: [{ kind: 'personal' }] }, { text: 'No source', sources: [] }] }) });
    expect(await s.ask('  What is on?  ')).toEqual({ ok: true });
    expect(calls.find((c) => c[0] === 'status')).toEqual(['status', 'What is on?', 'Europe/London']);
    const a = s.getState().messages.at(-1);
    expect(a).toMatchObject({ from: 'cacci', kind: 'answer', text: 'Morning' });
    expect(a.lines).toEqual(['Bins are Thursday (From: "Parent care")', 'Mum has tablets (From: your own notes)', 'No source']);
    expect(texts(s)[0]).toBe('me:text:What is on?');
  });
  it('says nothing relevant was found, in the usual words', async () => {
    const { s } = await make({ status: () => okv({ headline: 'Nothing.', nothing: true, points: [] }) });
    await s.ask('x');
    expect(s.getState().messages.at(-1).lines).toEqual(['Nothing relevant was found in what you can read.']);
  });
  it('a blank or over-long question sends nothing; a failure or limit is shown with the wait', async () => {
    const { s, calls } = await make({ status: () => bad('limit', 'Too many questions.', { retryAfterSeconds: 60 }) });
    expect(await s.ask(' ')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await s.ask('x'.repeat(501))).toMatchObject({ ok: false, kind: 'invalid' });
    expect(calls.filter((c) => c[0] === 'status')).toEqual([]);
    expect(await s.ask('fine')).toMatchObject({ ok: false, kind: 'limit' });
    expect(texts(s).at(-1)).toBe('cacci:error:Too many questions. Try again in 60 seconds.');
  });
  it('asking files nothing', async () => {
    const { s, calls } = await make();
    await s.ask('q');
    expect(names({ calls })).toEqual(['mode', 'status']);
  });
});

describe('one request at a time, and forgetting', () => {
  it('a second send, ask, pulse or mode request meanwhile sends nothing', async () => {
    const d = deferred();
    const { s, calls } = await make({ propose: () => d.promise });
    const first = s.send('x');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState()).toMatchObject({ busy: true, canSend: false, canAsk: false });
    expect(await s.send('y')).toMatchObject({ kind: 'busy' });
    expect(await s.ask('y')).toMatchObject({ kind: 'busy' });
    expect(await s.loadMode()).toMatchObject({ kind: 'busy' });
    expect(calls.filter((c) => c[0] === 'propose')).toHaveLength(1);
    d.resolve(okv({ id: 'p', summary: SUMMARY() }));
    await first;
    expect(s.getState().busy).toBe(false);
  });
  it('reset clears the thread and the model, and drops an answer still on its way', async () => {
    const d = deferred();
    const { s } = await make({ status: () => d.promise });
    const pendingAsk = s.ask('q');
    await new Promise((r) => setTimeout(r, 0));
    s.reset();
    d.resolve(okv({ headline: 'late', nothing: false, points: [] }));
    expect(await pendingAsk).toMatchObject({ kind: 'dropped' });
    expect(s.getState()).toMatchObject({ messages: [], busy: false, mode: { status: 'unknown' } });
  });
  it('an old request finishing after a reset does not clear a newer request\'s busy mark', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const queue = [d1, d2];
    const { s } = await make({ status: () => queue.shift().promise });
    const old = s.ask('one');
    await new Promise((r) => setTimeout(r, 0));
    s.reset();
    await s.loadMode();
    const fresh = s.ask('two');
    await new Promise((r) => setTimeout(r, 0));
    d1.resolve(okv({ headline: 'old', nothing: false, points: [] }));
    await old;
    expect(s.getState().busy).toBe(true);
    d2.resolve(okv({ headline: 'new', nothing: false, points: [] }));
    await fresh;
    expect(texts(s).filter((t) => t.includes('old'))).toEqual([]);
    expect(texts(s).at(-1)).toBe('cacci:answer:new');
  });
  it('listeners hear every change; a broken one does not matter; unsubscribing works; messages are frozen with increasing ids', async () => {
    const { s } = await make();
    const seen = [];
    const un = s.subscribe((v) => seen.push(v.messages.length));
    s.subscribe(() => { throw new Error('x'); });
    await s.ask('q');
    expect(seen.length).toBeGreaterThan(1);
    un();
    const n = seen.length;
    await s.ask('q2');
    expect(seen).toHaveLength(n);
    const m = s.getState().messages;
    expect(Object.isFrozen(m) && Object.isFrozen(m[0]) && Object.isFrozen(m[0].lines)).toBe(true);
    expect(m.map((x) => x.id)).toEqual([...m.map((x) => x.id)].sort((a, b) => a - b));
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);
  });
});

describe('against the real service (demo model)', () => {
  const real = async (who) => {
    const s = createChatSession({ notes: who.notes });
    await s.loadMode();
    return s;
  };
  it('a profile note to your own brain, then a change that replaces only one fact, then a question', async () => {
    const w = await world();
    const solo = await real(w.dan);
    expect(await solo.send('Mum: born 4 June 1950, phone 07700 900123, email mum@example.test.')).toEqual({ ok: true });
    const first = solo.getState().messages.at(-1);
    expect(first.text).toBe(RECORDED_PERSONAL);
    expect(first.lines).toHaveLength(3);
    expect(await solo.send("Mum's new phone number: 07700 900456.")).toEqual({ ok: true });
    const second = solo.getState().messages.at(-1);
    expect(second.lines.some((l) => l.startsWith('Replaced:') && l.includes('900123'))).toBe(true);
    await solo.ask('What is happening?');
    const answer = solo.getState().messages.at(-1);
    expect(answer.kind).toBe('answer');
    expect(answer.lines.join(' ')).toContain('900456');
    expect(answer.lines.join(' ')).not.toContain('900123');
  });
  it('on Home a note always goes to the own brain, even for a person in a circle', async () => {
    const w = await world();
    const ann = await real(w.ann);
    expect(await ann.send('Bin collection moved to Thursday')).toEqual({ ok: true });
    expect(ann.getState().messages.at(-1).text).toBe(RECORDED_PERSONAL);
    const own = await w.ann.notes.categoriesIn({ kind: 'personal' });
    expect(own.value.items.length).toBeGreaterThan(0);
    const inCircle = await w.bob.notes.categoriesIn({ kind: 'circle', circleId: w.circle });
    expect(inCircle.value.items).toEqual([]);
  });
  it('on a circle\'s screen a note lands in that circle and another member can read it; the own brain is untouched', async () => {
    const w = await world();
    const ann = createChatSession({ notes: w.ann.notes, circle: { circleId: w.circle, circleName: 'Club', canCapture: true } });
    await ann.loadMode();
    const ownBefore = (await w.ann.notes.categoriesIn({ kind: 'personal' })).value.items.length;
    expect(await ann.send('Bin collection moved to Thursday')).toEqual({ ok: true });
    expect(ann.getState().messages.at(-1).text).toBe('Recorded against the circle "Club"');
    expect((await w.bob.notes.categoriesIn({ kind: 'circle', circleId: w.circle })).value.items.length).toBeGreaterThan(0);
    expect((await w.ann.notes.categoriesIn({ kind: 'personal' })).value.items.length).toBe(ownBefore);
  });
  it('an observer is refused by the page logic and by the service; the Pulse reads only that circle', async () => {
    const w = await world();
    await w.ann.notes.propose('Dentist appointment on Friday morning').then((m) => w.ann.notes.approve(m.value.id));
    const m = await w.ann.notes.propose('Club bins go out on Thursday', { kind: 'circle', circleId: w.circle });
    await w.ann.notes.approve(m.value.id);
    const bob = createChatSession({ notes: w.bob.notes, circle: { circleId: w.circle, circleName: 'Club', canCapture: false } });
    await bob.loadMode();
    expect(await bob.send('x')).toMatchObject({ kind: 'read-only' });
    expect(await bob.pulse()).toEqual({ ok: true });
    const answer = bob.getState().messages.at(-1);
    expect(answer.lines.join(' ')).toContain('Club bins');
    expect(answer.lines.join(' ')).not.toContain('Dentist');
    expect(answer.lines.every((l) => l.includes('Club') || l.startsWith('Nothing'))).toBe(true);
  });
  it('a stranger\'s pulse of the circle is the one not-found, in words', async () => {
    const w = await world();
    const dan = createChatSession({ notes: w.dan.notes, circle: { circleId: w.circle, circleName: 'Club', canCapture: true } });
    await dan.loadMode();
    expect(await dan.pulse()).toMatchObject({ ok: false, kind: 'not-found' });
    expect(dan.getState().messages.at(-1).text).toBe('No such circle, or you are not in it.');
  });
  it('markup in a note comes back as text', async () => {
    const w = await world();
    const ann = await real(w.ann);
    await ann.send('<img src=x onerror=alert(1)> Mum phone 0770');
    expect(ann.getState().messages[0].text).toContain('<img');
  });
});
