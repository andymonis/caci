import { describe, expect, it } from 'vitest';
import * as testing from '../../src/llm/testing/index.ts';
import { GOLDEN } from './golden.mjs';
import { KEY, lazyReply, lib, replying } from './helpers.test-util.mjs';
import { runEval, totalRuns } from './runner.mjs';
import { idealReply } from './scripted.mjs';

const two = GOLDEN.slice(0, 2);
const models = [{ label: 'fast', choice: { tier: 'fast' } }, { label: 'my-model', choice: { model: 'my-model-1' } }];
const ideal = ({ caseDef, itemId }) => replying(idealReply(caseDef, itemId), { inputTokens: 100, outputTokens: 10 });

describe('runEval', () => {
  it('runs every case on every model, in order (a model at a time), once by default', async () => {
    const { results, aborted } = await runEval({ lib, cases: two, models, makeClient: ideal });
    expect(aborted).toBe(false);
    expect(results.map((r) => `${r.model}/${r.caseId}/${r.run}`)).toEqual(['fast/doctor-followup/1', 'fast/dentist-booking/1', 'my-model/doctor-followup/1', 'my-model/dentist-booking/1']);
    expect(totalRuns({ cases: two, models })).toBe(4);
  });

  it('repeats each run as often as asked', async () => {
    const { results } = await runEval({ lib, cases: two, models: models.slice(0, 1), repeat: 3, makeClient: ideal });
    expect(results.map((r) => `${r.caseId}#${r.run}`)).toEqual(['doctor-followup#1', 'doctor-followup#2', 'doctor-followup#3', 'dentist-booking#1', 'dentist-booking#2', 'dentist-booking#3']);
    expect(totalRuns({ cases: two, models: models.slice(0, 1), repeat: 3 })).toBe(6);
  });

  it('asks for the model it was told to, by tier or by exact id', async () => {
    const asked = [];
    await runEval({
      lib,
      cases: two.slice(0, 1),
      models,
      makeClient: ({ caseDef, itemId }) => {
        const client = replying(idealReply(caseDef, itemId));
        return { complete: (request) => (asked.push(request.model), client.complete(request)) };
      },
    });
    expect(asked).toEqual(['claude-haiku-4-5-20251001', 'my-model-1']);
  });

  it('gives the client maker the case, a note id, the label and the choice', async () => {
    const seen = [];
    await runEval({ lib, cases: two.slice(0, 1), models: models.slice(1), makeClient: (ctx) => (seen.push(ctx), ideal(ctx)) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ itemId: 'note-eval-1', label: 'my-model', choice: { model: 'my-model-1' } });
    expect(seen[0].caseDef.id).toBe('doctor-followup');
  });

  it('records the checks, tokens, attempts, answering model and proposal of a good run', async () => {
    const { results } = await runEval({ lib, cases: two.slice(0, 1), models: models.slice(0, 1), makeClient: ideal });
    const r = results[0];
    expect(r).toMatchObject({ caseId: 'doctor-followup', model: 'fast', run: 1, pass: true, error: null, attempts: 1, repaired: false, tokens: { inputTokens: 100, outputTokens: 10 } });
    expect(r.answeredBy).toBe('claude-haiku-4-5-20251001');
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.proposal.ops.length).toBeGreaterThanOrEqual(2);
    expect(r.proposal.rationale).toBe('The scripted ideal answer.');
  });

  it('measures latency with the clock it is given', async () => {
    let clock = 0;
    const { results } = await runEval({ lib, cases: two, models: models.slice(0, 1), makeClient: ideal, now: () => (clock += 25) });
    expect(results.every((r) => r.latencyMs > 0 && r.latencyMs % 25 === 0)).toBe(true);
  });

  it('a wrong answer is a failed run, with the failing check named', async () => {
    const { results } = await runEval({ lib, cases: two.slice(0, 1), models: models.slice(0, 1), makeClient: ({ caseDef, itemId }) => replying(lazyReply({ ...caseDef, categories: [{ id: 'finance' }] }, itemId)) });
    const r = results[0];
    expect(r.pass).toBe(false);
    expect(r.error).toBeNull(); // it answered; the answer was wrong
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toContain('reuses health');
  });

  it('a repaired run is flagged and uses both attempts\' tokens', async () => {
    const bad = { ops: [{ op: 'deleteNode', partition: 'item', id: 'x' }] };
    const { results } = await runEval({
      lib,
      cases: two.slice(0, 1),
      models: models.slice(0, 1),
      makeClient: ({ caseDef, itemId }) => testing.createScriptedModelClient((_q, n) => ({ reply: JSON.stringify(n === 1 ? bad : idealReply(caseDef, itemId)), usage: { inputTokens: 100, outputTokens: 10 } })),
    });
    expect(results[0]).toMatchObject({ pass: true, repaired: true, attempts: 2, tokens: { inputTokens: 200, outputTokens: 20 } });
  });

  it('a call that fails is a failed run with its error and the tokens it still used', async () => {
    const bad = { ops: [{ op: 'deleteNode', partition: 'item', id: 'x' }] };
    const { results } = await runEval({ lib, cases: two.slice(0, 1), models: models.slice(0, 1), makeClient: () => replying(bad, { inputTokens: 100, outputTokens: 10 }) });
    expect(results[0]).toMatchObject({ pass: false, repaired: false, attempts: 2, error: { code: 'BAD_OUTPUT' }, tokens: { inputTokens: 200, outputTokens: 20 }, proposal: null, answeredBy: null });
    expect(results[0].checks).toEqual([{ name: 'answered', pass: false, detail: expect.stringContaining('BAD_OUTPUT') }]);
  });

  it('a provider error keeps its code, and a time-out is a failed run, not a crash', async () => {
    const refused = await runEval({ lib, cases: two.slice(0, 1), models: models.slice(0, 1), makeClient: () => testing.createScriptedModelClient([{ refusal: true }]) });
    expect(refused.results[0]).toMatchObject({ pass: false, error: { code: 'REFUSED' }, tokens: { inputTokens: 0, outputTokens: 0 }, attempts: 1 });
    const hung = await runEval({ lib, cases: two.slice(0, 1), models: models.slice(0, 1), timeoutMs: 100, makeClient: () => testing.createScriptedModelClient([{ hang: true }]) });
    expect(hung.results[0]).toMatchObject({ pass: false, error: { code: 'TIMEOUT' } });
  });

  it('one failed run does not stop the next', async () => {
    let n = 0;
    const { results } = await runEval({ lib, cases: two, models: models.slice(0, 1), makeClient: (ctx) => (++n === 1 ? testing.createScriptedModelClient([{ refusal: true }]) : ideal(ctx)) });
    expect(results.map((r) => r.pass)).toEqual([false, true]);
  });

  it('reports each run as it finishes, with its running number', async () => {
    const seen = [];
    await runEval({ lib, cases: two, models: models.slice(0, 1), makeClient: ideal, onResult: (r, n) => seen.push([n, r.caseId]) });
    expect(seen).toEqual([[1, 'doctor-followup'], [2, 'dentist-booking']]);
  });

  it('stops between calls when told to, and keeps what it has', async () => {
    const controller = new AbortController();
    const { results, aborted } = await runEval({ lib, cases: GOLDEN, models: models.slice(0, 1), makeClient: ideal, signal: controller.signal, onResult: (_r, n) => n === 3 && controller.abort() });
    expect(aborted).toBe(true);
    expect(results).toHaveLength(3);
  });

  it('gives each run its own client and does not change the golden cases', async () => {
    const before = JSON.stringify(GOLDEN);
    const clients = new Set();
    await runEval({ lib, cases: two, models, makeClient: (ctx) => { const c = ideal(ctx); clients.add(c); return c; } });
    expect(clients.size).toBe(4);
    expect(JSON.stringify(GOLDEN)).toBe(before);
  });

  it('never puts a key anywhere in its results', async () => {
    const { results } = await runEval({ lib, cases: two, models, makeClient: ideal });
    expect(JSON.stringify(results)).not.toContain(KEY);
  });

  it('runs nothing, harmlessly, for no cases or no models', async () => {
    expect((await runEval({ lib, cases: [], models, makeClient: ideal })).results).toEqual([]);
    expect((await runEval({ lib, cases: two, models: [], makeClient: ideal })).results).toEqual([]);
  });
});
