// Turns Firestore documents into engine inputs and answers portfolio questions for the screens.
// No Firebase imports here, so it is testable in tests/index.html.
import { addDays, buildDailyNav, daysBetween, dec, toKobo, DAYS_IN_YEAR } from '../engine/index.js';

const OPENING = new Set(['invest', 'fund_subscription']);
const CLOSING = new Set(['mature', 'fund_redemption']);
const DISCOUNT = new Set(['ntb', 'omo', 'commercial_paper']);

export const TYPE_LABELS = {
  ntb: 'Treasury bill (NTB)',
  omo: 'OMO bill',
  commercial_paper: 'Commercial paper',
  fixed_deposit: 'Fixed deposit',
  money_market_fund: 'Money market fund',
};

export const TX_LABELS = {
  inflow: 'Inflow from Access',
  withdrawal: 'Withdrawal',
  fee_debit: 'Fee debit',
  invest: 'Investment',
  mature: 'Maturity',
  rollover: 'Rollover',
  interest: 'Interest received',
  fund_subscription: 'Fund subscription',
  fund_redemption: 'Fund redemption',
};

/** Cash sign of each transaction type, for display. Rollover carries its own sign. */
export const TX_SIGN = {
  inflow: 1, withdrawal: -1, fee_debit: -1, invest: -1, mature: 1,
  interest: 1, fund_subscription: -1, fund_redemption: 1,
};

/** The transaction that opened each position (its investment or subscription). */
export function openingTransactions(transactions = []) {
  const out = new Map();
  for (const t of transactions) if (OPENING.has(t.type) && t.instrumentId) out.set(t.instrumentId, t);
  return out;
}

/** Instruments with a maturity or redemption recorded. */
export function closedInstrumentIds(transactions = []) {
  return new Set(transactions.filter((t) => CLOSING.has(t.type) && t.instrumentId).map((t) => t.instrumentId));
}

/**
 * Day each holding leaves NAV ahead of schedule: a fund's first (full) redemption, or a maturity recorded
 * before the contract maturity date (early termination, or a bill sold before maturity).
 */
function earlyCloseDates(transactions = [], instruments = []) {
  const maturity = new Map(instruments.map((i) => [i.id, i.maturityDate]));
  const out = new Map();
  for (const t of transactions) {
    if (!t.instrumentId) continue;
    const due = maturity.get(t.instrumentId);
    const early = t.type === 'fund_redemption' || (t.type === 'mature' && due && t.date < due);
    if (!early) continue;
    const prev = out.get(t.instrumentId);
    if (!prev || t.date < prev) out.set(t.instrumentId, t.date);
  }
  return out;
}

export function toEngineInstrument(i, closeDate) {
  const base = { id: i.id, valueDate: i.valueDate };
  if (closeDate) base.closeDate = closeDate;
  if (DISCOUNT.has(i.type)) return { ...base, type: i.type, faceValue: i.faceValue, cost: i.cost, maturityDate: i.maturityDate };
  if (i.type === 'fixed_deposit') return { ...base, type: i.type, principal: i.cost, rate: i.rate, maturityDate: i.maturityDate };
  if (i.type === 'money_market_fund') {
    return { ...base, type: i.type, fundId: i.fundId, pricingBasis: i.pricingBasis, cost: i.cost, units: i.units };
  }
  throw new Error(`Instrument ${i.id}: unknown type ${i.type}`);
}

/** Engine inputs from Firestore data. Every recorded transaction counts. */
export function engineInputs(data) {
  const txs = data.transactions ?? [];
  const closed = earlyCloseDates(txs, data.instruments ?? []);
  const instruments = (data.instruments ?? []).map((i) => toEngineInstrument(i, closed.get(i.id)));
  const transactions = txs.map((t) => ({
    id: t.id, date: t.date, type: t.type, amount: t.amount, instrumentId: t.instrumentId, approved: true,
  }));
  const fundPrices = (data.fundPrices ?? []).map((p) => ({ fundId: p.fundId, date: p.date, priceOrYield: p.priceOrYield }));
  return { transactions, instruments, fundPrices };
}

/** Daily NAV rows from the first transaction to asOf. Empty when there are no transactions yet. */
export function navSeries(data, asOf) {
  const inputs = engineInputs(data);
  const dates = inputs.transactions.map((t) => t.date).sort();
  if (!dates.length || asOf < dates[0]) return [];
  return buildDailyNav({ start: dates[0], end: asOf, ...inputs });
}

/** Expected cash at maturity: face value for discount instruments; principal plus interest for deposits. */
export function expectedMaturityValue(i) {
  if (DISCOUNT.has(i.type)) return dec(i.faceValue).toFixed(2);
  if (i.type === 'fixed_deposit') {
    const p = dec(i.cost);
    const days = daysBetween(i.valueDate, i.maturityDate);
    return toKobo(p.plus(p.times(i.rate).times(days).div(DAYS_IN_YEAR))).toFixed(2);
  }
  return null;
}

/** Maturities due within `days` of `today`, and overdue ones with no maturity recorded yet. */
export function maturityWatch(data, today, days = 14) {
  const closed = closedInstrumentIds(data.transactions);
  const horizon = addDays(today, days);
  const due = [];
  const overdue = [];
  for (const i of data.instruments ?? []) {
    if (i.type === 'money_market_fund' || !i.maturityDate || closed.has(i.id)) continue;
    if (i.maturityDate < today) overdue.push(i);
    else if (i.maturityDate <= horizon) due.push(i);
  }
  const byDate = (a, b) => (a.maturityDate < b.maturityDate ? -1 : 1);
  return { due: due.sort(byDate), overdue: overdue.sort(byDate) };
}

/** Mandate terms in force on a date: the latest version with effectiveFrom <= date. */
export function mandateOn(data, date) {
  return (data.mandateTerms ?? [])
    .filter((m) => m.effectiveFrom <= date && (!m.effectiveTo || m.effectiveTo > date))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}
