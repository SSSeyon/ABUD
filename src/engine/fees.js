import { DAYS_IN_YEAR, dec, sum, toKobo } from './decimal.js';
import { quarterOf } from './dates.js';

/**
 * Daily management fee day count.
 * - 'act365': rate x NAV_t / 365 per calendar day (the plan's reading of Clause 8).
 * - 'quarterly': (rate / 4) / days in that calendar quarter x NAV_t per day, so every full quarter costs exactly
 *   a quarter of the annual rate on average NAV (how the MCM income sheet has billed since 2021).
 * @typedef {'act365'|'quarterly'} FeeDayCount
 */

/** Fraction of the annual rate charged for one day. @param {string} date @param {FeeDayCount} dayCount */
export function feeDayFraction(date, dayCount = 'act365') {
  if (dayCount === 'quarterly') return dec(1).div(4).div(quarterOf(date).days);
  return dec(1).div(DAYS_IN_YEAR);
}

/**
 * Clause 8 management fee accrued for each calendar day.
 * Rows must be consecutive calendar days in date order. Non-business days use the most recent
 * business day's NAV in the rows; if there is none yet, the day's own NAV.
 *
 * @param {{date: string, nav: import('./decimal.js').Dec}[]} rows
 * @param {import('./decimal.js').Num} annualRate
 * @param {import('./dates.js').BusinessCalendar} calendar
 * @param {FeeDayCount} [dayCount]
 */
export function managementFeeAccruals(rows, annualRate, calendar, dayCount = 'act365') {
  const rate = dec(annualRate);
  let lastBusinessNav;
  return rows.map((row) => {
    if (calendar.isBusinessDay(row.date)) lastBusinessNav = row.nav;
    const base = lastBusinessNav ?? row.nav;
    return { date: row.date, base, accrual: rate.times(base).times(feeDayFraction(row.date, dayCount)) };
  });
}

/**
 * Fee for the days from periodStart to periodEnd. Pass rows starting before periodStart
 * when available, so a period that opens on a weekend uses the prior business day's NAV.
 * Returns the unrounded total and the posted (kobo) amount.
 * @param {FeeDayCount} [dayCount]
 */
export function managementFeeForPeriod(rows, periodStart, periodEnd, annualRate, calendar, dayCount = 'act365') {
  const accruals = managementFeeAccruals(
    rows.filter((r) => r.date <= periodEnd),
    annualRate,
    calendar,
    dayCount,
  ).filter((a) => a.date >= periodStart);
  const total = sum(accruals.map((a) => a.accrual));
  return { accruals, total, posted: toKobo(total) };
}
