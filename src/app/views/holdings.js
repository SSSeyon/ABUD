import { addDays, FundPriceBook, Valuer, daysBetween, dec } from '../../engine/index.js';
import { limitsFrom } from '../alerts.js';
import { createDeal, partialLiquidate, rollOverDeal, saveFundPrice, saveTransaction, updateDeal } from '../actions.js';
import { partialLiquidationPlan, PENALTY_BASES } from '../liquidation.js';
import { openHoldingStatement } from './holdingdetail.js';
import { openFundUpload } from './fundupload.js';
import { ASSET_CLASSES, closedInstrumentIds, DEPOSIT_TYPES, engineInputs, expectedMaturityValue, navSeries, openingTransactions, positionsFor, toEngineInstrument, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, excelButton, fmtDate, fmtNaira, fmtPct, h, openForm, parseDecimal, parseMoney, parsePercent, table, toast, todayISO, xDate, xMoney, xPct } from '../ui.js';
import { counterpartyName, custodianExposure, dealRatingCheck } from '../counterparties.js';

const DISCOUNT = ['ntb', 'omo', 'commercial_paper'];
const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];

const filt = { q: '', type: '', counterparty: '', custodian: '', within: '' };

export function holdingsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const closed = closedInstrumentIds(data.transactions);
  const opening = openingTransactions(data.transactions);
  const valuer = new Valuer(new FundPriceBook(engineInputs(data).fundPrices));
  const funds = new Map((data.funds ?? []).map((f) => [f.id, f]));

  // Fund deals on an uploaded statement are shown as the fund's account instead (valued at the statement balance).
  const { statements, byId } = positionsFor(data);
  const covered = (i) => i.type === 'money_market_fund' && statements.covers(i.fundId, today);
  const allLive = (data.instruments ?? [])
    .filter((i) => !closed.has(i.id) && !covered(i))
    .sort((a, b) => ((a.maturityDate ?? '9999') < (b.maturityDate ?? '9999') ? -1 : 1));
  const cpOf = (i) => counterpartyName(i, data.funds);
  const horizon = filt.within ? addDays(today, Number(filt.within)) : null;
  const q = filt.q.trim().toLowerCase();
  const live = allLive.filter((i) => (!filt.type || i.type === filt.type)
    && (!filt.counterparty || cpOf(i) === filt.counterparty)
    && (!filt.custodian || (i.custodianName?.trim() || "Not recorded") === filt.custodian)
    && (!horizon || (i.maturityDate && i.maturityDate <= horizon))
    && (!q || [cpOf(i), i.custodianName, TYPE_LABELS[i.type], funds.get(i.fundId)?.name].some((s) => String(s ?? "").toLowerCase().includes(q))));
  const accounts = statements.funds.map((f) => byId.get(`fund:${f}`)).filter((p) => p && !p.value(today).isZero()
    && (!filt.type || filt.type === 'money_market_fund') && (!filt.counterparty || p.inst.counterpartyName === filt.counterparty)
    && (!filt.custodian || filt.custodian === 'Not recorded') && !horizon
    && (!q || [p.inst.counterpartyName, p.label, 'money market fund'].some((s) => String(s ?? '').toLowerCase().includes(q))));

  const valueOf = (i) => {
    try {
      return valuer.valueOn(toEngineInstrument(i), today);
    } catch (err) {
      return err.message;
    }
  };
  const fmtValue = (v) => (typeof v === 'string' ? v : fmtNaira(v));
  const row = (i, value) => {
    const rate = DEPOSIT_TYPES.has(i.type) ? fmtPct(i.rate, 2) : i.discountRate ? `${fmtPct(i.discountRate, 2)} disc.` : '—';
    const dtm = i.maturityDate ? daysBetween(today, i.maturityDate) : null;
    return h(
      'tr',
      { class: `clickable ${dtm != null && dtm < 0 ? 'bad' : ''}`, tabindex: 0, title: 'Open the daily statement',
        onclick: (e) => { if (!e.target.closest('button, a, select, input')) openHoldingStatement(i.id); },
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openHoldingStatement(i.id); } },
      h('td', null, TYPE_LABELS[i.type], i.type === 'money_market_fund' ? h('div', { class: 'muted' }, funds.get(i.fundId)?.name ?? '') : null, dtm != null && dtm < 0 ? h('div', { class: 'badge warn' }, 'Matured: record it') : null),
      h('td', null, cpOf(i) ?? ''),
      h('td', { class: 'num' }, fmtNaira(i.cost)),
      h('td', { class: 'num' }, i.faceValue ? fmtNaira(i.faceValue) : fmtNaira(expectedMaturityValue(i))),
      h('td', null, rate),
      h('td', null, fmtDate(i.valueDate)),
      h('td', null, i.maturityDate ? fmtDate(i.maturityDate) : 'Open'),
      h('td', { class: 'num' }, dtm == null ? '' : String(dtm)),
      h('td', { class: 'num' }, fmtValue(value)),
      h('td', null, actionsFor(i, funds.get(i.fundId), opening.get(i.id))),
    );
  };

  // Grouped by asset class, each with a subtotal row.
  const rows = [];
  let total = dec(0);
  for (const c of ASSET_CLASSES) {
    if (c.key === 'call_deposit' || c.key === 'cash') continue;
    const group = live.filter((i) => i.type === c.key);
    const accts = c.key === 'money_market_fund' ? accounts : [];
    // Every fund in the register gets a row even with nothing in it, so it can be topped up from here.
    const idle = c.key === 'money_market_fund' && (!filt.type || filt.type === c.key) && !filt.counterparty && !filt.custodian && !horizon
      ? [...funds.values()].filter((f) => !group.some((i) => i.fundId === f.id) && !accts.some((p) => p.fundId === f.id)
        && (!q || [f.name, f.managerName, 'money market fund'].some((s) => String(s ?? '').toLowerCase().includes(q))))
      : [];
    if (!group.length && !accts.length && !idle.length) continue;
    const values = group.map(valueOf);
    const acctValues = accts.map((p) => p.value(today));
    const sub = [...values, ...acctValues].reduce((t, v) => (typeof v === 'string' ? t : t.plus(v)), dec(0));
    total = total.plus(sub);
    rows.push(h('tr', { class: 'group' }, h('td', { colspan: 8 }, classTag(c.key, c.label), h('span', { class: 'muted' }, ` · ${group.length + accts.length + idle.length}`)), h('td', { class: 'num' }, fmtNaira(sub)), h('td', null)));
    accts.forEach((p, n) => rows.push(accountRow(p, acctValues[n], statements, today)));
    group.forEach((i, n) => rows.push(row(i, values[n])));
    idle.forEach((f) => rows.push(idleFundRow(f, data)));
  }
  // Cash and call deposits, last: the uninvested balance (from the NAV series) and any open calls.
  const calls = live.filter((i) => i.type === 'call_deposit');
  const cashShown = (!filt.type || filt.type === 'call_deposit') && !filt.counterparty && !filt.custodian && !horizon;
  const cash = cashShown ? (navSeries(data, today).at(-1)?.cash ?? dec(0)) : null;
  const showCash = cash && !cash.isZero() && (!q || 'cash at bank'.includes(q));
  if (calls.length || showCash) {
    const values = calls.map(valueOf);
    const sub = values.reduce((t, v) => (typeof v === 'string' ? t : t.plus(v)), showCash ? cash : dec(0));
    total = total.plus(sub);
    rows.push(h('tr', { class: 'group' }, h('td', { colspan: 8 }, classTag('call_deposit', 'Cash and call deposits'), h('span', { class: 'muted' }, ` · ${calls.length + (showCash ? 1 : 0)}`)), h('td', { class: 'num' }, fmtNaira(sub)), h('td', null)));
    if (showCash) rows.push(cashRow(cash));
    calls.forEach((i, n) => rows.push(row(i, values[n])));
  }
  if (rows.length) rows.push(h('tr', { class: 'total' }, h('td', { colspan: 8 }, showCash ? 'Total portfolio (NAV)' : 'Total holdings'), h('td', { class: 'num' }, fmtNaira(total)), h('td', null)));

  const sel = (label, key, options) => h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, label),
    h('select', { class: 'period-select', onchange: (e) => { filt[key] = e.target.value; rerender(); } },
      [['', 'All'], ...options].map(([v, l]) => h('option', { value: v, selected: filt[key] === v ? true : null }, l))));
  const uniq = (xs) => [...new Set(xs)].sort().map((x) => [x, x]);
  const filtered = Object.values(filt).some(Boolean);
  const toolbar = h('div', { class: 'toolbar no-print' },
    h('label', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Search'),
      h('input', { type: 'search', value: filt.q, placeholder: 'Counterparty, custodian, fund', onchange: (e) => { filt.q = e.target.value; rerender(); } })),
    sel('Class', 'type', ASSET_CLASSES.filter((c) => c.key === 'call_deposit' || (c.key === 'money_market_fund' && funds.size) || allLive.some((i) => i.type === c.key)).map((c) => [c.key, c.key === 'call_deposit' ? 'Cash and call deposits' : c.label])),
    sel('Counterparty', 'counterparty', uniq(allLive.map(cpOf))),
    sel('Custodian', 'custodian', uniq(allLive.map((i) => i.custodianName?.trim() || 'Not recorded'))),
    sel('Maturing within', 'within', [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['182', '6 months']]),
    filtered ? h('button', { onclick: () => { Object.keys(filt).forEach((k) => { filt[k] = ''; }); rerender(); } }, 'Clear filters') : null,
    excelButton('Download Excel', () => `ABUD holdings ${today}.xlsx`, () => holdingsWorkbook(data, live, valueOf, cpOf, today, showCash ? cash : null)));

  let custodians = [];
  try { custodians = custodianExposure(data, today); } catch { custodians = []; }
  const custTotal = custodians.reduce((t, c) => t.plus(c.value), dec(0));
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Holdings'), h('p', { class: 'subtitle' }, `Open positions at end of ${fmtDate(today)}, by asset class${filtered ? ` · ${live.length} of ${allLive.length} shown` : ''}`)), h('div', { class: 'row-actions head-actions' }, h('button', { onclick: () => openFundUpload() }, 'Upload fund statement'), h('button', { class: 'primary', onclick: () => dealForm(data) }, 'New deal'))),
    toolbar,
    table(
      ['Instrument', 'Counterparty', { label: 'Cost', num: true }, { label: 'At maturity', num: true }, 'Rate', 'Value date', 'Maturity', { label: 'Days left', num: true }, { label: 'Value today', num: true }, ''],
      rows,
      filtered ? 'No holdings match these filters.' : 'No holdings yet. Use "New deal" to record an investment.',
    ),
    h('p', { class: 'muted' }, 'Click a holding for its daily statement. Values are end of day: bills and CPs at amortised cost, deposits with accrued interest, funds at the uploaded statement balance (or else the latest price or accrued yield). Matured and redeemed holdings drop off this list once the maturity or redemption is recorded.'),
    h('section', { class: 'card' }, h('h2', null, 'Holdings by custodian'),
      table(['Custodian', { label: 'Holdings', num: true }, { label: 'Value', num: true }, { label: 'Share', num: true }],
        custodians.map((c) => h('tr', null,
          h('td', null, h('a', { href: '#/holdings', onclick: (e) => { e.preventDefault(); filt.custodian = c.name; rerender(); } }, c.name)),
          h('td', { class: 'num' }, String(c.count)), h('td', { class: 'num' }, fmtNaira(c.value)),
          h('td', { class: 'num' }, custTotal.isZero() ? '—' : fmtPct(c.value.div(custTotal), 1)))),
        'No holdings.'),
      h('p', { class: 'muted small' }, 'Custodians come from each deal. Keep the names consistent with the register on the Counterparties screen.')),
  );
}

/** A fund with nothing in it today: when it was last redeemed, and buttons to subscribe or upload a statement. */
function idleFundRow(f, data) {
  const ids = new Set((data.instruments ?? []).filter((i) => i.type === 'money_market_fund' && i.fundId === f.id).map((i) => i.id));
  const last = (data.transactions ?? []).filter((t) => t.type === 'fund_redemption' && ids.has(t.instrumentId)).reduce((m, t) => (!m || t.date > m.date ? t : m), null);
  const note = last ? `Nothing invested: redeemed ${fmtNaira(last.amount)} on ${fmtDate(last.date)}` : 'Nothing invested yet';
  return h('tr', null,
    h('td', null, TYPE_LABELS.money_market_fund, h('div', { class: 'muted' }, f.name), h('div', { class: 'badge' }, note)),
    h('td', null, f.managerName ?? ''),
    h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'), h('td', null, '—'), h('td', null, ''), h('td', null, 'Open'), h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, fmtNaira(0)),
    h('td', null, h('div', { class: 'row-actions' },
      h('button', { class: 'primary', onclick: () => dealForm(state.data, null, null, { type: 'money_market_fund', fundId: f.id, counterpartyName: f.managerName }) }, 'Subscribe'),
      h('button', { onclick: () => openFundUpload(f.id) }, 'Upload statement'))));
}

/** The uninvested cash balance: one row; click for its daily statement. */
function cashRow(cash) {
  const open = (e) => { if (!e.target.closest('button, a')) openHoldingStatement('cash'); };
  return h('tr', { class: 'clickable', tabindex: 0, title: 'Open the daily statement', onclick: open,
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openHoldingStatement('cash'); } },
    h('td', null, 'Cash at bank', h('div', { class: 'muted' }, 'Not yet invested')),
    h('td', null, ''), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'), h('td', null, '—'),
    h('td', null, ''), h('td', null, 'On call'), h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, fmtNaira(cash)),
    h('td', null, h('div', { class: 'row-actions' }, h('button', { onclick: () => openHoldingStatement('cash') }, 'Statement'))));
}

/** A fund kept on uploaded statements: one row, valued at the statement balance. */
function accountRow(p, value, statements, today) {
  const rows = statements.byFund.get(p.fundId) ?? [];
  const last = rows.at(-1);
  const stale = last && daysBetween(last.date, today) > 7;
  return h('tr', { class: 'clickable', tabindex: 0, title: 'Open the daily statement',
    onclick: (e) => { if (!e.target.closest('button, a')) openHoldingStatement(p.id); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openHoldingStatement(p.id); } },
    h('td', null, TYPE_LABELS.money_market_fund, h('div', { class: 'muted' }, p.label),
      last ? h('div', { class: `badge ${stale ? 'warn' : ''}` }, `Statement to ${fmtDate(last.date)}`) : null),
    h('td', null, p.inst.counterpartyName ?? ''),
    h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'),
    h('td', null, last ? `${fmtPct(last.rate, 2)} yield` : '—'),
    h('td', null, fmtDate(p.start)), h('td', null, 'Open'), h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, fmtNaira(value)),
    h('td', null, h('div', { class: 'row-actions' },
      h('button', { onclick: () => openHoldingStatement(p.id) }, 'Statement'),
      h('button', { onclick: () => openFundUpload(p.fundId) }, 'Upload'))));
}

/**
 * Partial liquidation of a fixed deposit: take out the amount needed and the penalty, and place the balance again
 * at the same rate to the original maturity date. Shows the figures as they are typed.
 */
function liquidationForm(i, openingTx) {
  const today = todayISO();
  const planFor = (v) => partialLiquidationPlan(i, {
    date: v.date,
    amount: parseMoney(v.amount, 'Amount needed'),
    penaltyBasis: v.penaltyBasis,
    penaltyValue: v.penaltyBasis === 'fixed' ? parseMoney(v.penaltyValue || '0', 'Penalty', { allowZero: true }) : v.penaltyBasis === 'none' ? '0' : parsePercent(v.penaltyValue || '0', 'Penalty rate'),
  });
  openForm({
    title: 'Partial liquidation',
    intro: `${TYPE_LABELS[i.type]} · ${i.counterpartyName ?? ''} · ${fmtNaira(i.cost)} at ${fmtPct(i.rate, 2)} to ${fmtDate(i.maturityDate)}. The deposit is broken on the date, the amount needed and the penalty come out, and the balance is placed again at the same rate to the same maturity. One Undo in Change history reverses it all.`,
    submitLabel: 'Liquidate and roll the balance',
    fields: [
      { name: 'date', label: 'Liquidation date', type: 'date', required: true, value: today < i.maturityDate ? today : '' },
      { name: 'amount', label: 'Amount needed (₦)', type: 'money', required: true, help: 'What has to be paid out. The penalty comes on top of this.' },
      { name: 'penaltyBasis', label: 'Early termination penalty', type: 'select', required: true, value: 'interest_pct', options: PENALTY_BASES },
      { name: 'penaltyValue', label: 'Penalty rate (%)', type: 'percent', required: true, value: '25', showIf: (v) => v.penaltyBasis === 'interest_pct' || v.penaltyBasis === 'amount_pct', help: 'For example 25 means a quarter of the interest earned on the part taken out.' },
      { name: 'penaltyFixed', label: 'Penalty (₦)', type: 'money', required: true, showIf: (v) => v.penaltyBasis === 'fixed' },
      { name: 'payOut', label: 'The amount needed', type: 'select', value: 'yes', options: [{ value: 'yes', label: 'Pay it out to Access (record a withdrawal)' }, { value: 'no', label: 'Keep it in the cash account' }] },
      { name: 'reference', label: 'Reference', type: 'text', value: openingTx?.reference ?? '' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    preview: (v) => {
      if (!v.date || !v.amount) return h('p', { class: 'muted' }, 'Enter the date and the amount needed to see the figures.');
      const p = planFor({ ...v, penaltyValue: v.penaltyBasis === 'fixed' ? v.penaltyFixed : v.penaltyValue });
      const line = (label, x, strong) => h('tr', { class: strong ? 'total' : null }, h('td', null, label), h('td', { class: 'num' }, fmtNaira(x)));
      return h('table', { class: 'bridge' }, h('tbody', null,
        line(`Value at ${fmtDate(v.date)} (${p.days} days' interest ${fmtNaira(p.accrued)})`, p.gross),
        line('Less early termination penalty', p.penalty.neg()),
        line('Less amount taken out', p.amount.neg()),
        line(`Balance placed again to ${fmtDate(i.maturityDate)} (${p.remainingDays} days at ${fmtPct(i.rate, 2)})`, p.balance, true),
        line('Expected at maturity', p.maturityValue)));
    },
    onSubmit: async (v) => {
      const plan = planFor({ ...v, penaltyValue: v.penaltyBasis === 'fixed' ? v.penaltyFixed : v.penaltyValue });
      await partialLiquidate(i, plan, { date: v.date, payOut: v.payOut === 'yes', reference: v.reference, notes: v.notes });
      toast(`Liquidated ${fmtNaira(plan.amount)}; ${fmtNaira(plan.balance)} rolled to ${fmtDate(i.maturityDate)}.`);
    },
  });
}

/** Refuses a new deal with a counterparty rated below the minimum in Settings > Limits. */
function checkRating(data, inst, date = todayISO()) {
  const msg = dealRatingCheck(data, inst, limitsFrom(data, date).minRating, date);
  if (msg) throw new Error(msg);
}

function holdingsWorkbook(data, live, valueOf, cpOf, today, cash) {
  const funds = new Map((data.funds ?? []).map((f) => [f.id, f]));
  const rows = [['Class', 'Instrument', 'Fund', 'Counterparty', 'Custodian', 'Cost', 'At maturity', 'Rate', 'Discount rate', 'Value date', 'Maturity', 'Days left', `Value at ${today}`]];
  for (const i of live) {
    const v = valueOf(i);
    rows.push([
      ASSET_CLASSES.find((c) => c.key === i.type)?.label ?? i.type, TYPE_LABELS[i.type], funds.get(i.fundId)?.name ?? '', cpOf(i), i.custodianName ?? '',
      xMoney(i.cost), xMoney(i.faceValue ?? expectedMaturityValue(i)), DEPOSIT_TYPES.has(i.type) ? xPct(i.rate, 2) : '', i.discountRate ? xPct(i.discountRate, 2) : '',
      xDate(i.valueDate), xDate(i.maturityDate), i.maturityDate ? daysBetween(today, i.maturityDate) : '', typeof v === 'string' ? v : xMoney(v),
    ]);
  }
  if (cash) rows.push(['Cash and call deposits', 'Cash at bank', '', '', '', '', '', '', '', '', '', '', xMoney(cash)]);
  return [{ name: 'Holdings', rows }];
}

function actionsFor(i, fund, openingTx) {
  const edit = h('button', { onclick: () => dealForm(state.data, i, openingTx) }, 'Edit');
  if (i.type === 'money_market_fund') {
    return h(
      'div',
      { class: 'row-actions' },
      h('button', { onclick: () => fundPriceForm(fund) }, fund?.pricingBasis === 'yield' ? 'Add yield' : 'Add price'),
      h('button', { onclick: () => redemptionForm(i) }, 'Redeem'),
      edit,
    );
  }
  return h('div', { class: 'row-actions' },
    h('button', { class: 'primary', onclick: () => rolloverForm(i, openingTx) }, 'Roll over'),
    i.type === 'fixed_deposit' ? h('button', { onclick: () => liquidationForm(i, openingTx) }, 'Part-liquidate') : null,
    h('button', { onclick: () => maturityForm(i) }, 'Record maturity'), edit);
}

/** Refuses a tenor above the limit in Settings > Limits. */
function checkTenor(valueDate, maturityDate) {
  const max = Number(limitsFrom(state.data).maxTenorDays);
  const days = daysBetween(valueDate, maturityDate);
  if (days > max) throw new Error(`Tenor is ${days} days; the limit is ${max} days (Settings → Limits and alerts).`);
}

/**
 * Roll a deal over on the same terms: same counterparty, rate (or discount rate) and tenor, starting on the
 * maturity date, with principal = the maturity proceeds. Every figure can be changed before saving.
 */
function rolloverForm(i, openingTx) {
  const tenor = daysBetween(i.valueDate, i.maturityDate);
  const proceeds = expectedMaturityValue(i);
  const isDiscount = DISCOUNT.includes(i.type);
  openForm({
    title: 'Roll over on the same terms',
    intro: `${TYPE_LABELS[i.type]} · ${i.counterpartyName ?? ''} · ${tenor} days. Records the maturity and the new deal together; one Undo in Change history reverses both.`,
    submitLabel: 'Roll over',
    fields: [
      { name: 'date', label: 'Maturity and rollover date', type: 'date', required: true, value: i.maturityDate },
      { name: 'amount', label: 'Maturity proceeds (₦)', type: 'money', required: true, value: proceeds ?? '', help: 'Principal plus interest (or face value) received.' },
      { name: 'cost', label: 'New principal (₦)', type: 'money', required: true, value: proceeds ?? '', help: 'Defaults to the full proceeds. Less leaves the rest in cash; more adds cash from the account.' },
      { name: 'rate', label: 'Interest rate (% p.a.)', type: 'percent', required: true, value: pct(i.rate), showIf: () => DEPOSIT_TYPES.has(i.type) },
      { name: 'discountRate', label: 'Discount rate (%)', type: 'percent', required: true, value: pct(i.discountRate), showIf: () => isDiscount, help: 'Face value is worked out from this, the principal and the tenor.' },
      { name: 'tenor', label: 'Tenor (days)', type: 'number', required: true, value: String(tenor) },
      { name: 'reference', label: 'New deal reference', type: 'text', value: openingTx?.reference ? `${openingTx.reference} (rolled)` : '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: `Rollover of ${openingTx?.reference ?? 'the previous deal'}` },
    ],
    onSubmit: async (v) => {
      const amount = parseMoney(v.amount, 'Maturity proceeds');
      const cost = parseMoney(v.cost, 'New principal');
      if (!/^\d+$/.test(v.tenor) || Number(v.tenor) < 1) throw new Error('Tenor: enter a whole number of days.');
      const maturityDate = addDays(v.date, Number(v.tenor));
      checkTenor(v.date, maturityDate);
      const next = {
        type: i.type, counterpartyName: i.counterpartyName, custodianName: i.custodianName,
        tradeDate: v.date, valueDate: v.date, maturityDate, cost,
      };
      checkRating(state.data, next, v.date);
      if (DEPOSIT_TYPES.has(i.type)) next.rate = parsePercent(v.rate, 'Interest rate');
      if (isDiscount) {
        // Discount basis, Actual/365: price = face x (1 - d x t / 365), so face = cost / (1 - d x t / 365).
        next.discountRate = parsePercent(v.discountRate, 'Discount rate');
        const factor = dec(1).minus(dec(next.discountRate).times(v.tenor).div(365));
        if (factor.lte(0)) throw new Error('Discount rate and tenor give no valid price.');
        next.faceValue = dec(cost).div(factor).toFixed(2);
      }
      await rollOverDeal(i, { date: v.date, amount, reference: openingTx?.reference, notes: 'Rolled over' }, next, { reference: v.reference || openingTx?.reference, notes: v.notes });
      toast(`Rolled over to ${maturityDate}.`);
    },
  });
}

const pct = (fraction) => (fraction ? dec(fraction).times(100).toFixed() : '');

/** New deal, or edit an existing one (inst + its opening transaction). */
function dealForm(data, inst, openingTx, preset) {
  const funds = data.funds ?? [];
  const today = todayISO();
  const isDiscount = (v) => DISCOUNT.includes(v.type);
  openForm({
    title: inst ? 'Edit deal' : 'New deal',
    intro: inst ? 'Changing cost or value date also updates the investment entry.' : 'Records the instrument and the investment entry that pays for it.',
    submitLabel: 'Save deal',
    fields: [
      { name: 'type', label: 'Instrument type', type: 'select', required: true, value: inst?.type ?? preset?.type ?? 'ntb', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
      { name: 'fundId', label: 'Fund', type: 'select', required: true, value: inst?.fundId ?? preset?.fundId ?? '', placeholder: funds.length ? 'Choose a fund' : 'No funds yet: add them under Settings → Funds', options: funds.map((f) => ({ value: f.id, label: f.name })), showIf: (v) => v.type === 'money_market_fund' },
      { name: 'counterpartyName', label: 'Counterparty (bank, issuer or fund manager)', type: 'text', required: true, value: inst?.counterpartyName ?? preset?.counterpartyName ?? '' },
      { name: 'custodianName', label: 'Custodian', type: 'text', value: inst?.custodianName ?? '' },
      { name: 'tradeDate', label: 'Trade date', type: 'date', required: true, value: inst?.tradeDate ?? today },
      { name: 'valueDate', label: 'Value (settlement) date', type: 'date', required: true, value: inst?.valueDate ?? today },
      { name: 'maturityDate', label: 'Maturity date', type: 'date', required: true, value: inst?.maturityDate ?? '', showIf: (v) => v.type !== 'money_market_fund' },
      { name: 'faceValue', label: 'Face value (₦)', type: 'money', required: true, value: inst?.faceValue ?? '', showIf: isDiscount },
      { name: 'cost', label: 'Amount paid / principal (₦)', type: 'money', required: true, value: inst?.cost ?? '' },
      { name: 'discountRate', label: 'Discount rate (%)', type: 'percent', value: pct(inst?.discountRate), help: 'For reference; value is driven by cost and face value.', showIf: isDiscount },
      { name: 'rate', label: 'Interest rate (% p.a.)', type: 'percent', required: true, value: pct(inst?.rate), showIf: (v) => DEPOSIT_TYPES.has(v.type) },
      { name: 'units', label: 'Units', type: 'decimal', required: true, value: inst?.units ?? '', showIf: (v) => v.type === 'money_market_fund' && funds.find((f) => f.id === v.fundId)?.pricingBasis === 'price' },
      ...(inst ? [] : [{ name: 'reference', label: 'Deal reference', type: 'text' }, { name: 'notes', label: 'Notes', type: 'textarea' }]),
    ],
    onSubmit: async (v) => {
      const next = {
        type: v.type,
        counterpartyName: v.counterpartyName,
        custodianName: v.custodianName,
        tradeDate: v.tradeDate,
        valueDate: v.valueDate,
        cost: parseMoney(v.cost, 'Amount paid'),
      };
      if (v.valueDate < v.tradeDate) throw new Error('Value date cannot be before the trade date.');
      if (v.type !== 'money_market_fund') {
        if (v.maturityDate <= v.valueDate) throw new Error('Maturity date must be after the value date.');
        if (!inst) checkTenor(v.valueDate, v.maturityDate);
        next.maturityDate = v.maturityDate;
      }
      if (DISCOUNT.includes(v.type)) {
        next.faceValue = parseMoney(v.faceValue, 'Face value');
        if (dec(next.faceValue).lte(next.cost)) throw new Error('Face value must be more than the amount paid for a discount instrument.');
        if (v.discountRate) next.discountRate = parsePercent(v.discountRate, 'Discount rate');
      }
      if (DEPOSIT_TYPES.has(v.type)) next.rate = parsePercent(v.rate, 'Interest rate');
      if (v.type === 'money_market_fund') {
        const fund = funds.find((f) => f.id === v.fundId);
        if (!fund) throw new Error('Choose a fund.');
        next.fundId = fund.id;
        next.pricingBasis = fund.pricingBasis;
        if (fund.pricingBasis === 'price') next.units = parseDecimal(v.units, 'Units');
      }
      if (!inst) checkRating(data, next);
      if (inst) {
        if (inst.type !== next.type && (inst.type === 'money_market_fund') !== (next.type === 'money_market_fund')) {
          throw new Error('A fund holding cannot be changed into a bill or deposit (or back). Delete the investment entry and enter a new deal.');
        }
        await updateDeal(inst.id, next, openingTx);
        toast('Deal updated.');
      } else {
        await createDeal(next, { reference: v.reference, notes: v.notes });
        toast('Deal saved.');
      }
    },
  });
}

function maturityForm(i) {
  openForm({
    title: 'Record maturity',
    intro: `${TYPE_LABELS[i.type]} · ${i.counterpartyName ?? ''}`,
    submitLabel: 'Save maturity',
    fields: [
      { name: 'date', label: 'Date cash received', type: 'date', required: true, value: i.maturityDate },
      { name: 'amount', label: 'Amount received (₦)', type: 'money', required: true, value: expectedMaturityValue(i) ?? '' },
      { name: 'reference', label: 'Reference', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea', help: 'To roll over, record this maturity, then enter the new deal.' },
    ],
    onSubmit: async (v) => {
      await saveTransaction(null, { type: 'mature', date: v.date, amount: parseMoney(v.amount, 'Amount'), instrumentId: i.id, reference: v.reference, notes: v.notes });
      toast('Maturity recorded.');
    },
  });
}

function redemptionForm(i) {
  openForm({
    title: 'Redeem fund holding',
    intro: 'Full redemption. The holding leaves NAV on the redemption date.',
    submitLabel: 'Save redemption',
    fields: [
      { name: 'date', label: 'Redemption date', type: 'date', required: true, value: todayISO() },
      { name: 'amount', label: 'Amount received (₦)', type: 'money', required: true },
      { name: 'reference', label: 'Reference', type: 'text' },
    ],
    onSubmit: async (v) => {
      await saveTransaction(null, { type: 'fund_redemption', date: v.date, amount: parseMoney(v.amount, 'Amount'), instrumentId: i.id, reference: v.reference });
      toast('Redemption recorded.');
    },
  });
}

function fundPriceForm(fund) {
  if (!fund) return toast('Fund not found.', 'bad');
  const yieldBasis = fund.pricingBasis === 'yield';
  openForm({
    title: `${fund.name}: ${yieldBasis ? 'yield' : 'price'}`,
    submitLabel: 'Save',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, value: todayISO() },
      { name: 'value', label: yieldBasis ? 'Annual yield (%)' : 'Price per unit (₦)', type: yieldBasis ? 'percent' : 'decimal', required: true },
    ],
    onSubmit: async (v) => {
      const value = yieldBasis ? parsePercent(v.value, 'Yield') : parseDecimal(v.value, 'Price');
      await saveFundPrice(fund.id, v.date, value);
      toast('Saved.');
    },
  });
}
