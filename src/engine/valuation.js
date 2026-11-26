import { addDays, daysBetween } from './dates.js';
import { DAYS_IN_YEAR, ZERO, dec } from './decimal.js';

/** Last day (exclusive) the instrument is held, or undefined for an open-ended fund holding. */
export function holdingEnd(inst) {
  if (inst.closeDate) return inst.closeDate;
  return inst.type === 'money_market_fund' ? undefined : inst.maturityDate;
}

/** Held on day t when valueDate <= t < end. On the end day the cash comes back through a transaction. */
export function isHeld(inst, date) {
  const end = holdingEnd(inst);
  return date >= inst.valueDate && (end === undefined || date < end);
}

/** Sorted price/yield history per fund, with lookup of the latest value on or before a date. */
export class FundPriceBook {
  /** @param {Iterable<import('./types.js').FundPrice>} [prices] */
  constructor(prices = []) {
    /** @type {Map<string, {date: string, value: import('./decimal.js').Dec}[]>} */
    this.byFund = new Map();
    for (const p of prices) {
      const list = this.byFund.get(p.fundId) ?? [];
      list.push({ date: p.date, value: dec(p.priceOrYield) });
      this.byFund.set(p.fundId, list);
    }
    for (const list of this.byFund.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** Latest value on or before the date; throws when none is stored. */
  latest(fundId, date) {
    let found;
    for (const p of this.byFund.get(fundId) ?? []) {
      if (p.date > date) break;
      found = p.value;
    }
    if (!found) throw new Error(`No price or yield for fund ${fundId} on or before ${date}`);
    return found;
  }
}

/**
 * Fund account statements uploaded from the investment platform: the closing balance per day.
 * From a fund's first statement day on, the fund is valued at the statement balance instead of holding by holding
 * (the statement already reflects every subscription, partial redemption and the platform's own earnings).
 * After its last row the balance accrues simply at the last rate (Actual/365) until the next upload.
 */
export class FundStatementBook {
  /** @param {Iterable<{fundId: string, date: string, balance: import('./decimal.js').Num, rate?: import('./decimal.js').Num}>} [rows] */
  constructor(rows = []) {
    /** @type {Map<string, {date: string, balance: import('./decimal.js').Dec, rate: import('./decimal.js').Dec}[]>} */
    this.byFund = new Map();
    for (const r of rows) {
      if (r.balance == null || r.balance === '') continue;
      const list = this.byFund.get(r.fundId) ?? [];
      list.push({ date: r.date, balance: dec(r.balance), rate: r.rate == null || r.rate === '' ? ZERO : dec(r.rate) });
      this.byFund.set(r.fundId, list);
    }
    for (const list of this.byFund.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  get funds() { return [...this.byFund.keys()]; }

  /** First statement day of a fund, or null. */
  start(fundId) { return this.byFund.get(fundId)?.[0]?.date ?? null; }

  /** Whether the statement values this fund on the date. */
  covers(fundId, date) {
    const s = this.start(fundId);
    return s !== null && date >= s;
  }

  /** Balance at the end of the date (ZERO before the first statement day). */
  value(fundId, date) {
    let last = null;
    for (const r of this.byFund.get(fundId) ?? []) {
      if (r.date > date) break;
      last = r;
    }
    if (!last) return ZERO;
    if (last.date === date || last.rate.isZero()) return last.balance;
    return last.balance.plus(last.balance.times(last.rate).times(daysBetween(last.date, date)).div(DAYS_IN_YEAR));
  }
}

/**
 * Values each holding at end of day. Elapsed days count from the value date,
 * so a holding is worth its cost at the end of its value date.
 */
export class Valuer {
  /** @param {FundPriceBook} [prices] @param {FundStatementBook} [statements] */
  constructor(prices = new FundPriceBook(), statements = new FundStatementBook()) {
    this.prices = prices;
    this.statements = statements;
    /** Yield-basis funds: cumulative accrual per holding. */
    this.yieldAccrual = new Map();
  }

  /** Total of every statement-valued fund on the date. */
  statementTotal(date) {
    let t = ZERO;
    for (const f of this.statements.funds) t = t.plus(this.statements.value(f, date));
    return t;
  }

  /** @param {import('./types.js').Instrument} inst @param {string} date */
  valueOn(inst, date) {
    // A fund on a statement is valued as one account (statementTotal), not holding by holding.
    if (inst.type === 'money_market_fund' && this.statements.covers(inst.fundId, date)) return ZERO;
    if (!isHeld(inst, date)) return ZERO;
    const elapsed = daysBetween(inst.valueDate, date);

    switch (inst.type) {
      case 'ntb':
      case 'omo':
      case 'commercial_paper': {
        // Amortised cost: straight-line accretion of the discount to maturity.
        const total = daysBetween(inst.valueDate, inst.maturityDate);
        if (total <= 0) throw new Error(`Instrument ${inst.id}: maturity must be after value date`);
        const cost = dec(inst.cost);
        return cost.plus(dec(inst.faceValue).minus(cost).times(elapsed).div(total));
      }
      case 'fixed_deposit': {
        const principal = dec(inst.principal);
        return principal.plus(principal.times(inst.rate).times(elapsed).div(DAYS_IN_YEAR));
      }
      case 'money_market_fund':
        return this.fundValue(inst, date);
      default:
        throw new Error(`Instrument ${inst.id}: unknown type ${inst.type}`);
    }
  }

  fundValue(inst, date) {
    if (inst.pricingBasis === 'price') {
      if (inst.units === undefined) throw new Error(`Fund holding ${inst.id}: units are required for price basis`);
      return dec(inst.units).times(this.prices.latest(inst.fundId, date));
    }
    // Yield basis: cost plus simple daily accrual at the yield in force each day (Actual/365).
    const cost = dec(inst.cost);
    let state = this.yieldAccrual.get(inst.id);
    if (!state || state.date > date) state = { date: inst.valueDate, accrued: ZERO };
    let { date: d, accrued } = state;
    while (d < date) {
      d = addDays(d, 1);
      accrued = accrued.plus(cost.times(this.prices.latest(inst.fundId, d)).div(DAYS_IN_YEAR));
    }
    this.yieldAccrual.set(inst.id, { date: d, accrued });
    return cost.plus(accrued);
  }
}
