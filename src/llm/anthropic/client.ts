import Anthropic from '@anthropic-ai/sdk';
import { err, ok, type JsonValue, type Result } from '../../graph_store/index.js';
import { runWithDeadline } from '../deadline.js';
import { llmError, type LlmError } from '../errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../model-client.js';
import { checkRequest } from '../request-check.js';
import { mapProviderError, redact } from './errors.js';
import { toProviderSchema } from './schema.js';

export interface AnthropicClientOptions {
  /** The API key. The caller supplies it (see `readAnthropicKey`); this component never reads the environment. */
  readonly apiKey: string;
  /** Default `https://api.anthropic.com`. */
  readonly baseURL?: string;
  /** The HTTP layer. Tests replace it with a fake provider. */
  readonly fetch?: typeof fetch;
  /** Retries the SDK makes on its own after a rate limit or server fault. Default 0: callers see every failure and decide. */
  readonly maxRetries?: number;
}

export const ANTHROPIC_KEY_VARIABLE = 'ANTHROPIC_API_KEY';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

/** Reads the key from an environment object the caller passes in (for example the process environment). The key is never echoed in an error. */
export function readAnthropicKey(env: Readonly<Record<string, string | undefined>>): Result<string, LlmError> {
  const value = env[ANTHROPIC_KEY_VARIABLE];
  if (value === undefined || value.trim() === '') return err(llmError('CONFIG', `${ANTHROPIC_KEY_VARIABLE} is not set`));
  const key = value.trim();
  return KEY_SHAPE.test(key) ? ok(key) : err(llmError('CONFIG', `${ANTHROPIC_KEY_VARIABLE} does not look like an API key (printable characters, 8 to 512 of them, no spaces)`));
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
}

/**
 * A `ModelClient` for the Anthropic Messages API. Every request names its model; there is no
 * default. A request asking for JSON uses the provider's structured output with the schema
 * narrowed to what it accepts, and the reply is parsed (prose is `BAD_OUTPUT`). The key is held in
 * a closure and never appears on the object, in logs or in errors. A bad key shape is a coding
 * mistake and throws a `TypeError` that does not show the key.
 */
export function createAnthropicClient(options: AnthropicClientOptions): ModelClient {
  const { apiKey } = options;
  if (typeof apiKey !== 'string' || !KEY_SHAPE.test(apiKey)) throw new TypeError('createAnthropicClient: apiKey must be the API key as text (printable characters, 8 to 512 of them, no spaces)');
  const sdk = new Anthropic({
    apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    maxRetries: options.maxRetries ?? 0,
    logLevel: 'off',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  async function ask(request: ModelRequest, signal: AbortSignal, schema: Record<string, unknown> | undefined): Promise<Result<ModelResponse, LlmError>> {
    try {
      const message = await sdk.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(request.system === undefined ? {} : { system: request.system }),
          ...(schema === undefined ? {} : { output_config: { format: { type: 'json_schema' as const, schema } } }),
        },
        { signal },
      );
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        return err(llmError('REFUSED', `the model declined to answer${category == null ? '' : ` (${category})`}`));
      }
      const usage = {
        inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };
      const text = textOf(message.content as Array<{ type: string; text?: string }>);
      if (schema === undefined) return ok({ model: message.model, output: { kind: 'text', text }, usage });
      if (message.stop_reason === 'max_tokens') {
        return err(llmError('BAD_OUTPUT', `the reply was cut off at the limit of ${request.maxOutputTokens} output tokens, so the JSON is incomplete`));
      }
      try {
        return ok({ model: message.model, output: { kind: 'json', value: JSON.parse(text) as JsonValue }, usage });
      } catch {
        return err(llmError('BAD_OUTPUT', 'the reply was asked to be JSON but is not'));
      }
    } catch (error) {
      return err(mapProviderError(error, apiKey));
    }
  }

  return Object.freeze({
    async complete(request: ModelRequest): Promise<Result<ModelResponse, LlmError>> {
      try {
        const problem = checkRequest(request);
        if (problem !== undefined) return err(problem);
        let schema: Record<string, unknown> | undefined;
        if (request.outputSchema !== undefined) {
          const converted = toProviderSchema(request.outputSchema);
          if (!converted.ok) return converted;
          schema = converted.value;
        }
        return await runWithDeadline((signal) => ask(request, signal, schema), { timeoutMs: request.timeoutMs, signal: request.signal });
      } catch (error) {
        return err(llmError('MODEL_ERROR', redact(`the call failed unexpectedly: ${error instanceof Error ? error.constructor.name : 'unknown'}`, apiKey)));
      }
    },
  });
}
