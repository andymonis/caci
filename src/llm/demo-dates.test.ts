import { describe, expect, it } from 'vitest';
import { addDaysTo, datesIn, datesInWindow } from './demo-dates.js';

const TODAY = '2026-10-22'; // a Thursday

describe('the demo model\'s date finder', () => {
  it('finds each way of writing a date', () => {
    expect(datesIn('Payment 2: 2026-10-01', TODAY)).toEqual(['2026-10-01']);
    expect(datesIn('due 01/02/2027', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('due 1 Feb 2027', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('due 01 February 2027', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('due 1st of February 2027', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('due 22nd Oct 2026', TODAY)).toEqual(['2026-10-22']);
    expect(datesIn('due Feb 1, 2027', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('due Sept 3 2026', TODAY)).toEqual(['2026-09-03']);
  });

  it('a date with no year is the next one on or after today', () => {
    expect(datesIn('1 Feb', TODAY)).toEqual(['2027-02-01']);
    expect(datesIn('22 Oct', TODAY)).toEqual(['2026-10-22']);
    expect(datesIn('21 Oct', TODAY)).toEqual(['2027-10-21']);
    expect(datesIn('Oct 28', TODAY)).toEqual(['2026-10-28']);
    expect(datesIn('29 Feb', '2027-03-01')).toEqual(['2028-02-29']);
  });

  it('today, tonight, tomorrow and weekday names are relative to today (a weekday is the next one, today included)', () => {
    expect(datesIn('dentist tomorrow', TODAY)).toEqual(['2026-10-23']);
    expect(datesIn('bins out tonight', TODAY)).toEqual(['2026-10-22']);
    expect(datesIn('Today is fine', TODAY)).toEqual(['2026-10-22']);
    expect(datesIn('see you on Friday', TODAY)).toEqual(['2026-10-23']);
    expect(datesIn('Thursday', TODAY)).toEqual(['2026-10-22']);
    expect(datesIn('Wednesday', TODAY)).toEqual(['2026-10-28']);
    expect(datesIn('on MONDAY', TODAY)).toEqual(['2026-10-26']);
  });

  it('gives every date once, in order; text with no date gives none; impossible dates are skipped', () => {
    expect(datesIn('1 May 2027 then 1 Feb 2027 then 2027-02-01 again', TODAY)).toEqual(['2027-02-01', '2027-05-01']);
    expect(datesIn('1 May 2027 then 1 Feb 2027', TODAY)).toEqual(['2027-02-01', '2027-05-01']);
    expect(datesIn('Mum takes 2 tablets daily', TODAY)).toEqual([]);
    expect(datesIn('', TODAY)).toEqual([]);
    expect(datesIn('31 Feb 2027, 32/01/2027, 2027-13-01, 00 May 2027', TODAY)).toEqual([]);
    expect(datesIn('29 Feb 2028', TODAY)).toEqual(['2028-02-29']);
    expect(datesIn('29 Feb 2027', TODAY)).toEqual([]);
  });

  it('the real case: four rent payments, two of them in the next year', () => {
    const rent = 'Payment 1 01 Aug 2026 £908.58. Payment 2 01 Oct 2026 £4,732.14. Payment 3 01 Feb 2027 £4,050.71. Payment 4 01 May 2027 £3,823.57.';
    expect(datesIn(rent, TODAY)).toEqual(['2026-08-01', '2026-10-01', '2027-02-01', '2027-05-01']);
    expect(datesInWindow(rent, '2026-10-22', '2026-10-28')).toEqual([]);
    expect(datesInWindow(rent, '2026-10-22', '2026-11-21')).toEqual([]);
    expect(datesInWindow(rent, '2026-10-22', '2027-10-22')).toEqual(['2027-02-01', '2027-05-01']);
  });

  it('a window includes both of its ends and nothing beside', () => {
    expect(datesInWindow('2026-10-22 and 2026-10-28', '2026-10-22', '2026-10-28')).toEqual(['2026-10-22', '2026-10-28']);
    expect(datesInWindow('2026-10-21 and 2026-10-29', '2026-10-22', '2026-10-28')).toEqual([]);
  });

  it('counts days across month, leap-day and year ends', () => {
    expect(addDaysTo('2026-10-22', 6)).toBe('2026-10-28');
    expect(addDaysTo('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysTo('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysTo('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDaysTo('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is the same every time and never throws on hostile text', () => {
    const hostile = '\u0000 ' + '9'.repeat(5000) + ' 99/99/9999 ' + 'jan '.repeat(2000);
    expect(() => datesIn(hostile, TODAY)).not.toThrow();
    expect(datesIn('1 Feb 2027', TODAY)).toEqual(datesIn('1 Feb 2027', TODAY));
  });
});
