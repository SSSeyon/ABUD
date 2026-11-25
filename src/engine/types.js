// Shapes the engine works with. Rates are fractions (0.0075 = 0.75%); amounts are Num (see decimal.js).

/** Clause 2: fixed income and money market only. */
export const ALLOWED_INSTRUMENT_TYPES = Object.freeze([
  'ntb',
  'omo',
  'commercial_paper',
  'fixed_deposit',
  'money_market_fund',
]);

/** @param {string} type */
export function assertAllowedType(type) {
  if (!ALLOWED_INSTRUMENT_TYPES.includes(type)) {
    throw new Error(`Instrument type "${type}" is not allowed by the mandate (Clause 2)`);
  }
}

/**
 * Every instrument has: id, type, valueDate (first day held) and optional closeDate
 * (early liquidation/redemption). A position is held on days valueDate <= t < (closeDate ?? maturityDate).
 *
 * @typedef {object} DiscountInstrument NTB, OMO bill or CP bought at a discount; valued at amortised cost.
 * @property {string} id
 * @property {'ntb'|'omo'|'commercial_paper'} type
 * @property {import('./decimal.js').Num} faceValue
 * @property {import('./decimal.js').Num} cost
 * @property {string} valueDate
 * @property {string} maturityDate
 * @property {string} [closeDate]
 *
 * @typedef {object} FixedDeposit Principal plus simple interest at the contract rate, Actual/365.
 * @property {string} id
 * @property {'fixed_deposit'} type
 * @property {import('./decimal.js').Num} principal
 * @property {import('./decimal.js').Num} rate
 * @property {string} valueDate
 * @property {string} maturityDate
 * @property {string} [closeDate]
 *
 * @typedef {object} FundHolding Money market fund: units x price, or cost plus accrued yield.
 * @property {string} id
 * @property {'money_market_fund'} type
 * @property {string} fundId
 * @property {'price'|'yield'} pricingBasis
 * @property {import('./decimal.js').Num} cost
 * @property {import('./decimal.js').Num} [units] required for price basis
 * @property {string} valueDate
 * @property {string} [closeDate]
 *
 * @typedef {DiscountInstrument|FixedDeposit|FundHolding} Instrument
 *
 * @typedef {object} FundPrice A published price ('price' basis) or annual yield as a fraction ('yield' basis).
 * @property {string} fundId
 * @property {string} date
 * @property {import('./decimal.js').Num} priceOrYield
 *
 * @typedef {'inflow'|'withdrawal'|'fee_debit'|'invest'|'mature'|'rollover'|'interest'|'fund_subscription'|'fund_redemption'} TransactionType
 *
 * @typedef {object} Transaction
 * @property {string} id
 * @property {string} date
 * @property {TransactionType} type
 * @property {import('./decimal.js').Num} amount Positive magnitude; 'rollover' carries the signed net cash amount
 *   (positive = cash released to the account).
 * @property {string} [instrumentId]
 * @property {boolean} approved Unapproved entries are excluded from NAV (maker-checker).
 *
 * @typedef {object} MandateTerms
 * @property {import('./decimal.js').Num} mgmtFeeRate 0.0075 = 0.75% p.a.
 * @property {import('./decimal.js').Num} incentiveRate 0.10 = 10% of outperformance
 * @property {import('./decimal.js').Num} hurdleSpread 0.02 added to the 91-day true yield
 */

export {};
