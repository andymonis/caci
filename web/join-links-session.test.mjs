import { describe, expect, it } from 'vitest';
import { checkJoinLink, CREATED_NOTICE, createJoinLinksSession } from './join-links-session.js';

const C = 'c0123456789abcdef';
const U = 'u0123456789abcdef';
const TOKEN = `cjoin_${'Ab1_-'.repeat(8)}Abc`;
const link = (n, extra = {}) => ({ id: `j${String(n).padStart(16, '0')}`, role: 'member', label: `Link ${n}`, createdBy: { userId: U, displayName: 'Ann' }, createdAt: 1, expiresAt: 2, maxUses: 3, uses: 0, approval: true, ...extra });
const request = (n, name = `Eve ${n}`) => ({ id: `r${String(n).padStart(16, '0')}`, person: { displayName: name }, role: 'observer', createdAt: 1, expiresAt: 2 });
const page = (items) => ({ ok: true, value: { items, nextCursor: null } });
const bad = (kind, message = kind, extra = {}) => ({ ok: false, error: { kind, message, ...extra } });

/** A fake join client over a little state; each method can be made to fail or wait. */
function fake(init = {}) {
  const state = { links: init.links ?? [], requests: init.requests ?? [], calls: [] };
  const wait = {};
  const fails = {};
  const gate = async (name, ...args) => {
    state.calls.push([name, ...args]);
    if (wait[name]) await wait[name].promise;
    return fails[name];
  };
  const client = {
    listLinks: async (...a) => (await gate('listLinks', ...a)) ?? page(state.links),
    listRequests: async (...a) => (await gate('listRequests', ...a)) ?? page(state.requests),
    createLink: async (c, input) => {
      const f = await gate('createLink', c, input);
      if (f) return f;
      const made = link(state.links.length + 1, { label: input.label, role: input.role ?? 'observer' });
      state.links.push(made);
      return { ok: true, value: { token: TOKEN, link: made } };
    },
    revokeLink: async (c, id) => {
      const f = await gate('revokeLink', c, id);
      if (f) return f;
      state.links = state.links.filter((l) => l.id !== id);
      return { ok: true, value: true };
    },
    approve: async (c, id) => {
      const f = await gate('approve', c, id);
      if (f) return f;
      state.requests = state.requests.filter((r) => r.id !== id);
      return { ok: true, value: { userId: U, role: 'observer', joinedAt: 5 } };
    },
    decline: async (c, id) => {
      const f = await gate('decline', c, id);
      if (f) return f;
      state.requests = state.requests.filter((r) => r.id !== id);
      return { ok: true, value: true };
    },
  };
  const hold = (name) => {
    let release;
    wait[name] = { promise: new Promise((r) => (release = r)) };
    return () => release();
  };
  return { state, client, fails, hold };
}
const make = (f, extra = {}) => createJoinLinksSession({ client: f.client, ...extra });
const FORM = { label: 'Group chat', role: 'observer', days: 7, uses: 1, approval: true };

describe('the form check', () => {
  it('accepts the form and trims the name', () => {
    expect(checkJoinLink({ ...FORM, label: '  Club  ' })).toEqual({ ok: true, value: { ...FORM, label: 'Club' } });
    expect(checkJoinLink({ label: 'x'.repeat(80), role: 'member', days: 30, uses: 100, approval: false }).ok).toBe(true);
    expect(checkJoinLink({ label: '😀'.repeat(80), role: 'member', days: 1, uses: 1, approval: false }).ok).toBe(true);
  });
  it('says what is wrong beside its field, all at once', () => {
    const r = checkJoinLink({ label: ' ', role: 'owner', days: 0, uses: 101, approval: 'yes' });
    expect(Object.keys(r.errors).sort()).toEqual(['approval', 'days', 'label', 'role', 'uses']);
    for (const label of ['', 'x'.repeat(81), 'a\nb', '\u0001', 5, undefined]) expect(checkJoinLink({ ...FORM, label }).errors?.label, String(label)).toBeTruthy();
    for (const role of ['owner', 'manager', '', 5, undefined]) expect(checkJoinLink({ ...FORM, role }).errors?.role, String(role)).toBeTruthy();
    for (const days of [0, 31, 1.5, '7', undefined, Number.NaN]) expect(checkJoinLink({ ...FORM, days }).errors?.days, String(days)).toBeTruthy();
    for (const uses of [0, 101, 2.5, '1', undefined]) expect(checkJoinLink({ ...FORM, uses }).errors?.uses, String(uses)).toBeTruthy();
    for (const approval of ['yes', 0, undefined, null]) expect(checkJoinLink({ ...FORM, approval }).errors?.approval, String(approval)).toBeTruthy();
    expect(checkJoinLink(undefined).ok).toBe(false);
    expect(checkJoinLink({ ...FORM, label: '😀'.repeat(81) }).errors.label).toBeTruthy();
  });
});

describe('opening', () => {
  it('asks for nothing until it is opened, then loads the links and the waiting requests', async () => {
    const f = fake({ links: [link(1), link(2)], requests: [request(1)] });
    const s = make(f);
    expect(f.state.calls).toEqual([]);
    expect(s.getState()).toMatchObject({ status: 'idle', links: [], requests: [], created: null, busy: false });
    expect(await s.open(C)).toEqual({ ok: true });
    expect(f.state.calls).toEqual([['listLinks', C, { limit: 100 }], ['listRequests', C, { limit: 100 }]]);
    expect(s.getState()).toMatchObject({ status: 'loaded', circleId: C, message: null });
    expect(s.getState().links).toHaveLength(2);
    expect(s.getState().requests).toEqual([request(1)]);
  });

  it('says so when join links are not switched on, or the circle is gone, or the load fails, and shows nothing then', async () => {
    for (const [{ error }, status] of [[bad('unavailable', 'Not switched on.'), 'unavailable'], [bad('not-found', 'No such circle.', { what: 'circle' }), 'gone'], [bad('server', 'Broke.'), 'error'], [bad('forbidden', 'No.'), 'error']]) {
      const f = fake({ links: [link(1)] });
      f.fails.listLinks = { ok: false, error };
      const s = make(f);
      const r = await s.open(C);
      expect(r.ok).toBe(false);
      expect(s.getState()).toMatchObject({ status, message: error.message, links: [], requests: [] });
    }
  });

  it('a failure of the second list is shown the same way and keeps nothing', async () => {
    const f = fake({ links: [link(1)], requests: [request(1)] });
    f.fails.listRequests = { ok: false, error: { kind: 'server', message: 'Broke.' } };
    const s = make(f);
    await s.open(C);
    expect(s.getState()).toMatchObject({ status: 'error', links: [], requests: [] });
  });

  it('the snapshot is frozen all the way down, and a broken listener does not stop the others', async () => {
    const f = fake({ links: [link(1)], requests: [request(1)] });
    const s = make(f);
    let heard = 0;
    s.subscribe(() => {
      throw new Error('broken');
    });
    s.subscribe(() => heard++);
    await s.open(C);
    const state = s.getState();
    expect(heard).toBeGreaterThan(0);
    expect(Object.isFrozen(state) && Object.isFrozen(state.links) && Object.isFrozen(state.requests)).toBe(true);
    const off = s.subscribe(() => heard++);
    off();
    const before = heard;
    await s.refresh();
    expect(heard).toBeGreaterThan(before); // the first listener still hears
  });
});

describe('making a link', () => {
  it('checks the form first and sends nothing when it is wrong, naming the first field', async () => {
    const f = fake();
    const s = make(f);
    await s.open(C);
    const before = f.state.calls.length;
    const r = await s.create({ ...FORM, label: '' });
    expect(r).toMatchObject({ ok: false, kind: 'invalid', field: 'label' });
    expect(s.getState()).toMatchObject({ problem: expect.any(String), problemField: 'label', created: null });
    expect(f.state.calls).toHaveLength(before);
  });

  it('sends the checked values, holds the token once with the link, says so, and reloads the list without the token', async () => {
    const f = fake();
    const s = make(f);
    await s.open(C);
    expect(await s.create({ ...FORM, label: ' Chat ', role: 'member', uses: 4, approval: false })).toEqual({ ok: true });
    expect(f.state.calls.find((c) => c[0] === 'createLink')).toEqual(['createLink', C, { label: 'Chat', role: 'member', days: 7, uses: 4, approval: false }]);
    const st = s.getState();
    expect(st.created).toEqual({ token: TOKEN, link: expect.objectContaining({ label: 'Chat' }) });
    expect(st.notice).toBe(CREATED_NOTICE);
    expect(st.links.map((l) => l.label)).toEqual(['Chat']);
    expect(JSON.stringify(st.links)).not.toContain('cjoin_');
    expect(JSON.stringify({ ...st, created: null })).not.toContain(TOKEN);
  });

  it('forgets the token when it is dismissed, replaced by another link, or the screen is left', async () => {
    const f = fake();
    const s = make(f);
    await s.open(C);
    await s.create(FORM);
    expect(s.dismissCreated()).toBe(true);
    expect(s.getState()).toMatchObject({ created: null, notice: null });
    expect(s.dismissCreated()).toBe(false);
    await s.create(FORM);
    await s.create({ ...FORM, label: 'Second' });
    expect(s.getState().created.link.label).toBe('Second');
    s.reset();
    expect(s.getState()).toMatchObject({ created: null, status: 'idle', links: [], requests: [], circleId: null });
    expect(JSON.stringify(s.getState())).not.toContain(TOKEN);
  });

  it('shows the service\'s words and field when it refuses, keeps no token, and a limit is shown', async () => {
    const f = fake();
    const s = make(f);
    await s.open(C);
    f.fails.createLink = { ok: false, error: { kind: 'invalid', message: 'label must be 1 to 80 characters', field: 'label' } };
    expect(await s.create(FORM)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(s.getState()).toMatchObject({ problem: 'label must be 1 to 80 characters', problemField: 'label', created: null, status: 'loaded' });
    f.fails.createLink = { ok: false, error: { kind: 'limit', message: 'a circle may have at most 20 live join links' } };
    await s.create(FORM);
    expect(s.getState()).toMatchObject({ problem: 'a circle may have at most 20 live join links', problemField: null });
  });

  it('a circle that has gone ends the view, and then nothing more is asked', async () => {
    const f = fake({ links: [link(1)], requests: [request(1)] });
    const s = make(f);
    await s.open(C);
    await s.create(FORM);
    f.fails.createLink = { ok: false, error: { kind: 'not-found', what: 'circle', message: 'No such circle.' } };
    await s.create(FORM);
    expect(s.getState()).toMatchObject({ status: 'gone', links: [], requests: [], created: null, notice: null, asking: null });
    const sent = f.state.calls.length;
    expect(await s.approve(request(1).id)).toMatchObject({ kind: 'not-open' });
    expect(await s.decline(request(1).id)).toMatchObject({ kind: 'not-open' });
    expect(await s.create(FORM)).toMatchObject({ kind: 'not-open' });
    expect(s.askRevoke(link(1).id)).toBe(false);
    expect(f.state.calls).toHaveLength(sent);
  });

  it('a failed refresh leaves nothing shown that may be out of date', async () => {
    const f = fake({ links: [link(1)], requests: [request(1)] });
    const s = make(f);
    await s.open(C);
    s.askRevoke(link(1).id);
    f.fails.listLinks = { ok: false, error: { kind: 'server', message: 'Broke.' } };
    await s.refresh();
    expect(s.getState()).toMatchObject({ status: 'error', links: [], requests: [], asking: null, created: null });
  });

  it('refuses before the links are shown', async () => {
    const f = fake();
    const s = make(f);
    expect(await s.create(FORM)).toMatchObject({ ok: false, kind: 'not-open' });
    expect(f.state.calls).toEqual([]);
  });

  it('a failed reload after making a link is reported but the link was made and the token is kept', async () => {
    const f = fake();
    const s = make(f);
    await s.open(C);
    let n = 0;
    const original = f.client.listLinks;
    f.client.listLinks = async (...a) => (++n === 1 ? { ok: false, error: { kind: 'server', message: 'Reload broke.' } } : original(...a));
    expect(await s.create(FORM)).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ problem: 'Reload broke.' });
    expect(s.getState().created.token).toBe(TOKEN);
  });
});

describe('withdrawing a link', () => {
  it('asks first; cancel changes nothing; confirming removes it, says so and reloads', async () => {
    const f = fake({ links: [link(1), link(2)] });
    const s = make(f);
    await s.open(C);
    expect(s.askRevoke(link(2).id)).toBe(true);
    expect(s.getState().asking).toBe(link(2).id);
    expect(s.cancel()).toBe(true);
    expect(s.cancel()).toBe(false);
    expect(f.state.calls.some((c) => c[0] === 'revokeLink')).toBe(false);
    s.askRevoke(link(2).id);
    expect(await s.confirmRevoke()).toEqual({ ok: true });
    expect(f.state.calls.find((c) => c[0] === 'revokeLink')).toEqual(['revokeLink', C, link(2).id]);
    expect(s.getState()).toMatchObject({ asking: null, notice: expect.stringContaining('withdrawn') });
    expect(s.getState().links.map((l) => l.id)).toEqual([link(1).id]);
  });

  it('cannot ask about a link that is not shown, or while a request is out, and confirm needs a question', async () => {
    const f = fake({ links: [link(1)] });
    const s = make(f);
    expect(s.askRevoke(link(1).id)).toBe(false);
    await s.open(C);
    expect(s.askRevoke('j0000000000000000')).toBe(false);
    const release = f.hold('listLinks');
    const pending = s.refresh();
    expect(s.askRevoke(link(1).id)).toBe(false);
    release();
    await pending;
    expect(await s.confirmRevoke()).toMatchObject({ ok: false, kind: 'not-open' });
  });

  it('a link already gone shows the service\'s words and what is there now', async () => {
    const f = fake({ links: [link(1)] });
    const s = make(f);
    await s.open(C);
    f.state.links = [];
    f.fails.revokeLink = { ok: false, error: { kind: 'not-found', what: 'link', message: 'This link does not work.' } };
    s.askRevoke(link(1).id);
    await s.confirmRevoke();
    expect(s.getState()).toMatchObject({ problem: 'This link does not work.', links: [], asking: null });
  });

  it('a circle that has gone ends the view', async () => {
    const f = fake({ links: [link(1)] });
    const s = make(f);
    await s.open(C);
    f.fails.revokeLink = { ok: false, error: { kind: 'not-found', what: 'circle', message: 'No such circle.' } };
    s.askRevoke(link(1).id);
    await s.confirmRevoke();
    expect(s.getState().status).toBe('gone');
  });
});

describe('approving and declining', () => {
  it('approving makes the person a member, says who, reloads the requests and tells the page the roster changed', async () => {
    const f = fake({ requests: [request(1, 'Eve'), request(2, 'Fay')] });
    let changes = 0;
    const s = make(f, { onChanged: () => changes++ });
    await s.open(C);
    expect(await s.approve(request(1).id)).toEqual({ ok: true });
    expect(f.state.calls.find((c) => c[0] === 'approve')).toEqual(['approve', C, request(1).id]);
    expect(s.getState().notice).toBe('Approved: Eve is now a observer.');
    expect(s.getState().requests.map((r) => r.person.displayName)).toEqual(['Fay']);
    expect(changes).toBe(1);
    await s.decline(request(2).id);
    expect(changes).toBe(1);
  });

  it('declining says who and reloads; neither is asked before the links are shown', async () => {
    const f = fake({ requests: [request(1, 'Eve')] });
    const s = make(f);
    expect(await s.approve(request(1).id)).toMatchObject({ kind: 'not-open' });
    expect(await s.decline(request(1).id)).toMatchObject({ kind: 'not-open' });
    await s.open(C);
    expect(await s.decline(request(1).id)).toEqual({ ok: true });
    expect(s.getState()).toMatchObject({ notice: 'Declined: Eve was not added.', requests: [] });
  });

  it('a person with no name is "the person"', async () => {
    const f = fake({ requests: [{ ...request(1), person: {} }, { ...request(2), person: {} }] });
    const s = make(f);
    await s.open(C);
    await s.approve(request(1).id);
    expect(s.getState().notice).toBe('Approved: the person is now a observer.');
    await s.decline(request(2).id);
    expect(s.getState().notice).toBe('Declined: the person was not added.');
  });

  it('a full circle shows the service\'s words and leaves the request waiting', async () => {
    const f = fake({ requests: [request(1)] });
    const s = make(f);
    await s.open(C);
    f.fails.approve = { ok: false, error: { kind: 'limit', message: 'a circle may have at most 4 people' } };
    expect(await s.approve(request(1).id)).toMatchObject({ ok: false, kind: 'limit' });
    expect(s.getState()).toMatchObject({ problem: 'a circle may have at most 4 people', notice: null });
    expect(s.getState().requests).toHaveLength(1);
  });

  it('a request already dealt with shows the words and reloads the list; a gone circle ends the view', async () => {
    for (const method of ['approve', 'decline']) {
      const f = fake({ requests: [request(1), request(2)] });
      const s = make(f);
      await s.open(C);
      f.state.requests = [request(2)];
      f.fails[method] = { ok: false, error: { kind: 'not-found', what: 'request', message: 'No such request.' } };
      await s[method](request(1).id);
      expect(s.getState()).toMatchObject({ problem: 'No such request.' });
      expect(s.getState().requests.map((r) => r.id)).toEqual([request(2).id]);
      f.fails[method] = { ok: false, error: { kind: 'not-found', what: 'circle', message: 'No such circle.' } };
      await s[method](request(2).id);
      expect(s.getState().status).toBe('gone');
    }
  });

  it('a failed reload after approving is reported but the approval counts', async () => {
    const f = fake({ requests: [request(1)] });
    let changes = 0;
    const s = make(f, { onChanged: () => changes++ });
    await s.open(C);
    f.client.listRequests = async () => ({ ok: false, error: { kind: 'server', message: 'Reload broke.' } });
    expect(await s.approve(request(1).id)).toEqual({ ok: true });
    expect(s.getState().problem).toBe('Reload broke.');
    expect(changes).toBe(1);
  });

  it('a broken onChanged does not matter', async () => {
    const f = fake({ requests: [request(1)] });
    const s = make(f, {
      onChanged: () => {
        throw new Error('broken');
      },
    });
    await s.open(C);
    expect(await s.approve(request(1).id)).toEqual({ ok: true });
  });
});

describe('one at a time, late answers, sign-out', () => {
  it('a second call while one is out is refused as busy and sends nothing', async () => {
    const f = fake({ requests: [request(1)] });
    const s = make(f);
    await s.open(C);
    const release = f.hold('approve');
    const first = s.approve(request(1).id);
    expect(s.getState().busy).toBe(true);
    expect(await s.decline(request(1).id)).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.create(FORM)).toMatchObject({ ok: false, kind: 'busy' });
    expect(await s.refresh()).toMatchObject({ kind: 'busy' });
    expect(f.state.calls.filter((c) => c[0] === 'decline' || c[0] === 'createLink')).toEqual([]);
    release();
    await first;
    expect(s.getState().busy).toBe(false);
  });

  it('an answer for a circle that is no longer open is dropped and shows nothing', async () => {
    const f = fake({ links: [link(1)] });
    const s = make(f);
    const release = f.hold('listLinks');
    const pending = s.open(C);
    s.reset();
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'dropped' });
    expect(s.getState()).toMatchObject({ status: 'idle', links: [], busy: false });
    expect(f.state.calls.some((c) => c[0] === 'listRequests')).toBe(false); // nothing more is asked for a circle that is no longer open
  });

  it('opening another circle drops the first one\'s answer and does not clear the second\'s busy mark', async () => {
    const f = fake();
    let releaseFirst;
    f.client.listLinks = (circle) => (circle === C ? new Promise((resolve) => (releaseFirst = () => resolve(page([link(9)])))) : Promise.resolve(page([link(1)])));
    const s = make(f);
    const first = s.open(C);
    const second = s.open('c0000000000000002');
    expect(s.getState()).toMatchObject({ circleId: 'c0000000000000002' });
    await second;
    releaseFirst();
    expect(await first).toMatchObject({ kind: 'dropped' });
    expect(s.getState().links.map((l) => l.id)).toEqual([link(1).id]);
    expect(s.getState().busy).toBe(false);
  });

  it('a late answer after a reset does not clear a newer request\'s busy mark', async () => {
    const f = fake({ links: [link(1)] });
    const s = make(f);
    const release = f.hold('listLinks');
    const old = s.open(C);
    s.reset();
    f.client.listLinks = () => new Promise(() => {}); // the next request never answers
    void s.open(C);
    expect(s.getState().busy).toBe(true);
    release();
    await old;
    expect(s.getState().busy).toBe(true);
  });

  it('a signed-out answer is reported once to the page', async () => {
    const f = fake({ links: [link(1)] });
    let out = 0;
    const s = make(f, { onSignedOut: () => out++ });
    f.fails.listLinks = { ok: false, error: { kind: 'signed-out', message: 'Your session has ended.' } };
    await s.open(C);
    expect(out).toBe(1);
  });
});
