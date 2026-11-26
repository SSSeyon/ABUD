// Back-test: every completed quarter since inception recalculated from the recorded history, set against the fees
// MBO actually billed (the invoices collection, loaded from the MCM income sheet). Pure functions (testable).
import { dec, ZERO } from '../engine/index.js';
import { completedQuarters, computeClose, incentiveFor } from './close.js';
import { navSeries } from './portfolio.js';

/**
 * @param {object} data loaded collections
 * @param {string} today
 * @param {{feeDayCount?: 'quarterly'|'act365', reading?: 'clause_8'|'clause_12'|'worksheet', from?: string, to?: string}} [opts]
 */
export function runBacktest(data, today, { feeDayCount, reading = 'worksheet', from, to } = {}) {
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  let quarters = completedQuarters(inception, today).reverse();
  if (from) quarters = quarters.filter((q) => q.label >= from);
  if (to) quarters = quarters.filter((q) => q.label <= to);
  if (!quarters.length) return { rows: [], totals: null, reading };
  const rows = navSeries(data, quarters.at(-1).end);
  const invoices = new Map((data.invoices ?? []).map((i) => [i.quarter ?? i.id, i]));
  const out = [];
  for (const q of quarters) {
    const c = computeClose(data, q.label, { rows, withReport: false, feeDayCount });
    const inv = invoices.get(q.label) ?? null;
    if (c.error) { out.push({ label: q.label, error: c.error, invoice: inv }); continue; }
    const r = c.result;
    const incentive = incentiveFor(r, reading);
    const billedMgmt = inv ? dec(inv.mgmtFee) : null;
    const billedInc = inv ? dec(inv.incentiveFee) : null;
    out.push({
      label: q.label,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      days: r.days,
      benchmarkDate: c.benchmark.date,
      trueYield: c.benchmark.trueYield,
      avgNav: r.avgNav,
      arip: r.arip,
      watbr: r.watbr,
      hurdle: r.hurdle,
      hurdleMet: r.hurdleMet,
      mgmtFee: r.mgmtFee,
      clause8: r.incentiveClause8,
      clause12: r.incentiveClause12,
      worksheet: r.worksheet,
      incentive,
      invoice: inv,
      mgmtDiff: billedMgmt ? r.mgmtFee.minus(billedMgmt) : null,
      incentiveDiff: billedInc ? incentive.minus(billedInc) : null,
    });
  }
  const ok = out.filter((x) => !x.error);
  const sumOf = (f) => ok.reduce((s, x) => s.plus(f(x) ?? ZERO), ZERO);
  const billed = ok.filter((x) => x.invoice);
  const totals = {
    quarters: ok.length,
    billedQuarters: billed.length,
    mgmtFee: sumOf((x) => x.mgmtFee),
    clause8: sumOf((x) => x.clause8),
    clause12: sumOf((x) => x.clause12),
    worksheet: sumOf((x) => x.worksheet.fee),
    incentive: sumOf((x) => x.incentive),
    billedMgmt: billed.reduce((s, x) => s.plus(x.invoice.mgmtFee), ZERO),
    billedIncentive: billed.reduce((s, x) => s.plus(x.invoice.incentiveFee), ZERO),
    // Totals over billed quarters only, so the comparison is like for like.
    mgmtOnBilled: billed.reduce((s, x) => s.plus(x.mgmtFee), ZERO),
    incentiveOnBilled: billed.reduce((s, x) => s.plus(x.incentive), ZERO),
    hurdleMet: ok.filter((x) => x.hurdleMet).length,
    // Within 1% (or N1,000 for small amounts) counts as a match.
    mgmtMatches: billed.filter((x) => matches(x.mgmtFee, x.invoice.mgmtFee)).length,
    incentiveMatches: billed.filter((x) => matches(x.incentive, x.invoice.incentiveFee)).length,
  };
  return { rows: out, totals, reading };
}

/** Within 1% of the billed figure, or N1,000 when that is larger. */
export function matches(a, b) {
  const diff = dec(a).minus(b).abs();
  const tol = dec(b).abs().times('0.01');
  return diff.lte(tol.gt(1000) ? tol : dec(1000));
}
