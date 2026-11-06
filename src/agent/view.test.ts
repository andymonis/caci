import { describe, expect, it } from 'vitest';
import { describeGraph } from '../graph_store/index.js';
import { circleGraphId } from '../scopes/index.js';
import { userGraphId } from '../users/index.js';
import { agentWorld, cid, DAY } from './agent.test-util.js';

const NO_CIRCLE = { ok: false, error: { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } } };
const NOT_SIGNED_IN = { ok: false, error: { source: 'caci', error: { code: 'UNAUTHENTICATED' } } };
const circle = (id: string) => ({ kind: 'circle', circleId: id });

async function setup() {
  const w = agentWorld();
  const ann = await w.register('ann');
  const bob = await w.register('bob');
  const dan = await w.register('dan');
  const club = await w.circle(1, ann, [[bob, 'member']]);
  const other = await w.circle(2, ann);
  await w.note(userGraphId(ann.id), 'n-own', 'Dentist on Tuesday', 'health', 'Health');
  await w.note(circleGraphId(club), 'n-club', 'Club meets Wednesday', 'meetings', 'Meetings');
  await w.note(circleGraphId(other), 'n-other', 'Other circle secret', 'secrets', 'Secrets');
  return { w, ann, bob, dan, club, other };
}

describe('the agent view reads the brains a token lists, as the person could', () => {
  it('a personal token reads the person\'s own brain: summary, categories, the items in one, and one item', async () => {
    const { w, ann } = await setup();
    const t = await w.bearer(ann, ['personal']);
    expect(await w.view.read.summary(t)).toMatchObject({ ok: true, value: { itemCount: 1, categoryCount: 1 } });
    const cats = await w.view.read.categories(t);
    expect(cats).toMatchObject({ ok: true, value: { items: [{ id: 'health', name: 'Health', itemCount: 1 }] } });
    expect(await w.view.read.categoryItems(t, 'health')).toMatchObject({ ok: true, value: { items: [{ id: 'n-own' }] } });
    expect(await w.view.read.item(t, 'n-own')).toMatchObject({ ok: true, value: { item: { id: 'n-own', data: { title: 'Dentist on Tuesday' } } } });
  });

  it('a circle token reads that circle, with its name, and only as a reader (an observer can too)', async () => {
    const { w, ann, bob, club } = await setup();
    const t = await w.bearer(bob, [`circle:${club}`]);
    expect(await w.view.read.summary(t, circle(club))).toMatchObject({ ok: true, value: { itemCount: 1, scope: { kind: 'circle', circleId: club, circleName: 'Circle 1' } } });
    expect(await w.view.read.item(t, 'n-club', circle(club))).toMatchObject({ ok: true, value: { item: { id: 'n-club' } } });
    await w.circles.changeRole(club, bob.id, 'observer');
    expect(await w.view.read.summary(t, circle(club))).toMatchObject({ ok: true }); // a demoted reader still reads
    void ann;
  });

  it('the combined view covers only the scopes the token lists', async () => {
    const { w, ann, club } = await setup();
    const both = await w.bearer(ann, ['personal', `circle:${club}`]);
    expect(await w.view.read.mineSummary(both)).toMatchObject({ ok: true, value: { itemCount: 2 } }); // her own and Club, not Circle 2
    const scopes = await w.view.read.brainScopes(both);
    expect(scopes.ok && scopes.value.items.map((s) => s.scope.kind === 'personal' ? 'personal' : (s.scope as { circleId: string }).circleId)).toEqual(['personal', club]);
    const onlyPersonal = await w.bearer(ann, ['personal']);
    expect(await w.view.read.mineSummary(onlyPersonal)).toMatchObject({ ok: true, value: { itemCount: 1 } });
  });

  it('a circle outside the token, a made-up circle and a circle the person is not in are the one no-such-circle answer', async () => {
    const { w, ann, dan, club, other } = await setup();
    const t = await w.bearer(ann, ['personal', `circle:${club}`]);
    const outside = await w.view.read.summary(t, circle(other)); // ann is a member of it, but this token does not list it
    expect(outside).toMatchObject(NO_CIRCLE);
    expect(await w.view.read.summary(t, circle(cid(99)))).toEqual(outside); // made up
    const strangers = await w.bearer(dan, [`circle:${club}`]); // dan lists it, but is not in it
    expect(await w.view.read.summary(strangers, circle(club))).toEqual(outside);
    for (const call of [
      () => w.view.read.categories(t, undefined, circle(other)),
      () => w.view.read.categoryItems(t, 'secrets', undefined, circle(other)),
      () => w.view.read.item(t, 'n-other', circle(other)),
      () => w.view.read.ledger(t, circle(other)),
      () => w.view.read.source(t, { scope: circle(other), id: 'n-other' }),
      () => w.view.read.mineItem(t, { scope: circle(other), id: 'n-other' }),
      () => w.view.read.mineCategoryItems(t, { scope: circle(other), id: 'secrets' }),
    ]) expect(await call()).toEqual(outside);
  });

  it('a token that does not list the personal scope cannot read the personal brain, by omission or by name', async () => {
    const { w, bob, club } = await setup();
    const t = await w.bearer(bob, [`circle:${club}`]);
    const byOmission = await w.view.read.summary(t);
    expect(byOmission).toMatchObject(NO_CIRCLE);
    expect(await w.view.read.summary(t, { kind: 'personal' })).toEqual(byOmission);
    expect(await w.view.read.categories(t)).toEqual(byOmission);
    const personal = { kind: 'personal' };
    for (const call of [
      () => w.view.read.categoryItems(t, 'health'),
      () => w.view.read.categoryItems(t, 'health', undefined, personal),
      () => w.view.read.item(t, 'n-own'),
      () => w.view.read.item(t, 'n-own', personal),
      () => w.view.read.ledger(t),
      () => w.view.read.ledger(t, personal),
      () => w.view.read.source(t, { id: 'n-own' }),
      () => w.view.read.source(t, { scope: personal, id: 'n-own' }),
      () => w.view.read.mineItem(t, { scope: personal, id: 'n-own' }),
      () => w.view.read.mineCategoryItems(t, { scope: personal, id: 'health' }),
      () => w.view.read.searchFacts(t, { text: 'dentist' }),
      () => w.view.read.searchFacts(t, { text: 'dentist', scope: personal }),
      () => w.view.read.changes(t, { since: 0 }),
      () => w.view.read.changes(t, { since: 0, scope: personal }),
    ]) expect(await call()).toEqual(byOmission);
    // and the combined view does not include it either
    expect(await w.view.read.mineSummary(t)).toMatchObject({ ok: true, value: { itemCount: 1 } }); // only Club's note
  });

  it('a token that lists personal still cannot reach a circle it does not list through an explicit personal-looking reference', async () => {
    const { w, ann, club } = await setup();
    const t = await w.bearer(ann, ['personal']);
    expect(await w.view.read.mineItem(t, { scope: { kind: 'personal' }, id: 'n-own' })).toMatchObject({ ok: true });
    expect(await w.view.read.mineItem(t, { scope: circle(club), id: 'n-club' })).toMatchObject(NO_CIRCLE);
  });

  it('removal from the circle takes effect on the next call, and the other circles still work', async () => {
    const { w, bob, club } = await setup();
    const t = await w.bearer(bob, ['personal', `circle:${club}`]);
    expect(await w.view.read.summary(t, circle(club))).toMatchObject({ ok: true });
    await w.circles.removeMember(club, bob.id);
    expect(await w.view.read.summary(t, circle(club))).toMatchObject(NO_CIRCLE);
    expect(await w.view.read.summary(t)).toMatchObject({ ok: true });
    expect(await w.view.read.mineSummary(t)).toMatchObject({ ok: true, value: { itemCount: 0 } });
  });
});

describe('the search and changes tools', () => {
  it('search the token\'s scopes only: a listed circle finds its facts, an unlisted one is the one not-found answer', async () => {
    const { w, ann, club, other } = await setup();
    const t = await w.bearer(ann, ['personal', `circle:${club}`]);
    expect(await w.view.read.searchFacts(t, { text: 'dentist tuesday' })).toMatchObject({ ok: true, value: { items: [{ id: 'n-own' }] } });
    expect(await w.view.read.searchFacts(t, { text: 'club meets', scope: circle(club) })).toMatchObject({ ok: true, value: { items: [{ id: 'n-club' }], scope: { circleName: 'Circle 1' } } });
    const outside = await w.view.read.searchFacts(t, { text: 'secret', scope: circle(other) });
    expect(outside).toMatchObject(NO_CIRCLE);
    expect(await w.view.read.changes(t, { since: 0, scope: circle(other) })).toEqual(outside);
    expect(await w.view.read.searchFacts(t, { text: 'secret', scope: circle(cid(99)) })).toEqual(outside);
  });

  it('are not signed in for a bad token, and write nothing', async () => {
    const { w, ann } = await setup();
    expect(await w.view.read.searchFacts('cpat_' + 'A'.repeat(43), { text: 'x' })).toMatchObject(NOT_SIGNED_IN);
    expect(await w.view.read.changes(undefined, { since: 0 })).toMatchObject(NOT_SIGNED_IN);
    const t = await w.bearer(ann, ['personal']);
    await w.view.read.searchFacts(t, { text: 'dentist' });
    await w.view.read.changes(t, { since: 0 });
    expect(w.writes).toEqual([]);
  });
});

describe('who a token is', () => {
  it('a live token gives its access; anything else gives nothing and every tool says not signed in', async () => {
    const { w, ann } = await setup();
    const t = await w.bearer(ann, ['personal'], true);
    expect(await w.view.access(t)).toMatchObject({ userId: ann.id, scopes: ['personal'], checks: true });
    const login = await w.controller.login({ username: 'ann', password: 'correct horse 7 staple' }, { clientKey: 'k' });
    const session = login.ok ? login.value.token : '';
    for (const bad of [undefined, null, 5, '', 'garbage', 'cpat_' + 'A'.repeat(43), session, `Bearer ${t}`]) {
      expect(await w.view.access(bad), String(bad)).toBeUndefined();
      expect(await w.view.read.summary(bad), String(bad)).toMatchObject(NOT_SIGNED_IN);
    }
  });

  it('a revoked token, an expired one and a token of a deleted account stop working at once', async () => {
    const { w, ann, bob } = await setup();
    const revoked = await w.bearer(ann, ['personal']);
    const expiring = await w.bearer(ann, ['personal'], false, 1);
    const gone = await w.bearer(bob, ['personal']);
    expect(await w.view.read.summary(revoked)).toMatchObject({ ok: true });
    await w.tokens.revokeAllFor(ann.id);
    expect(await w.view.read.summary(revoked)).toMatchObject(NOT_SIGNED_IN);
    expect(await w.view.read.summary(expiring)).toMatchObject(NOT_SIGNED_IN);
    await w.users.delete(bob.id);
    expect(await w.view.read.summary(gone)).toMatchObject(NOT_SIGNED_IN);
    expect(await w.view.access(gone)).toBeUndefined();
  });

  it('a token ends at its expiry time', async () => {
    const { w, ann } = await setup();
    const t = await w.bearer(ann, ['personal'], false, 2);
    w.now.value += 2 * DAY - 1;
    expect(await w.view.read.summary(t)).toMatchObject({ ok: true });
    w.now.value += 1;
    expect(await w.view.read.summary(t)).toMatchObject(NOT_SIGNED_IN);
  });
});

describe('the agent view cannot write', () => {
  it('exposes only reading methods, none of the capture ones', async () => {
    const { w } = await setup();
    expect(Object.keys(w.view.read).sort()).toEqual(['brainScopes', 'categories', 'categoryItems', 'item', 'ledger', 'mineCategories', 'mineCategoryItems', 'mineItem', 'mineSummary', 'searchFacts', 'changes', 'source', 'status', 'summary'].sort());
    for (const writer of ['propose', 'approve', 'reject', 'get', 'mode']) expect(writer in w.view.read, writer).toBe(false);
    expect(Object.isFrozen(w.view.read)).toBe(true);
    expect(Object.isFrozen(w.view)).toBe(true);
  });

  it('every tool, over every scope, calls no write primitive and leaves every graph as it was', async () => {
    const { w, ann, club, other } = await setup();
    const before = await Promise.all([userGraphId(ann.id), circleGraphId(club), circleGraphId(other)].map((g) => describeGraph(w.graphs, g)));
    const t = await w.bearer(ann, ['personal', `circle:${club}`]);
    for (const scope of [undefined, { kind: 'personal' }, circle(club), circle(other)]) {
      await w.view.read.summary(t, scope);
      await w.view.read.categories(t, undefined, scope);
      await w.view.read.categoryItems(t, 'health', undefined, scope);
      await w.view.read.item(t, 'n-own', scope);
      await w.view.read.ledger(t, scope);
      await w.view.read.source(t, { scope, id: 'n-own' });
    }
    await w.view.read.mineSummary(t);
    await w.view.read.mineCategories(t);
    await w.view.read.brainScopes(t);
    expect(w.writes).toEqual([]);
    const after = await Promise.all([userGraphId(ann.id), circleGraphId(club), circleGraphId(other)].map((g) => describeGraph(w.graphs, g)));
    expect(after).toEqual(before);
  });
});

describe('the checks tool', () => {
  const stub = {
    status: async () => ({ ok: true as const, value: { headline: 'Nothing needs you.', points: [], nothing: true, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub', attempts: 1 } }),
  };

  it('is refused for a token made without the checks flag, and runs for one made with it', async () => {
    const w = agentWorld({ llm: stub as never, checkTexts: { pulse: 'What needs my attention this week?' } });
    const ann = await w.register('ann');
    const without = await w.bearer(ann, ['personal'], false);
    const withChecks = await w.bearer(ann, ['personal'], true);
    expect(await w.view.read.status(without, { check: 'pulse' })).toMatchObject({ ok: false, error: { error: { code: 'NOT_FOUND', message: 'this token cannot run checks' } } });
    expect(await w.view.read.status(withChecks, { check: 'pulse' })).toMatchObject({ ok: true, value: { nothing: true } });
    expect(await w.view.read.status('cpat_' + 'A'.repeat(43), { check: 'pulse' })).toMatchObject(NOT_SIGNED_IN);
  });

  it('a checks token without the personal scope cannot ask a check about the personal brain by name', async () => {
    const w = agentWorld({ llm: stub as never, checkTexts: { pulse: 'What needs my attention this week?' } });
    const ann = await w.register('ann');
    const club = await w.circle(1, ann);
    const t = await w.bearer(ann, [`circle:${club}`], true);
    expect(await w.view.read.status(t, { check: 'pulse', scope: { kind: 'personal' } })).toMatchObject(NO_CIRCLE);
    expect(await w.view.read.status(t, { check: 'pulse', scope: circle(club) })).toMatchObject({ ok: true });
  });

  it('reads only the token\'s scopes when it asks for every brain', async () => {
    const seen: string[] = [];
    const llm = { status: async (input: { entries: ReadonlyArray<{ text: string }> }) => (seen.push(...input.entries.map((e) => e.text)), stub.status()) };
    const w = agentWorld({ llm: llm as never, checkTexts: { pulse: 'What needs my attention this week?' } });
    const ann = await w.register('ann');
    const club = await w.circle(1, ann);
    const other = await w.circle(2, ann);
    await w.note(userGraphId(ann.id), 'n-own', 'Own thing', 'a');
    await w.note(circleGraphId(club), 'n-club', 'Club thing', 'b');
    await w.note(circleGraphId(other), 'n-other', 'Other thing', 'c');
    const t = await w.bearer(ann, [`circle:${club}`], true);
    expect(await w.view.read.status(t, { check: 'pulse' })).toMatchObject({ ok: true });
    expect(seen.join('\n')).toContain('Club thing');
    expect(seen.join('\n')).not.toContain('Own thing');
    expect(seen.join('\n')).not.toContain('Other thing');
  });
});
