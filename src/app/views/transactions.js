import { dec } from '../../engine/index.js';
import { deleteTransaction, saveTransaction } from '../actions.js';
import { TX_LABELS, TX_SIGN, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { confirmDialog, fmtDate, fmtNaira, h, openForm, parseMoney, runAction, table, toast, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments'];
let typeFilter = '';

export function transactionsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const all = [...(data.transactions ?? [])].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const shown = typeFilter ? all.filter((t) => t.type === typeFilter) : all;

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
      h('td', null, inst ? `${TYPE_LABELS[inst.type]} · ${inst.counterpartyName ?? ''}` : ''),
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
    { 'aria-label': 'Filter by type', class: 'filter', value: typeFilter, onchange: (e) => { typeFilter = e.target.value; rerender(); } },
    h('option', { value: '' }, 'All types'),
    Object.entries(TX_LABELS).map(([value, label]) => h('option', { value }, label)),
  );

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('h1', null, 'Transactions'), h('div', { class: 'row-actions' }, filterSelect, h('button', { class: 'primary', onclick: () => transactionForm(data) }, 'New entry'))),
    table(['Date', 'Type', { label: 'Cash effect', num: true }, 'Instrument', 'Reference', ''], rows, 'No transactions yet.'),
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
