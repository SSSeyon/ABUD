// One holding's statement, day by day: opening balance, money in, money out, income and closing balance,
// for its whole life to date or the shared period. Opens from Holdings (click a row) and the daily NAV make-up.
import { addDays, dec, ZERO } from '../../engine/index.js';
import { positionStatement } from '../daily.js';
import { DEPOSIT_TYPES, positionsFor, TYPE_LABELS } from '../portfolio.js';
import { resolvePeriod, sharedPeriod } from '../period.js';
import { state } from '../store.js';
import { excelButton, fmtDate, fmtNaira, fmtPct, h, todayISO, xDate, xMoney } from '../ui.js';

export function openHoldingStatement(positionId) {
  const data = state.data;
  const pos = positionsFor(data).byId.get(positionId);
  if (!pos) return;
  const today = todayISO();
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), today);
  const lifeEnd = pos.end ? addDays(pos.end, 0) : today;
  const range = { key: 'life' };
  const dialog = h('dialog', { class: 'modal wide', 'aria-label': pos.label });
  const body = h('div', { class: 'stmt-body' });

  const draw = () => {
    let start = pos.start;
    let end = lifeEnd < today ? lifeEnd : today;
    if (range.key === 'period') {
      const p = resolvePeriod(sharedPeriod, inception, today);
      start = p.start > start ? p.start : start;
      end = p.end < end ? p.end : end;
    }
    if (start > end) { body.replaceChildren(h('p', { class: 'muted' }, 'The holding was not held in the chosen period.')); return; }
    let st;
    try { st = positionStatement(data, positionId, start, end); } catch (err) { body.replaceChildren(h('p', { class: 'bad' }, err.message)); return; }
    const rows = st.rows;
    const t = st.total ?? { open: ZERO, in: ZERO, out: ZERO, income: ZERO, close: ZERO };
    const kpi = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
    const cell = (x, cls) => h('td', { class: `num ${cls ?? ''}` }, x && !dec(x).isZero() ? fmtNaira(x) : '—');
    const MAX = 1200;
    const shown = rows.length > MAX ? rows.slice(-MAX) : rows;
    body.replaceChildren(...[
      h('div', { class: 'stats' }, kpi('Opening balance', fmtNaira(t.open)), kpi('Inflows', fmtNaira(t.in)), kpi('Withdrawals', fmtNaira(t.out)),
        kpi('Income', fmtNaira(t.income)), kpi('Closing balance', fmtNaira(rows.at(-1)?.close ?? t.close))),
      h('p', { class: 'muted small' }, `${fmtDate(start)} to ${fmtDate(end)} · ${rows.length} days. Inflows are money placed or subscribed (and balances moved onto a fund statement); withdrawals are maturities, redemptions and interest paid out. Income = closing − opening − inflows + withdrawals.`),
      rows.length > MAX ? h('p', { class: 'muted small' }, `Showing the last ${MAX} days; the Excel file has all of them.`) : null,
      h('div', { class: 'table-wrap stmt-table' }, h('table', null,
        h('thead', null, h('tr', null, ['Date', 'Opening', 'Inflows', 'Withdrawals', 'Income', 'Closing'].map((x, i) => h('th', { class: i ? 'num' : null }, x)))),
        h('tbody', null, shown.map((r) => h('tr', null, h('td', null, fmtDate(r.date)), cell(r.open), cell(r.in), cell(r.out), cell(r.income, r.income.isNegative() ? 'neg' : ''), cell(r.close))),
          h('tr', { class: 'total' }, h('td', null, 'Period'), cell(t.open), cell(t.in), cell(t.out), cell(t.income), cell(rows.at(-1)?.close ?? t.close))))),
    ].filter(Boolean));
    excel.replaceChildren(excelButton('Download Excel', `ABUD ${pos.label.replace(/[^\w ]+/g, ' ').replace(/\s+/g, ' ').trim()} ${start} to ${end}.xlsx`, () => [{
      name: 'Statement',
      rows: [['Date', 'Opening', 'Inflows', 'Withdrawals', 'Income', 'Closing'], ...rows.map((r) => [xDate(r.date), xMoney(r.open), xMoney(r.in), xMoney(r.out), xMoney(r.income), xMoney(r.close)]),
        ['Period', xMoney(t.open), xMoney(t.in), xMoney(t.out), xMoney(t.income), xMoney(rows.at(-1)?.close ?? t.close)]],
    }]));
  };

  const inst = pos.inst;
  const fund = (data.funds ?? []).find((f) => f.id === inst.fundId);
  const facts = [
    TYPE_LABELS[inst.type] + (fund ? ` · ${fund.name}` : ''),
    inst.counterpartyName,
    inst.statement ? 'Valued at the platform statement balance' : null,
    inst.cost && !inst.statement ? `Principal ${fmtNaira(inst.cost)}` : null,
    DEPOSIT_TYPES.has(inst.type) && inst.rate ? `${fmtPct(inst.rate, 2)} p.a.` : null,
    inst.valueDate ? `from ${fmtDate(inst.valueDate)}` : null,
    inst.maturityDate ? `to ${fmtDate(inst.maturityDate)}` : 'open-ended',
  ].filter(Boolean).join(' · ');
  const excel = h('span');
  const choice = h('div', { class: 'seg', role: 'group', 'aria-label': 'Dates' },
    [['life', 'Whole life to date'], ['period', 'Chosen period']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(range.key === k), onclick: (e) => {
      range.key = k;
      for (const b of choice.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      draw();
    } }, l)));
  dialog.append(
    h('div', { class: 'stmt-head' }, h('div', null, h('h2', null, pos.label), h('p', { class: 'muted small' }, facts)),
      h('button', { class: 'icon-close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('div', { class: 'toolbar' }, choice, excel),
    body);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  draw();
  dialog.showModal();
}
