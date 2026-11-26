// Money flows for a period, for the Sankey chart: where the money came from (opening NAV, inflows from Access,
// income by asset class) and where it went (withdrawals, fees, losses, closing value by asset class).
// Both sides add up: opening + inflows + income = withdrawals + fees + closing NAV.
import { ZERO } from '../engine/index.js';

const SHORT = { ntb: 'Bills', commercial_paper: 'CP', fixed_deposit: 'Fixed dep.', call_deposit: 'Calls', money_market_fund: 'Funds', omo: 'OMO', cash: 'Cash' };
const NEUTRAL = { opening: 'var(--slate)', inflows: 'var(--access-navy)', withdrawals: '#8b8c90', fees: '#b5b6ba', losses: 'var(--down)' };

/** @param {ReturnType<import('./portfolio.js').periodReport>} r */
export function periodFlows(r) {
  const left = [
    { label: 'Opening NAV', short: 'Opening', value: r.openingNav, color: NEUTRAL.opening },
    { label: 'Inflows from Access', short: 'Inflows', value: r.inflows, color: NEUTRAL.inflows },
  ];
  const right = [
    { label: 'Withdrawals', short: 'Withdrawn', value: r.withdrawals, color: NEUTRAL.withdrawals },
    { label: 'Fees and charges', short: 'Fees', value: r.fees, color: NEUTRAL.fees },
  ];
  let losses = ZERO;
  for (const c of r.classes) {
    if (c.income.gt('0.5')) left.push({ label: `Income: ${c.label.toLowerCase()}`, short: `+${SHORT[c.key] ?? c.label}`, value: c.income, color: `var(--class-${c.key})` });
    else if (c.income.lt('-0.5')) losses = losses.plus(c.income.neg());
  }
  if (losses.gt('0.5')) right.push({ label: 'Losses', value: losses, color: NEUTRAL.losses });
  for (const c of r.classes) if (c.closing.gt('0.5')) right.push({ label: `Closing: ${c.label.toLowerCase()}`, short: SHORT[c.key] ?? c.label, value: c.closing, color: `var(--class-${c.key})` });
  return { left, right };
}
