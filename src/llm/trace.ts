import type { JsonObject } from '../graph_store/index.js';
import type { LlmError } from './errors.js';
import type { ModelMessage, ModelOutput } from './model-client.js';
import type { TokenUsage } from './usage.js';

/** One step of a capability call (the same for every capability that asks a model). The data is a copy of what the call really used. */
export type TraceEvent =
  /** What was built to send: the fixed instructions, the messages and the output schema. */
  | { readonly type: 'prompt'; readonly system: string; readonly messages: readonly ModelMessage[]; readonly schema: JsonObject }
  /** A call to the model is about to be made. Attempt 2 is the repair. */
  | { readonly type: 'request'; readonly attempt: 1 | 2; readonly model: string; readonly timeoutMs: number; readonly messages: readonly ModelMessage[] }
  | { readonly type: 'response'; readonly attempt: 1 | 2; readonly output: ModelOutput; readonly usage: TokenUsage; readonly model: string; readonly elapsedMs: number }
  /** The call failed (a provider error, a time-out, a cancellation). */
  | { readonly type: 'failure'; readonly attempt: 1 | 2; readonly error: LlmError; readonly elapsedMs: number }
  /** What the output guard made of a reply: accepted, or every problem it found. */
  | { readonly type: 'verdict'; readonly attempt: 1 | 2; readonly accepted: boolean; readonly problems: readonly string[] }
  /** The reasons being sent back for the repair attempt. */
  | { readonly type: 'repair'; readonly feedback: string }
  /** Always last, once per call. `attempts` is how many calls to the model were started. */
  | { readonly type: 'done'; readonly ok: boolean; readonly attempts: number; readonly elapsedMs: number; readonly error?: LlmError };

export type Emit = (event: TraceEvent) => void;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Hands events to the `trace` option's callback as frozen copies, and swallows anything it does wrong. */
export function makeEmitter(options: unknown): Emit {
  const trace = isObject(options) && typeof options.trace === 'function' ? (options.trace as (event: TraceEvent) => unknown) : undefined;
  if (trace === undefined) return () => undefined;
  return (event) => {
    try {
      const outcome = trace(Object.freeze(structuredClone(event)));
      if (typeof (outcome as { then?: unknown } | undefined)?.then === 'function') (outcome as Promise<unknown>).then(undefined, () => undefined);
    } catch {
      // a trace is for watching; it must never change what the call does
    }
  };
}
