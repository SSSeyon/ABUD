import { describe, expect, it } from '../harness.js';
import { BusinessCalendar, dec, eachDay, managementFeeForPeriod, shadowBenchmark, worksheetIncentive } from '../../src/engine/index.js';
import { limitsFrom } from '../../src/app/alerts.js';
import { matches } from '../../src/app/backtest.js';
import { backupFile, restoreDocs } from '../../src/app/backup.js';
import { computeTermination } from '../../src/app/close.js';
import { belowMinimum, findCounterparty, normRating, ratingOn, recentDowngrades } from '../../src/app/counterparties.js';
import { buildDigest } from '../../src/app/digest.js';
import { upcomingAuctions } from '../../src/app/market.js';
import { monthEnds } from '../../src/app/mgmt.js';
import { periodFlows } from '../../src/app/flows.js';
import { periodReport } from '../../src/app/portfolio.js';

const TERMS = [{ id: '2021-01-01', effectiveFrom: '2021-01-01', mgmtFeeRate: '0.0075', incentiveRate: '0.10', hurdleSpread: '0.02', incentiveReading: 'clause_8' }];
const flat = {
  transactions: [{ id: 't1', type: 'inflow', date: '2026-06-30', amount: '10000000000.00' }], instruments: [], fundPrices: [], funds: [], mandateTerms: TERMS,
  auctions: [{ id: 'ntb-2026-06-24-91', kind: 'ntb', date: '2026-06-24', tenorDays: '91', stopRate: '0.18' }],
};

describe('fee day count and worksheet reading', () => {
  it('quarterly basis: a full quarter costs exactly a quarter of the annual rate', () => {
    const rows = eachDay('2026-07-01', '2026-09-30').map((date) => ({ date, nav: dec('1000000') }));
    expect(managementFeeForPeriod(rows, '2026-07-01', '2026-09-30', '0.0075', new BusinessCalendar(), 'quarterly').posted.toFixed(2)).toBe('1875.00');
    expect(managementFeeForPeriod(rows, '2026-07-01', '2026-09-30', '0.0075', new BusinessCalendar()).posted.toFixed(2)).toBe('1890.41');
  });

  it('shadow account compounds contributions daily at yield + spread', () => {
    const s = shadowBenchmark({ start: '2026-01-01', end: '2026-01-02', contributions: new Map([['2026-01-01', dec(365000)]]), yieldOn: () => '0.08', spread: '0.02' });
    expect(s[0].interest.toFixed(2)).toBe('100.00');
    expect(s[1].interest.toFixed(4)).toBe('100.0274');
  });

  it('worksheet incentive: 10% of income above the benchmark income, never negative', () => {
    expect(worksheetIncentive({ income: 100, benchmarkIncome: 60, incentiveRate: '0.1' }).fee.toFixed(2)).toBe('4.00');
    expect(worksheetIncentive({ income: 50, benchmarkIncome: 60, incentiveRate: '0.1' }).fee.toFixed(2)).toBe('0.00');
  });

  it('back-test match: within 1% or N1,000', () => {
    expect(matches('100500', '100000')).toBe(true);
    expect(matches('103000', '100000')).toBe(false);
    expect(matches('2000000', '1985000')).toBe(true);
  });
});

describe('termination', () => {
  it('whole months since the last quarter end, part months rounded up', () => {
    const t = computeTermination(flat, '2026-08-15');
    expect(t.fee.months).toBe(2);
    expect(t.fee.monthBasis.toFixed(2)).toBe('12500000.00');
    expect(t.lastFeePeriodEnd).toBe('2026-06-30');
    expect(t.close.result.incentiveClause8.toFixed(2)).toBe('0.00');
  });
});

describe('counterparties and ratings', () => {
  const data = {
    counterparties: [{ id: 'c1', name: 'Coronation Merchant Bank Ltd', kind: 'bank', aliases: 'Coronation MB' }],
    ratings: [
      { id: 'r1', counterpartyId: 'c1', agency: 'Agusto', rating: 'A', date: '2026-01-01' },
      { id: 'r2', counterpartyId: 'c1', agency: 'GCR', rating: 'BBB', date: '2026-03-01' },
      { id: 'r3', counterpartyId: 'c1', agency: 'Agusto', rating: 'A-', date: '2026-06-01' },
    ],
  };
  it('normalises agency styles onto one scale', () => {
    expect([normRating('Aa-(NG)'), normRating('Baa1'), normRating('bbb−'), normRating('A+ (ngn)'), normRating('XYZ')]).toEqual(['AA-', 'BBB+', 'BBB-', 'A+', null]);
    expect([belowMinimum('BBB-', 'BBB'), belowMinimum('A', 'BBB'), belowMinimum(null, 'BBB')]).toEqual([true, false, false]);
  });
  it('matches names and aliases, ignoring Ltd and case', () => {
    expect(findCounterparty(data, 'Coronation Merchant Bank').id).toBe('c1');
    expect(findCounterparty(data, 'coronation mb').id).toBe('c1');
    expect(findCounterparty(data, 'Page')).toBe(null);
  });
  it('rating in force is the lowest of each agency\'s latest; downgrades are flagged', () => {
    expect(ratingOn(data, 'c1', '2026-02-01')).toEqual({ rating: 'A', agency: 'Agusto', date: '2026-01-01' });
    expect(ratingOn(data, 'c1', '2026-07-01').rating).toBe('BBB');
    expect(recentDowngrades(data, 'c1', '2026-06-10')).toEqual([{ agency: 'Agusto', from: 'A', to: 'A-', date: '2026-06-01' }]);
    expect(recentDowngrades(data, 'c1', '2026-09-10')).toEqual([]);
  });
});

describe('limits, reports, backup, digest, calendar', () => {
  it('limits in force on a date come from the dated versions', () => {
    const data = { limitSets: [{ id: '2026-01-01', effectiveFrom: '2026-01-01', concentrationShare: '0.30' }, { id: '2026-06-01', effectiveFrom: '2026-06-01', concentrationShare: '0.20' }] };
    expect([limitsFrom(data, '2025-12-01').concentrationShare, limitsFrom(data, '2026-03-01').concentrationShare, limitsFrom(data, '2026-07-01').concentrationShare]).toEqual(['0.25', '0.30', '0.20']);
    expect(limitsFrom({}, '2026-01-01').minRating).toBe('BBB');
  });
  it('month ends of a period, closing on the period end', () => {
    expect(monthEnds('2026-01-15', '2026-03-10')).toEqual(['2026-01-31', '2026-02-28', '2026-03-10']);
  });
  it('backup keeps everything; restore skips the change history', () => {
    const file = backupFile({ transactions: [{ id: 't1', amount: '1', updatedAt: { toDate: () => new Date('2026-01-01T00:00:00Z') } }], audit: [{ id: 'a1' }] }, 'now');
    expect(file.collections.transactions[0].updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(file.collections.audit).toHaveLength(1);
    expect(restoreDocs(file)).toEqual([{ coll: 'transactions', id: 't1', data: { amount: '1', updatedAt: '2026-01-01T00:00:00.000Z' } }]);
  });
  it('digest lists the alerts', () => {
    const d = buildDigest(flat, '2026-07-15', 'https://example.org/');
    expect(d.subject).toContain('ABUD 2026-07-15');
    expect(d.text).toContain('Idle cash');
    expect(d.html).toContain('https://example.org/#/alerts');
  });
  it('auction calendar: projected from the cycle unless dates are entered', () => {
    const auctions = ['2026-10-07', '2026-10-21', '2026-11-04', '2026-11-18'].map((date) => ({ id: date, kind: 'ntb', date, tenorDays: '91', stopRate: '0.16' }));
    expect(upcomingAuctions({ auctions }, '2026-11-26').map((u) => u.date)).toEqual(['2026-12-02', '2026-12-16', '2026-12-30']);
    expect(upcomingAuctions({ auctions, auctionCalendar: [{ id: 'x', date: '2026-12-03', kind: 'ntb' }] }, '2026-11-26').map((u) => u.date)).toEqual(['2026-12-03']);
  });
});

describe('money flows (Sankey)', () => {
  it('sources and uses add up: opening + inflows + income = withdrawals + fees + closing', () => {
    const data = { ...flat, transactions: [...flat.transactions,
      { id: 't2', type: 'withdrawal', date: '2026-07-10', amount: '1000000000.00' },
      { id: 't3', type: 'fee_debit', date: '2026-07-20', amount: '50.00' },
      { id: 't4', type: 'inflow', date: '2026-07-25', amount: '250000000.00' }] };
    const f = periodFlows(periodReport(data, '2026-07-01', '2026-07-31'));
    const sum = (l) => l.reduce((s, x) => s.plus(x.value), dec(0)).toFixed(2);
    expect(sum(f.left)).toBe(sum(f.right));
    expect(f.right.map((x) => x.label)).toContain('Withdrawals');
  });
});
