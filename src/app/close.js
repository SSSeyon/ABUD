// Quarter close: the benchmark a quarter uses, its fee and incentive calculation, and the lock that stops
// entries dated in a closed quarter from changing. Pure functions over the loaded data (testable).
import {
  addDays, BusinessCalendar, closePeriod, dec, parseQuarterLabel, quarter, quarterOf, shadowBenchmark, terminationFee,
  toKobo, trueYieldFromDiscount, worksheetIncentive, ZERO,
} from '../engine/index.js';
import { holdingsOn, mandateOn, navSeries, periodReport } from './portfolio.js';

/** Decisions confirmed on 26 Nov 2026: management fee is a quarter of the annual rate per quarter (as billed). */
export const DEFAULT_FEE_DAY_COUNT = 'quarterly';
/** Terms as the app applies them: the confirmed day count unless a terms version says otherwise. */
export function appTerms(terms) {
  return terms ? { ...terms, feeDayCount: terms.feeDayCount ?? DEFAULT_FEE_DAY_COUNT } : terms;
}

/** Incentive readings. Billing uses Clause 8 until Access confirms; all three are shown. */
export const READINGS = [
  { key: 'clause_8', label: 'Clause 8', help: '10% × (ARIP − WATBR) × average NAV, when ARIP beats the hurdle' },
  { key: 'clause_12', label: 'Clause 12', help: '10% × (ARIP − hurdle) × average NAV' },
  { key: 'worksheet', label: 'Worksheet', help: '10% × (naira income − shadow benchmark income), as in the MCM income sheet' },
];

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


// ---------- worksheet reading ----------

/** Net contributions (inflows less withdrawals) by date: what the MCM income sheet counts as contributions. */
export function contributionsByDate(data) {
  const out = new Map();
  for (const t of data.transactions ?? []) {
    if (t.type !== 'inflow' && t.type !== 'withdrawal') continue;
    const a = t.type === 'inflow' ? dec(t.amount) : dec(t.amount).neg();
    out.set(t.date, (out.get(t.date) ?? ZERO).plus(a));
  }
  return out;
}

const shadowCache = [];
/**
 * The worksheet's shadow benchmark account from the first transaction to asOf: contributions compounded daily at
 * the true yield of the latest 91-day NTB auction (on or before each day) plus the hurdle spread then in force.
 * @returns {Map<string, {balance, interest}>}
 */
export function shadowSeries(data, asOf) {
  const hit = shadowCache.find((c) => c.t === data.transactions && c.a === data.auctions && c.m === data.mandateTerms && c.asOf === asOf);
  if (hit) return hit.map;
  const contributions = contributionsByDate(data);
  const start = [...contributions.keys()].sort()[0];
  const map = new Map();
  if (start && start <= asOf) {
    const auctions = ntb91(data).slice().reverse(); // oldest first
    let k = -1;
    const terms = [...(data.mandateTerms ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    let ti = -1;
    const yieldOn = (date) => {
      while (k + 1 < auctions.length && auctions[k + 1].date <= date) k++;
      while (ti + 1 < terms.length && terms[ti + 1].effectiveFrom <= date) ti++;
      if (k < 0) return null;
      return auctionYield(auctions[k]).plus(ti >= 0 ? terms[ti].hurdleSpread : 0);
    };
    for (const r of shadowBenchmark({ start, end: asOf, contributions, yieldOn, spread: 0 })) map.set(r.date, r);
  }
  shadowCache.unshift({ t: data.transactions, a: data.auctions, m: data.mandateTerms, asOf, map });
  shadowCache.length = Math.min(shadowCache.length, 4);
  return map;
}

/** Worksheet figures for start..end from NAV rows and the shadow account. */
export function worksheetFigures(data, rows, shadow, start, end, incentiveRate) {
  const navOn = (d) => rows.find((r) => r.date === d)?.nav;
  const opening = navOn(addDays(start, -1)) ?? ZERO;
  const closing = navOn(end) ?? ZERO;
  let contributions = ZERO;
  let benchmarkIncome = ZERO;
  const flows = contributionsByDate(data);
  for (const [d, a] of flows) if (d >= start && d <= end) contributions = contributions.plus(a);
  for (const [d, r] of shadow) if (d >= start && d <= end) benchmarkIncome = benchmarkIncome.plus(r.interest);
  const income = closing.minus(opening).minus(contributions);
  const { excess, fee } = worksheetIncentive({ income, benchmarkIncome, incentiveRate });
  return { income, benchmarkIncome, excess, fee: toKobo(fee), unrounded: fee };
}

/**
 * The quarter's figures. For the current quarter, pass today as asOf: the result runs to date (a preview).
 * Pass rows (a NAV series reaching periodEnd) and withReport: false to run many quarters quickly (back-test).
 * @returns {{quarter, periodStart, periodEnd, benchmark, terms, result, report} | {error: string}}
 */
export function computeClose(data, label, { asOf, auctionId, rows, withReport = true, feeDayCount } = {}) {
  const q = parseQuarterLabel(label);
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  if (!inception) return { error: 'No transactions yet.' };
  const periodStart = inception > q.start ? inception : q.start;
  const periodEnd = asOf && asOf < q.end ? asOf : q.end;
  if (periodEnd < periodStart) return { error: `${label} is before the first transaction.` };
  let terms = appTerms(mandateOn(data, periodEnd));
  if (!terms) return { error: `No mandate terms in force on ${periodEnd}. Add them under Settings.` };
  if (feeDayCount) terms = { ...terms, feeDayCount };
  const benchmark = auctionId ? (data.auctions ?? []).find((a) => a.id === auctionId) : benchmarkFor(data, label);
  if (!benchmark) return { error: `No 91-day NTB auction before ${q.start} is stored. Add it on the Market screen.` };
  const trueYield = auctionYield(benchmark);
  const navRows = rows ?? navSeries(data, periodEnd);
  const result = closePeriod({
    periodStart, periodEnd, navRows, terms, benchmark: { trueYield }, calendar: new BusinessCalendar(),
  });
  const shadow = shadowSeries(data, rows ? rows.at(-1).date : periodEnd);
  result.worksheet = worksheetFigures(data, navRows, shadow, periodStart, periodEnd, terms.incentiveRate);
  const report = withReport ? periodReport(data, periodStart, periodEnd) : null;
  return { quarter: q, periodStart, periodEnd, benchmark: { ...benchmark, trueYield }, terms, result, report };
}

/** Incentive under a reading, from a computeClose result. */
export function incentiveFor(result, reading) {
  if (reading === 'clause_12') return result.incentiveClause12;
  if (reading === 'worksheet') return result.worksheet.fee;
  return result.incentiveClause8;
}

// ---------- termination (Clauses 12 and 13) ----------

/**
 * Everything due if the mandate ends on a determination date: the pro-rata management fee since the last quarter
 * end (whole months, part months rounded up: confirmed 26 Nov 2026; the daily figure is shown for reference),
 * the final-period incentive under each reading, and the End-Date Portfolio to hand over.
 */
export function computeTermination(data, date) {
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  if (!inception) return { error: 'No transactions yet.' };
  if (date < inception) return { error: 'The date is before the first transaction.' };
  const q = quarterOf(date);
  const lastFeePeriodEnd = addDays(q.start, -1);
  const rows = navSeries(data, date);
  const nav = rows.at(-1)?.nav ?? ZERO;
  const cash = rows.at(-1)?.cash ?? ZERO;
  const terms = appTerms(mandateOn(data, date));
  if (!terms) return { error: `No mandate terms in force on ${date}.` };
  const fee = terminationFee({ navAtDetermination: nav, annualRate: terms.mgmtFeeRate, lastFeePeriodEnd, determinationDate: date });
  const close = computeClose(data, q.label, { asOf: date, withReport: false });
  const holdings = holdingsOn(data, date).map((x) => ({ ...x }));
  return { date, quarter: q, lastFeePeriodEnd, nav, cash, terms, fee, close, holdings };
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
      feeDayCount: c.terms.feeDayCount ?? DEFAULT_FEE_DAY_COUNT,
    },
    arip: s(r.arip),
    watbr: s(r.watbr),
    hurdle: s(r.hurdle),
    avgNav: m(r.avgNav),
    hurdleMet: r.hurdleMet,
    mgmtFee: m(r.mgmtFee),
    incentiveClause8: m(r.incentiveClause8),
    incentiveClause12: m(r.incentiveClause12),
    incentiveWorksheet: m(r.worksheet.fee),
    worksheetIncome: m(r.worksheet.income),
    worksheetBenchmarkIncome: m(r.worksheet.benchmarkIncome),
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
