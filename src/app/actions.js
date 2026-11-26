// Every write goes through here, one batch per action. Each action is also written to the change history
// (the 'audit' collection): the version of every document before and after, so it can be restored.
import { db, collection, doc, writeBatch, serverTimestamp } from './firebase.js';
import { historyDocs } from './history.js';
import { state } from './store.js';
import { closedQuarters, lockedBy } from './close.js';
import { restoreDocs } from './backup.js';

/** Drop empty optional fields so documents only carry what was entered. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

const TX_FIELDS = ['type', 'date', 'amount', 'instrumentId', 'reference', 'notes'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

/** A document as currently loaded, without its id and timestamp; null when it doesn't exist. */
function current(coll, id) {
  const found = (state.data[coll] ?? []).find((d) => d.id === id);
  if (!found) return null;
  const { id: _id, updatedAt: _u, ...rest } = found;
  return rest;
}

/** Set when the change history could not be written (Firestore rules not yet published). */
export const historyStatus = { failing: false };

/**
 * Writes the changes in one batch, then records them in the change history.
 * changes: [{ coll, id, data }] where data is the full new document, or null to delete it.
 */
async function commit(summary, changes, { kind = 'edit' } = {}) {
  // A closed quarter's figures are final: nothing dated in it may change until it is reopened.
  const closed = closedQuarters(state.data);
  for (const c of changes) {
    const q = lockedBy(closed, c.coll, current(c.coll, c.id)) ?? lockedBy(closed, c.coll, c.data);
    if (q) throw new Error(`${q.label} is closed, so entries dated in it can't change. Reopen it on the Quarter close screen first, or record a correction dated after it.`);
  }
  const batch = writeBatch(db);
  const entry = [];
  for (const c of changes) {
    const ref = doc(db, c.coll, c.id);
    const before = current(c.coll, c.id);
    if (c.data === null) batch.delete(ref);
    else batch.set(ref, c.stamp === false ? c.data : { ...c.data, updatedAt: serverTimestamp() });
    entry.push({ coll: c.coll, docId: c.id, before, after: c.data });
  }
  await batch.commit();
  // The history is a second write so a missing rule never blocks the change itself.
  try {
    const log = writeBatch(db);
    log.set(doc(collection(db, 'audit')), { summary, kind, at: serverTimestamp(), changes: entry });
    await log.commit();
    historyStatus.failing = false;
  } catch (err) {
    console.warn('Change history not written:', err);
    historyStatus.failing = true;
  }
}

const newId = (coll) => doc(collection(db, coll)).id;

// ---------- transactions ----------

/** Create (id null) or replace a transaction. */
export async function saveTransaction(id, fields, summary) {
  const txId = id ?? newId('transactions');
  const data = clean(pick(fields, TX_FIELDS));
  await commit(summary ?? `${id ? 'Edited' : 'Added'} ${data.type} of ${data.amount} on ${data.date}`, [{ coll: 'transactions', id: txId, data }]);
  return txId;
}

/** Delete a transaction. Deleting a deal's investment entry also removes the instrument. */
export async function deleteTransaction(tx) {
  const changes = [{ coll: 'transactions', id: tx.id, data: null }];
  if ((tx.type === 'invest' || tx.type === 'fund_subscription') && tx.instrumentId) {
    changes.push({ coll: 'instruments', id: tx.instrumentId, data: null });
  }
  await commit(`Deleted ${tx.type} of ${tx.amount} on ${tx.date}`, changes, { kind: 'delete' });
}

// ---------- deals ----------

/** A new deal: the instrument plus the transaction that pays for it. */
export async function createDeal(inst, tx) {
  const instId = newId('instruments');
  const opening = clean({
    type: inst.type === 'money_market_fund' ? 'fund_subscription' : 'invest',
    date: inst.valueDate,
    amount: inst.cost,
    instrumentId: instId,
    reference: tx.reference,
    notes: tx.notes,
  });
  await commit(`New deal: ${inst.type} with ${inst.counterpartyName ?? ''} for ${inst.cost}`, [
    { coll: 'instruments', id: instId, data: clean(inst) },
    { coll: 'transactions', id: newId('transactions'), data: opening },
  ]);
}

/** Edit a deal's terms; keeps its investment entry's date and amount in step. */
export async function updateDeal(instId, inst, openingTx) {
  const changes = [{ coll: 'instruments', id: instId, data: clean(inst) }];
  if (openingTx) {
    const tx = current('transactions', openingTx.id) ?? {};
    changes.push({ coll: 'transactions', id: openingTx.id, data: { ...tx, date: inst.valueDate, amount: inst.cost } });
  }
  await commit(`Edited deal with ${inst.counterpartyName ?? ''}`, changes);
}

/**
 * Roll a deal over in one step: its maturity, the new deal and the new deal's investment entry, written together
 * (one change in the history, so one Undo reverses all three).
 */
export async function rollOverDeal(old, maturity, next, tx) {
  const instId = newId('instruments');
  await commit(`Rolled over ${old.type} with ${old.counterpartyName ?? ''}: ${maturity.amount} into ${next.cost}`, [
    { coll: 'transactions', id: newId('transactions'), data: clean({ type: 'mature', date: maturity.date, amount: maturity.amount, instrumentId: old.id, reference: maturity.reference, notes: maturity.notes }) },
    { coll: 'instruments', id: instId, data: clean(next) },
    { coll: 'transactions', id: newId('transactions'), data: clean({ type: 'invest', date: next.valueDate, amount: next.cost, instrumentId: instId, reference: tx.reference, notes: tx.notes }) },
  ]);
}

export async function saveFundPrice(fundId, date, priceOrYield) {
  await commit(`Fund yield or price for ${date}: ${priceOrYield}`, [{ coll: 'fundPrices', id: `${fundId}_${date}`, data: { fundId, date, priceOrYield }, stamp: false }]);
}

// ---------- change history ----------

/** Puts every document an earlier change touched back the way it was before that change. */
export async function restoreChange(entry) {
  await commit(
    `Undid: ${entry.summary}`,
    entry.changes.map((c) => ({ coll: c.coll, id: c.docId, data: c.before, stamp: ['transactions', 'instruments'].includes(c.coll) })),
    { kind: 'restore' },
  );
}

// ---------- history import ----------

/**
 * Writes a history file's documents (see history.js) in batches of 400. Ids are fixed, so if a batch fails
 * the import can simply be run again. Calls onProgress(written, total) after each batch. Not in the change history.
 */
export async function importHistory(file, onProgress) {
  const docs = historyDocs(file);
  const stamped = new Set(['instruments', 'transactions']);
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + 400)) {
      batch.set(doc(db, d.coll, d.id), stamped.has(d.coll) ? { ...d.data, updatedAt: serverTimestamp() } : d.data);
    }
    await batch.commit();
    onProgress?.(Math.min(i + 400, docs.length), docs.length);
  }
}

/** Changes the type of the given instruments (used once to move calls out of fixed deposits). */
export async function reclassifyInstruments(ids, type) {
  await commit(`Reclassified ${ids.length} deals as ${type}`, ids.map((id) => ({ coll: 'instruments', id, data: { ...current('instruments', id), type } })));
}

// ---------- settings ----------

/** Create (id null) or replace a settings document. */
export async function saveDoc(coll, id, data) {
  const docId = id ?? newId(coll);
  await commit(`${id ? 'Edited' : 'Added'} ${{ mandateTerms: 'mandate terms', funds: 'fund', settings: 'limits', auctions: 'auction result', mpc: 'MPC decision', cpQuotes: 'CP quotation', invoices: 'billed fees', counterparties: 'counterparty', ratings: 'rating', limitSets: 'limits', auctionCalendar: 'auction date' }[coll] ?? coll}`, [{ coll, id: docId, data: clean(data), stamp: false }]);
  return docId;
}

/** Delete a settings or market document (not transactions or deals: those have their own actions). */
export async function deleteDoc(coll, id, summary) {
  await commit(summary ?? `Deleted ${coll} ${id}`, [{ coll, id, data: null }], { kind: 'delete' });
}

// ---------- quarter close ----------

/** Saves the quarter's figures (see closeRecord) and so locks it. */
export async function closeQuarter(record) {
  await commit(`Closed ${record.quarter}: management fee ${record.mgmtFee}, incentive ${record.incentiveClause8}`, [
    { coll: 'quarterlyResults', id: record.quarter, data: { ...record, closedAt: new Date().toISOString() }, stamp: false },
  ]);
}

/** Marks a closed quarter as billed (invoice sent) on a date. */
export async function markBilled(label, billedOn) {
  const rec = current('quarterlyResults', label);
  await commit(`Marked ${label} billed on ${billedOn}`, [{ coll: 'quarterlyResults', id: label, data: { ...rec, status: 'billed', billedOn }, stamp: false }]);
}

/** Removes the close record, unlocking the quarter. The old figures stay in the change history. */
export async function reopenQuarter(label) {
  await commit(`Reopened ${label}`, [{ coll: 'quarterlyResults', id: label, data: null }], { kind: 'delete' });
}

// ---------- back-test ----------

/** Loads the billed fees (data/invoices-mcm.json) as one change, so it can be undone from Change history. */
export async function importInvoices(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('The file holds no quarters.');
  const changes = list.map((i) => ({ coll: 'invoices', id: i.quarter, data: clean({ ...i, id: undefined }), stamp: false }));
  await commit(`Loaded billed fees for ${list.length} quarters (${list[0].quarter} to ${list.at(-1).quarter})`, changes);
}

// ---------- limits ----------

/** Saves the limits as the current set and as a dated version (limitSets/{effectiveFrom}), in one change. */
export async function saveLimits(limits, effectiveFrom) {
  await commit(`Limits effective ${effectiveFrom}`, [
    { coll: 'settings', id: 'limits', data: clean(limits), stamp: false },
    { coll: 'limitSets', id: effectiveFrom, data: clean({ ...limits, effectiveFrom }), stamp: false },
  ]);
}

// ---------- backup ----------

/** Writes a backup file's documents back in batches of 400 (not in the change history; ids are fixed, so rerunnable). */
export async function restoreBackup(file, onProgress) {
  const docs = restoreDocs(file);
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + 400)) batch.set(doc(db, d.coll, d.id), d.data);
    await batch.commit();
    onProgress?.(Math.min(i + 400, docs.length), docs.length);
  }
}

/** Adds several new documents to a collection as one change (e.g. counterparties found in the holdings). */
export async function saveDocs(coll, list, summary) {
  await commit(summary, list.map((data) => ({ coll, id: newId(coll), data: clean(data), stamp: false })));
}
