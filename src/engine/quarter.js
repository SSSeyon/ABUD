import { addDays, daysBetween } from './dates.js';
import { dec, roundRate, toKobo } from './decimal.js';
import { periodRates, trueYieldFromDiscount } from './benchmark.js';
import { managementFeeForPeriod } from './fees.js';
import { incentiveFee } from './incentive.js';
import { averageNav, timeWeightedReturn } from './returns.js';

/**
 * Quarter (or stub period) close: management fee, ARIP, hurdle test and both incentive readings.
 *
 * @param {object} input
 * @param {string} input.periodStart
 * @param {string} input.periodEnd
 * @param {import('./nav.js').DailyNavRow[]} input.navRows Consecutive daily rows covering the period. Include the
 *   day before periodStart (its NAV opens the return calculation) and ideally the prior business day too.
 * @param {import('./types.js').MandateTerms} input.terms
 * @param {{trueYield: any} | {discountRate: any, tenorDays?: number}} input.benchmark
 * @param {import('./dates.js').BusinessCalendar} input.calendar
 * @param {number} [input.rateRoundingDp] Round ARIP, WATBR and hurdle before the incentive step
 *   (5 matches a worksheet showing percentages to 3 dp). Default: full precision.
 */
export function closePeriod(input) {
  const { periodStart, periodEnd, navRows, terms, calendar } = input;
  const days = daysBetween(periodStart, periodEnd) + 1;
  if (days <= 0) throw new Error('periodEnd must not be before periodStart');

  const inPeriod = navRows.filter((r) => r.date >= periodStart && r.date <= periodEnd);
  if (inPeriod.length !== days) {
    throw new Error(`NAV rows cover ${inPeriod.length} of ${days} days from ${periodStart} to ${periodEnd}`);
  }
  const dayBefore = navRows.find((r) => r.date === addDays(periodStart, -1));
  const prevNav = dayBefore ? dayBefore.nav : 0;

  const trueYield =
    'trueYield' in input.benchmark
      ? dec(input.benchmark.trueYield)
      : trueYieldFromDiscount(input.benchmark.discountRate, input.benchmark.tenorDays);

  const fee = managementFeeForPeriod(navRows, periodStart, periodEnd, terms.mgmtFeeRate, calendar, terms.feeDayCount ?? 'act365');
  let arip = timeWeightedReturn(inPeriod, prevNav);
  if (input.rateRoundingDp !== undefined) arip = roundRate(arip, input.rateRoundingDp);
  const { watbr, hurdle } = periodRates(trueYield, terms.hurdleSpread, days, input.rateRoundingDp);
  const avgNav = averageNav(inPeriod);
  const incentive = incentiveFee({ arip, watbr, hurdle, avgNav, incentiveRate: terms.incentiveRate });

  return {
    periodStart,
    periodEnd,
    days,
    trueYield,
    arip,
    watbr,
    hurdle,
    avgNav,
    hurdleMet: incentive.hurdleMet,
    mgmtFee: fee.posted,
    incentiveClause8: toKobo(incentive.clause8),
    incentiveClause12: toKobo(incentive.clause12),
    unrounded: { mgmtFee: fee.total, incentiveClause8: incentive.clause8, incentiveClause12: incentive.clause12 },
  };
}
