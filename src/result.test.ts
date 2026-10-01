import { describe, expect, it } from 'vitest';
import { ERROR_CODES, err, graphError, ok, type Result } from './result.js';

describe('error codes', () => {
  it('is the closed set from the spec', () => {
    expect([...ERROR_CODES]).toEqual([
      'VALIDATION_ERROR',
      'GRAPH_NOT_FOUND',
      'NODE_NOT_FOUND',
      'CONFLICT',
      'UNSUPPORTED_VERSION',
      'STORAGE_ERROR',
    ]);
  });
});

describe('Result helpers', () => {
  it('ok wraps a value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });

  it('err wraps an error', () => {
    const e = graphError('GRAPH_NOT_FOUND', 'no such graph');
    expect(err(e)).toEqual({ ok: false, error: e });
  });

  it('graphError includes path only when given', () => {
    expect(graphError('VALIDATION_ERROR', 'bad')).not.toHaveProperty('path');
    expect(graphError('VALIDATION_ERROR', 'bad', ['ops', 2, 'category'])).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'bad',
      path: ['ops', 2, 'category'],
    });
  });

  it('narrows on ok', () => {
    const r: Result<number> = ok(5);
    if (r.ok) {
      expect(r.value).toBe(5);
    } else {
      expect.unreachable();
    }
  });
});
