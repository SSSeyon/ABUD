// Alerts from the build plan, computed live from the data (no Firebase here, so they are testable).
// Each alert clears by itself once the condition is resolved (maturity recorded, cash invested, limit met).
import { addDays, BusinessCalendar, daysBetween, dec, quarterOf, ZERO } from '../engine/index.js';
import { fmtNaira } from './ui.js';
import { closedInstrumentIds, expectedMaturityValue, holdingsOn, navSeries, TYPE_LABELS } from './portfolio.js';
import { benchmarkFor, completedQuarters } from './close.js';
import { feedHealth, marketEvents } from './market.js';
import { payoutSchedule } from './payout.js';
import { ratingAlerts } from './counterparties.js';

/** Defaults until Settings > Limits is saved. Money as strings, shares as fractions. */
export const DEFAULT_LIMITS = Object.freeze({
  idleCash: '10000000.00', // naira uninvested...
  idleDays: '2', // ...for more than this many business days
  liquidityShare: '0.10', // cash plus holdings maturing within liquidityDays, as a share of NAV
  liquidityDays: '30',
  concentrationShare: '0.25', // largest counterparty as a share of NAV
  maxTenorDays: '364', // longest new deal allowed
  maturityWarnDays: '14',
  minRating: 'BBB', // lowest counterparty rating for new deals (confirmed 26 Nov 2026); FGN paper exempt
});

/**
 * Limits in force on a date (default today): the latest Settings > Limits version effective on or before it
 * (limitSets, one per change), else the single saved settings/limits document, else the plan's defaults.
 */
export function limitsFrom(data, date) {
  const on = date ?? new Date().toISOString().slice(0, 10);
  const versions = (data.limitSets ?? []).filter((v) => v.effectiveFrom && v.effectiveFrom <= on).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const saved = versions[0] ?? (data.settings ?? []).find((d) => d.id === 'limits') ?? {};
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) if (saved[k] != null && saved[k] !== '') out[k] = String(saved[k]);
  return out;
}

/** Who a holding's money sits with: the bank or issuer, or for a fund its manager. */
export function counterpartyOf(inst, funds = []) {
  if (inst.type === 'money_market_fund') return funds.find((f) => f.id === inst.fundId)?.managerName ?? inst.counterpartyName ?? 'Fund';
  return inst.counterpartyName || TYPE_LABELS[inst.type];
}

const fmtM = (x) => fmtNaira(x);
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
    alerts.push({ key: `qe-${q.label}`, level: 'medium', title: `Quarter end in ${bdLeft} business day${bdLeft === 1 ? '' : 's'}: ${q.label}`, detail: 'Check the benchmark, then run the fee and incentive calculation and prepare the statement (Quarter close).', route: 'close', sort: q.end });
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

  // Quarter close and market data (only once those collections have loaded).
  if (Array.isArray(data.auctions) && (data.transactions ?? []).length && !benchmarkFor(data, q.label)) {
    alerts.push({ key: `bench-${q.label}`, level: 'high', title: `Benchmark missing for ${q.label}`, detail: `No 91-day NTB auction before ${q.start} is stored, so the hurdle can't be set. Add it on the Market screen.`, route: 'market', sort: q.start });
  }
  if (Array.isArray(data.quarterlyResults)) {
    const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
    const lastQ = completedQuarters(inception, today)[0];
    if (lastQ && !data.quarterlyResults.some((r) => r.id === lastQ.label)) {
      alerts.push({ key: `close-${lastQ.label}`, level: 'medium', title: `${lastQ.label} not closed yet`, detail: 'Lock the benchmark, run the fee and incentive calculation and issue the statement (Quarter close).', route: 'close', sort: lastQ.end });
    }
    // Access's mandate: each closed quarter's income (net of MBO fees) is paid out to them.
    for (const s of payoutSchedule(data, today)) {
      if (!s.closed || s.outstanding.lte('0.5')) continue;
      const days = daysBetween(s.end, today);
      alerts.push({ key: `payout-${s.quarter}-${s.outstanding.toFixed(0)}`, level: days > 14 ? 'high' : 'medium', title: `Income payout due to Access: ${s.quarter}`,
        detail: `${fmtM(s.outstanding)} outstanding (income ${fmtM(s.income)} less MBO fees ${fmtM(s.fees)}${s.paid.isZero() ? '' : `, ${fmtM(s.paid)} paid`}). Record it on Quarter close.`, route: 'close', sort: s.end });
    }
  }
  if (Array.isArray(data.feedStatus)) {
    const feeds = feedHealth(data, today);
    if (feeds.every((f) => f.status === 'never')) {
      alerts.push({ key: 'feeds-never', level: 'low', title: 'Market feeds have not run yet', detail: 'Auction, MPC and CP data come from a scheduled job (see Market). Until it runs, add results by hand.', route: 'market', sort: today });
    } else {
      for (const f of feeds.filter((x) => x.status === 'stale' || x.status === 'failing')) {
        alerts.push({ key: `feed-${f.key}`, level: 'medium', title: `Market feed ${f.status === 'failing' ? 'failing' : 'stale'}: ${f.label}`, detail: f.status === 'failing' ? `Last error: ${f.doc?.lastError ?? 'unknown'}. Add data by hand on the Market screen until it is fixed.` : `Last updated ${f.lastOk}. Check the scheduled job, or add data by hand.`, route: 'market', sort: f.lastOk ?? today });
      }
    }
    for (const e of marketEvents(data, today)) alerts.push({ key: e.key, level: 'low', title: e.title, detail: e.detail, route: 'market', sort: e.date });
  }

  // Counterparty ratings (once the register has loaded).
  alerts.push(...ratingAlerts(data, today, limits.minRating));

  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level] || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
}
