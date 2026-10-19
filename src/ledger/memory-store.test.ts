import { describe, expect, it } from 'vitest';
import { createMemoryLedgerStore } from './memory-store.js';
import { runLedgerStoreConformance } from './testing/index.js';
import { capText, entryProblem, scopeKey } from './validate.js';
import { isLedgerId, newLedgerId } from './ids.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { ledgerError } from './errors.js';

runLedgerStoreConformance(createMemoryLedgerStore, { describe, it });

describe('the helpers', () => {
  it('capText cuts by character and leaves short text alone', () => {
    expect(capText('abc', 3)).toBe('abc');
    expect(capText('abcd', 3)).toBe('abc');
    expect(capText('😀😀😀', 2)).toBe('😀😀');
    expect(capText('', 5)).toBe('');
  });
  it('scopeKey tells the two kinds apart', () => {
    expect(scopeKey({ kind: 'personal', userId: 'x' })).toBe('personal:x');
    expect(scopeKey({ kind: 'circle', circleId: 'x' })).toBe('circle:x');
  });
  it('entryProblem accepts a sound entry and says what is wrong with a bad one', () => {
    const e = { id: 'l1', at: 0, scope: { kind: 'personal', userId: 'u1' }, actor: 'u1', action: 'added', kind: 'item', subject: 's', proposalId: 'p' };
    expect(entryProblem(e)).toBeUndefined();
    expect(entryProblem({ ...e, at: -1 })).toContain('at must');
    expect(entryProblem({ ...e, extra: 1 })).toContain('unknown field');
    expect(entryProblem({ ...e, ['x'.repeat(50)]: 1 })).toContain('x'.repeat(20));
    expect(entryProblem({ ...e, ['x'.repeat(50)]: 1 })).not.toContain('x'.repeat(21));
    expect(entryProblem([])).toContain('object');
    expect(entryProblem({ ...e, scope: 'x' })).toContain('scope must be an object');
    expect(entryProblem({ ...e, scope: { kind: 'x' } })).toContain('personal or circle');
  });
  it('ledger ids have one shape', () => {
    expect(isLedgerId(newLedgerId())).toBe(true);
    expect(newLedgerId()).not.toBe(newLedgerId());
    expect(isLedgerId('l123')).toBe(false);
    expect(isLedgerId(5)).toBe(false);
    expect(isLedgerId('L' + 'a'.repeat(16))).toBe(false);
  });
  it('cursors round-trip for their own scope only', () => {
    const scope = { kind: 'personal', userId: 'u1' } as const;
    const c = encodeCursor(scope, 5, 'l1');
    expect(decodeCursor(scope, c)).toEqual({ at: 5, id: 'l1' });
    expect(() => decodeCursor({ kind: 'personal', userId: 'u2' }, c)).toThrow(RangeError);
    expect(() => decodeCursor(scope, 'g' + Buffer.from('not json').toString('base64url'))).toThrow(RangeError);
    expect(() => decodeCursor(scope, 'g' + Buffer.from(JSON.stringify(['personal:u1', '5', 'l1'])).toString('base64url'))).toThrow(RangeError);
    expect(() => decodeCursor(scope, 'g' + Buffer.from(JSON.stringify(['personal:u1', 5])).toString('base64url'))).toThrow(RangeError);
  });
  it('errors are frozen', () => {
    expect(Object.isFrozen(ledgerError('STORAGE_ERROR', 'x'))).toBe(true);
  });
});
