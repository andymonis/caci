import { err, ok, type Result } from '../../../graph_store/index.js';
import { llmError, type LlmError } from '../../errors.js';
import { isTimeZone } from './prompt.js';

// The window of a focused status check (R-018 D6, D7). Pure: the code works the window out and says it to the model; the model never
// does. Days are calendar days in the person's time zone, so a month end, a leap day or a clock change cannot move a boundary.

export const HORIZONS = Object.freeze(['week', 'month', 'year'] as const);
export type Horizon = (typeof HORIZONS)[number];

export interface HorizonWindow {
  readonly horizon: Horizon;
  /** The first instant of today in the person's zone, milliseconds since 1970. */
  readonly from: number;
  /** The last instant of the last day (inclusive), milliseconds since 1970. */
  readonly to: number;
  /** `2026-10-22` and `2026-10-28`: the first and last day in the person's zone. */
  readonly fromDay: string;
  readonly toDay: string;
  /** As it is said to the model: `Thursday 22 October to Wednesday 28 October 2026`. */
  readonly label: string;
}

export const isHorizon = (value: unknown): value is Horizon => typeof value === 'string' && (HORIZONS as readonly string[]).includes(value);

interface Day {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function localParts(ms: number, timeZone: string): { day: Day; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(ms);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { day: { y: get('year'), m: get('month'), d: get('day') }, h: get('hour'), mi: get('minute'), s: get('second') };
}

/** How far local time is ahead of UTC at this instant (a whole second), in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.day.y, p.day.m - 1, p.day.d, p.h, p.mi, p.s) - ms; // ms is always a whole second here
}

/** The first instant of a calendar day in the zone. */
function startOfDay(day: Day, timeZone: string): number {
  const guess = Date.UTC(day.y, day.m - 1, day.d);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return t;
}

function addDays(day: Day, days: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The same date a year on; 29 February becomes 28 February in a year with none. */
function addYear(day: Day): Day {
  const t = new Date(Date.UTC(day.y + 1, day.m - 1, day.d));
  return t.getUTCMonth() + 1 === day.m ? { y: t.getUTCFullYear(), m: day.m, d: day.d } : { y: day.y + 1, m: day.m, d: new Date(Date.UTC(day.y + 1, day.m, 0)).getUTCDate() };
}

const iso = (day: Day): string => `${day.y}-${pad(day.m)}-${pad(day.d)}`;
const spoken = (day: Day, withYear: boolean): string => `${WEEKDAYS[new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()]} ${day.d} ${MONTHS[day.m - 1]}${withYear ? ` ${day.y}` : ''}`;

/**
 * The window for a horizon, counted in the person's calendar days: `week` is today and the next six days, `month` is today and the next
 * thirty, `year` runs to the same date a year on. Never throws; a time outside the range or a zone the runtime does not know is `CONFIG`.
 */
export function horizonWindow(now: number, timeZone: string, horizon: Horizon): Result<HorizonWindow, LlmError> {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0 || now >= 8.64e15 - 4e10) return err(llmError('CONFIG', 'horizon window: now must be milliseconds since 1970'));
  if (!isTimeZone(timeZone)) return err(llmError('CONFIG', 'horizon window: the time zone is not one the runtime knows'));
  if (!isHorizon(horizon)) return err(llmError('CONFIG', 'horizon window: the horizon must be "week", "month" or "year"'));
  const first = localParts(now, timeZone).day;
  const last = horizon === 'week' ? addDays(first, 6) : horizon === 'month' ? addDays(first, 30) : addYear(first);
  const sameYear = first.y === last.y;
  return ok(
    Object.freeze({
      horizon,
      from: startOfDay(first, timeZone),
      to: startOfDay(addDays(last, 1), timeZone) - 1,
      fromDay: iso(first),
      toDay: iso(last),
      label: `${spoken(first, !sameYear)} to ${spoken(last, true)}`,
    }),
  );
}
