import { addDays, addMonths, daysBetween } from './dates.js';
import { DAYS_IN_YEAR, dec, toKobo } from './decimal.js';

/**
 * Months, or part months rounded up, from the day after the last fee period end
 * up to and including the determination date.
 */
export function monthsSince(lastFeePeriodEnd, determinationDate) {
  const start = addDays(lastFeePeriodEnd, 1);
  if (determinationDate < start) throw new Error('Determination date must be after the last fee period end');
  let m = 1;
  while (addMonths(start, m) <= determinationDate) m++;
  return m;
}

/**
 * Pro-rata management fee on termination (Clause 12). Both bases shown until one is confirmed:
 * - monthBasis: Clause 12 as written, (quarterly rate / 3) x NAV x m = annual rate / 12 x NAV x m
 * - dailyBasis: annual rate x NAV x days / 365, days counted inclusive of the determination date
 *
 * @param {{navAtDetermination: any, annualRate: any, lastFeePeriodEnd: string, determinationDate: string}} input
 */
export function terminationFee(input) {
  const nav = dec(input.navAtDetermination);
  const rate = dec(input.annualRate);
  const months = monthsSince(input.lastFeePeriodEnd, input.determinationDate);
  const days = daysBetween(input.lastFeePeriodEnd, input.determinationDate);
  return {
    months,
    monthBasis: toKobo(rate.div(12).times(nav).times(months)),
    days,
    dailyBasis: toKobo(rate.times(nav).times(days).div(DAYS_IN_YEAR)),
  };
}
