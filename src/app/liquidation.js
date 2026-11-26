// Partial liquidation of a fixed deposit: on a date before maturity the deposit is broken, the amount needed is
// taken out together with the bank's early-termination penalty, and the balance is placed again at the same rate
// for the rest of the original term (same maturity date). No Firebase here, so it is testable.
import { daysBetween, dec, DAYS_IN_YEAR, toKobo, ZERO } from '../engine/index.js';

export const PENALTY_BASES = [
  { value: 'interest_pct', label: '% of the interest earned on the part taken out' },
  { value: 'amount_pct', label: '% of the amount taken out' },
  { value: 'fixed', label: 'Fixed amount (₦)' },
  { value: 'none', label: 'No penalty' },
];

/**
 * @param {{cost: string, rate: string, valueDate: string, maturityDate: string}} inst the deposit
 * @param {{date: string, amount: string, penaltyBasis: string, penaltyValue?: string}} req penaltyValue: a fraction
 *   for the % bases, naira for 'fixed'
 * @returns {{ days: number, accrued: any, gross: any, amount: any, share: any, penalty: any, proceeds: any, balance: any,
 *   remainingDays: number, maturityValue: any }}
 *   gross = principal + interest to the date; proceeds = gross − penalty (what the bank pays when breaking it);
 *   balance = proceeds − amount (placed again to the original maturity at the same rate).
 */
export function partialLiquidationPlan(inst, { date, amount, penaltyBasis, penaltyValue }) {
  if (!date) throw new Error('Choose the liquidation date.');
  if (date <= inst.valueDate) throw new Error('The liquidation date must be after the value date.');
  if (date >= inst.maturityDate) throw new Error('On or after maturity this is a maturity, not a partial liquidation.');
  const principal = dec(inst.cost);
  const days = daysBetween(inst.valueDate, date);
  const accrued = principal.times(inst.rate).times(days).div(DAYS_IN_YEAR);
  const gross = toKobo(principal.plus(accrued));
  const out = toKobo(amount);
  if (out.lte(0)) throw new Error('Enter the amount needed.');
  const share = out.div(gross);
  let penalty = ZERO;
  if (penaltyBasis === 'interest_pct') penalty = accrued.times(share).times(penaltyValue ?? 0);
  else if (penaltyBasis === 'amount_pct') penalty = out.times(penaltyValue ?? 0);
  else if (penaltyBasis === 'fixed') penalty = dec(penaltyValue ?? 0);
  penalty = toKobo(penalty);
  const proceeds = gross.minus(penalty);
  const balance = proceeds.minus(out);
  if (balance.lte(0)) throw new Error('The amount needed and the penalty take the whole deposit: record a full early maturity instead.');
  const remainingDays = daysBetween(date, inst.maturityDate);
  const maturityValue = toKobo(balance.plus(balance.times(inst.rate).times(remainingDays).div(DAYS_IN_YEAR)));
  return { days, accrued: toKobo(accrued), gross, amount: out, share, penalty, proceeds, balance, remainingDays, maturityValue };
}
