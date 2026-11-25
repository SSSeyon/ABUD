// All engine arithmetic uses this Decimal constructor: 40 significant digits, half-up rounding.
// Never use JavaScript floating point for money or rates.
import Decimal from 'https://cdn.jsdelivr.net/npm/decimal.js@10.4.3/decimal.mjs';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** @typedef {import('https://cdn.jsdelivr.net/npm/decimal.js@10.4.3/decimal.mjs').default} Dec */
/** Inputs may be Decimals, decimal strings ("0.0075") or integers. @typedef {Dec|string|number} Num */

/** @param {Num} x */
export const dec = (x) => new D(x);
export const ZERO = new D(0);
export const ONE = new D(1);
export const DAYS_IN_YEAR = new D(365);

/** Round a naira amount to the kobo (2 dp, half up). Used only when an amount posts. @param {Num} x */
export function toKobo(x) {
  return new D(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Round a rate (a fraction) to a number of decimal places. @param {Num} x @param {number} dp */
export function roundRate(x, dp) {
  return new D(x).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** @param {Iterable<Dec>} xs */
export function sum(xs) {
  let total = ZERO;
  for (const x of xs) total = total.plus(x);
  return total;
}
