import { describe, expect, it } from 'vitest';
import { LLM_ERROR_CODES, llmError } from './errors.js';

describe('LLM error codes', () => {
  it('are the closed set from the plan, in order', () => {
    expect([...LLM_ERROR_CODES]).toEqual(['TIMEOUT', 'RATE_LIMITED', 'REFUSED', 'BAD_OUTPUT', 'MODEL_ERROR', 'CONFIG']);
  });

  it('do not overlap the graph store codes that mean something else', () => {
    expect(LLM_ERROR_CODES).not.toContain('VALIDATION_ERROR');
    expect(LLM_ERROR_CODES).not.toContain('STORAGE_ERROR');
  });
});

describe('llmError', () => {
  it('carries the code and message', () => {
    expect(llmError('REFUSED', 'the model declined')).toMatchObject({ code: 'REFUSED', message: 'the model declined' });
  });

  it.each([
    ['TIMEOUT', true],
    ['RATE_LIMITED', true],
    ['REFUSED', false],
    ['BAD_OUTPUT', false],
    ['MODEL_ERROR', false],
    ['CONFIG', false],
  ] as const)('%s is retryable: %s, by default', (code, retryable) => {
    expect(llmError(code, 'x').retryable).toBe(retryable);
  });

  it('lets a caller override retryable, for example a server fault reported as MODEL_ERROR', () => {
    expect(llmError('MODEL_ERROR', 'provider returned 503', { retryable: true }).retryable).toBe(true);
    expect(llmError('TIMEOUT', 'x', { retryable: false }).retryable).toBe(false);
  });

  it('keeps how long a rate limit asked callers to wait, and omits the field otherwise', () => {
    expect(llmError('RATE_LIMITED', 'slow down', { retryAfterMs: 1500 })).toMatchObject({ retryAfterMs: 1500 });
    expect(llmError('RATE_LIMITED', 'slow down')).not.toHaveProperty('retryAfterMs');
  });

  it('is frozen, so an error cannot be changed after it is made', () => {
    const e = llmError('TIMEOUT', 'x');
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { message: string }).message = 'changed';
    }).toThrow(TypeError);
  });
});
