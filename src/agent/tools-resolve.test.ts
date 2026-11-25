import { describe, expect, it } from 'vitest';
import { createController } from '../app/index.js';
import { defaultVerbs } from '../caci/index.js';
import { query } from '../graph_store/index.js';
import { createMemoryResolutionStore } from '../resolutions/index.js';
import { circleGraphId } from '../scopes/index.js';
import { userGraphId } from '../users/index.js';
import { agentWorld, cid } from './agent.test-util.js';
import { createAgentTools, type AgentToolOutcome } from './tools.js';
import { ownBrainOnly } from './view.js';

// R-025 D13 (VR-FR-10, VR-AC-08): three verb tools, offered only to a token made with the resolve flag, limited to its scopes, writing only the
// person's own resolution record (or deleting a fact in their own brain for `clear`), never a circle's notes, and never the verb `remove`.

const result = (o: AgentToolOutcome) => {
  if (o.kind !== 'result') throw new Error(`expected a result, got ${o.kind}`);
  return o.result;
};
const data = (o: AgentToolOutcome): any => result(o).data; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup() {
  const resolutions = createMemoryResolutionStore();
  const holder: { w?: ReturnType<typeof agentWorld> } = {};
  const capture = (adapter: Parameters<typeof createController>[0]['adapter']) => createController({ adapter, llm: { categorise: async () => { throw new Error('the model is not used to remove a fact'); } } as never });
  const w = agentWorld({
    verbs: defaultVerbs(),
    resolutions,
    removeFact: (graphId, id) => capture(holder.w?.graphs as never).remove(graphId, id),
  });
  holder.w = w;
  const ann = await w.register('ann');
  const bob = await w.register('bob');
  const club = await w.circle(1, ann, [[bob, 'member']]);
  const other = await w.circle(2, ann, [[bob, 'member']]);
  await w.note(userGraphId(bob.id), 'own-1', 'Dentist on Tuesday', 'health', 'Health');
  await w.note(circleGraphId(club), 'yoga-1', 'Pay for this week yoga', 'yoga', 'Yoga');
  await w.note(circleGraphId(other), 'bins-1', 'Bins on Thursday', 'bins', 'Bins');
  return { w, ann, bob, club, other, resolutions, tools: createAgentTools(w.view) };
}
const nodes = async (w: Awaited<ReturnType<typeof setup>>['w'], graphId: string): Promise<string[]> => {
  const r = await query(w.graphs, { version: 1, graphId, from: { all: true }, return: { shape: 'nodes', includeData: false }, page: { limit: 100 } } as never);
  return r.ok ? (r.value as { nodes: Array<{ partition: string; id: string }> }).nodes.map((n) => `${n.partition}:${n.id}`).sort() : ['error'];
};
const NAMES = ['resolve_fact', 'unresolve_fact', 'resolutions'];

describe('which tokens are offered the verb tools', () => {
  it('only a token with the resolve flag, after the read tools and the checks tool', async () => {
    const { w, bob, tools } = await setup();
    const plain = await tools.list(await w.bearer(bob, ['personal']));
    expect(plain?.map((t) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes']);
    const resolving = await tools.list(await w.bearer(bob, ['personal'], false, 90, true));
    expect(resolving?.map((t) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes', ...NAMES]);
    const both = await tools.list(await w.bearer(bob, ['personal'], true, 90, true));
    expect(both?.map((t) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes', 'pulse', ...NAMES]);
    for (const t of (resolving ?? []).filter((x) => NAMES.includes(x.name))) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('a token without the flag is told the tool does not exist, for every verb tool, and nothing is written', async () => {
    const { w, bob, club, tools, resolutions } = await setup();
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`]);
    for (const name of NAMES) expect(await tools.call(bearer, name, { scope: `circle:${club}`, id: 'yoga-1', verb: 'pay' }), name).toEqual({ kind: 'unknown-tool' });
    expect(await resolutions.count(bob.id)).toBe(0);
  });
});

describe('resolve_fact', () => {
  it('hides a circle fact for the person only and changes nothing in the circle (VR-AC-08)', async () => {
    const { w, ann, bob, club, tools, resolutions } = await setup();
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`], false, 90, true);
    const before = await nodes(w, circleGraphId(club));
    w.writes.length = 0;
    const out = data(await tools.call(bearer, 'resolve_fact', { scope: `circle:${club}`, id: 'yoga-1', verb: 'pay' }));
    expect(out).toEqual({ scope: `circle:${club}`, id: 'yoga-1', verb: 'pay', result: "hidden from the person's own checks" });
    expect(await nodes(w, circleGraphId(club))).toEqual(before);
    expect(w.writes).toEqual([]);
    expect(await resolutions.get(bob.id, { kind: 'circle', circleId: club }, 'yoga-1')).toMatchObject({ verb: 'pay' });
    expect(await resolutions.count(ann.id)).toBe(0);
  });

  it('clear in the person\'s own brain deletes the fact there, and only there', async () => {
    const { w, bob, club, tools } = await setup();
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`], false, 90, true);
    expect(data(await tools.call(bearer, 'resolve_fact', { scope: 'personal', id: 'own-1', verb: 'clear' })).result).toBe('the fact was deleted from the notes');
    expect(await nodes(w, userGraphId(bob.id))).toEqual([]);
    expect(await nodes(w, circleGraphId(club))).toEqual(['category:yoga', 'item:yoga-1']);
  });

  it('the verb remove is refused for an agent, in every brain, and nothing is deleted', async () => {
    const { w, ann, bob, club, tools } = await setup();
    const owner = await w.bearer(ann, ['personal', `circle:${club}`], false, 90, true);
    const own = await w.bearer(bob, ['personal'], false, 90, true);
    for (const [bearer, scope, id] of [[owner, `circle:${club}`, 'yoga-1'], [own, 'personal', 'own-1']] as const) {
      const r = result(await tools.call(bearer, 'resolve_fact', { scope, id, verb: 'remove' }));
      expect(r.isError).toBe(true);
      expect(r.text).toContain('cannot remove');
    }
    expect(await nodes(w, circleGraphId(club))).toEqual(['category:yoga', 'item:yoga-1']);
    expect(await nodes(w, userGraphId(bob.id))).toEqual(['category:health', 'item:own-1']);
  });

  it('a brain the token does not list is the same "no such circle" a stranger gets, for read and verb tools alike', async () => {
    const { w, bob, club, other, tools, resolutions } = await setup();
    const bearer = await w.bearer(bob, [`circle:${club}`], false, 90, true); // no personal, and not `other`
    const unlisted = result(await tools.call(bearer, 'resolve_fact', { scope: `circle:${other}`, id: 'bins-1', verb: 'pay' }));
    const madeUp = result(await tools.call(bearer, 'resolve_fact', { scope: `circle:${cid(9)}`, id: 'bins-1', verb: 'pay' }));
    const personal = result(await tools.call(bearer, 'resolve_fact', { scope: 'personal', id: 'own-1', verb: 'clear' }));
    for (const r of [unlisted, madeUp, personal]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain('no such circle');
    }
    expect(unlisted.text).toBe(madeUp.text);
    expect(await resolutions.count(bob.id)).toBe(0);
    expect(await nodes(w, userGraphId(bob.id))).toEqual(['category:health', 'item:own-1']);
  });

  it('a person who left the circle can no longer resolve in it, and a made-up fact is not found', async () => {
    const { w, bob, club, tools } = await setup();
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`], false, 90, true);
    expect(result(await tools.call(bearer, 'resolve_fact', { scope: `circle:${club}`, id: 'nope', verb: 'pay' })).text).toContain('no such fact');
    await w.circles.removeMember(club, bob.id);
    expect(result(await tools.call(bearer, 'resolve_fact', { scope: `circle:${club}`, id: 'yoga-1', verb: 'pay' })).text).toContain('no such circle');
  });

  it('refuses unknown arguments, a missing scope, id or verb and an unknown verb, each plainly', async () => {
    const { w, bob, club, tools } = await setup();
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`], false, 90, true);
    const say = async (args: unknown): Promise<string> => result(await tools.call(bearer, 'resolve_fact', args)).text;
    expect(await say({ scope: 'personal', id: 'x', verb: 'pay', extra: 1 })).toContain('extra is not an argument');
    expect(await say({ id: 'x', verb: 'pay' })).toContain('scope is required');
    expect(await say({ scope: 'personal', verb: 'pay' })).toContain('id must be some text');
    expect(await say({ scope: 'personal', id: 'x' })).toContain('verb must be some text');
    expect(await say({ scope: 'personal', id: 'x', verb: 'dance' })).toContain('no such verb');
    expect(await say('x')).toContain('must be an object');
  });
});

describe('unresolve_fact and resolutions', () => {
  it('takes back a resolution, and lists only the person\'s own, within the token\'s scopes, without words', async () => {
    const { w, ann, bob, club, other, tools } = await setup();
    const wide = await w.bearer(bob, ['personal', `circle:${club}`, `circle:${other}`], false, 90, true);
    const narrow = await w.bearer(bob, [`circle:${club}`], false, 90, true);
    await tools.call(wide, 'resolve_fact', { scope: `circle:${club}`, id: 'yoga-1', verb: 'pay' });
    await tools.call(wide, 'resolve_fact', { scope: `circle:${other}`, id: 'bins-1', verb: 'clear' });
    const annBearer = await w.bearer(ann, ['personal', `circle:${club}`], false, 90, true);
    await tools.call(annBearer, 'resolve_fact', { scope: `circle:${club}`, id: 'yoga-1', verb: 'clear' });
    const listed = data(await tools.call(wide, 'resolutions', {}));
    expect(listed.resolutions.map((r: { scope: string; id: string; verb: string }) => `${r.scope} ${r.id} ${r.verb}`).sort()).toEqual([`circle:${club} yoga-1 pay`, `circle:${other} bins-1 clear`].sort());
    expect(JSON.stringify(listed)).not.toContain('Pay for');
    // the narrow token sees only the circle it lists: the other record is not shown to it
    expect(data(await tools.call(narrow, 'resolutions', {})).resolutions.map((r: { id: string }) => r.id)).toEqual(['yoga-1']);
    // taking back
    expect(data(await tools.call(wide, 'unresolve_fact', { scope: `circle:${club}`, id: 'yoga-1' }))).toEqual({ id: 'yoga-1', resolved: false });
    expect(data(await tools.call(wide, 'unresolve_fact', { scope: `circle:${club}`, id: 'yoga-1' }))).toEqual({ id: 'yoga-1', resolved: false });
    expect(data(await tools.call(wide, 'resolutions', {})).resolutions).toHaveLength(1);
    // an unlisted brain cannot be unresolved through the narrow token
    expect(result(await tools.call(narrow, 'unresolve_fact', { scope: `circle:${other}`, id: 'bins-1' })).text).toContain('no such circle');
    expect(data(await tools.call(wide, 'resolutions', {})).resolutions).toHaveLength(1);
  });

  it('pages: next is given back as after_scope and after_id, and half a cursor is refused', async () => {
    const { w, bob, club, tools } = await setup();
    for (const id of ['a', 'b', 'c']) await w.note(circleGraphId(club), id, `Fact ${id}`, 'misc', 'Misc');
    const bearer = await w.bearer(bob, ['personal', `circle:${club}`], false, 90, true);
    for (const id of ['a', 'b', 'c']) await tools.call(bearer, 'resolve_fact', { scope: `circle:${club}`, id, verb: 'clear' });
    const first = data(await tools.call(bearer, 'resolutions', { limit: 2 }));
    expect(first.resolutions.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(first.next).toEqual({ after_scope: `circle:${club}`, after_id: 'b' });
    const second = data(await tools.call(bearer, 'resolutions', { limit: 2, ...first.next }));
    expect(second.resolutions.map((r: { id: string }) => r.id)).toEqual(['c']);
    expect(second.next).toBeUndefined();
    expect(result(await tools.call(bearer, 'resolutions', { after_id: 'b' })).text).toContain('after_scope and after_id together');
    expect(result(await tools.call(bearer, 'resolutions', { limit: 0 })).isError).toBe(true);
  });

  it('an expired or revoked token is unauthenticated for these tools too', async () => {
    const { w, bob, tools } = await setup();
    const bearer = await w.bearer(bob, ['personal'], false, 1, true);
    w.now.value += 2 * 86_400_000;
    expect(await tools.call(bearer, 'resolutions', {})).toEqual({ kind: 'unauthenticated' });
    expect(await tools.list(bearer)).toBeUndefined();
  });
});

describe('the one delete an agent can make', () => {
  it('reaches only a graph named for a person, and never a circle\'s', async () => {
    const seen: string[] = [];
    const guarded = ownBrainOnly(async (graphId, id) => (seen.push(`${graphId}/${id}`), { ok: true, value: null }));
    expect(await guarded(`user-${'u0000000000000001'}`, 'a')).toEqual({ ok: true, value: null });
    for (const graphId of [`circle-${cid(1)}`, 'graph', '', 'users-x', 'User-u1', 5 as unknown as string]) await expect(guarded(graphId, 'a'), String(graphId)).rejects.toThrow('cannot change a circle brain');
    expect(seen).toEqual(['user-u0000000000000001/a']);
  });
});
