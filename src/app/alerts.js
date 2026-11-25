// Alerts from the build plan, computed live from the data (no Firebase here, so they are testable).
// Each alert clears by itself once the condition is resolved (maturity recorded, cash invested, limit met).
import { addDays, BusinessCalendar, daysBetween, dec, quarterOf, ZERO } from '../engine/index.js';
import { closedInstrumentIds, expectedMaturityValue, holdingsOn, navSeries, TYPE_LABELS } from './portfolio.js';

/** Defaults until Settings > Limits is saved. Money as strings, shares as fractions. */
export const DEFAULT_LIMITS = Object.freeze({
  idleCash: '10000000.00', // naira uninvested...
  idleDays: '2', // ...for more than this many business days
  liquidityShare: '0.10', // cash plus holdings maturing within liquidityDays, as a share of NAV
  liquidityDays: '30',
  concentrationShare: '0.25', // largest counterparty as a share of NAV
  maxTenorDays: '364', // longest new deal allowed
  maturityWarnDays: '14',
});

export function limitsFrom(data) {
  const saved = (data.settings ?? []).find((d) => d.id === 'limits') ?? {};
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) if (saved[k] != null && saved[k] !== '') out[k] = String(saved[k]);
  return out;
}

/** Who a holding's money sits with: the bank or issuer, or for a fund its manager. */
export function counterpartyOf(inst, funds = []) {
  if (inst.type === 'money_market_fund') return funds.find((f) => f.id === inst.fundId)?.managerName ?? inst.counterpartyName ?? 'Fund';
  return inst.counterpartyName || TYPE_LABELS[inst.type];
}

const fmtM = (x) => `₦${Number(dec(x).div(1e6).toFixed(1)).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}m`;
const pct = (x) => `${dec(x).times(100).toFixed(1)}%`;

/**
 * @returns {{key: string, level: 'high'|'medium'|'low', title: string, detail: string, route: string, instId?: string}[]}
 * Sorted high first, then by date.
 */
export function computeAlerts(data, today, limits = limitsFrom(data)) {
  const alerts = [];
  const closed = closedInstrumentIds(data.transactions);
  const cal = new BusinessCalendar();

  // Maturities: matured with nothing recorded, and due within the warning window (flagged at 14, 7 and 1 days).
  const warn = Number(limits.maturityWarnDays);
  for (const i of data.instruments ?? []) {
    if (i.type === 'money_market_fund' || !i.maturityDate || closed.has(i.id)) continue;
    const days = daysBetween(today, i.maturityDate);
    const amount = expectedMaturityValue(i);
    const who = `${TYPE_LABELS[i.type]} with ${i.counterpartyName ?? ''}`;
    if (days < 0) {
      alerts.push({ key: `matured-${i.id}`, level: 'high', title: `Matured, not actioned: ${who}`, detail: `Matured ${-days} day${days === -1 ? '' : 's'} ago (${i.maturityDate}); ${fmtM(amount)} expected. Record the maturity or roll it over.`, route: 'holdings', instId: i.id, sort: i.maturityDate });
    } else if (days <= warn) {
      const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
      alerts.push({ key: `due-${i.id}`, level: days <= 1 ? 'high' : days <= 7 ? 'medium' : 'low', title: `Matures ${when}: ${who}`, detail: `${fmtM(amount)} due on ${i.maturityDate}. Plan the reinvestment.`, route: 'holdings', instId: i.id, sort: i.maturityDate });
    }
  }

  const rows = (() => { try { return navSeries(data, today); } catch { return []; } })();
  const last = rows.at(-1);
  if (last && last.nav.gt(0)) {
    // Idle cash: above the threshold at the end of every business day for more than idleDays business days.
    const limit = dec(limits.idleCash);
    let businessDays = 0;
    let since = null;
    for (let k = rows.length - 1; k >= 0 && rows[k].cash.gt(limit); k--) {
      if (cal.isBusinessDay(rows[k].date)) businessDays += 1;
      since = rows[k].date;
    }
    if (businessDays > Number(limits.idleDays)) {
      alerts.push({ key: 'idle-cash', level: 'high', title: `Idle cash: ${fmtM(last.cash)} uninvested`, detail: `Above the ${fmtM(limit)} limit since ${since} (${businessDays} business days). Cash to deploy: ${fmtM(last.cash.minus(limit))}.`, route: 'holdings', sort: since });
    }

    // Liquidity buffer and counterparty concentration, on today's holdings.
    let held = [];
    try { held = holdingsOn(data, today); } catch { held = []; }
    const horizon = addDays(today, Number(limits.liquidityDays));
    const liquid = held.filter((x) => x.inst.type === 'money_market_fund' || (x.inst.maturityDate && x.inst.maturityDate <= horizon)).reduce((t, x) => t.plus(x.value), last.cash);
    const liqShare = liquid.div(last.nav);
    if (liqShare.lt(limits.liquidityShare)) {
      alerts.push({ key: 'liquidity', level: 'high', title: `Liquidity buffer low: ${pct(liqShare)} of NAV`, detail: `Cash, funds and holdings maturing within ${limits.liquidityDays} days come to ${fmtM(liquid)}; the minimum is ${pct(limits.liquidityShare)} of NAV.`, route: 'ladder', sort: today });
    }
    const byCp = new Map();
    for (const x of held) {
      const cp = counterpartyOf(x.inst, data.funds);
      byCp.set(cp, (byCp.get(cp) ?? ZERO).plus(x.value));
    }
    for (const [cp, value] of byCp) {
      const share = value.div(last.nav);
      if (share.gt(limits.concentrationShare)) {
        alerts.push({ key: `conc-${cp}`, level: 'high', title: `Concentration: ${cp} is ${pct(share)} of NAV`, detail: `${fmtM(value)} with ${cp}, above the ${pct(limits.concentrationShare)} limit.`, route: 'holdings', sort: today });
      }
    }
  }

  // Tenor: any open deal longer than the limit (new ones are blocked at entry).
  for (const i of data.instruments ?? []) {
    if (!i.maturityDate || closed.has(i.id)) continue;
    const tenor = daysBetween(i.valueDate, i.maturityDate);
    if (tenor > Number(limits.maxTenorDays)) {
      alerts.push({ key: `tenor-${i.id}`, level: 'medium', title: `Tenor above limit: ${TYPE_LABELS[i.type]} with ${i.counterpartyName ?? ''}`, detail: `${tenor} days, above the ${limits.maxTenorDays}-day limit.`, route: 'holdings', instId: i.id, sort: i.maturityDate });
    }
  }

  // Quarter-end tasks: from 5 business days before quarter end.
  const q = quarterOf(today);
  let bdLeft = 0;
  for (let d = today; d <= q.end; d = addDays(d, 1)) if (cal.isBusinessDay(d)) bdLeft += 1;
  if (bdLeft <= 5) {
    alerts.push({ key: `qe-${q.label}`, level: 'medium', title: `Quarter end in ${bdLeft} business day${bdLeft === 1 ? '' : 's'}: ${q.label}`, detail: 'Run the fee and incentive test and prepare the quarter statement (Reports).', route: 'reports', sort: q.end });
  }

  // Mandate renewal window: 60 and 45 days before the anniversary (30-day notice).
  const terms = [...(data.mandateTerms ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  if (terms?.anniversary) {
    let next = `${today.slice(0, 4)}${terms.anniversary.slice(4)}`;
    if (next < today) next = `${Number(today.slice(0, 4)) + 1}${terms.anniversary.slice(4)}`;
    const days = daysBetween(today, next);
    if (days <= 60) {
      alerts.push({ key: `renewal-${next}`, level: days <= 45 ? 'medium' : 'low', title: `Mandate anniversary in ${days} days (${next})`, detail: `The 30-day notice deadline is ${addDays(next, -30)}.`, route: 'settings', sort: next });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level] || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
}
