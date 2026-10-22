import { modelIdProblem } from './config.js';
import { llmError, type LlmError } from './errors.js';

const REQUEST_FIELDS: readonly string[] = Object.freeze(['model', 'system', 'messages', 'outputSchema', 'maxOutputTokens', 'timeoutMs', 'signal', 'meta']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const looksLikeSignal = (value: unknown): boolean =>
  isObject(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';

const bad = (where: string, message: string): LlmError => llmError('CONFIG', `request.${where}: ${message}`);

function metaProblemOf(meta: unknown): string | undefined {
  if (meta === undefined) return undefined;
  if (!isObject(meta)) return 'must be an object when given';
  if (meta.capability === 'categorise') {
    if (Object.keys(meta).some((k) => k !== 'capability' && k !== 'itemId' && k !== 'maxFacts')) return 'a categorise meta may hold only capability, itemId and maxFacts';
    if (meta.maxFacts !== undefined && (typeof meta.maxFacts !== 'number' || !Number.isSafeInteger(meta.maxFacts) || meta.maxFacts < 1)) return 'maxFacts must be a whole number from 1';
    return typeof meta.itemId === 'string' && meta.itemId !== '' ? undefined : 'itemId must be non-empty text';
  }
  if (meta.capability === 'status') {
    if (Object.keys(meta).some((k) => !['capability', 'entryCount', 'now', 'timeZone', 'horizon'].includes(k))) return 'a status meta may hold only capability, entryCount, now, timeZone and horizon';
    if (meta.horizon !== undefined) {
      const h = meta.horizon;
      if (!isObject(h) || Object.keys(h).some((k) => !['name', 'fromDay', 'toDay', 'maxPoints'].includes(k))) return 'horizon may hold only name, fromDay, toDay and maxPoints';
      if (h.name !== 'week' && h.name !== 'month' && h.name !== 'year') return 'horizon.name must be "week", "month" or "year"';
      for (const day of [h.fromDay, h.toDay]) if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'horizon.fromDay and horizon.toDay must be days like 2026-10-22';
      if (typeof h.maxPoints !== 'number' || !Number.isSafeInteger(h.maxPoints) || h.maxPoints < 1) return 'horizon.maxPoints must be a whole number from 1';
    }
    if (typeof meta.entryCount !== 'number' || !Number.isSafeInteger(meta.entryCount) || meta.entryCount < 0) return 'entryCount must be a whole number';
    if (typeof meta.now !== 'number' || !Number.isSafeInteger(meta.now) || meta.now < 0) return 'now must be milliseconds since 1970';
    return typeof meta.timeZone === 'string' && meta.timeZone !== '' ? undefined : 'timeZone must be text';
  }
  return 'capability must be "categorise" or "status"';
}

/**
 * Checks a model request before anything is sent. Every client does this first, so a request that
 * cannot be sent comes back as a `CONFIG` error that says what is wrong, never as an exception or
 * a confusing provider failure. Unknown fields are refused so a misspelt setting is not silently
 * ignored. Pure; never throws.
 */
export function checkRequest(request: unknown): LlmError | undefined {
  try {
    if (!isObject(request)) return llmError('CONFIG', 'request: must be an object');
    const extra = Object.keys(request).find((key) => !REQUEST_FIELDS.includes(key));
    if (extra !== undefined) return bad(extra, `unknown field (known: ${REQUEST_FIELDS.join(', ')})`);

    const modelProblem = modelIdProblem(request.model);
    if (modelProblem !== undefined) return bad('model', modelProblem);

    const { system, messages, outputSchema, maxOutputTokens, timeoutMs, signal } = request;
    if (system !== undefined && typeof system !== 'string') return bad('system', 'must be text when given');
    if (!Array.isArray(messages) || messages.length === 0) return bad('messages', 'must be a non-empty list');
    for (const [index, message] of messages.entries()) {
      if (!isObject(message)) return bad(`messages[${index}]`, 'must be an object like { role, content }');
      if (message.role !== 'user' && message.role !== 'assistant') return bad(`messages[${index}].role`, 'must be "user" or "assistant"');
      if (typeof message.content !== 'string' || message.content.length === 0) return bad(`messages[${index}].content`, 'must be non-empty text');
    }
    if (outputSchema !== undefined && !isObject(outputSchema)) return bad('outputSchema', 'must be a JSON Schema object when given');
    if (!positiveInteger(maxOutputTokens)) return bad('maxOutputTokens', 'must be a positive whole number');
    if (!positiveInteger(timeoutMs)) return bad('timeoutMs', 'must be a positive whole number of milliseconds');
    if (signal !== undefined && !looksLikeSignal(signal)) return bad('signal', 'must be an AbortSignal when given');
    const metaProblem = metaProblemOf(request.meta);
    if (metaProblem !== undefined) return bad('meta', metaProblem);
    return undefined;
  } catch {
    return llmError('CONFIG', 'request: could not be read');
  }
}
