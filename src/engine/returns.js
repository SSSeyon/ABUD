import { ONE, ZERO, dec, sum } from './decimal.js';

/**
 * r_t = (NAV_t - NAV_{t-1} - F_t) / NAV_{t-1}, flows at end of day.
 * prevNav is the NAV at the end of the day before the first row. A day that starts with
 * zero NAV (inception) has no capital at risk and returns 0.
 *
 * @param {{date: string, nav: import('./decimal.js').Dec, netFlow: import('./decimal.js').Dec}[]} rows
 * @param {import('./decimal.js').Num} prevNav
 */
export function dailyReturns(rows, prevNav) {
  let prev = dec(prevNav);
  return rows.map((row) => {
    const r = prev.isZero() ? ZERO : row.nav.minus(prev).minus(row.netFlow).div(prev);
    prev = row.nav;
    return { date: row.date, r };
  });
}

/** ARIP for the period: daily time-weighted, gross of fees. ARIP = prod(1 + r_t) - 1. */
export function timeWeightedReturn(rows, prevNav) {
  let growth = ONE;
  for (const { r } of dailyReturns(rows, prevNav)) growth = growth.times(ONE.plus(r));
  return growth.minus(ONE);
}

/** Average daily NAV over the rows (calendar days). */
export function averageNav(rows) {
  if (rows.length === 0) throw new Error('averageNav needs at least one row');
  return sum(rows.map((r) => r.nav)).div(rows.length);
}
