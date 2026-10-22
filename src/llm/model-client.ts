import type { JsonObject, JsonValue, Result } from '../graph_store/index.js';
import type { LlmError } from './errors.js';
import type { TokenUsage } from './usage.js';

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * Facts about a request that a client may use but that are **never sent to a provider** (R-012). They exist so the
 * free demo model and the test clients do not have to read the wording of the controls, which anyone may edit.
 */
export type ModelMeta =
  | { readonly capability: 'categorise'; readonly itemId: string; /** Most facts a reply may hold (R-015); absent means 1. */ readonly maxFacts?: number }
  | { readonly capability: 'status'; readonly entryCount: number; readonly now: number; readonly timeZone: string; /** A focused check (R-018): the window and the most points it may have, for the demo client. */ readonly horizon?: { readonly name: 'week' | 'month' | 'year'; readonly fromDay: string; readonly toDay: string; readonly maxPoints: number } };

/**
 * One call to a model. Every request names its model, so no client hides a default and the model
 * can be chosen per capability, per call or per run.
 */
export interface ModelRequest {
  /** The model to use, as the provider names it (for example `claude-haiku-4-5-20251001`). */
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  /** When set, the reply must be JSON matching this JSON Schema, and is returned parsed. */
  readonly outputSchema?: JsonObject;
  readonly maxOutputTokens: number;
  /** Give up after this long and return a `TIMEOUT` error. */
  readonly timeoutMs: number;
  /** Machine-readable facts for the demo and test clients. A real client must not send them. */
  readonly meta?: ModelMeta;
  /** Lets the caller cancel the call; a cancelled call ends with a `CANCELLED` error result, not an exception. */
  readonly signal?: AbortSignal;
}

export type ModelOutput = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'json'; readonly value: JsonValue };

export interface ModelResponse {
  /** The model that actually answered, which a provider may report differently from the one asked for. */
  readonly model: string;
  readonly output: ModelOutput;
  readonly usage: TokenUsage;
}

/**
 * The only door to a model. Implementations (the real Anthropic client, the scripted test client)
 * turn a request into a response or a typed error, and never throw: bad output, refusals, time-outs
 * and provider failures all come back as `LlmError` results.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<Result<ModelResponse, LlmError>>;
}
