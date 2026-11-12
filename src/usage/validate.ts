import { isUserId } from '../users/index.js';
import { LATENCY_MAX, MODEL_MAX, TOKENS_MAX, USAGE_CAPABILITIES, USAGE_RESULTS, type UsageAggregate, type UsageRange, type UsageRecord, type UsageScope } from './types.js';

export const CIRCLE_ID = /^c[a-z0-9]{16}$/;
const KEYS = ['at', 'userId', 'capability', 'scope', 'model', 'attempt', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'result', 'latencyMs'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
/** A model name: 1 to 200 characters, no spaces or control characters (the same loose rule the model configuration uses). */
const isModel = (v: unknown): v is string => typeof v === 'string' && [...v].length >= 1 && [...v].length <= MODEL_MAX && !/[\s\p{Cc}]/u.test(v);

export function scopeProblem(scope: unknown): string | undefined {
  if (!isObject(scope)) return 'scope must be an object';
  if (scope.kind === 'personal') return Object.keys(scope).length === 1 ? undefined : 'a personal scope has no other field';
  if (scope.kind === 'circle') return Object.keys(scope).length === 2 && typeof scope.circleId === 'string' && CIRCLE_ID.test(scope.circleId) ? undefined : 'a circle scope is exactly a kind and a circle id';
  return 'scope.kind must be personal or circle';
}

/** `undefined` when the record is acceptable, otherwise the first thing wrong. Strict: any field that is not listed is refused, so no text can be smuggled in. */
export function recordProblem(record: unknown): string | undefined {
  if (!isObject(record)) return 'a usage record must be an object';
  for (const key of Object.keys(record)) if (!(KEYS as readonly string[]).includes(key)) return `a usage record has no field ${JSON.stringify(key.slice(0, 20))}`;
  if (!whole(record.at, 8_640_000_000_000_000)) return 'at must be a whole number of milliseconds';
  if (!isUserId(record.userId)) return 'userId must be a user id';
  if (!(USAGE_CAPABILITIES as readonly unknown[]).includes(record.capability)) return 'capability is not one this service meters';
  const scope = scopeProblem(record.scope);
  if (scope !== undefined) return scope;
  if (!isModel(record.model)) return 'model must be 1 to 200 characters with no spaces or control characters';
  if (record.attempt !== 1 && record.attempt !== 2) return 'attempt must be 1 or 2';
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) if (!whole(record[key], TOKENS_MAX)) return `${key} must be a whole number of tokens`;
  if ((record.cacheReadTokens as number) + (record.cacheCreationTokens as number) > (record.inputTokens as number)) return 'the cache counts are part of the input and cannot exceed it';
  if (!(USAGE_RESULTS as readonly unknown[]).includes(record.result)) return 'result is not one of the known results';
  if (!whole(record.latencyMs, LATENCY_MAX)) return 'latencyMs must be a whole number of milliseconds, at most a day';
  return undefined;
}

export function copyRecord(r: UsageRecord): UsageRecord {
  return Object.freeze({ at: r.at, userId: r.userId, capability: r.capability, scope: Object.freeze(r.scope.kind === 'personal' ? { kind: 'personal' as const } : { kind: 'circle' as const, circleId: r.scope.circleId }), model: r.model, attempt: r.attempt, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens, result: r.result, latencyMs: r.latencyMs });
}

export const scopeKey = (scope: UsageScope): string => (scope.kind === 'personal' ? 'personal' : `circle:${scope.circleId}`);

/** The UTC day of a time, as `YYYY-MM-DD`. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Whole times with `from` not after `to`; anything else is a coding mistake (a `RangeError`). */
export function checkRange(range: UsageRange): void {
  if (!whole(range.from, 8_640_000_000_000_000) || !whole(range.to, 8_640_000_000_000_000) || range.from > range.to) throw new RangeError('a usage range needs whole times with from not after to');
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The fixed order of the aggregates: day, then person (accounts that are gone last), call type, scope, model. */
export function compareAggregates(a: UsageAggregate, b: UsageAggregate): number {
  return text(a.day, b.day) || (a.userId === b.userId ? 0 : a.userId === null ? 1 : b.userId === null ? -1 : text(a.userId, b.userId)) || text(a.capability, b.capability) || text(scopeKey(a.scope), scopeKey(b.scope)) || text(a.model, b.model);
}

/** Adds records up into aggregates, for the reference store. `userId` null means the record's person is gone. */
export function aggregateRecords(records: ReadonlyArray<{ readonly record: UsageRecord; readonly userId: string | null }>, range: UsageRange): UsageAggregate[] {
  checkRange(range);
  const groups = new Map<string, { -readonly [K in keyof UsageAggregate]: UsageAggregate[K] }>();
  for (const { record: r, userId } of records) {
    if (r.at < range.from || r.at >= range.to) continue;
    const day = dayOf(r.at);
    const key = JSON.stringify([day, userId, r.capability, scopeKey(r.scope), r.model]);
    let g = groups.get(key);
    if (g === undefined) {
      g = { day, userId, capability: r.capability, scope: r.scope.kind === 'personal' ? { kind: 'personal' } : { kind: 'circle', circleId: r.scope.circleId }, model: r.model, calls: 0, attempts: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 0 };
      groups.set(key, g);
    }
    if (r.attempt === 1) g.calls++;
    g.attempts++;
    if (r.result === 'rejected') g.rejected++;
    else if (r.result !== 'ok') g.failed++;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.cacheReadTokens += r.cacheReadTokens;
    g.cacheCreationTokens += r.cacheCreationTokens;
    g.latencyMs += r.latencyMs;
  }
  return [...groups.values()].map((g) => Object.freeze({ ...g, scope: Object.freeze(g.scope) })).sort(compareAggregates);
}
