// Backup file format shared by Settings > Backup (download / restore) and the nightly job (tools/backup).
// { app: 'ABUD Portfolio', takenAt: ISO, collections: { name: [{ id, ...fields }] } }. Timestamps become ISO strings.

/** Collections a restore writes back. The change history is append-only, so it is kept in the file but not restored. */
export const RESTORABLE = ['transactions', 'instruments', 'mandateTerms', 'funds', 'fundPrices', 'settings', 'quarterlyResults', 'auctions', 'mpc', 'cpQuotes', 'feedStatus', 'invoices', 'counterparties', 'ratings', 'limitSets', 'news', 'auctionCalendar'];

function plain(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** The loaded data as a backup file. */
export function backupFile(data, takenAt = new Date().toISOString()) {
  const collections = {};
  for (const [name, list] of Object.entries(data)) if (Array.isArray(list)) collections[name] = list.map(plain);
  return { app: 'ABUD Portfolio', takenAt, collections };
}

/** Documents to write for a restore: [{coll, id, data}], skipping the change history and malformed entries. */
export function restoreDocs(file) {
  if (!file || typeof file.collections !== 'object') throw new Error('Not an ABUD backup file (no collections).');
  const out = [];
  for (const name of RESTORABLE) {
    for (const d of file.collections[name] ?? []) {
      if (!d || typeof d.id !== 'string' || !d.id) continue;
      const { id, ...rest } = d;
      out.push({ coll: name, id, data: rest });
    }
  }
  return out;
}
