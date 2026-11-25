import { describe, expect, it } from 'vitest';
import { world } from './sharing-world.test-util.mjs';

// The facts client against the real service (R-025): real SQLite files, real HTTP, the demo model. ann owns "Club", bob is a member,
// cat is an observer, dan is in nothing.

const post = async (who, text, circleId) => {
  const made = await who.notes.propose(text, { kind: 'circle', circleId });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  expect((await who.notes.approve(made.value.id)).ok).toBe(true);
  return made.value.summary.newItems?.[0] ?? made.value.summary.facts?.[0]?.id;
};

describe('the facts client against the real service', () => {
  it('resolves for you only, lists your own, takes it back, and a stranger and a made-up circle read the same', async () => {
    const w = await world();
    const scope = { kind: 'circle', circleId: w.circle };
    const id = await post(w.ann, 'Pay for this week yoga class by Friday', w.circle);
    expect(typeof id).toBe('string');
    const fact = { scope, id };

    const paid = await w.bob.facts.resolve(fact, 'pay');
    expect(paid, JSON.stringify(paid)).toEqual({ ok: true, value: { fact, verb: 'pay', effect: 'clear', result: 'hidden' } });
    expect((await w.bob.facts.list()).value.items).toEqual([expect.objectContaining({ fact, verb: 'pay' })]);
    for (const other of [w.ann, w.cat, w.dan]) expect((await other.facts.list()).value.items, other.id).toEqual([]);

    expect((await w.bob.facts.unresolve(fact)).ok).toBe(true);
    expect((await w.bob.facts.unresolve(fact)).ok).toBe(true);
    expect((await w.bob.facts.list()).value.items).toEqual([]);

    const stranger = await w.dan.facts.resolve(fact, 'pay');
    const madeUp = await w.dan.facts.resolve({ scope: { kind: 'circle', circleId: 'c0000000000000000' }, id }, 'pay');
    expect(stranger).toEqual(madeUp);
    expect(stranger.error).toMatchObject({ kind: 'not-found', what: 'circle' });
    expect((await w.bob.facts.resolve({ scope, id: 'nope' }, 'pay')).error).toMatchObject({ kind: 'not-found', what: 'fact' });
    expect((await w.bob.facts.resolve(fact, 'dance')).ok).toBe(false);
  });

  it('only the owner removes: others are told so in fixed words, the owner deletes it for everyone', async () => {
    const w = await world();
    const scope = { kind: 'circle', circleId: w.circle };
    const id = await post(w.ann, 'Pay for this week yoga class by Friday', w.circle);
    for (const who of [w.bob, w.cat]) expect((await who.facts.resolve({ scope, id }, 'remove')).error).toMatchObject({ kind: 'forbidden' });
    const done = await w.ann.facts.resolve({ scope, id }, 'remove');
    expect(done.value).toMatchObject({ verb: 'remove', effect: 'remove', result: 'deleted' });
    expect((await w.bob.facts.resolve({ scope, id }, 'clear')).error).toMatchObject({ kind: 'not-found', what: 'fact' });
  });

  it('pages through your own resolutions', async () => {
    const w = await world();
    const scope = { kind: 'circle', circleId: w.circle };
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await post(w.ann, `Unrelated note number ${i} about gardening ${'x'.repeat(i)}`, w.circle));
    for (const id of ids) expect((await w.bob.facts.resolve({ scope, id }, 'clear')).ok).toBe(true);
    const first = await w.bob.facts.list({ limit: 2 });
    expect(first.value.items).toHaveLength(2);
    expect(first.value.next).not.toBeNull();
    const second = await w.bob.facts.list({ limit: 2, after: first.value.next });
    expect(second.value.items).toHaveLength(1);
    expect(second.value.next).toBeNull();
    expect([...first.value.items, ...second.value.items].map((r) => r.fact.id).sort()).toEqual([...ids].sort());
  });
});
