import { eachDay } from './dates.js';
import { DAYS_IN_YEAR, ZERO, dec } from './decimal.js';

/**
 * Worksheet benchmark ("WATBR return" in the MCM income sheet): a shadow account that receives the pool's
 * contributions and withdrawals and compounds daily at the benchmark yield plus the hurdle spread.
 * Each day: balance += that day's net contributions; interest = balance x (yield + spread) / 365; balance += interest.
 * A quarter's benchmark income is the interest earned on its days.
 *
 * @param {object} input
 * @param {string} input.start first day (the first contribution)
 * @param {string} input.end
 * @param {Map<string, import('./decimal.js').Dec>} input.contributions net inflows less withdrawals, by date
 * @param {(date: string) => (import('./decimal.js').Num | null)} input.yieldOn benchmark yield in force that day
 * @param {import('./decimal.js').Num} input.spread
 * @returns {{date: string, balance: import('./decimal.js').Dec, interest: import('./decimal.js').Dec}[]}
 */
export function shadowBenchmark(input) {
  const spread = dec(input.spread);
  let balance = ZERO;
  const out = [];
  for (const date of eachDay(input.start, input.end)) {
    balance = balance.plus(input.contributions.get(date) ?? ZERO);
    const y = input.yieldOn(date);
    const interest = y == null ? ZERO : balance.times(dec(y).plus(spread)).div(DAYS_IN_YEAR);
    balance = balance.plus(interest);
    out.push({ date, balance, interest });
  }
  return out;
}

/**
 * Worksheet incentive: rate x (the quarter's naira income - the shadow account's benchmark income), floored at zero.
 * @param {{income: any, benchmarkIncome: any, incentiveRate: any}} input
 */
export function worksheetIncentive(input) {
  const excess = dec(input.income).minus(input.benchmarkIncome);
  return { excess, fee: excess.gt(0) ? excess.times(input.incentiveRate) : ZERO };
}
