import { describe, expect, it } from 'vitest';
import { USERS_ERROR_CODES, usersError } from './errors.js';

describe('users errors', () => {
  it('are a closed set of eight codes', () => {
    expect([...USERS_ERROR_CODES]).toEqual(['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN', 'THROTTLED', 'LAST_ADMIN', 'STORAGE_ERROR']);
  });

  it('carry a code and a message, and only the extras that were given', () => {
    expect(usersError('NOT_FOUND', 'no such user')).toEqual({ code: 'NOT_FOUND', message: 'no such user' });
    expect(usersError('INVALID_INPUT', 'bad', { field: 'username' })).toEqual({ code: 'INVALID_INPUT', message: 'bad', field: 'username' });
    expect(usersError('THROTTLED', 'slow down', { retryAfterMs: 2000 })).toEqual({ code: 'THROTTLED', message: 'slow down', retryAfterMs: 2000 });
    expect('field' in usersError('CONFLICT', 'taken')).toBe(false);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(usersError('FORBIDDEN', 'no'))).toBe(true);
  });
});
