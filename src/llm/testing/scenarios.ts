import type { JsonValue } from '../../graph_store/index.js';
import type { TokenUsage } from '../usage.js';
import type { Script } from './scripted-client.js';

/**
 * Situations every model client must handle. The contract suite names them and each client says
 * how to produce one (a real client points its HTTP layer at a fake provider that behaves this way).
 */
export type ClientScenario =
  /** The provider answers with this text. */
  | { readonly kind: 'text'; readonly text: string; readonly usage: TokenUsage; readonly model?: string }
  /** The provider answers with this JSON (sent as text, which the client must parse because the request asked for JSON). */
  | { readonly kind: 'json'; readonly value: JsonValue; readonly usage: TokenUsage }
  /** The request asked for JSON but the provider sent prose. */
  | { readonly kind: 'not-json'; readonly text: string }
  | { readonly kind: 'refusal' }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs?: number }
  /** A provider fault worth retrying. */
  | { readonly kind: 'server-error' }
  /** The provider rejected the request itself. */
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unknown-model' }
  /** The provider never answers. */
  | { readonly kind: 'hangs' };

/** The script that makes a scripted client act out a scenario, every time it is called. */
export function scriptFor(scenario: ClientScenario): Script {
  switch (scenario.kind) {
    case 'text':
      return () => ({ reply: scenario.text, usage: scenario.usage, ...(scenario.model === undefined ? {} : { model: scenario.model }) });
    case 'json':
      return () => ({ reply: JSON.stringify(scenario.value), usage: scenario.usage });
    case 'not-json':
      return () => ({ reply: scenario.text });
    case 'refusal':
      return () => ({ refusal: true });
    case 'rate-limited':
      return () => ({ rateLimited: true, ...(scenario.retryAfterMs === undefined ? {} : { retryAfterMs: scenario.retryAfterMs }) });
    case 'server-error':
      return () => ({ serverError: true });
    case 'rejected':
      return () => ({ rejected: true });
    case 'unknown-model':
      return () => ({ unknownModel: true });
    case 'hangs':
      return () => ({ hang: true });
  }
}
