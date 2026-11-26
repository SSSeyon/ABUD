// Internal management report helpers: limit checks at each month end of a period, each judged against the limits
// in force on that date (Settings > Limits versions). Pure functions over the loaded data (testable).
import { addDays, addMonths, daysBetween, ZERO } from '../engine/index.js';
import { limitsFrom } from './alerts.js';
import { belowMinimum, counterpartyName, findCounterparty, ratingOn } from './counterparties.js';
import { holdingsOn, navSeries, TYPE_LABELS } from './portfolio.js';
import { fmtNaira } from './ui.js';

const FGN = new Set(['ntb', 'omo']);

/** Month ends from start to end (inclusive), plus end itself when it is not a month end. */
export function monthEnds(start, end) {
  const out = [];
  let d = addDays(addMonths(`${start.slice(0, 7)}-01`, 1), -1);
  while (d <= end) {
    if (d >= start) out.push(d);
    d = addDays(addMonths(`${addDays(d, 1).slice(0, 7)}-01`, 1), -1);
  }
  if (out.at(-1) !== end) out.push(end);
  return out;
}

/**
 * Limit breaches in a period: concentration, liquidity, idle cash and minimum rating at each month end, and any
 * deal struck in the period above the tenor limit then in force.
 * @returns {{date: string, limit: string, detail: string}[]}
 */
export function breachesBetween(data, start, end) {
  const rows = navSeries(data, end);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  for (const d of monthEnds(start, end)) {
    const row = byDate.get(d);
    if (!row || row.nav.lte(0)) continue;
    const lim = limitsFrom(data, d);
    const held = holdingsOn(data, d);
    const byCp = new Map();
    for (const { inst, value } of held) {
      if (FGN.has(inst.type)) continue;
      const name = counterpartyName(inst, data.funds);
      byCp.set(name, (byCp.get(name) ?? ZERO).plus(value));
    }
    for (const [name, value] of byCp) {
      const share = value.div(row.nav);
      if (share.gt(lim.concentrationShare)) out.push({ date: d, limit: 'Concentration', detail: `${name} ${pct(share)} of NAV (limit ${pct(lim.concentrationShare)})` });
      const cp = findCounterparty(data, name);
      const r = cp ? ratingOn(data, cp.id, d) : null;
      if (r && belowMinimum(r.rating, lim.minRating)) out.push({ date: d, limit: 'Minimum rating', detail: `${name} rated ${r.rating} (${r.agency}), minimum ${lim.minRating}` });
    }
    const horizon = addDays(d, Number(lim.liquidityDays));
    const liquid = held.filter((x) => x.inst.type === 'money_market_fund' || (x.inst.maturityDate && x.inst.maturityDate <= horizon)).reduce((t, x) => t.plus(x.value), row.cash);
    const liqShare = liquid.div(row.nav);
    if (liqShare.lt(lim.liquidityShare)) out.push({ date: d, limit: 'Liquidity buffer', detail: `${pct(liqShare)} of NAV liquid within ${lim.liquidityDays} days (minimum ${pct(lim.liquidityShare)})` });
    if (row.cash.gt(lim.idleCash)) out.push({ date: d, limit: 'Idle cash', detail: `${fmtNaira(row.cash)} uninvested at month end (limit ${fmtNaira(lim.idleCash)})` });
  }
  for (const i of data.instruments ?? []) {
    if (!i.maturityDate || i.valueDate < start || i.valueDate > end) continue;
    const lim = limitsFrom(data, i.valueDate);
    const tenor = daysBetween(i.valueDate, i.maturityDate);
    if (tenor > Number(lim.maxTenorDays)) out.push({ date: i.valueDate, limit: 'Tenor', detail: `${TYPE_LABELS[i.type]} with ${i.counterpartyName ?? ''}: ${tenor} days (limit ${lim.maxTenorDays})` });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
