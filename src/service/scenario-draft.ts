import type { BrainExport } from './brain-export.js';

// A brain-eval scenario draft made from an exported brain (R-017 D13). The notes are the words that were typed (oldest first, with
// their dates); facts that were entered before the words were recorded have none, so each becomes a note `title: summary`, dated
// when it was entered if that is known (else just before the earliest typed words), and the description says so. There are **no
// questions**: what a good answer contains is for a person who knows the notes to write, and the brain-eval refuses a scenario
// without them.

export interface ScenarioDraft {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly notes: ReadonlyArray<{ readonly id: string; readonly at: string; readonly text: string }>;
  readonly questions: readonly never[];
}

const isoOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const NOTE_CHARS = 8000;

export function scenarioDraft(doc: BrainExport): ScenarioDraft {
  const typed = doc.ledger.filter((e) => e.kind === 'input' && typeof e.text === 'string' && e.text.trim() !== '' && [...e.text].length <= NOTE_CHARS).map((e) => ({ at: e.at, text: e.text as string })).sort((a, b) => a.at - b.at);
  const known = new Set(doc.ledger.filter((e) => e.kind === 'item' && e.action === 'added' && e.subject !== undefined).map((e) => e.subject as string));
  const older = doc.facts.filter((f) => !known.has(f.id) && (f.title !== undefined || f.summary !== undefined));
  const first = typed[0]?.at ?? doc.exportedAt;
  const olderNotes = older
    .map((f, i) => ({ at: Math.min(f.at ?? first - (older.length - i) * 1000, first), text: f.title !== undefined && f.summary !== undefined ? `${f.title}: ${f.summary}` : (f.title ?? f.summary) as string }))
    .filter((n) => [...n.text].length <= NOTE_CHARS)
    .sort((a, b) => a.at - b.at);
  const all = [...olderNotes, ...typed];
  const slug = doc.brain.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const sources = `${typed.length} typed update${typed.length === 1 ? '' : 's'}${olderNotes.length === 0 ? '' : ` and ${olderNotes.length} older fact${olderNotes.length === 1 ? '' : 's'} from before the words were recorded (written as "title: summary", dated when entered if that is known)`}`;
  return {
    id: `brain-${slug === '' ? 'export' : slug}`,
    title: `Real notes from ${doc.brain.kind === 'personal' ? 'the brain of' : 'the circle'} ${doc.brain.name}`,
    description: `A draft made by export-brain from ${sources}. It has no questions yet: add some (and what a good answer must contain or leave out) before running it with the brain-eval.`,
    notes: all.map((n, i) => ({ id: `n${String(i + 1).padStart(3, '0')}`, at: isoOf(n.at), text: n.text })),
    questions: [],
  };
}
