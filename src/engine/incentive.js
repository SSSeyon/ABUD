import { ZERO, dec } from './decimal.js';

/**
 * Incentive fee: earned only when ARIP beats the hurdle; both clause readings computed, unrounded.
 * Clause 8 (billing default): rate x (ARIP - WATBR) x avg NAV.
 * Clause 12 (internal only):  rate x (ARIP - Hurdle) x avg NAV.
 *
 * @param {{arip: any, watbr: any, hurdle: any, avgNav: any, incentiveRate: any}} input Num values
 */
export function incentiveFee(input) {
  const arip = dec(input.arip);
  const hurdle = dec(input.hurdle);
  const hurdleMet = arip.gt(hurdle);
  if (!hurdleMet) return { hurdleMet, clause8: ZERO, clause12: ZERO };
  const rate = dec(input.incentiveRate);
  const nav = dec(input.avgNav);
  return {
    hurdleMet,
    clause8: rate.times(arip.minus(input.watbr)).times(nav),
    clause12: rate.times(arip.minus(hurdle)).times(nav),
  };
}
