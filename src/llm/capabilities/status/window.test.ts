import { describe, expect, it } from 'vitest';
import { horizonWindow, HORIZONS, isHorizon, type Horizon } from './window.js';

const at = (iso: string): number => Date.parse(iso);
const win = (iso: string, zone: string, horizon: Horizon) => {
  const r = horizonWindow(at(iso), zone, horizon);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('the window of a horizon', () => {
  it('the three horizons are week, month and year', () => {
    expect([...HORIZONS]).toEqual(['week', 'month', 'year']);
    expect(isHorizon('week') && isHorizon('month') && isHorizon('year')).toBe(true);
    for (const bad of ['', 'Week', 'day', 'quarter', 5, null, undefined, {}, 'toString', '__proto__']) expect(isHorizon(bad), String(bad)).toBe(false);
  });

  it('22 October 2026 in London: the week runs to Wednesday 28 October, said in words, with the exact days', () => {
    const w = win('2026-10-22T09:30:00Z', 'Europe/London', 'week');
    expect(w).toMatchObject({ horizon: 'week', fromDay: '2026-10-22', toDay: '2026-10-28', label: 'Thursday 22 October to Wednesday 28 October 2026' });
    expect(w.from).toBe(at('2026-10-22T00:00:00+01:00'));
    // the clocks go back on Sunday 25 October, so the last day ends at the local midnight of the 29th (GMT, UTC+0)
    expect(w.to).toBe(at('2026-10-29T00:00:00Z') - 1);
    expect(Object.isFrozen(w)).toBe(true);
  });

  it('the month is today and the next thirty days; the year is the same date a year on', () => {
    expect(win('2026-10-22T09:30:00Z', 'Europe/London', 'month')).toMatchObject({ toDay: '2026-11-21', label: 'Thursday 22 October to Saturday 21 November 2026' });
    expect(win('2026-10-22T09:30:00Z', 'Europe/London', 'year')).toMatchObject({ fromDay: '2026-10-22', toDay: '2027-10-22', label: 'Thursday 22 October 2026 to Friday 22 October 2027' });
  });

  it('the day is the person\'s: the same instant is a different day in Auckland, and a zone far behind', () => {
    const instant = '2026-10-22T20:00:00Z';
    expect(win(instant, 'UTC', 'week').fromDay).toBe('2026-10-22');
    expect(win(instant, 'Pacific/Auckland', 'week').fromDay).toBe('2026-10-23');
    expect(win(instant, 'America/Los_Angeles', 'week').fromDay).toBe('2026-10-22');
    expect(win('2026-10-22T03:00:00Z', 'America/Los_Angeles', 'week').fromDay).toBe('2026-10-21');
    const w = win(instant, 'Pacific/Auckland', 'week');
    expect(w.from).toBe(at('2026-10-23T00:00:00+13:00'));
    expect(w.to).toBe(at('2026-10-30T00:00:00+13:00') - 1);
  });

  it('month ends, leap days and year ends are calendar arithmetic', () => {
    expect(win('2026-12-28T10:00:00Z', 'UTC', 'week')).toMatchObject({ toDay: '2027-01-03', label: 'Monday 28 December 2026 to Sunday 3 January 2027' });
    expect(win('2028-02-27T10:00:00Z', 'UTC', 'week').toDay).toBe('2028-03-04');
    expect(win('2027-02-27T10:00:00Z', 'UTC', 'week').toDay).toBe('2027-03-05');
    expect(win('2028-02-29T10:00:00Z', 'UTC', 'year').toDay).toBe('2029-02-28');
    expect(win('2027-03-01T10:00:00Z', 'UTC', 'year').toDay).toBe('2028-03-01');
    expect(win('2026-01-31T10:00:00Z', 'UTC', 'month').toDay).toBe('2026-03-02');
    expect(win('2026-12-31T23:59:59Z', 'UTC', 'week')).toMatchObject({ fromDay: '2026-12-31', toDay: '2027-01-06' });
  });

  it('a clock change inside the window does not move a boundary: the last day still ends at local midnight', () => {
    const spring = win('2027-03-25T12:00:00Z', 'Europe/London', 'week'); // clocks go forward on 28 March 2027
    expect(spring.toDay).toBe('2027-03-31');
    expect(spring.to).toBe(at('2027-03-31T23:59:59.999+01:00'));
    const us = win('2026-10-30T12:00:00Z', 'America/New_York', 'week'); // clocks go back on 1 November 2026
    expect(us.from).toBe(at('2026-10-30T00:00:00-04:00'));
    expect(us.to).toBe(at('2026-11-05T23:59:59.999-05:00'));
    const onTheDay = win('2026-10-25T00:30:00Z', 'Europe/London', 'week'); // 01:30 BST, the day the clocks go back
    expect(onTheDay.from).toBe(at('2026-10-25T00:00:00+01:00'));
  });

  it('a day whose clock change falls between the first guess and the true midnight still starts at the true midnight (Sydney, 4 October 2026)', () => {
    const w = win('2026-10-04T05:00:00Z', 'Australia/Sydney', 'week');
    expect(w.fromDay).toBe('2026-10-04');
    expect(w.from).toBe(at('2026-10-04T00:00:00+10:00'));
  });

  it('works for any time up to the limit and refuses the limit itself', () => {
    expect(horizonWindow(8e15, 'UTC', 'week').ok).toBe(true);
    expect(horizonWindow(8.64e15 - 5e10, 'UTC', 'week').ok).toBe(true);
    expect(horizonWindow(8.64e15 - 1, 'UTC', 'week').ok).toBe(false);
  });

  it('the first and last instants belong to the window: a minute before and after are outside', () => {
    const w = win('2026-10-22T09:30:00Z', 'UTC', 'week');
    expect(w.from).toBe(at('2026-10-22T00:00:00Z'));
    expect(w.to).toBe(at('2026-10-28T23:59:59.999Z'));
    expect(at('2026-10-21T23:59:59Z') < w.from).toBe(true);
    expect(at('2026-10-29T00:00:00Z') > w.to).toBe(true);
  });

  it('refuses a bad time, zone or horizon without throwing', () => {
    const bad = (now: unknown, zone: unknown, horizon: unknown) => horizonWindow(now as number, zone as string, horizon as Horizon);
    for (const r of [bad(-1, 'UTC', 'week'), bad(1.5, 'UTC', 'week'), bad('x', 'UTC', 'week'), bad(8.64e15, 'UTC', 'week'), bad(0, 'Not/AZone', 'week'), bad(0, '', 'week'), bad(0, 5, 'week'), bad(0, 'UTC', 'day'), bad(0, 'UTC', undefined)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CONFIG');
    }
    expect(horizonWindow(0, 'UTC', 'week').ok).toBe(true);
  });

  it('is the same answer every time for the same input', () => {
    expect(win('2026-10-22T09:30:00Z', 'Europe/London', 'month')).toEqual(win('2026-10-22T09:30:00Z', 'Europe/London', 'month'));
  });
});
