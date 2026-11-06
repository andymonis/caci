import { describe, expect, it } from 'vitest';
import { write } from '../graph_store/index.js';
import { circleGraphId } from '../scopes/index.js';
import { userGraphId } from '../users/index.js';
import { agentWorld, cid, T0 } from './agent.test-util.js';
import { createAgentTools, MAX_TOOL_RESULT_CHARS, type AgentToolOutcome } from './tools.js';

const asResult = (o: AgentToolOutcome) => {
  if (o.kind !== 'result') throw new Error(`expected a result, got ${o.kind}`);
  return o.result;
};
const data = (o: AgentToolOutcome): any => asResult(o).data; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup(extra: Parameters<typeof agentWorld>[0] = {}) {
  const w = agentWorld(extra);
  const ann = await w.register('ann');
  const bob = await w.register('bob');
  const club = await w.circle(1, ann, [[bob, 'member']]);
  await w.note(userGraphId(ann.id), 'n-own', 'Dentist on Tuesday', 'health', 'Health');
  await w.note(circleGraphId(club), 'n-club', 'Club meets Wednesday', 'meetings', 'Meetings');
  const tools = createAgentTools(w.view);
  return { w, ann, bob, club, tools };
}

describe('which tools a token is offered', () => {
  it('five read tools for an ordinary token, and the model-using pulse only with the checks flag', async () => {
    const { w, ann, tools } = await setup();
    const plain = await tools.list(await w.bearer(ann, ['personal']));
    expect(plain?.map((t) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes']);
    const checks = await tools.list(await w.bearer(ann, ['personal'], true));
    expect(checks?.map((t) => t.name)).toEqual(['list_brains', 'search_facts', 'get_fact', 'browse', 'changes', 'pulse']);
    for (const bad of [undefined, 'garbage', 'cpat_' + 'A'.repeat(43), 5]) expect(await tools.list(bad)).toBeUndefined();
  });

  it('every tool has a name, a title, a description and a closed object schema, and no tool writes', async () => {
    const { w, ann, tools } = await setup();
    const all = (await tools.list(await w.bearer(ann, ['personal'], true))) ?? [];
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
    for (const t of all) {
      expect(t.title.length, t.name).toBeGreaterThan(2);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.name).not.toMatch(/file|write|propose|approve|reject|delete|create|update/);
    }
  });

  it('a call to pulse without the flag, and to a tool that does not exist, is an unknown tool; a bad token is unauthenticated', async () => {
    const { w, ann, tools } = await setup();
    const t = await w.bearer(ann, ['personal']);
    for (const name of ['pulse', 'file_note', 'propose', '', 5, null, undefined, '__proto__', 'constructor', 'toString']) expect(await tools.call(t, name, {}), String(name)).toEqual({ kind: 'unknown-tool' });
    expect(await tools.call('cpat_' + 'A'.repeat(43), 'list_brains', {})).toEqual({ kind: 'unauthenticated' });
    expect(await tools.call(undefined, 'nope', {})).toEqual({ kind: 'unauthenticated' });
  });
});

describe('list_brains', () => {
  it('names the brains the token covers, with the person\'s role, and nothing it does not cover', async () => {
    const { w, ann, bob, club, tools } = await setup();
    await w.circle(2, ann);
    const t = await w.bearer(bob, ['personal', `circle:${club}`]);
    expect(data(await tools.call(t, 'list_brains', {}))).toEqual({ brains: [{ scope: 'personal', name: 'Your own notes' }, { scope: `circle:${club}`, name: 'Circle 1', role: 'member' }] });
    const circleOnly = await w.bearer(ann, [`circle:${club}`]);
    expect(data(await tools.call(circleOnly, 'list_brains', undefined)).brains).toEqual([{ scope: `circle:${club}`, name: 'Circle 1', role: 'owner' }]);
  });
});

describe('search_facts', () => {
  it('finds facts in one brain, with the brain named, and who entered them in a circle', async () => {
    const { w, ann, bob, club, tools } = await setup();
    w.now.value = T0 + 5000;
    // a fact with a stamp, as an approved circle note would have
    await write(w.graphs, { version: 1, kind: 'mutation', graphId: circleGraphId(club), ops: [{ op: 'upsertNode', partition: 'item', id: 'n-stamped', data: { title: 'Picnic on Saturday', summary: 'Bring food', contributedBy: bob.id, contributedAt: T0 + 3000 } }, { op: 'link', item: 'n-stamped', category: 'meetings' }] } as never);
    const t = await w.bearer(ann, ['personal', `circle:${club}`]);
    const out = data(await tools.call(t, 'search_facts', { scope: `circle:${club}`, text: 'picnic saturday' }));
    expect(out.brain).toEqual({ scope: `circle:${club}`, name: 'Circle 1' });
    expect(out.facts).toEqual([{ id: 'n-stamped', title: 'Picnic on Saturday', summary: 'Bring food', entered_at: new Date(T0 + 3000).toISOString(), entered_by: { username: 'bob', display_name: 'Display bob' } }]);
    expect(data(await tools.call(t, 'search_facts', { scope: 'personal', text: 'dentist' })).facts).toMatchObject([{ id: 'n-own' }]);
    expect(data(await tools.call(t, 'search_facts', { scope: 'personal', text: 'volcano' })).facts).toEqual([]);
  });

  it('needs a scope, and says what is wrong with an argument by name', async () => {
    const { w, ann, tools } = await setup();
    const t = await w.bearer(ann, ['personal']);
    const problem = async (args: unknown, expected: RegExp) => {
      const r = asResult(await tools.call(t, 'search_facts', args));
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toMatch(expected);
    };
    await problem({ text: 'x' }, /scope is required/);
    await problem({ scope: 'mine', text: 'x' }, /scope must be/);
    await problem({ scope: 'circle:abc', text: 'x' }, /scope must be/);
    await problem({ scope: `circle:c${'a'.repeat(17)}`, text: 'x' }, /scope must be/); // one character too long
    await problem({ scope: `circle:c${'a'.repeat(15)}`, text: 'x' }, /scope must be/);
    await problem({ scope: `circle:c${'A'.repeat(16)}`, text: 'x' }, /scope must be/);
    await problem({ scope: 5, text: 'x' }, /scope must be/);
    await problem({ scope: 'personal' }, /text must be some text/);
    await problem({ scope: 'personal', text: '  ' }, /text must be some text/);
    await problem({ scope: 'personal', text: 'a'.repeat(501) }, /at most 500/);
    await problem({ scope: 'personal', text: 'x', limit: 0 }, /limit must be/);
    await problem({ scope: 'personal', text: 'x', limit: 51 }, /limit must be/);
    await problem({ scope: 'personal', text: 'x', limit: '5' }, /limit must be/);
    await problem({ scope: 'personal', text: 'x', graphId: 'user-u1' }, /graphId is not an argument/);
    await problem('personal', /arguments must be an object/);
    await problem(['personal'], /arguments must be an object/);
  });

  it('a circle outside the token or one the person is not in is the one answer a stranger gets', async () => {
    const { w, ann, club, tools } = await setup();
    const other = await w.circle(2, ann);
    const t = await w.bearer(ann, ['personal']);
    const outside = asResult(await tools.call(t, 'search_facts', { scope: `circle:${club}`, text: 'club' }));
    expect(outside).toEqual({ isError: true, data: { error: 'no such circle' }, text: '{"error":"no such circle"}' });
    expect(asResult(await tools.call(t, 'search_facts', { scope: `circle:${cid(99)}`, text: 'club' }))).toEqual(outside);
    void other;
  });
});

describe('get_fact', () => {
  it('gives the fact without the stamps that hold internal ids, where it is filed, and where it came from', async () => {
    const { w, ann, bob, club, tools } = await setup();
    await write(w.graphs, { version: 1, kind: 'mutation', graphId: circleGraphId(club), ops: [{ op: 'upsertNode', partition: 'item', id: 'n-stamped', data: { title: 'Picnic', summary: 'Bring food', contributedBy: bob.id, contributedAt: T0 + 3000 } }, { op: 'link', item: 'n-stamped', category: 'meetings', weight: 0.8 }] } as never);
    await w.ledger.append([{ id: 'lentry00000000001', at: T0 + 3000, scope: { kind: 'circle', circleId: club }, actor: bob.id, action: 'added', kind: 'item', subject: 'n-stamped', title: 'Picnic', summary: 'Bring food', proposalId: 'prop-1' }, { id: 'lentry00000000002', at: T0 + 2999, scope: { kind: 'circle', circleId: club }, actor: bob.id, action: 'added', kind: 'input', subject: 'prop-1', text: 'Picnic on Saturday, bring food', proposalId: 'prop-1' } as never]);
    const t = await w.bearer(ann, ['circle:' + club]);
    const out = data(await tools.call(t, 'get_fact', { scope: `circle:${club}`, id: 'n-stamped' }));
    expect(out).toEqual({
      brain: { scope: `circle:${club}`, name: 'Circle 1' },
      fact: { id: 'n-stamped', data: { title: 'Picnic', summary: 'Bring food' }, filed_under: [{ id: 'meetings', name: 'Meetings', weight: 0.8 }] },
      current: true,
      source: { entered_by: { username: 'bob', display_name: 'Display bob' }, entered_at: new Date(T0 + 3000).toISOString(), words: 'Picnic on Saturday, bring food', words_kept: true, replaced_later: false },
    });
    expect(JSON.stringify(out)).not.toContain(bob.id);
  });

  it('works for a fact that was replaced: what it said, that it is not current, and that it was replaced later', async () => {
    const { w, ann, club, tools } = await setup();
    const scope = { kind: 'circle' as const, circleId: club };
    await w.ledger.append([
      { id: 'lentry00000000003', at: T0 + 1000, scope, actor: ann.id, action: 'added', kind: 'item', subject: 'n-old', title: 'Tablet A', summary: '2 x daily', proposalId: 'prop-2' },
      { id: 'lentry00000000004', at: T0 + 2000, scope, actor: ann.id, action: 'removed', kind: 'item', subject: 'n-old', title: 'Tablet A', summary: '2 x daily', proposalId: 'prop-3' },
    ]);
    const t = await w.bearer(ann, ['circle:' + club]);
    const out = data(await tools.call(t, 'get_fact', { scope: `circle:${club}`, id: 'n-old' }));
    expect(out).toMatchObject({ current: false, fact: { id: 'n-old', title: 'Tablet A', summary: '2 x daily' }, source: { replaced_later: true, words_kept: false } });
  });

  it('an id that is neither in the brain nor in its change log, or another brain\'s, is not found', async () => {
    const { w, ann, club, tools } = await setup();
    const t = await w.bearer(ann, ['personal', 'circle:' + club]);
    const missing = asResult(await tools.call(t, 'get_fact', { scope: 'personal', id: 'n-none' }));
    expect(missing.isError).toBe(true);
    expect(asResult(await tools.call(t, 'get_fact', { scope: 'personal', id: 'n-club' }))).toEqual(missing); // it exists, but in another brain
    expect(asResult(await tools.call(t, 'get_fact', { scope: 'personal', id: 'x'.repeat(300) })).isError).toBe(true);
  });
});

describe('browse', () => {
  it('lists the categories with counts, then the facts of one, paged, with the brain named', async () => {
    const { w, ann, tools } = await setup();
    for (let i = 0; i < 4; i++) await w.note(userGraphId(ann.id), `n-extra-${i}`, `Extra ${i}`, `cat-${i}`, `Category ${i}`);
    const t = await w.bearer(ann, ['personal']);
    const first = data(await tools.call(t, 'browse', { scope: 'personal', limit: 2 }));
    expect(first.brain).toEqual({ scope: 'personal', name: 'Your own notes' });
    expect(first.categories).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const seen = [...first.categories];
    let cursor: string | null = first.next_cursor;
    for (let guard = 0; cursor !== null && guard < 10; guard++) {
      const page = data(await tools.call(t, 'browse', { scope: 'personal', limit: 2, cursor }));
      seen.push(...page.categories);
      cursor = page.next_cursor;
    }
    expect(seen.map((c: { id: string }) => c.id).sort()).toEqual(['cat-0', 'cat-1', 'cat-2', 'cat-3', 'health']);
    expect(seen.every((c: { fact_count: number }) => c.fact_count === 1)).toBe(true);
    const facts = data(await tools.call(t, 'browse', { scope: 'personal', category: 'health' }));
    expect(facts).toEqual({ brain: { scope: 'personal', name: 'Your own notes' }, category: { id: 'health', name: 'Health' }, facts: [{ id: 'n-own', data: { title: 'Dentist on Tuesday', summary: 'Dentist on Tuesday summary' } }], next_cursor: null });
    expect(asResult(await tools.call(t, 'browse', { scope: 'personal', category: 'nope' })).isError).toBe(true);
    expect(asResult(await tools.call(t, 'browse', { scope: 'personal', cursor: 'garbage' })).isError).toBe(true);
  });

  it('checks its arguments: limit from 1 to 100, a cursor that is some text, a category that is some text', async () => {
    const { w, ann, tools } = await setup();
    const t = await w.bearer(ann, ['personal']);
    const problem = async (tool: string, args: unknown, expected: RegExp) => {
      const r = asResult(await tools.call(t, tool, args));
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toMatch(expected);
    };
    for (const limit of [0, 101, -1, 1.5, '5', null]) await problem('browse', { scope: 'personal', limit }, /limit must be/);
    for (const cursor of ['', 5, 'c'.repeat(1001)]) await problem('browse', { scope: 'personal', cursor }, /cursor must be/);
    await problem('browse', { scope: 'personal', category: '' }, /category must be some text/);
    await problem('browse', { scope: 'personal', category: 5 }, /category must be some text/);
    await problem('browse', { scope: 'personal', category: 'c'.repeat(257) }, /at most 256/);
    await problem('changes', { scope: 'personal', since: '1970-01-01', limit: 0 }, /limit must be/);
    await problem('changes', { scope: 'personal', since: '1970-01-01', cursor: '' }, /cursor must be/);
    await problem('get_fact', { scope: 'personal', id: '' }, /id must be some text/);
    expect(asResult(await tools.call(t, 'browse', { scope: 'personal', limit: 100 })).isError).toBe(false);
    expect(asResult(await tools.call(t, 'browse', { scope: 'personal', limit: 1 })).isError).toBe(false);
  });

  it('shortens nothing silently and refuses to send more than a safe amount at once', async () => {
    const { w, ann, tools } = await setup();
    const big = 'x'.repeat(3500);
    for (let i = 0; i < 40; i++) await write(w.graphs, { version: 1, kind: 'mutation', graphId: userGraphId(ann.id), ops: [{ op: 'upsertNode', partition: 'item', id: `big-${i}`, data: { title: `Big ${i}`, summary: big } }, { op: 'link', item: `big-${i}`, category: 'health' }] } as never);
    const t = await w.bearer(ann, ['personal']);
    const r = asResult(await tools.call(t, 'browse', { scope: 'personal', category: 'health', limit: 100 }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/too large/);
    expect(r.text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
    const ok = asResult(await tools.call(t, 'browse', { scope: 'personal', category: 'health', limit: 5 }));
    expect(ok.isError).toBe(false);
    expect(ok.text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });
});

describe('changes', () => {
  it('lists what changed after a time, newest first, with the words typed and who, and takes the time as ISO text', async () => {
    const { w, ann, bob, club, tools } = await setup();
    const scope = { kind: 'circle' as const, circleId: club };
    await w.ledger.append([
      { id: 'lentry00000000010', at: T0 + 1000, scope, actor: bob.id, action: 'added', kind: 'input', subject: 'prop-9', text: 'Meeting moved to Thursday', proposalId: 'prop-9' } as never,
      { id: 'lentry00000000011', at: T0 + 1001, scope, actor: bob.id, action: 'added', kind: 'item', subject: 'n-m', title: 'Meeting Thursday', summary: 'Moved', proposalId: 'prop-9' },
      { id: 'lentry00000000012', at: T0 + 500, scope, actor: ann.id, action: 'added', kind: 'item', subject: 'n-older', title: 'Older', summary: 'x', proposalId: 'prop-8' },
    ]);
    const t = await w.bearer(ann, ['circle:' + club]);
    const out = data(await tools.call(t, 'changes', { scope: `circle:${club}`, since: new Date(T0 + 600).toISOString() }));
    expect(out.since).toBe(new Date(T0 + 600).toISOString());
    expect(out.changes).toEqual([
      { at: new Date(T0 + 1001).toISOString(), action: 'added', kind: 'fact', id: 'n-m', title: 'Meeting Thursday', summary: 'Moved', by: { username: 'bob', display_name: 'Display bob' } },
      { at: new Date(T0 + 1000).toISOString(), action: 'added', kind: 'words typed', words: 'Meeting moved to Thursday', by: { username: 'bob', display_name: 'Display bob' } },
    ]);
    expect(out.next_cursor).toBeNull();
    expect(asResult(await tools.call(t, 'changes', { scope: `circle:${club}`, since: 'yesterday' })).isError).toBe(true);
    expect(asResult(await tools.call(t, 'changes', { scope: `circle:${club}` })).text).toMatch(/since must be some text/);
  });
});

describe('pulse', () => {
  const stub = {
    status: async () => ({
      ok: true as const,
      value: { headline: 'Dentist is on Tuesday.', points: [{ text: 'Dentist on Tuesday', refs: [1] }], nothing: false, usage: { inputTokens: 1, outputTokens: 1 }, model: 'stub', attempts: 1 },
    }),
  };

  it('gives the short answer with its sources, and nothing about the plumbing, for a token that allows it', async () => {
    const { w, ann, tools } = await setup({ llm: stub as never, checkTexts: { pulse: 'What needs my attention this week?' } });
    const t = await w.bearer(ann, ['personal'], true);
    const out = data(await tools.call(t, 'pulse', { check: 'pulse' }));
    expect(out).toMatchObject({ headline: 'Dentist is on Tuesday.', nothing: false, points: [{ text: 'Dentist on Tuesday', from: [{ scope: 'personal', name: 'Your own notes' }], facts: [{ brain: { scope: 'personal' }, id: 'n-own' }] }], notes_read: 1, notes_left_out: 0 });
    expect(JSON.stringify(out)).not.toMatch(/model|usage|stub|mode"/);
    const bad = asResult(await tools.call(t, 'pulse', { check: 'daily' }));
    expect(bad.isError).toBe(true);
    expect(asResult(await tools.call(t, 'pulse', { check: 'pulse', time_zone: 5 })).isError).toBe(true);
  });
});

describe('failures', () => {
  it('say only fixed words when something inside fails, never what failed', async () => {
    const { w, ann, tools } = await setup();
    const t = await w.bearer(ann, ['personal']);
    const broken = createAgentTools({ ...w.view, read: { ...w.view.read, categories: async () => { throw new Error('secret path /var/db and sk-ant-123'); } } as never });
    const r = asResult(await broken.call(t, 'browse', { scope: 'personal' }));
    expect(r).toEqual({ isError: true, data: { error: 'the service could not complete the request' }, text: '{"error":"the service could not complete the request"}' });
    void tools;
  });

  it('a failure of a store or a model, however it is reported, is never repeated', async () => {
    const { w, ann } = await setup();
    const t = await w.bearer(ann, ['personal']);
    const graphFailure = { ok: false, error: { source: 'graph', error: { code: 'STORAGE_ERROR', message: 'secret path /var/db sk-ant-123' } } };
    const modelFailure = { ok: false, error: { source: 'llm', error: { code: 'MODEL_ERROR', message: 'provider said sk-ant-123' } } };
    for (const failing of [graphFailure, modelFailure]) {
      const tools = createAgentTools({ ...w.view, read: { ...w.view.read, categories: async () => failing, brainScopes: async () => failing } as never });
      for (const [name, args] of [['browse', { scope: 'personal' }], ['list_brains', {}]] as const) {
        expect(asResult(await tools.call(t, name, args))).toEqual({ isError: true, data: { error: 'the service could not complete the request' }, text: '{"error":"the service could not complete the request"}' });
      }
    }
  });

  it('never put a graph id, a user id or a token in any result', async () => {
    const { w, ann, bob, club, tools } = await setup();
    const t = await w.bearer(ann, ['personal', 'circle:' + club]);
    const texts: string[] = [];
    for (const [name, args] of [['list_brains', {}], ['search_facts', { scope: 'personal', text: 'dentist' }], ['search_facts', { scope: `circle:${club}`, text: 'club' }], ['get_fact', { scope: 'personal', id: 'n-own' }], ['browse', { scope: `circle:${club}` }], ['changes', { scope: 'personal', since: '1970-01-01' }]] as const) texts.push(asResult(await tools.call(t, name, args)).text);
    const all = texts.join('\n');
    for (const leak of [ann.id, bob.id, 'user-u', 'circle-c', t, 'cpat_']) expect(all.includes(leak), leak).toBe(false);
  });
});
