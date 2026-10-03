import assert from 'node:assert/strict';
import type { Result } from '../../graph_store/index.js';
import { LLM_ERROR_CODES, type LlmError } from '../errors.js';
import type { ModelRequest, ModelResponse } from '../model-client.js';
import { isValidUsage } from '../usage.js';
import type { ClientScenario } from './scenarios.js';
import type { ClientCase } from './types.js';

type Reply = Result<ModelResponse, LlmError>;

const usage = { inputTokens: 12, outputTokens: 3 };
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'test-model-1',
  system: 'You sort notes into categories.',
  messages: [{ role: 'user', content: 'Saw Dr X on Tuesday' }],
  maxOutputTokens: 200,
  timeoutMs: 2000,
  ...extra,
});
const jsonRequest = (extra: Partial<ModelRequest> = {}): ModelRequest => request({ outputSchema: { type: 'object' }, ...extra });

/** Fails the test, instead of hanging the suite, when a client ignores its own time limit. */
async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what}: no answer within ${ms} ms, so the client is ignoring its time limit or cancellation` })), ms);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

function failure(reply: Reply, code: LlmError['code'], retryable: boolean): LlmError {
  assert.ok(!reply.ok, `expected a ${code} error but the call succeeded`);
  assert.equal(reply.error.code, code, `expected ${code}, got ${reply.error.code}: ${reply.error.message}`);
  assert.equal(reply.error.retryable, retryable, `${code} should ${retryable ? '' : 'not '}be retryable`);
  return reply.error;
}

function success(reply: Reply): ModelResponse {
  assert.ok(reply.ok, `expected an answer but got ${reply.ok ? '' : `${reply.error.code}: ${reply.error.message}`}`);
  return reply.value;
}

const answering = (): ClientCase[] => [
  {
    name: 'a text reply comes back as text, with its token usage and the model that answered',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'Saw Dr X on Tuesday', usage });
      const response = success(await client.complete(request()));
      assert.deepEqual(response.output, { kind: 'text', text: 'Saw Dr X on Tuesday' });
      assert.deepEqual(response.usage, usage);
      assert.equal(typeof response.model, 'string');
      assert.notEqual(response.model, '');
    },
  },
  {
    name: 'a provider that names the model it used is believed, not overwritten with the one asked for',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'ok', usage, model: 'test-model-1-snapshot-0042' });
      assert.equal(success(await client.complete(request())).model, 'test-model-1-snapshot-0042');
    },
  },
  {
    name: 'when a JSON schema is given, a JSON reply comes back parsed',
    run: async (make) => {
      const value = { ops: [{ op: 'link', item: 'a', category: 'b' }], n: 2, ok: true, nothing: null };
      const client = await make({ kind: 'json', value, usage });
      const response = success(await client.complete(jsonRequest()));
      assert.deepEqual(response.output, { kind: 'json', value });
      assert.deepEqual(response.usage, usage);
    },
  },
  {
    name: 'a text request is not treated as JSON, even when the reply happens to look like it',
    run: async (make) => {
      const client = await make({ kind: 'text', text: '{"a":1}', usage });
      assert.deepEqual(success(await client.complete(request())).output, { kind: 'text', text: '{"a":1}' });
    },
  },
  {
    name: 'every answer reports usable token counts (whole numbers, not negative)',
    run: async (make) => {
      for (const scenario of [{ kind: 'text', text: 'x', usage }, { kind: 'json', value: { a: 1 }, usage }] as ClientScenario[]) {
        const client = await make(scenario);
        const response = success(await client.complete(scenario.kind === 'json' ? jsonRequest() : request()));
        assert.ok(isValidUsage(response.usage), 'token usage must be whole, non-negative numbers');
      }
    },
  },
  {
    name: 'several calls at once each get their own answer',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'same', usage });
      const replies = await Promise.all(Array.from({ length: 10 }, () => client.complete(request())));
      for (const reply of replies) assert.deepEqual(success(reply).output, { kind: 'text', text: 'same' });
    },
  },
];

const failing = (): ClientCase[] => [
  {
    name: 'prose in reply to a request for JSON is BAD_OUTPUT, which retrying will not fix',
    run: async (make) => {
      const client = await make({ kind: 'not-json', text: 'Sure! Here are your categories: ...' });
      failure(await client.complete(jsonRequest()), 'BAD_OUTPUT', false);
    },
  },
  {
    name: 'a refusal is REFUSED, which retrying will not fix',
    run: async (make) => {
      failure(await (await make({ kind: 'refusal' })).complete(request()), 'REFUSED', false);
    },
  },
  {
    name: 'a rate limit is RATE_LIMITED and retryable, and keeps how long the provider asked to wait',
    run: async (make) => {
      const asked = failure(await (await make({ kind: 'rate-limited', retryAfterMs: 1500 })).complete(request()), 'RATE_LIMITED', true);
      assert.equal(asked.retryAfterMs, 1500);
      const unasked = failure(await (await make({ kind: 'rate-limited' })).complete(request()), 'RATE_LIMITED', true);
      assert.equal(unasked.retryAfterMs, undefined);
    },
  },
  {
    name: 'a provider server fault is a retryable MODEL_ERROR; a rejected request is a MODEL_ERROR that is not',
    run: async (make) => {
      failure(await (await make({ kind: 'server-error' })).complete(request()), 'MODEL_ERROR', true);
      failure(await (await make({ kind: 'rejected' })).complete(request()), 'MODEL_ERROR', false);
    },
  },
  {
    name: 'a model the provider does not know is a CONFIG error, which retrying will not fix',
    run: async (make) => {
      failure(await (await make({ kind: 'unknown-model' })).complete(request()), 'CONFIG', false);
    },
  },
  {
    name: 'every error is well formed: a known code, a message, and a retryable flag',
    run: async (make) => {
      const scenarios: ClientScenario[] = [
        { kind: 'not-json', text: 'prose' },
        { kind: 'refusal' },
        { kind: 'rate-limited' },
        { kind: 'server-error' },
        { kind: 'rejected' },
        { kind: 'unknown-model' },
      ];
      for (const scenario of scenarios) {
        const reply = await (await make(scenario)).complete(scenario.kind === 'not-json' ? jsonRequest() : request());
        assert.ok(!reply.ok, `${scenario.kind} should be an error`);
        assert.ok((LLM_ERROR_CODES as readonly string[]).includes(reply.error.code), `unknown code ${reply.error.code}`);
        assert.ok(typeof reply.error.message === 'string' && reply.error.message.length > 0, 'an error needs a message');
        assert.equal(typeof reply.error.retryable, 'boolean');
      }
    },
  },
];

const timeAndCancellation = (): ClientCase[] => [
  {
    name: 'a provider that never answers ends in a retryable TIMEOUT once the time limit is up',
    run: async (make) => {
      const client = await make({ kind: 'hangs' });
      const started = Date.now();
      failure(await within(5000, client.complete(request({ timeoutMs: 40 })), 'a hanging provider'), 'TIMEOUT', true);
      assert.ok(Date.now() - started < 3000, 'the timeout took far longer than the limit it was given');
    },
  },
  {
    name: 'a call already cancelled is CANCELLED straight away',
    run: async (make) => {
      const controller = new AbortController();
      controller.abort();
      for (const scenario of [{ kind: 'text', text: 'x', usage }, { kind: 'hangs' }] as ClientScenario[]) {
        const client = await make(scenario);
        failure(await within(2000, client.complete(request({ signal: controller.signal })), 'an already-cancelled call'), 'CANCELLED', false);
      }
    },
  },
  {
    name: 'cancelling a call in flight ends it as CANCELLED, not TIMEOUT, long before its time limit',
    run: async (make) => {
      const client = await make({ kind: 'hangs' });
      const controller = new AbortController();
      const started = Date.now();
      const pending = client.complete(request({ timeoutMs: 20_000, signal: controller.signal }));
      setTimeout(() => controller.abort(), 30);
      failure(await within(4000, pending, 'a cancelled call'), 'CANCELLED', false);
      assert.ok(Date.now() - started < 4000);
    },
  },
  {
    name: 'a cancellation signal that never fires does not disturb the call',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'fine', usage });
      const controller = new AbortController();
      assert.deepEqual(success(await client.complete(request({ signal: controller.signal }))).output, { kind: 'text', text: 'fine' });
    },
  },
];

const badRequests = (): ClientCase[] => [
  {
    name: 'a request that cannot be sent is a CONFIG error, never an exception',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'x', usage });
      const bad: Array<[string, unknown]> = [
        ['no model', { ...request(), model: undefined }],
        ['an empty model', request({ model: '' })],
        ['a model with spaces', request({ model: 'my model' })],
        ['no messages', request({ messages: [] })],
        ['an empty message', request({ messages: [{ role: 'user', content: '' }] })],
        ['an unknown role', request({ messages: [{ role: 'system' as never, content: 'x' }] })],
        ['a zero time limit', request({ timeoutMs: 0 })],
        ['a fractional time limit', request({ timeoutMs: 1.5 })],
        ['a time limit that is not a number', request({ timeoutMs: '5' as never })],
        ['no output limit', request({ maxOutputTokens: 0 })],
        ['a negative output limit', request({ maxOutputTokens: -5 })],
        ['a schema that is a list', request({ outputSchema: [] as never })],
        ['a system prompt that is not text', request({ system: 5 as never })],
        ['an unknown field (a misspelt setting)', { ...request(), temprature: 0.2 }],
        ['a cancellation signal that is not one', request({ signal: {} as never })],
      ];
      for (const [label, input] of bad) {
        const reply = await client.complete(input as ModelRequest);
        assert.ok(!reply.ok, `${label} should be refused`);
        assert.equal(reply.error.code, 'CONFIG', `${label}: expected CONFIG, got ${reply.error.code}`);
        assert.equal(reply.error.retryable, false);
      }
    },
  },
  {
    name: 'something that is not a request at all is also an error result, not an exception',
    run: async (make) => {
      const client = await make({ kind: 'text', text: 'x', usage });
      const hostile = { get model(): never { throw new Error('boom'); } };
      for (const input of [null, undefined, 'hello', 7, [], hostile]) {
        const reply = await client.complete(input as never);
        assert.ok(!reply.ok);
        assert.equal(reply.error.code, 'CONFIG');
      }
    },
  },
  {
    name: 'a valid request is left exactly as it was (the client does not change what it is given)',
    run: async (make) => {
      const client = await make({ kind: 'json', value: { a: 'x' }, usage });
      const given = request({ outputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
      const frozen = JSON.stringify(given);
      Object.freeze(given);
      Object.freeze(given.messages);
      success(await client.complete(given));
      assert.equal(JSON.stringify(given), frozen);
    },
  },
];

/** Everything a model client must do: answer, fail in the agreed ways, honour time and cancellation, refuse bad requests. */
export function modelClientCases(): ClientCase[] {
  return [...answering(), ...failing(), ...timeAndCancellation(), ...badRequests()];
}
