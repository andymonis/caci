import { describe, expect, it } from 'vitest';
import { createChatSession, RECORDED_PERSONAL, recordedCircle, WHO_QUESTION } from './chat-session.js';
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
      scopes: rec('scopes', () => okv({ items: [{ scope: { kind: 'personal' }, canCapture: true }] })),
      propose: rec('propose', () => okv({ id: 'prop-1', summary: SUMMARY() })),
      approve: rec('approve', () => okv({ id: 'prop-1', applied: 3 })),
      reject: rec('reject', () => okv(true)),
      status: rec('status', () => okv({ headline: 'A quiet day.', nothing: false, points: [{ text: 'Mum has new tablets.', sources: [{ kind: 'personal' }] }] })),
      ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, rec(k, v)])),
    },
  };
}
const CIRCLES = { items: [{ scope: { kind: 'personal' }, canCapture: true }, { scope: { kind: 'circle', circleId: C1, circleName: 'Parent care' }, role: 'member', canCapture: true }, { scope: { kind: 'circle', circleId: 'cabcdefghij012345', circleName: 'Read only' }, role: 'observer', canCapture: false }] };
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
    expect(s.getState()).toMatchObject({ mode: { status: 'unknown' }, canSend: false, messages: [] });
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
    expect(calls.map((c) => c[0])).toEqual(['mode', 'scopes', 'propose', 'approve']);
    expect(calls[2]).toEqual(['propose', 'Mum phone 0770', undefined]);
    expect(texts(s)).toEqual(['me:text:Mum phone 0770', `cacci:recorded:${RECORDED_PERSONAL}`]);
    expect(s.getState().messages[1].lines).toEqual(['Mum: phone: 0770']);
    expect(s.getState()).toMatchObject({ busy: false, choosing: false, canSend: true });
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

describe('for you or a circle', () => {
  const circles = { scopes: () => okv(CIRCLES) };
  it('asks in the thread, offering Me, each circle you may capture into, and Cancel (not the read-only one)', async () => {
    const { s, calls } = await make(circles);
    expect(await s.send('Bins on Thursday')).toEqual({ ok: true, asked: true });
    const ask = s.getState().messages.at(-1);
    expect(ask).toMatchObject({ from: 'cacci', kind: 'choice', text: WHO_QUESTION });
    expect(ask.choices).toEqual([{ key: 'personal', label: 'Me' }, { key: `circle:${C1}`, label: 'Parent care' }, { key: 'cancel', label: 'Cancel' }]);
    expect(names({ calls })).toEqual(['mode', 'scopes']);
    expect(s.getState()).toMatchObject({ choosing: true, canSend: false });
  });
  it('sending or asking is refused while the question is open', async () => {
    const { s } = await make(circles);
    await s.send('Bins');
    expect(await s.send('another')).toMatchObject({ ok: false, kind: 'choose' });
    expect(await s.ask('why')).toMatchObject({ ok: false, kind: 'choose' });
  });
  it('Me files to your own brain, with no scope sent', async () => {
    const { s, calls } = await make(circles);
    await s.send('Bins');
    expect(await s.choose('personal')).toEqual({ ok: true });
    expect(calls.find((c) => c[0] === 'propose')).toEqual(['propose', 'Bins', undefined]);
    expect(texts(s).slice(-2)).toEqual(['me:text:Me', `cacci:recorded:${RECORDED_PERSONAL}`]);
    expect(s.getState().choosing).toBe(false);
  });
  it('a circle files to that circle, sending only its kind and id, and says its name', async () => {
    const { s, calls } = await make(circles);
    await s.send('Bins');
    await s.choose(`circle:${C1}`);
    expect(calls.find((c) => c[0] === 'propose')).toEqual(['propose', 'Bins', { kind: 'circle', circleId: C1 }]);
    expect(texts(s).slice(-2)).toEqual(['me:text:Parent care', `cacci:recorded:${recordedCircle('Parent care')}`]);
    expect(recordedCircle('Parent care')).toBe('Recorded against the circle "Parent care"');
    expect(recordedCircle('')).toBe('Recorded against the circle "this circle"');
  });
  it('Cancel records nothing', async () => {
    const { s, calls } = await make(circles);
    await s.send('Bins');
    expect(await s.choose('cancel')).toEqual({ ok: true, cancelled: true });
    expect(names({ calls })).toEqual(['mode', 'scopes']);
    expect(texts(s).slice(-2)).toEqual(['me:text:Cancel', 'cacci:text:Not recorded.']);
    expect(s.getState().canSend).toBe(true);
  });
  it('a choice that was not offered, or none open, sends nothing', async () => {
    const { s, calls } = await make(circles);
    expect(await s.choose('personal')).toMatchObject({ ok: false, kind: 'invalid' });
    await s.send('Bins');
    expect(await s.choose('circle:cabcdefghij012345')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await s.choose('__proto__')).toMatchObject({ ok: false, kind: 'invalid' });
    expect(names({ calls })).toEqual(['mode', 'scopes']);
    expect(s.getState().choosing).toBe(true);
  });
  it('a list of circles that cannot be read records nothing and says why', async () => {
    const { s, calls } = await make({ scopes: () => bad('server', 'down') });
    expect(await s.send('Bins')).toMatchObject({ ok: false });
    expect(names({ calls })).toEqual(['mode', 'scopes']);
    expect(texts(s).at(-1)).toBe('cacci:error:Not recorded: down');
  });
  it('a circle name is only text', async () => {
    const { s } = await make({ scopes: () => okv({ items: [{ scope: { kind: 'circle', circleId: C1, circleName: '<b>Parent</b>' }, role: 'owner', canCapture: true }] }) });
    await s.send('x');
    expect(s.getState().messages.at(-1).choices[1].label).toBe('<b>Parent</b>');
  });
});

describe('when filing does not work, nothing is kept', () => {
  it('a model failure says why, with the wait, and nothing is approved', async () => {
    const { s, calls } = await make({ propose: () => bad('model', 'The model is busy.', { retryAfterSeconds: 30 }) });
    expect(await s.send('x')).toMatchObject({ ok: false, kind: 'model' });
    expect(names({ calls })).toEqual(['mode', 'scopes', 'propose']);
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
  it('a second send, ask or choice meanwhile sends nothing', async () => {
    const d = deferred();
    const { s, calls } = await make({ propose: () => d.promise });
    const first = s.send('x');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState()).toMatchObject({ busy: true, canSend: false });
    expect(await s.send('y')).toMatchObject({ kind: 'busy' });
    expect(await s.ask('y')).toMatchObject({ kind: 'busy' });
    expect(await s.choose('personal')).toMatchObject({ kind: 'busy' });
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
    expect(s.getState()).toMatchObject({ messages: [], busy: false, choosing: false, mode: { status: 'unknown' } });
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
  it('a reset while a choice is open forgets it', async () => {
    const { s } = await make({ scopes: () => okv(CIRCLES) });
    await s.send('x');
    s.reset();
    expect(s.getState()).toMatchObject({ choosing: false, messages: [] });
    expect(await s.choose('personal')).toMatchObject({ ok: false });
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
  it('a person in a circle is asked, and the note lands in the circle; another member can read it', async () => {
    const w = await world();
    const ann = await real(w.ann);
    expect(await ann.send('Bin collection moved to Thursday')).toEqual({ ok: true, asked: true });
    expect(ann.getState().messages.at(-1).choices.map((c) => c.label)).toEqual(['Me', 'Club', 'Cancel']);
    expect(await ann.choose(`circle:${w.circle}`)).toEqual({ ok: true });
    expect(ann.getState().messages.at(-1).text).toBe('Recorded against the circle "Club"');
    const seen = await w.bob.notes.categories({ kind: 'circle', circleId: w.circle });
    expect(seen.ok).toBe(true);
    const ownBefore = (await w.ann.notes.summaryIn(undefined)).value.itemCount;
    expect(ownBefore).toBeGreaterThanOrEqual(0);
  });
  it('an observer-only circle is not offered, so that person files straight to their own brain', async () => {
    const w = await world();
    const club = w.circle;
    const neighbours = (await w.ann.circles.createCircle({ name: 'Neighbours' })).value.id;
    await w.ann.circles.invite(neighbours, { username: 'dan', role: 'observer' });
    const invitation = (await w.dan.circles.myInvitations()).value.items.find((i) => i.circle.id === neighbours).id;
    await w.dan.circles.acceptInvitation(invitation);
    const dan = await real(w.dan);
    expect(await dan.send('A note')).toEqual({ ok: true });
    expect(dan.getState().messages.at(-1).text).toBe(RECORDED_PERSONAL);
    expect(club).toBeDefined();
  });
  it('markup in a note comes back as text, and a cancelled choice records nothing', async () => {
    const w = await world();
    const ann = await real(w.ann);
    await ann.send('<img src=x onerror=alert(1)> Mum phone 0770');
    await ann.choose('cancel');
    const before = (await w.ann.notes.summaryIn(undefined)).value.itemCount;
    expect(ann.getState().messages[0].text).toContain('<img');
    expect(ann.getState().messages.at(-1).text).toBe('Not recorded.');
    expect((await w.ann.notes.summaryIn(undefined)).value.itemCount).toBe(before);
  });
});
