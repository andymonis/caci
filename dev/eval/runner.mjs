// Runs golden cases against models through the real `categorise`, one call at a time, and records
// what happened: the checks, the tokens, the time, and the trace of attempts.
import { evaluateCase } from './evaluate.mjs';

const GRAPH_ID = 'eval';
const ITEM_ID = 'note-eval-1';

/** The tokens a run used: the result's total, or for a failed call whatever its responses reported. */
function tokensOf(result, trace) {
  if (result.ok) return result.value.usage;
  return trace.filter((e) => e.type === 'response').reduce((sum, e) => ({ inputTokens: sum.inputTokens + e.usage.inputTokens, outputTokens: sum.outputTokens + e.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 });
}

/**
 * @param options.lib        { createLlm, summarise }
 * @param options.cases      golden cases
 * @param options.models     [{ label, choice }] where choice is { tier } or { model }
 * @param options.repeat     runs per case and model (models are not deterministic)
 * @param options.makeClient ({ caseDef, itemId, label, choice }) => a ModelClient
 * @param options.now        the clock in ms
 * @param options.timeoutMs  limit for each call
 * @param options.onResult   called with each finished run (progress)
 * @param options.signal     stops the run between calls when aborted
 */
export async function runEval({ lib, cases, models, repeat = 1, makeClient, now = Date.now, timeoutMs = 60_000, onResult, signal }) {
  const results = [];
  for (const model of models) {
    for (const caseDef of cases) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        if (signal?.aborted) return { results, aborted: true };
        const client = makeClient({ caseDef, itemId: ITEM_ID, label: model.label, choice: model.choice });
        const llm = lib.createLlm({ client, now });
        const trace = [];
        const started = now();
        const result = await llm.categorise(
          { text: caseDef.note, graphId: GRAPH_ID, itemId: ITEM_ID, categories: caseDef.categories },
          { ...model.choice, timeoutMs, trace: (event) => void trace.push(event) },
        );
        const latencyMs = now() - started;

        let outcome;
        let proposal = null;
        if (result.ok) {
          const existing = { items: [], categories: caseDef.categories.map((c) => c.id) };
          const summary = lib.summarise(result.value.mutation, existing);
          outcome = summary.ok ? { ok: true, summary: summary.value } : { ok: false, error: { code: 'SUMMARY', message: summary.error.message } };
          proposal = { rationale: result.value.rationale ?? null, ops: result.value.mutation.ops, model: result.value.model };
        } else {
          outcome = { ok: false, error: result.error };
        }
        const verdict = evaluateCase(caseDef, outcome);
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
          answeredBy: proposal?.model ?? null,
          proposal,
        };
        results.push(record);
        onResult?.(record, results.length);
      }
    }
  }
  return { results, aborted: false };
}

export const totalRuns = ({ cases, models, repeat = 1 }) => cases.length * models.length * repeat;
