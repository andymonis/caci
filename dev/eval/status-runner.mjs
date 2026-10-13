// Runs status golden cases against models through the real `status`, one call at a time, and records what
// happened: the checks, the tokens, the time and the trace of attempts. Same record shape as the runner for
// `categorise`, so the same report reads both.
import { evaluateStatusCase } from './status-evaluate.mjs';

const tokensOf = (result, trace) => (result.ok ? result.value.usage : trace.filter((e) => e.type === 'response').reduce((sum, e) => ({ inputTokens: sum.inputTokens + e.usage.inputTokens, outputTokens: sum.outputTokens + e.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 }));

/** Same options as `runEval`; `lib` needs only `createLlm`. */
export async function runStatusEval({ lib, cases, models, repeat = 1, makeClient, now = Date.now, timeoutMs = 60_000, onResult, signal }) {
  const results = [];
  for (const model of models) {
    for (const caseDef of cases) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        if (signal?.aborted) return { results, aborted: true };
        const client = makeClient({ caseDef, label: model.label, choice: model.choice });
        const llm = lib.createLlm({ client, now });
        const trace = [];
        const started = now();
        const result = await llm.status({ text: caseDef.request, entries: caseDef.entries }, { ...model.choice, timeoutMs, trace: (event) => void trace.push(event) });
        const latencyMs = now() - started;
        const outcome = result.ok ? { ok: true, answer: result.value } : { ok: false, error: result.error };
        const verdict = evaluateStatusCase(caseDef, outcome);
        const record = {
          caseId: caseDef.id,
          model: model.label,
          run: attempt,
          pass: verdict.pass,
          checks: verdict.checks,
          error: outcome.ok ? null : outcome.error,
          attempts: trace.filter((e) => e.type === 'request').length,
          repaired: result.ok && result.value.attempts === 2,
          latencyMs,
          tokens: tokensOf(result, trace),
          answeredBy: result.ok ? result.value.model : null,
          proposal: result.ok ? { headline: result.value.headline, points: result.value.points, nothing: result.value.nothing, model: result.value.model } : null,
        };
        results.push(record);
        onResult?.(record, results.length);
      }
    }
  }
  return { results, aborted: false };
}
