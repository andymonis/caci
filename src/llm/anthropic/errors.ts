import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { llmError, type LlmError } from '../errors.js';

const MAX_MESSAGE = 300;

/** Makes text safe to show: the key (and anything shaped like one) is removed, and long text is cut. */
export function redact(text: string, secret: string): string {
  const withoutKey = secret.length > 0 ? text.split(secret).join('[redacted]') : text;
  const cleaned = withoutKey.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_MESSAGE ? `${cleaned.slice(0, MAX_MESSAGE)}…` : cleaned;
}

/** How long the provider asked callers to wait, in milliseconds, from its headers. */
function retryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  const ms = Number(headers?.get('retry-after-ms'));
  if (headers?.get('retry-after-ms') != null && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const header = headers?.get('retry-after');
  if (header == null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  if (!/[A-Za-z]/.test(header)) return undefined; // a number we could not accept above (negative, say), not a date
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** What the provider said about the problem, without the key and without raw response bodies. */
function providerSays(error: APIError, secret: string): string {
  const body: unknown = error.error;
  const inner = typeof body === 'object' && body !== null ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  return typeof inner === 'string' && inner !== '' ? redact(inner, secret) : 'no details given';
}

/**
 * Turns whatever the SDK threw into the component's own error type. Only messages written here,
 * plus the provider's short explanation with the key removed, are used; the SDK's own message
 * (which carries the raw response body) is never passed on.
 */
export function mapProviderError(error: unknown, secret: string, now: number = Date.now()): LlmError {
  if (error instanceof APIUserAbortError) return llmError('CANCELLED', 'the call was cancelled');
  if (error instanceof APIConnectionTimeoutError) return llmError('TIMEOUT', 'the connection to the provider timed out');
  if (error instanceof APIConnectionError) return llmError('MODEL_ERROR', 'could not reach the provider', { retryable: true });
  if (error instanceof APIError) {
    const says = providerSays(error, secret);
    const { status } = error;
    if (error instanceof RateLimitError) {
      const wait = retryAfterMs(error.headers, now);
      return llmError('RATE_LIMITED', `the provider is rate limiting this key: ${says}`, wait === undefined ? {} : { retryAfterMs: wait });
    }
    if (error instanceof NotFoundError) return llmError('CONFIG', `the model was not found or is not available to this key: ${says}`);
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return llmError('CONFIG', `the provider did not accept the API key or its permissions (HTTP ${status}): ${says}`);
    }
    if (typeof status === 'number' && status >= 500) return llmError('MODEL_ERROR', `the provider failed (HTTP ${status}): ${says}`, { retryable: true });
    return llmError('MODEL_ERROR', `the provider rejected the request (HTTP ${String(status)}): ${says}`);
  }
  return llmError('MODEL_ERROR', 'the call to the provider failed');
}
