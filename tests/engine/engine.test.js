import { describe, expect, it } from '../harness.js';
import {
  BusinessCalendar,
  ZERO,
  addMonths,
  assertAllowedType,
  buildDailyNav,
  closePeriod,
  dailyReturns,
  daysBetween,
  dec,
  incentiveFee,
  managementFeeAccruals,
  monthsSince,
  parseQuarterLabel,
  quarterOf,
  terminationFee,
  timeWeightedReturn,
  trueYieldFromDiscount,
  Valuer,
  FundPriceBook,
} from '../../src/engine/index.js';

describe('dates', () => {
  it('quarters', () => {
    expect(quarterOf('2026-08-15')).toMatchObject({ label: '2026Q3', start: '2026-07-01', end: '2026-09-30', days: 92 });
    expect(parseQuarterLabel('2024Q1').days).toBe(91); // leap year
    expect(parseQuarterLabel('2025Q1').days).toBe(90);
  });

  it('addMonths clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('rejects impossible dates', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow();
  });

  it('business calendar', () => {
    const cal = new BusinessCalendar(['2026-10-01']); // Independence Day
    expect(cal.isBusinessDay('2026-09-30')).toBe(true);
    expect(cal.isBusinessDay('2026-10-01')).toBe(false);
    expect(cal.isBusinessDay('2026-10-03')).toBe(false); // Saturday
  });
});

describe('mandate whitelist (Clause 2)', () => {
  it('rejects equities', () => {
    expect(() => assertAllowedType('equity')).toThrow(/not allowed/);
    expect(() => assertAllowedType('ntb')).notToThrow();
  });
});

describe('benchmark', () => {
  it('converts a stop rate to a true yield', () => {
    // 17.5% discount: 0.175 / (1 - 0.175 x 91/365)
    expect(trueYieldFromDiscount('0.175').toFixed(6)).toBe('0.182984');
  });
});

describe('valuation', () => {
  const valuer = new Valuer();

  it('amortises a bill straight-line to face value', () => {
    const bill = {
      id: 'ntb1', type: 'ntb', faceValue: 1_000_000, cost: 955_000,
      valueDate: '2026-01-01', maturityDate: '2026-04-02', // 91 days
    };
    expect(valuer.valueOn(bill, '2025-12-31').toFixed(2)).toBe('0.00');
    expect(valuer.valueOn(bill, '2026-01-01').toFixed(2)).toBe('955000.00');
    expect(valuer.valueOn(bill, '2026-04-01').toFixed(2)).toBe(dec(955_000).plus(dec(45_000).times(90).div(91)).toFixed(2));
    expect(valuer.valueOn(bill, '2026-04-02').toFixed(2)).toBe('0.00'); // matured: cash comes back via the mature transaction
  });

  it('accrues fixed deposit interest Actual/365', () => {
    const fd = {
      id: 'fd1', type: 'fixed_deposit', principal: 1_000_000_000, rate: '0.219',
      valueDate: '2026-01-01', maturityDate: '2026-03-02',
    };
    // 30 days at 21.9% on N1bn = N18,000,000
    expect(valuer.valueOn(fd, '2026-01-31').toFixed(2)).toBe('1018000000.00');
  });

  it('values a price-basis fund at units x latest price', () => {
    const v = new Valuer(new FundPriceBook([
      { fundId: 'mmf', date: '2026-01-01', priceOrYield: '100' },
      { fundId: 'mmf', date: '2026-01-05', priceOrYield: '100.5' },
    ]));
    const h = { id: 'h1', type: 'money_market_fund', fundId: 'mmf', pricingBasis: 'price', cost: 1_000_000, units: 10_000, valueDate: '2026-01-01' };
    expect(v.valueOn(h, '2026-01-04').toFixed(2)).toBe('1000000.00');
    expect(v.valueOn(h, '2026-01-06').toFixed(2)).toBe('1005000.00');
  });

  it('accrues a yield-basis fund daily at the yield in force', () => {
    const v = new Valuer(new FundPriceBook([
      { fundId: 'mmf', date: '2026-01-01', priceOrYield: '0.1825' },
      { fundId: 'mmf', date: '2026-01-03', priceOrYield: '0.365' },
    ]));
    const h = { id: 'h2', type: 'money_market_fund', fundId: 'mmf', pricingBasis: 'yield', cost: 3_650_000, valueDate: '2026-01-01' };
    // Day 2 at 18.25%: 1,825. Day 3 at 36.5%: 3,650.
    expect(v.valueOn(h, '2026-01-02').toFixed(2)).toBe('3651825.00');
    expect(v.valueOn(h, '2026-01-03').toFixed(2)).toBe('3655475.00');
  });
});

describe('daily NAV', () => {
  const instruments = [
    { id: 'ntb1', type: 'ntb', faceValue: 1_000_000, cost: 950_000, valueDate: '2026-01-02', maturityDate: '2026-01-12' },
  ];
  const transactions = [
    { id: 't1', date: '2026-01-01', type: 'inflow', amount: 1_000_000, approved: true },
    { id: 't2', date: '2026-01-02', type: 'invest', amount: 950_000, instrumentId: 'ntb1', approved: true },
    { id: 't3', date: '2026-01-12', type: 'mature', amount: 1_000_000, instrumentId: 'ntb1', approved: true },
    { id: 't4', date: '2026-01-05', type: 'withdrawal', amount: 10_000, approved: false }, // unapproved: ignored
  ];
  const rows = buildDailyNav({ start: '2026-01-01', end: '2026-01-12', transactions, instruments });

  it('is cash plus holdings, gross of fees, and excludes unapproved entries', () => {
    expect(rows[0].nav.toFixed(2)).toBe('1000000.00');
    expect(rows[0].netFlow.toFixed(2)).toBe('1000000.00');
    expect(rows[1].cash.toFixed(2)).toBe('50000.00');
    expect(rows[1].nav.toFixed(2)).toBe('1000000.00');
    expect(rows[6].nav.toFixed(2)).toBe('1025000.00'); // 7 Jan: 5 of 10 days accreted
    expect(rows[11].nav.toFixed(2)).toBe('1050000.00'); // matured into cash
    expect(rows[11].holdingsValue.isZero()).toBe(true);
  });

  it('rolls transactions before the start into opening cash', () => {
    const later = buildDailyNav({ start: '2026-01-05', end: '2026-01-05', transactions, instruments, openingCash: 5 });
    expect(later[0].cash.toFixed(2)).toBe('50005.00');
  });
});

describe('returns', () => {
  it('neutralises flows: inflow at end of day does not count as return', () => {
    const rows = [
      { date: '2026-01-01', nav: dec(151), netFlow: dec(50) },
      { date: '2026-01-02', nav: dec('152.51'), netFlow: ZERO },
    ];
    const r = dailyReturns(rows, 100);
    expect(r[0].r.toFixed(4)).toBe('0.0100');
    expect(r[1].r.toFixed(4)).toBe('0.0100');
    expect(timeWeightedReturn(rows, 100).toFixed(4)).toBe('0.0201');
  });

  it('fee debits are external, so ARIP stays gross of fees', () => {
    const rows = [{ date: '2026-03-31', nav: dec(99), netFlow: dec(-1) }];
    expect(timeWeightedReturn(rows, 100).isZero()).toBe(true);
  });

  it('inception day with zero opening NAV returns 0', () => {
    const rows = [{ date: '2026-01-01', nav: dec(100), netFlow: dec(100) }];
    expect(timeWeightedReturn(rows, 0).isZero()).toBe(true);
  });
});

describe('management fee', () => {
  it('uses the prior business day NAV on weekends and holidays', () => {
    const rows = [
      { date: '2026-01-02', nav: dec(365_000) }, // Friday
      { date: '2026-01-03', nav: dec(999_999) }, // Saturday
      { date: '2026-01-04', nav: dec(999_999) }, // Sunday
      { date: '2026-01-05', nav: dec(730_000) }, // Monday
    ];
    const a = managementFeeAccruals(rows, '0.01', new BusinessCalendar());
    expect(a.map((x) => x.accrual.toFixed(2))).toEqual(['10.00', '10.00', '10.00', '20.00']);
  });
});

describe('incentive', () => {
  it('pays nothing when ARIP does not beat the hurdle', () => {
    const r = incentiveFee({ arip: '0.05', watbr: '0.045', hurdle: '0.05', avgNav: 1e9, incentiveRate: '0.1' });
    expect(r.hurdleMet).toBe(false);
    expect(r.clause8.isZero() && r.clause12.isZero()).toBe(true);
  });
});

describe('termination (Clauses 12 and 13)', () => {
  it('counts part months rounded up', () => {
    expect(monthsSince('2025-12-31', '2026-01-31')).toBe(1);
    expect(monthsSince('2025-12-31', '2026-02-01')).toBe(2);
    expect(monthsSince('2025-12-31', '2026-03-31')).toBe(3);
  });

  it('32 days into a quarter: month basis bills 2 months, daily basis 32 days', () => {
    const f = terminationFee({
      navAtDetermination: 10_000_000_000, annualRate: '0.0075',
      lastFeePeriodEnd: '2025-12-31', determinationDate: '2026-02-01',
    });
    expect(f.months).toBe(2);
    expect(f.monthBasis.toFixed(2)).toBe('12500000.00');
    expect(f.days).toBe(32);
    expect(f.dailyBasis.toFixed(2)).toBe('6575342.47');
  });
});

describe('quarter close', () => {
  const calendar = new BusinessCalendar();
  const terms = { mgmtFeeRate: '0.0075', incentiveRate: '0.10', hurdleSpread: '0.02' };

  it('constant cash portfolio: fee charged, zero return, no incentive', () => {
    const rows = buildDailyNav({
      start: '2026-06-30', end: '2026-09-30', openingCash: 10_000_000_000,
      transactions: [], instruments: [],
    });
    const r = closePeriod({
      periodStart: '2026-07-01', periodEnd: '2026-09-30', navRows: rows, terms, calendar,
      benchmark: { trueYield: '0.18' },
    });
    expect(r.days).toBe(92);
    expect(r.mgmtFee.toFixed(2)).toBe('18904109.59');
    expect(r.arip.isZero()).toBe(true);
    expect(r.hurdleMet).toBe(false);
    expect(r.incentiveClause8.isZero()).toBe(true);
  });

  it('a bill that beats the hurdle earns an incentive', () => {
    // N10bn CP bought 30 Jun at a ~7% discount to face, maturing after the quarter.
    const instruments = [{
      id: 'cp1', type: 'commercial_paper', faceValue: '10752688172.04', cost: 10_000_000_000,
      valueDate: '2026-06-30', maturityDate: '2026-10-31',
    }];
    const transactions = [
      { id: 'in', date: '2026-06-30', type: 'inflow', amount: 10_000_000_000, approved: true },
      { id: 'buy', date: '2026-06-30', type: 'invest', amount: 10_000_000_000, instrumentId: 'cp1', approved: true },
    ];
    const rows = buildDailyNav({ start: '2026-06-30', end: '2026-09-30', transactions, instruments });
    const r = closePeriod({
      periodStart: '2026-07-01', periodEnd: '2026-09-30', navRows: rows, terms, calendar,
      benchmark: { discountRate: '0.175' },
    });
    expect(r.arip.gt(r.hurdle)).toBe(true);
    expect(r.hurdleMet).toBe(true);
    expect(r.incentiveClause8.gt(r.incentiveClause12)).toBe(true);
    expect(r.incentiveClause12.gt(0)).toBe(true);
  });

  it('refuses a period with missing NAV rows', () => {
    const rows = buildDailyNav({ start: '2026-07-01', end: '2026-07-10', transactions: [], instruments: [], openingCash: 1 });
    expect(() => closePeriod({
      periodStart: '2026-07-01', periodEnd: '2026-09-30', navRows: rows, terms, calendar, benchmark: { trueYield: '0.18' },
    })).toThrow(/cover 10 of 92 days/);
  });
});
