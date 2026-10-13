import { err, ok, type JsonObject, type Result } from '../graph_store/index.js';
import { runWithDeadline } from './deadline.js';
import { llmError, type LlmError } from './errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from './model-client.js';
import { checkRequest } from './request-check.js';

// A model that costs nothing and sends nothing anywhere. It reads the real prompt the categoriser builds
// (the note's id, the note, the existing categories) and answers with a simple, deterministic rule: link
// the note to the one or two categories whose id or name shares a word with it, or else create one named
// after its commonest word. It is a demonstration so the whole propose / preview / approve flow can be
// used without a key; it is not a classifier, and it is what the service uses unless told otherwise.

const STOPWORDS: readonly string[] = Object.freeze(
  ('the and for with that this from have has had was were are not but you your our their about into onto over under again also just need needs want wants ' +
    'will would could should can may might get got make made new one two three four five six next last first then than them they she him her his its ' +
    'been being very more most some any all out off per via').split(' '),
);

const MAX_TITLE = 60;
const MAX_SUMMARY = 120;
const MAX_WORD = 30;
const MAX_ID = 40;

/** At most `max` characters, never cutting a character in half (no lone surrogate can end up in the reply). */
const clip = (text: string, max: number): string => [...text].slice(0, max).join('');
const unescapeBlock = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const wordsOf = (text: unknown): string[] =>
  String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => [...w].length >= 3 && !STOPWORDS.includes(w));
const same = (a: string, b: string): boolean => a === b || ([...a].length >= 4 && [...b].length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const capitalise = (word: string): string => {
  const [first = '', ...rest] = [...word];
  return first.toUpperCase() + rest.join('');
};
/** Plain code-unit order, so the answer never depends on the machine's locale. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CategoryLine {
  readonly id: string;
  readonly links?: number;
  readonly data?: { readonly name?: unknown };
}

/** What the categoriser put in the prompt. */
function readRequest(request: ModelRequest): { itemId: string | undefined; note: string | undefined; categories: CategoryLine[] } {
  const itemId = /The note's own id is "([^"]+)"/.exec(request.system ?? '')?.[1];
  const content = request.messages[0]?.content ?? '';
  const note = /<note>\n([\s\S]*?)\n<\/note>/.exec(content)?.[1];
  const block = /<categories>\n([\s\S]*?)\n<\/categories>/.exec(content)?.[1] ?? '';
  const categories: CategoryLine[] = [];
  for (const line of unescapeBlock(block).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as CategoryLine;
      if (typeof entry.id === 'string') categories.push(entry);
    } catch {
      // not an entry: a header, or a note about categories left out
    }
  }
  return { itemId, note: note === undefined ? undefined : unescapeBlock(note), categories };
}

const MAX_HEADLINE = 160;
const MAX_POINT = 240;
const MAX_POINTS = 5;
const oneLine = (text: string): string => text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * The reply for a status prompt: a headline with the date and how many notes were read, and up to five points
 * quoting the entries (the ones sharing words with the request first, else the newest, in the order given), each
 * citing its number; or "nothing" when there are no entries. Deterministic, and valid for any entries.
 */
function demoStatusReply(request: ModelRequest): JsonObject | undefined {
  const system = request.system ?? '';
  const count = Number(/numbered 1 to (\d+)/.exec(system)?.[1]);
  const content = request.messages[0]?.content ?? '';
  const block = /<entries>\n([\s\S]*?)\n<\/entries>/.exec(content)?.[1];
  const asked = /<request>\n([\s\S]*?)\n<\/request>/.exec(content)?.[1];
  if (!Number.isSafeInteger(count) || block === undefined || asked === undefined) return undefined;
  const day = /current date and time is ([A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4})/.exec(system)?.[1] ?? 'today';
  const entries: { n: number; where: string; text: string }[] = [];
  for (const line of unescapeBlock(block).split('\n')) {
    const m = /^\[(\d+)\] \(([^)]*?)(?:, \d{4}-\d{2}-\d{2})?\) ([\s\S]*)$/.exec(line);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count) entries.push({ n, where: m[2] ?? '', text: oneLine(m[3] ?? '') });
  }
  if (entries.length === 0) return { headline: clip(`${day}: nothing relevant was found in your notes.`, MAX_HEADLINE), points: [], nothing: true };
  const wanted = wordsOf(unescapeBlock(asked));
  const scored = entries
    .map((e, i) => ({ ...e, i, score: [...new Set(wordsOf(e.text))].filter((w) => wanted.some((x) => same(x, w))).length }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_POINTS);
  const points = scored.map((e) => ({ text: clip(`${e.text || '(no text)'}${e.where === 'personal' || e.where === '' ? '' : ` (${oneLine(e.where)})`}`, MAX_POINT), refs: [e.n] }));
  return { headline: clip(`${day}: I read ${entries.length} note${entries.length === 1 ? '' : 's'}; here ${points.length === 1 ? 'is the one' : `are the ${points.length}`} most relevant.`, MAX_HEADLINE), points, nothing: false };
}

/** The reply the demo model gives for a prompt, as the JSON object the capability expects; `undefined` if the prompt is not one it understands. */
export function demoReply(request: ModelRequest): JsonObject | undefined {
  if ((request.system ?? '').startsWith('You are the status assistant')) return demoStatusReply(request);
  const { itemId, note, categories } = readRequest(request);
  if (itemId === undefined || note === undefined) return undefined;
  const noteWords = wordsOf(note);
  const scored = categories
    .map((c) => {
      const own = [...new Set([...wordsOf(c.id), ...wordsOf(c.data?.name ?? '')])];
      return { id: c.id, links: typeof c.links === 'number' ? c.links : 0, score: own.filter((w) => noteWords.some((n) => same(n, w))).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.links - a.links || byId(a.id, b.id))
    .slice(0, 2);

  const words = note.trim().split(/\s+/).filter(Boolean);
  const ops: JsonObject[] = [
    {
      op: 'upsertNode',
      partition: 'item',
      id: itemId,
      data: { title: clip(words.slice(0, 8).join(' '), MAX_TITLE) || 'Untitled', summary: clip(note.replace(/\s+/g, ' ').trim(), MAX_SUMMARY) || 'Empty note' },
    },
  ];
  let rationale: string;
  if (scored.length > 0) {
    scored.forEach((c, i) => ops.push({ op: 'link', item: itemId, category: c.id, weight: i === 0 ? 0.9 : 0.6 }));
    rationale = `The note shares words with ${scored.map((c) => `"${clip(c.id, MAX_ID)}"`).join(' and ')}.`;
  } else {
    const counts = new Map<string, number>();
    for (const w of noteWords) counts.set(w, (counts.get(w) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || [...b[0]].length - [...a[0]].length || byId(a[0], b[0]))[0]?.[0];
    const word = best === undefined ? undefined : clip(best, MAX_WORD);
    const id = clip((word ?? 'inbox').replace(/[^\p{L}\p{N}]+/gu, '-'), MAX_ID);
    ops.push({ op: 'upsertNode', partition: 'category', id, data: { name: capitalise(word ?? 'inbox') } }, { op: 'link', item: itemId, category: id, weight: 0.8 });
    rationale = word === undefined ? 'The note has no distinctive words, so it goes to a new "inbox" category.' : `No existing category shares a word with the note, so a new one was made from "${word}".`;
  }
  return { ops, rationale };
}

/** Rough, but plausible and never zero: about four characters to a token. */
const tokens = (characters: number): number => Math.max(1, Math.ceil(characters / 4));

/**
 * A `ModelClient` that answers with `demoReply`. Like any client it checks the request, honours the
 * time limit and cancellation, and never throws; it answers at once, so it cannot hang.
 */
export function createDemoModelClient(): ModelClient {
  return Object.freeze({
    async complete(request: ModelRequest): Promise<Result<ModelResponse, LlmError>> {
      try {
        const problem = checkRequest(request);
        if (problem !== undefined) return err(problem);
        return await runWithDeadline(
          async (): Promise<Result<ModelResponse, LlmError>> => {
            const reply = demoReply(request);
            if (reply === undefined) return err(llmError('MODEL_ERROR', 'the demo model does not understand this prompt'));
            const text = JSON.stringify(reply);
            const inputChars = (request.system?.length ?? 0) + request.messages.reduce((n, m) => n + m.content.length, 0);
            return ok({
              model: 'demo',
              output: request.outputSchema === undefined ? { kind: 'text', text } : { kind: 'json', value: reply },
              usage: { inputTokens: tokens(inputChars), outputTokens: tokens(text.length) },
            });
          },
          { timeoutMs: request.timeoutMs, signal: request.signal },
        );
      } catch (cause) {
        return err(llmError('MODEL_ERROR', `the demo model failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    },
  });
}
