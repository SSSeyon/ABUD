// Termination calculator (Clauses 12 and 13): what is due to MBO if the mandate ends on a chosen date, and the
// End-Date Portfolio to hand over. Pro-rata management fee on whole months (confirmed 26 Nov 2026).
import { dec } from '../../engine/index.js';
import { computeTermination } from '../close.js';
import { counterpartyName } from '../counterparties.js';
import { expectedMaturityValue, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { excelButton, fmtDate, fmtNaira, fmtPct, h, table, todayISO, xDate, xMoney } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms', 'funds', 'auctions'];
const sel = { date: '' };

export function terminationView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  if (!sel.date) sel.date = today;
  const toolbar = h('div', { class: 'toolbar no-print' },
    h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Determination date'),
      h('input', { type: 'date', value: sel.date, max: '2100-12-31', onchange: (e) => { if (e.target.value) { sel.date = e.target.value; rerender(); } } })),
    h('button', { class: 'primary', onclick: () => window.print() }, 'Print / save as PDF'));
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Termination'),
    h('p', { class: 'subtitle' }, 'Fees due and the End-Date Portfolio if the mandate ends on a given date (Clauses 12 and 13).')));

  let t;
  try { t = computeTermination(data, sel.date); } catch (err) { t = { error: err.message }; }
  if (t.error) return h('div', null, head, toolbar, h('div', { class: 'card bad' }, h('p', null, t.error)));

  const c = t.close;
  const r = c.error ? null : c.result;
  const incentive = r ? r.incentiveClause8 : dec(0);
  const total = t.fee.monthBasis.plus(incentive);
  const kpi = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  const parts = [head, toolbar,
    h('div', { class: 'stats' },
      kpi('NAV at determination', fmtNaira(t.nav), fmtDate(t.date)),
      kpi('Pro-rata management fee', fmtNaira(t.fee.monthBasis), `${t.fee.months} month${t.fee.months === 1 ? '' : 's'} since ${fmtDate(t.lastFeePeriodEnd)}`),
      kpi('Final-period incentive (Cl. 8)', r ? fmtNaira(incentive) : '—', r ? (r.hurdleMet ? 'Hurdle met to date' : 'Hurdle not met to date') : c.error),
      kpi('Total due to MBO', fmtNaira(total), 'Management fee + Clause 8 incentive'))];

  const rows = [
    ['Last fee period ended', fmtDate(t.lastFeePeriodEnd)],
    ['Determination date', fmtDate(t.date)],
    ['NAV at determination (gross of fees)', fmtNaira(t.nav)],
    [`Management fee, whole months (billing basis): ${fmtPct(t.terms.mgmtFeeRate)} ÷ 12 × NAV × ${t.fee.months}`, fmtNaira(t.fee.monthBasis)],
    [`For reference, daily basis: ${fmtPct(t.terms.mgmtFeeRate)} × NAV × ${t.fee.days} ÷ 365`, fmtNaira(t.fee.dailyBasis)],
  ];
  if (r) {
    rows.push(
      [`Final period ${fmtDate(c.periodStart)} to ${fmtDate(c.periodEnd)}: ARIP`, fmtPct(r.arip, 4)],
      [`Hurdle for ${r.days} days (benchmark ${fmtDate(c.benchmark.date)}, true yield ${fmtPct(c.benchmark.trueYield, 3)})`, fmtPct(r.hurdle, 4)],
      ['Incentive, Clause 8 (billing basis)', fmtNaira(r.incentiveClause8)],
      ['Incentive, Clause 12 (internal)', fmtNaira(r.incentiveClause12)],
      ['Incentive, worksheet reading (internal)', fmtNaira(r.worksheet.fee)],
    );
  }
  rows.push(['Total due to MBO (management fee + Clause 8 incentive)', fmtNaira(total)]);
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Fees due on termination'),
    h('table', { class: 'bridge' }, h('tbody', null, rows.map(([k, v], i) => h('tr', { class: i === rows.length - 1 ? 'total' : null }, h('td', null, k), h('td', { class: 'num' }, v))))),
    h('p', { class: 'muted small' }, 'Clause 12: the management fee for the part quarter is the quarterly rate ÷ 3 for each month or part month. The incentive for the final period uses the benchmark of the quarter it falls in.')));

  // End-Date Portfolio.
  const held = [...t.holdings].sort((a, b) => ((a.inst.maturityDate ?? '9999') < (b.inst.maturityDate ?? '9999') ? -1 : 1));
  const hRows = held.map(({ inst, value }) => h('tr', null,
    h('td', null, TYPE_LABELS[inst.type]), h('td', null, counterpartyName(inst, data.funds)), h('td', null, inst.custodianName ?? ''),
    h('td', null, fmtDate(inst.valueDate)), h('td', null, inst.maturityDate ? fmtDate(inst.maturityDate) : 'Open'),
    h('td', { class: 'num' }, inst.type === 'money_market_fund' ? '—' : fmtNaira(inst.faceValue ?? expectedMaturityValue(inst))),
    h('td', { class: 'num' }, fmtNaira(value))));
  hRows.push(h('tr', null, h('td', null, 'Cash at bank'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, fmtNaira(t.cash))));
  hRows.push(h('tr', { class: 'total' }, h('td', { colspan: 6 }, 'Net asset value'), h('td', { class: 'num' }, fmtNaira(t.nav))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, `End-Date Portfolio at ${fmtDate(t.date)}`),
      excelButton('Download Excel', () => `ABUD end-date portfolio ${t.date}.xlsx`, () => workbook(data, t, held, rows))),
    table(['Instrument', 'Counterparty', 'Custodian', 'Value date', 'Maturity', { label: 'At maturity', num: true }, { label: `Value at ${fmtDate(t.date)}`, num: true }], hRows),
    h('p', { class: 'muted small' }, 'Clause 13: holdings are handed over as they stand, or liquidated on instruction. Values are amortised cost and accrued interest at the determination date.')));
  return h('div', null, parts);
}

function workbook(data, t, held, feeRows) {
  const p = [['Instrument', 'Counterparty', 'Custodian', 'Value date', 'Maturity', 'Cost', 'At maturity', `Value at ${t.date}`]];
  for (const { inst, value } of held) {
    p.push([TYPE_LABELS[inst.type], counterpartyName(inst, data.funds), inst.custodianName ?? '', xDate(inst.valueDate), xDate(inst.maturityDate), xMoney(inst.cost), inst.type === 'money_market_fund' ? '' : xMoney(inst.faceValue ?? expectedMaturityValue(inst)), xMoney(value)]);
  }
  p.push(['Cash at bank', '', '', '', '', '', '', xMoney(t.cash)], ['Net asset value', '', '', '', '', '', '', xMoney(t.nav)]);
  return [{ name: 'End-Date Portfolio', rows: p }, { name: 'Fees due', rows: [['Item', 'Value'], ...feeRows], widths: [80, 22] }];
}
