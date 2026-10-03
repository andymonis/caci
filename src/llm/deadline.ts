import { err, type Result } from '../graph_store/index.js';
import { llmError, type LlmError } from './errors.js';

export interface DeadlineOptions {
  readonly timeoutMs: number;
  /** The caller's cancellation signal. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runs a piece of work under a time limit and the caller's cancellation, for every client. The work
 * receives a signal that fires when either happens, so it can stop (for example by passing the
 * signal to `fetch`). Gives back `TIMEOUT` when the time runs out, `CANCELLED` when the caller
 * cancels (also when the signal was already cancelled, in which case the work never starts), and
 * `MODEL_ERROR` if the work throws. Never throws, never leaves a timer running.
 */
export async function runWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<Result<T, LlmError>>,
  options: DeadlineOptions,
): Promise<Result<T, LlmError>> {
  const { timeoutMs, signal } = options;
  if (signal?.aborted === true) return err(llmError('CANCELLED', 'the call was cancelled before it started'));

  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const interrupted = new Promise<Result<T, LlmError>>((resolve) => {
    timer = setTimeout(() => {
      resolve(err(llmError('TIMEOUT', `the model did not answer within ${timeoutMs} ms`)));
      inner.abort();
    }, timeoutMs);
    onAbort = () => {
      resolve(err(llmError('CANCELLED', 'the call was cancelled')));
      inner.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const finished = work(inner.signal).catch(
      (cause: unknown): Result<T, LlmError> => err(llmError('MODEL_ERROR', `the model client failed: ${cause instanceof Error ? cause.message : String(cause)}`)),
    );
    return await Promise.race([finished, interrupted]);
  } catch (cause) {
    return err(llmError('MODEL_ERROR', `the model client failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
