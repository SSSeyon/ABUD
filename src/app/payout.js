// Quarterly income payout to Access (their mandate): each quarter's income is paid out to them.
// Up to 2026Q3 the gross income was paid (those payouts are ordinary withdrawals in the history); from
// NET_PAYOUT_FROM the payout is the income net of MBO's fees for the quarter (management fee + Clause 8 incentive,
// the billing basis). The amount is fixed when the quarter is closed, because the fees are only final then.
// A payout is a `withdrawal` tagged { purpose: 'income_payout', quarter: '2026Q4' }. No Firebase here, so it is testable.
import { dec, quarter, quarterOf, ZERO } from '../engine/index.js';
import { completedQuarters } from './close.js';
import { periodReport } from './portfolio.js';

export const NET_PAYOUT_FROM = '2026Q4';
export const PAYOUT_PURPOSE = 'income_payout';

/** 'net' from NET_PAYOUT_FROM, 'gross' before. Quarter labels sort as text ('2026Q4' < '2027Q1'). */
export const payoutBasis = (label) => (label >= NET_PAYOUT_FROM ? 'net' : 'gross');

/** MBO's fees billed for a closed quarter: management fee plus the Clause 8 incentive. */
export const billedFees = (rec) => dec(rec.mgmtFee ?? 0).plus(rec.incentiveClause8 ?? 0);

/** Payouts recorded against each quarter. */
export function payoutsByQuarter(transactions) {
  const out = new Map();
  for (const t of transactions ?? []) {
    if (t.type !== 'withdrawal' || t.purpose !== PAYOUT_PURPOSE || !t.quarter) continue;
    const e = out.get(t.quarter) ?? out.set(t.quarter, { amount: ZERO, list: [] }).get(t.quarter);
    e.amount = e.amount.plus(t.amount);
    e.list.push(t);
  }
  return out;
}

/** Quarters a payout can be tagged to: NET_PAYOUT_FROM up to the current quarter, newest first. */
export function payoutQuarters(today) {
  const out = [];
  let q = quarterOf(today);
  while (q.label >= NET_PAYOUT_FROM) {
    out.push(q);
    q = q.q === 1 ? quarter(q.year - 1, 4) : quarter(q.year, q.q - 1);
  }
  return out;
}

/**
 * One row per quarter from NET_PAYOUT_FROM to the current one, newest first.
 * Closed quarters: income and fees from the frozen close record; payable = max(0, income − fees).
 * Open quarters: income to date, fees not yet known (payable null) until the quarter is closed.
 * @returns {{quarter: string, start: string, end: string, closed: boolean, inProgress: boolean, income: any,
 *   fees: any|null, payable: any|null, paid: any, outstanding: any|null, payouts: object[]}[]}
 */
export function payoutSchedule(data, today) {
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  if (!inception) return [];
  const recs = new Map((data.quarterlyResults ?? []).map((r) => [r.quarter ?? r.id, r]));
  const paid = payoutsByQuarter(data.transactions);
  const current = quarterOf(today);
  const quarters = [current, ...completedQuarters(inception, today)].filter((q) => q.label >= NET_PAYOUT_FROM && q.end >= inception);
  return quarters.map((q) => {
    const rec = recs.get(q.label);
    const p = paid.get(q.label) ?? { amount: ZERO, list: [] };
    if (rec) {
      const income = dec(rec.income ?? 0);
      const fees = billedFees(rec);
      const net = income.minus(fees);
      const payable = net.isNegative() ? ZERO : net.toDecimalPlaces(2);
      return { quarter: q.label, start: q.start, end: q.end, closed: true, inProgress: false, income, fees, payable, paid: p.amount, outstanding: payable.minus(p.amount), payouts: p.list };
    }
    const end = q.end < today ? q.end : today;
    let income = null;
    try { income = periodReport(data, q.start, end).income; } catch { income = null; }
    return { quarter: q.label, start: q.start, end: q.end, closed: false, inProgress: q.label === current.label, income, fees: null, payable: null, paid: p.amount, outstanding: null, payouts: p.list };
  });
}
