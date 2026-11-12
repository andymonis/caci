import type { TraceEvent } from '../llm/index.js';
import { recordProblem, type UsageCapability, type UsageRecord, type UsageResult, type UsageScope, type UsageStore } from '../usage/index.js';

/** Who a call is charged to and what it was for (R-024 D2, D9). The recorder never sees any text. */
export interface UsageContext {
  readonly userId: string;
  readonly capability: UsageCapability;
  readonly scope: UsageScope;
}

const RESULT_OF_ERROR: Readonly<Record<string, UsageResult>> = Object.freeze({
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  REFUSED: 'refused',
  BAD_OUTPUT: 'bad_output',
  MODEL_ERROR: 'model_error',
  CONFIG: 'config',
  CANCELLED: 'cancelled',
});

/**
 * Turns the trace of one call into one record per attempt (R-024 D4). A response whose reply the checks accepted is `ok`, one they
 * refused is `rejected` (the repair is the next attempt); a failed request is one record with its error kind and no tokens (a failed
 * request returns none); a call refused before any model was asked is no record at all. Pure; `at` is when the call finished.
 */
export function recordsFromTrace(events: readonly TraceEvent[], context: UsageContext, at: number): UsageRecord[] {
  const records: UsageRecord[] = [];
  const modelAsked = new Map<number, string>();
  const accepted = new Map<number, boolean>();
  for (const event of events) {
    if (event.type === 'request') modelAsked.set(event.attempt, event.model);
    if (event.type === 'verdict') accepted.set(event.attempt, event.accepted);
  }
  for (const event of events) {
    if (event.type !== 'response' && event.type !== 'failure') continue;
    const attempt = event.attempt;
    const base = { at, userId: context.userId, capability: context.capability, scope: context.scope, attempt, latencyMs: Math.min(86_400_000, Math.max(0, Math.round(event.elapsedMs))) };
    const draft: UsageRecord =
      event.type === 'response'
        ? { ...base, model: event.model, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, cacheReadTokens: event.usage.cacheReadTokens ?? 0, cacheCreationTokens: event.usage.cacheCreationTokens ?? 0, result: accepted.get(attempt) === false ? 'rejected' : 'ok' }
        : { ...base, model: modelAsked.get(attempt) ?? 'unknown', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, result: RESULT_OF_ERROR[event.error.code] ?? 'model_error' };
    // a model name the check would refuse must not cost the whole batch
    records.push(recordProblem(draft) !== undefined && recordProblem({ ...draft, model: 'unknown' }) === undefined ? { ...draft, model: 'unknown' } : draft);
  }
  return records;
}

/** One call being recorded: hand its `trace` to the capability, then call `done` when the call has ended (successfully or not). */
export interface UsageCall {
  readonly trace: (event: TraceEvent) => void;
  done(): Promise<void>;
}

export interface UsageRecorder {
  begin(context: UsageContext): UsageCall;
}

export interface UsageRecorderInit {
  readonly store: Pick<UsageStore, 'append'>;
  readonly clock?: () => number;
  /** Told, with fixed words and nothing else, when a batch could not be saved. */
  readonly onWarning?: (message: string) => void;
}

export const USAGE_WARNING = 'usage records could not be saved';

/**
 * Collects a call's trace and saves its records after the answer is ready (R-024 D10). It never throws and never changes what the
 * call returned: a failed or throwing store, or a throwing warning hook, is swallowed after one fixed-words warning.
 */
export function createUsageRecorder(init: UsageRecorderInit): UsageRecorder {
  const clock = init.clock ?? Date.now;
  const warn = (): void => {
    try {
      init.onWarning?.(USAGE_WARNING);
    } catch {
      // a warning hook must not be able to break a call either
    }
  };
  return Object.freeze({
    begin(context: UsageContext): UsageCall {
      const events: TraceEvent[] = [];
      return Object.freeze({
        trace: (event: TraceEvent): void => {
          events.push(event);
        },
        done: async (): Promise<void> => {
          try {
            const records = recordsFromTrace(events, context, clock());
            if (records.length === 0) return;
            const saved = await init.store.append(records);
            if (!saved.ok) warn();
          } catch {
            warn();
          }
        },
      });
    },
  });
}
