// Quarter close: the benchmark a quarter uses, its fee and incentive calculation, and the lock that stops
// entries dated in a closed quarter from changing. Pure functions over the loaded data (testable).
import { BusinessCalendar, closePeriod, dec, parseQuarterLabel, quarter, quarterOf, trueYieldFromDiscount } from '../engine/index.js';
import { mandateOn, navSeries, periodReport } from './portfolio.js';

/** True yield of an auction result: the stored one when the source gave it, else from the stop (discount) rate. */
export function auctionYield(a) {
  if (a.trueYield && !dec(a.trueYield).isZero()) return dec(a.trueYield);
  return trueYieldFromDiscount(a.stopRate, Number(a.tenorDays));
}

/** 91-day NTB primary auctions, newest first. */
export function ntb91(data) {
  return (data.auctions ?? [])
    .filter((a) => a.kind === 'ntb' && Number(a.tenorDays) >= 89 && Number(a.tenorDays) <= 92)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** The benchmark for a quarter: the last 91-day NTB auction held before the quarter started. */
export function benchmarkFor(data, label) {
  const q = parseQuarterLabel(label);
  return ntb91(data).find((a) => a.date < q.start) ?? null;
}

/** Quarters that have ended, newest first, back to the quarter of the first transaction. */
export function completedQuarters(inception, today) {
  if (!inception) return [];
  const out = [];
  let cur = quarterOf(today);
  cur = cur.q === 1 ? quarter(cur.year - 1, 4) : quarter(cur.year, cur.q - 1);
  while (cur.end >= inception) {
    out.push(cur);
    cur = cur.q === 1 ? quarter(cur.year - 1, 4) : quarter(cur.year, cur.q - 1);
  }
  return out;
}

/**
 * The quarter's figures. For the current quarter, pass today as asOf: the result runs to date (a preview).
 * @returns {{quarter, periodStart, periodEnd, benchmark, terms, result, report} | {error: string}}
 */
export function computeClose(data, label, { asOf, auctionId } = {}) {
  const q = parseQuarterLabel(label);
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  if (!inception) return { error: 'No transactions yet.' };
  const periodStart = inception > q.start ? inception : q.start;
  const periodEnd = asOf && asOf < q.end ? asOf : q.end;
  if (periodEnd < periodStart) return { error: `${label} is before the first transaction.` };
  const terms = mandateOn(data, periodEnd);
  if (!terms) return { error: `No mandate terms in force on ${periodEnd}. Add them under Settings.` };
  const benchmark = auctionId ? (data.auctions ?? []).find((a) => a.id === auctionId) : benchmarkFor(data, label);
  if (!benchmark) return { error: `No 91-day NTB auction before ${q.start} is stored. Add it on the Market screen.` };
  const trueYield = auctionYield(benchmark);
  const rows = navSeries(data, periodEnd);
  const result = closePeriod({
    periodStart, periodEnd, navRows: rows, terms, benchmark: { trueYield }, calendar: new BusinessCalendar(),
  });
  const report = periodReport(data, periodStart, periodEnd);
  return { quarter: q, periodStart, periodEnd, benchmark: { ...benchmark, trueYield }, terms, result, report };
}

/** The document saved when a quarter is closed: every figure as a decimal string, so the record never moves. */
export function closeRecord(c) {
  const r = c.result;
  const s = (x) => dec(x).toFixed();
  const m = (x) => dec(x).toFixed(2);
  return {
    quarter: c.quarter.label,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    days: String(r.days),
    benchmark: {
      auctionId: c.benchmark.id ?? '',
      auctionDate: c.benchmark.date,
      tenorDays: String(c.benchmark.tenorDays),
      stopRate: c.benchmark.stopRate ?? '',
      trueYield: s(c.benchmark.trueYield),
      sourceUrl: c.benchmark.sourceUrl ?? '',
    },
    terms: {
      effectiveFrom: c.terms.effectiveFrom,
      mgmtFeeRate: c.terms.mgmtFeeRate,
      incentiveRate: c.terms.incentiveRate,
      hurdleSpread: c.terms.hurdleSpread,
      incentiveReading: c.terms.incentiveReading ?? 'clause_8',
    },
    arip: s(r.arip),
    watbr: s(r.watbr),
    hurdle: s(r.hurdle),
    avgNav: m(r.avgNav),
    hurdleMet: r.hurdleMet,
    mgmtFee: m(r.mgmtFee),
    incentiveClause8: m(r.incentiveClause8),
    incentiveClause12: m(r.incentiveClause12),
    openingNav: m(c.report.openingNav),
    closingNav: m(c.report.closingNav),
    inflows: m(c.report.inflows),
    withdrawals: m(c.report.withdrawals),
    fees: m(c.report.fees),
    income: m(c.report.income),
    status: 'closed',
  };
}

// ---------- lock ----------

/** Closed quarters as {label, start, end}. */
export function closedQuarters(data) {
  return (data.quarterlyResults ?? []).map((r) => ({ label: r.quarter ?? r.id, start: r.periodStart, end: r.periodEnd }));
}

const inside = (d, q) => d && d >= q.start && d <= q.end;

/**
 * The closed quarter a change would alter, or null. A transaction or fund price is caught by its date; a deal by
 * the time it is held (value date to maturity, or open-ended for a fund).
 */
export function lockedBy(closed, coll, docData) {
  if (!docData || !closed.length) return null;
  if (coll === 'transactions' || coll === 'fundPrices') return closed.find((q) => inside(docData.date, q)) ?? null;
  if (coll === 'instruments') {
    const from = docData.valueDate;
    const to = docData.maturityDate ?? '9999-12-31';
    return closed.find((q) => from && from <= q.end && to >= q.start) ?? null;
  }
  return null;
}
