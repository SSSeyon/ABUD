import { eachDay } from './dates.js';
import { ZERO, dec } from './decimal.js';
import { FundPriceBook, Valuer } from './valuation.js';

/**
 * @typedef {object} DailyNavRow
 * @property {string} date
 * @property {import('./decimal.js').Dec} cash
 * @property {import('./decimal.js').Dec} holdingsValue
 * @property {import('./decimal.js').Dec} nav Gross of fees due to MBO: accrued fees are never deducted.
 * @property {import('./decimal.js').Dec} netFlow External flow F: inflows positive; withdrawals and fee debits negative.
 */

/** Sign of each transaction type's effect on cash. Rollover carries its own signed amount. */
const CASH_SIGN = {
  inflow: 1,
  withdrawal: -1,
  fee_debit: -1,
  invest: -1,
  mature: 1,
  interest: 1,
  fund_subscription: -1,
  fund_redemption: 1,
};

/** Flows that cross the portfolio boundary. Fee debits count as external so ARIP stays gross of fees. */
const EXTERNAL = new Set(['inflow', 'withdrawal', 'fee_debit']);

/** @param {import('./types.js').Transaction} t */
export function cashEffect(t) {
  const amount = dec(t.amount);
  if (t.type === 'rollover') return amount;
  const sign = CASH_SIGN[t.type];
  if (!sign) throw new Error(`Transaction ${t.id}: unknown type ${t.type}`);
  if (amount.lte(0)) throw new Error(`Transaction ${t.id}: amount must be positive for type ${t.type}`);
  return amount.times(sign);
}

/** @param {import('./types.js').Transaction} t */
export function externalFlow(t) {
  return EXTERNAL.has(t.type) ? cashEffect(t) : ZERO;
}

/**
 * Daily NAV for every calendar day from start to end. Only approved transactions count.
 * Transactions dated before start roll into the opening cash.
 *
 * @param {object} input
 * @param {string} input.start
 * @param {string} input.end
 * @param {import('./types.js').Transaction[]} input.transactions
 * @param {import('./types.js').Instrument[]} input.instruments
 * @param {import('./types.js').FundPrice[]} [input.fundPrices]
 * @param {import('./decimal.js').Num} [input.openingCash] cash before any listed transaction (default 0)
 * @returns {DailyNavRow[]}
 */
export function buildDailyNav(input) {
  if (input.end < input.start) throw new Error('end must not be before start');
  const approved = input.transactions.filter((t) => t.approved);

  const cashByDay = new Map();
  const flowByDay = new Map();
  let cash = dec(input.openingCash ?? 0);
  for (const t of approved) {
    const effect = cashEffect(t);
    if (t.date < input.start) {
      cash = cash.plus(effect);
      continue;
    }
    cashByDay.set(t.date, (cashByDay.get(t.date) ?? ZERO).plus(effect));
    flowByDay.set(t.date, (flowByDay.get(t.date) ?? ZERO).plus(externalFlow(t)));
  }

  const valuer = new Valuer(new FundPriceBook(input.fundPrices ?? []));
  const rows = [];
  for (const date of eachDay(input.start, input.end)) {
    cash = cash.plus(cashByDay.get(date) ?? ZERO);
    let holdingsValue = ZERO;
    for (const inst of input.instruments) holdingsValue = holdingsValue.plus(valuer.valueOn(inst, date));
    rows.push({ date, cash, holdingsValue, nav: cash.plus(holdingsValue), netFlow: flowByDay.get(date) ?? ZERO });
  }
  return rows;
}
