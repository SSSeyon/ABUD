import { dec } from '../../engine/index.js';
import { deleteTransaction, saveTransaction } from '../actions.js';
import { periodPicker, resolvePeriod, sharedPeriod } from '../period.js';
import { ASSET_CLASSES, CLASS_LABELS, positionsFor, txClass, TX_LABELS, TX_SIGN, TYPE_LABELS } from '../portfolio.js';
import { PAYOUT_PURPOSE, payoutQuarters } from '../payout.js';
import { loadedAll, state } from '../store.js';
import { classTag, confirmDialog, fmtDate, fmtNaira, h, openForm, parseMoney, runAction, table, toast, todayISO } from '../ui.js';
import { openHoldingStatement } from './holdingdetail.js';

const NEEDS = ['transactions', 'instruments'];
const PAGE = 50;
const filters = { type: '', cls: '', q: '', page: 0 };

const signedOf = (t) => (t.type === 'rollover' ? dec(t.amount) : dec(t.amount).times(TX_SIGN[t.type] ?? 1));
const isDealTx = (t) => t.type === 'invest' || t.type === 'fund_subscription';

/** Delete after a confirmation; an investment entry takes its deal with it. */
async function confirmDelete(t) {
  const ok = await confirmDialog({
    title: 'Delete entry',
    message: isDealTx(t)
      ? 'Delete this investment entry? The deal (instrument) is deleted with it.'
      : `Delete this ${TX_LABELS[t.type]?.toLowerCase() ?? 'entry'} of ${fmtNaira(t.amount)} on ${fmtDate(t.date)}?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (ok) await runAction(null, () => deleteTransaction(t), 'Deleted.');
}

/** A row opens its entry: the edit form, or for an investment a summary with its statement (deals are edited under Holdings). */
export function openEntry(data, t, instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]))) {
  if (!isDealTx(t)) return transactionForm(data, t);
  const inst = instruments.get(t.instrumentId);
  const hasPosition = !!inst && positionsFor(data).byId.has(inst.id);
  openForm({
    title: TX_LABELS[t.type],
    intro: `${fmtDate(t.date)} · ${fmtNaira(t.amount)}${inst ? ` · ${TYPE_LABELS[inst.type] ?? ''} · ${inst.counterpartyName ?? ''}` : ''}. Deals are edited under Holdings.`,
    fields: [],
    submitLabel: hasPosition ? 'Open statement' : 'Close',
    onSubmit: async () => { if (hasPosition) setTimeout(() => openHoldingStatement(inst.id)); },
    extra: [{ label: 'Delete', danger: true, onClick: () => confirmDelete(t) }],
  });
}

export function transactionsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const instruments = new Map((data.instruments ?? []).map((i) => [i.id, i]));
  const all = [...(data.transactions ?? [])].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const inception = all.at(-1)?.date ?? '';
  const period = resolvePeriod(sharedPeriod, inception, today);
  const q = filters.q.trim().toLowerCase();
  const matchesText = (t) => !q || [t.reference, t.notes, t.quarter, instruments.get(t.instrumentId)?.counterpartyName, TX_LABELS[t.type], String(t.amount)]
    .some((s) => (s ?? '').toLowerCase().includes(q));
  const inRange = all.filter((t) => t.date >= period.start && t.date <= period.end && (!filters.type || t.type === filters.type) && matchesText(t));
  const shown = filters.cls ? inRange.filter((t) => txClass(t, instruments) === filters.cls) : inRange;
  const counts = {};
  for (const t of inRange) counts[txClass(t, instruments)] = (counts[txClass(t, instruments)] ?? 0) + 1;
  const reset = () => { filters.page = 0; rerender(); };
  const chip = (key, label, n) =>
    h('button', { class: `chip ${filters.cls === key ? 'active' : ''}`, 'aria-pressed': String(filters.cls === key), onclick: () => { filters.cls = key; reset(); } },
      key ? h('span', { class: 'swatch', style: `background:var(--class-${key})` }) : null, label, h('span', { class: 'chip-count' }, String(n)));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Asset class' },
    chip('', 'All', inRange.length),
    ASSET_CLASSES.filter((c) => counts[c.key]).map((c) => chip(c.key, c.label, counts[c.key])));

  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  if (filters.page >= pages) filters.page = pages - 1;
  const rows = shown.slice(filters.page * PAGE, (filters.page + 1) * PAGE).map((t) => {
    const signed = signedOf(t);
    const inst = t.instrumentId ? instruments.get(t.instrumentId) : null;
    const open = () => openEntry(data, t, instruments);
    return h(
      'tr',
      { class: 'clickable', tabindex: 0, title: isDealTx(t) ? 'Open this investment entry' : 'Edit or delete this entry', onclick: open,
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } },
      h('td', null, fmtDate(t.date)),
      h('td', null, TX_LABELS[t.type] ?? t.type, t.purpose === PAYOUT_PURPOSE ? h('div', { class: 'muted' }, `Income payout ${t.quarter}`) : null),
      h('td', { class: `num ${signed.isNegative() ? 'neg' : ''}` }, fmtNaira(signed)),
      h('td', null, classTag(txClass(t, instruments), CLASS_LABELS[txClass(t, instruments)]), inst ? h('div', { class: 'muted' }, inst.counterpartyName ?? '') : null),
      h('td', null, t.reference ?? '', t.notes ? h('div', { class: 'muted' }, t.notes) : null),
    );
  });

  const filterSelect = h(
    'select',
    { 'aria-label': 'Filter by type', class: 'filter', value: filters.type, onchange: (e) => { filters.type = e.target.value; reset(); } },
    h('option', { value: '' }, 'All types'),
    Object.entries(TX_LABELS).map(([value, label]) => h('option', { value }, label)),
  );
  const search = h('input', { type: 'search', class: 'filter', placeholder: 'Search reference, notes, counterparty', 'aria-label': 'Search', value: filters.q,
    onchange: (e) => { filters.q = e.target.value; reset(); } });
  const net = shown.reduce((s, t) => s.plus(signedOf(t)), dec(0));
  const pager = pages > 1
    ? h('div', { class: 'pager' },
        h('button', { disabled: filters.page === 0, onclick: () => { filters.page -= 1; rerender(); } }, '← Newer'),
        h('span', { class: 'muted' }, `${filters.page * PAGE + 1}–${Math.min(shown.length, (filters.page + 1) * PAGE)} of ${shown.length}`),
        h('button', { disabled: filters.page >= pages - 1, onclick: () => { filters.page += 1; rerender(); } }, 'Older →'))
    : null;

  return h(
    'div',
    null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Transactions'), h('p', { class: 'subtitle' }, `${shown.length} entries · net cash effect ${fmtNaira(net)} · click an entry to edit or delete it`)),
      h('div', { class: 'page-tools' }, inception ? periodPicker(sharedPeriod, inception, today, reset) : null,
        h('button', { class: 'primary', onclick: () => transactionForm(data) }, 'New entry'))),
    h('div', { class: 'toolbar' }, chips, h('div', { class: 'row-actions' }, search, filterSelect,
      filters.q || filters.type || filters.cls ? h('button', { class: 'link', onclick: () => { Object.assign(filters, { type: '', cls: '', q: '' }); reset(); } }, 'Clear filters') : null)),
    table(['Date', 'Type', { label: 'Cash effect', num: true }, 'Asset class', 'Reference'], rows, 'No transactions in this period match.'),
    pager,
  );
}

const ENTRY_TYPES = ['inflow', 'withdrawal', 'interest', 'fee_debit', 'mature', 'fund_redemption'];

/** New entry, or edit an existing one (with Delete). Deals are entered under Holdings. */
export function transactionForm(data, tx, preset = {}) {
  const v0 = tx ?? preset;
  const instOptions = (data.instruments ?? []).map((i) => ({ value: i.id, label: `${TYPE_LABELS[i.type]} · ${i.counterpartyName ?? ''} · ${fmtNaira(i.cost)}` }));
  const types = tx && !ENTRY_TYPES.includes(tx.type) ? [...ENTRY_TYPES, tx.type] : ENTRY_TYPES;
  return openForm({
    title: tx ? 'Edit entry' : 'New entry',
    intro: tx ? null : preset.intro ?? 'For new investments use Holdings → New deal.',
    submitLabel: 'Save entry',
    fields: [
      { name: 'type', label: 'Type', type: 'select', required: true, value: v0.type ?? 'inflow', options: types.map((t) => ({ value: t, label: TX_LABELS[t] })) },
      { name: 'instrumentId', label: 'Instrument', type: 'select', required: true, value: tx?.instrumentId ?? '', placeholder: 'Choose the instrument', options: instOptions, showIf: (v) => ['mature', 'fund_redemption'].includes(v.type) },
      { name: 'interestInstrumentId', label: 'Instrument (optional)', type: 'select', value: tx?.instrumentId ?? '', placeholder: 'Not linked', options: instOptions, showIf: (v) => v.type === 'interest' },
      { name: 'quarter', label: 'Income payout for quarter', type: 'select', value: tx?.purpose === PAYOUT_PURPOSE ? tx.quarter : '', placeholder: 'No: an ordinary withdrawal', options: payoutQuarters(todayISO()).map((q) => ({ value: q.label, label: q.label })), showIf: (v) => v.type === 'withdrawal', help: 'Tag a payment of quarterly income to Access, so Quarter close counts it.' },
      { name: 'date', label: 'Date', type: 'date', required: true, value: v0.date ?? todayISO() },
      { name: 'amount', label: 'Amount (₦)', type: 'money', required: true, value: v0.amount ?? '' },
      { name: 'reference', label: 'Reference', type: 'text', value: v0.reference ?? '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: v0.notes ?? '' },
    ],
    extra: tx ? [{ label: 'Delete', danger: true, onClick: () => confirmDelete(tx) }] : [],
    onSubmit: async (v) => {
      await saveTransaction(tx?.id ?? null, {
        type: v.type,
        date: v.date,
        amount: parseMoney(v.amount, 'Amount'),
        instrumentId: v.instrumentId || v.interestInstrumentId,
        ...(v.type === 'withdrawal' && v.quarter ? { purpose: PAYOUT_PURPOSE, quarter: v.quarter } : {}),
        reference: v.reference,
        notes: v.notes,
      });
      toast(tx ? 'Entry updated.' : 'Entry saved.');
    },
  });
}
