import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../llm/index.js';
import { createMemoryResolutionStore, type ResolutionStore } from '../resolutions/index.js';
import { recordAdapter, type RecordingAdapter } from '../app/recording-adapter.test-util.js';
import { world, type World } from './controller.test-util.js';

// R-025 D11 (VR-FR-06, VR-AC-06, VR-AC-11, VR-NFR-03): a person's status answers leave out the facts they have resolved, for them only.

const PULSE = 'Provide a status update for the circle. Keep the answer factual, stick to the point and be concise.';
const circleScope = (circleId: string) => ({ kind: 'circle', circleId });
const must = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.error)}`);
  return r.value as T;
};
/** Files a note and returns the id of the fact it made. */
async function note(w: World, who: string, text: string, circleId?: string): Promise<string> {
  const made = must(await w.caci.propose(w.tokens[who], { text, ...(circleId === undefined ? {} : { scope: circleScope(circleId) }) }));
  must(await w.caci.approve(w.tokens[who], made.id));
  w.now.value += 60_000;
  return made.summary.newItems[0] as string;
}
const statusCalls = (w: World): ModelRequest[] => w.modelCalls.filter((c) => (c.system ?? '').startsWith('You are the status assistant'));
const lastPrompt = (w: World): string => (statusCalls(w).at(-1) as ModelRequest).messages.map((m) => m.content).join('\n');
const pulse = (w: World, who: string, circleId: string) => w.caci.status(w.tokens[who], { pulse: true, scope: circleScope(circleId) });

async function story(extra: Parameters<typeof world>[0] = {}) {
  const w = await world({ people: ['ann', 'bob', 'cat'], pulseText: PULSE, checkTexts: { pulse: PULSE, 'coming-up': 'What is coming up this month?', 'long-range': 'What is coming this year?' }, ...extra });
  const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  const yoga = await note(w, 'ann', 'Pay for this week yoga class by Friday', c);
  const bins = await note(w, 'ann', 'Bins go out on Thursday evening', c);
  return { w, c, yoga, bins };
}

describe('the status context leaves out what you have resolved (VR-AC-06)', () => {
  it('a resolved fact is gone from the resolver\'s pulse and still in everyone else\'s', async () => {
    const { w, c, yoga } = await story();
    expect(must(await pulse(w, 'bob', c)).entriesUsed).toBe(2);
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'pay' }));
    const mine = must(await pulse(w, 'bob', c));
    expect(mine).toMatchObject({ entriesUsed: 1, entriesLeftOut: 0, entriesResolved: 1 });
    expect(lastPrompt(w)).toContain('Bins go out');
    expect(lastPrompt(w)).not.toContain('yoga');
    for (const who of ['ann', 'cat']) {
      const theirs = must(await pulse(w, who, c));
      expect(theirs, who).toMatchObject({ entriesUsed: 2, entriesResolved: 0 });
      expect(lastPrompt(w), who).toContain('yoga');
    }
  });

  it('works for the other checks and a typed request too, and for the combined view', async () => {
    const { w, c, yoga } = await story();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'clear' }));
    for (const input of [{ check: 'coming-up' }, { check: 'long-range' }, { text: 'what is on?' }, { text: 'what is on?', scope: circleScope(c) }]) {
      const r = must(await w.caci.status(w.tokens.bob, input));
      expect(r.entriesResolved, JSON.stringify(input)).toBe(1);
      expect(lastPrompt(w), JSON.stringify(input)).not.toContain('yoga');
    }
  });

  it('taking the resolution back brings the fact into the checks again (VR-AC-05)', async () => {
    const { w, c, yoga } = await story();
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'pay' }));
    must(await w.caci.unresolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga }));
    expect(must(await pulse(w, 'bob', c))).toMatchObject({ entriesUsed: 2, entriesResolved: 0 });
    expect(lastPrompt(w)).toContain('yoga');
  });

  it('a resolved fact does not take a place from one that is still open', async () => {
    const { w, c, yoga, bins } = await story({ limits: { status: { maxPerScope: 1 } } });
    // the newest fact is the bins; resolve it and the older yoga fact fills the one place
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: bins, verb: 'clear' }));
    expect(must(await pulse(w, 'bob', c))).toMatchObject({ entriesUsed: 1, entriesResolved: 1 });
    expect(lastPrompt(w)).toContain('yoga');
    expect(lastPrompt(w)).not.toContain('Bins');
    expect(yoga).not.toBe(bins);
  });

  it('every fact resolved: the answer is built from nothing, and the others still see theirs', async () => {
    const { w, c, yoga, bins } = await story();
    for (const id of [yoga, bins]) must(await w.caci.resolveFact(w.tokens.cat, { scope: circleScope(c), id, verb: 'clear' }));
    expect(must(await pulse(w, 'cat', c))).toMatchObject({ entriesUsed: 0, entriesResolved: 2, nothing: true });
    expect(must(await pulse(w, 'bob', c)).entriesUsed).toBe(2);
  });

  it('the status path still writes nothing, resolutions included', async () => {
    const recorded: RecordingAdapter[] = [];
    const store = createMemoryResolutionStore();
    const sets: number[] = [];
    const watched: ResolutionStore = { ...store, set: async (r) => (sets.push(1), store.set(r)), removeFact: async (...a) => (sets.push(1), store.removeFact(...a)) };
    const { w, c, yoga } = await story({ resolutions: watched, browseAdapter: (a) => { const r = recordAdapter(a); recorded.push(r); return r.adapter; } });
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'pay' }));
    const before = sets.length;
    for (const r of recorded) r.writes.length = 0;
    must(await pulse(w, 'bob', c));
    must(await w.caci.status(w.tokens.bob, { check: 'pulse' as never }));
    expect(recorded.flatMap((r) => r.writes)).toEqual([]);
    expect(sets.length).toBe(before);
  });
});

describe('a store that cannot be read never fails a status (VR-NFR-03, VR-AC-11)', () => {
  it('builds the context without the filter and warns once for the stretch', async () => {
    const store = createMemoryResolutionStore();
    let down = true;
    const flaky: ResolutionStore = { ...store, listFor: async (...a) => { if (down) throw new Error('SECRET disk'); return store.listFor(...a); } };
    const said: string[] = [];
    const { w, c, yoga } = await story({ resolutions: flaky, onResolutionFailure: (m) => said.push(m) });
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'pay' }));
    for (let i = 0; i < 3; i++) expect(must(await pulse(w, 'bob', c))).toMatchObject({ entriesUsed: 2, entriesResolved: 0 });
    expect(said).toEqual(['resolved facts could not be read, so this answer may include facts you have resolved']);
    expect(said.join()).not.toContain('SECRET');
    down = false;
    expect(must(await pulse(w, 'bob', c))).toMatchObject({ entriesUsed: 1, entriesResolved: 1 });
    down = true;
    must(await pulse(w, 'bob', c));
    expect(said).toHaveLength(2);
  });

  it('a throwing warning hook changes nothing', async () => {
    const store = createMemoryResolutionStore();
    const flaky: ResolutionStore = { ...store, listFor: async () => { throw new Error('x'); } };
    const { w, c } = await story({ resolutions: flaky, onResolutionFailure: () => { throw new Error('hook'); } });
    expect(must(await pulse(w, 'bob', c)).entriesUsed).toBe(2);
  });
});

describe('the source view marks a fact you have resolved, for you only (D11)', () => {
  it('the resolver sees resolvedByYou; anyone else sees nothing of it; the Brain and search are unchanged', async () => {
    const w = await world({ people: ['ann', 'bob', 'cat'], ledger: (await import('../ledger/index.js')).createMemoryLedgerStore() });
    const c = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'member']]);
    const yoga = await note(w, 'ann', 'Pay for this week yoga class by Friday', c);
    must(await w.caci.resolveFact(w.tokens.bob, { scope: circleScope(c), id: yoga, verb: 'pay' }));
    const mine = must(await w.caci.source(w.tokens.bob, { scope: circleScope(c), id: yoga }));
    expect(mine.resolvedByYou).toEqual({ verb: 'pay', at: w.now.value });
    expect(mine.current).toBe(true);
    for (const who of ['ann', 'cat']) expect(must(await w.caci.source(w.tokens[who], { scope: circleScope(c), id: yoga })).resolvedByYou, who).toBeUndefined();
    const found = must(await w.caci.searchFacts(w.tokens.bob, { text: 'yoga', scope: circleScope(c) }));
    expect(JSON.stringify(found)).toContain('yoga');
    expect(must(await w.caci.item(w.tokens.bob, yoga, circleScope(c))).item.id).toBe(yoga);
  });
});
