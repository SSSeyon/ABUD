// Every write goes through here, one batch per action.
import { db, collection, doc, writeBatch, serverTimestamp } from './firebase.js';
import { historyDocs } from './history.js';

/** Drop empty optional fields so documents only carry what was entered. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

const TX_FIELDS = ['type', 'date', 'amount', 'instrumentId', 'reference', 'notes'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// ---------- transactions ----------

/** Create (id null) or replace a transaction. */
export async function saveTransaction(id, fields) {
  const batch = writeBatch(db);
  const ref = id ? doc(db, 'transactions', id) : doc(collection(db, 'transactions'));
  batch.set(ref, { ...clean(pick(fields, TX_FIELDS)), updatedAt: serverTimestamp() });
  await batch.commit();
  return ref.id;
}

/** Delete a transaction. Deleting a deal's investment entry also removes the instrument. */
export async function deleteTransaction(tx) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'transactions', tx.id));
  if ((tx.type === 'invest' || tx.type === 'fund_subscription') && tx.instrumentId) {
    batch.delete(doc(db, 'instruments', tx.instrumentId));
  }
  await batch.commit();
}

// ---------- deals ----------

/** A new deal: the instrument plus the transaction that pays for it. */
export async function createDeal(inst, tx) {
  const batch = writeBatch(db);
  const instRef = doc(collection(db, 'instruments'));
  batch.set(instRef, { ...clean(inst), updatedAt: serverTimestamp() });
  const txRef = doc(collection(db, 'transactions'));
  batch.set(txRef, {
    ...clean({
      type: inst.type === 'money_market_fund' ? 'fund_subscription' : 'invest',
      date: inst.valueDate,
      amount: inst.cost,
      instrumentId: instRef.id,
      reference: tx.reference,
      notes: tx.notes,
    }),
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

/** Edit a deal's terms; keeps its investment entry's date and amount in step. */
export async function updateDeal(instId, inst, openingTx) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'instruments', instId), { ...clean(inst), updatedAt: serverTimestamp() });
  if (openingTx) {
    batch.update(doc(db, 'transactions', openingTx.id), { date: inst.valueDate, amount: inst.cost, updatedAt: serverTimestamp() });
  }
  await batch.commit();
}

export async function saveFundPrice(fundId, date, priceOrYield) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'fundPrices', `${fundId}_${date}`), { fundId, date, priceOrYield });
  await batch.commit();
}

// ---------- history import ----------

/**
 * Writes a history file's documents (see history.js) in batches of 400. Ids are fixed, so if a batch fails
 * the import can simply be run again. Calls onProgress(written, total) after each batch.
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

// ---------- settings ----------

/** Create (id null) or replace a settings document. */
export async function saveDoc(coll, id, data) {
  const batch = writeBatch(db);
  const ref = id ? doc(db, coll, id) : doc(collection(db, coll));
  batch.set(ref, clean(data));
  await batch.commit();
  return ref.id;
}
