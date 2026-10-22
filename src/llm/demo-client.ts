import { err, ok, type JsonObject, type Result } from '../graph_store/index.js';
import { runWithDeadline } from './deadline.js';
import { llmError, type LlmError } from './errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from './model-client.js';
import { checkRequest } from './request-check.js';
import { datesInWindow } from './demo-dates.js';

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

/** Words that say a note changes something that was already noted ("now takes", "moved to", "corrected", "instead"). */
const CHANGE_CUE = /\b(?:now|changed|change|instead|moved|move|rescheduled|corrected|correction|actually|new|replaced|cancelled|canceled|switched)\b/i;
/** A note replaces an existing one only if they share at least this many words. */
const REPLACE_SHARED_WORDS = 3;

interface CategoryLine {
  readonly id: string;
  readonly links?: number;
  readonly data?: { readonly name?: unknown };
}

/** What the categoriser put in the prompt. */
function readRequest(request: ModelRequest): { itemId: string | undefined; maxFacts: number; note: string | undefined; categories: CategoryLine[] } {
  const itemId = request.meta?.capability === 'categorise' ? request.meta.itemId : undefined;
  const maxFacts = request.meta?.capability === 'categorise' ? (request.meta.maxFacts ?? 1) : 1;
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
  return { itemId, maxFacts, note: note === undefined ? undefined : unescapeBlock(note), categories };
}

/** The existing notes the categoriser showed, as `[number, text]` (the text is `title: summary`). */
function readExisting(request: ModelRequest): Array<readonly [number, string, string]> {
  const block = /<existing>\n([\s\S]*?)\n<\/existing>/.exec(request.messages[0]?.content ?? '')?.[1];
  if (block === undefined) return [];
  const out: Array<readonly [number, string, string]> = [];
  for (const line of unescapeBlock(block).split('\n')) {
    const m = /^\[(\d+)\] (?:(.*?) — )?(.*)$/.exec(line);
    if (m !== null) out.push([Number(m[1]), m[3] as string, m[2] ?? '']);
  }
  return out;
}

/** `Thursday 15 October 2026` in the zone, from the request's own facts (not from the wording of any prompt). */
function dayText(now: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(now);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
  } catch {
    return 'today';
  }
}

const SILENT = Object.freeze({ week: 'Nothing needs your attention this week.', month: 'Nothing needs your attention in the next month.', year: 'Nothing is on the radar for the next year.' });
const FOR = Object.freeze({ week: 'this week', month: 'in the next month', year: 'in the next year' });
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
  const meta = request.meta;
  if (meta?.capability !== 'status') return undefined;
  const count = meta.entryCount;
  const content = request.messages[0]?.content ?? '';
  const block = /<entries>\n([\s\S]*?)\n<\/entries>/.exec(content)?.[1];
  const asked = /<request>\n([\s\S]*?)\n<\/request>/.exec(content)?.[1];
  if (!Number.isSafeInteger(count) || block === undefined || asked === undefined) return undefined;
  const day = dayText(meta.now, meta.timeZone);
  const entries: { n: number; where: string; text: string }[] = [];
  for (const line of unescapeBlock(block).split('\n')) {
    const m = /^\[(\d+)\] \(([^)]*?)(?:, \d{4}-\d{2}-\d{2})?\) ([\s\S]*)$/.exec(line);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count) entries.push({ n, where: m[2] ?? '', text: oneLine(m[3] ?? '') });
  }
  const focus = meta.horizon;
  if (focus !== undefined) {
    // a focused check (R-018): only entries with a date inside the window; nothing in the window is a one-line, silent answer
    const found = entries
      .map((e, i) => ({ ...e, i, first: datesInWindow(e.text, focus.fromDay, focus.toDay)[0] }))
      .filter((e): e is typeof e & { first: string } => e.first !== undefined)
      .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.i - b.i));
    if (found.length === 0) return { headline: SILENT[focus.name], points: [], nothing: true };
    const shown = found.slice(0, focus.maxPoints);
    const points = shown.map((e) => ({ text: clip(`${e.text}${e.where === 'personal' || e.where === '' ? '' : ` (${oneLine(e.where)})`}`, MAX_POINT), refs: [e.n] }));
    return { headline: clip(`${day}: ${found.length} thing${found.length === 1 ? '' : 's'} to look at ${FOR[focus.name]}.`, MAX_HEADLINE), points, nothing: false };
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
  if (request.meta?.capability === 'status') return demoStatusReply(request);
  const { itemId, maxFacts, note, categories } = readRequest(request);
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

  // The facts of the note (R-015): one when only one is allowed, else the note split at sentences and `label: value` pairs.
  const facts = maxFacts > 1 ? splitFacts(note, maxFacts) : [{ text: note, key: undefined as string | undefined }];
  const existing = readExisting(request);
  const withKeys = maxFacts > 1;
  const ops: JsonObject[] = facts.map((fact, i) => {
    const words = fact.text.trim().split(/\s+/).filter(Boolean);
    const key = withKeys ? reuseKey(fact, existing) : undefined;
    return {
      op: 'upsertNode',
      partition: 'item',
      id: i === 0 ? itemId : `${itemId}-${i + 1}`,
      data: {
        title: clip(words.slice(0, 8).join(' '), MAX_TITLE) || 'Untitled',
        summary: clip(fact.text.replace(/\s+/g, ' ').trim(), MAX_SUMMARY) || 'Empty note',
        ...(key === undefined || key === '' ? {} : { key }),
      },
    };
  });
  const factIds = ops.map((o) => o.id as string);
  let rationale: string;
  let categoryIds: Array<{ id: string; weight: number }>;
  if (scored.length > 0) {
    categoryIds = scored.map((c, i) => ({ id: c.id, weight: i === 0 ? 0.9 : 0.6 }));
    rationale = `The note shares words with ${scored.map((c) => `"${clip(c.id, MAX_ID)}"`).join(' and ')}.`;
  } else {
    const counts = new Map<string, number>();
    for (const w of noteWords) counts.set(w, (counts.get(w) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || [...b[0]].length - [...a[0]].length || byId(a[0], b[0]))[0]?.[0];
    const word = best === undefined ? undefined : clip(best, MAX_WORD);
    const id = clip((word ?? 'inbox').replace(/[^\p{L}\p{N}]+/gu, '-'), MAX_ID);
    ops.push({ op: 'upsertNode', partition: 'category', id, data: { name: capitalise(word ?? 'inbox') } });
    categoryIds = [{ id, weight: 0.8 }];
    rationale = word === undefined ? 'The note has no distinctive words, so it goes to a new "inbox" category.' : `No existing category shares a word with the note, so a new one was made from "${word}".`;
  }
  for (const fact of factIds) for (const c of categoryIds) ops.push({ op: 'link', item: fact, category: c.id, weight: c.weight });
  const replaces = replacedBy(note, facts.map((f) => f.text), existing);
  if (replaces.length > 0) rationale = `${rationale} It changes ${replaces.length === 1 ? `note ${replaces[0]}` : `notes ${replaces.join(', ')}`}, which it replaces.`;
  return { ops, rationale, ...(replaces.length === 0 ? {} : { replaces }) };
}

const MAX_KEY = 80;
const FACT_CLIP = 400;

interface DemoFact {
  readonly text: string;
  /** A key from the label of a `label: value` fact, when it had one. */
  readonly key: string | undefined;
}

/** A key for a fact: its label or subject, then its first two meaningful words, lower case. */
function keyOf(subject: string | undefined, text: string): string {
  const own = wordsOf(text).slice(0, 2).join(' ');
  const head = subject === undefined ? '' : wordsOf(subject).slice(0, 2).join(' ');
  return clip([head, own].filter(Boolean).join(' / '), MAX_KEY);
}

/**
 * The note as facts, for the demo: sentences and `;` clauses are separate facts; `Subject: part, part, part` becomes one fact per part
 * (each keeping the subject); `Label: value, Label: value` becomes one fact per pair. More than `max` are merged into the last.
 * Deterministic and simple: a stand-in for a model that reads, not a reader.
 */
export function splitFacts(note: string, max: number): DemoFact[] {
  const segments = note.split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\p{N}])|;\s*/u).map((s) => s.trim()).filter((s) => [...s].length >= 3);
  const out: DemoFact[] = [];
  for (const raw of segments) {
    const segment = clip(raw, FACT_CLIP);
    const pairs = segment.split(/,\s*(?=[^,:]{1,25}:\s)/u);
    const subject = /^([^:,]{1,40}):\s*(.+)$/u.exec(segment);
    if (pairs.length > 1 && pairs.every((p) => /^[^:]{1,25}:\s*\S/u.test(p))) {
      for (const p of pairs) out.push({ text: p, key: keyOf(p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)) });
    } else if (subject !== null) {
      const parts = (subject[2] as string).split(/,\s*(?:and\s+)?/u).map((p) => p.trim().replace(/[.]$/u, '')).filter((p) => [...p].length >= 2);
      if (parts.length > 1 && !/:/u.test(subject[2] as string)) for (const p of parts) out.push({ text: `${subject[1]}: ${p}`, key: keyOf(subject[1], p) });
      else out.push({ text: segment, key: keyOf(subject[1], subject[2] as string) });
    } else out.push({ text: segment, key: keyOf(undefined, segment) });
  }
  if (out.length === 0) return [{ text: note, key: keyOf(undefined, note) }];
  if (out.length <= max) return out;
  const head = out.slice(0, max - 1);
  const tail = out.slice(max - 1);
  return [...head, { text: clip(tail.map((f) => f.text).join(' '), FACT_CLIP), key: tail[0]?.key }];
}

/** The key of an existing fact whose key words all appear in this fact (so an update reuses it), else the fact's own key. */
function reuseKey(fact: DemoFact, existing: ReadonlyArray<readonly [number, string, string]>): string | undefined {
  const mine = wordsOf(fact.text);
  for (const [, , key] of existing) {
    const keyWords = wordsOf(key);
    if (keyWords.length > 0 && keyWords.every((w) => mine.some((x) => same(x, w)))) return clip(key, MAX_KEY);
  }
  return fact.key;
}

/**
 * The numbers of the existing notes this note replaces: only if it reads like a change, then for each fact the best existing note
 * whose key words are all in the fact, or that shares at least three words with it (one number at most per fact, none twice).
 */
function replacedBy(note: string, facts: readonly string[], existing: ReadonlyArray<readonly [number, string, string]>): number[] {
  if (existing.length === 0 || !CHANGE_CUE.test(note)) return [];
  const chosen = new Set<number>();
  for (const text of facts) {
    const mine = wordsOf(text);
    let best: { n: number; rank: number } | undefined;
    for (const [n, existingText, key] of existing) {
      const shared = [...new Set(wordsOf(existingText))].filter((w) => mine.some((x) => same(x, w))).length;
      const keyWords = wordsOf(key);
      const keyHit = keyWords.length > 0 && keyWords.every((w) => mine.some((x) => same(x, w)));
      if (!keyHit && shared < REPLACE_SHARED_WORDS) continue;
      const rank = (keyHit ? 1000 : 0) + shared;
      if (best === undefined || rank > best.rank) best = { n, rank };
    }
    if (best !== undefined) chosen.add(best.n);
  }
  return [...chosen].sort((a, b) => a - b).slice(0, 5);
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
