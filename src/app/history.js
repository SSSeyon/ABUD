// Turns a history file (data/history-*.json, built by tools/history/build-history.ps1) into Firestore documents.
// No Firebase imports here, so tests can check exactly what an import writes.

export const HISTORY_FILE = 'data/history-2026-09-30.json';

/** Imported documents have fixed ids starting with this, so a rerun overwrites instead of duplicating. */
export const HISTORY_PREFIX = 'hist-';

const drop = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * Every document an import writes: funds, then fund yields, then instruments, then transactions.
 * @returns {{ coll: string, id: string, data: object }[]}
 */
export function historyDocs(file) {
  const fundId = (key) => `${HISTORY_PREFIX}fund-${key}`;
  const instId = (key) => `${HISTORY_PREFIX}${key}`;
  const docs = [];

  for (const f of file.funds) {
    docs.push({ coll: 'funds', id: fundId(f.key), data: drop({ name: f.name, managerName: f.managerName, pricingBasis: f.pricingBasis, isMboManaged: Boolean(f.isMboManaged) }) });
  }
  for (const p of file.fundPrices) {
    const id = fundId(p.fundKey);
    docs.push({ coll: 'fundPrices', id: `${id}_${p.date}`, data: { fundId: id, date: p.date, priceOrYield: p.priceOrYield } });
  }
  for (const i of file.instruments) {
    const { key, fundKey, ...rest } = i;
    docs.push({ coll: 'instruments', id: instId(key), data: drop({ ...rest, fundId: fundKey ? fundId(fundKey) : undefined }) });
  }
  file.transactions.forEach((t, n) => {
    const { instrumentKey, ...rest } = t;
    docs.push({
      coll: 'transactions',
      id: `${HISTORY_PREFIX}tx-${String(n + 1).padStart(4, '0')}`,
      data: drop({ type: rest.type, date: rest.date, amount: rest.amount, instrumentId: instrumentKey ? instId(instrumentKey) : undefined, reference: rest.reference, notes: rest.notes }),
    });
  });
  return docs;
}

/** The app's data shape (docs with ids) for a history file, as the screens would see it after import. */
export function historyData(file) {
  const data = { transactions: [], instruments: [], funds: [], fundPrices: [] };
  for (const d of historyDocs(file)) data[d.coll].push({ id: d.id, ...d.data });
  return data;
}

/**
 * Whether the Import button applies: nothing but earlier history-import documents in the deal and transaction
 * collections, and fewer transactions than the file has (empty database, or an import that stopped part way).
 */
export function importStatus(data, file) {
  const own = (list = []) => list.filter((d) => !d.id.startsWith(HISTORY_PREFIX));
  const other = own(data.transactions).length + own(data.instruments).length;
  const loaded = (data.transactions ?? []).length - own(data.transactions).length;
  if (other > 0) return { canImport: false, reason: 'The database already has transactions or deals entered in the app.' };
  if (loaded >= file.transactions.length) return { canImport: false, reason: 'This history is already imported.' };
  return { canImport: true, resuming: loaded > 0 };
}
