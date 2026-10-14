// The replay arm (R-013 D6): the same `status` capability, the same controls and the same answering model, but given every raw
// note up to the checkpoint as an entry, with its date, and the size limits lifted to hold them. Nothing is filed or stored.
import { entriesOf, lostAt, recordingClient } from './brain-arm.mjs';
import { askedAt, timeOf } from './scenario.mjs';
import { scoreAnswer } from './score.mjs';
import { containsPhrase, tokens } from './text.mjs';

export const DEFAULT_WINDOW_TOKENS = 150_000;
export const ORDERS = Object.freeze(['oldest-first', 'newest-first']);
const CHARS_PER_TOKEN = 4;
/** The prompt's limits count where an entry came from as well as its text; this is room for that. */
const WHERE_ALLOWANCE = 200;

/** A rough size of what would be sent: the request and every entry, about four characters to a token. */
export const estimateTokens = (request, entries) => Math.ceil((request.length + entries.reduce((n, e) => n + e.text.length, 0)) / CHARS_PER_TOKEN);

/** The entries for a question: every note up to and including its checkpoint, each with its date. */
export function entriesFor(scenario, question, order = 'oldest-first') {
  const upTo = scenario.notes.findIndex((n) => n.id === question.after);
  const entries = scenario.notes.slice(0, upTo + 1).map((n) => ({ where: 'personal', text: n.text, when: timeOf(n.at) }));
  return order === 'newest-first' ? entries.reverse() : entries;
}

const groupsIn = (groups, texts) => groups.map((group) => group.some((alt) => texts.some((t) => containsPhrase(t, tokens(alt)))));
const sum = (usages) => usages.reduce((t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens }), { inputTokens: 0, outputTokens: 0 });

/**
 * @param {object} p
 * @param {object} p.lib needs `createLlm` and `createLlmConfig`
 * @param {object} p.controls
 * @param {object} p.scenario a validated scenario
 * @param {{label:string, choice:object}[]} p.answerWith
 * @param {(who:{role:'answer', label:string, choice:object}) => object} p.makeClient
 * @param {number} [p.repeat]
 * @param {'oldest-first'|'newest-first'} [p.order]
 * @param {number} [p.windowTokens] a transcript estimated above this is not sent
 * @param {number} [p.timeoutMs]
 */
export async function runReplayArm({ lib, controls, scenario, answerWith, makeClient, repeat = 1, order = 'oldest-first', windowTokens = DEFAULT_WINDOW_TOKENS, timeoutMs = 120_000, signal, onResult }) {
  if (!ORDERS.includes(order)) throw new TypeError(`order must be one of ${ORDERS.join(', ')}`);
  const answers = [];
  const clock = { value: timeOf(scenario.notes[0].at) };
  const now = () => clock.value;
  const models = answerWith.map((m) => {
    const config = lib.createLlmConfig({ capabilities: { status: m.choice } });
    if (!config.ok) throw new Error(`bad model choice: ${config.error.message}`);
    const rec = recordingClient(makeClient({ role: 'answer', label: m.label, choice: m.choice }));
    return { model: m, rec, llm: lib.createLlm({ client: rec.client, controls, config: config.value, now }) };
  });

  for (const question of scenario.questions) {
    const entries = entriesFor(scenario, question, order);
    const estimate = estimateTokens(question.ask, entries);
    for (const a of models) {
      for (let run = 1; run <= repeat; run++) {
        if (signal?.aborted === true) return { answers, aborted: true };
        clock.value = askedAt(scenario, question);
        const overWindow = estimate > windowTokens;
        const before = a.rec.log.length;
        let result = null;
        if (!overWindow) {
          const total = entries.reduce((n, e) => n + e.text.length, 0);
          result = await a.llm.status(
            { text: question.ask, entries, timeZone: 'UTC' },
            { timeoutMs, maxEntries: Math.max(entries.length, 1), maxEntryChars: Math.max(...entries.map((e) => e.text.length), 1) + WHERE_ALLOWANCE, maxTotalChars: total + entries.length * WHERE_ALLOWANCE + 1 },
          );
        }
        const requests = a.rec.log.slice(before);
        const view = result?.ok === true ? result.value : null;
        const score = scoreAnswer(question, view === null ? null : { headline: view.headline, points: view.points, nothing: view.nothing });
        let diagnostic = null;
        if (question.expectNothing !== true) {
          const inBrain = question.must.map(() => true);
          const inContext = groupsIn(question.must, requests[0] === undefined ? [] : [tokens(entriesOf(requests[0].content))]);
          const inAnswer = score.groups.map((g) => g.met);
          diagnostic = { inBrain, inContext, inAnswer, lostAt: lostAt(inBrain, inContext, inAnswer) };
        }
        const record = {
          arm: 'replay', scenario: scenario.id, question: question.id, kind: question.kind, model: a.model.label, run,
          pass: score.pass, score, overWindow, estimatedTokens: estimate,
          error: result === null || result.ok ? null : { source: 'llm', code: result.error.code, message: result.error.message },
          answer: view === null ? null : { headline: view.headline, points: view.points.map((p) => p.text), nothing: view.nothing },
          tokens: sum(requests.map((e) => e.usage).filter((u) => u !== null)), attempts: requests.length, entriesUsed: overWindow ? 0 : entries.length, entriesLeftOut: 0, diagnostic,
        };
        answers.push(record);
        onResult?.(record);
      }
    }
  }
  return { answers, aborted: false };
}
