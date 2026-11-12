import { describe, expect, it } from 'vitest';
import { err, ok } from '../graph_store/index.js';
import { createDemoModelClient, llmError, type ModelClient } from '../llm/index.js';
import type { UsageRecord, UsageStore } from '../usage/index.js';
import { world, type World } from './controller.test-util.js';
import { createUsageRecorder, USAGE_WARNING } from './usage-recorder.js';

/** A usage store that remembers every record it is given, in order. */
function remembering(): { store: Pick<UsageStore, 'append'>; records: UsageRecord[]; batches: number } {
  const out = { records: [] as UsageRecord[], batches: 0 };
  return { store: { append: async (batch) => (out.batches++, out.records.push(...batch), ok(undefined)) }, get records() { return out.records; }, get batches() { return out.batches; } };
}
const recorderOf = (mem: ReturnType<typeof remembering>, onWarning?: (m: string) => void) => createUsageRecorder({ store: mem.store, clock: () => 1_700_000_000_000, ...(onWarning === undefined ? {} : { onWarning }) });

async function setup(extra: Parameters<typeof world>[0] = {}) {
  const mem = remembering();
  const w = await world({ people: ['ann', 'bob', 'cat'], usage: recorderOf(mem), ...extra });
  const circle = await w.circle(1, 'ann', [['bob', 'member'], ['cat', 'observer']]);
  return { w, mem, circle };
}
const uid = (w: World, name: string): string => (w.graphIds[name] as string).slice('user-'.length);

describe('usage metering of filing a note', () => {
  it('records one categorise attempt charged to the person, in their own scope, and nothing more on approval', async () => {
    const { w, mem } = await setup();
    const made = await w.caci.propose(w.tokens.ann, { text: 'Mum takes 2 tablets daily after breakfast' });
    expect(made.ok).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toMatchObject({ userId: uid(w, 'ann'), capability: 'categorise', scope: { kind: 'personal' }, model: 'demo', attempt: 1, result: 'ok' });
    expect(mem.records[0]?.inputTokens).toBeGreaterThan(0);
    expect(mem.records[0]?.outputTokens).toBeGreaterThan(0);
    if (made.ok) expect((await w.caci.approve(w.tokens.ann, made.value.id)).ok).toBe(true);
    expect(mem.records).toHaveLength(1);
  });

  it('a circle note is charged to the member who made it, with the circle as the scope', async () => {
    const { w, mem, circle } = await setup();
    const made = await w.caci.propose(w.tokens.bob, { text: 'Hospital visit moved to Monday', scope: { kind: 'circle', circleId: circle } });
    expect(made.ok).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toMatchObject({ userId: uid(w, 'bob'), capability: 'categorise', scope: { kind: 'circle', circleId: circle } });
  });

  it('a refusal before any model is asked records nothing: an observer, a bad note, a stranger\'s circle, the hourly limit', async () => {
    const { w, mem, circle } = await setup({ limits: { proposalsPerHour: 1 } });
    expect((await w.caci.propose(w.tokens.cat, { text: 'x note here', scope: { kind: 'circle', circleId: circle } })).ok).toBe(false);
    expect((await w.caci.propose(w.tokens.ann, { text: '   ' })).ok).toBe(false);
    expect((await w.caci.propose(w.tokens.ann, { text: 'a real note', scope: { kind: 'circle', circleId: 'c9999999999999999' } })).ok).toBe(false);
    expect(mem.records).toHaveLength(0);
    expect((await w.caci.propose(w.tokens.ann, { text: 'a real note about gardens' })).ok).toBe(true);
    expect(mem.records).toHaveLength(1);
    const limited = await w.caci.propose(w.tokens.ann, { text: 'another real note about cooking' });
    expect(limited.ok).toBe(false);
    expect(mem.records).toHaveLength(1);
  });

  it('a note that needed a repair is two records, rejected then ok, and still succeeds', async () => {
    const demo = createDemoModelClient();
    let calls = 0;
    const client: ModelClient = {
      complete: async (request) => {
        calls++;
        if (calls === 1) return ok({ model: 'first-model', output: { kind: 'json' as const, value: { ops: [] } }, usage: { inputTokens: 500, outputTokens: 20 } });
        return demo.complete(request);
      },
    };
    const { w, mem } = await setup({ client });
    const made = await w.caci.propose(w.tokens.ann, { text: 'Dentist on Friday at 9' });
    expect(made.ok).toBe(true);
    expect(mem.records.map((r) => [r.attempt, r.result, r.model])).toEqual([[1, 'rejected', 'first-model'], [2, 'ok', 'demo']]);
    expect(mem.records[0]?.inputTokens).toBe(500);
  });

  it('a model that fails is a record with the error kind, and the person still gets the model error', async () => {
    const client: ModelClient = { complete: async () => err(llmError('RATE_LIMITED', 'slow down')) };
    const { w, mem } = await setup({ client });
    const made = await w.caci.propose(w.tokens.ann, { text: 'Dentist on Friday at 9' });
    expect(made.ok).toBe(false);
    if (!made.ok) expect((made.error as { source: string }).source).toBe('llm');
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toMatchObject({ result: 'rate_limited', inputTokens: 0, attempt: 1 });
  });

  it('records no note text, request, answer or name, only the allowed fields', async () => {
    const { w, mem, circle } = await setup();
    await w.caci.propose(w.tokens.ann, { text: 'Secret dentist appointment for Zebediah on Friday' });
    await w.caci.propose(w.tokens.bob, { text: 'Zebediah hospital visit', scope: { kind: 'circle', circleId: circle } });
    const json = JSON.stringify(mem.records);
    for (const word of ['Secret', 'dentist', 'Zebediah', 'hospital', 'Friday', 'ann', 'bob']) expect(json).not.toContain(word);
    for (const r of mem.records) expect(Object.keys(r).sort()).toEqual(['at', 'attempt', 'cacheCreationTokens', 'cacheReadTokens', 'capability', 'inputTokens', 'latencyMs', 'model', 'outputTokens', 'result', 'scope', 'userId']);
  });

  it('a failing store changes nothing the person sees and gives one fixed warning', async () => {
    const warnings: string[] = [];
    const refusing = { append: async () => err({ code: 'STORAGE_ERROR' as const, message: 'secret /var/db detail' }) };
    const w = await world({ people: ['ann'], usage: createUsageRecorder({ store: refusing, onWarning: (m) => void warnings.push(m) }) });
    const made = await w.caci.propose(w.tokens.ann, { text: 'Dentist on Friday at 9' });
    expect(made.ok).toBe(true);
    expect(warnings).toEqual([USAGE_WARNING]);
    if (made.ok) expect((await w.caci.approve(w.tokens.ann, made.value.id)).ok).toBe(true);
  });

  it('with no recorder nothing is recorded and nothing else changes', async () => {
    const w = await world({ people: ['ann'] });
    expect((await w.caci.propose(w.tokens.ann, { text: 'Dentist on Friday at 9' })).ok).toBe(true);
  });
});

describe('usage metering of statuses and checks', () => {
  const texts = { pulse: 'What needs my attention this week?', 'coming-up': 'What is coming up this month?', 'long-range': 'What is on the radar this year?' };

  it('a typed request is a status, a predefined one is a check, each charged to the asker', async () => {
    const { w, mem } = await setup({ checkTexts: texts });
    expect((await w.caci.status(w.tokens.ann, { text: 'Give me a morning status check' })).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { check: 'pulse' })).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { check: 'long-range' })).ok).toBe(true);
    expect(mem.records.map((r) => [r.capability, r.userId, r.scope.kind, r.result])).toEqual([
      ['status', uid(w, 'ann'), 'personal', 'ok'],
      ['check', uid(w, 'ann'), 'personal', 'ok'],
      ['check', uid(w, 'ann'), 'personal', 'ok'],
    ]);
  });

  it('a request narrowed to a circle is that circle\'s, whoever the asker is; the legacy pulse is a check', async () => {
    const { w, mem, circle } = await setup({ pulseText: 'What needs my attention this week?' });
    expect((await w.caci.status(w.tokens.cat, { text: 'Anything on?', scope: { kind: 'circle', circleId: circle } })).ok).toBe(true);
    expect((await w.caci.status(w.tokens.cat, { pulse: true, scope: { kind: 'circle', circleId: circle } })).ok).toBe(true);
    expect(mem.records.map((r) => [r.capability, r.userId, r.scope])).toEqual([
      ['status', uid(w, 'cat'), { kind: 'circle', circleId: circle }],
      ['check', uid(w, 'cat'), { kind: 'circle', circleId: circle }],
    ]);
  });

  it('a status narrowed to the person\'s own brain is personal', async () => {
    const { w, mem } = await setup();
    expect((await w.caci.status(w.tokens.ann, { text: 'Anything on?', scope: { kind: 'personal' } })).ok).toBe(true);
    expect(mem.records[0]?.scope).toEqual({ kind: 'personal' });
  });

  it('a controller made for an agent records its checks as agent-check', async () => {
    const { w, mem } = await setup({ checkTexts: texts, checkCapability: 'agent-check' });
    expect((await w.caci.status(w.tokens.ann, { check: 'pulse' })).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { text: 'typed words' })).ok).toBe(true);
    expect(mem.records.map((r) => r.capability)).toEqual(['agent-check', 'status']);
  });

  it('refusals before the model is asked record nothing: bad input, a stranger\'s circle, the hourly limit, a second at once', async () => {
    const { w, mem } = await setup({ limits: { statusPerHour: 1 }, checkTexts: texts });
    expect((await w.caci.status(w.tokens.ann, { text: '' })).ok).toBe(false);
    expect((await w.caci.status(w.tokens.ann, { check: 'nope' })).ok).toBe(false);
    expect((await w.caci.status(w.tokens.ann, { text: 'hi', scope: { kind: 'circle', circleId: 'c9999999999999999' } })).ok).toBe(false);
    expect(mem.records).toHaveLength(0);
    expect((await w.caci.status(w.tokens.ann, { text: 'first' })).ok).toBe(true);
    expect((await w.caci.status(w.tokens.ann, { text: 'second' })).ok).toBe(false);
    expect(mem.records).toHaveLength(1);
  });

  it('a status whose model fails is a record with the error kind, and the person gets the model error', async () => {
    const client: ModelClient = { complete: async () => err(llmError('TIMEOUT', 'slow')) };
    const { w, mem } = await setup({ client });
    const r = await w.caci.status(w.tokens.ann, { text: 'Give me a status' });
    expect(r.ok).toBe(false);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toMatchObject({ capability: 'status', result: 'timeout' });
  });

  it('a failing store does not change a status', async () => {
    const warnings: string[] = [];
    const throwing = { append: async (): Promise<never> => { throw new Error('boom'); } };
    const w = await world({ people: ['ann'], usage: createUsageRecorder({ store: throwing, onWarning: (m) => void warnings.push(m) }) });
    const r = await w.caci.status(w.tokens.ann, { text: 'Give me a status' });
    expect(r.ok).toBe(true);
    expect(warnings).toEqual([USAGE_WARNING]);
  });
});
