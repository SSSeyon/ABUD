// The worked example from the build plan (Calculation engine, section 6) is the first test case.
import { describe, expect, it } from '../harness.js';
import {
  BusinessCalendar,
  eachDay,
  incentiveFee,
  managementFeeForPeriod,
  periodRates,
  dec,
  toKobo,
} from '../../src/engine/index.js';

const NAV = dec('10000000000'); // N10bn average daily NAV
const DAYS = 92;
const TRUE_YIELD = '0.18';
const ARIP = '0.06';
const TERMS = { mgmtFeeRate: '0.0075', incentiveRate: '0.10', hurdleSpread: '0.02' };

// 92-day quarter: 1 Jul to 30 Sep 2026, constant NAV.
const rows = eachDay('2026-07-01', '2026-09-30').map((date) => ({ date, nav: NAV }));

describe('worked example', () => {
  it('has 92 days', () => {
    expect(rows).toHaveLength(DAYS);
  });

  it('management fee: 0.75% x N10bn x 92/365', () => {
    const fee = managementFeeForPeriod(rows, '2026-07-01', '2026-09-30', TERMS.mgmtFeeRate, new BusinessCalendar());
    expect(fee.posted.toFixed(2)).toBe('18904109.59');
    // The plan shows the figure rounded to the naira.
    expect(fee.total.toDecimalPlaces(0).toFixed(0)).toBe('18904110');
  });

  describe('as printed in the plan (rates rounded to 3 dp of a percent)', () => {
    const { watbr, hurdle } = periodRates(TRUE_YIELD, TERMS.hurdleSpread, DAYS, 5);

    it('WATBR 4.537% and hurdle 5.041%', () => {
      expect(watbr.toFixed(5)).toBe('0.04537');
      expect(hurdle.toFixed(5)).toBe('0.05041');
    });

    // The plan prints N9,589,000 for Clause 12, but 10% x (6.000% - 5.041%) x N10bn = N9,590,000.
    // (N9,589,000 would need the hurdle at 5.0411%.) This test holds the arithmetic, not the typo.
    it('incentive: Clause 8 N14,630,000; Clause 12 N9,590,000', () => {
      const r = incentiveFee({ arip: ARIP, watbr, hurdle, avgNav: NAV, incentiveRate: TERMS.incentiveRate });
      expect(r.hurdleMet).toBe(true);
      expect(toKobo(r.clause8).toFixed(2)).toBe('14630000.00');
      expect(toKobo(r.clause12).toFixed(2)).toBe('9590000.00');
    });
  });

  describe('at full precision (the proposed default rounding rule)', () => {
    const { watbr, hurdle } = periodRates(TRUE_YIELD, TERMS.hurdleSpread, DAYS);

    it('incentive: Clause 8 N14,630,136.99; Clause 12 N9,589,041.10', () => {
      const r = incentiveFee({ arip: ARIP, watbr, hurdle, avgNav: NAV, incentiveRate: TERMS.incentiveRate });
      expect(r.hurdleMet).toBe(true);
      expect(toKobo(r.clause8).toFixed(2)).toBe('14630136.99');
      expect(toKobo(r.clause12).toFixed(2)).toBe('9589041.10');
    });

    it('Clause 8 earns about N5.0m more than Clause 12', () => {
      const r = incentiveFee({ arip: ARIP, watbr, hurdle, avgNav: NAV, incentiveRate: TERMS.incentiveRate });
      expect(toKobo(r.clause8.minus(r.clause12)).toFixed(2)).toBe('5041095.89');
    });
  });
});
