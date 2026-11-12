import { describe, expect, it } from 'vitest';
import { dayOf, recordProblem, scopeKey, scopeProblem, createMemoryUsageStore } from './index.js';
import { runUsageStoreConformance } from './testing/index.js';
import { describe as d, it as i } from 'vitest';

const good = { at: 1, userId: 'u0000000000000001', capability: 'categorise', scope: { kind: 'personal' }, model: 'm', attempt: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, result: 'ok', latencyMs: 1 };

describe('the usage record check', () => {
  it('accepts a good record and a circle scope', () => {
    expect(recordProblem(good)).toBeUndefined();
    expect(recordProblem({ ...good, scope: { kind: 'circle', circleId: 'c0000000000000001' } })).toBeUndefined();
  });
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an extra key', { ...good, text: 'x' }],
    ['a missing key', { ...good, latencyMs: undefined, at: undefined }],
    ['a stray key with a long name is named but cut', { ...good, ['k'.repeat(50)]: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(recordProblem(value)).toBeDefined();
  });
  it('names a long stray key only in part, so the message cannot carry text', () => {
    const problem = recordProblem({ ...good, ['secret-note-text-'.repeat(5)]: 1 }) as string;
    expect(problem.length).toBeLessThan(80);
  });
  it('checks scope shapes strictly', () => {
    expect(scopeProblem({ kind: 'personal' })).toBeUndefined();
    expect(scopeProblem({ kind: 'personal', x: 1 })).toBeDefined();
    expect(scopeProblem({ kind: 'circle' })).toBeDefined();
    expect(scopeProblem({ kind: 'circle', circleId: 'c0000000000000001', x: 1 })).toBeDefined();
    expect(scopeProblem('personal')).toBeDefined();
    expect(scopeProblem(null)).toBeDefined();
  });
  it('gives each scope its own key and the day in UTC', () => {
    expect(scopeKey({ kind: 'personal' })).toBe('personal');
    expect(scopeKey({ kind: 'circle', circleId: 'c0000000000000001' })).toBe('circle:c0000000000000001');
    expect(dayOf(Date.UTC(2026, 10, 3, 23, 59, 59, 999))).toBe('2026-11-03');
    expect(dayOf(Date.UTC(2026, 10, 4))).toBe('2026-11-04');
  });
  it('a model name with a control character or a space is refused', () => {
    expect(recordProblem({ ...good, model: `a${String.fromCharCode(1)}b` })).toBeDefined();
    expect(recordProblem({ ...good, model: `a${String.fromCharCode(127)}b` })).toBeDefined();
    expect(recordProblem({ ...good, model: 'a b' })).toBeDefined();
  });
  it('the model name rule counts characters, not units', () => {
    expect(recordProblem({ ...good, model: '😀'.repeat(200) })).toBeUndefined();
    expect(recordProblem({ ...good, model: '😀'.repeat(201) })).toBeDefined();
  });
});

d('the memory usage store', () => {
  runUsageStoreConformance(createMemoryUsageStore, { describe: d, it: i });
});
