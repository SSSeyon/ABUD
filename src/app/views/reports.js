// Period report: pick a period, see NAV movement, return, income by asset class, transactions and holdings.
import { addDays, dec } from '../../engine/index.js';
import { periodPicker, resolvePeriod, sharedPeriod } from '../period.js';
import { allocationBar, lineChart } from '../charts.js';
import { ASSET_CLASSES, CLASS_LABELS, holdingsOn, periodReport, txClass, TX_LABELS, TX_SIGN, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, fmtDate, fmtNaira, fmtPct, h, table, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices'];
const sel = { cls: '' };

function firstDate(data) {
  return (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
}


export function reportsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const inception = firstDate(data);
  if (!inception) return h('div', null, h('h1', null, 'Reports'), h('div', { class: 'card' }, h('p', null, 'No transactions yet.')));

  const period = resolvePeriod(sharedPeriod, inception, today);
  const { start, end } = period;
  const picker = h('div', { class: 'toolbar no-print' }, periodPicker(sharedPeriod, inception, today, rerender), h('button', { onclick: () => window.print() }, 'Print / PDF'));

  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, `Portfolio report: ${period.key === 'custom' ? 'custom period' : period.label}`), h('p', { class: 'subtitle' }, `Access Holdings Plc unclaimed dividend portfolio · ${fmtDate(start)} to ${fmtDate(end)}`)));
  if (!start || !end || start > end) return h('div', null, head, picker, h('div', { class: 'card' }, h('p', null, 'Choose a start date on or before the end date.')));

  let r;
  try {
    r = periodReport(data, start, end);
  } catch (err) {
    return h('div', null, head, picker, h('div', { class: 'card bad' }, h('h2', null, 'The report could not be calculated'), h('p', null, err.message)));
  }

  const kpi = (label, value, note, tone) => h('div', { class: `stat ${tone ?? ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  const signTone = (x) => (x.isNegative() ? 'down' : 'up');

  // Summary: how NAV moved.
  const bridge = [
    ['Opening NAV', r.openingNav, `End of ${fmtDate(addDays(start, -1))}`],
    ['Inflows from Access', r.inflows],
    ['Withdrawals', r.withdrawals.negated()],
    ['Fees and bank charges', r.fees.negated()],
    ['Investment income', r.income, 'Interest, discount accretion and fund yield, net of losses'],
    ['Closing NAV', r.closingNav, `End of ${fmtDate(end)}`],
  ];

  const classRows = r.classes.map((c) =>
    h('tr', null,
      h('td', null, classTag(c.key, c.label)),
      h('td', { class: 'num' }, fmtNaira(c.opening)),
      h('td', { class: 'num' }, c.key === 'cash' ? '' : fmtNaira(c.invested)),
      h('td', { class: 'num' }, c.key === 'cash' ? '' : fmtNaira(c.returned)),
      h('td', { class: `num ${c.income.isNegative() ? 'neg' : ''}` }, c.key === 'cash' ? '' : fmtNaira(c.income)),
      h('td', { class: 'num' }, c.yield ? fmtPct(c.yield, 2) : ''),
      h('td', { class: 'num' }, fmtNaira(c.closing))));
  const totals = r.classes.reduce((t, c) => ({ opening: t.opening.plus(c.opening), closing: t.closing.plus(c.closing) }), { opening: dec(0), closing: dec(0) });
  classRows.push(h('tr', { class: 'total' }, h('td', null, 'Portfolio'), h('td', { class: 'num' }, fmtNaira(totals.opening)), h('td'), h('td'), h('td', { class: 'num' }, fmtNaira(r.income)), h('td', { class: 'num' }, r.annualised ? fmtPct(r.annualised, 2) : ''), h('td', { class: 'num' }, fmtNaira(totals.closing))));

  // Transactions in the period, filterable by class.
  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const txs = sel.cls ? r.transactions.filter((t) => txClass(t, instruments) === sel.cls) : r.transactions;
  const chip = (key, label, n) => h('button', { class: `chip ${sel.cls === key ? 'active' : ''}`, 'aria-pressed': String(sel.cls === key), onclick: () => { sel.cls = key; rerender(); } },
    key ? h('span', { class: 'swatch', style: `background:var(--class-${key})` }) : null, label, h('span', { class: 'chip-count' }, String(n)));
  const txRows = txs.map((t) => {
    const signed = t.type === 'rollover' ? dec(t.amount) : dec(t.amount).times(TX_SIGN[t.type] ?? 1);
    const inst = t.instrumentId ? instruments.get(t.instrumentId) : null;
    return h('tr', null,
      h('td', null, fmtDate(t.date)),
      h('td', null, TX_LABELS[t.type] ?? t.type),
      h('td', null, classTag(txClass(t, instruments), CLASS_LABELS[txClass(t, instruments)])),
      h('td', null, inst?.counterpartyName ?? '', t.reference ? h('div', { class: 'muted' }, t.reference) : null),
      h('td', { class: `num ${signed.isNegative() ? 'neg' : ''}` }, fmtNaira(signed)));
  });

  // Holdings at the end of the period.
  const held = holdingsOn(data, end);
  const heldByClass = ASSET_CLASSES.filter((c) => c.key !== 'cash').map((c) => ({ ...c, value: held.filter((x) => x.inst?.type === c.key).reduce((t, x) => t.plus(x.value), dec(0)) }));
  const closingCash = r.classes.find((c) => c.key === 'cash')?.closing ?? dec(0);
  const holdRows = held
    .sort((a, b) => ASSET_CLASSES.findIndex((c) => c.key === a.inst.type) - ASSET_CLASSES.findIndex((c) => c.key === b.inst.type) || ((a.inst.maturityDate ?? '9') < (b.inst.maturityDate ?? '9') ? -1 : 1))
    .map(({ inst, value }) => h('tr', null,
      h('td', null, classTag(inst.type, TYPE_LABELS[inst.type])),
      h('td', null, inst.counterpartyName ?? ''),
      h('td', { class: 'num' }, fmtNaira(inst.cost)),
      h('td', null, fmtDate(inst.valueDate)),
      h('td', null, inst.maturityDate ? fmtDate(inst.maturityDate) : 'Open'),
      h('td', { class: 'num' }, fmtNaira(value))));

  return h(
    'div',
    { class: 'report' },
    head,
    picker,
    h('div', { class: 'stats' },
      kpi('Closing NAV', fmtNaira(r.closingNav), `Opening ${fmtNaira(r.openingNav)}`),
      kpi('Investment income', fmtNaira(r.income), `${r.days} days`, signTone(r.income)),
      kpi('Return for the period', fmtPct(r.twr, 2), 'Time-weighted, gross of fees', signTone(r.twr)),
      kpi('Annualised', r.annualised ? fmtPct(r.annualised, 2) : '—', 'Compounded over 365 days'),
      kpi('Net flows', fmtNaira(r.netFlow), 'Inflows less withdrawals and fees')),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h2', null, 'NAV over the period'), lineChart(r.rows.map((x) => ({ date: x.date, value: x.nav })), { label: 'NAV' })),
      h('section', { class: 'card' }, h('h2', null, 'How NAV moved'),
        h('table', { class: 'bridge' }, h('tbody', null, bridge.map(([label, v, note], i) =>
          h('tr', { class: i === 0 || i === bridge.length - 1 ? 'total' : null },
            h('td', null, label, note ? h('div', { class: 'muted small' }, note) : null),
            h('td', { class: `num ${v.isNegative() ? 'neg' : ''}` }, fmtNaira(v)))))))),
    h('section', { class: 'card' }, h('h2', null, 'By asset class'),
      h('p', { class: 'muted small' }, 'Income = closing value − opening value − money invested + money returned. Yield is income over the average value held, annualised.'),
      table(['Asset class', { label: 'Opening value', num: true }, { label: 'Invested', num: true }, { label: 'Returned', num: true }, { label: 'Income', num: true }, { label: 'Yield p.a.', num: true }, { label: 'Closing value', num: true }], classRows)),
    h('section', { class: 'card' }, h('h2', null, `Allocation at ${fmtDate(end)}`), allocationBar([...heldByClass, { key: 'cash', label: CLASS_LABELS.cash, value: closingCash }])),
    h('section', { class: 'card' },
      h('div', { class: 'page-head' }, h('h2', null, `Transactions (${txs.length})`)),
      h('div', { class: 'chips no-print', role: 'group', 'aria-label': 'Asset class' }, chip('', 'All', r.transactions.length), ASSET_CLASSES.filter((c) => r.counts[c.key]).map((c) => chip(c.key, c.label, r.counts[c.key]))),
      table(['Date', 'Type', 'Asset class', 'Counterparty / reference', { label: 'Cash effect', num: true }], txRows, 'No transactions in this period.')),
    h('section', { class: 'card' }, h('h2', null, `Holdings at ${fmtDate(end)}`),
      table(['Instrument', 'Counterparty', { label: 'Cost', num: true }, 'Value date', 'Maturity', { label: 'Value', num: true }], holdRows, 'Nothing held at the end of the period.')),
  );
}
