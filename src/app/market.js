// Market data and the opportunity engine: the latest auction, MPC and CP data, the events worth flagging, and a
// ranked shortlist of where idle cash could go. Fixed rules from the build plan; the team decides.
// Pure functions over the loaded data, so they are testable. No portfolio data leaves the app.
import { addDays, daysBetween, dec, DAYS_IN_YEAR, ONE, ZERO } from '../engine/index.js';
import { counterpartyOf } from './alerts.js';
import { auctionYield, ntb91 } from './close.js';
import { DEPOSIT_TYPES, holdingsOn, mandateOn, navSeries } from './portfolio.js';

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
/** Standard tenor bucket (CBN writes 90/91, 181/182, 363/364/365). OMO bills come in many odd tenors, so they
 * are grouped into up-to-3, 6 and 12-month bands. */
export function tenorBucket(days, kind = 'ntb') {
  const d = Number(days);
  if (kind === 'omo') return d <= 100 ? 91 : d <= 200 ? 182 : 364;
  if (d >= 85 && d <= 95) return 91;
  if (d >= 175 && d <= 190) return 182;
  if (d >= 355 && d <= 370) return 364;
  return d;
}

/** Latest auction per tenor for a kind (ntb or omo), with the change in stop rate against the one before. */
export function latestByTenor(data, kind) {
  const groups = new Map();
  for (const a of (data.auctions ?? []).filter((x) => x.kind === kind).sort(byDateDesc)) {
    const t = tenorBucket(a.tenorDays, kind);
    const g = groups.get(t) ?? groups.set(t, []).get(t);
    if (g.length < 2) g.push(a);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([tenor, [last, prev]]) => ({
    tenor, auction: last, trueYield: auctionYield(last),
    changeBps: prev ? dec(last.stopRate).minus(prev.stopRate).times(10000) : null, previous: prev ?? null,
  }));
}

/** MPC decisions, newest first, each with the change in MPR against the one before. */
export function mpcHistory(data) {
  const list = [...(data.mpc ?? [])].sort(byDateDesc);
  return list.map((m, i) => ({ ...m, changeBps: list[i + 1] ? dec(m.mpr).minus(list[i + 1].mpr).times(10000) : null }));
}

/** The hurdle in force today, annual: latest 91-day NTB true yield plus the mandate's spread. */
export function currentHurdle(data, today) {
  const last = ntb91(data).find((a) => a.date <= today);
  if (!last) return null;
  const spread = dec(mandateOn(data, today)?.hurdleSpread ?? '0.02');
  const ty = auctionYield(last);
  return { trueYield: ty, spread, hurdle: ty.plus(spread), auction: last };
}

/** Simple annual yield of a holding (Actual/365), or null when it can't be told. */
export function holdingYield(inst, data) {
  if (DEPOSIT_TYPES.has(inst.type)) return inst.rate ? dec(inst.rate) : null;
  if (inst.type === 'money_market_fund') {
    const fund = (data.funds ?? []).find((f) => f.id === inst.fundId);
    if ((fund?.pricingBasis ?? inst.pricingBasis) !== 'yield') return null;
    const p = (data.fundPrices ?? []).filter((x) => x.fundId === inst.fundId).sort(byDateDesc)[0];
    return p ? dec(p.priceOrYield) : null;
  }
  const t = daysBetween(inst.valueDate, inst.maturityDate);
  if (!inst.faceValue || !inst.cost || t <= 0) return null;
  return dec(inst.faceValue).div(inst.cost).minus(ONE).times(DAYS_IN_YEAR).div(t);
}

/** Value-weighted yield of what is held today. */
export function runningYield(data, today) {
  let held = [];
  try { held = holdingsOn(data, today); } catch { return null; }
  let w = ZERO;
  let total = ZERO;
  for (const x of held) {
    const y = holdingYield(x.inst, data);
    if (y == null) continue;
    w = w.plus(y.times(x.value));
    total = total.plus(x.value);
  }
  return total.isZero() ? null : w.div(total);
}

/**
 * Ranked reinvestment options.
 * Universe: latest NTB and OMO auctions (last 30 days), confirmed CP quotations (last 60 days), and indicative
 * deposit rates from the portfolio's own deals with each bank in the last 90 days (bank rates are not captured).
 * Rules: tenor within the limit; per-counterparty headroom under the concentration limit (FGN paper exempt);
 * the liquidity buffer kept for anything longer than the buffer horizon. Ranked by pick-up over the hurdle, then
 * by pick-up over the portfolio's running yield.
 * @returns {{ranked: object[], rejected: object[], cashToDeploy, hurdle, running, nav}}
 */
export function rankOpportunities(data, today, limits) {
  const rows = (() => { try { return navSeries(data, today); } catch { return []; } })();
  const last = rows.at(-1);
  const nav = last?.nav ?? ZERO;
  const cash = last?.cash ?? ZERO;
  const cashToDeploy = cash.minus(limits.idleCash).gt(0) ? cash.minus(limits.idleCash) : ZERO;
  const hurdle = currentHurdle(data, today);
  const running = runningYield(data, today);

  let held = [];
  try { held = holdingsOn(data, today); } catch { held = []; }
  const exposure = new Map();
  for (const x of held) {
    const cp = counterpartyOf(x.inst, data.funds);
    exposure.set(cp, (exposure.get(cp) ?? ZERO).plus(x.value));
  }
  const horizon = addDays(today, Number(limits.liquidityDays));
  const liquid = held.filter((x) => x.inst.type === 'money_market_fund' || (x.inst.maturityDate && x.inst.maturityDate <= horizon)).reduce((t, x) => t.plus(x.value), cash);
  const liquidSpare = liquid.minus(nav.times(limits.liquidityShare));

  const candidates = [];
  for (const kind of ['ntb', 'omo']) {
    for (const l of latestByTenor(data, kind)) {
      if (daysBetween(l.auction.date, today) > 30) continue;
      candidates.push({ key: `${kind}-${l.tenor}`, type: kind, counterparty: 'FGN', sovereign: true, label: `${kind === 'ntb' ? 'NTB' : 'OMO bill'} ${l.auction.tenorDays}-day`, tenorDays: Number(l.auction.tenorDays), yield: l.trueYield, source: `CBN auction ${l.auction.date}, stop ${dec(l.auction.stopRate).times(100).toFixed(2)}%`, date: l.auction.date });
    }
  }
  for (const q of data.cpQuotes ?? []) {
    if (!q.confirmed || !q.yield || !q.tenorDays || daysBetween(q.date, today) > 60) continue;
    candidates.push({ key: `cp-${q.id}`, type: 'commercial_paper', counterparty: q.issuer, label: `CP: ${q.issuer}${q.rating ? ` (${q.rating})` : ''}`, tenorDays: Number(q.tenorDays), yield: dec(q.yield), source: `FMDQ quotation ${q.date}`, date: q.date });
  }
  const recent = new Map();
  for (const i of data.instruments ?? []) {
    if (!DEPOSIT_TYPES.has(i.type) || !i.rate || daysBetween(i.valueDate, today) > 90 || i.valueDate > today) continue;
    const prev = recent.get(i.counterpartyName);
    if (!prev || prev.valueDate < i.valueDate) recent.set(i.counterpartyName, i);
  }
  for (const i of recent.values()) {
    candidates.push({ key: `dep-${i.counterpartyName}`, type: i.type, counterparty: i.counterpartyName, label: `${i.type === 'call_deposit' ? 'Call' : 'Fixed deposit'}: ${i.counterpartyName}`, tenorDays: daysBetween(i.valueDate, i.maturityDate), yield: dec(i.rate), source: `Indicative: last deal ${i.valueDate}`, date: i.valueDate, indicative: true });
  }

  const ranked = [];
  const rejected = [];
  for (const c of candidates) {
    const notes = [];
    if (c.tenorDays > Number(limits.maxTenorDays)) { rejected.push({ ...c, reason: `Tenor ${c.tenorDays} days is over the ${limits.maxTenorDays}-day limit` }); continue; }
    let amount = cashToDeploy;
    let headroom = null;
    if (!c.sovereign) {
      headroom = nav.times(limits.concentrationShare).minus(exposure.get(c.counterparty) ?? ZERO);
      if (headroom.lte(0)) { rejected.push({ ...c, reason: `${c.counterparty} is already at the ${dec(limits.concentrationShare).times(100).toFixed(0)}% concentration limit` }); continue; }
      if (headroom.lt(amount)) { amount = headroom; notes.push('limited by concentration'); }
    }
    if (c.tenorDays > Number(limits.liquidityDays)) {
      const cap = liquidSpare.gt(0) ? liquidSpare : ZERO;
      if (cap.lt(amount)) { amount = cap; notes.push('limited by the liquidity buffer'); }
    }
    ranked.push({
      ...c, amount, headroom, notes,
      pickup: hurdle ? c.yield.minus(hurdle.hurdle) : null,
      overRunning: running ? c.yield.minus(running) : null,
    });
  }
  ranked.sort((a, b) => (b.pickup ?? b.yield).minus(a.pickup ?? a.yield).toNumber() || (b.overRunning ?? ZERO).minus(a.overRunning ?? ZERO).toNumber());
  return { ranked, rejected, cashToDeploy, hurdle, running, nav };
}

/** Notable market events: NTB stop moves over 25 bps, new CP quotations, MPR changes (last 14 days). */
export function marketEvents(data, today) {
  const out = [];
  const recentDays = 14;
  for (const l of latestByTenor(data, 'ntb')) {
    if (l.changeBps == null || l.changeBps.abs().lte(25) || daysBetween(l.auction.date, today) > recentDays) continue;
    const up = l.changeBps.gt(0);
    out.push({ key: `ntb-move-${l.auction.id}`, date: l.auction.date, title: `NTB ${l.tenor}-day stop rate ${up ? 'up' : 'down'} ${l.changeBps.abs().toFixed(0)} bps to ${dec(l.auction.stopRate).times(100).toFixed(2)}%`,
      detail: l.tenor === 91 ? `The 91-day rate sets next quarter's hurdle: ${up ? 'a higher' : 'a lower'} hurdle if it holds to quarter end.` : `${up ? 'Better' : 'Lower'} yields for new bills at this tenor.` });
  }
  for (const q of data.cpQuotes ?? []) {
    if (daysBetween(q.date, today) > recentDays) continue;
    out.push({ key: `cp-${q.id}`, date: q.date, title: `New CP quotation: ${q.issuer || q.title}`, detail: q.confirmed ? `Confirmed: ${q.yield ? `${dec(q.yield).times(100).toFixed(2)}%` : 'yield not set'}${q.tenorDays ? `, ${q.tenorDays} days` : ''}.` : 'Needs yield, tenor and rating before it counts as an option (Market screen).' });
  }
  const mpc = mpcHistory(data)[0];
  if (mpc && mpc.changeBps && !mpc.changeBps.isZero() && daysBetween(mpc.date, today) <= 30) {
    const up = mpc.changeBps.gt(0);
    out.push({ key: `mpc-${mpc.id}`, date: mpc.date, title: `MPR ${up ? 'raised' : 'cut'} ${mpc.changeBps.abs().toFixed(0)} bps to ${dec(mpc.mpr).times(100).toFixed(2)}%`, detail: `Expect ${up ? 'higher' : 'lower'} NTB and deposit rates, and so a ${up ? 'higher' : 'lower'} hurdle from next quarter.` });
  }
  return out.sort(byDateDesc);
}

/** Feeds the scheduled job writes, and how many days old each may get before it is stale. */
export const FEEDS = [
  { key: 'cbn_ntb', label: 'NTB auctions (CBN)', staleDays: 4 },
  { key: 'cbn_omo', label: 'OMO auctions (CBN)', staleDays: 4 },
  { key: 'cbn_mpc', label: 'MPR and MPC (CBN)', staleDays: 4 },
  { key: 'fmdq_cp', label: 'CP quotations (FMDQ)', staleDays: 4 },
  { key: 'cbn_cpi', label: 'Headline inflation (CBN)', staleDays: 10 },
];

/** Each feed with its status: ok, stale, failing or never run. */
export function feedHealth(data, today) {
  const docs = new Map((data.feedStatus ?? []).map((d) => [d.id, d]));
  return FEEDS.map((f) => {
    const d = docs.get(f.key);
    const lastOk = d?.lastSuccessAt?.slice(0, 10) ?? null;
    let status;
    if (d?.lastErrorAt && (!d.lastSuccessAt || d.lastErrorAt > d.lastSuccessAt)) status = 'failing';
    else if (!lastOk) status = 'never';
    else status = daysBetween(lastOk, today) > f.staleDays ? 'stale' : 'ok';
    return { ...f, doc: d ?? null, lastOk, status };
  });
}
