// A small, deterministic date finder for the free demo model (R-018 D13). It is a stand-in so tests and journeys can show a
// focused check being silent; it is not a judge of meaning. Days are `YYYY-MM-DD` strings and all arithmetic is calendar
// arithmetic, so there is no clock and no time zone in here: the caller says what "today" is.

const MONTHS = Object.freeze(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

const pad = (n: number): string => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number): boolean => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const parts = (day: string): { y: number; m: number; d: number } => ({ y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)), d: Number(day.slice(8, 10)) });

/** The day `days` after (or before, if negative) the given day. */
export function addDaysTo(day: string, days: number): string {
  const { y, m, d } = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const weekdayOf = (day: string): number => {
  const { y, m, d } = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** A date written without a year is the next one on or after today. */
function withYear(today: string, m: number, d: number, year: number | undefined): string | undefined {
  if (year !== undefined) return valid(year, m, d) ? iso(year, m, d) : undefined;
  const t = parts(today);
  for (const y of [t.y, t.y + 1]) if (valid(y, m, d) && iso(y, m, d) >= today) return iso(y, m, d);
  return undefined;
}

/**
 * Every day the text names, resolved against `today`, without repeats and in order: `2027-02-01`, `01/02/2027` (day first),
 * `1 Feb 2027`, `1st of February`, `Feb 1, 2027`, `today`, `tonight`, `tomorrow` and weekday names (the next one, today included).
 */
export function datesIn(text: string, today: string): readonly string[] {
  const found = new Set<string>();
  const add = (day: string | undefined): void => {
    if (day !== undefined) found.add(day);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(y, mo, d)) add(iso(y, mo, d));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) add(withYear(today, Number(m[2]), Number(m[1]), Number(m[3])));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) {
    add(withYear(today, MONTHS.indexOf((m[2] as string).toLowerCase()) + 1, Number(m[1]), m[3] === undefined ? undefined : Number(m[3])));
  }
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) {
    add(withYear(today, MONTHS.indexOf((m[1] as string).toLowerCase()) + 1, Number(m[2]), m[3] === undefined ? undefined : Number(m[3])));
  }
  for (const m of text.matchAll(/\b(today|tonight|tomorrow)\b/gi)) add((m[1] as string).toLowerCase() === 'tomorrow' ? addDaysTo(today, 1) : today);
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`, 'gi'))) {
    const ahead = (WEEKDAYS.indexOf((m[1] as string).toLowerCase()) - weekdayOf(today) + 7) % 7;
    add(addDaysTo(today, ahead));
  }
  return [...found].sort();
}

/** The days of the text that fall inside the window, both ends included. */
export function datesInWindow(text: string, fromDay: string, toDay: string): readonly string[] {
  return datesIn(text, fromDay).filter((day) => day >= fromDay && day <= toDay);
}
