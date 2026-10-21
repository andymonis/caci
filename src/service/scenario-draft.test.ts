import { describe, expect, it } from 'vitest';
import type { BrainExport, ExportEntry, ExportFact } from './brain-export.js';
import { scenarioDraft } from './scenario-draft.js';

const T = Date.UTC(2026, 9, 14, 9, 30, 0);
const doc = (over: { name?: string; kind?: 'personal' | 'circle'; facts?: ExportFact[]; ledger?: ExportEntry[]; exportedAt?: number } = {}): BrainExport => ({
  format: 'caci-brain-export', version: 1, exportedAt: over.exportedAt ?? T + 1_000_000, brain: { kind: over.kind ?? 'personal', name: over.name ?? 'ann' },
  counts: { facts: 0, categories: 0, links: 0, entries: 0, inputs: 0 }, categories: [], facts: over.facts ?? [], ledger: over.ledger ?? [],
});
const input = (at: number, text: string): ExportEntry => ({ at, action: 'added', kind: 'input', text, by: 'ann' });
const added = (at: number, subject: string): ExportEntry => ({ at, action: 'added', kind: 'item', subject, by: 'ann' });

describe('a scenario draft', () => {
  it('has the typed words as notes, oldest first, dated to the second in UTC, with numbered ids and no questions', () => {
    const d = scenarioDraft(doc({ ledger: [input(T + 2000, 'second words'), added(T + 2001, 'f2'), input(T, 'first words'), added(T + 1, 'f1')] }));
    expect(d.notes).toEqual([{ id: 'n001', at: '2026-10-14T09:30:00Z', text: 'first words' }, { id: 'n002', at: '2026-10-14T09:30:02Z', text: 'second words' }]);
    expect(d.questions).toEqual([]);
    expect(d.id).toBe('brain-ann');
    expect(d.title).toBe('Real notes from the brain of ann');
    expect(d.description).toContain('2 typed updates');
    expect(d.description).toContain('no questions');
  });

  it('keeps the words exactly: markup, new lines, emoji, spaces', () => {
    const text = '  <b>Mum</b> now takes 1 tablet 😀\nsecond line  ';
    expect(scenarioDraft(doc({ ledger: [input(T, text)] })).notes[0]?.text).toBe(text);
  });

  it('turns facts from before the words were recorded into notes "title: summary", placed before the typed words, dated when entered if known', () => {
    const facts: ExportFact[] = [
      { id: 'old-a', title: 'Mum: phone', summary: '0770', at: T - 5000, categories: [] },
      { id: 'old-b', title: 'Dad: ward', categories: [] },
      { id: 'old-c', summary: 'only a summary', at: T - 9000, categories: [] },
      { id: 'covered', title: 'Typed', summary: 'already told', categories: [] },
    ];
    const d = scenarioDraft(doc({ facts, ledger: [input(T, 'typed words'), added(T + 1, 'covered')] }));
    expect(d.notes.map((n) => n.text)).toEqual(['only a summary', 'Mum: phone: 0770', 'Dad: ward', 'typed words']);
    expect(d.notes[0]?.at).toBe('2026-10-14T09:29:51Z');
    expect(d.notes[1]?.at).toBe('2026-10-14T09:29:55Z');
    expect(d.notes.every((n) => n.at <= '2026-10-14T09:30:00Z')).toBe(true);
    expect(d.description).toContain('3 older facts');
    expect(d.description).toContain('1 typed update ');
  });

  it('with no typed words at all, every fact is a note, dated just before the export when it has no time', () => {
    const d = scenarioDraft(doc({ facts: [{ id: 'a', title: 'A', summary: 'one', categories: [] }, { id: 'b', title: 'B', summary: 'two', categories: [] }] }));
    expect(d.notes.map((n) => n.text)).toEqual(['A: one', 'B: two']);
    expect(d.notes.map((n) => n.at)).toEqual(['2026-10-14T09:46:38Z', '2026-10-14T09:46:39Z']);
    expect(d.description).toContain('0 typed updates');
  });

  it('a fact with neither title nor summary, empty or over-long words, and non-input entries make no note', () => {
    const d = scenarioDraft(doc({ facts: [{ id: 'a', categories: [] }], ledger: [input(T, '   '), input(T + 1, 'x'.repeat(8001)), { at: T + 2, action: 'removed', kind: 'item', subject: 'z', title: 'gone' }, input(T + 3, 'x'.repeat(8000))] }));
    expect(d.notes).toHaveLength(1);
    expect([...d.notes[0]?.text ?? ''].length).toBe(8000);
  });

  it('names a circle as a circle, and makes a safe id from any name', () => {
    expect(scenarioDraft(doc({ kind: 'circle', name: 'Parent care' })).title).toBe('Real notes from the circle Parent care');
    expect(scenarioDraft(doc({ name: 'Parent care' })).id).toBe('brain-parent-care');
    expect(scenarioDraft(doc({ name: '  ../Ünï <b>x</b>  ' })).id).toBe('brain-n-b-x-b');
    expect(scenarioDraft(doc({ name: '😀😀' })).id).toBe('brain-export');
    expect(scenarioDraft(doc({ name: 'a'.repeat(100) })).id).toBe(`brain-${'a'.repeat(40)}`);
  });

  it('ordering is by time whatever the order the export gives them in, and ties keep a stable order', () => {
    const d = scenarioDraft(doc({ ledger: [input(T + 5, 'c'), input(T, 'a'), input(T + 5, 'd'), input(T + 2, 'b')] }));
    expect(d.notes.map((n) => n.text)).toEqual(['a', 'b', 'c', 'd']);
  });
});
