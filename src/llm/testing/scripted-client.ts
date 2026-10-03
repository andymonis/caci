import { err, ok, type Result } from '../../graph_store/index.js';
import { runWithDeadline } from '../deadline.js';
import { llmError, type LlmError } from '../errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../model-client.js';
import { checkRequest } from '../request-check.js';
import { isValidUsage, type TokenUsage } from '../usage.js';

/** What a scripted provider does for one call. These mirror what real providers do. */
export type ScriptStep =
  /** The provider answers with this text. If the request asked for JSON, the client parses it. */
  | { readonly reply: string; readonly usage?: TokenUsage; readonly model?: string }
  | { readonly refusal: true }
  | { readonly rateLimited: true; readonly retryAfterMs?: number }
  /** A provider fault worth retrying (a 5xx). */
  | { readonly serverError: true }
  /** The provider rejected the request itself (a 4xx that retrying will not fix). */
  | { readonly rejected: true }
  /** The provider does not know the model that was asked for. */
  | { readonly unknownModel: true }
  /** The provider never answers, so only the time limit or a cancellation ends the call. */
  | { readonly hang: true }
  | { readonly error: LlmError }
  /** Wait, then do `then`. */
  | { readonly delayMs: number; readonly then: ScriptStep };

/** Steps used in order, or a function that chooses the step for each call (calls count from 1). */
export type Script = readonly ScriptStep[] | ((request: ModelRequest, callNumber: number) => ScriptStep);

/** A `ModelClient` for tests, plus a record of what it was asked. */
export interface ScriptedModelClient extends ModelClient {
  /** Every request received, in order (including ones refused as invalid), as frozen copies. */
  readonly requests: readonly ModelRequest[];
  /** How many requests reached the scripted provider (invalid ones do not). */
  readonly callCount: number;
}

export interface ScriptedOptions {
  /** Usage reported for a reply that does not give its own. */
  readonly usage?: TokenUsage;
}

const DEFAULT_USAGE: TokenUsage = Object.freeze({ inputTokens: 10, outputTokens: 5 });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolves after `ms`, or rejects as soon as the signal fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });
}

async function perform(step: ScriptStep, request: ModelRequest, signal: AbortSignal, usageDefault: TokenUsage): Promise<Result<ModelResponse, LlmError>> {
  if ('delayMs' in step) {
    await pause(step.delayMs, signal);
    return perform(step.then, request, signal, usageDefault);
  }
  if ('hang' in step) {
    return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }
  if ('error' in step) return err(step.error);
  if ('refusal' in step) return err(llmError('REFUSED', 'the model declined to answer'));
  if ('rateLimited' in step) {
    return err(llmError('RATE_LIMITED', 'the provider asked for fewer requests', step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }));
  }
  if ('serverError' in step) return err(llmError('MODEL_ERROR', 'the provider had a server error', { retryable: true }));
  if ('rejected' in step) return err(llmError('MODEL_ERROR', 'the provider rejected the request'));
  if ('unknownModel' in step) return err(llmError('CONFIG', `the provider does not know the model "${request.model}"`));

  const usage = step.usage ?? usageDefault;
  if (!isValidUsage(usage)) return err(llmError('MODEL_ERROR', 'the provider reported token usage that is not valid'));
  const model = step.model ?? request.model;
  if (request.outputSchema === undefined) return ok({ model, output: { kind: 'text', text: step.reply }, usage });
  try {
    return ok({ model, output: { kind: 'json', value: JSON.parse(step.reply) as never }, usage });
  } catch {
    return err(llmError('BAD_OUTPUT', 'the model was asked for JSON but did not return JSON'));
  }
}

/**
 * A model client that plays back a script instead of calling a model. It behaves like a careful
 * real client: it checks the request first, honours the time limit and cancellation, parses JSON
 * when the request asks for it, and never throws. Use it to test everything built on a
 * `ModelClient` without a network or a key.
 */
export function createScriptedModelClient(script: Script, options: ScriptedOptions = {}): ScriptedModelClient {
  const seen: ModelRequest[] = [];
  let calls = 0;
  const usageDefault = options.usage ?? DEFAULT_USAGE;

  /** Keeps a frozen copy of what was asked. A request that cannot even be copied (a hostile getter) is left out, and refused by the check that follows. */
  const record = (request: unknown): void => {
    try {
      if (isObject(request)) seen.push(Object.freeze({ ...request }) as unknown as ModelRequest);
    } catch {
      // not recorded; checkRequest reports it
    }
  };

  const stepFor = (request: ModelRequest): ScriptStep | undefined => (typeof script === 'function' ? script(request, calls) : script[calls - 1]);

  return Object.freeze({
    get requests(): readonly ModelRequest[] {
      return [...seen];
    },
    get callCount(): number {
      return calls;
    },
    async complete(request: ModelRequest): Promise<Result<ModelResponse, LlmError>> {
      try {
        record(request);
        const problem = checkRequest(request);
        if (problem !== undefined) return err(problem);
        calls += 1;
        const step = stepFor(request);
        if (step === undefined) return err(llmError('MODEL_ERROR', `the scripted client has no answer left for call ${calls}`));
        return await runWithDeadline((signal) => perform(step, request, signal, usageDefault), { timeoutMs: request.timeoutMs, signal: request.signal });
      } catch (cause) {
        return err(llmError('MODEL_ERROR', `the scripted client failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    },
  });
}
