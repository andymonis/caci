import { describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { createCaciController, viewOf } from './index.js';
import { describeGraph, query, write } from '../graph_store/index.js';
import { createDemoModelClient, createLlm } from '../llm/index.js';
import { ownErrorOf, world, type World } from './controller.test-util.js';
import type { ModelClient } from '../llm/index.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';

const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
const PEOPLE = ['ann', 'bob', 'cat', 'dan', 'eve'];
const setup = async (extra: Parameters<typeof world>[0] = {}) => world({ people: PEOPLE, ...extra });
const circleScope = (circleId: string) => ({ kind: 'circle', circleId });
const items = async (w: World, graphId: string): Promise<number> => {
  const r = await describeGraph(w.graphs, graphId);
  return r.ok ? r.value.itemCount : -1;
};
const NO_CIRCLE = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };
const NO_PROPOSAL = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such proposal' } };
const NOTE = 'Dr Patel booked my blood test';
const seed = async (w: World, graphId: string, categories: Record<string, string>) => {
  const ops = Object.entries(categories).map(([id, name]) => ({ op: 'upsertNode', partition: 'category', id, data: { name } }));
  must(await write(w.graphs, { version: 1, kind: 'mutation', graphId, ops } as never));
};

describe('no scope, or the personal scope: nothing changes from R-003', () => {
  it('a proposal without a scope, and with the personal scope, has no scope key and writes to the personal graph only', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    for (const input of [{ text: NOTE }, { text: NOTE, scope: undefined }, { text: NOTE, scope: { kind: 'personal' } }]) {
      const made = must(await w.caci.propose(w.tokens.ann, input as never));
      expect(Object.keys(made).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'mode', 'operations', 'rationale', 'summary', 'text'].sort());
      must(await w.caci.approve(w.tokens.ann, made.id));
    }
    expect(await items(w, w.graphIds.ann as string)).toBe(3);
    expect(await items(w, `circle-${c}`)).toBe(0);
  });
});

describe('a circle scope', () => {
  it('a member proposes into the circle: the view names it, nothing is written until approval, and approval writes to that circle graph only', async () => {
    const w = await setup();
    const a = await w.circle(1, 'ann', [['bob', 'member']]);
    const b = await w.circle(2, 'ann');
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(a) }));
    expect(made.scope).toEqual({ kind: 'circle', circleId: a, circleName: 'Circle 1' });
    expect(JSON.stringify(made)).not.toContain('circle-c');
    expect(JSON.stringify(made)).not.toContain('user-u');
    expect(await items(w, `circle-${a}`)).toBe(0);
    expect(must(await w.caci.get(w.tokens.bob, made.id))).toEqual(made);
    const done = must(await w.caci.approve(w.tokens.bob, made.id));
    expect(done.applied).toBeGreaterThan(0);
    expect(await items(w, `circle-${a}`)).toBe(1);
    expect(await items(w, `circle-${b}`)).toBe(0);
    expect(await items(w, w.graphIds.bob as string)).toBe(0);
    expect(await items(w, w.graphIds.ann as string)).toBe(0);
  });

  it('owner, manager and member may capture; an observer, a stranger, and a made-up circle all get the identical answer and no model call', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'manager'], ['cat', 'member'], ['dan', 'observer']]);
    for (const who of ['ann', 'bob', 'cat']) expect((await w.caci.propose(w.tokens[who], { text: NOTE, scope: circleScope(c) })).ok, who).toBe(true);
    const calls = w.modelCalls.length;
    const answers = [
      await w.caci.propose(w.tokens.dan, { text: NOTE, scope: circleScope(c) }),
      await w.caci.propose(w.tokens.eve, { text: NOTE, scope: circleScope(c) }),
      await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope('c9999999999999999') }),
    ];
    for (const a of answers) expect(a).toEqual({ ok: false, error: NO_CIRCLE });
    // a circle id that does not even have the right shape is refused as input, the same for everyone
    expect(ownErrorOf(await w.caci.propose(w.tokens.dan, { text: NOTE, scope: circleScope(c.toUpperCase()) }))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.circleId' });
    expect(w.modelCalls.length).toBe(calls);
  });

  it('a malformed scope is refused naming its field, before any model call', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    const field = async (scope: unknown) => ownErrorOf(await w.caci.propose(w.tokens.ann, { text: NOTE, scope } as never));
    expect(await field('circle')).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(await field({ kind: 'mine' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope' });
    expect(await field({ kind: 'circle', circleId: 'x' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.circleId' });
    expect(await field({ kind: 'circle', circleId: c, graphId: 'user-u1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.graphId' });
    expect(await field({ kind: 'personal', userId: 'u1' })).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.userId' });
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: NOTE, graphId: 'x' } as never))).toMatchObject({ code: 'INVALID_INPUT', field: 'graphId' });
    expect(w.modelCalls).toHaveLength(0);
  });

  it('a bad note is refused before the scope is looked at, and a signed-out caller is unauthenticated', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: '  ', scope: circleScope('nope') } as never))).toMatchObject({ code: 'INVALID_INPUT', field: 'text' });
    expect(ownErrorOf(await w.caci.propose('nope', { text: NOTE, scope: circleScope(c) }))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('without a scope resolver only personal works: a circle is simply not found', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    const capture = createController({ adapter: w.graphs, llm: createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() }) });
    const bare = createCaciController({ users: w.users, capture, graphAdapter: w.graphs });
    expect(await bare.propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) })).toEqual({ ok: false, error: NO_CIRCLE });
    expect((await bare.propose(w.tokens.ann, { text: NOTE })).ok).toBe(true);
  });

  it('several members capture into the same circle and everything lands in its one graph', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'manager']]);
    const made = await Promise.all(['ann', 'bob', 'cat'].map((who, i) => w.caci.propose(w.tokens[who], { text: `${NOTE} ${i}`, scope: circleScope(c) })));
    for (const [i, m] of made.entries()) must(await w.caci.approve(w.tokens[['ann', 'bob', 'cat'][i] as string], must(m).id));
    expect(await items(w, `circle-${c}`)).toBe(3);
  });
});

describe('the proposal is bound to its scope when it is made', () => {
  it('two proposals for two circles each land in their own circle, whatever order they are approved in, and a scope sent at approval is ignored', async () => {
    const w = await setup();
    const a = await w.circle(1, 'ann');
    const b = await w.circle(2, 'ann');
    const pa = must(await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope(a) }));
    const pb = must(await w.caci.propose(w.tokens.ann, { text: `${NOTE} again`, scope: circleScope(b) }));
    const approve = w.caci.approve as unknown as (t: unknown, id: unknown, extra: unknown) => ReturnType<typeof w.caci.approve>;
    must(await approve(w.tokens.ann, pb.id, { scope: circleScope(a) }));
    must(await w.caci.approve(w.tokens.ann, pa.id));
    expect(await items(w, `circle-${a}`)).toBe(1);
    expect(await items(w, `circle-${b}`)).toBe(1);
    expect(await items(w, w.graphIds.ann as string)).toBe(0);
  });

  it('another member of the circle, an admin and a stranger cannot see, approve or reject someone else\'s circle proposal', async () => {
    const w = await setup({ people: ['root', 'ann', 'bob', 'cat'] });
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) }));
    for (const who of ['bob', 'cat', 'root']) {
      expect(await w.caci.get(w.tokens[who], made.id), who).toEqual({ ok: false, error: NO_PROPOSAL });
      expect(await w.caci.approve(w.tokens[who], made.id), who).toEqual({ ok: false, error: NO_PROPOSAL });
      expect(await w.caci.reject(w.tokens[who], made.id), who).toEqual({ ok: false, error: NO_PROPOSAL });
    }
    expect(await items(w, `circle-${c}`)).toBe(0);
  });

  it('losing the right to capture before approval writes nothing, discards the proposal and frees its place', async () => {
    for (const lose of ['removed', 'observer', 'circle deleted'] as const) {
      const w = await setup({ limits: { maxPendingPerUser: 1 } });
      const c = await w.circle(1, 'ann', [['bob', 'member']]);
      const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
      const bobId = (w.graphIds.bob as string).slice(5);
      if (lose === 'removed') must(await w.circleStore.removeMember(c, bobId));
      else if (lose === 'observer') must(await w.circleStore.changeRole(c, bobId, 'observer'));
      else await w.circleStore.deleteCircle(c);
      expect(await w.caci.approve(w.tokens.bob, made.id), lose).toEqual({ ok: false, error: NO_PROPOSAL });
      expect(await items(w, `circle-${c}`), lose).toBe(0);
      expect(await w.caci.approve(w.tokens.bob, made.id), lose).toEqual({ ok: false, error: NO_PROPOSAL });
      expect((await w.caci.propose(w.tokens.bob, { text: NOTE })).ok, `${lose}: the place is free`).toBe(true);
    }
  });

  it('the preview of a proposal whose circle access is gone is not shown either', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    must(await w.circleStore.removeMember(c, (w.graphIds.bob as string).slice(5)));
    expect(await w.caci.get(w.tokens.bob, made.id)).toEqual({ ok: false, error: NO_PROPOSAL });
  });

  it('a person may still reject their own proposal after losing access', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    must(await w.circleStore.removeMember(c, (w.graphIds.bob as string).slice(5)));
    expect(must(await w.caci.reject(w.tokens.bob, made.id)).id).toBe(made.id);
  });

  it('a change of role that still allows capture changes nothing; a promotion works too', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'manager']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    must(await w.circleStore.changeRole(c, (w.graphIds.bob as string).slice(5), 'member'));
    must(await w.caci.approve(w.tokens.bob, made.id));
    expect(await items(w, `circle-${c}`)).toBe(1);
  });

  it('a membership check that fails at approval keeps the proposal pending, writes nothing, and works when the store is back', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    const real = w.circleStore.membershipOf.bind(w.circleStore);
    w.circleStore.membershipOf = async () => {
      throw new Error('disk exploded at /secret');
    };
    const failed = await w.caci.approve(w.tokens.bob, made.id);
    expect(failed).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(await items(w, `circle-${c}`)).toBe(0);
    w.circleStore.membershipOf = real;
    must(await w.caci.approve(w.tokens.bob, made.id));
    expect(await items(w, `circle-${c}`)).toBe(1);
  });

  it('a store failure while making a proposal is the fixed storage error and no model call is made', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    w.circleStore.membershipOf = async () => {
      throw new Error('boom');
    };
    expect(await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) })).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(w.modelCalls).toHaveLength(0);
  });
});

describe('what the model is shown', () => {
  it('each proposal\'s prompt holds only the categories of its own scope', async () => {
    const w = await setup();
    const a = await w.circle(1, 'ann');
    const b = await w.circle(2, 'ann');
    await seed(w, w.graphIds.ann as string, { 'personal-x': 'PERSONALMARK' });
    await seed(w, `circle-${a}`, { 'alpha-x': 'ALPHAMARK' });
    await seed(w, `circle-${b}`, { 'bravo-x': 'BRAVOMARK' });
    const text = (calls: number): string => JSON.stringify(w.modelCalls.slice(calls).map((c) => c.messages));
    const marks = ['PERSONALMARK', 'ALPHAMARK', 'BRAVOMARK'];
    const ask = async (scope: unknown, mine: string) => {
      const before = w.modelCalls.length;
      must(await w.caci.propose(w.tokens.ann, { text: NOTE, scope } as never));
      expect(w.modelCalls.length).toBeGreaterThan(before);
      const sent = text(before);
      expect(sent).toContain(mine);
      for (const other of marks.filter((m) => m !== mine)) expect(sent, `${mine} prompt must not hold ${other}`).not.toContain(other);
    };
    await ask(undefined, 'PERSONALMARK');
    await ask({ kind: 'personal' }, 'PERSONALMARK');
    await ask(circleScope(a), 'ALPHAMARK');
    await ask(circleScope(b), 'BRAVOMARK');
  });
});

describe('limits are per account across scopes', () => {
  it('a circle proposal and a personal one use the same pending places and the same hourly count', async () => {
    const w = await setup({ limits: { maxPendingPerUser: 2, proposalsPerHour: 3 } });
    const c = await w.circle(1, 'ann');
    must(await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) }));
    must(await w.caci.propose(w.tokens.ann, { text: NOTE }));
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) }))).toMatchObject({ code: 'TOO_MANY_PENDING' });
    expect(ownErrorOf(await w.caci.propose(w.tokens.ann, { text: NOTE }))).toMatchObject({ code: 'TOO_MANY_PENDING' });
  });
});

describe('how scope problems are put', () => {
  it('a resolver that answers with each kind of failure is turned into this controller\'s words', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann');
    const capture = createController({ adapter: w.graphs, llm: createLlm({ controls: SHIPPED_CONTROLS, client: createDemoModelClient() }) });
    const answering = (error: { code: string; message: string; field?: string }) =>
      createCaciController({ users: w.users, capture, graphAdapter: w.graphs, scopes: { who: async () => ({ ok: true, value: 'x' }), resolve: async () => ({ ok: false, error }) } as never });
    const ask = (error: { code: string; message: string; field?: string }) => answering(error).propose(w.tokens.ann, { text: NOTE, scope: circleScope(c) });
    expect(await ask({ code: 'UNAUTHENTICATED', message: 'not signed in' })).toMatchObject({ ok: false, error: { source: 'caci', error: { code: 'UNAUTHENTICATED' } } });
    expect(await ask({ code: 'NOT_FOUND', message: 'whatever the resolver said' })).toEqual({ ok: false, error: NO_CIRCLE });
    expect(await ask({ code: 'STORAGE_ERROR', message: 'disk /secret' })).toMatchObject({ ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR' } } });
    expect(ownErrorOf(await ask({ code: 'INVALID_INPUT', message: 'x', field: 'circleId' }))).toMatchObject({ code: 'INVALID_INPUT', field: 'scope.circleId' });
  });

  it('viewOf shows no scope for a personal one and the circle for a circle', () => {
    const proposal = { id: 'p', createdAt: 1, expiresAt: 2, text: 't', summary: {}, mutation: { ops: [] } } as never;
    expect('scope' in viewOf(proposal, 'demo', { kind: 'personal' })).toBe(false);
    expect('scope' in viewOf(proposal, 'demo')).toBe(false);
    expect(viewOf(proposal, 'demo', { kind: 'circle', circleId: 'c', circleName: 'N' }).scope).toEqual({ kind: 'circle', circleId: 'c', circleName: 'N' });
  });
});

describe('contribution metadata', () => {
  const dataOf = async (w: World, graphId: string): Promise<Array<{ id: string; partition: string; data?: Record<string, unknown> }>> => {
    const r = await query(w.graphs, { version: 1, graphId, from: { all: true }, return: { shape: 'nodes', includeData: true } });
    return r.ok ? ((r.value as { nodes: Array<{ id: string; partition: string; data?: Record<string, unknown> }> }).nodes) : [];
  };
  /** A model that tries to forge the contribution fields on every node it creates. */
  const forging = (): ModelClient => {
    const inner = createDemoModelClient();
    return {
      complete: async (request) => {
        const r = await inner.complete(request);
        if (!r.ok || r.value.output.kind !== 'json') return r;
        const value = JSON.parse(JSON.stringify(r.value.output.value)) as { ops: Array<{ op: string; data?: Record<string, unknown> }> };
        for (const op of value.ops) if (op.op === 'upsertNode') op.data = { ...(op.data ?? {}), contributedBy: 'u-forged', contributedAt: 1 };
        return { ok: true, value: { ...r.value, output: { kind: 'json', value } } } as never;
      },
    };
  };

  it('an item captured into a circle records who added it and when; a personal capture records nothing of the kind', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    w.now.value += 5000;
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    const upsertItem = (made.operations as Array<{ op: string; partition?: string; data?: Record<string, unknown> }>).find((o) => o.op === 'upsertNode' && o.partition === 'item');
    expect(upsertItem?.data).toMatchObject({ contributedBy: (w.graphIds.bob as string).slice(5) });
    const links = (made.operations as Array<{ op: string; data?: unknown }>).filter((o) => o.op === 'link');
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect('data' in l).toBe(false);
    must(await w.caci.approve(w.tokens.bob, made.id));
    const stored = (await dataOf(w, `circle-${c}`)).filter((n) => n.partition === 'item');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.data).toMatchObject({ contributedBy: (w.graphIds.bob as string).slice(5), contributedAt: expect.any(Number) });
    expect(stored[0]?.data?.contributedAt).toBeGreaterThan(1_700_000_000_000);
    const mine = must(await w.caci.propose(w.tokens.bob, { text: NOTE }));
    must(await w.caci.approve(w.tokens.bob, mine.id));
    const personal = (await dataOf(w, w.graphIds.bob as string)).filter((n) => n.partition === 'item');
    expect(personal[0]?.data).not.toHaveProperty('contributedBy');
    expect(personal[0]?.data).not.toHaveProperty('contributedAt');
  });

  it('whatever the model puts under those names, on any node, is replaced or removed: it cannot forge them', async () => {
    const w = await setup({ client: forging() });
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    must(await w.caci.approve(w.tokens.bob, made.id));
    const nodes = await dataOf(w, `circle-${c}`);
    const item = nodes.find((n) => n.partition === 'item');
    expect(item?.data?.contributedBy).toBe((w.graphIds.bob as string).slice(5));
    expect(item?.data?.contributedAt).not.toBe(1);
    for (const n of nodes.filter((x) => x.partition === 'category')) {
      expect(n.data ?? {}).not.toHaveProperty('contributedBy');
      expect(n.data ?? {}).not.toHaveProperty('contributedAt');
    }
    // a personal capture does not stamp, and does not clean what the model wrote either: it is the person's own graph and the model's data
    const mine = must(await w.caci.propose(w.tokens.bob, { text: NOTE }));
    expect(JSON.stringify(mine.operations)).toContain('u-forged');
  });

  it('records stay when the contributor\'s access ends: leaving does not touch the circle graph', async () => {
    const w = await setup();
    const c = await w.circle(1, 'ann', [['bob', 'member']]);
    const made = must(await w.caci.propose(w.tokens.bob, { text: NOTE, scope: circleScope(c) }));
    must(await w.caci.approve(w.tokens.bob, made.id));
    must(await w.circleStore.removeMember(c, (w.graphIds.bob as string).slice(5)));
    const left = (await dataOf(w, `circle-${c}`)).filter((n) => n.partition === 'item');
    expect(left).toHaveLength(1);
    expect(left[0]?.data?.contributedBy).toBe((w.graphIds.bob as string).slice(5));
  });
});

