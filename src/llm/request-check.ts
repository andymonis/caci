import { modelIdProblem } from './config.js';
import { llmError, type LlmError } from './errors.js';

const REQUEST_FIELDS: readonly string[] = Object.freeze(['model', 'system', 'messages', 'outputSchema', 'maxOutputTokens', 'timeoutMs', 'signal']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const looksLikeSignal = (value: unknown): boolean =>
  isObject(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';

const bad = (where: string, message: string): LlmError => llmError('CONFIG', `request.${where}: ${message}`);

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
    return undefined;
  } catch {
    return llmError('CONFIG', 'request: could not be read');
  }
}
