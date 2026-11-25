import { BusinessCalendar, daysBetween, managementFeeForPeriod, quarterOf, timeWeightedReturn } from '../../engine/index.js';
import { expectedMaturityValue, mandateOn, maturityWatch, navSeries, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { fmtDate, fmtNaira, fmtPct, h, table, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms'];

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
}

export function dashboardView() {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();

  let rows;
  try {
    rows = navSeries(data, today);
  } catch (err) {
    return h('div', { class: 'card bad' }, h('h2', null, 'NAV could not be calculated'), h('p', null, err.message));
  }

  const parts = [h('h1', null, 'Dashboard')];
  if (!rows.length) {
    parts.push(h('div', { class: 'card' }, h('p', null, 'No transactions yet. Record the opening inflow under Transactions.')));
  } else {
    const last = rows[rows.length - 1];
    const q = quarterOf(today);
    const qRows = rows.filter((r) => r.date >= q.start);
    // NAV at the end of the day before the quarter opens the return; none if the portfolio started this quarter.
    const before = rows.filter((r) => r.date < q.start).at(-1);
    const arip = timeWeightedReturn(qRows, before ? before.nav : 0);
    const terms = mandateOn(data, today);
    const fee = terms ? managementFeeForPeriod(rows, q.start, today, terms.mgmtFeeRate, new BusinessCalendar()) : null;

    parts.push(
      h(
        'div',
        { class: 'stats' },
        stat('NAV today', fmtNaira(last.nav), `Gross of fees · ${fmtDate(today)}`),
        stat('Cash', fmtNaira(last.cash)),
        stat('Holdings', fmtNaira(last.holdingsValue)),
        stat(`${q.label} return to date`, fmtPct(arip), 'Time-weighted, gross of fees'),
        stat(`${q.label} management fee accrued`, fee ? fmtNaira(fee.posted) : '—', terms ? `${fmtPct(terms.mgmtFeeRate)} p.a.` : 'Set mandate terms in Settings'),
      ),
    );
  }

  const { due, overdue } = maturityWatch(data, today, 14);
  const matRow = (i, late) =>
    h(
      'tr',
      { class: late ? 'bad' : null },
      h('td', null, fmtDate(i.maturityDate)),
      h('td', null, late ? `${-daysBetween(today, i.maturityDate)} days overdue` : `${daysBetween(today, i.maturityDate)} days`),
      h('td', null, TYPE_LABELS[i.type]),
      h('td', null, i.counterpartyName ?? ''),
      h('td', { class: 'num' }, fmtNaira(expectedMaturityValue(i))),
    );
  parts.push(
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'Maturities: next 14 days'),
      overdue.length ? h('p', { class: 'bad' }, `${overdue.length} matured with no maturity recorded. Record them under Holdings.`) : null,
      table(
        ['Maturity', 'When', 'Instrument', 'Counterparty', { label: 'Expected cash', num: true }],
        [...overdue.map((i) => matRow(i, true)), ...due.map((i) => matRow(i, false))],
        'No maturities in the next 14 days.',
      ),
    ),
  );
  return h('div', null, parts);
}
