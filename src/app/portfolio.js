// Turns Firestore documents into engine inputs and answers portfolio questions for the screens.
// No Firebase imports here, so it is testable in tests/index.html.
import {
  addDays, buildDailyNav, daysBetween, dec, eachDay, toKobo, timeWeightedReturn, DAYS_IN_YEAR, FundPriceBook, FundStatementBook, ONE, Valuer, ZERO,
} from '../engine/index.js';

const OPENING = new Set(['invest', 'fund_subscription']);
const CLOSING = new Set(['mature', 'fund_redemption']);
const DISCOUNT = new Set(['ntb', 'omo', 'commercial_paper']);

export const TYPE_LABELS = {
  ntb: 'Treasury bill (NTB)',
  omo: 'OMO bill',
  commercial_paper: 'Commercial paper',
  fixed_deposit: 'Fixed deposit',
  call_deposit: 'Call deposit',
  money_market_fund: 'Money market fund',
};

/** Deposits earn simple interest at a rate: fixed deposits and calls value the same way. */
export const DEPOSIT_TYPES = new Set(['fixed_deposit', 'call_deposit']);

/**
 * Asset classes, in a fixed order that also fixes each class's chart colour (--class-<key> in styles.css).
 * Transactions not tied to a deal (inflows, withdrawals, fees) belong to 'cash'.
 */
export const ASSET_CLASSES = [
  { key: 'ntb', label: 'Treasury bills' },
  { key: 'commercial_paper', label: 'Commercial paper' },
  { key: 'fixed_deposit', label: 'Fixed deposits' },
  { key: 'call_deposit', label: 'Call deposits' },
  { key: 'money_market_fund', label: 'Money market funds' },
  { key: 'omo', label: 'OMO bills' },
  { key: 'cash', label: 'Cash and flows' },
];
export const CLASS_LABELS = Object.fromEntries(ASSET_CLASSES.map((c) => [c.key, c.label]));

/** Asset class of a transaction: its deal's instrument type, or 'cash'. */
export function txClass(t, instruments) {
  const i = t.instrumentId ? instruments.get(t.instrumentId) : null;
  return i?.type ?? 'cash';
}

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
  if (DEPOSIT_TYPES.has(i.type)) return { ...base, type: 'fixed_deposit', principal: i.cost, rate: i.rate, maturityDate: i.maturityDate };
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
  // Rows uploaded from a fund platform statement carry the day's closing balance (see fundstatement.js).
  const fundStatements = (data.fundPrices ?? []).filter((p) => p.balance != null && p.balance !== '')
    .map((p) => ({ fundId: p.fundId, date: p.date, balance: p.balance, rate: p.priceOrYield }));
  return { transactions, instruments, fundPrices, fundStatements };
}

/** Daily NAV rows from the first transaction to asOf. Empty when there are no transactions yet. */
// Last few NAV series, keyed on the data arrays (replaced whenever Firestore sends a change) and the date.
const navCache = [];

export function navSeries(data, asOf) {
  const hit = navCache.find((c) => c.t === data.transactions && c.i === data.instruments && c.p === data.fundPrices && c.asOf === asOf);
  if (hit) return hit.rows;
  const rows = computeNavSeries(data, asOf);
  navCache.unshift({ t: data.transactions, i: data.instruments, p: data.fundPrices, asOf, rows });
  navCache.length = Math.min(navCache.length, 8);
  return rows;
}

function computeNavSeries(data, asOf) {
  const inputs = engineInputs(data);
  const dates = inputs.transactions.map((t) => t.date).sort();
  if (!dates.length || asOf < dates[0]) return [];
  return buildDailyNav({ start: dates[0], end: asOf, ...inputs });
}

/** Expected cash at maturity: face value for discount instruments; principal plus interest for deposits. */
export function expectedMaturityValue(i) {
  if (DISCOUNT.has(i.type)) return dec(i.faceValue).toFixed(2);
  if (DEPOSIT_TYPES.has(i.type)) {
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

/**
 * Everything a report for the period start..end (inclusive) needs. Values are end of day; "opening" is the
 * end of the day before start. Per asset class:
 *   income = closing value - opening value - money invested + money returned (maturities, redemptions, interest).
 * The cash class carries the external flows, so the class incomes add up to the portfolio's income.
 */
export function periodReport(data, start, end) {
  const rows = navSeries(data, end);
  const before = rows.filter((r) => r.date < start).at(-1);
  const period = rows.filter((r) => r.date >= start);
  const openingNav = before ? before.nav : ZERO;
  const closingNav = rows.at(-1)?.nav ?? ZERO;
  const openingCash = before ? before.cash : ZERO;
  const closingCash = rows.at(-1)?.cash ?? ZERO;
  const days = daysBetween(start, end) + 1;

  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const txs = (data.transactions ?? []).filter((t) => t.date >= start && t.date <= end)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const total = (type) => txs.filter((t) => t.type === type).reduce((s, t) => s.plus(t.amount), ZERO);
  const inflows = total('inflow');
  const withdrawals = total('withdrawal');
  const fees = total('fee_debit');
  const netFlow = inflows.minus(withdrawals).minus(fees);
  const income = closingNav.minus(openingNav).minus(netFlow);
  const twr = period.length ? timeWeightedReturn(period, openingNav) : ZERO;
  const annualised = days >= 1 && twr.gt(-1) ? ONE.plus(twr).pow(DAYS_IN_YEAR.div(days)).minus(ONE) : null;

  // Daily value of every position (holding, or fund on a statement) over the period, summed by class.
  const { list } = positionsFor(data);
  const prevDay = addDays(start, -1);
  const live = list.filter((p) => p.start <= end && (p.end ?? '9999-12-31') >= prevDay);
  const blank = () => ({ opening: ZERO, closing: ZERO, invested: ZERO, returned: ZERO, valueDays: ZERO });
  const byClass = new Map();
  const cls = (k) => byClass.get(k) ?? byClass.set(k, blank()).get(k);
  for (const date of [prevDay, ...eachDay(start, end)]) {
    for (const p of live) {
      const v = p.value(date);
      if (v.isZero()) continue;
      const c = cls(p.type);
      if (date === prevDay) c.opening = c.opening.plus(v);
      else c.valueDays = c.valueDays.plus(v);
      if (date === end) c.closing = c.closing.plus(v);
    }
  }
  for (const t of txs) {
    const k = txClass(t, instruments);
    if (k === 'cash') continue;
    const c = cls(k);
    if (OPENING.has(t.type)) c.invested = c.invested.plus(t.amount);
    else if (CLOSING.has(t.type) || t.type === 'interest') c.returned = c.returned.plus(t.amount);
  }
  const classes = ASSET_CLASSES.filter((a) => a.key !== 'cash' && byClass.has(a.key)).map((a) => {
    const c = byClass.get(a.key);
    const inc = c.closing.minus(c.opening).minus(c.invested).plus(c.returned);
    const average = c.valueDays.div(days);
    return { ...a, ...c, income: inc, average, yield: average.isZero() ? null : inc.div(average).times(DAYS_IN_YEAR).div(days) };
  });
  // Cash: what's left of income after the holdings (bank charges are external flows, so normally zero).
  const holdingsIncome = classes.reduce((s, c) => s.plus(c.income), ZERO);
  classes.push({ key: 'cash', label: CLASS_LABELS.cash, opening: openingCash, closing: closingCash, invested: ZERO, returned: ZERO, income: income.minus(holdingsIncome), average: null, yield: null });

  const counts = {};
  for (const t of txs) counts[txClass(t, instruments)] = (counts[txClass(t, instruments)] ?? 0) + 1;
  return { start, end, days, rows: period, allRows: rows, openingNav, closingNav, inflows, withdrawals, fees, netFlow, income, twr, annualised, classes, transactions: txs, counts };
}

/** Holdings open at the end of a date, valued, with their class. A fund on a statement is one holding. */
export function holdingsOn(data, date) {
  return positionsFor(data).list
    .map((p) => ({ inst: p.inst, value: p.value(date), position: p }))
    .filter((x) => !x.value.isZero());
}

// Positions for the last few data versions (the yield-accrual cache inside the valuer makes reuse cheap).
const posCache = [];

/**
 * Everything valued day by day, as positions: each deal, plus one account per money market fund kept on an
 * uploaded statement (from its first statement day the fund's deals are valued through the account).
 * Each position: { id, kind: 'instrument'|'fund', type, label, inst, start, end (exclusive, or null), value(date) }.
 * For a fund account, inst is a stand-in record (type, fundId, counterpartyName, valueDate) so screens can list it.
 */
export function positionsFor(data) {
  const hit = posCache.find((c) => c.t === data.transactions && c.i === data.instruments && c.p === data.fundPrices && c.f === data.funds);
  if (hit) return hit.value;
  const inputs = engineInputs(data);
  const statements = new FundStatementBook(inputs.fundStatements);
  const valuer = new Valuer(new FundPriceBook(inputs.fundPrices), statements);
  const docs = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const funds = new Map((data.funds ?? []).map((f) => [f.id, f]));
  const list = inputs.instruments.map((e) => {
    const inst = docs.get(e.id);
    // A fund deal stops at its fund's statement start: from then on the account carries it.
    const stmt = inst.type === 'money_market_fund' ? statements.start(inst.fundId) : null;
    let end = e.closeDate ?? (inst.type === 'money_market_fund' ? null : e.maturityDate);
    if (stmt && (!end || stmt < end)) end = stmt < e.valueDate ? e.valueDate : stmt;
    return { id: e.id, kind: 'instrument', type: inst.type, label: positionLabel(inst, funds), inst, start: e.valueDate, end, value: (d) => valuer.valueOn(e, d) };
  });
  for (const fundId of statements.funds) {
    const fund = funds.get(fundId);
    const inst = { id: `fund:${fundId}`, type: 'money_market_fund', fundId, counterpartyName: fund?.managerName || fund?.name || 'Fund', valueDate: statements.start(fundId), statement: true };
    list.push({ id: inst.id, kind: 'fund', type: 'money_market_fund', label: `${fund?.name ?? 'Fund'} account`, inst, fundId, start: inst.valueDate, end: null, value: (d) => statements.value(fundId, d) });
  }
  const value = { list, byId: new Map(list.map((p) => [p.id, p])), statements, valuer };
  posCache.unshift({ t: data.transactions, i: data.instruments, p: data.fundPrices, f: data.funds, value });
  posCache.length = Math.min(posCache.length, 4);
  return value;
}

const SHORT_TYPE = { ntb: 'NTB', omo: 'OMO', commercial_paper: 'CP', fixed_deposit: 'FD', call_deposit: 'Call', money_market_fund: 'Fund' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}` : '');

/** Short name for a deal: "FD Coronation · 12 Nov 26 → 10 Feb 27". */
export function positionLabel(inst, funds = new Map()) {
  const who = inst.type === 'money_market_fund' ? (funds.get(inst.fundId)?.name ?? inst.counterpartyName ?? 'Fund') : (inst.counterpartyName || TYPE_LABELS[inst.type]);
  const span = inst.maturityDate ? `${shortDate(inst.valueDate)} → ${shortDate(inst.maturityDate)}` : `from ${shortDate(inst.valueDate)}`;
  return `${SHORT_TYPE[inst.type] ?? inst.type} ${who} · ${span}`;
}

/** The position a transaction belongs to: its deal, or its fund's statement account once the statement covers the date. */
export function positionIdOf(t, instruments, statements) {
  if (!t.instrumentId) return null;
  const inst = instruments.get(t.instrumentId);
  if (inst?.type === 'money_market_fund' && statements.covers(inst.fundId, t.date)) return `fund:${inst.fundId}`;
  return t.instrumentId;
}

/** Mandate terms in force on a date: the latest version with effectiveFrom <= date. */
export function mandateOn(data, date) {
  return (data.mandateTerms ?? [])
    .filter((m) => m.effectiveFrom <= date && (!m.effectiveTo || m.effectiveTo > date))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}
