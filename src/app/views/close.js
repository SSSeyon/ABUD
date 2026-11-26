// Quarter close: benchmark, management fee, ARIP, hurdle test and incentive (both readings), then close (lock),
// mark billed, and the client documents: statement of account (Cl. 9) and fee computation (Cl. 8).
import { addDays, BusinessCalendar, dec, managementFeeForPeriod, quarterOf } from '../../engine/index.js';
import { closeQuarter, markBilled, reopenQuarter, saveTransaction } from '../actions.js';
import { NET_PAYOUT_FROM, PAYOUT_PURPOSE, payoutBasis, payoutSchedule } from '../payout.js';
import { auctionYield, closeRecord, completedQuarters, computeClose, ntb91 } from '../close.js';
import { holdingsOn, navSeries, periodReport, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { accessMark, confirmDialog, mboMark, downloadCsv, fmtDate, fmtNaira, fmtPct, h, openForm, parseMoney, runAction, table, toast, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms', 'funds'];
const sel = { label: '', auctionId: '', doc: null };

const inceptionOf = (data) => (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');

/** Figures to show: the saved record for a closed quarter, otherwise calculated now. */
function figures(data, label, today) {
  const rec = (data.quarterlyResults ?? []).find((r) => r.id === label);
  if (rec) return { rec, closed: true };
  const c = computeClose(data, label, { asOf: today, auctionId: sel.auctionId || undefined });
  if (c.error) return { error: c.error };
  return { rec: closeRecord(c), live: c, closed: false, preview: c.periodEnd < c.quarter.end };
}

export function closeView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const inception = inceptionOf(data);
  const head = (sub) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Quarter close'), h('p', { class: 'subtitle' }, sub)));
  if (!inception) return h('div', null, head('No transactions yet.'));

  const rulesMissing = ['quarterlyResults', 'auctions'].filter((n) => state.errors[n]);
  const current = quarterOf(today);
  const quarters = [current, ...completedQuarters(inception, today)];
  if (!sel.label || !quarters.some((q) => q.label === sel.label)) sel.label = quarters[1]?.label ?? current.label;

  const f = figures(data, sel.label, today);
  if (sel.doc && f.rec) return documentView(data, f, rerender);

  const picker = h('div', { class: 'toolbar no-print' },
    h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Quarter'),
      h('select', { class: 'period-select', value: sel.label, onchange: (e) => { sel.label = e.target.value; sel.auctionId = ''; rerender(); } },
        quarters.map((q) => {
          const rec = (data.quarterlyResults ?? []).find((r) => r.id === q.label);
          const tag = q.label === current.label ? ' (in progress)' : rec ? (rec.status === 'billed' ? ' · billed' : ' · closed') : '';
          return h('option', { value: q.label }, `${q.label}${tag}`);
        }))));

  const parts = [head('Benchmark, management fee, return against the hurdle, incentive fee, and the client statement.'), picker];
  if (rulesMissing.length) parts.push(h('div', { class: 'card warn' }, h('p', null, 'Quarter close needs the updated Firestore rules (publish firestore.rules). Until then the figures show but cannot be saved.')));
  if (f.error) {
    parts.push(h('div', { class: 'card bad' }, h('h2', null, 'Cannot calculate this quarter yet'), h('p', null, f.error), h('p', null, h('a', { href: '#/market' }, 'Market'), ' holds auction results; ', h('a', { href: '#/settings' }, 'Settings'), ' holds mandate terms.')));
    parts.push(historyCard(data));
    return h('div', null, parts);
  }

  const r = f.rec;
  const q = quarters.find((x) => x.label === sel.label);
  const status = f.closed
    ? r.status === 'billed' ? `Billed on ${fmtDate(r.billedOn)}` : `Closed ${r.closedAt ? fmtDate(r.closedAt.slice(0, 10)) : ''}: figures locked`
    : f.preview ? `In progress: figures to ${fmtDate(r.periodEnd)}` : 'Not closed: figures are live and will change with any edit';
  const total = dec(r.mgmtFee).plus(r.incentiveClause8);

  const kpi = (label, value, note, tone) => h('div', { class: `stat ${tone ?? ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  parts.push(h('div', { class: `close-status ${f.closed ? 'closed' : f.preview ? 'preview' : 'open'}` }, h('strong', null, status), h('span', { class: 'muted' }, ` · ${fmtDate(r.periodStart)} to ${fmtDate(r.periodEnd)}, ${r.days} days`)));
  parts.push(h('div', { class: 'stats' },
    kpi('ARIP', fmtPct(r.arip), 'Time-weighted, gross of fees', dec(r.arip).isNegative() ? 'down' : 'up'),
    kpi('Hurdle', fmtPct(r.hurdle), `WATBR ${fmtPct(r.watbr)} + spread`),
    kpi('Hurdle test', r.hurdleMet ? 'Met' : 'Not met', `ARIP ${dec(r.arip).minus(r.hurdle).gte(0) ? 'above' : 'below'} hurdle by ${fmtPct(dec(r.arip).minus(r.hurdle).abs())}`, r.hurdleMet ? 'up' : 'down'),
    kpi('Management fee', fmtNaira(r.mgmtFee), feeBasisShort(r.terms)),
    kpi('Incentive fee (Cl. 8)', fmtNaira(r.incentiveClause8), `Billing basis · Cl. 12 ${fmtNaira(r.incentiveClause12)} · worksheet ${r.incentiveWorksheet ? fmtNaira(r.incentiveWorksheet) : '—'}`),
    kpi('Total fees for the quarter', fmtNaira(total))));

  // Benchmark.
  const b = r.benchmark;
  const choices = ntb91(data).filter((a) => a.date < q.start).slice(0, 8);
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Benchmark: 91-day NTB true yield')),
    h('p', null, `Auction of ${fmtDate(b.auctionDate)} (${b.tenorDays} days): stop rate ${b.stopRate ? fmtPct(b.stopRate, 2) : '—'}, true yield ${fmtPct(b.trueYield)}. `,
      b.sourceUrl ? h('a', { href: b.sourceUrl, target: '_blank', rel: 'noopener' }, 'Source') : 'No source link stored.'),
    h('p', { class: 'muted small' }, 'The last 91-day primary auction before the quarter started. True yield = d ÷ (1 − d × t ÷ 365). It is saved with the quarter when closed, so later edits to auction data never change a closed quarter.'),
    !f.closed && choices.length > 1
      ? h('label', { class: 'period-picker no-print' }, h('span', { class: 'period-label' }, 'Use another auction'),
          h('select', { class: 'period-select', value: sel.auctionId || choices[0].id, onchange: (e) => { sel.auctionId = e.target.value === choices[0].id ? '' : e.target.value; rerender(); } },
            choices.map((a) => h('option', { value: a.id }, `${fmtDate(a.date)}: ${fmtPct(a.stopRate, 2)} stop, ${fmtPct(auctionYield(a), 2)} true yield`))))
      : null));

  // Workings (internal: both incentive readings).
  const gap = dec(r.incentiveClause8).minus(r.incentiveClause12);
  const rowsOf = [
    ['Days in period', r.days],
    ['Opening NAV', fmtNaira(r.openingNav)],
    ['Inflows from Access', fmtNaira(r.inflows)],
    ['Withdrawals', fmtNaira(dec(r.withdrawals).negated())],
    ['Fees and charges debited', fmtNaira(dec(r.fees).negated())],
    ['Investment income', fmtNaira(r.income)],
    ['Closing NAV', fmtNaira(r.closingNav)],
    ['Average daily NAV', fmtNaira(r.avgNav)],
    ['ARIP (daily time-weighted, gross of fees)', fmtPct(r.arip, 4)],
    [`WATBR = ${fmtPct(b.trueYield)} × ${r.days} ÷ 365`, fmtPct(r.watbr, 4)],
    [`Hurdle = (${fmtPct(b.trueYield)} + ${fmtPct(r.terms.hurdleSpread, 2)}) × ${r.days} ÷ 365`, fmtPct(r.hurdle, 4)],
    ['Hurdle met', r.hurdleMet ? 'Yes' : 'No'],
    [`Management fee: ${feeBasisLong(r.terms)}`, fmtNaira(r.mgmtFee)],
    [`Incentive, Clause 8: ${fmtPct(r.terms.incentiveRate, 0)} × (ARIP − WATBR) × average NAV`, fmtNaira(r.incentiveClause8)],
    [`Incentive, Clause 12 (internal only): ${fmtPct(r.terms.incentiveRate, 0)} × (ARIP − hurdle) × average NAV`, fmtNaira(r.incentiveClause12)],
    ['Gap between Clause 8 and Clause 12', fmtNaira(gap)],
    ...(r.worksheetIncome ? [
      ['Worksheet reading: investment income for the quarter (naira, NAV change less contributions)', fmtNaira(r.worksheetIncome)],
      [`Shadow benchmark income: contributions compounded daily at the latest 91-day true yield + ${fmtPct(r.terms.hurdleSpread, 2)}`, fmtNaira(r.worksheetBenchmarkIncome)],
      [`Incentive, worksheet reading (internal only): ${fmtPct(r.terms.incentiveRate, 0)} × the excess`, fmtNaira(r.incentiveWorksheet)],
    ] : []),
  ];
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Workings'),
    h('table', { class: 'bridge' }, h('tbody', null, rowsOf.map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'num' }, String(v)))))),
    h('p', { class: 'muted small' }, `Mandate terms effective ${fmtDate(r.terms.effectiveFrom)}. Clause 8 is the billing reading until Access confirms the basis; Clause 12 and the worksheet reading (how the MCM income sheet billed) appear only here. See Back-test for every quarter since inception.`)));

  // Actions.
  const btn = (label, cls, fn) => h('button', { class: cls, onclick: (e) => fn(e.currentTarget) }, label);
  const actions = [];
  if (!f.closed && !f.preview) {
    actions.push(btn('Close quarter', 'primary', (el) => confirmDialog({ title: `Close ${sel.label}?`, message: `This saves the figures above and locks ${sel.label}: entries dated in it can't be changed until it is reopened.`, confirmLabel: 'Close quarter' })
      .then((ok) => ok && runAction(el, () => closeQuarter({ ...r, quarter: sel.label }), `${sel.label} closed`))));
  }
  if (f.closed && r.status !== 'billed') {
    actions.push(btn('Mark billed', 'primary', () => openForm({ title: `Mark ${sel.label} billed`, fields: [{ name: 'date', label: 'Invoice date', type: 'date', required: true, value: today }], submitLabel: 'Mark billed', onSubmit: (v) => markBilled(sel.label, v.date) })));
  }
  actions.push(btn(f.closed ? 'Statement of account' : 'Statement (draft)', null, () => { sel.doc = 'statement'; rerender(); }));
  actions.push(btn(f.closed ? 'Fee computation' : 'Fee computation (draft)', null, () => { sel.doc = 'fees'; rerender(); }));
  actions.push(btn('Download CSV', null, () => downloadCsv(`ABUD ${sel.label} quarter close.csv`, [['Item', 'Value'], ...rowsOf.map(([k, v]) => [k, String(v)]), ['Benchmark auction date', b.auctionDate], ['Benchmark true yield', fmtPct(b.trueYield)], ['Benchmark source', b.sourceUrl], ['Status', status]])));
  if (f.closed) {
    actions.push(btn('Reopen', 'danger', (el) => confirmDialog({ title: `Reopen ${sel.label}?`, message: 'This unlocks the quarter so its entries can change. The closed figures stay in Change history and can be restored with Undo.', confirmLabel: 'Reopen', danger: true })
      .then((ok) => ok && runAction(el, () => reopenQuarter(sel.label), `${sel.label} reopened`))));
  }
  parts.push(h('div', { class: 'toolbar actions-row no-print' }, actions));
  if (f.preview) parts.push(h('p', { class: 'muted small' }, `${sel.label} ends on ${fmtDate(q.end)}; it can be closed after that.`));
  parts.push(payoutCard(data, today));
  parts.push(historyCard(data));
  return h('div', null, parts);
}

/** Quarterly income payout to Access: net of MBO's fees from NET_PAYOUT_FROM, fixed when the quarter closes. */
function payoutCard(data, today) {
  const sched = payoutSchedule(data, today);
  const money = (x) => (x == null ? '—' : fmtNaira(x));
  const rows = sched.map((s) => {
    const settled = s.closed && s.outstanding.lte('0.5');
    const status = !s.closed ? (s.inProgress ? 'In progress' : 'Close the quarter to fix it') : settled ? 'Paid' : s.paid.isZero() ? 'Due' : 'Part paid';
    return h('tr', null,
      h('td', null, s.quarter),
      h('td', { class: 'num' }, money(s.income)),
      h('td', { class: 'num' }, s.fees == null ? 'At close' : fmtNaira(s.fees.negated())),
      h('td', { class: 'num' }, money(s.payable)),
      h('td', { class: 'num' }, s.paid.isZero() ? '—' : fmtNaira(s.paid)),
      h('td', { class: 'num' }, s.outstanding == null ? '—' : fmtNaira(s.outstanding)),
      h('td', null, h('span', { class: `badge ${status === 'Due' || status === 'Part paid' ? 'warn' : ''}` }, status)),
      h('td', null, s.closed && !settled ? h('button', { class: 'primary', onclick: () => payoutForm(s, today) }, 'Record payout') : null));
  });
  return h('section', { class: 'card' }, h('h2', null, 'Income payout to Access'),
    h('p', { class: 'muted small' }, `Access's mandate: each quarter's income is paid out to them. Up to 2026Q3 the gross income was paid; from ${NET_PAYOUT_FROM} it is the income net of MBO's fees (management fee + Clause 8 incentive). The amount is fixed when the quarter is closed. A payout is a withdrawal tagged to its quarter.`),
    table(['Quarter', { label: 'Income', num: true }, { label: 'MBO fees', num: true }, { label: 'Payable', num: true }, { label: 'Paid', num: true }, { label: 'Outstanding', num: true }, 'Status', ''], rows, 'No quarters under the net payout yet.'));
}

function payoutForm(s, today) {
  const after = addDays(s.end, 1);
  openForm({
    title: `Income payout for ${s.quarter}`,
    intro: `Income ${fmtNaira(s.income)} less MBO's fees ${fmtNaira(s.fees)} = ${fmtNaira(s.payable)} payable${s.paid.isZero() ? '' : `; ${fmtNaira(s.paid)} already paid`}. Records a withdrawal to Access tagged to ${s.quarter}.`,
    submitLabel: 'Record payout',
    fields: [
      { name: 'date', label: 'Date paid', type: 'date', required: true, value: today > after ? today : after, help: 'After the quarter end: entries dated in a closed quarter are locked.' },
      { name: 'amount', label: 'Amount (₦)', type: 'money', required: true, value: s.outstanding.toFixed(2) },
      { name: 'reference', label: 'Reference', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: `Income payout for ${s.quarter}, net of MBO fees` },
    ],
    onSubmit: async (v) => {
      await saveTransaction(null, { type: 'withdrawal', purpose: PAYOUT_PURPOSE, quarter: s.quarter, date: v.date, amount: parseMoney(v.amount, 'Amount'), reference: v.reference, notes: v.notes },
        `Income payout for ${s.quarter}`);
      toast(`Payout for ${s.quarter} recorded.`);
    },
  });
}

function historyCard(data) {
  const recs = [...(data.quarterlyResults ?? [])].sort((a, b) => (a.id < b.id ? 1 : -1));
  const rows = recs.map((r) => h('tr', null,
    h('td', null, h('a', { href: '#/close', onclick: () => { sel.label = r.id; sel.doc = null; } }, r.id)),
    h('td', { class: 'num' }, fmtPct(r.arip)), h('td', { class: 'num' }, fmtPct(r.hurdle)),
    h('td', null, r.hurdleMet ? 'Met' : 'Not met'),
    h('td', { class: 'num' }, fmtNaira(r.mgmtFee)), h('td', { class: 'num' }, fmtNaira(r.incentiveClause8)), h('td', { class: 'num' }, fmtNaira(r.incentiveClause12)), h('td', { class: 'num' }, r.incentiveWorksheet ? fmtNaira(r.incentiveWorksheet) : '—'),
    h('td', null, r.status === 'billed' ? `Billed ${fmtDate(r.billedOn)}` : 'Closed')));
  return h('section', { class: 'card' }, h('h2', null, 'Closed quarters'),
    table(['Quarter', { label: 'ARIP', num: true }, { label: 'Hurdle', num: true }, 'Test', { label: 'Management fee', num: true }, { label: 'Incentive Cl. 8', num: true }, { label: 'Incentive Cl. 12', num: true }, { label: 'Worksheet', num: true }, 'Status'], rows, 'No quarter has been closed yet.'));
}

// ---------- client documents ----------

function documentView(data, f, rerender) {
  const r = f.rec;
  const draft = !f.closed;
  const toolbar = h('div', { class: 'toolbar actions-row no-print' },
    h('button', { onclick: () => { sel.doc = null; rerender(); } }, '← Back to quarter close'),
    h('button', { class: 'primary', onclick: () => window.print() }, 'Print / save as PDF'));
  const ref = draft ? 'DRAFT: quarter not closed; figures may change.' : `Quarter close record ${r.quarter}, closed ${r.closedAt ? fmtDate(r.closedAt.slice(0, 10)) : ''}${r.status === 'billed' ? `, billed ${fmtDate(r.billedOn)}` : ''}.`;
  const letterhead = (title) => h('div', { class: 'doc-head' },
    h('div', { class: 'doc-firm' }, mboMark()),
    h('div', null, h('h1', null, title), h('p', null, `Access Holdings Plc unclaimed dividend portfolio · ${r.quarter} · ${fmtDate(r.periodStart)} to ${fmtDate(r.periodEnd)}`)),
    h('div', { class: 'doc-client' }, accessMark()));
  const body = sel.doc === 'fees' ? feeDoc(data, r) : statementDoc(data, r);
  return h('div', { class: `document ${draft ? 'draft' : ''}` }, toolbar,
    letterhead(sel.doc === 'fees' ? 'Fee computation (Clause 8)' : 'Statement of account (Clause 9)'),
    body,
    h('p', { class: 'doc-ref' }, ref));
}

function kv(rows) {
  return h('table', { class: 'bridge' }, h('tbody', null, rows.map(([k, v, cls]) => h('tr', { class: cls ?? null }, h('td', null, k), h('td', { class: 'num' }, v)))));
}

function statementDoc(data, r) {
  const yearStart = `${r.periodEnd.slice(0, 4)}-01-01`;
  const inception = inceptionOf(data);
  let ytd = null;
  try { ytd = periodReport(data, inception > yearStart ? inception : yearStart, r.periodEnd).twr; } catch { ytd = null; }
  const held = holdingsOn(data, r.periodEnd).sort((a, b) => (a.inst.type < b.inst.type ? -1 : a.inst.type > b.inst.type ? 1 : (a.inst.maturityDate ?? '9') < (b.inst.maturityDate ?? '9') ? -1 : 1));
  const cash = navSeries(data, r.periodEnd).at(-1)?.cash ?? dec(0);
  const holdRows = held.map(({ inst, value }) => h('tr', null,
    h('td', null, TYPE_LABELS[inst.type]), h('td', null, inst.counterpartyName ?? ''),
    h('td', null, fmtDate(inst.valueDate)), h('td', null, inst.maturityDate ? fmtDate(inst.maturityDate) : 'Open'),
    h('td', { class: 'num' }, fmtNaira(inst.cost)), h('td', { class: 'num' }, fmtNaira(value))));
  holdRows.push(h('tr', null, h('td', null, 'Cash at bank'), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, fmtNaira(cash))));
  holdRows.push(h('tr', { class: 'total' }, h('td', { colspan: 5 }, 'Net asset value'), h('td', { class: 'num' }, fmtNaira(r.closingNav))));
  return h('div', null,
    h('section', null, h('h2', null, 'Summary'), kv([
      ['Opening NAV', fmtNaira(r.openingNav), 'total'],
      ['Inflows from Access Holdings', fmtNaira(r.inflows)],
      ['Withdrawals', fmtNaira(dec(r.withdrawals).negated())],
      ['Investment income', fmtNaira(r.income)],
      ['Fees and charges debited', fmtNaira(dec(r.fees).negated())],
      ['Closing NAV', fmtNaira(r.closingNav), 'total'],
    ])),
    h('section', null, h('h2', null, 'Return'), kv([
      [`Quarter (${r.quarter}), time-weighted, gross of fees`, fmtPct(r.arip, 3)],
      [`Year to date (${r.periodEnd.slice(0, 4)})`, ytd ? fmtPct(ytd, 3) : '—'],
    ])),
    h('section', null, h('h2', null, `Holdings at ${fmtDate(r.periodEnd)}`),
      table(['Instrument', 'Counterparty', 'Value date', 'Maturity', { label: 'Cost', num: true }, { label: 'Value', num: true }], holdRows)),
    h('p', { class: 'muted small' }, 'NAV is gross of fees due to MBO Capital. Bills and commercial paper at amortised cost; deposits with accrued interest; funds at the latest yield.'));
}

function feeDoc(data, r) {
  const rows = navSeries(data, r.periodEnd);
  let accruals = [];
  try { accruals = managementFeeForPeriod(rows, r.periodStart, r.periodEnd, r.terms.mgmtFeeRate, new BusinessCalendar(), r.terms.feeDayCount ?? 'act365').accruals; } catch { accruals = []; }
  const months = new Map();
  for (const a of accruals) {
    const k = a.date.slice(0, 7);
    const m = months.get(k) ?? months.set(k, { days: 0, base: dec(0), fee: dec(0) }).get(k);
    m.days += 1; m.base = m.base.plus(a.base); m.fee = m.fee.plus(a.accrual);
  }
  const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthRows = [...months.entries()].map(([k, m]) => h('tr', null,
    h('td', null, `${NAMES[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`), h('td', { class: 'num' }, String(m.days)),
    h('td', { class: 'num' }, fmtNaira(m.base.div(m.days))), h('td', { class: 'num' }, fmtNaira(m.fee))));
  monthRows.push(h('tr', { class: 'total' }, h('td', null, 'Management fee'), h('td', { class: 'num' }, r.days), h('td'), h('td', { class: 'num' }, fmtNaira(r.mgmtFee))));
  const b = r.benchmark;
  const total = dec(r.mgmtFee).plus(r.incentiveClause8);
  return h('div', null,
    h('section', null, h('h2', null, 'Management fee'),
      h('p', { class: 'muted small' }, `${feeBasisLong(r.terms)}; weekends and holidays use the prior business day's NAV.`),
      table(['Month', { label: 'Days', num: true }, { label: 'Average NAV used', num: true }, { label: 'Fee', num: true }], monthRows)),
    h('section', null, h('h2', null, 'Benchmark and hurdle test'), kv([
      ['Benchmark: 91-day NTB auction', `${fmtDate(b.auctionDate)}${b.stopRate ? `, stop rate ${fmtPct(b.stopRate, 2)}` : ''}`],
      ['True yield', fmtPct(b.trueYield, 3)],
      ['Source', b.sourceUrl || '—'],
      [`WATBR for ${r.days} days`, fmtPct(r.watbr, 3)],
      [`Hurdle (true yield + ${fmtPct(r.terms.hurdleSpread, 2)}) for ${r.days} days`, fmtPct(r.hurdle, 3)],
      ['ARIP', fmtPct(r.arip, 3)],
      ['Hurdle met', r.hurdleMet ? 'Yes' : 'No'],
    ])),
    h('section', null, h('h2', null, 'Fees due'), kv([
      ['Management fee', fmtNaira(r.mgmtFee)],
      [`Incentive fee: ${fmtPct(r.terms.incentiveRate, 0)} × (ARIP − WATBR) × average NAV of ${fmtNaira(r.avgNav)}`, fmtNaira(r.incentiveClause8)],
      ['Total due', fmtNaira(total), 'total'],
    ])),
    payoutBasis(r.quarter) === 'net' ? h('section', null, h('h2', null, 'Income payable to Access'), kv([
      ['Investment income for the quarter', fmtNaira(r.income)],
      ['Less fees due to MBO Capital', fmtNaira(total.negated())],
      ['Income payable', fmtNaira(dec(r.income).minus(total).isNegative() ? 0 : dec(r.income).minus(total)), 'total'],
    ])) : null);
}

/** How the management fee was charged, from the terms saved with the figures. */
function feeBasisShort(terms) {
  return terms.feeDayCount === 'quarterly' ? `${fmtPct(dec(terms.mgmtFeeRate).div(4), 4)} a quarter on daily NAV` : `${fmtPct(terms.mgmtFeeRate)} p.a. on daily NAV`;
}
function feeBasisLong(terms) {
  return terms.feeDayCount === 'quarterly'
    ? `${fmtPct(terms.mgmtFeeRate)} a year ÷ 4 per quarter, spread evenly over the quarter's days, on each day's NAV`
    : `${fmtPct(terms.mgmtFeeRate)} a year on each day's NAV (Actual/365)`;
}
