// Back-test: every completed quarter since inception recalculated from the recorded history and compared with the
// fees MBO billed (MCM income sheet). Switch the management fee day count and the incentive reading to see which
// reproduces the invoices.
import { dec } from '../../engine/index.js';
import { importInvoices, saveDoc } from '../actions.js';
import { runBacktest } from '../backtest.js';
import { groupedBars } from '../charts.js';
import { READINGS } from '../close.js';
import { loadedAll, state } from '../store.js';
import { downloadCsv, excelButton, fmtCompact, fmtDate, fmtNaira, fmtPct, h, openForm, parseMoney, runAction, table, todayISO, xMoney, xPct } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms', 'funds', 'auctions'];
const sel = { feeDayCount: 'quarterly', reading: 'worksheet', from: '', to: '' };
let cache = { key: null, result: null };

const pctDiff = (a, b) => (dec(b).isZero() ? null : dec(a).minus(b).div(b));
const fmtM = (x) => fmtCompact(x);

function compute(data, today) {
  const key = [data.transactions, data.instruments, data.fundPrices, data.auctions, data.mandateTerms, data.invoices, sel.feeDayCount, sel.reading, sel.from, sel.to, today];
  if (cache.key && cache.key.every((v, i) => v === key[i])) return cache.result;
  const result = runBacktest(data, today, { feeDayCount: sel.feeDayCount, reading: sel.reading, from: sel.from || undefined, to: sel.to || undefined });
  cache = { key, result };
  return result;
}

export function backtestView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Back-test'),
    h('p', { class: 'subtitle' }, 'Every quarter since inception, recalculated from the recorded history and set against the fees MBO billed.')));

  let bt;
  try { bt = compute(data, today); } catch (err) {
    console.error(err);
    return h('div', null, head, h('div', { class: 'card bad' }, h('h2', null, 'The back-test could not run'), h('p', null, err.message)));
  }
  if (!bt.totals) return h('div', null, head, h('p', { class: 'muted' }, 'No completed quarter yet.'));
  const all = runQuarters(data);
  const reading = READINGS.find((r) => r.key === sel.reading);
  const t = bt.totals;
  const parts = [head];

  if (state.errors.invoices) parts.push(h('div', { class: 'card warn' }, h('p', null, 'Billed fees need the updated Firestore rules (publish firestore.rules). Until then the recalculated figures show without the comparison.')));
  if (!(data.invoices ?? []).length) {
    parts.push(h('div', { class: 'card warn' },
      h('h2', null, 'Billed fees not loaded'),
      h('p', null, 'Load the management and incentive fees billed each quarter, taken from the "MCM income" sheet of the ABUD schedule (data/invoices-mcm.json, built by tools/history/build-invoices.ps1).'),
      h('button', { class: 'primary', onclick: (e) => runAction(e.currentTarget, async () => {
        const res = await fetch('data/invoices-mcm.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Could not read data/invoices-mcm.json (${res.status})`);
        await importInvoices(await res.json());
      }, 'Billed fees loaded') }, 'Load billed fees')));
  }

  // Controls.
  const select = (label, value, options, onchange) => h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, label),
    h('select', { class: 'period-select', value, onchange: (e) => { onchange(e.target.value); rerender(); } }, options.map(([v, l]) => h('option', { value: v, selected: v === value ? true : null }, l))));
  parts.push(h('div', { class: 'toolbar no-print' },
    select('Management fee', sel.feeDayCount, [['quarterly', 'Annual rate ÷ 4 per quarter (confirmed)'], ['act365', 'Actual/365']], (v) => { sel.feeDayCount = v; }),
    select('Incentive reading', sel.reading, READINGS.map((r) => [r.key, r.label]), (v) => { sel.reading = v; }),
    select('From', sel.from || all[0], all.map((q) => [q, q]), (v) => { sel.from = v === all[0] ? '' : v; }),
    select('To', sel.to || all.at(-1), all.map((q) => [q, q]), (v) => { sel.to = v === all.at(-1) ? '' : v; })));

  // Headline tiles.
  const kpi = (label, value, note, tone) => h('div', { class: `stat ${tone ?? ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  const mDiff = t.billedQuarters ? pctDiff(t.mgmtOnBilled, t.billedMgmt) : null;
  const iDiff = t.billedQuarters ? pctDiff(t.incentiveOnBilled, t.billedIncentive) : null;
  parts.push(h('div', { class: 'stats' },
    kpi('Quarters', String(t.quarters), `${t.hurdleMet} beat the hurdle · ${t.billedQuarters} with billed fees`),
    kpi('Management fee billed', t.billedQuarters ? fmtNaira(t.billedMgmt) : '—', t.billedQuarters ? `Recalculated ${fmtNaira(t.mgmtOnBilled)}` : 'Load billed fees'),
    kpi('Management fee difference', mDiff == null ? '—' : fmtPct(mDiff, 2), t.billedQuarters ? `${t.mgmtMatches} of ${t.billedQuarters} quarters within 1%` : null, mDiff == null ? null : mDiff.abs().lt('0.01') ? 'up' : 'down'),
    kpi('Incentive billed', t.billedQuarters ? fmtNaira(t.billedIncentive) : '—', t.billedQuarters ? `${reading.label} reading: ${fmtNaira(t.incentiveOnBilled)}` : null),
    kpi(`Incentive difference (${reading.label})`, iDiff == null ? '—' : fmtPct(iDiff, 1), t.billedQuarters ? `${t.incentiveMatches} of ${t.billedQuarters} quarters within 1%` : null, iDiff == null ? null : iDiff.abs().lt('0.01') ? 'up' : 'down'),
    kpi('All three readings, total', fmtM(t.clause8), `Cl. 8 · Cl. 12 ${fmtM(t.clause12)} · worksheet ${fmtM(t.worksheet)}`)));

  // Charts.
  const ok = bt.rows.filter((r) => !r.error);
  const cats = ok.map((r) => r.label.replace(/^20/, '').replace('Q', ' Q'));
  const billedInc = ok.map((r) => (r.invoice ? Number(r.invoice.incentiveFee) : null));
  parts.push(h('div', { class: 'grid-2' },
    h('section', { class: 'card' }, h('h2', null, 'Incentive fee by quarter'),
      groupedBars(cats, [
        { label: 'Billed', values: billedInc, cls: 'series-a' },
        { label: `Recalculated (${reading.label})`, values: ok.map((r) => Number(r.incentive)), cls: 'series-b' },
      ], { label: 'Incentive fee by quarter' })),
    h('section', { class: 'card' }, h('h2', null, 'Return against the hurdle'),
      groupedBars(cats, [
        { label: 'ARIP', values: ok.map((r) => Number(r.arip)), cls: 'series-b' },
        { label: 'Hurdle', values: ok.map((r) => Number(r.hurdle)), cls: 'series-a' },
      ], { label: 'ARIP and hurdle by quarter', format: (v) => `${(v * 100).toFixed(1)}%` }))));

  // Main table.
  const diffCell = (d, base) => {
    if (d == null) return h('td', { class: 'num muted' }, '—');
    const p = pctDiff(d.plus(base), base);
    const tone = p != null && p.abs().lte('0.01') ? 'ok' : 'bad';
    return h('td', { class: `num diff-${tone}`, title: p == null ? '' : `${fmtPct(p, 2)} of the billed figure` }, fmtNaira(d));
  };
  const rows = bt.rows.map((r) => {
    if (r.error) return h('tr', null, h('td', null, r.label), h('td', { colspan: 12, class: 'muted' }, r.error));
    const inv = r.invoice;
    return h('tr', null,
      h('td', null, h('a', { href: '#/backtest', title: 'Edit the billed figures', onclick: (e) => { e.preventDefault(); editInvoice(r.label, inv); } }, r.label)),
      h('td', { class: 'num' }, String(r.days)),
      h('td', { class: 'num' }, fmtM(r.avgNav)),
      h('td', { class: 'num' }, fmtPct(r.arip, 2)),
      h('td', { class: 'num' }, fmtPct(r.hurdle, 2)),
      h('td', { class: 'num' }, inv ? fmtNaira(inv.mgmtFee) : '—'),
      h('td', { class: 'num' }, fmtNaira(r.mgmtFee)),
      diffCell(r.mgmtDiff, inv?.mgmtFee),
      h('td', { class: 'num' }, inv ? fmtNaira(inv.incentiveFee) : '—'),
      h('td', { class: `num ${sel.reading === 'clause_8' ? 'strong' : ''}` }, fmtNaira(r.clause8)),
      h('td', { class: `num ${sel.reading === 'clause_12' ? 'strong' : ''}` }, fmtNaira(r.clause12)),
      h('td', { class: `num ${sel.reading === 'worksheet' ? 'strong' : ''}` }, fmtNaira(r.worksheet.fee)),
      diffCell(r.incentiveDiff, inv?.incentiveFee));
  });
  rows.push(h('tr', { class: 'total' }, h('td', null, 'Total'), h('td'), h('td'), h('td'), h('td'),
    h('td', { class: 'num' }, fmtNaira(t.billedMgmt)), h('td', { class: 'num' }, fmtNaira(t.mgmtFee)), h('td', { class: 'num' }, t.billedQuarters ? fmtNaira(t.mgmtOnBilled.minus(t.billedMgmt)) : '—'),
    h('td', { class: 'num' }, fmtNaira(t.billedIncentive)), h('td', { class: 'num' }, fmtNaira(t.clause8)), h('td', { class: 'num' }, fmtNaira(t.clause12)), h('td', { class: 'num' }, fmtNaira(t.worksheet)),
    h('td', { class: 'num' }, t.billedQuarters ? fmtNaira(t.incentiveOnBilled.minus(t.billedIncentive)) : '—')));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Fees by quarter'),
      h('div', { class: 'toolbar actions-row no-print' },
        excelButton('Download Excel', () => `ABUD back-test ${today}.xlsx`, () => workbook(bt)),
        h('button', { onclick: () => downloadCsv(`ABUD back-test ${today}.csv`, csvRows(bt)) }, 'CSV'))),
    table(['Quarter', { label: 'Days', num: true }, { label: 'Avg NAV', num: true }, { label: 'ARIP', num: true }, { label: 'Hurdle', num: true },
      { label: 'Mgmt fee billed', num: true }, { label: 'Recalculated', num: true }, { label: 'Difference', num: true },
      { label: 'Incentive billed', num: true }, { label: 'Clause 8', num: true }, { label: 'Clause 12', num: true }, { label: 'Worksheet', num: true }, { label: `Difference (${reading.label})`, num: true }], rows),
    h('p', { class: 'muted small' }, `Differences within 1% of the billed figure show green. Click a quarter to correct its billed figures. ${reading.help}.`)));

  // Worksheet detail: where the incentive difference comes from.
  const wrows = ok.filter((r) => r.invoice).map((r) => h('tr', null,
    h('td', null, r.label),
    h('td', { class: 'num' }, fmtNaira(r.invoice.sheetIncome)), h('td', { class: 'num' }, fmtNaira(r.worksheet.income)),
    h('td', { class: 'num' }, fmtNaira(r.invoice.sheetBenchmarkIncome)), h('td', { class: 'num' }, fmtNaira(r.worksheet.benchmarkIncome)),
    h('td', { class: 'num' }, fmtPct(r.trueYield, 3)), h('td', null, fmtDate(r.benchmarkDate))));
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Worksheet reading: income and shadow benchmark'),
    h('p', { class: 'muted small' }, 'The MCM income sheet charges 10% of the quarter\'s naira income (NAV change less contributions) above the income of a shadow account. That account receives every contribution and withdrawal and compounds daily at the latest 91-day NTB true yield plus the 2% spread. Gaps between the sheet and the app point to differences in the recorded history, valuation or benchmark rates.'),
    table(['Quarter', { label: 'Income (sheet)', num: true }, { label: 'Income (app)', num: true }, { label: 'Benchmark income (sheet)', num: true }, { label: 'Benchmark income (app)', num: true }, { label: 'Quarter benchmark yield', num: true }, 'Auction used for the hurdle'], wrows, 'Load billed fees to compare with the sheet.')));
  return h('div', null, parts);
}

/** Every completed quarter label, oldest first (for the From and To pickers). */
function runQuarters(data) {
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  const out = [];
  if (!inception) return out;
  let y = Number(inception.slice(0, 4));
  let q = Math.floor((Number(inception.slice(5, 7)) - 1) / 3) + 1;
  const today = todayISO();
  for (;;) {
    const endMonth = q * 3;
    const end = `${y}-${String(endMonth).padStart(2, '0')}-${endMonth === 3 || endMonth === 12 ? '31' : '30'}`;
    if (end >= today) break;
    out.push(`${y}Q${q}`);
    if (q === 4) { y += 1; q = 1; } else q += 1;
  }
  return out;
}

function editInvoice(label, inv) {
  openForm({
    title: `Billed fees for ${label}`,
    intro: 'The amounts invoiced to Access for this quarter.',
    fields: [
      { name: 'mgmtFee', label: 'Management fee billed (₦)', required: true, value: inv?.mgmtFee ?? '' },
      { name: 'incentiveFee', label: 'Incentive fee billed (₦)', required: true, value: inv?.incentiveFee ?? '0.00' },
      { name: 'invoiceDate', label: 'Invoice date', type: 'date', value: inv?.invoiceDate ?? '' },
    ],
    onSubmit: (v) => {
      const mgmtFee = parseMoney(v.mgmtFee, 'Management fee', { allowZero: true });
      const incentiveFee = parseMoney(v.incentiveFee, 'Incentive fee', { allowZero: true });
      return saveDoc('invoices', label, { ...(inv ?? {}), id: undefined, updatedAt: undefined, quarter: label, mgmtFee, incentiveFee, totalFee: dec(mgmtFee).plus(incentiveFee).toFixed(2), invoiceDate: v.invoiceDate, source: inv?.source ? `${inv.source} (edited)` : 'Entered by hand' });
    },
  });
}

function csvRows(bt) {
  const out = [['Quarter', 'Start', 'End', 'Days', 'Average NAV', 'ARIP', 'WATBR', 'Hurdle', 'Hurdle met', 'Mgmt fee billed', 'Mgmt fee recalculated', 'Incentive billed', 'Clause 8', 'Clause 12', 'Worksheet', 'Income (sheet)', 'Income (app)', 'Benchmark income (sheet)', 'Benchmark income (app)']];
  for (const r of bt.rows) {
    if (r.error) { out.push([r.label, '', '', '', r.error]); continue; }
    const inv = r.invoice;
    out.push([r.label, r.periodStart, r.periodEnd, r.days, r.avgNav.toFixed(2), r.arip.toFixed(6), r.watbr.toFixed(6), r.hurdle.toFixed(6), r.hurdleMet ? 'Yes' : 'No',
      inv?.mgmtFee ?? '', r.mgmtFee.toFixed(2), inv?.incentiveFee ?? '', r.clause8.toFixed(2), r.clause12.toFixed(2), r.worksheet.fee.toFixed(2),
      inv?.sheetIncome ?? '', r.worksheet.income.toFixed(2), inv?.sheetBenchmarkIncome ?? '', r.worksheet.benchmarkIncome.toFixed(2)]);
  }
  return out;
}

function workbook(bt) {
  const rows = [['Quarter', 'Start', 'End', 'Days', 'Average NAV', 'ARIP', 'WATBR', 'Hurdle', 'Hurdle met', 'Mgmt fee billed', 'Mgmt fee recalculated', 'Incentive billed', 'Clause 8', 'Clause 12', 'Worksheet', 'Income (sheet)', 'Income (app)', 'Benchmark income (sheet)', 'Benchmark income (app)']];
  for (const r of bt.rows) {
    if (r.error) { rows.push([r.label, '', '', '', r.error]); continue; }
    const inv = r.invoice;
    rows.push([r.label, r.periodStart, r.periodEnd, r.days, xMoney(r.avgNav), xPct(r.arip, 4), xPct(r.watbr, 4), xPct(r.hurdle, 4), r.hurdleMet ? 'Yes' : 'No',
      xMoney(inv?.mgmtFee), xMoney(r.mgmtFee), xMoney(inv?.incentiveFee), xMoney(r.clause8), xMoney(r.clause12), xMoney(r.worksheet.fee),
      xMoney(inv?.sheetIncome), xMoney(r.worksheet.income), xMoney(inv?.sheetBenchmarkIncome), xMoney(r.worksheet.benchmarkIncome)]);
  }
  const t = bt.totals;
  const summary = [
    ['Back-test summary', ''],
    ['Quarters', t.quarters], ['Quarters with billed fees', t.billedQuarters], ['Quarters beating the hurdle', t.hurdleMet],
    ['Management fee billed', xMoney(t.billedMgmt)], ['Management fee recalculated (billed quarters)', xMoney(t.mgmtOnBilled)],
    ['Incentive billed', xMoney(t.billedIncentive)], ['Clause 8 total', xMoney(t.clause8)], ['Clause 12 total', xMoney(t.clause12)], ['Worksheet total', xMoney(t.worksheet)],
  ];
  return [{ name: 'Fees by quarter', rows }, { name: 'Summary', rows: summary, widths: [44, 18] }];
}
