// Bank reconciliation: upload the bank statement, see which lines match recorded entries, record the ones that
// don't, and compare the bank balance with the app's cash day by day. A summary can be saved (bankRecs/{end date}).
import { saveDoc } from '../actions.js';
import { parseBankStatement, reconcile, suggestType } from '../bankrec.js';
import { TX_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { errorText, fmtDate, fmtNaira, foldCard, h, runAction, sheetJs, table, todayISO } from '../ui.js';
import { openEntry, transactionForm } from './transactions.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];
/** The loaded statement stays while the app is open, so recording a missing line re-runs the match at once. */
const st = { fileName: '', sheets: [], sheet: '', parsed: null, error: '', days: 3 };

const signed = (x) => h('span', { class: x.isNegative() ? 'neg' : null }, fmtNaira(x));

export function bankRecView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const fileIn = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', 'aria-label': 'Bank statement file', onchange: (e) => load(e.target.files?.[0], rerender) });
  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Bank reconciliation'),
      h('p', { class: 'subtitle' }, 'Upload the bank statement (Excel or CSV from the bank). Each line is matched to a recorded entry; nothing is saved unless you record an entry or save the reconciliation.')),
    h('label', { class: 'button-link primary file-btn' }, st.parsed ? 'Upload another statement' : 'Upload bank statement', fileIn));

  const parts = [head];
  if (st.error) parts.push(h('div', { class: 'card bad' }, h('p', null, st.error)));
  if (st.parsed) parts.push(...results(data, rerender));
  else if (!st.error) parts.push(h('div', { class: 'card' }, h('p', null, 'The statement needs a Date (or Value Date) column and Debit and Credit columns, or one signed Amount column. Narration and Balance columns are read when present; with a balance the app also checks its cash against the bank day by day.')));
  parts.push(pastCard(data));
  return h('div', null, parts);
}

async function load(file, rerender) {
  if (!file) return;
  Object.assign(st, { fileName: file.name, sheets: [], sheet: '', parsed: null, error: '' });
  try {
    const XLSX = await sheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    st.sheets = wb.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }));
    const ok = st.sheets.find((s) => { try { parseBankStatement(s.aoa); return true; } catch { return false; } });
    st.sheet = (ok ?? st.sheets[0])?.name ?? '';
    read();
  } catch (err) {
    st.error = `Could not read the file: ${errorText(err)}`;
  }
  rerender();
}

function read() {
  st.parsed = null; st.error = '';
  const sh = st.sheets.find((s) => s.name === st.sheet);
  if (!sh) return;
  try { st.parsed = parseBankStatement(sh.aoa); } catch (err) { st.error = `${st.fileName}, sheet "${st.sheet}": ${err.message}`; }
}

function results(data, rerender) {
  const p = st.parsed;
  let r;
  try { r = reconcile(data, p.rows, { days: st.days, opening: p.opening }); } catch (err) { return [h('div', { class: 'card bad' }, h('p', null, err.message))]; }
  const kpi = (label, value, note, tone) => h('div', { class: `stat ${tone ?? ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  const balanced = r.closing?.diff != null && r.closing.diff.abs().lte(1);
  const head = (i) => (i >= 0 ? `"${p.headers[i]}"` : '—');
  const c = p.cols;

  const controls = h('div', { class: 'toolbar no-print' },
    st.sheets.length > 1 ? h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Sheet'),
      h('select', { class: 'period-select', onchange: (e) => { st.sheet = e.target.value; read(); rerender(); } },
        st.sheets.map((s) => h('option', { value: s.name, selected: s.name === st.sheet ? true : null }, s.name)))) : null,
    h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Dates may differ by'),
      h('select', { class: 'period-select', onchange: (e) => { st.days = Number(e.target.value); rerender(); } },
        [0, 1, 2, 3, 5, 7].map((d) => h('option', { value: String(d), selected: d === st.days ? true : null }, d === 0 ? 'Same day only' : `Up to ${d} day${d > 1 ? 's' : ''}`)))),
    h('span', { class: 'muted small' }, `${st.fileName} · columns: date ${c.valueDate >= 0 ? head(c.valueDate) : head(c.date)}, ${c.debit >= 0 ? `debit ${head(c.debit)}, credit ${head(c.credit)}` : `amount ${head(c.amount)}`}, narration ${head(c.description)}, balance ${head(c.balance)}`));

  const stats = h('div', { class: 'stats' },
    kpi('Statement', `${r.lines} lines`, `${fmtDate(r.start)} to ${fmtDate(r.end)}`),
    kpi('Matched', `${r.matched.length + r.netted.filter((n) => n.line).length} of ${r.lines}`, r.netted.length ? `${r.netted.length} maturity and reinvestment pairs netted by the bank` : 'Same direction, within ₦1'),
    kpi('Bank closing balance', r.closing ? fmtNaira(r.closing.bank) : '—', r.closing ? fmtDate(r.end) : 'No Balance column'),
    kpi('Cash in the app', r.closing?.app != null ? fmtNaira(r.closing.app) : '—', r.closing?.app != null ? fmtDate(r.end) : ''),
    kpi('Difference', r.closing?.diff != null ? fmtNaira(r.closing.diff) : '—', balanced ? 'Bank and app agree' : r.closing?.diff != null ? 'Bank less app' : '', balanced ? 'up' : r.closing?.diff != null ? 'down' : null));

  const bankRows = r.bankOnly.map((l) => {
    const type = suggestType(l);
    return h('tr', null,
      h('td', null, fmtDate(l.date)),
      h('td', null, l.description || '—', l.reference ? h('div', { class: 'muted small' }, l.reference) : null),
      h('td', { class: 'num' }, signed(l.amount)),
      h('td', null, h('button', { onclick: () => transactionForm(data, null, {
        type, date: l.date, amount: l.amount.abs().toFixed(2), reference: l.reference, notes: l.description,
        intro: `From the bank statement, line ${l.line}. Check the type: it is a guess from the narration. Investments go through Holdings → New deal.`,
      }) }, `Record as ${(TX_LABELS[type] ?? type).toLowerCase()}`)));
  });
  const appRows = r.appOnly.map((m) => h('tr', { class: 'clickable', tabindex: 0, title: 'Open this entry', onclick: () => openEntry(data, m.tx) },
    h('td', null, fmtDate(m.date)), h('td', null, TX_LABELS[m.tx.type] ?? m.tx.type),
    h('td', null, m.tx.reference ?? '', m.tx.notes ? h('div', { class: 'muted small' }, m.tx.notes) : null),
    h('td', { class: 'num' }, signed(m.amount))));
  const diffRows = r.changes.map((d) => h('tr', null, h('td', null, fmtDate(d.date)), h('td', { class: 'num' }, fmtNaira(d.bank)), h('td', { class: 'num' }, fmtNaira(d.app)), h('td', { class: 'num' }, signed(d.diff))));
  const matchRows = [
    ...r.matched.map((m) => h('tr', null, h('td', null, fmtDate(m.line.date)), h('td', null, m.line.description || '—'), h('td', { class: 'num' }, signed(m.line.amount)),
      h('td', null, `${TX_LABELS[m.entry.tx.type] ?? m.entry.tx.type} ${fmtDate(m.entry.date)}${m.dayGap ? ` (${Math.abs(m.dayGap)} day${Math.abs(m.dayGap) > 1 ? 's' : ''} ${m.dayGap > 0 ? 'later' : 'earlier'})` : ''}`))),
    ...r.netted.map((n) => h('tr', null, h('td', null, fmtDate(n.date)), h('td', null, n.line ? n.line.description || '—' : 'No bank line: netted at the counterparty'), h('td', { class: 'num' }, signed(n.net)),
      h('td', null, n.entries.map((e) => `${TX_LABELS[e.tx.type]} ${fmtNaira(e.amount.abs())}`).join(' + ')))),
  ];

  const save = h('button', { class: 'primary', onclick: (e) => runAction(e.currentTarget, () => saveDoc('bankRecs', r.end, {
    start: r.start, end: r.end, fileName: st.fileName, lines: String(r.lines), matched: String(r.matched.length + r.netted.filter((n) => n.line).length),
    bankOnly: String(r.bankOnly.length), appOnly: String(r.appOnly.length),
    bankClosing: r.closing ? r.closing.bank.toFixed(2) : '', appClosing: r.closing?.app != null ? r.closing.app.toFixed(2) : '',
    difference: r.closing?.diff != null ? r.closing.diff.toFixed(2) : '', reconciledOn: todayISO(),
  }), 'Reconciliation saved.') }, 'Save reconciliation');

  return [
    controls, stats,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, `On the bank statement, not in the app (${r.bankOnly.length})`), r.bankOnly.length ? h('span', { class: 'muted small' }, `net ${fmtNaira(r.totals.bankOnly)}`) : null),
      table(['Date', 'Narration', { label: 'Amount', num: true }, ''], bankRows, 'Every statement line matches a recorded entry.'),
      r.bankOnly.length ? h('p', { class: 'muted small' }, 'Record what belongs in the portfolio; the match re-runs as soon as it is saved. Bank charges are usually fee debits; anything that is not the portfolio\'s money should be taken up with the bank.') : null),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, `In the app, not on the bank statement (${r.appOnly.length})`), r.appOnly.length ? h('span', { class: 'muted small' }, `net ${fmtNaira(r.totals.appOnly)}`) : null),
      table(['Date', 'Entry', 'Reference', { label: 'Cash effect', num: true }], appRows, 'Every recorded cash movement in these dates is on the statement.'),
      r.appOnly.length ? h('p', { class: 'muted small' }, 'Entries dated in the statement period with no line on it. Check the date and amount, or whether it went through another account. Click one to correct or delete it.') : null),
    r.changes.length ? foldCard('Where the balances part', `${r.changes.length} day${r.changes.length > 1 ? 's' : ''} where the difference changes`,
      h('p', { class: 'muted small' }, `Bank end-of-day balance against the app's cash. Opening: bank ${r.opening.bank ? fmtNaira(r.opening.bank) : '—'}, app ${fmtNaira(r.opening.app)}. Each row is a day the difference moved, so the cause is on or just before that day.`),
      table(['Date', { label: 'Bank balance', num: true }, { label: 'App cash', num: true }, { label: 'Difference', num: true }], diffRows)) : null,
    foldCard(`Matched (${matchRows.length})`, 'Statement lines and the entries they matched', table(['Date', 'Narration', { label: 'Amount', num: true }, 'Matched to'], matchRows, 'Nothing matched.')),
    h('div', { class: 'toolbar actions-row' }, save, h('span', { class: 'muted small' }, `Saves the summary for ${fmtDate(r.end)} (counts and balances), not the statement itself.`)),
  ];
}

function pastCard(data) {
  if (!Array.isArray(data.bankRecs)) {
    return state.errors.bankRecs ? h('p', { class: 'muted small' }, 'Saved reconciliations need the updated Firestore rules (publish firestore.rules).') : null;
  }
  const list = [...data.bankRecs].sort((a, b) => (a.end < b.end ? 1 : -1));
  return h('section', { class: 'card' }, h('h2', null, 'Saved reconciliations'),
    table(['Statement to', 'From', { label: 'Lines', num: true }, { label: 'Unmatched (bank / app)', num: true }, { label: 'Bank balance', num: true }, { label: 'Difference', num: true }, 'Saved'],
      list.map((x) => h('tr', null, h('td', null, fmtDate(x.end)), h('td', null, fmtDate(x.start)), h('td', { class: 'num' }, x.lines ?? ''),
        h('td', { class: 'num' }, `${x.bankOnly ?? '—'} / ${x.appOnly ?? '—'}`), h('td', { class: 'num' }, x.bankClosing ? fmtNaira(x.bankClosing) : '—'),
        h('td', { class: 'num' }, x.difference ? fmtNaira(x.difference) : '—'), h('td', null, x.reconciledOn ? fmtDate(x.reconciledOn) : ''))),
      'None saved yet.'));
}
