import { DAYS_IN_YEAR, dec, sum, toKobo } from './decimal.js';

/**
 * Clause 8 management fee: rate x NAV_t / 365 for each calendar day.
 * Rows must be consecutive calendar days in date order. Non-business days use the most recent
 * business day's NAV in the rows; if there is none yet, the day's own NAV.
 *
 * @param {{date: string, nav: import('./decimal.js').Dec}[]} rows
 * @param {import('./decimal.js').Num} annualRate
 * @param {import('./dates.js').BusinessCalendar} calendar
 */
export function managementFeeAccruals(rows, annualRate, calendar) {
  const rate = dec(annualRate);
  let lastBusinessNav;
  return rows.map((row) => {
    if (calendar.isBusinessDay(row.date)) lastBusinessNav = row.nav;
    const base = lastBusinessNav ?? row.nav;
    return { date: row.date, base, accrual: rate.times(base).div(DAYS_IN_YEAR) };
  });
}

/**
 * Fee for the days from periodStart to periodEnd. Pass rows starting before periodStart
 * when available, so a period that opens on a weekend uses the prior business day's NAV.
 * Returns the unrounded total and the posted (kobo) amount.
 */
export function managementFeeForPeriod(rows, periodStart, periodEnd, annualRate, calendar) {
  const accruals = managementFeeAccruals(
    rows.filter((r) => r.date <= periodEnd),
    annualRate,
    calendar,
  ).filter((a) => a.date >= periodStart);
  const total = sum(accruals.map((a) => a.accrual));
  return { accruals, total, posted: toKobo(total) };
}
