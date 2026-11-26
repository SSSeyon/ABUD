// Internal management report for MBO: AUM trend, return against the hurdle by quarter, fees under every reading
// against what was billed, concentration and limit status today, and limit breaches in the period.
import { dec, ZERO } from '../../engine/index.js';
import { limitsFrom } from '../alerts.js';
import { runBacktest } from '../backtest.js';
import { groupedBars, lineChart, sankey } from '../charts.js';
import { periodFlows } from '../flows.js';
import { exposures } from '../counterparties.js';
import { breachesBetween } from '../mgmt.js';
import { periodPicker, resolvePeriod } from '../period.js';
import { navSeries, periodReport } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { excelButton, fmtDate, fmtNaira, fmtPct, h, table, todayISO, xDate, xMoney, xPct } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms', 'funds', 'auctions'];
const sel = { key: 'ytd', start: '', end: '' };
let cache = { key: null, value: null };

function compute(data, period, today) {
  const key = [data.transactions, data.instruments, data.fundPrices, data.auctions, data.mandateTerms, data.invoices, data.limitSets, data.ratings, data.counterparties, period.start, period.end];
  if (cache.key && cache.key.every((v, i) => v === key[i])) return cache.value;
  const bt = runBacktest(data, today, {});
  const quarters = bt.rows.filter((r) => !r.error && r.periodEnd >= period.start && r.periodStart <= period.end);
  const breaches = breachesBetween(data, period.start, period.end);
  const rows = navSeries(data, period.end).filter((r) => r.date >= period.start);
  const value = { quarters, breaches, rows };
  cache = { key, value };
  return value;
}

export function managementView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  if (!inception) return h('div', null, h('h1', null, 'Management report'), h('p', { class: 'muted' }, 'No transactions yet.'));
  const period = resolvePeriod(sel, inception, today);
  const toolbar = h('div', { class: 'toolbar no-print' }, periodPicker(sel, inception, today, rerender),
    h('button', { class: 'primary', onclick: () => window.print() }, 'Print / save as PDF'));
  const docHead = h('div', { class: 'doc-head' },
    h('div', { class: 'wordmark' }, h('span', { class: 'wm-mbo' }, 'mbo'), h('span', { class: 'wm-capital' }, 'capital')),
    h('div', null, h('h1', null, 'Management report (internal)'), h('p', null, `ABUD portfolio · ${fmtDate(period.start)} to ${fmtDate(period.end)} · prepared ${fmtDate(today)}`)));

  let m;
  try { m = compute(data, period, today); } catch (err) {
    console.error(err);
    return h('div', null, toolbar, h('div', { class: 'card bad' }, h('p', null, err.message)));
  }
  const limits = limitsFrom(data, today);
  const q = m.quarters;
  const sum = (f) => q.reduce((s, r) => s.plus(f(r) ?? ZERO), ZERO);
  const billed = q.filter((r) => r.invoice);
  const opening = m.rows[0]?.nav ?? ZERO;
  const closing = m.rows.at(-1)?.nav ?? ZERO;
  const kpi = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);

  const parts = [toolbar, docHead,
    h('div', { class: 'stats' },
      kpi('AUM at period end', fmtNaira(closing), `From ${fmtNaira(opening)}`),
      kpi('Quarters in period', String(q.length), `${q.filter((r) => r.hurdleMet).length} beat the hurdle`),
      kpi('Management fees earned', fmtNaira(sum((r) => r.mgmtFee)), billed.length ? `Billed ${fmtNaira(billed.reduce((s, r) => s.plus(r.invoice.mgmtFee), ZERO))}` : 'Recalculated'),
      kpi('Incentive (Clause 8)', fmtNaira(sum((r) => r.clause8)), `Cl. 12 ${fmtNaira(sum((r) => r.clause12))} · worksheet ${fmtNaira(sum((r) => r.worksheet.fee))}`),
      kpi('Limit breaches', String(m.breaches.length), 'Month ends and new deals in the period'))];

  // AUM trend and return against the hurdle.
  const cats = q.map((r) => r.label.replace(/^20/, '').replace('Q', ' Q'));
  parts.push(h('div', { class: 'grid-2' },
    h('section', { class: 'card' }, h('h2', null, 'Assets under management'), lineChart(m.rows.map((x) => ({ date: x.date, value: x.nav })), { label: 'NAV' })),
    h('section', { class: 'card' }, h('h2', null, 'Return against the hurdle'),
      groupedBars(cats, [
        { label: 'ARIP', values: q.map((r) => Number(r.arip)), cls: 'series-b' },
        { label: 'Hurdle', values: q.map((r) => Number(r.hurdle)), cls: 'series-a' },
      ], { label: 'ARIP and hurdle by quarter', format: (v) => `${(v * 100).toFixed(1)}%` }))));

  // Money flows for the period.
  try {
    const f = periodFlows(periodReport(data, period.start, period.end));
    parts.push(h('section', { class: 'card' }, h('h2', null, 'Money flows'), sankey(f.left, f.right, { middle: 'Portfolio', label: 'Money flows for the period' })));
  } catch (err) { console.error(err); }

  // Quarter table.
  const qRows = q.map((r) => h('tr', null,
    h('td', null, r.label), h('td', { class: 'num' }, fmtNaira(r.avgNav)), h('td', { class: 'num' }, fmtPct(r.arip, 2)), h('td', { class: 'num' }, fmtPct(r.hurdle, 2)),
    h('td', null, r.hurdleMet ? 'Met' : 'Not met'),
    h('td', { class: 'num' }, fmtNaira(r.mgmtFee)), h('td', { class: 'num' }, fmtNaira(r.clause8)), h('td', { class: 'num' }, fmtNaira(r.clause12)), h('td', { class: 'num' }, fmtNaira(r.worksheet.fee)),
    h('td', { class: 'num' }, r.invoice ? fmtNaira(dec(r.invoice.mgmtFee).plus(r.invoice.incentiveFee)) : '—')));
  if (q.length) {
    qRows.push(h('tr', { class: 'total' }, h('td', null, 'Total'), h('td'), h('td'), h('td'), h('td'),
      h('td', { class: 'num' }, fmtNaira(sum((r) => r.mgmtFee))), h('td', { class: 'num' }, fmtNaira(sum((r) => r.clause8))), h('td', { class: 'num' }, fmtNaira(sum((r) => r.clause12))), h('td', { class: 'num' }, fmtNaira(sum((r) => r.worksheet.fee))),
      h('td', { class: 'num' }, billed.length ? fmtNaira(billed.reduce((s, r) => s.plus(r.invoice.mgmtFee).plus(r.invoice.incentiveFee), ZERO)) : '—')));
  }
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Quarters: return and fees under each reading'),
    table(['Quarter', { label: 'Average NAV', num: true }, { label: 'ARIP', num: true }, { label: 'Hurdle', num: true }, 'Test', { label: 'Mgmt fee', num: true }, { label: 'Incentive Cl. 8', num: true }, { label: 'Cl. 12', num: true }, { label: 'Worksheet', num: true }, { label: 'Billed total', num: true }], qRows, 'No completed quarter in this period.'),
    h('p', { class: 'muted small' }, 'Only quarters that have ended are shown. Management fee on the confirmed basis (annual rate ÷ 4 per quarter). Billing stays on Clause 8 until Access confirms the incentive basis.')));

  // Concentration and limits today.
  let ex = [];
  try { ex = exposures(data, today, limits.minRating); } catch { ex = []; }
  const exRows = ex.slice(0, 12).map((e) => h('tr', { class: e.below ? 'bad' : null },
    h('td', null, e.name), h('td', null, e.fgn ? 'FGN' : e.rating?.rating ?? 'Unrated'),
    h('td', { class: 'num' }, fmtNaira(e.value)), h('td', { class: 'num' }, fmtPct(e.share, 1)),
    h('td', null, e.fgn ? 'Exempt' : e.below ? `Below ${limits.minRating}` : e.share.gt(limits.concentrationShare) ? 'Over limit' : 'Within')));
  parts.push(h('section', { class: 'card' }, h('h2', null, `Concentration and limits at ${fmtDate(today)}`),
    h('p', { class: 'muted small' }, `Limits in force: concentration ${fmtPct(limits.concentrationShare, 0)} of NAV · liquidity ${fmtPct(limits.liquidityShare, 0)} within ${limits.liquidityDays} days · idle cash ₦${(Number(limits.idleCash) / 1e6).toFixed(0)}m · tenor ${limits.maxTenorDays} days · minimum rating ${limits.minRating}.`),
    table(['Counterparty', 'Rating', { label: 'Value', num: true }, { label: '% of NAV', num: true }, 'Status'], exRows, 'No holdings today.')));

  // Breaches.
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Limit breaches in the period'),
    table(['Date', 'Limit', 'Detail'], m.breaches.map((b) => h('tr', null, h('td', null, fmtDate(b.date)), h('td', null, b.limit), h('td', null, b.detail))), 'No breaches at any month end in the period.'),
    h('p', { class: 'muted small' }, 'Checked at each month end (and the period end) against the limits in force on that date, plus every deal struck in the period against the tenor limit then.')));

  parts.push(h('div', { class: 'toolbar actions-row no-print' },
    excelButton('Download Excel', () => `ABUD management report ${period.start} to ${period.end}.xlsx`, () => workbook(m, ex, period))));
  return h('div', { class: 'document' }, parts);
}

function workbook(m, ex, period) {
  const quarters = [['Quarter', 'Start', 'End', 'Average NAV', 'ARIP', 'WATBR', 'Hurdle', 'Hurdle met', 'Mgmt fee', 'Clause 8', 'Clause 12', 'Worksheet', 'Billed mgmt', 'Billed incentive']];
  for (const r of m.quarters) quarters.push([r.label, xDate(r.periodStart), xDate(r.periodEnd), xMoney(r.avgNav), xPct(r.arip, 4), xPct(r.watbr, 4), xPct(r.hurdle, 4), r.hurdleMet ? 'Yes' : 'No', xMoney(r.mgmtFee), xMoney(r.clause8), xMoney(r.clause12), xMoney(r.worksheet.fee), xMoney(r.invoice?.mgmtFee), xMoney(r.invoice?.incentiveFee)]);
  const aum = [['Date', 'NAV']];
  for (const x of m.rows) aum.push([xDate(x.date), xMoney(x.nav)]);
  const exposure = [['Counterparty', 'Rating', 'Value', 'Share of NAV']];
  for (const e of ex) exposure.push([e.name, e.fgn ? 'FGN' : e.rating?.rating ?? 'Unrated', xMoney(e.value), xPct(e.share, 1)]);
  const breaches = [['Date', 'Limit', 'Detail'], ...m.breaches.map((b) => [xDate(b.date), b.limit, b.detail])];
  return [{ name: 'Quarters', rows: quarters }, { name: 'AUM', rows: aum }, { name: 'Concentration', rows: exposure }, { name: `Breaches ${period.start.slice(0, 4)}`, rows: breaches }];
}
