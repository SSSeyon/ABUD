// Daily NAV make-up for the chosen period: each day's opening NAV, flows from and to Access, income from every
// investment (or asset class), and closing NAV; or each investment's value that day. Click an investment for its
// own daily statement.
import { dec, ZERO } from '../../engine/index.js';
import { segmented } from '../charts.js';
import { dailyBreakdown } from '../daily.js';
import { periodPicker, resolvePeriod, sharedPeriod } from '../period.js';
import { ASSET_CLASSES, CLASS_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, excelButton, fmtDate, foldCard, fmtNaira, h, table, todayISO, xDate, xMoney } from '../ui.js';
import { openHoldingStatement } from './holdingdetail.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];
const view = { show: 'income', by: 'investment' };
let cache = { key: null, value: null };
const MAX_ROWS = 400;

function compute(data, start, end) {
  const key = [data.transactions, data.instruments, data.fundPrices, data.funds, start, end];
  if (cache.key && cache.key.every((v, i) => v === key[i])) return cache.value;
  const value = dailyBreakdown(data, start, end);
  cache = { key, value };
  return value;
}

export function navDailyView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Daily NAV make-up'),
    h('p', { class: 'subtitle' }, 'What NAV was made of each day, and the income from each investment')));
  if (!inception) return h('div', null, head, h('div', { class: 'card' }, h('p', null, 'No transactions yet.')));
  const period = resolvePeriod(sharedPeriod, inception, today);
  let b;
  try { b = compute(data, period.start, period.end); } catch (err) {
    console.error(err);
    return h('div', null, head, h('div', { class: 'card bad' }, h('p', null, err.message)));
  }

  // Columns: each investment active in the period, or each asset class.
  const active = b.positions.filter((p) => b.days.some((d) => d.byPos.has(p.id)));
  const order = (p) => ASSET_CLASSES.findIndex((c) => c.key === p.type);
  active.sort((x, y) => order(x) - order(y) || (x.start < y.start ? -1 : 1));
  const classes = ASSET_CLASSES.filter((c) => c.key !== 'cash' && active.some((p) => p.type === c.key));
  const cols = view.by === 'class'
    ? classes.map((c) => ({ id: c.key, label: c.label, key: c.key, members: active.filter((p) => p.type === c.key).map((p) => p.id) }))
    : active.map((p) => ({ id: p.id, label: p.label, key: p.type, members: [p.id], position: p }));
  const field = view.show === 'income' ? 'income' : 'close';
  const cellOf = (d, col) => col.members.reduce((t, id) => t.plus(d.byPos.get(id)?.[field] ?? ZERO), ZERO);

  const toolbar = h('div', { class: 'toolbar no-print' }, periodPicker(sharedPeriod, inception, today, rerender),
    h('div', { class: 'row-actions' },
      segmented([['income', 'Income'], ['value', 'Value']], view.show, (v) => { view.show = v; rerender(); }, 'Show'),
      segmented([['investment', 'By investment'], ['class', 'By asset class']], view.by, (v) => { view.by = v; rerender(); }, 'Columns'),
      excelButton('Download Excel', () => `ABUD daily NAV ${period.start} to ${period.end}.xlsx`, () => workbook(b, active, classes))));

  // Period summary per investment.
  const totalIncome = b.days.reduce((t, d) => t.plus(d.income), ZERO);
  const sumRows = active.map((p) => {
    const t = b.totals.get(p.id);
    return h('tr', { class: 'clickable', tabindex: 0, onclick: () => openHoldingStatement(p.id), onkeydown: (e) => { if (e.key === 'Enter') openHoldingStatement(p.id); }, title: 'Open the daily statement' },
      h('td', null, classTag(p.type, p.label)),
      h('td', { class: 'num' }, fmtNaira(t.open)), h('td', { class: 'num' }, fmtNaira(t.in)), h('td', { class: 'num' }, fmtNaira(t.out)),
      h('td', { class: `num ${t.income.isNegative() ? 'neg' : ''}` }, fmtNaira(t.income)), h('td', { class: 'num' }, fmtNaira(t.close)),
      h('td', { class: 'num' }, totalIncome.isZero() ? '' : `${t.income.div(totalIncome).times(100).toFixed(1)}%`));
  });
  if (active.length) sumRows.push(h('tr', { class: 'total' }, h('td', null, 'All investments'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, fmtNaira(totalIncome)), h('td'), h('td')));

  // The daily table.
  const first = b.days[0];
  const lastDay = b.days.at(-1);
  const days = b.days.length > MAX_ROWS ? b.days.slice(-MAX_ROWS) : b.days;
  const num = (x, neg) => h('td', { class: `num ${neg && x.isNegative() ? 'neg' : ''}` }, x.isZero() ? '—' : fmtNaira(x));
  const headCells = view.show === 'income'
    ? ['Date', 'Opening NAV', 'Inflows', 'Withdrawals and fees', ...cols.map((c) => c.label), 'Total income', 'Closing NAV']
    : ['Date', ...cols.map((c) => c.label), 'Cash', 'NAV'];
  const bodyRows = days.map((d) => h('tr', null,
    h('td', { class: 'sticky-col' }, fmtDate(d.date)),
    view.show === 'income'
      ? [num(d.openNav ?? ZERO), num(d.inflows), num(d.withdrawals.plus(d.fees)), cols.map((c) => num(cellOf(d, c), true)), num(d.income, true), num(d.closeNav ?? ZERO)]
      : [cols.map((c) => num(cellOf(d, c))), num(d.closeCash ?? ZERO), num(d.closeNav ?? ZERO)]));
  const dailyTable = h('div', { class: 'table-wrap daily-table' }, h('table', null,
    h('thead', null, h('tr', null, headCells.map((x, i) => {
      const col = view.show === 'income' ? cols[i - 4] : cols[i - 1];
      return h('th', { class: `${i ? 'num' : 'sticky-col'}`, title: typeof x === 'string' ? x : null },
        col?.position ? h('button', { class: 'link th-link', onclick: () => openHoldingStatement(col.position.id) }, x) : x);
    }))),
    h('tbody', null, bodyRows)));

  return h('div', null, head, toolbar,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Opening NAV'), h('div', { class: 'stat-value' }, fmtNaira(first?.openNav ?? ZERO)), h('div', { class: 'stat-note' }, fmtDate(period.start))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Income'), h('div', { class: 'stat-value' }, fmtNaira(totalIncome)), h('div', { class: 'stat-note' }, `${b.days.length} days · ${active.length} investments`)),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Net flows'), h('div', { class: 'stat-value' }, fmtNaira(b.days.reduce((t, d) => t.plus(d.inflows).minus(d.withdrawals).minus(d.fees), ZERO))), h('div', { class: 'stat-note' }, 'Inflows less withdrawals and fees')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Closing NAV'), h('div', { class: 'stat-value' }, fmtNaira(lastDay?.closeNav ?? ZERO)), h('div', { class: 'stat-note' }, fmtDate(period.end)))),
    h('section', { class: 'card' }, h('h2', null, `Income by investment: ${fmtDate(period.start)} – ${fmtDate(period.end)}`),
      h('p', { class: 'muted small' }, 'Income = closing − opening − money in + money out. Click an investment for its daily statement.'),
      table(['Investment', { label: 'Opening', num: true }, { label: 'Money in', num: true }, { label: 'Money out', num: true }, { label: 'Income', num: true }, { label: 'Closing', num: true }, { label: 'Share', num: true }], sumRows, 'No investments held in this period.')),
    foldCard(view.show === 'income' ? 'Day by day: where NAV came from' : 'Day by day: what NAV was made of', `${b.days.length} days`,
      b.days.length > MAX_ROWS ? h('p', { class: 'muted small' }, `Showing the last ${MAX_ROWS} of ${b.days.length} days; the Excel file has every day.`) : null,
      h('p', { class: 'muted small' }, view.show === 'income'
        ? 'Each day: opening NAV + inflows − withdrawals and fees + income = closing NAV.'
        : 'Each investment\'s value at the end of the day; with cash they add up to NAV.'),
      dailyTable));
}

function workbook(b, active, classes) {
  const head = ['Date', 'Opening NAV', 'Inflows', 'Withdrawals', 'Fees'];
  const byInv = [[...head, ...active.map((p) => p.label), 'Total income', 'Closing NAV']];
  const values = [['Date', ...active.map((p) => p.label), 'Cash', 'NAV']];
  const byClass = [[...head, ...classes.map((c) => CLASS_LABELS[c.key]), 'Total income', 'Closing NAV']];
  for (const d of b.days) {
    const base = [xDate(d.date), xMoney(d.openNav), xMoney(d.inflows), xMoney(d.withdrawals), xMoney(d.fees)];
    byInv.push([...base, ...active.map((p) => xMoney(d.byPos.get(p.id)?.income ?? ZERO)), xMoney(d.income), xMoney(d.closeNav)]);
    values.push([xDate(d.date), ...active.map((p) => xMoney(d.byPos.get(p.id)?.close ?? ZERO)), xMoney(d.closeCash), xMoney(d.closeNav)]);
    byClass.push([...base, ...classes.map((c) => xMoney(active.filter((p) => p.type === c.key).reduce((t, p) => t.plus(d.byPos.get(p.id)?.income ?? ZERO), dec(0)))), xMoney(d.income), xMoney(d.closeNav)]);
  }
  const summary = [['Investment', 'Class', 'Opening', 'Money in', 'Money out', 'Income', 'Closing']];
  for (const p of active) {
    const t = b.totals.get(p.id);
    summary.push([p.label, CLASS_LABELS[p.type], xMoney(t.open), xMoney(t.in), xMoney(t.out), xMoney(t.income), xMoney(t.close)]);
  }
  return [{ name: 'Summary', rows: summary }, { name: 'Daily income by investment', rows: byInv }, { name: 'Daily income by class', rows: byClass }, { name: 'Daily value by investment', rows: values }];
}
