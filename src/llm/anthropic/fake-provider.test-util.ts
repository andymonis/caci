import type { ClientScenario } from '../testing/index.js';

/** One request the fake provider received. */
export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeProvider {
  readonly fetch: typeof fetch;
  readonly seen: SeenRequest[];
}

export const MESSAGE_USAGE = { cache_creation_input_tokens: null, cache_read_input_tokens: null };

/** A reply shaped like the Messages API's. */
export function messageBody(model: string, text: string, usage: { input: number; output: number }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: text === '' ? [] : [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output, ...MESSAGE_USAGE },
    ...extra,
  };
}

export function errorBody(type: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } };
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake provider that answers every request with `answer(request, callNumber)`. A thrown error becomes a network failure. */
export function fakeProvider(answer: (request: SeenRequest, callNumber: number, signal: AbortSignal | undefined) => Response | Promise<Response>): FakeProvider {
  const seen: SeenRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: SeenRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    seen.push(request);
    return answer(request, seen.length, init?.signal ?? undefined);
  };
  return { fetch: fetchFn, seen };
}

/** A provider that behaves as one of the contract suite's scenarios. */
export function providerFor(scenario: ClientScenario): FakeProvider {
  return fakeProvider((request, _n, signal) => {
    const model = String(request.body.model);
    switch (scenario.kind) {
      case 'text':
        return jsonResponse(200, messageBody(scenario.model ?? model, scenario.text, { input: scenario.usage.inputTokens, output: scenario.usage.outputTokens }));
      case 'json':
        return jsonResponse(200, messageBody(model, JSON.stringify(scenario.value), { input: scenario.usage.inputTokens, output: scenario.usage.outputTokens }));
      case 'not-json':
        return jsonResponse(200, messageBody(model, scenario.text, { input: 5, output: 5 }));
      case 'refusal':
        return jsonResponse(200, messageBody(model, '', { input: 5, output: 0 }, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }));
      case 'rate-limited':
        return jsonResponse(429, errorBody('rate_limit_error', 'slow down'), scenario.retryAfterMs === undefined ? {} : { 'retry-after-ms': String(scenario.retryAfterMs) });
      case 'server-error':
        return jsonResponse(500, errorBody('api_error', 'internal error'));
      case 'rejected':
        return jsonResponse(400, errorBody('invalid_request_error', 'messages: bad'));
      case 'unknown-model':
        return jsonResponse(404, errorBody('not_found_error', `model: ${model}`));
      case 'hangs':
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        });
    }
  });
}
