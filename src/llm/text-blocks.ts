import { llmError, type LlmError } from './errors.js';

// Small helpers every capability needs, kept in the shared kernel so no capability imports another.

/**
 * Makes text safe to place between tags: `&`, `<` and `>` become entities, so nothing inside can
 * look like a tag, and the exact original is recoverable. This is how user text is kept from
 * closing its own block and passing for instructions.
 */
export function escapeForBlock(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MAX_PROBLEMS = 5;

/** The error for a rejected reply: up to five numbered problems, so one repair attempt can fix them together. */
export const rejectionError = (problems: readonly string[]): LlmError =>
  llmError('BAD_OUTPUT', `The reply was not accepted: ${problems.slice(0, MAX_PROBLEMS).map((p, i) => `(${i + 1}) ${p}`).join(' ')}${problems.length > MAX_PROBLEMS ? ` (and ${problems.length - MAX_PROBLEMS} more)` : ''}`);
