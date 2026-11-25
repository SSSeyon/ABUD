import { dec } from '../../engine/index.js';
import { deleteTransaction, saveTransaction } from '../actions.js';
import { ASSET_CLASSES, CLASS_LABELS, txClass, TX_LABELS, TX_SIGN, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, confirmDialog, fmtDate, fmtNaira, h, openForm, parseMoney, runAction, table, toast, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments'];
const filters = { type: '', cls: '', from: '', to: '' };

export function transactionsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const all = [...(data.transactions ?? [])].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const inRange = all.filter((t) => (!filters.from || t.date >= filters.from) && (!filters.to || t.date <= filters.to) && (!filters.type || t.type === filters.type));
  const shown = filters.cls ? inRange.filter((t) => txClass(t, instruments) === filters.cls) : inRange;
  const counts = {};
  for (const t of inRange) counts[txClass(t, instruments)] = (counts[txClass(t, instruments)] ?? 0) + 1;
  const chip = (key, label, n) =>
    h('button', { class: `chip ${filters.cls === key ? 'active' : ''}`, 'aria-pressed': String(filters.cls === key), onclick: () => { filters.cls = key; rerender(); } },
      key ? h('span', { class: 'swatch', style: `background:var(--class-${key})` }) : null, label, h('span', { class: 'chip-count' }, String(n)));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Asset class' },
    chip('', 'All', inRange.length),
    ASSET_CLASSES.filter((c) => counts[c.key]).map((c) => chip(c.key, c.label, counts[c.key])));

  const rows = shown.map((t) => {
    const signed = t.type === 'rollover' ? dec(t.amount) : dec(t.amount).times(TX_SIGN[t.type] ?? 1);
    const inst = t.instrumentId ? instruments.get(t.instrumentId) : null;
    const isDeal = t.type === 'invest' || t.type === 'fund_subscription';
    return h(
      'tr',
      null,
      h('td', null, fmtDate(t.date)),
      h('td', null, TX_LABELS[t.type] ?? t.type),
      h('td', { class: `num ${signed.isNegative() ? 'neg' : ''}` }, fmtNaira(signed)),
      h('td', null, classTag(txClass(t, instruments), CLASS_LABELS[txClass(t, instruments)]), inst ? h('div', { class: 'muted' }, inst.counterpartyName ?? '') : null),
      h('td', null, t.reference ?? '', t.notes ? h('div', { class: 'muted' }, t.notes) : null),
      h(
        'td',
        null,
        h(
          'div',
          { class: 'row-actions' },
          isDeal ? h('span', { class: 'muted' }, 'Edit under Holdings') : h('button', { onclick: () => transactionForm(data, t) }, 'Edit'),
          h('button', {
            class: 'danger',
            onclick: async (e) => {
              const ok = await confirmDialog({
                title: 'Delete entry',
                message: isDeal
                  ? 'Delete this investment entry? The deal (instrument) is deleted with it.'
                  : `Delete this ${TX_LABELS[t.type]?.toLowerCase() ?? 'entry'} of ${fmtNaira(t.amount)} on ${fmtDate(t.date)}?`,
                confirmLabel: 'Delete',
                danger: true,
              });
              if (ok) runAction(e.target, () => deleteTransaction(t), 'Deleted.');
            },
          }, 'Delete'),
        ),
      ),
    );
  });

  const filterSelect = h(
    'select',
    { 'aria-label': 'Filter by type', class: 'filter', value: filters.type, onchange: (e) => { filters.type = e.target.value; rerender(); } },
    h('option', { value: '' }, 'All types'),
    Object.entries(TX_LABELS).map(([value, label]) => h('option', { value }, label)),
  );
  const dateInput = (key, label) =>
    h('label', { class: 'inline-field' }, label, h('input', { type: 'date', value: filters[key], onchange: (e) => { filters[key] = e.target.value; rerender(); } }));
  const net = shown.reduce((s, t) => s.plus(t.type === 'rollover' ? dec(t.amount) : dec(t.amount).times(TX_SIGN[t.type] ?? 1)), dec(0));

  return h(
    'div',
    null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Transactions'), h('p', { class: 'subtitle' }, `${shown.length} entries · net cash effect ${fmtNaira(net)}`)),
      h('button', { class: 'primary', onclick: () => transactionForm(data) }, 'New entry')),
    h('div', { class: 'toolbar' }, chips, h('div', { class: 'row-actions' }, dateInput('from', 'From'), dateInput('to', 'To'), filterSelect,
      filters.from || filters.to || filters.type || filters.cls ? h('button', { class: 'link', onclick: () => { Object.assign(filters, { type: '', cls: '', from: '', to: '' }); rerender(); } }, 'Clear filters') : null)),
    table(['Date', 'Type', { label: 'Cash effect', num: true }, 'Asset class', 'Reference', ''], rows, 'No transactions match.'),
  );
}

const ENTRY_TYPES = ['inflow', 'withdrawal', 'interest', 'fee_debit', 'mature', 'fund_redemption'];

/** New entry, or edit an existing one. Deals are entered under Holdings. */
export function transactionForm(data, tx) {
  const instOptions = (data.instruments ?? []).map((i) => ({ value: i.id, label: `${TYPE_LABELS[i.type]} · ${i.counterpartyName ?? ''} · ${fmtNaira(i.cost)}` }));
  const types = tx && !ENTRY_TYPES.includes(tx.type) ? [...ENTRY_TYPES, tx.type] : ENTRY_TYPES;
  openForm({
    title: tx ? 'Edit entry' : 'New entry',
    intro: tx ? null : 'For new investments use Holdings → New deal.',
    submitLabel: 'Save entry',
    fields: [
      { name: 'type', label: 'Type', type: 'select', required: true, value: tx?.type ?? 'inflow', options: types.map((t) => ({ value: t, label: TX_LABELS[t] })) },
      { name: 'instrumentId', label: 'Instrument', type: 'select', required: true, value: tx?.instrumentId ?? '', placeholder: 'Choose the instrument', options: instOptions, showIf: (v) => ['mature', 'fund_redemption'].includes(v.type) },
      { name: 'interestInstrumentId', label: 'Instrument (optional)', type: 'select', value: tx?.instrumentId ?? '', placeholder: 'Not linked', options: instOptions, showIf: (v) => v.type === 'interest' },
      { name: 'date', label: 'Date', type: 'date', required: true, value: tx?.date ?? todayISO() },
      { name: 'amount', label: 'Amount (₦)', type: 'money', required: true, value: tx?.amount ?? '' },
      { name: 'reference', label: 'Reference', type: 'text', value: tx?.reference ?? '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: tx?.notes ?? '' },
    ],
    onSubmit: async (v) => {
      await saveTransaction(tx?.id ?? null, {
        type: v.type,
        date: v.date,
        amount: parseMoney(v.amount, 'Amount'),
        instrumentId: v.instrumentId || v.interestInstrumentId,
        reference: v.reference,
        notes: v.notes,
      });
      toast(tx ? 'Entry updated.' : 'Entry saved.');
    },
  });
}
