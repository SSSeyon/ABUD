// Money market fund statements downloaded from the investment platform (Excel). Reads the daily rows (date,
// investment, liquidation or withdrawal, rate, earnings, balance), whatever order the columns come in, and plans
// what to save: one fundPrices row per day carrying the platform's balance (the fund is then valued at that
// balance), and a subscription or redemption entry for each movement not already recorded.
// No Firebase here, so it is testable.
import { dec, ZERO } from '../engine/index.js';

/** Column finders, tried on the header row (case-insensitive). The first match wins, except redemptions (all summed). */
const COLUMNS = {
  date: /^(value\s*)?date|transaction date|^day$/i,
  subscription: /invest(ment)?\s*amount|subscri|deposit|top.?up|contribution|amount invested|^invest/i,
  redemption: /liquidat|redeem|redemption|withdraw/i,
  rate: /rate|yield/i,
  income: /earning|income|interest|accru|return/i,
  balance: /balance|closing|portfolio value|^value$/i,
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/** A cell as an ISO date: a Date, an Excel serial number, ISO text, day/month/year text, or "14 Nov 2024" style. */
export function cellDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // SheetJS gives local-midnight Dates; add 12 hours so any time-zone offset stays on the same day.
    const t = new Date(v.getTime() + 12 * 3600e3);
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null; // not an Excel date serial (1954 to 2119)
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400e3);
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); // Nigerian statements are day first
  if (m) return iso(m[3].length === 2 ? `20${m[3]}` : m[3], Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})/);
  const month = (name) => MONTHS[name.slice(0, 3).toLowerCase()];
  if (m && month(m[2])) return iso(m[3], month(m[2]), Number(m[1]));
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && month(m[1])) return iso(m[3], month(m[1]), Number(m[2]));
  return null;
}

/** A cell as a Decimal amount, or null when blank or not a number. Handles ₦, commas, brackets for negatives. */
export function cellNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? dec(String(v)) : null;
  let s = String(v).replace(/[₦,\s]|NGN/gi, '');
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  if (s === '' || s === '-') return null;
  if (!/^-?\d+(\.\d+)?%?$/.test(s)) return null;
  const pct = s.endsWith('%');
  let d = dec(s.replace('%', ''));
  if (pct) d = d.div(100);
  return neg ? d.neg() : d;
}

/**
 * Finds the header row and the columns. Returns { headerRow, cols: {date, subscription, redemption: number[], rate,
 * income, balance}, headers } or throws when no date column or no balance/earnings column is found.
 */
export function detectColumns(aoa) {
  for (let r = 0; r < Math.min(aoa.length, 30); r++) {
    const row = (aoa[r] ?? []).map((c) => String(c ?? '').trim());
    const find = (re, taken) => row.findIndex((c, i) => c && re.test(c) && !taken.includes(i));
    const date = find(COLUMNS.date, []);
    if (date < 0) continue;
    const taken = [date];
    const balance = find(COLUMNS.balance, taken); if (balance >= 0) taken.push(balance);
    const income = find(COLUMNS.income, taken); if (income >= 0) taken.push(income);
    if (balance < 0 && income < 0) continue;
    const subscription = find(COLUMNS.subscription, taken); if (subscription >= 0) taken.push(subscription);
    const redemption = row.map((c, i) => (c && COLUMNS.redemption.test(c) && !taken.includes(i) ? i : -1)).filter((i) => i >= 0);
    taken.push(...redemption);
    const rate = find(COLUMNS.rate, taken);
    return { headerRow: r, headers: row, cols: { date, subscription, redemption, rate, income, balance } };
  }
  throw new Error('Could not find the statement table: the sheet needs a Date column and a Balance (or Earnings) column.');
}

/**
 * Daily rows from a sheet (array of arrays). Rates above 1 are read as percentages (23.15 → 0.2315).
 * Missing balances are carried forward: previous balance + investment − liquidation + earnings.
 * @returns {{rows: {date: string, subscription: any, redemption: any, rate: any|null, income: any, balance: any}[], cols: object, headers: string[]}}
 */
export function parseStatement(aoa) {
  const { headerRow, cols, headers } = detectColumns(aoa);
  const byDate = new Map();
  for (const raw of aoa.slice(headerRow + 1)) {
    const date = cellDate(raw?.[cols.date]);
    if (!date) continue;
    const num = (i) => (i >= 0 ? cellNumber(raw[i]) : null);
    const sub = num(cols.subscription) ?? ZERO;
    const red = cols.redemption.reduce((t, i) => t.plus((cellNumber(raw[i]) ?? ZERO).abs()), ZERO);
    let rate = num(cols.rate);
    if (rate && rate.gt(1)) rate = rate.div(100);
    const income = num(cols.income);
    const balance = num(cols.balance);
    if (sub.isZero() && red.isZero() && income === null && balance === null) continue;
    const prev = byDate.get(date);
    if (prev) {
      prev.subscription = prev.subscription.plus(sub.abs());
      prev.redemption = prev.redemption.plus(red);
      if (income !== null) prev.income = (prev.income ?? ZERO).plus(income);
      if (balance !== null) prev.balance = balance;
      if (rate) prev.rate = rate;
    } else byDate.set(date, { date, subscription: sub.abs(), redemption: red, rate: rate ?? null, income, balance });
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  let bal = null;
  for (const r of rows) {
    if (r.balance === null) r.balance = (bal ?? ZERO).plus(r.subscription).minus(r.redemption).plus(r.income ?? ZERO);
    if (r.income === null) r.income = bal === null ? ZERO : r.balance.minus(bal).minus(r.subscription).plus(r.redemption);
    // No rate column: the day's earnings over the opening balance, annualised.
    if (r.rate === null) r.rate = bal && bal.gt(0) ? r.income.div(bal).times(365) : ZERO;
    if (r.rate.isNegative()) r.rate = ZERO;
    bal = r.balance;
  }
  if (!rows.length) throw new Error('The statement has no dated rows.');
  return { rows, cols, headers };
}

const near = (a, b) => dec(a).minus(b).abs().lte(1);

/**
 * What an upload would save for a fund. Existing subscriptions and redemptions of the fund's deals in the statement
 * period are matched to the statement's movements by date and amount (within ₦1); the rest are new entries.
 * @param {object} data app data
 * @param {string} fundId
 * @param {ReturnType<typeof parseStatement>['rows']} rows
 * @param {string|null} [lockedUntil] end of the last closed quarter: rows up to it are left out (closed figures stay final)
 */
export function statementPlan(data, fundId, allRows, lockedUntil = null) {
  const fund = (data.funds ?? []).find((f) => f.id === fundId);
  if (!fund) throw new Error('Choose the fund this statement is for.');
  const rows = lockedUntil ? allRows.filter((r) => r.date > lockedUntil) : allRows;
  if (!rows.length) throw new Error(`Every row is dated in a closed quarter (up to ${lockedUntil}). Reopen the quarter first to change its figures.`);
  const first = rows[0].date;
  const lastDate = rows.at(-1).date;
  const fundInst = new Set((data.instruments ?? []).filter((i) => i.type === 'money_market_fund' && i.fundId === fundId).map((i) => i.id));
  const recorded = (data.transactions ?? []).filter((t) => fundInst.has(t.instrumentId) && ['fund_subscription', 'fund_redemption'].includes(t.type) && t.date >= first && t.date <= lastDate);
  const unused = new Set(recorded.map((t) => t.id));
  const movements = [];
  for (const r of rows) {
    for (const [type, amount] of [['fund_subscription', r.subscription], ['fund_redemption', r.redemption]]) {
      if (!amount || amount.isZero()) continue;
      const match = recorded.find((t) => unused.has(t.id) && t.type === type && t.date === r.date && near(t.amount, amount));
      if (match) unused.delete(match.id);
      movements.push({ type, date: r.date, amount: amount.toFixed(2), matched: match?.id ?? null });
    }
  }
  const accountId = `acct-${fundId}`;
  const hasAccount = (data.instruments ?? []).some((i) => i.id === accountId);
  const account = hasAccount ? null : {
    type: 'money_market_fund', fundId, pricingBasis: fund.pricingBasis ?? 'yield', counterpartyName: fund.managerName || fund.name,
    tradeDate: first, valueDate: first, cost: (rows[0].balance.gt(0) ? rows[0].balance : dec(1)).toFixed(2),
    notes: 'Fund account for uploaded platform statements; valued at the statement balance.',
  };
  const prices = rows.map((r) => ({
    id: `${fundId}_${r.date}`,
    data: {
      fundId, date: r.date, priceOrYield: r.rate.toDecimalPlaces(6).toFixed(), balance: r.balance.toFixed(2), income: r.income.toFixed(2),
      subscription: r.subscription.toFixed(2), redemption: r.redemption.toFixed(2), source: 'statement',
    },
  }));
  const sum = (k) => rows.reduce((t, r) => t.plus(r[k]), ZERO);
  return {
    fund, first, last: lastDate, rows: rows.length, skipped: allRows.length - rows.length, prices, account, accountId,
    newMovements: movements.filter((m) => !m.matched), matched: movements.filter((m) => m.matched).length,
    unmatchedRecorded: recorded.filter((t) => unused.has(t.id)),
    totals: { subscriptions: sum('subscription'), redemptions: sum('redemption'), income: sum('income'), closing: rows.at(-1).balance },
  };
}
