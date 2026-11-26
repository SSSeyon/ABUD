// Upload a money market fund statement (the Excel file from the investment platform). Shows what was read and
// what will be saved, checked against what the app holds, before anything is written.
import { ZERO } from '../../engine/index.js';
import { importFundStatement } from '../actions.js';
import { closedQuarters } from '../close.js';
import { parseStatement, statementPlan } from '../fundstatement.js';
import { positionsFor } from '../portfolio.js';
import { state } from '../store.js';
import { errorText, fmtDate, fmtNaira, fmtPct, h, sheetJs, table, toast } from '../ui.js';

export function openFundUpload(presetFundId) {
  const data = state.data;
  const funds = data.funds ?? [];
  const dialog = h('dialog', { class: 'modal wide', 'aria-label': 'Upload fund statement' });
  const st = { fundId: presetFundId ?? (funds.length === 1 ? funds[0].id : ''), sheets: [], sheet: '', parsed: null, error: '', busy: false };
  const out = h('div', { class: 'upload-body' });

  const fundSel = h('select', { onchange: (e) => { st.fundId = e.target.value; draw(); } },
    h('option', { value: '' }, funds.length ? 'Choose the fund' : 'No funds yet: add them under Settings → Funds'),
    funds.map((f) => h('option', { value: f.id, selected: f.id === st.fundId ? true : null }, f.name)));
  const fileIn = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', onchange: (e) => load(e.target.files?.[0]) });
  const sheetSel = h('select', { onchange: (e) => { st.sheet = e.target.value; read(); draw(); } });

  async function load(file) {
    if (!file) return;
    st.error = ''; st.parsed = null; st.sheets = [];
    out.replaceChildren(h('p', { class: 'muted' }, 'Reading the file…'));
    try {
      const XLSX = await sheetJs();
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      st.sheets = wb.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }));
      // First sheet that reads as a statement, preferring one named after the fund.
      const fundName = (funds.find((f) => f.id === st.fundId)?.name ?? '').toLowerCase();
      const ok = st.sheets.filter((s) => { try { parseStatement(s.aoa); return true; } catch { return false; } });
      st.sheet = (ok.find((s) => fundName && s.name.toLowerCase().includes(fundName)) ?? ok[0] ?? st.sheets[0])?.name ?? '';
      if (!st.fundId) {
        const hay = `${file.name} ${st.sheet}`.toLowerCase();
        st.fundId = funds.find((f) => hay.includes(f.name.toLowerCase()))?.id ?? '';
        fundSel.value = st.fundId;
      }
      sheetSel.replaceChildren(...st.sheets.map((s) => h('option', { value: s.name, selected: s.name === st.sheet ? true : null }, s.name)));
      read();
    } catch (err) {
      st.error = `Could not read the file: ${errorText(err)}`;
    }
    draw();
  }

  function read() {
    st.parsed = null; st.error = '';
    const sh = st.sheets.find((s) => s.name === st.sheet);
    if (!sh) return;
    try { st.parsed = parseStatement(sh.aoa); } catch (err) { st.error = err.message; }
  }

  function draw() {
    if (st.error) { out.replaceChildren(h('p', { class: 'bad' }, st.error)); return; }
    if (!st.parsed) { out.replaceChildren(h('p', { class: 'muted' }, 'Choose the Excel file downloaded from the platform. The sheet needs a Date column and a Balance or Earnings column; Investment, Liquidation, Withdrawal and Rate columns are read when present.')); return; }
    if (!st.fundId) { out.replaceChildren(h('p', { class: 'muted' }, 'Choose which fund this statement is for.')); return; }
    const closed = closedQuarters(data).map((q) => q.end).sort();
    let plan;
    try { plan = statementPlan(data, st.fundId, st.parsed.rows, closed.at(-1) ?? null); } catch (err) { out.replaceChildren(h('p', { class: 'bad' }, err.message)); return; }
    // The app's value of this fund at the statement's last date, before the upload.
    let before = ZERO;
    try {
      for (const p of positionsFor(data).list) if (p.type === 'money_market_fund' && (p.inst.fundId === st.fundId)) before = before.plus(p.value(plan.last));
    } catch { before = null; }
    const diff = before === null ? null : plan.totals.closing.minus(before);
    const c = st.parsed.cols;
    const head = (i) => (i >= 0 ? st.parsed.headers[i] : '—');
    const kpi = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
    const lastRate = st.parsed.rows.at(-1).rate;
    out.replaceChildren(...[
      h('div', { class: 'stats' },
        kpi('Days', String(plan.rows), `${fmtDate(plan.first)} to ${fmtDate(plan.last)}`),
        kpi('Closing balance', fmtNaira(plan.totals.closing), `Rate ${fmtPct(lastRate, 2)}`),
        kpi('Earnings', fmtNaira(plan.totals.income)),
        kpi('In the app now', before === null ? '—' : fmtNaira(before), diff === null ? '' : `Difference ${fmtNaira(diff)}`)),
      h('p', { class: 'muted small' }, `Columns read: date "${head(c.date)}", investment "${head(c.subscription)}", liquidation/withdrawal ${c.redemption.length ? c.redemption.map((i) => `"${st.parsed.headers[i]}"`).join(' + ') : '—'}, rate "${head(c.rate)}", earnings "${head(c.income)}", balance "${head(c.balance)}".`),
      plan.skipped ? h('p', { class: 'card warn' }, `${plan.skipped} rows dated in closed quarters are left out, so closed figures stay as they were.`) : null,
      h('p', null, `From ${fmtDate(plan.first)} the fund is valued at the statement balance. Investments ${fmtNaira(plan.totals.subscriptions)}, liquidations and withdrawals ${fmtNaira(plan.totals.redemptions)}: ${plan.matched} already recorded, ${plan.newMovements.length} to add as new entries${plan.account ? ' (on a new fund account holding)' : ''}.`),
      plan.newMovements.length ? table(['Date', 'Entry', { label: 'Amount', num: true }],
        plan.newMovements.slice(0, 50).map((m) => h('tr', null, h('td', null, fmtDate(m.date)), h('td', null, m.type === 'fund_subscription' ? 'Subscription (cash out)' : 'Redemption (cash in)'), h('td', { class: 'num' }, fmtNaira(m.amount)))), '') : null,
      plan.unmatchedRecorded.length
        ? h('div', { class: 'card warn' }, h('strong', null, `${plan.unmatchedRecorded.length} recorded entries for this fund in these dates are not on the statement.`),
            h('p', { class: 'small' }, 'They still move cash. If the statement is right, delete or correct them under Transactions after the upload: ', plan.unmatchedRecorded.slice(0, 8).map((t) => `${t.date} ${t.type === 'fund_subscription' ? 'subscription' : 'redemption'} ${fmtNaira(t.amount)}`).join('; '), plan.unmatchedRecorded.length > 8 ? '…' : ''))
        : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            await importFundStatement(plan, (n, total) => { b.textContent = `Saving ${n} of ${total}…`; });
            toast(`${plan.fund.name}: ${plan.rows} days saved${plan.newMovements.length ? `, ${plan.newMovements.length} entries added` : ''}.`);
            dialog.close();
          } catch (err) {
            toast(errorText(err), 'bad');
            b.disabled = false; b.textContent = 'Save statement';
          }
        } }, 'Save statement'))].filter(Boolean));
  }

  dialog.append(
    h('div', { class: 'stmt-head' }, h('div', null, h('h2', null, 'Upload fund statement'), h('p', { class: 'muted small' }, 'The money market fund statement from the investment platform (Excel). Nothing is saved until you confirm.')),
      h('button', { class: 'icon-close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('div', { class: 'upload-fields' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Fund'), fundSel),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Statement file'), fileIn),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Sheet'), sheetSel)),
    out);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  draw();
  dialog.showModal();
}
