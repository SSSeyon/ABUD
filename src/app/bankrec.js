// Bank statement reconciliation. Reads the bank statement (Excel or CSV from the bank's portal), matches each line
// to a recorded cash movement (same direction, amount within ₦1, date within a few days), pairs same-day
// maturity and reinvestment entries that the bank netted, and compares the bank's balance with the app's cash
// day by day. No Firebase here, so it is testable.
import { daysBetween, dec, ZERO } from '../engine/index.js';
import { cellDate, cellNumber } from './fundstatement.js';
import { navSeries, TX_SIGN } from './portfolio.js';

/** Header finders (case-insensitive). Value date wins over transaction date when both are there. */
const COLUMNS = {
  valueDate: /value\s*date/i,
  date: /^(trans(action)?\.?\s*|posting\s*|book(ing)?\s*|txn\s*)?date$|^date\b|trans(action)?\.?\s*date|posting date/i,
  description: /narration|description|details|remark|particular|memo|^transaction$/i,
  debit: /debit|withdrawal|^dr\.?$|money out|paid out|outflow/i,
  credit: /credit|deposit|lodg|^cr\.?$|money in|paid in|inflow/i,
  amount: /^amount|^(transaction\s*)?amount\s*\(?(ngn|₦)?\)?$/i,
  balance: /balance/i,
  reference: /^ref|reference|cheque|chq|doc(ument)?\s*no/i,
};

/**
 * Finds the header row and columns. Needs a date column and either debit and credit columns or one signed amount.
 * @returns {{headerRow: number, headers: string[], cols: Record<string, number>}}
 */
export function detectBankColumns(aoa) {
  for (let r = 0; r < Math.min(aoa.length, 40); r++) {
    const row = (aoa[r] ?? []).map((c) => String(c ?? '').trim());
    const taken = [];
    const find = (re) => { const i = row.findIndex((c, j) => c && re.test(c) && !taken.includes(j)); if (i >= 0) taken.push(i); return i; };
    const valueDate = find(COLUMNS.valueDate);
    const date = find(COLUMNS.date);
    if (valueDate < 0 && date < 0) continue;
    const balance = find(COLUMNS.balance);
    const debit = find(COLUMNS.debit);
    const credit = find(COLUMNS.credit);
    const amount = debit >= 0 && credit >= 0 ? -1 : find(COLUMNS.amount);
    if (!(debit >= 0 && credit >= 0) && amount < 0) continue;
    const description = find(COLUMNS.description);
    const reference = find(COLUMNS.reference);
    return { headerRow: r, headers: row, cols: { valueDate, date, description, debit, credit, amount, balance, reference } };
  }
  throw new Error('No statement table found: the sheet needs a Date (or Value Date) column and Debit and Credit columns, or one Amount column.');
}

/**
 * Statement lines in file order: { line, date, description, reference, amount (signed: credit +, debit −), balance }.
 * Rows without a date or amount (headers, opening/closing summary lines) are skipped; an opening balance line is
 * kept as `opening` when it has a balance.
 */
export function parseBankStatement(aoa) {
  const { headerRow, headers, cols } = detectBankColumns(aoa);
  const rows = [];
  let opening = null;
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const date = cellDate(cols.valueDate >= 0 ? row[cols.valueDate] : null) ?? cellDate(cols.date >= 0 ? row[cols.date] : null);
    const description = cols.description >= 0 ? String(row[cols.description] ?? '').trim() : '';
    const balance = cols.balance >= 0 ? cellNumber(row[cols.balance]) : null;
    let amount = null;
    if (cols.debit >= 0) {
      const dr = cellNumber(row[cols.debit]);
      const cr = cellNumber(row[cols.credit]);
      if ((dr && !dr.isZero()) || (cr && !cr.isZero())) amount = (cr ?? ZERO).abs().minus((dr ?? ZERO).abs());
    } else {
      amount = cellNumber(row[cols.amount]);
    }
    if (!date || !amount || amount.isZero()) {
      if (!rows.length && balance && /open|brought|b\/f|balance/i.test(`${description} ${row.join(' ')}`)) opening = balance;
      continue;
    }
    rows.push({ line: r + 1, date, description, reference: cols.reference >= 0 ? String(row[cols.reference] ?? '').trim() : '', amount, balance });
  }
  if (!rows.length) throw new Error('The statement table has no dated lines with an amount.');
  // Statements are often newest first: put them in date order, keeping same-day lines in file order.
  if (rows.length > 1 && rows[0].date > rows.at(-1).date) rows.reverse();
  return { headers, cols, rows, opening };
}

/** Recorded entries that move the bank account, signed as cash (in +, out −); a rollover carries its own signed amount. */
export function cashMovements(data) {
  return (data.transactions ?? [])
    .filter((t) => (TX_SIGN[t.type] != null || t.type === 'rollover') && t.amount != null)
    .map((t) => ({ tx: t, date: t.date, amount: t.type === 'rollover' ? dec(t.amount) : dec(t.amount).times(TX_SIGN[t.type]) }))
    .filter((m) => !m.amount.isZero());
}

/**
 * Reconciles statement lines against the recorded entries.
 * @param {object} data app data
 * @param {Array} lines parsed statement rows (date order)
 * @param {{days?: number, tolerance?: string, opening?: import('decimal.js').Decimal|null}} opts
 */
export function reconcile(data, lines, { days = 3, tolerance = '1', opening = null } = {}) {
  const tol = dec(tolerance);
  const start = lines[0].date;
  const end = lines.at(-1).date;
  const moves = cashMovements(data).filter((m) => m.date >= start && m.date <= end);
  const used = new Set();
  const matchedLine = new Map();
  // Pass 0: same day; then widen to the allowed gap. Closest date wins within a pass.
  for (let gap = 0; gap <= days; gap++) {
    for (const [li, l] of lines.entries()) {
      if (matchedLine.has(li)) continue;
      const cand = moves.filter((m) => !used.has(m) && m.amount.minus(l.amount).abs().lte(tol) && Math.abs(daysBetween(l.date, m.date)) === gap);
      if (cand.length) { used.add(cand[0]); matchedLine.set(li, cand[0]); }
    }
  }
  // Same-day maturity + reinvestment the bank netted: an unmatched pair or group whose sum equals a bank line, or zero.
  const left = moves.filter((m) => !used.has(m));
  const netted = [];
  const byDay = new Map();
  for (const m of left) byDay.set(m.date, [...(byDay.get(m.date) ?? []), m]);
  for (const [date, group] of byDay) {
    const ins = group.filter((m) => m.amount.gt(0));
    const outs = group.filter((m) => m.amount.lt(0));
    for (const o of outs) {
      for (const i of ins) {
        if (used.has(i) || used.has(o)) continue;
        const net = i.amount.plus(o.amount);
        if (net.abs().lte(tol)) { used.add(i); used.add(o); netted.push({ date, entries: [i, o], net, line: null }); continue; }
        const li = lines.findIndex((l, k) => !matchedLine.has(k) && l.date === date && l.amount.minus(net).abs().lte(tol));
        if (li >= 0) { used.add(i); used.add(o); matchedLine.set(li, null); netted.push({ date, entries: [i, o], net, line: lines[li] }); }
      }
    }
  }
  const matched = [...matchedLine.entries()].filter(([, m]) => m).map(([li, m]) => ({ line: lines[li], entry: m, dayGap: daysBetween(lines[li].date, m.date) }));
  const bankOnly = lines.filter((_, li) => !matchedLine.has(li));
  const appOnly = moves.filter((m) => !used.has(m));

  // Balances: the bank's end-of-day balance against the app's cash, each day the statement has a line.
  const cashByDate = new Map();
  try { for (const r of navSeries(data, end)) cashByDate.set(r.date, r.cash); } catch { /* no NAV yet */ }
  const eod = new Map();
  for (const l of lines) if (l.balance) eod.set(l.date, l.balance);
  const daily = [...eod.entries()].map(([date, bank]) => {
    const app = cashByDate.get(date) ?? null;
    return { date, bank, app, diff: app == null ? null : bank.minus(app) };
  });
  // Only days where the difference changes, so the list points at the day something went wrong.
  const changes = daily.filter((d, i) => d.diff != null && (i === 0 || daily[i - 1].diff == null || !d.diff.minus(daily[i - 1].diff).abs().lte(tol)));
  const first = lines[0];
  const openingBank = opening ?? (first.balance ? first.balance.minus(first.amount) : null);
  const prev = [...cashByDate.keys()].filter((d) => d < start).pop();
  const openingApp = prev ? cashByDate.get(prev) : ZERO;
  const closing = daily.at(-1) ?? null;
  const total = (arr, f) => arr.reduce((t, x) => t.plus(f(x)), ZERO);
  return {
    start, end, lines: lines.length, matched, netted, bankOnly, appOnly, daily, changes,
    opening: { bank: openingBank, app: openingApp, diff: openingBank == null ? null : openingBank.minus(openingApp) },
    closing: closing ? { bank: closing.bank, app: closing.app, diff: closing.diff } : null,
    totals: { bankIn: total(lines.filter((l) => l.amount.gt(0)), (l) => l.amount), bankOut: total(lines.filter((l) => l.amount.lt(0)), (l) => l.amount.neg()),
      bankOnly: total(bankOnly, (l) => l.amount), appOnly: total(appOnly, (m) => m.amount) },
  };
}

/** A guess at the entry type for a bank line not in the app (the form lets you change it). */
export function suggestType(line) {
  const d = `${line.description} ${line.reference}`.toLowerCase();
  if (line.amount.gt(0)) {
    if (/interest|int\.? (paid|credit)|coupon/.test(d)) return 'interest';
    if (/matur|liquidat|redemp|redeem|terminat/.test(d)) return 'mature';
    return 'inflow';
  }
  if (/charge|fee|commission|vat|stamp duty|levy|sms|cot\b|maintenance/.test(d)) return 'fee_debit';
  return 'withdrawal';
}
