import { err, ok, type Result } from '../graph_store/index.js';
import { llmError, type LlmError } from './errors.js';

/** The environment variable the Anthropic API key is read from. */
export const ANTHROPIC_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/** What a key may look like: 8 to 512 printable characters, no spaces. A check on the shape only, not that the key works. */
export const ANTHROPIC_KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

/**
 * Reads the key from an environment object the caller passes in (for example the process environment).
 * This lives outside the Anthropic client so that checking a setting does not need the provider's SDK.
 * The key is never echoed in an error.
 */
export function readAnthropicKey(env: Readonly<Record<string, string | undefined>>): Result<string, LlmError> {
  const value = env[ANTHROPIC_KEY_VARIABLE];
  if (value === undefined || value.trim() === '') return err(llmError('CONFIG', `${ANTHROPIC_KEY_VARIABLE} is not set`));
  const key = value.trim();
  return ANTHROPIC_KEY_SHAPE.test(key) ? ok(key) : err(llmError('CONFIG', `${ANTHROPIC_KEY_VARIABLE} does not look like an API key (printable characters, 8 to 512 of them, no spaces)`));
}
