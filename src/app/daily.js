// Day-by-day make-up of NAV: for every position (deal, or fund account on a statement) its opening value,
// money in, money out, income and closing value each day; plus cash and the external flows.
// Income of a position on a day = closing − opening − money in + money out, so the positions' incomes and the
// cash flows add up to the day's NAV change exactly. No Firebase here, so it is testable.
import { addDays, dec, eachDay, ZERO } from '../engine/index.js';
import { navSeries, positionIdOf, positionsFor } from './portfolio.js';

const IN = new Set(['invest', 'fund_subscription']);
const OUT = new Set(['mature', 'fund_redemption', 'interest']);

/**
 * @param {object} data app data
 * @param {string} start first day (inclusive)
 * @param {string} end last day (inclusive)
 * @param {{only?: string}} [opts] only: one position id (for a holding statement)
 * @returns {{
 *   positions: {id: string, label: string, type: string, inst: object, kind: string}[],
 *   days: {date: string, openNav: any, closeNav: any, openCash: any, closeCash: any, inflows: any, withdrawals: any, fees: any,
 *          income: any, byPos: Map<string, {open: any, in: any, out: any, income: any, close: any, moved: any}>}[],
 *   totals: Map<string, {open: any, in: any, out: any, income: any, close: any}>,
 * }}
 */
export function dailyBreakdown(data, start, end, { only } = {}) {
  const { list, statements } = positionsFor(data);
  const prev = addDays(start, -1);
  const positions = list.filter((p) => (!only || p.id === only) && p.start <= end && (p.end ?? '9999-12-31') >= start);
  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));

  // Money in and out per position per day.
  const flows = new Map();
  const add = (date, id, key, amount) => {
    const k = `${date}|${id}`;
    const f = flows.get(k) ?? flows.set(k, { in: ZERO, out: ZERO }).get(k);
    f[key] = f[key].plus(amount);
  };
  const ext = new Map();
  for (const t of data.transactions ?? []) {
    if (t.date < start || t.date > end) continue;
    if (['inflow', 'withdrawal', 'fee_debit'].includes(t.type)) {
      const e = ext.get(t.date) ?? ext.set(t.date, { inflows: ZERO, withdrawals: ZERO, fees: ZERO }).get(t.date);
      if (t.type === 'inflow') e.inflows = e.inflows.plus(t.amount);
      else if (t.type === 'withdrawal') e.withdrawals = e.withdrawals.plus(t.amount);
      else e.fees = e.fees.plus(t.amount);
      continue;
    }
    const id = positionIdOf(t, instruments, statements);
    if (!id) continue;
    if (IN.has(t.type)) add(t.date, id, 'in', dec(t.amount));
    else if (OUT.has(t.type)) add(t.date, id, 'out', dec(t.amount));
  }

  const nav = only ? null : navSeries(data, end);
  const navOn = new Map((nav ?? []).map((r) => [r.date, r]));
  const last = new Map(positions.map((p) => [p.id, p.value(prev)]));
  const totals = new Map(positions.map((p) => [p.id, { open: last.get(p.id), in: ZERO, out: ZERO, income: ZERO, close: ZERO }]));
  const days = [];
  for (const date of eachDay(start, end)) {
    const byPos = new Map();
    // A fund deal that the statement takes over today hands its value to the fund's account.
    const moved = new Map();
    for (const p of positions) {
      if (p.kind !== 'instrument' || p.type !== 'money_market_fund') continue;
      if (statements.start(p.inst.fundId) === date && !last.get(p.id).isZero()) {
        moved.set(p.id, last.get(p.id));
        const acct = `fund:${p.inst.fundId}`;
        moved.set(acct, (moved.get(acct) ?? ZERO).minus(last.get(p.id)));
      }
    }
    let income = ZERO;
    for (const p of positions) {
      const open = last.get(p.id);
      const close = p.value(date);
      const f = flows.get(`${date}|${p.id}`) ?? { in: ZERO, out: ZERO };
      const m = moved.get(p.id) ?? ZERO; // positive: moved out to the account; negative: moved in
      const moneyIn = f.in.plus(m.isNegative() ? m.neg() : ZERO);
      const moneyOut = f.out.plus(m.isPositive() ? m : ZERO);
      const inc = close.minus(open).minus(moneyIn).plus(moneyOut);
      last.set(p.id, close);
      if (open.isZero() && close.isZero() && moneyIn.isZero() && moneyOut.isZero()) continue;
      byPos.set(p.id, { open, in: moneyIn, out: moneyOut, income: inc, close, moved: m });
      income = income.plus(inc);
      const t = totals.get(p.id);
      t.in = t.in.plus(moneyIn); t.out = t.out.plus(moneyOut); t.income = t.income.plus(inc);
    }
    const e = ext.get(date) ?? { inflows: ZERO, withdrawals: ZERO, fees: ZERO };
    const row = navOn.get(date);
    const before = navOn.get(addDays(date, -1));
    days.push({
      date, byPos, income, ...e,
      openNav: before?.nav ?? null, closeNav: row?.nav ?? null, openCash: before?.cash ?? null, closeCash: row?.cash ?? null,
    });
  }
  for (const p of positions) totals.get(p.id).close = last.get(p.id);
  // Opening NAV of the first day comes from the day before the period.
  if (days.length && nav) {
    const first = nav.find((r) => r.date === prev);
    days[0].openNav = first?.nav ?? ZERO;
    days[0].openCash = first?.cash ?? ZERO;
  }
  return { positions, days, totals };
}

/** Rows for one position's statement: date, opening, in, out, income, closing; skips days before it opened. */
export function positionStatement(data, positionId, start, end) {
  const b = dailyBreakdown(data, start, end, { only: positionId });
  return { position: b.positions[0] ?? null, rows: b.days.filter((d) => d.byPos.has(positionId)).map((d) => ({ date: d.date, ...d.byPos.get(positionId) })), total: b.totals.get(positionId) ?? null };
}

const CASH_IN = new Set(['inflow', 'mature', 'fund_redemption', 'interest']);
const CASH_OUT = new Set(['withdrawal', 'fee_debit', 'invest', 'fund_subscription']);

/**
 * The cash account's statement, shaped like positionStatement: money in = inflows from Access plus maturities,
 * redemptions and interest received; money out = investments, withdrawals and fee debits. Cash earns nothing, so
 * income is only what the cash balance does not explain (zero when the records are complete).
 */
export function cashStatement(data, start, end) {
  const nav = navSeries(data, end);
  const cashOn = new Map(nav.map((r) => [r.date, r.cash]));
  const flows = new Map();
  for (const t of data.transactions ?? []) {
    if (t.date < start || t.date > end) continue;
    const key = CASH_IN.has(t.type) ? 'in' : CASH_OUT.has(t.type) ? 'out' : null;
    if (!key) continue;
    const f = flows.get(t.date) ?? flows.set(t.date, { in: ZERO, out: ZERO }).get(t.date);
    f[key] = f[key].plus(t.amount);
  }
  let last = cashOn.get(addDays(start, -1)) ?? ZERO;
  const total = { open: last, in: ZERO, out: ZERO, income: ZERO, close: ZERO };
  const rows = [];
  for (const date of eachDay(start, end)) {
    const close = cashOn.get(date) ?? last;
    const f = flows.get(date) ?? { in: ZERO, out: ZERO };
    const income = close.minus(last).minus(f.in).plus(f.out);
    if (!(last.isZero() && close.isZero() && f.in.isZero() && f.out.isZero())) {
      rows.push({ date, open: last, in: f.in, out: f.out, income, close });
      total.in = total.in.plus(f.in); total.out = total.out.plus(f.out); total.income = total.income.plus(income);
    }
    last = close;
  }
  total.close = last;
  return { position: null, rows, total };
}
