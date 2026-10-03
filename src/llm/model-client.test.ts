import { describe, expect, expectTypeOf, it } from 'vitest';
import { err, ok, type JsonObject } from '../graph_store/index.js';
import { llmError, NO_USAGE, type ModelClient, type ModelRequest, type ModelResponse } from './index.js';

const request: ModelRequest = {
  model: 'claude-haiku-4-5-20251001',
  system: 'Categorise the note.',
  messages: [{ role: 'user', content: 'Saw Dr X on Tuesday' }],
  maxOutputTokens: 500,
  timeoutMs: 30_000,
};

/** The smallest possible client: proves the port can be implemented and used with nothing else. */
const echo: ModelClient = {
  complete: async (r) =>
    r.model === ''
      ? err(llmError('CONFIG', 'a model is required'))
      : ok({ model: r.model, output: { kind: 'text', text: 'hello' }, usage: NO_USAGE }),
};

describe('the ModelClient port', () => {
  it('can be implemented by a plain object', async () => {
    expect(await echo.complete(request)).toEqual({ ok: true, value: { model: 'claude-haiku-4-5-20251001', output: { kind: 'text', text: 'hello' }, usage: { inputTokens: 0, outputTokens: 0 } } });
  });

  it('reports failures as results, with the LLM error type', async () => {
    const r = await echo.complete({ ...request, model: '' });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  });

  it('every request must name its model, so no client can hide a default', () => {
    // @ts-expect-error a request without a model is a type error
    const missing: ModelRequest = { messages: [], maxOutputTokens: 1, timeoutMs: 1 };
    expect(missing).toBeDefined();
    expectTypeOf<ModelRequest['model']>().toEqualTypeOf<string>();
  });

  it('every request must say how long it may take and how much it may write', () => {
    // @ts-expect-error timeoutMs is required
    const noTimeout: ModelRequest = { model: 'm', messages: [], maxOutputTokens: 1 };
    // @ts-expect-error maxOutputTokens is required
    const noLimit: ModelRequest = { model: 'm', messages: [], timeoutMs: 1 };
    expect([noTimeout, noLimit]).toHaveLength(2);
  });

  it('a response tells text from parsed JSON by its kind', () => {
    const describe = (r: ModelResponse): string => (r.output.kind === 'text' ? `text:${r.output.text}` : `json:${JSON.stringify(r.output.value)}`);
    expect(describe({ model: 'm', output: { kind: 'text', text: 'hi' }, usage: NO_USAGE })).toBe('text:hi');
    expect(describe({ model: 'm', output: { kind: 'json', value: { a: 1 } }, usage: NO_USAGE })).toBe('json:{"a":1}');
  });

  it('accepts an output schema and a cancellation signal', () => {
    const controller = new AbortController();
    const full: ModelRequest = { ...request, outputSchema: { type: 'object', properties: { ops: { type: 'array' } } }, signal: controller.signal };
    expectTypeOf(full.outputSchema).toEqualTypeOf<JsonObject | undefined>();
    expect(full.signal).toBe(controller.signal);
  });
});
