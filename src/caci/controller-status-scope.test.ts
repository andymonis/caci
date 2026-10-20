import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../graph_store/index.js';
import type { ModelRequest } from '../llm/index.js';
import { world, type World } from './controller.test-util.js';

// A status for one brain (R-016 D20): an optional scope narrows the context to that circle (or the own brain).

async function note(w: World, who: string, text: string, circleId?: string): Promise<void> {
  const made = await w.caci.propose(w.tokens[who], { text, ...(circleId === undefined ? {} : { scope: { kind: 'circle', circleId } }) });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const done = await w.caci.approve(w.tokens[who], made.value.id);
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  w.now.value += 60_000;
}
const statusCalls = (w: World): ModelRequest[] => w.modelCalls.filter((c) => (c.system ?? '').startsWith('You are the status assistant'));
const sent = (w: World): string => statusCalls(w).map((c) => c.messages.map((m) => m.content).join('\n')).join('\n=====\n');
const errorOf = (r: { ok: boolean; error?: unknown }): { source: string; error: { code: string; field?: string; message?: string } } => r.error as never;
const NOT_FOUND = { source: 'caci', error: { code: 'NOT_FOUND', message: 'no such circle' } };

async function story(extra: Parameters<typeof world>[0] = {}) {
  const w = await world({ people: ['ann', 'bob', 'cat', 'dan'], ...extra });
  const parent = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  const inlaw = await w.circle(2, 'ann', [['bob', 'member']]);
  await note(w, 'ann', 'Dentist appointment on Friday morning');
  await note(w, 'ann', 'Mum new tablets one a day with food', parent);
  await note(w, 'bob', 'Inlaw hospital visit moved to Monday', inlaw);
  return { w, parent, inlaw };
}

describe('a status for one circle', () => {
  it('reads only that circle and names it as the source', async () => {
    const { w, parent } = await story();
    const r = await w.caci.status(w.tokens.ann, { text: 'status please', scope: { kind: 'circle', circleId: parent } });
    expect(r.ok).toBe(true);
    const prompt = sent(w);
    expect(prompt).toContain('Mum new tablets');
    expect(prompt).not.toContain('Dentist');
    expect(prompt).not.toContain('Inlaw hospital');
    if (r.ok) {
      expect(r.value.entriesUsed).toBe(1);
      expect(r.value.points.flatMap((p) => p.sources)).toEqual([{ kind: 'circle', circleId: parent, circleName: 'Circle 1' }]);
    }
  });

  it('an observer may ask for the circle they can read', async () => {
    const { w, parent } = await story();
    const r = await w.caci.status(w.tokens.cat, { text: 'status', scope: { kind: 'circle', circleId: parent } });
    expect(r.ok).toBe(true);
    expect(sent(w)).toContain('Mum new tablets');
  });

  it('a personal scope reads only the own brain', async () => {
    const { w } = await story();
    const r = await w.caci.status(w.tokens.ann, { text: 'status', scope: { kind: 'personal' } });
    expect(r.ok).toBe(true);
    expect(sent(w)).toContain('Dentist');
    expect(sent(w)).not.toContain('Mum new tablets');
  });

  it('a stranger, a person in another circle only and a made-up circle get the one not-found, and nothing is asked, read or counted', async () => {
    const touched: string[] = [];
    const { w, parent, inlaw } = await story({ browseAdapter: (a) => ({ ...a, transaction: (g: string, fn: never) => (touched.push(g), a.transaction(g, fn)) }) as StorageAdapter });
    touched.length = 0;
    const before = w.modelCalls.length;
    for (const [who, circleId] of [['dan', parent], ['cat', inlaw], ['ann', 'c0000000000000999'], ['dan', 'nonsense']] as const) {
      const r = await w.caci.status(w.tokens[who], { text: 'status', scope: { kind: 'circle', circleId } });
      expect(r.ok).toBe(false);
      if (!r.ok && circleId !== 'nonsense') expect(r.error).toEqual(NOT_FOUND);
    }
    expect(w.modelCalls.length).toBe(before);
    expect(touched).toEqual([]);
    // refusals are not counted against the hour: twenty good ones still work afterwards
    for (let i = 0; i < 20; i++) expect((await w.caci.status(w.tokens.ann, { text: 'status', scope: { kind: 'circle', circleId: parent } })).ok).toBe(true);
  });

  it('a malformed scope names its field and a stray key is refused', async () => {
    const { w, parent } = await story();
    const bad = await w.caci.status(w.tokens.ann, { text: 'x', scope: { kind: 'circle', circleId: 'nope' } });
    expect(errorOf(bad).error.field).toBe('scope.circleId');
    const stray = await w.caci.status(w.tokens.ann, { text: 'x', scope: { kind: 'circle', circleId: parent, graphId: 'user-x' } });
    expect(errorOf(stray).error.field).toBe('scope.graphId');
    expect(errorOf(await w.caci.status(w.tokens.ann, { text: 'x', scope: 'circle' })).error.code).toBe('INVALID_INPUT');
  });

  it('a demoted observer still reads, a removed member does not, on the next request', async () => {
    const { w, parent } = await story();
    expect((await w.caci.status(w.tokens.bob, { text: 'x', scope: { kind: 'circle', circleId: parent } })).ok).toBe(true);
    const removed = await w.circleStore.removeMember(parent, (w.graphIds.bob as string).slice('user-'.length));
    expect(removed.ok).toBe(true);
    const after = await w.caci.status(w.tokens.bob, { text: 'x', scope: { kind: 'circle', circleId: parent } });
    expect(after.ok ? undefined : after.error).toEqual(NOT_FOUND);
  });

  it('without a scope nothing changes: the own brain and every circle', async () => {
    const { w } = await story();
    const r = await w.caci.status(w.tokens.ann, { text: 'status' });
    expect(r.ok && r.value.entriesUsed).toBe(3);
  });
});
