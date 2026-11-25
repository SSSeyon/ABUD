// Change history: every save and delete, with what changed and a button to put it back.
import { historyStatus, restoreChange } from '../actions.js';
import { TX_LABELS, TYPE_LABELS } from '../portfolio.js';
import { state } from '../store.js';
import { confirmDialog, fmtDate, fmtNaira, h, runAction } from '../ui.js';

const FIELD_LABELS = {
  type: 'Type', date: 'Date', amount: 'Amount', instrumentId: 'Deal', reference: 'Reference', notes: 'Notes',
  counterpartyName: 'Counterparty', custodianName: 'Custodian', cost: 'Cost', faceValue: 'Face value', rate: 'Rate',
  discountRate: 'Discount rate', tradeDate: 'Trade date', valueDate: 'Value date', maturityDate: 'Maturity date',
  priceOrYield: 'Price or yield', name: 'Name',
};
const MONEY = new Set(['amount', 'cost', 'faceValue']);
const DATES = new Set(['date', 'tradeDate', 'valueDate', 'maturityDate']);

function fmtField(k, v) {
  if (v == null || v === '') return '—';
  if (MONEY.has(k)) return fmtNaira(v);
  if (DATES.has(k)) return fmtDate(v);
  if (k === 'type') return TX_LABELS[v] ?? TYPE_LABELS[v] ?? v;
  return String(v);
}

/** One line naming the document a change touched. */
function describe(coll, d) {
  if (!d) return '';
  if (coll === 'transactions') return `${TX_LABELS[d.type] ?? d.type} ${fmtNaira(d.amount)} on ${fmtDate(d.date)}`;
  if (coll === 'instruments') return `${TYPE_LABELS[d.type] ?? d.type} · ${d.counterpartyName ?? ''} · ${fmtNaira(d.cost)}`;
  if (coll === 'fundPrices') return `Fund ${d.date}: ${d.priceOrYield}`;
  return d.name ?? d.clientName ?? coll;
}

function changeDetail(c) {
  const what = c.before && !c.after ? 'Deleted' : !c.before ? 'Added' : 'Edited';
  const fields = c.before && c.after
    ? [...new Set([...Object.keys(c.before), ...Object.keys(c.after)])].filter((k) => k !== 'updatedAt' && String(c.before[k] ?? '') !== String(c.after[k] ?? ''))
    : [];
  return h('li', null,
    h('span', { class: `badge ${what === 'Deleted' ? 'bad' : what === 'Added' ? 'ok' : ''}` }, what), ' ',
    describe(c.coll, c.after ?? c.before),
    fields.length ? h('ul', { class: 'diff' }, fields.map((k) => h('li', null, `${FIELD_LABELS[k] ?? k}: `, h('del', null, fmtField(k, c.before[k])), ' → ', h('ins', null, fmtField(k, c.after[k]))))) : null);
}

/** True when a document has changed again since this entry (restoring would also undo that). */
function changedSince(entry) {
  return entry.changes.some((c) => {
    const now = (state.data[c.coll] ?? []).find((d) => d.id === c.docId);
    if (!now) return c.after != null;
    if (!c.after) return true;
    const { id, updatedAt, ...rest } = now;
    return JSON.stringify(Object.entries(rest).sort()) !== JSON.stringify(Object.entries(c.after).sort());
  });
}

export function historyView() {
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Change history'), h('p', { class: 'subtitle' }, 'Every save and delete made in the app, newest first. Undo puts the records back as they were before that change.')));
  if (state.errors.audit || historyStatus.failing) {
    return h('div', null, head, h('div', { class: 'card warn' },
      h('h2', null, 'Change history is not switched on yet'),
      h('p', null, 'Publish the updated firestore.rules in the Firebase console (project abud-24577 → Firestore → Rules). Until then, changes still save but are not recorded here.')));
  }
  if (!state.loaded.has('audit')) return h('div', null, head, h('p', { class: 'muted' }, 'Loading…'));

  const entries = [...(state.data.audit ?? [])].sort((a, b) => (b.at?.toMillis?.() ?? Infinity) - (a.at?.toMillis?.() ?? Infinity));
  if (!entries.length) return h('div', null, head, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No changes recorded yet. Changes made from now on will appear here.')));

  return h('div', null, head,
    h('ol', { class: 'timeline' }, entries.slice(0, 300).map((e) => {
      const when = e.at?.toDate?.();
      return h('li', { class: `card entry ${e.kind}` },
        h('div', { class: 'entry-head' },
          h('div', null,
            h('div', { class: 'entry-when' }, when ? when.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }) : 'Saving…'),
            h('div', { class: 'entry-kind' }, e.kind === 'restore' ? 'Undo' : e.kind === 'delete' ? 'Delete' : 'Change')),
          h('button', {
            onclick: async (ev) => {
              const later = changedSince(e);
              const ok = await confirmDialog({
                title: 'Undo this change?',
                message: later
                  ? 'Some of these records have changed again since. Undoing puts them back to how they were before this change, which also discards the later edits.'
                  : 'The records go back to how they were before this change. The undo itself is recorded here too, so it can be reversed.',
                confirmLabel: 'Undo change',
                danger: later,
              });
              if (ok) runAction(ev.target, () => restoreChange(e), 'Change undone.');
            },
          }, 'Undo')),
        h('ul', { class: 'changes' }, e.changes.map(changeDetail)));
    })));
}
