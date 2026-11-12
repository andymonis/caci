import { costOf, priceOf, type PriceTable } from './prices.js';
import type { UsageAggregate, UsageCapability } from './types.js';

export const GROUP_BYS = ['user', 'capability', 'model', 'circle', 'day', 'month'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

/** What the report says for accounts that are gone. */
export const DELETED_ACCOUNT = 'deleted account';

export interface Tally {
  readonly calls: number;
  readonly attempts: number;
  readonly rejected: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly latencyMs: number;
  /** The cost of the attempts whose model has a price. */
  readonly cost: number;
  /** Attempts whose model has no price: their tokens are counted, their cost is not. */
  readonly unpricedAttempts: number;
}

export interface ReportGroup extends Tally {
  readonly key: string;
  /** What to show for the key: a username for a person (when known), otherwise the key itself. */
  readonly label: string;
}

export interface CallCost {
  readonly capability: UsageCapability;
  readonly calls: number;
  /** Calls whose model has a price, and what they cost (repairs included). */
  readonly pricedCalls: number;
  readonly cost: number;
  /** The average cost of a call, or `null` when no call of this kind was priced. */
  readonly averageCost: number | null;
}

export interface Spender {
  readonly userId: string;
  readonly label: string;
  readonly cost: number;
  /** Share of all priced cost of live accounts, 0 to 1. */
  readonly share: number;
}

export interface Report {
  readonly by: GroupBy;
  readonly currency: string;
  readonly asOf: string;
  readonly groups: readonly ReportGroup[];
  readonly totals: Tally;
  readonly perCall: readonly CallCost[];
  /** Models seen with no price, with what they used. */
  readonly unpriced: ReadonlyArray<{ readonly model: string; readonly attempts: number; readonly inputTokens: number; readonly outputTokens: number }>;
  /** Extra attempts (repairs) per call, 0 or more. */
  readonly repairRate: number;
  /** Attempts the checks refused, over all attempts. */
  readonly rejectedRate: number;
  /** Attempts that failed to get an answer, over all attempts. */
  readonly failedRate: number;
  readonly topSpenders: readonly Spender[];
  /** Over live accounts that made a call; accounts that are gone are not people and are left out (and shown in `deletedCost`). */
  readonly distribution: { readonly people: number; readonly mean: number; readonly median: number; readonly p90: number; readonly max: number; readonly topTenthShare: number };
  readonly deletedCost: number;
}

export interface ReportOptions {
  readonly by: GroupBy;
  /** How many top spenders to list (default 10). */
  readonly top?: number;
  /** Turns a user id into the text to show (a username); unknown ids show as the id. */
  readonly label?: (userId: string) => string | undefined;
}

type MutableTally = { -readonly [K in keyof Tally]: Tally[K] };
const empty = (): MutableTally => ({ calls: 0, attempts: 0, rejected: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 0, cost: 0, unpricedAttempts: 0 });

function add(t: MutableTally, r: UsageAggregate, cost: number | null): void {
  t.calls += r.calls;
  t.attempts += r.attempts;
  t.rejected += r.rejected;
  t.failed += r.failed;
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.cacheCreationTokens += r.cacheCreationTokens;
  t.latencyMs += r.latencyMs;
  if (cost === null) t.unpricedAttempts += r.attempts;
  else t.cost += cost;
}

const keyOf = (r: UsageAggregate, by: GroupBy): string => {
  switch (by) {
    case 'user': return r.userId ?? DELETED_ACCOUNT;
    case 'capability': return r.capability;
    case 'model': return r.model;
    case 'circle': return r.scope.kind === 'personal' ? 'personal' : r.scope.circleId;
    case 'day': return r.day;
    case 'month': return r.day.slice(0, 7);
  }
};

const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);
/** Nearest-rank percentile of an ascending list. */
const percentile = (sorted: readonly number[], p: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number));

/**
 * Turns the store's daily aggregates into the operator's report (R-024 D7, D14). Pure. Cost is only ever for models with a price:
 * a model with none is listed as unpriced with its tokens, and is never counted as free.
 */
export function buildReport(rows: readonly UsageAggregate[], prices: PriceTable, options: ReportOptions): Report {
  const top = options.top ?? 10;
  const groups = new Map<string, MutableTally>();
  const totals = empty();
  const perCall = new Map<UsageCapability, { calls: number; pricedCalls: number; cost: number }>();
  const unpriced = new Map<string, { attempts: number; inputTokens: number; outputTokens: number }>();
  const spend = new Map<string, number>();
  let deletedCost = 0;
  for (const r of rows) {
    const price = priceOf(prices, r.model);
    const cost = price === undefined ? null : costOf(price, r);
    const key = keyOf(r, options.by);
    let g = groups.get(key);
    if (g === undefined) groups.set(key, (g = empty()));
    add(g, r, cost);
    add(totals, r, cost);
    const c = perCall.get(r.capability) ?? { calls: 0, pricedCalls: 0, cost: 0 };
    c.calls += r.calls;
    if (cost !== null) {
      c.pricedCalls += r.calls;
      c.cost += cost;
    }
    perCall.set(r.capability, c);
    if (cost === null) {
      const u = unpriced.get(r.model) ?? { attempts: 0, inputTokens: 0, outputTokens: 0 };
      u.attempts += r.attempts;
      u.inputTokens += r.inputTokens;
      u.outputTokens += r.outputTokens;
      unpriced.set(r.model, u);
    } else if (r.userId === null) deletedCost += cost;
    else spend.set(r.userId, (spend.get(r.userId) ?? 0) + cost);
  }
  const labelOf = options.label ?? (() => undefined);
  const ordered = [...groups.entries()].map(([key, t]): ReportGroup => Object.freeze({ key, label: options.by === 'user' && key !== DELETED_ACCOUNT ? (labelOf(key) ?? key) : key, ...t }));
  ordered.sort((a, b) => (options.by === 'day' || options.by === 'month' ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  const liveTotal = [...spend.values()].reduce((n, c) => n + c, 0);
  const spenders = [...spend.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const costs = [...spend.values()].sort((a, b) => a - b);
  const tenth = Math.ceil(spenders.length / 10);
  return Object.freeze({
    by: options.by,
    currency: prices.currency,
    asOf: prices.asOf,
    groups: Object.freeze(ordered),
    totals: Object.freeze(totals),
    perCall: Object.freeze((['categorise', 'status', 'check', 'agent-check'] as const).filter((c) => perCall.has(c)).map((capability): CallCost => {
      const c = perCall.get(capability) as { calls: number; pricedCalls: number; cost: number };
      return Object.freeze({ capability, calls: c.calls, pricedCalls: c.pricedCalls, cost: c.cost, averageCost: c.pricedCalls === 0 ? null : c.cost / c.pricedCalls });
    })),
    unpriced: Object.freeze([...unpriced.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([model, u]) => Object.freeze({ model, ...u }))),
    repairRate: rate(totals.attempts - totals.calls, totals.calls),
    rejectedRate: rate(totals.rejected, totals.attempts),
    failedRate: rate(totals.failed, totals.attempts),
    topSpenders: Object.freeze(spenders.slice(0, top).map(([userId, cost]): Spender => Object.freeze({ userId, label: labelOf(userId) ?? userId, cost, share: rate(cost, liveTotal) }))),
    distribution: Object.freeze({
      people: costs.length,
      mean: rate(liveTotal, costs.length),
      median: percentile(costs, 0.5),
      p90: percentile(costs, 0.9),
      max: costs.at(-1) ?? 0,
      topTenthShare: rate(spenders.slice(0, tenth).reduce((n, [, c]) => n + c, 0), liveTotal),
    }),
    deletedCost,
  });
}

/** What an invoice figure says about the estimate (R-024 D14). */
export function invoiceDifference(estimate: number, invoice: number): { readonly estimate: number; readonly invoice: number; readonly difference: number; readonly percent: number | null } {
  return Object.freeze({ estimate, invoice, difference: estimate - invoice, percent: invoice === 0 ? null : ((estimate - invoice) / invoice) * 100 });
}
