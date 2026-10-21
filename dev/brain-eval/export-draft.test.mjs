import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scenarioDraft } from '../../src/service/scenario-draft.ts';
import { loadScenarios, validateScenario } from './scenario.mjs';

// R-017 D13: a draft made by export-brain becomes a real scenario once a person adds questions.

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const T = Date.UTC(2026, 9, 14, 9, 30, 0);
const doc = {
  format: 'caci-brain-export', version: 1, exportedAt: T + 100000, brain: { kind: 'personal', name: 'ann' },
  counts: { facts: 0, categories: 0, links: 0, entries: 0, inputs: 2 }, categories: [], facts: [],
  ledger: [
    { at: T + 86_400_000, action: 'added', kind: 'input', text: 'Mum now takes 1 tablet daily after breakfast.', by: 'ann' },
    { at: T, action: 'added', kind: 'input', text: 'Mum takes 2 tablets daily after breakfast.', by: 'ann' },
  ],
};

describe('a draft from export-brain', () => {
  it('is not runnable as it is: the validator and the loader say that questions are missing, naming the draft', () => {
    const draft = scenarioDraft(doc);
    const problems = validateScenario(draft);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('questions must be a non-empty list (a draft made by export-brain has none: add some)');
    const dir = mkdtempSync(join(tmpdir(), 'caci-draft-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'ann.json'), JSON.stringify(draft));
    const loaded = loadScenarios(dir);
    expect(loaded.ok).toBe(false);
    expect(loaded.problems.join('\n')).toMatch(/ann\.json: scenario "brain-ann": questions must be a non-empty list \(a draft made by export-brain has none: add some\)/);
  });

  it('is a sound scenario once a valid question is added, and then loads', () => {
    const draft = scenarioDraft(doc);
    const withQuestion = { ...draft, questions: [{ id: 'q1', kind: 'override', after: 'n002', ask: 'How many tablets does Mum take?', must: [['1 tablet']], stale: ['2 tablets'], why: 'the later note replaces the dose' }] };
    expect(validateScenario(withQuestion)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'caci-draft-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ann.json'), JSON.stringify(withQuestion));
    const loaded = loadScenarios(dir);
    expect(loaded.ok).toBe(true);
    expect(loaded.scenarios.map((s) => s.id)).toEqual(['brain-ann']);
  });

  it('keeps the notes in time order and valid even when older facts and typed words are mixed', () => {
    const mixed = { ...doc, facts: [{ id: 'old', title: 'Mum: allergy', summary: 'penicillin', categories: [] }] };
    const draft = scenarioDraft(mixed);
    expect(draft.notes.map((n) => n.text)).toEqual(['Mum: allergy: penicillin', 'Mum takes 2 tablets daily after breakfast.', 'Mum now takes 1 tablet daily after breakfast.']);
    const problems = validateScenario({ ...draft, questions: [{ id: 'q1', kind: 'recall', after: 'n003', ask: 'What is Mum allergic to?', must: [['penicillin']], why: 'an early fact' }] });
    expect(problems).toEqual([]);
  });
});
