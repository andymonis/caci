import { describe, expect, it } from 'vitest';
import { createLedgerSession } from './ledger-session.js';
import { world } from './sharing-world.test-util.mjs';

// The change log through the web client and logic against the real service (R-014): real SQLite files, real HTTP, the demo model.

const file = async (who, text, circleId) => {
  const made = await who.notes.propose(text, circleId === undefined ? undefined : { kind: 'circle', circleId });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  const done = await who.notes.approve(made.value.id);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  return { made: made.value, done: done.value };
};

describe('the change log against the real service', () => {
  it('records what was added and what a new note replaced, newest first, only for the brain asked about', async () => {
    const w = await world();
    const club = { kind: 'circle', circleId: w.circle };
    await file(w.ann, 'Mum takes Tablet A twice a day with food');
    const second = await file(w.ann, 'Change: Mum takes Tablet A once a day with food now');
    expect(second.made.summary.removed).toHaveLength(1);
    expect(second.done.tidied ?? []).toEqual([]);
    await file(w.cat, 'Bin collection moved to Thursday', w.circle);

    const own = (await w.ann.ledger.list(undefined)).value;
    expect(own.nextCursor).toBeNull();
    const actions = own.items.map((e) => `${e.action} ${e.kind}`);
    expect(actions).toContain('removed item');
    expect(actions.filter((a) => a === 'added item')).toHaveLength(2);
    const removed = own.items.find((e) => e.action === 'removed' && e.kind === 'item');
    expect(removed.title).toContain('Tablet A');
    expect(removed.by).toEqual({ username: 'ann', displayName: 'Display ann' });
    for (let i = 1; i < own.items.length; i++) expect(own.items[i - 1].at).toBeGreaterThanOrEqual(own.items[i].at);
    expect(JSON.stringify(own)).not.toContain('Bin collection');

    const circle = (await w.bob.ledger.list(club)).value; // bob is a member and can read it
    expect(circle.scope).toMatchObject({ kind: 'circle', circleId: w.circle, circleName: 'Club' });
    expect(circle.items.some((e) => e.by?.username === 'cat')).toBe(true);
    expect(JSON.stringify(circle)).not.toContain('Tablet');
  });

  it('a stranger and a made-up circle read the same; a person who left is told so; paging works', async () => {
    const w = await world();
    const club = { kind: 'circle', circleId: w.circle };
    const stranger = await w.dan.ledger.list(club);
    const madeUp = await w.dan.ledger.list({ kind: 'circle', circleId: 'c0000000000000000' });
    expect(stranger).toEqual(madeUp);
    expect(stranger.error).toEqual({ kind: 'not-found', what: 'circle', message: 'No such circle, or you are not in it.' });

    for (let i = 0; i < 3; i++) await file(w.ann, `Unrelated note number ${i} about gardening ${'x'.repeat(i)}`);
    const first = await w.ann.ledger.list(undefined, { limit: 2 });
    expect(first.value.items).toHaveLength(2);
    expect(first.value.nextCursor).not.toBeNull();
    const next = await w.ann.ledger.list(undefined, { limit: 2, cursor: first.value.nextCursor });
    expect(next.ok).toBe(true);
    expect(next.value.items.map((e) => e.id)).not.toEqual(expect.arrayContaining(first.value.items.map((e) => e.id)));
    expect((await w.ann.ledger.list(club, { cursor: first.value.nextCursor })).ok).toBe(false); // a cursor from another scope

    const session = createLedgerSession({ client: w.cat.ledger });
    await session.open(club);
    expect(session.getState().status).toBe('loaded');
    expect((await w.ann.circles.removeMember(w.circle, w.cat.id)).ok).toBe(true);
    await session.refresh();
    expect(session.getState()).toMatchObject({ status: 'lost', error: 'No such circle, or you are not in it.' });
    await session.useOwn();
    expect(session.getState().status).toBe('loaded');
  });

  it('a signed-out client is told so', async () => {
    const w = await world();
    const out = await w.ann.ledger.list(undefined);
    expect(out.ok).toBe(true);
    const { createLedgerClient } = await import('./ledger-client.js');
    const anon = createLedgerClient({ fetchFn: (path, init) => fetch(`http://127.0.0.1:${w.service.port}${path}`, { method: init.method, headers: { origin: `http://127.0.0.1:${w.service.port}`, 'x-forwarded-for': '203.0.113.9' } }) });
    expect((await anon.list(undefined)).error.kind).toBe('signed-out');
  });

  it('keeps the words of each update (R-017): a member, an observer and the owner read the same words and the author; a stranger gets the one not-found; hostile text is data', async () => {
    const w = await world();
    const club = { kind: 'circle', circleId: w.circle };
    const words = '<img src=x onerror=alert(1)> Bin collection moved to Thursday 😀\nsecond line';
    await file(w.cat, words, w.circle);
    // dan is not in the circle yet: the same answer as a made-up circle
    const outside = await w.dan.ledger.list(club);
    const madeUp = await w.dan.ledger.list({ kind: 'circle', circleId: 'c0000000000000000' });
    expect(outside.error).toEqual(madeUp.error);
    // then dan joins as an observer and reads it
    await w.ann.circles.invite(w.circle, { username: 'dan', role: 'observer' });
    const invitation = (await w.dan.circles.myInvitations()).value.items.find((i) => i.circle.id === w.circle).id;
    expect((await w.dan.circles.acceptInvitation(invitation)).ok).toBe(true);
    const seen = [];
    for (const who of [w.ann, w.bob, w.cat, w.dan]) {
      const r = await who.ledger.list(club);
      expect(r.ok).toBe(true);
      const input = r.value.items.find((e) => e.kind === 'input');
      expect(input).toMatchObject({ action: 'added', kind: 'input', text: words, by: { username: 'cat' } });
      expect('subject' in input).toBe(false);
      seen.push(input.text);
    }
    expect(new Set(seen).size).toBe(1);
    // it is in the circle's log only
    expect((await w.cat.ledger.list(undefined)).value.items.some((e) => e.kind === 'input')).toBe(false);
  });
});

