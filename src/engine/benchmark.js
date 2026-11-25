import { DAYS_IN_YEAR, ONE, dec, roundRate } from './decimal.js';

/** Convert a CBN NTB stop (discount) rate to a true yield: TY = d / (1 - d x tenor / 365). */
export function trueYieldFromDiscount(discountRate, tenorDays = 91) {
  const d = dec(discountRate);
  const denom = ONE.minus(d.times(tenorDays).div(DAYS_IN_YEAR));
  if (denom.lte(0)) throw new Error('Discount rate too high for tenor');
  return d.div(denom);
}

/**
 * De-annualise the benchmark for a period of `days` days:
 * WATBR_q = TY x D / 365; Hurdle_q = (TY + spread) x D / 365.
 * rateRoundingDp, when given, rounds both rates (as fractions) to that many decimal places,
 * e.g. 5 to match a worksheet that shows percentages to 3 dp. Default: full precision.
 */
export function periodRates(trueYield, hurdleSpread, days, rateRoundingDp) {
  if (days <= 0) throw new Error('days must be positive');
  const ty = dec(trueYield);
  const watbr = ty.times(days).div(DAYS_IN_YEAR);
  const hurdle = ty.plus(hurdleSpread).times(days).div(DAYS_IN_YEAR);
  if (rateRoundingDp === undefined) return { watbr, hurdle };
  return { watbr: roundRate(watbr, rateRoundingDp), hurdle: roundRate(hurdle, rateRoundingDp) };
}
