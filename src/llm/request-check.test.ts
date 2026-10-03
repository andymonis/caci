import { describe, expect, it } from 'vitest';
import type { ModelRequest } from './model-client.js';
import { checkRequest } from './request-check.js';

const good = (extra: object = {}): ModelRequest => ({
  model: 'claude-haiku-4-5-20251001',
  system: 'Sort the note.',
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 300,
  timeoutMs: 30_000,
  ...extra,
});

describe('checkRequest accepts', () => {
  it('a complete request', () => {
    expect(checkRequest(good())).toBeUndefined();
  });

  it('the smallest valid request (no system prompt, one message)', () => {
    expect(checkRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 1, timeoutMs: 1 })).toBeUndefined();
  });

  it('a conversation, a schema and a real cancellation signal', () => {
    const controller = new AbortController();
    const request = good({
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
      outputSchema: { type: 'object' },
      signal: controller.signal,
    });
    expect(checkRequest(request)).toBeUndefined();
  });

  it('a request that is frozen all the way down', () => {
    const request = Object.freeze(good({ messages: Object.freeze([Object.freeze({ role: 'user', content: 'x' })]) }));
    expect(checkRequest(request)).toBeUndefined();
  });
});

describe('checkRequest refuses, as CONFIG, saying which part is wrong', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['no model', good({ model: undefined }), /request\.model/],
    ['an empty model', good({ model: '' }), /request\.model.*empty/],
    ['a model with a space', good({ model: 'a b' }), /request\.model.*spaces/],
    ['a model that is not text', good({ model: 4 }), /request\.model/],
    ['a system prompt that is not text', good({ system: 1 }), /request\.system/],
    ['no messages', good({ messages: [] }), /request\.messages.*non-empty/],
    ['messages that are not a list', good({ messages: 'hi' }), /request\.messages/],
    ['a message that is not an object', good({ messages: ['hi'] }), /request\.messages\[0\]/],
    ['a bad role', good({ messages: [{ role: 'system', content: 'x' }] }), /messages\[0\]\.role/],
    ['empty message text', good({ messages: [{ role: 'user', content: '' }] }), /messages\[0\]\.content/],
    ['message text that is not text', good({ messages: [{ role: 'user', content: 5 }] }), /messages\[0\]\.content/],
    ['the second message being bad', good({ messages: [{ role: 'user', content: 'ok' }, { role: 'user', content: '' }] }), /messages\[1\]\.content/],
    ['a schema that is a list', good({ outputSchema: [] }), /request\.outputSchema/],
    ['a schema that is null', good({ outputSchema: null }), /request\.outputSchema/],
    ['zero max tokens', good({ maxOutputTokens: 0 }), /request\.maxOutputTokens/],
    ['negative max tokens', good({ maxOutputTokens: -1 }), /request\.maxOutputTokens/],
    ['fractional max tokens', good({ maxOutputTokens: 2.5 }), /request\.maxOutputTokens/],
    ['max tokens that is NaN', good({ maxOutputTokens: Number.NaN }), /request\.maxOutputTokens/],
    ['max tokens given as text', good({ maxOutputTokens: '100' }), /request\.maxOutputTokens/],
    ['a zero time limit', good({ timeoutMs: 0 }), /request\.timeoutMs/],
    ['an infinite time limit', good({ timeoutMs: Infinity }), /request\.timeoutMs/],
    ['a time limit given as text', good({ timeoutMs: '30' }), /request\.timeoutMs/],
    ['a signal that is not one', good({ signal: {} }), /request\.signal/],
    ['a signal that is a string', good({ signal: 'abort' }), /request\.signal/],
    ['an unknown field', { ...good(), temperature: 0.2 }, /request\.temperature.*unknown field/],
    ['a request that is null', null, /request: must be an object/],
    ['a request that is undefined', undefined, /request: must be an object/],
    ['a request that is text', 'hello', /request: must be an object/],
    ['a request that is a list', [], /request: must be an object/],
  ];

  it.each(cases)('%s', (_name, input, message) => {
    const problem = checkRequest(input);
    expect(problem).toMatchObject({ code: 'CONFIG', retryable: false });
    expect(problem?.message).toMatch(message);
  });

  it('never throws on a hostile request', () => {
    const hostile = { get model(): never { throw new Error('boom'); } };
    expect(checkRequest(hostile)).toMatchObject({ code: 'CONFIG' });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    expect(checkRequest(proxy)).toMatchObject({ code: 'CONFIG' });
  });

  it('does not change what it checks', () => {
    const request = good();
    const before = JSON.stringify(request);
    checkRequest(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});
