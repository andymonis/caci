import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { mapProviderError, redact } from './errors.js';

const SECRET = 'sk-ant-api03-SECRET-0000';
const body = (message: string) => ({ type: 'error', error: { type: 'x', message } });
const headers = (h: Record<string, string> = {}) => new Headers(h);

describe('redact', () => {
  it('removes the key wherever it appears, including several times', () => {
    expect(redact(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [redacted] b [redacted]');
  });
  it('removes a key of any shape, not only ones that look like Anthropic keys', () => {
    expect(redact('bad key gateway-key-ABC123 given', 'gateway-key-ABC123')).toBe('bad key [redacted] given');
  });
  it('removes anything shaped like a key, even a different one', () => {
    expect(redact('token sk-ant-other-key_123 here', SECRET)).toBe('token [redacted] here');
  });
  it('collapses whitespace and cuts long text', () => {
    expect(redact('a\n\n  b', SECRET)).toBe('a b');
    const long = redact('x'.repeat(1000), SECRET);
    expect(long).toHaveLength(301);
    expect(long.endsWith('…')).toBe(true);
  });
  it('with no secret just cleans up', () => {
    expect(redact('hello', '')).toBe('hello');
  });
});

describe('mapProviderError', () => {
  it('cancellation', () => expect(mapProviderError(new APIUserAbortError(), SECRET)).toMatchObject({ code: 'CANCELLED', retryable: false }));
  it('the SDK\'s own connection timeout', () => expect(mapProviderError(new APIConnectionTimeoutError(), SECRET)).toMatchObject({ code: 'TIMEOUT', retryable: true }));
  it('a connection failure', () => expect(mapProviderError(new APIConnectionError({ message: 'ECONNRESET' }), SECRET)).toMatchObject({ code: 'MODEL_ERROR', retryable: true }));

  it('uses the status classes', () => {
    const cases: Array<[APIError, string, boolean]> = [
      [new RateLimitError(429, body('slow'), 'x', headers()), 'RATE_LIMITED', true],
      [new NotFoundError(404, body('no model'), 'x', headers()), 'CONFIG', false],
      [new AuthenticationError(401, body('bad key'), 'x', headers()), 'CONFIG', false],
      [new PermissionDeniedError(403, body('no'), 'x', headers()), 'CONFIG', false],
      [new BadRequestError(400, body('bad'), 'x', headers()), 'MODEL_ERROR', false],
      [new InternalServerError(500, body('oops'), 'x', headers()), 'MODEL_ERROR', true],
      [new InternalServerError(529, body('busy'), 'x', headers()), 'MODEL_ERROR', true],
      [new APIError(499, body('odd'), 'x', headers()), 'MODEL_ERROR', false],
    ];
    for (const [error, code, retryable] of cases) expect(mapProviderError(error, SECRET)).toMatchObject({ code, retryable });
  });

  it('says there were no details when the body has none', () => {
    expect(mapProviderError(new BadRequestError(400, undefined, undefined, headers()), SECRET).message).toContain('no details given');
    expect(mapProviderError(new BadRequestError(400, { error: {} }, undefined, headers()), SECRET).message).toContain('no details given');
    expect(mapProviderError(new BadRequestError(400, { error: { message: 5 } }, undefined, headers()), SECRET).message).toContain('no details given');
  });

  it('never uses the SDK\'s own message, which carries the raw body', () => {
    const e = new BadRequestError(400, body('short'), `400 {"leak":"${SECRET}"}`, headers());
    expect(mapProviderError(e, SECRET).message).not.toContain('leak');
    expect(mapProviderError(e, SECRET).message).not.toContain('SECRET');
  });

  it('removes the key from the provider\'s explanation', () => {
    expect(mapProviderError(new AuthenticationError(401, body(`bad ${SECRET}`), 'x', headers()), SECRET).message).not.toContain('SECRET');
  });

  it('reads retry-after-ms, retry-after seconds and a date', () => {
    const wait = (h: Record<string, string>, now = 0) => mapProviderError(new RateLimitError(429, body('s'), 'x', headers(h)), SECRET, now).retryAfterMs;
    expect(wait({ 'retry-after-ms': '250' })).toBe(250);
    expect(wait({ 'retry-after-ms': '0' })).toBe(0);
    expect(wait({ 'retry-after': '2' })).toBe(2000);
    expect(wait({ 'retry-after': '1.5' })).toBe(1500);
    expect(wait({ 'retry-after': new Date(10_000).toUTCString() }, 4_000)).toBe(6000);
    expect(wait({ 'retry-after': new Date(1_000).toUTCString() }, 4_000)).toBe(0);
    expect(wait({ 'retry-after': '-5' })).toBeUndefined();
    expect(wait({ 'retry-after': 'tomorrow-ish' })).toBeUndefined();
    expect(wait({})).toBeUndefined();
  });

  it('anything that is not an SDK error is a plain MODEL_ERROR with no details', () => {
    for (const thing of [new Error('secret ' + SECRET), 'text', undefined, null, { status: 500 }]) {
      const e = mapProviderError(thing, SECRET);
      expect(e).toMatchObject({ code: 'MODEL_ERROR', retryable: false });
      expect(e.message).not.toContain('SECRET');
    }
  });
});
