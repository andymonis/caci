import { describe, expect, it } from 'vitest';
import { checkFactIds, checkKey, checkPage, compareFacts, copyResolution, createMemoryResolutionStore, isFactId, resolutionProblem, scopeKey, scopeProblem } from './index.js';
import { runResolutionStoreConformance } from './testing/index.js';
import { describe as d, it as i } from 'vitest';

const good = { userId: 'u0000000000000001', scope: { kind: 'circle', circleId: 'c0000000000000001' }, factId: 'f1', verb: 'pay', at: 1 };

describe('the resolution record check', () => {
  it('accepts a good record and a personal scope', () => {
    expect(resolutionProblem(good)).toBeUndefined();
    expect(resolutionProblem({ ...good, scope: { kind: 'personal' } })).toBeUndefined();
  });
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an extra key', { ...good, text: 'x' }],
    ['a missing key', { ...good, at: undefined }],
  ])('refuses %s', (_name, value) => {
    expect(resolutionProblem(value)).toBeDefined();
  });
  it('names a long stray key only in part, so the message cannot carry text', () => {
    const problem = resolutionProblem({ ...good, ['secret-note-text-'.repeat(5)]: 1 }) as string;
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
  it('gives each scope its own key and orders by UTF-16 code unit', () => {
    expect(scopeKey({ kind: 'personal' })).toBe('personal');
    expect(scopeKey({ kind: 'circle', circleId: 'c0000000000000001' })).toBe('circle:c0000000000000001');
    const a = { scope: { kind: 'personal' as const }, factId: 'b' };
    expect(compareFacts(a, { ...a, factId: 'a' })).toBe(1);
    expect(compareFacts(a, { ...a })).toBe(0);
    expect(compareFacts({ scope: { kind: 'circle', circleId: 'c0000000000000001' }, factId: 'a' }, a)).toBe(-1);
  });
  it('a fact id counts characters, not units, and refuses a lone surrogate', () => {
    expect(isFactId('😀'.repeat(256))).toBe(true);
    expect(isFactId('😀'.repeat(257))).toBe(false);
    expect(isFactId('')).toBe(false);
    expect(isFactId(5)).toBe(false);
    expect(isFactId(`a${String.fromCharCode(0xdc00)}`)).toBe(false);
  });
  it('copies are frozen, including the scope', () => {
    const c = copyResolution(good as never);
    expect(Object.isFrozen(c) && Object.isFrozen(c.scope)).toBe(true);
  });
  it('page, key and id checks are RangeErrors', () => {
    expect(() => checkPage({ limit: 0 })).toThrow(RangeError);
    expect(() => checkPage({ limit: 5, after: { scope: { kind: 'x' } as never, factId: 'a' } })).toThrow(RangeError);
    expect(() => checkKey('u', { kind: 'personal' }, 'a')).toThrow(RangeError);
    expect(() => checkFactIds(Array.from({ length: 501 }, () => 'a'))).toThrow(RangeError);
    expect(() => checkFactIds(['a'])).not.toThrow();
  });
});

d('the memory resolution store', () => {
  runResolutionStoreConformance(createMemoryResolutionStore, { describe: d, it: i });
});
