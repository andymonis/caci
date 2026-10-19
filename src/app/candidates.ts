import { err, ok, query, type GraphError, type GraphOptions, type JsonObject, type Query, type Result, type StorageAdapter } from '../graph_store/index.js';

// Candidate items (R-014 D7): the existing items of ONE scope that a new note may be replacing. Found by the controller, not the
// model, with a deterministic word-overlap search, so the model can only ever be shown (and so only ever name) what is here.
// Reads only, through the public `query`.

/** An existing item as the categoriser is shown it. */
export interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export interface CandidateOptions {
  /** Most candidates returned. Default 8. */
  readonly maxCandidates?: number;
  /** Characters over all candidates' titles and summaries. Default 3,000. */
  readonly maxChars?: number;
  /** At most this many items of the scope are read. Default 2,000. */
  readonly maxRead?: number;
}

export const DEFAULT_CANDIDATE_OPTIONS = Object.freeze({ maxCandidates: 8, maxChars: 3000, maxRead: 2000 });

const TITLE_CLIP = 100;
const SUMMARY_CLIP = 300;
const PAGE = 500;

// Words too common to say two notes are about the same thing.
const STOP_TEXT = ` ${
  'a an the and or but if of on in at to from by for with about as is are was were be been am do does did have has had i me my we our you your he she it its his her they them their this that these those there here ' +
  'not no so than then too very can could will would should may might just also now again still more most some any all each into out up down over under after before'
} `;
const isStopWord = (word: string): boolean => STOP_TEXT.includes(` ${word} `);

const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({ one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' });

/** The distinct meaningful words of some text: lower case, numbers as digits, a trailing plural s removed, common words and single letters left out. */
export function wordsOf(text: string): Set<string> {
  const normal = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const out = new Set<string>();
  for (const raw of normal.split(' ')) {
    if (raw === '') continue;
    let word = NUMBER_WORDS[raw] ?? raw;
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    if (isStopWord(word) || (word.length === 1 && !/\d/.test(word))) continue;
    out.add(word);
  }
  return out;
}

const clip = (text: string, max: number): string => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
};

/** The time an item was made: a circle item's `contributedAt`, else the time inside a minted id (`note-<9 base-36 digits>-...`), else 0 (oldest). */
export function madeAt(id: string, data: JsonObject | undefined): number {
  const stamp = data?.contributedAt;
  if (typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0) return stamp;
  const m = /^[a-z]+-([0-9a-z]{9})-/.exec(id);
  if (m !== null) {
    const ms = Number.parseInt(m[1] as string, 36);
    if (Number.isSafeInteger(ms) && ms >= Date.UTC(2020, 0, 1)) return ms;
  }
  return 0;
}

interface Scored extends Candidate {
  readonly shared: number;
  readonly at: number;
}

/** The text of an item that is matched: its title and summary, and any other text it holds (but not who made it). */
function matchText(data: JsonObject | undefined): string {
  if (data === undefined) return '';
  return Object.entries(data)
    .filter(([key, value]) => key !== 'contributedBy' && typeof value === 'string')
    .map(([, value]) => value as string)
    .join(' ');
}

export interface ItemRow {
  readonly id: string;
  readonly data?: JsonObject;
}

/**
 * Ranks items by the number of meaningful words they share with the note (most first), then newest first, then by id in code
 * unit order. An item sharing no word is never returned. At most `maxCandidates`, within `maxChars` (the first that does not fit
 * stops the list, so what is returned is always the best ranked).
 */
export function rankCandidates(note: string, items: Iterable<ItemRow>, options: CandidateOptions = {}): Candidate[] {
  const maxCandidates = options.maxCandidates ?? DEFAULT_CANDIDATE_OPTIONS.maxCandidates;
  const maxChars = options.maxChars ?? DEFAULT_CANDIDATE_OPTIONS.maxChars;
  const wanted = wordsOf(note);
  if (maxCandidates < 1) return [];
  const scored: Scored[] = [];
  for (const item of items) {
    let shared = 0;
    for (const word of wordsOf(matchText(item.data))) if (wanted.has(word)) shared++;
    if (shared === 0) continue;
    scored.push({
      id: item.id,
      title: clip(typeof item.data?.title === 'string' ? item.data.title : '', TITLE_CLIP),
      summary: clip(typeof item.data?.summary === 'string' ? item.data.summary : '', SUMMARY_CLIP),
      shared,
      at: madeAt(item.id, item.data),
    });
  }
  scored.sort((a, b) => b.shared - a.shared || b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Candidate[] = [];
  let used = 0;
  for (const s of scored.slice(0, maxCandidates)) {
    const size = [...s.title].length + [...s.summary].length;
    if (used + size > maxChars) break;
    used += size;
    out.push({ id: s.id, title: s.title, summary: s.summary });
  }
  return out;
}

/** Reads the items of one graph (up to `maxRead`, through `query`) and ranks them against the note. Writes nothing. */
export async function readCandidates(adapter: StorageAdapter, graphId: string, note: string, options: CandidateOptions = {}, graphOptions?: GraphOptions): Promise<Result<Candidate[], GraphError>> {
  const maxRead = options.maxRead ?? DEFAULT_CANDIDATE_OPTIONS.maxRead;
  const rows: ItemRow[] = [];
  let cursor: string | null = null;
  do {
    const q: Query = { version: 1, graphId, from: { all: true }, traverse: { depth: 0 }, filter: { partition: 'item' }, return: { shape: 'nodes', includeData: true }, page: { limit: Math.min(PAGE, maxRead - rows.length), cursor } };
    const r = await query(adapter, q, graphOptions);
    if (!r.ok) return r;
    if (!('nodes' in r.value)) return err({ code: 'STORAGE_ERROR', message: 'an items listing did not return nodes' });
    for (const node of r.value.nodes) {
      if (rows.length >= maxRead) continue;
      rows.push(node.data === undefined ? { id: node.id } : { id: node.id, data: node.data });
    }
    cursor = rows.length >= maxRead ? null : r.value.nextCursor;
  } while (cursor !== null);
  return ok(rankCandidates(note, rows, options));
}
