import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '../model-client.js';
import { createAnthropicClient, readAnthropicKey, type AnthropicClientOptions } from './client.js';
import { errorBody, fakeProvider, jsonResponse, messageBody } from './fake-provider.test-util.js';

const KEY = 'sk-ant-api03-SECRET-KEY-VALUE-1234567890';
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-haiku-4-5-20251001',
  system: 'You sort notes.',
  messages: [{ role: 'user', content: 'Saw Dr X' }],
  maxOutputTokens: 300,
  timeoutMs: 2000,
  ...extra,
});
const make = (provider: ReturnType<typeof fakeProvider>, extra: Partial<AnthropicClientOptions> = {}) => createAnthropicClient({ apiKey: KEY, fetch: provider.fetch, ...extra });
const ok200 = (text = 'hello', input = 10, output = 5) => fakeProvider((r) => jsonResponse(200, messageBody(String(r.body.model), text, { input, output })));

describe('the request sent to the provider', () => {
  it('goes to the Messages endpoint with the key and version headers, and nothing else secret-bearing', async () => {
    const p = ok200();
    await make(p).complete(request());
    const sent = p.seen[0];
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent?.method).toBe('POST');
    expect(sent?.headers['x-api-key']).toBe(KEY);
    expect(sent?.headers['anthropic-version']).toBeDefined();
    expect(sent?.headers.authorization).toBeUndefined();
  });

  it('carries the model, token limit, system prompt and messages exactly as asked', async () => {
    const p = ok200();
    await make(p).complete(request({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }));
    expect(p.seen[0]?.body).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You sort notes.',
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    });
  });

  it('names the model on every request: there is no default', async () => {
    const p = ok200();
    const client = make(p);
    await client.complete(request({ model: 'model-one' }));
    await client.complete(request({ model: 'model-two' }));
    expect(p.seen.map((s) => s.body.model)).toEqual(['model-one', 'model-two']);
  });

  it('leaves out the system prompt when there is none', async () => {
    const p = ok200();
    const noSystem: ModelRequest = { model: 'm1', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10, timeoutMs: 1000 };
    await make(p).complete(noSystem);
    expect(p.seen[0]?.body).not.toHaveProperty('system');
  });

  it('asks for structured output only when the request has a schema, narrowed to what the provider accepts', async () => {
    const p = ok200('{"ok":true}');
    const client = make(p);
    await client.complete(request());
    expect(p.seen[0]?.body).not.toHaveProperty('output_config');
    await client.complete(request({ outputSchema: { type: 'object', properties: { ops: { type: 'array', maxItems: 3, items: { type: 'string' } } }, required: ['ops'] } }));
    expect(p.seen[1]?.body.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { ops: { type: 'array', items: { type: 'string' }, description: '{maxItems: 3}' } },
          additionalProperties: false,
          required: ['ops'],
        },
      },
    });
  });

  it('uses a different base URL when given', async () => {
    const p = ok200();
    await make(p, { baseURL: 'http://localhost:9999' }).complete(request());
    expect(p.seen[0]?.url).toBe('http://localhost:9999/v1/messages');
  });

  it('a schema that cannot be expressed is a CONFIG error and nothing is sent', async () => {
    const p = ok200();
    const r = await make(p).complete(request({ outputSchema: { properties: {} } }));
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(p.seen).toHaveLength(0);
  });

  it('an invalid request is a CONFIG error and nothing is sent', async () => {
    const p = ok200();
    const client = make(p);
    for (const bad of [{ ...request(), model: '' }, { ...request(), maxOutputTokens: 0 }, { ...request(), messages: [] }, { ...request(), temperature: 1 }, null]) {
      expect(await client.complete(bad as never)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    }
    expect(p.seen).toHaveLength(0);
  });

  it('does not retry on its own by default; a rate limit is one call', async () => {
    const p = fakeProvider(() => jsonResponse(429, errorBody('rate_limit_error', 'slow')));
    await make(p).complete(request());
    expect(p.seen).toHaveLength(1);
  });

  it('retries as many times as it is told to', async () => {
    const p = fakeProvider((_r, n) => (n === 1 ? jsonResponse(429, errorBody('rate_limit_error', 'slow'), { 'retry-after-ms': '1' }) : jsonResponse(200, messageBody('m', 'fine', { input: 1, output: 1 }))));
    const r = await make(p, { maxRetries: 1 }).complete(request());
    expect(r.ok).toBe(true);
    expect(p.seen).toHaveLength(2);
  });
});

describe('the answer', () => {
  it('reports text, the answering model and tokens (cache tokens count as input)', async () => {
    const p = fakeProvider(() =>
      jsonResponse(200, { ...messageBody('claude-served-1', 'Hi', { input: 10, output: 4 }), usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } }),
    );
    expect(await make(p).complete(request())).toEqual({ ok: true, value: { model: 'claude-served-1', output: { kind: 'text', text: 'Hi' }, usage: { inputTokens: 22, outputTokens: 4 } } });
  });

  it('joins several text blocks and ignores blocks that are not text', async () => {
    const p = fakeProvider(() =>
      jsonResponse(200, { ...messageBody('m', '', { input: 1, output: 1 }), content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'tool_use', id: 't', name: 'x', input: {}, text: 'NOT-TEXT' }, { type: 'text', text: 'b' }] }),
    );
    const r = await make(p).complete(request());
    expect(r.ok && r.value.output).toEqual({ kind: 'text', text: 'ab' });
  });

  it('an empty reply is empty text', async () => {
    const r = await make(ok200('')).complete(request());
    expect(r.ok && r.value.output).toEqual({ kind: 'text', text: '' });
  });

  it('parses JSON when a schema was asked for, including nested and non-object values', async () => {
    for (const [text, value] of [['{"a":[1,{"b":null}]}', { a: [1, { b: null }] }], ['[1,2]', [1, 2]], ['"s"', 's']] as const) {
      const r = await make(ok200(text)).complete(request({ outputSchema: { type: 'object' } }));
      expect(r.ok && r.value.output).toEqual({ kind: 'json', value });
    }
  });

  it('prose when JSON was asked for is a BAD_OUTPUT that is not retryable', async () => {
    const r = await make(ok200('Sure, here you go')).complete(request({ outputSchema: { type: 'object' } }));
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT', retryable: false } });
  });

  it('a reply cut off at the token limit says so', async () => {
    const p = fakeProvider(() => jsonResponse(200, { ...messageBody('m', '{"ops":[{"op":', { input: 1, output: 300 }), stop_reason: 'max_tokens' }));
    const r = await make(p).complete(request({ outputSchema: { type: 'object' } }));
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_OUTPUT' } });
    expect(!r.ok && r.error.message).toContain('cut off at the limit of 300 output tokens');
  });

  it('text cut off at the limit is still returned when no JSON was asked for', async () => {
    const p = fakeProvider(() => jsonResponse(200, { ...messageBody('m', 'partial', { input: 1, output: 300 }), stop_reason: 'max_tokens' }));
    const r = await make(p).complete(request());
    expect(r.ok && r.value.output).toEqual({ kind: 'text', text: 'partial' });
  });

  it('a refusal names its category and carries no content', async () => {
    const p = fakeProvider(() => jsonResponse(200, { ...messageBody('m', '', { input: 1, output: 0 }), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } }));
    const r = await make(p).complete(request());
    expect(r).toMatchObject({ ok: false, error: { code: 'REFUSED', retryable: false } });
    expect(!r.ok && r.error.message).toContain('(cyber)');
  });

  it('a refusal with no category is still a refusal', async () => {
    const p = fakeProvider(() => jsonResponse(200, { ...messageBody('m', '', { input: 1, output: 0 }), stop_reason: 'refusal', stop_details: null }));
    expect(await make(p).complete(request())).toMatchObject({ ok: false, error: { code: 'REFUSED', message: 'the model declined to answer' } });
  });
});

describe('failures from the provider', () => {
  const failing = (status: number, type: string, message = 'details here', headers: Record<string, string> = {}) =>
    make(fakeProvider(() => jsonResponse(status, errorBody(type, message), headers)));

  it.each([
    [401, 'authentication_error', 'CONFIG', false],
    [403, 'permission_error', 'CONFIG', false],
    [404, 'not_found_error', 'CONFIG', false],
    [400, 'invalid_request_error', 'MODEL_ERROR', false],
    [413, 'request_too_large', 'MODEL_ERROR', false],
    [422, 'invalid_request_error', 'MODEL_ERROR', false],
    [500, 'api_error', 'MODEL_ERROR', true],
    [502, 'api_error', 'MODEL_ERROR', true],
    [529, 'overloaded_error', 'MODEL_ERROR', true],
    [429, 'rate_limit_error', 'RATE_LIMITED', true],
  ])('HTTP %i is %s -> %s (retryable %s)', async (status, type, code, retryable) => {
    const r = await failing(status, type).complete(request());
    expect(r).toMatchObject({ ok: false, error: { code, retryable } });
  });

  it('includes the provider\'s short explanation but not the raw response body', async () => {
    const r = await failing(400, 'invalid_request_error', 'messages.0: roles must alternate').complete(request());
    expect(!r.ok && r.error.message).toContain('messages.0: roles must alternate');
    expect(!r.ok && r.error.message).not.toContain('{"type"');
  });

  it('copes with an error body that is not JSON, or empty', async () => {
    for (const body of ['<html>bad gateway</html>', '']) {
      const client = make(fakeProvider(() => new Response(body, { status: 502 })));
      expect(await client.complete(request())).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR', retryable: true } });
    }
  });

  it('a network failure is a retryable MODEL_ERROR', async () => {
    const client = make(fakeProvider(() => { throw new TypeError('fetch failed'); }));
    expect(await client.complete(request())).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR', retryable: true } });
  });

  describe('how long a rate limit asks to wait', () => {
    it('reads milliseconds', async () => {
      const r = await failing(429, 'rate_limit_error', 'x', { 'retry-after-ms': '1500' }).complete(request());
      expect(!r.ok && r.error.retryAfterMs).toBe(1500);
    });
    it('reads seconds', async () => {
      const r = await failing(429, 'rate_limit_error', 'x', { 'retry-after': '3' }).complete(request());
      expect(!r.ok && r.error.retryAfterMs).toBe(3000);
    });
    it('reads a date', async () => {
      const when = new Date(Date.now() + 60_000).toUTCString();
      const r = await failing(429, 'rate_limit_error', 'x', { 'retry-after': when }).complete(request());
      expect(!r.ok && r.error.retryAfterMs).toBeGreaterThan(50_000);
      expect(!r.ok && r.error.retryAfterMs).toBeLessThanOrEqual(60_000);
    });
    it('prefers milliseconds when both are given', async () => {
      const r = await failing(429, 'rate_limit_error', 'x', { 'retry-after-ms': '250', 'retry-after': '9' }).complete(request());
      expect(!r.ok && r.error.retryAfterMs).toBe(250);
    });
    it.each(['soon', '-5', ''])('leaves it out when the header is %j', async (value) => {
      const r = await failing(429, 'rate_limit_error', 'x', { 'retry-after': value }).complete(request());
      expect(r).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
      expect(!r.ok && r.error).not.toHaveProperty('retryAfterMs');
    });
    it('leaves it out when there is no header', async () => {
      const r = await failing(429, 'rate_limit_error').complete(request());
      expect(!r.ok && r.error).not.toHaveProperty('retryAfterMs');
    });
  });
});

describe('time limit and cancellation', () => {
  const hanging = () => fakeProvider((_r, _n, signal) => new Promise<Response>((_res, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true })));

  it('times out as a retryable TIMEOUT', async () => {
    expect(await make(hanging()).complete(request({ timeoutMs: 30 }))).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
  });

  it('cancels the HTTP request when the time runs out', async () => {
    let aborted = false;
    const p = fakeProvider((_r, _n, signal) => new Promise<Response>((_res, rej) => signal?.addEventListener('abort', () => ((aborted = true), rej(new DOMException('aborted', 'AbortError'))), { once: true })));
    await make(p).complete(request({ timeoutMs: 30 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  it('a signal that is already cancelled sends nothing', async () => {
    const c = new AbortController();
    c.abort();
    const p = ok200();
    expect(await make(p).complete(request({ signal: c.signal }))).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(p.seen).toHaveLength(0);
  });

  it('cancelling during the call ends it as CANCELLED', async () => {
    const c = new AbortController();
    const pending = make(hanging()).complete(request({ signal: c.signal, timeoutMs: 5000 }));
    setTimeout(() => c.abort(), 20);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED', retryable: false } });
  });
});

describe('the key', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  const savedBase = process.env.ANTHROPIC_BASE_URL;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  afterEach(() => {
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
  });

  it('is never in an error, even when the provider echoes it back', async () => {
    const echo = fakeProvider(() => jsonResponse(401, errorBody('authentication_error', `invalid x-api-key: ${KEY} (also sk-ant-other-secret-9999)`)));
    const r = await make(echo).complete(request());
    expect(JSON.stringify(r)).not.toContain('SECRET-KEY-VALUE');
    expect(JSON.stringify(r)).not.toContain('other-secret');
    expect(!r.ok && r.error.message).toContain('[redacted]');
  });

  it('is never in an error for any failure status', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 529]) {
      const r = await make(fakeProvider(() => jsonResponse(status, errorBody('x', `leaked ${KEY}`)))).complete(request());
      expect(JSON.stringify(r)).not.toContain('SECRET-KEY-VALUE');
    }
  });

  it('is removed from errors whatever shape it has', async () => {
    const custom = 'gateway-key-ABC123XYZ';
    const client = createAnthropicClient({ apiKey: custom, fetch: fakeProvider(() => jsonResponse(401, errorBody('authentication_error', `rejected ${custom}`))).fetch });
    const r = await client.complete(request());
    expect(JSON.stringify(r)).not.toContain('ABC123XYZ');
    expect(!r.ok && r.error.message).toContain('[redacted]');
  });

  it('is not on the client object, and not in its JSON or string forms', () => {
    const client = make(ok200());
    expect(JSON.stringify(client)).not.toContain('SECRET');
    expect(String(client)).not.toContain('SECRET');
    expect(Object.keys(client)).toEqual(['complete']);
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('is never written to the console', async () => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, debug: console.debug, info: console.info };
    for (const name of Object.keys(originals) as Array<keyof typeof originals>) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      await make(fakeProvider(() => jsonResponse(500, errorBody('api_error', 'boom')))).complete(request());
      await make(ok200()).complete(request());
    } finally {
      Object.assign(console, originals);
    }
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('a bad key is a TypeError that does not show it', () => {
    for (const bad of ['', 'short', 'has space in the middle of it', 'new\nline-in-key-1234', 'x'.repeat(600), 5, undefined]) {
      let message = '';
      try {
        createAnthropicClient({ apiKey: bad as never });
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      if (typeof bad === 'string' && bad.length > 3) expect(message).not.toContain(bad);
    }
  });

  it('is the one passed in: the environment is never consulted', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-FROM-THE-ENVIRONMENT-0000';
    process.env.ANTHROPIC_BASE_URL = 'http://environment.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-the-environment';
    const p = ok200();
    await make(p).complete(request());
    expect(p.seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(p.seen[0]?.headers.authorization).toBeUndefined();
    expect(p.seen[0]?.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('readAnthropicKey', () => {
  it('reads the key from the environment object it is given', () => {
    expect(readAnthropicKey({ ANTHROPIC_API_KEY: KEY })).toEqual({ ok: true, value: KEY });
  });
  it('trims whitespace around it', () => {
    expect(readAnthropicKey({ ANTHROPIC_API_KEY: `  ${KEY}\n` })).toEqual({ ok: true, value: KEY });
  });
  it.each([[undefined], [''], ['   ']])('%j is "not set"', (value) => {
    expect(readAnthropicKey({ ANTHROPIC_API_KEY: value })).toMatchObject({ ok: false, error: { code: 'CONFIG', message: 'ANTHROPIC_API_KEY is not set' } });
    expect(readAnthropicKey({})).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  });
  it.each([['short'], ['has space inside it, no'], ['x'.repeat(600)], ['control\u0007char-in-key']])('%j is refused without being shown', (value) => {
    const r = readAnthropicKey({ ANTHROPIC_API_KEY: value });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(JSON.stringify(r)).not.toContain(value);
  });
  it('does not read process.env itself', () => {
    process.env.ANTHROPIC_API_KEY = KEY;
    expect(readAnthropicKey({})).toMatchObject({ ok: false });
    delete process.env.ANTHROPIC_API_KEY;
  });
});
