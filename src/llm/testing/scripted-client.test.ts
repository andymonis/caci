import { describe, expect, it } from 'vitest';
import { llmError, type ModelRequest } from '../index.js';
import { createScriptedModelClient, type ScriptStep } from './scripted-client.js';

const req = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 100,
  timeoutMs: 1000,
  ...extra,
});
const text = (reply: string): ScriptStep => ({ reply });

describe('the script', () => {
  it('plays its steps in order, one per call', async () => {
    const client = createScriptedModelClient([text('first'), text('second')]);
    expect(await client.complete(req())).toMatchObject({ ok: true, value: { output: { text: 'first' } } });
    expect(await client.complete(req())).toMatchObject({ ok: true, value: { output: { text: 'second' } } });
  });

  it('can be a function that sees the request and the call number (from 1)', async () => {
    const client = createScriptedModelClient((request, n) => text(`${request.model}#${n}`));
    expect(await client.complete(req({ model: 'a' }))).toMatchObject({ value: { output: { text: 'a#1' } } });
    expect(await client.complete(req({ model: 'b' }))).toMatchObject({ value: { output: { text: 'b#2' } } });
  });

  it('runs out politely: an error result, never an exception', async () => {
    const client = createScriptedModelClient([text('only')]);
    await client.complete(req());
    expect(await client.complete(req())).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR', retryable: false, message: expect.stringContaining('call 2') } });
  });

  it('can wait before answering', async () => {
    const client = createScriptedModelClient([{ delayMs: 30, then: text('late') }]);
    const started = Date.now();
    expect(await client.complete(req())).toMatchObject({ ok: true, value: { output: { text: 'late' } } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('a delay longer than the time limit ends in TIMEOUT', async () => {
    const client = createScriptedModelClient([{ delayMs: 5000, then: text('too late') }]);
    expect(await client.complete(req({ timeoutMs: 30 }))).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('can fail with any error it is given', async () => {
    const error = llmError('RATE_LIMITED', 'slow', { retryAfterMs: 9 });
    expect(await createScriptedModelClient([{ error }]).complete(req())).toEqual({ ok: false, error });
  });
});

describe('replies', () => {
  it('reports the model asked for unless the provider names another, and default usage unless given', async () => {
    const client = createScriptedModelClient([text('a'), { reply: 'b', model: 'snapshot-7', usage: { inputTokens: 1, outputTokens: 2 } }]);
    expect(await client.complete(req())).toMatchObject({ value: { model: 'test-model', usage: { inputTokens: 10, outputTokens: 5 } } });
    expect(await client.complete(req())).toMatchObject({ value: { model: 'snapshot-7', usage: { inputTokens: 1, outputTokens: 2 } } });
  });

  it('uses the default usage it was configured with', async () => {
    const client = createScriptedModelClient([text('a')], { usage: { inputTokens: 100, outputTokens: 50 } });
    expect(await client.complete(req())).toMatchObject({ value: { usage: { inputTokens: 100, outputTokens: 50 } } });
  });

  it('refuses to report token usage that is not valid', async () => {
    const client = createScriptedModelClient([{ reply: 'x', usage: { inputTokens: -1, outputTokens: 0 } }]);
    expect(await client.complete(req())).toMatchObject({ ok: false, error: { code: 'MODEL_ERROR' } });
  });

  it('returns text as text when no schema was asked for', async () => {
    expect(await createScriptedModelClient([text('{"a":1}')]).complete(req())).toMatchObject({ value: { output: { kind: 'text', text: '{"a":1}' } } });
  });

  it.each([
    ['an object', '{"a":[1,2,{"b":null}]}', { a: [1, 2, { b: null }] }],
    ['a list', '[1,"two",true]', [1, 'two', true]],
    ['a number', '42', 42],
    ['null', 'null', null],
  ])('parses %s when a schema was asked for', async (_name, reply, value) => {
    expect(await createScriptedModelClient([text(reply)]).complete(req({ outputSchema: { type: 'object' } }))).toMatchObject({ ok: true, value: { output: { kind: 'json', value } } });
  });

  it.each([['prose', 'Here you go: {"a":1}'], ['broken JSON', '{"a":'], ['empty text', '']])('is BAD_OUTPUT for %s when a schema was asked for', async (_name, reply) => {
    expect(await createScriptedModelClient([text(reply)]).complete(req({ outputSchema: { type: 'object' } }))).toMatchObject({
      ok: false,
      error: { code: 'BAD_OUTPUT', retryable: false },
    });
  });

  it.each([
    ['a refusal', { refusal: true } as ScriptStep, 'REFUSED', false],
    ['a rate limit', { rateLimited: true, retryAfterMs: 800 } as ScriptStep, 'RATE_LIMITED', true],
    ['a server fault', { serverError: true } as ScriptStep, 'MODEL_ERROR', true],
    ['a rejected request', { rejected: true } as ScriptStep, 'MODEL_ERROR', false],
    ['an unknown model', { unknownModel: true } as ScriptStep, 'CONFIG', false],
  ])('acts out %s', async (_name, step, code, retryable) => {
    expect(await createScriptedModelClient([step]).complete(req())).toMatchObject({ ok: false, error: { code, retryable } });
  });

  it('says which model was unknown', async () => {
    const r = await createScriptedModelClient([{ unknownModel: true }]).complete(req({ model: 'no-such-model' }));
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('no-such-model') } });
  });
});

describe('the record of what was asked', () => {
  it('keeps every request, in order, and counts only calls that reached the provider', async () => {
    const client = createScriptedModelClient([text('a'), text('b')]);
    await client.complete(req({ model: 'one' }));
    await client.complete(req({ model: '' })); // invalid: refused before the provider
    await client.complete(req({ model: 'two' }));
    expect(client.requests.map((r) => r.model)).toEqual(['one', '', 'two']);
    expect(client.callCount).toBe(2);
  });

  it('keeps frozen copies, unaffected by later changes to the original', async () => {
    const client = createScriptedModelClient([text('a')]);
    const original = req({ system: 'before' });
    await client.complete(original);
    (original as { system: string }).system = 'after';
    expect(client.requests[0]?.system).toBe('before');
    expect(Object.isFrozen(client.requests[0])).toBe(true);
  });

  it('hands out a copy of the list, so editing it changes nothing', async () => {
    const client = createScriptedModelClient([text('a')]);
    await client.complete(req());
    (client.requests as ModelRequest[]).push(req());
    expect(client.requests).toHaveLength(1);
  });

  it('survives requests that cannot be recorded or that are not requests', async () => {
    const client = createScriptedModelClient([text('a')]);
    const hostile = { get model(): never { throw new Error('boom'); } };
    for (const input of [null, undefined, 'x', 3, [], hostile]) {
      expect(await client.complete(input as never)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    }
    expect(client.callCount).toBe(0);
  });

  it('counts concurrent calls correctly', async () => {
    const client = createScriptedModelClient(() => text('x'));
    await Promise.all(Array.from({ length: 20 }, () => client.complete(req())));
    expect(client.callCount).toBe(20);
    expect(client.requests).toHaveLength(20);
  });
});
