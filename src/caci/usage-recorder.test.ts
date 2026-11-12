import { describe, expect, it } from 'vitest';
import { createLlm, llmError, type TraceEvent } from '../llm/index.js';
import { createScriptedModelClient, type ScriptStep } from '../llm/testing/index.js';
import { SHIPPED_CONTROLS } from '../llm/testing/shipped-controls.test-util.js';
import { createMemoryUsageStore, type UsageRange } from '../usage/index.js';
import { createUsageRecorder, recordsFromTrace, USAGE_WARNING, type UsageContext } from './usage-recorder.js';

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const U1 = 'u0000000000000001';
const CTX: UsageContext = { userId: U1, capability: 'status', scope: { kind: 'personal' } };
const ALL: UsageRange = { from: 0, to: Date.UTC(2100, 0, 1) };
const INPUT = { text: 'Give me a morning status check', timeZone: 'Europe/London', entries: [{ where: 'personal', text: 'Dentist: Friday at 9' }, { where: 'personal', text: 'Mum: new tablets' }] };
const GOOD = JSON.stringify({ headline: 'A dentist visit.', points: [{ text: 'Dentist on Friday.', refs: [1] }], nothing: false });
const BAD = JSON.stringify({ headline: 'x', points: [{ text: 'cites a note that is not there', refs: [7] }], nothing: false });

/** The real trace of a real `status` call over a scripted provider. */
async function traced(script: ScriptStep[]): Promise<TraceEvent[]> {
  const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createScriptedModelClient(script), now: () => NOW });
  const events: TraceEvent[] = [];
  await llm.status(INPUT, { trace: (e) => void events.push(e) });
  return events;
}
const tokens = { inputTokens: 300, outputTokens: 60, cacheReadTokens: 200, cacheCreationTokens: 40 };

describe('turning a trace into records', () => {
  it('a good call is one record: its tokens, the model that answered, the cache counts and a result of ok', async () => {
    const records = recordsFromTrace(await traced([{ reply: GOOD, usage: tokens, model: 'served-model-1' }]), CTX, NOW);
    expect(records).toEqual([{ at: NOW, userId: U1, capability: 'status', scope: { kind: 'personal' }, model: 'served-model-1', attempt: 1, inputTokens: 300, outputTokens: 60, cacheReadTokens: 200, cacheCreationTokens: 40, result: 'ok', latencyMs: expect.any(Number) }]);
  });

  it('a repaired call is two records: the first rejected, the second ok, each with its own tokens', async () => {
    const records = recordsFromTrace(await traced([{ reply: BAD, usage: { inputTokens: 100, outputTokens: 20 } }, { reply: GOOD, usage: { inputTokens: 150, outputTokens: 30 } }]), CTX, NOW);
    expect(records.map((r) => [r.attempt, r.result, r.inputTokens, r.outputTokens])).toEqual([[1, 'rejected', 100, 20], [2, 'ok', 150, 30]]);
  });

  it('a call whose repair is also refused is two rejected records', async () => {
    const records = recordsFromTrace(await traced([{ reply: BAD }, { reply: BAD }]), CTX, NOW);
    expect(records.map((r) => [r.attempt, r.result])).toEqual([[1, 'rejected'], [2, 'rejected']]);
  });

  it.each([
    [{ refusal: true } as ScriptStep, 'refused'],
    [{ rateLimited: true } as ScriptStep, 'rate_limited'],
    [{ serverError: true } as ScriptStep, 'model_error'],
    [{ rejected: true } as ScriptStep, 'model_error'],
    [{ unknownModel: true } as ScriptStep, 'config'],
    [{ error: llmError('TIMEOUT', 'slow') } as ScriptStep, 'timeout'],
    [{ error: llmError('CANCELLED', 'stopped') } as ScriptStep, 'cancelled'],
    [{ error: llmError('BAD_OUTPUT', 'prose') } as ScriptStep, 'bad_output'],
  ])('a failed request is one record with no tokens and the error kind (%#)', async (step, result) => {
    const records = recordsFromTrace(await traced([step]), CTX, NOW);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ attempt: 1, result, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(records[0]?.model).toMatch(/\S/);
  });

  it('a failed request takes the model that was asked for from the request event', () => {
    const events = [
      { type: 'request', attempt: 1, model: 'asked-model', timeoutMs: 1, messages: [] },
      { type: 'failure', attempt: 1, error: llmError('MODEL_ERROR', 'x'), elapsedMs: 12 },
      { type: 'done', ok: false, attempts: 1, elapsedMs: 12 },
    ] as unknown as TraceEvent[];
    expect(recordsFromTrace(events, CTX, NOW)[0]).toMatchObject({ model: 'asked-model', latencyMs: 12 });
  });

  it('a repair that fails is a rejected record and then a failure record', async () => {
    const records = recordsFromTrace(await traced([{ reply: BAD }, { serverError: true }]), CTX, NOW);
    expect(records.map((r) => [r.attempt, r.result])).toEqual([[1, 'rejected'], [2, 'model_error']]);
  });

  it('a call refused before any model was asked is no record', async () => {
    const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createScriptedModelClient([{ reply: GOOD }]), now: () => NOW });
    const events: TraceEvent[] = [];
    const r = await llm.status({ ...INPUT, text: '   ' }, { trace: (e) => void events.push(e) });
    expect(r.ok).toBe(false);
    expect(recordsFromTrace(events, CTX, NOW)).toEqual([]);
    expect(recordsFromTrace([], CTX, NOW)).toEqual([]);
  });

  it('carries the context: the person, the call type, a circle scope and the time', async () => {
    const events = await traced([{ reply: GOOD }]);
    const circle = recordsFromTrace(events, { userId: 'u0000000000000002', capability: 'agent-check', scope: { kind: 'circle', circleId: 'c0000000000000001' } }, 42)[0];
    expect(circle).toMatchObject({ at: 42, userId: 'u0000000000000002', capability: 'agent-check', scope: { kind: 'circle', circleId: 'c0000000000000001' } });
  });

  it('a model name the check would refuse becomes unknown instead of costing the whole batch', () => {
    const events = [
      { type: 'response', attempt: 1, output: { kind: 'text', text: '' }, usage: { inputTokens: 5, outputTokens: 1 }, model: 'a model with spaces', elapsedMs: 3 },
      { type: 'verdict', attempt: 1, accepted: true, problems: [] },
    ] as unknown as TraceEvent[];
    expect(recordsFromTrace(events, CTX, NOW)).toMatchObject([{ model: 'unknown', inputTokens: 5 }]);
  });

  it('clamps an impossible latency and rounds a fractional one', () => {
    const event = (elapsedMs: number): TraceEvent[] => [{ type: 'response', attempt: 1, output: { kind: 'text', text: '' }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', elapsedMs }] as unknown as TraceEvent[];
    expect(recordsFromTrace(event(12.6), CTX, NOW)[0]?.latencyMs).toBe(13);
    expect(recordsFromTrace(event(-5), CTX, NOW)[0]?.latencyMs).toBe(0);
    expect(recordsFromTrace(event(9e9), CTX, NOW)[0]?.latencyMs).toBe(86_400_000);
  });

  it('a record never holds any text from the call', async () => {
    const records = recordsFromTrace(await traced([{ reply: BAD }, { reply: GOOD }]), CTX, NOW);
    const json = JSON.stringify(records);
    for (const word of ['Dentist', 'Mum', 'status check', 'headline', 'tablets']) expect(json).not.toContain(word);
    expect(Object.keys(records[0] as object).sort()).toEqual(['at', 'attempt', 'cacheCreationTokens', 'cacheReadTokens', 'capability', 'inputTokens', 'latencyMs', 'model', 'outputTokens', 'result', 'scope', 'userId']);
  });
});

describe('the recorder', () => {
  const run = async (script: ScriptStep[], init: Partial<Parameters<typeof createUsageRecorder>[0]> = {}) => {
    const store = createMemoryUsageStore();
    const warnings: string[] = [];
    const recorder = createUsageRecorder({ store, clock: () => NOW, onWarning: (m) => void warnings.push(m), ...init });
    const call = recorder.begin(CTX);
    const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createScriptedModelClient(script), now: () => NOW });
    const result = await llm.status(INPUT, { trace: call.trace });
    await call.done();
    return { store, warnings, result };
  };

  it('saves the records of a call after it ends, at the clock\'s time', async () => {
    const { store, result } = await run([{ reply: BAD }, { reply: GOOD }]);
    expect(result.ok).toBe(true);
    const rows = await store.aggregate(ALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-11-12', userId: U1, capability: 'status', calls: 1, attempts: 2, rejected: 1 });
  });

  it('saves nothing for a call that never asked a model, and does not warn', async () => {
    const store = createMemoryUsageStore();
    const warnings: string[] = [];
    let calls = 0;
    const spy = { append: async (r: Parameters<typeof store.append>[0]) => (calls++, store.append(r)) };
    const call = createUsageRecorder({ store: spy, onWarning: (m) => void warnings.push(m) }).begin(CTX);
    await call.done();
    expect(calls).toBe(0);
    expect(await store.aggregate(ALL)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a store that refuses the batch gives one fixed warning and changes nothing for the caller', async () => {
    const refusing = { append: async () => ({ ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: 'secret detail /var/db' } }) };
    const { warnings, result } = await run([{ reply: GOOD }], { store: refusing });
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([USAGE_WARNING]);
    expect(USAGE_WARNING).not.toMatch(/\/|secret|u0000/);
  });

  it('a store that throws is the same, and a hook that throws changes nothing', async () => {
    const throwing = { append: async (): Promise<never> => { throw new Error('boom /private/path'); } };
    const { warnings, result } = await run([{ reply: GOOD }], { store: throwing });
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([USAGE_WARNING]);
    const loud = await run([{ reply: GOOD }], { store: throwing, onWarning: () => { throw new Error('hook'); } });
    expect(loud.result.ok).toBe(true);
  });

  it('a call without a clock uses the real time, and a hook is optional', async () => {
    const store = createMemoryUsageStore();
    const call = createUsageRecorder({ store }).begin(CTX);
    const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createScriptedModelClient([{ reply: GOOD }]), now: () => NOW });
    await llm.status(INPUT, { trace: call.trace });
    await call.done();
    const rows = await store.aggregate({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(rows).toHaveLength(1);
  });

  it('is frozen, and each call keeps its own events', async () => {
    const store = createMemoryUsageStore();
    const recorder = createUsageRecorder({ store, clock: () => NOW });
    expect(Object.isFrozen(recorder)).toBe(true);
    const a = recorder.begin(CTX);
    const b = recorder.begin({ ...CTX, userId: 'u0000000000000002' });
    expect(Object.isFrozen(a)).toBe(true);
    const llm = createLlm({ controls: SHIPPED_CONTROLS, client: createScriptedModelClient([{ reply: GOOD }, { reply: GOOD }]), now: () => NOW });
    await llm.status(INPUT, { trace: a.trace });
    await llm.status(INPUT, { trace: b.trace });
    await a.done();
    await b.done();
    const rows = await store.aggregate(ALL);
    expect(rows.map((r) => [r.userId, r.attempts])).toEqual([[U1, 1], ['u0000000000000002', 1]]);
  });
});
