import { addDays, FundPriceBook, Valuer, daysBetween, dec } from '../../engine/index.js';
import { limitsFrom } from '../alerts.js';
import { createDeal, rollOverDeal, saveFundPrice, saveTransaction, updateDeal } from '../actions.js';
import { ASSET_CLASSES, closedInstrumentIds, DEPOSIT_TYPES, engineInputs, expectedMaturityValue, openingTransactions, toEngineInstrument, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, fmtDate, fmtNaira, fmtPct, h, openForm, parseDecimal, parseMoney, parsePercent, table, toast, todayISO } from '../ui.js';

const DISCOUNT = ['ntb', 'omo', 'commercial_paper'];
const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];

export function holdingsView() {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const closed = closedInstrumentIds(data.transactions);
  const opening = openingTransactions(data.transactions);
  const valuer = new Valuer(new FundPriceBook(engineInputs(data).fundPrices));
  const funds = new Map((data.funds ?? []).map((f) => [f.id, f]));

  const live = (data.instruments ?? [])
    .filter((i) => !closed.has(i.id))
    .sort((a, b) => ((a.maturityDate ?? '9999') < (b.maturityDate ?? '9999') ? -1 : 1));

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
      { class: dtm != null && dtm < 0 ? 'bad' : null },
      h('td', null, TYPE_LABELS[i.type], i.type === 'money_market_fund' ? h('div', { class: 'muted' }, funds.get(i.fundId)?.name ?? '') : null, dtm != null && dtm < 0 ? h('div', { class: 'badge warn' }, 'Matured: record it') : null),
      h('td', null, i.counterpartyName ?? ''),
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
    const group = live.filter((i) => i.type === c.key);
    if (!group.length) continue;
    const values = group.map(valueOf);
    const sub = values.reduce((t, v) => (typeof v === 'string' ? t : t.plus(v)), dec(0));
    total = total.plus(sub);
    rows.push(h('tr', { class: 'group' }, h('td', { colspan: 8 }, classTag(c.key, c.label), h('span', { class: 'muted' }, ` · ${group.length}`)), h('td', { class: 'num' }, fmtNaira(sub)), h('td', null)));
    group.forEach((i, n) => rows.push(row(i, values[n])));
  }
  if (rows.length) rows.push(h('tr', { class: 'total' }, h('td', { colspan: 8 }, 'Total holdings'), h('td', { class: 'num' }, fmtNaira(total)), h('td', null)));

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Holdings'), h('p', { class: 'subtitle' }, `Open positions at end of ${fmtDate(today)}, by asset class`)), h('button', { class: 'primary', onclick: () => dealForm(data) }, 'New deal')),
    table(
      ['Instrument', 'Counterparty', { label: 'Cost', num: true }, { label: 'At maturity', num: true }, 'Rate', 'Value date', 'Maturity', { label: 'Days left', num: true }, { label: 'Value today', num: true }, ''],
      rows,
      'No holdings yet. Use "New deal" to record an investment.',
    ),
    h('p', { class: 'muted' }, 'Values are end of day: bills and CPs at amortised cost, deposits with accrued interest, funds at the latest price or accrued yield. Matured and redeemed holdings drop off this list once the maturity or redemption is recorded.'),
  );
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
function dealForm(data, inst, openingTx) {
  const funds = data.funds ?? [];
  const today = todayISO();
  const isDiscount = (v) => DISCOUNT.includes(v.type);
  openForm({
    title: inst ? 'Edit deal' : 'New deal',
    intro: inst ? 'Changing cost or value date also updates the investment entry.' : 'Records the instrument and the investment entry that pays for it.',
    submitLabel: 'Save deal',
    fields: [
      { name: 'type', label: 'Instrument type', type: 'select', required: true, value: inst?.type ?? 'ntb', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
      { name: 'fundId', label: 'Fund', type: 'select', required: true, value: inst?.fundId ?? '', placeholder: funds.length ? 'Choose a fund' : 'No funds yet: add them under Settings → Funds', options: funds.map((f) => ({ value: f.id, label: f.name })), showIf: (v) => v.type === 'money_market_fund' },
      { name: 'counterpartyName', label: 'Counterparty (bank, issuer or fund manager)', type: 'text', required: true, value: inst?.counterpartyName ?? '' },
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
