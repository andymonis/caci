// Stand-in answering models for the tests, each with a known, deliberate behaviour. They read the real status request the
// way a model would (the entries and the question) and answer in the real reply format, so they go through the real
// guard, both arms and the real scoring.
import { hasPhrase } from './text.mjs';

const unescapeBlock = (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const ENTRY = /^\[(\d+)\] \(personal(?:, (\d{4}-\d{2}-\d{2}))?\) (.*)$/;
const flat = (text, max = 230) => [...text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

/** What a status request asked and was shown. */
export function readRequest(req) {
  const content = req.messages.map((m) => m.content).join('\n');
  const entriesText = /<entries>\n?([\s\S]*?)\n?<\/entries>/.exec(content)?.[1] ?? '';
  const ask = unescapeBlock(/<request>\n?([\s\S]*?)\n?<\/request>/.exec(content)?.[1] ?? '').trim();
  const entries = unescapeBlock(entriesText).split('\n').map((line) => ENTRY.exec(line)).filter(Boolean).map((m) => ({ n: Number(m[1]), day: m[2] ?? '', text: m[3] }));
  return { ask, entries };
}

const reply = (req, value) => ({ ok: true, value: { output: { kind: 'json', value }, usage: { inputTokens: 50, outputTokens: 20 }, model: req.model } });
const NOTHING = { headline: 'Nothing relevant.', points: [], nothing: true };
const one = (n, text) => ({ headline: 'From your notes.', points: [{ text: flat(text), refs: [n] }], nothing: false });

/** The scenario question being asked: the same wording at a different checkpoint is told apart by how many notes were shown. */
function findQuestion(scenarios, ask, shown) {
  const candidates = scenarios.flatMap((s) => s.questions.map((q) => ({ s, q, count: s.notes.findIndex((n) => n.id === q.after) + 1 }))).filter((x) => x.q.ask === ask);
  return (candidates.find((x) => x.count === shown) ?? candidates[0])?.q;
}

/**
 * @param {'ideal'|'parrot'|'amnesiac'|'nothing'} mode
 *   ideal: reads the question's own expectations and answers correctly
 *   parrot: quotes the OLDEST note that mentions the question's facts (so it gives the old value as current)
 *   amnesiac: quotes only the NEWEST note it was shown
 *   nothing: always says nothing is relevant
 */
export function answerer(mode, scenarios) {
  return {
    async complete(req) {
      const { ask, entries } = readRequest(req);
      if (mode === 'nothing' || entries.length === 0) return reply(req, NOTHING);
      if (mode === 'amnesiac') {
        const newest = entries.reduce((a, b) => (b.day > a.day || (b.day === a.day && b.n > a.n) ? b : a));
        return reply(req, one(newest.n, newest.text));
      }
      const q = findQuestion(scenarios, ask, entries.length);
      if (q === undefined) throw new Error(`the answerer does not know the question ${JSON.stringify(ask)}`);
      if (mode === 'ideal') {
        if (q.expectNothing === true) return reply(req, NOTHING);
        const first = q.must.map((g) => g[0]);
        return reply(req, { headline: flat(first.join('; '), 150), points: first.map((text) => ({ text: flat(text), refs: [1] })), nothing: false });
      }
      // parrot
      const phrases = [...(q.must ?? []).flat(), ...(q.stale ?? [])];
      const matching = entries.filter((e) => phrases.some((p) => hasPhrase(e.text, p)));
      if (matching.length === 0) return reply(req, NOTHING);
      const oldest = matching.reduce((a, b) => (b.day < a.day || (b.day === a.day && b.n < a.n) ? b : a));
      return reply(req, one(oldest.n, oldest.text));
    },
  };
}
