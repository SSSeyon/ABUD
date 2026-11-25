import { describe, expect, it } from '../harness.js';
import { benchmarkFor, closeRecord, completedQuarters, computeClose, lockedBy } from '../../src/app/close.js';
import { DEFAULT_LIMITS } from '../../src/app/alerts.js';
import { feedHealth, latestByTenor, marketEvents, rankOpportunities, tenorBucket } from '../../src/app/market.js';

const TERMS = [{ id: '2021-01-01', effectiveFrom: '2021-01-01', mgmtFeeRate: '0.0075', incentiveRate: '0.10', hurdleSpread: '0.02', incentiveReading: 'clause_8' }];
const auctions = [
  { id: 'ntb-2026-06-24-91', kind: 'ntb', date: '2026-06-24', tenorDays: '91', stopRate: '0.18' },
  { id: 'ntb-2026-06-24-182', kind: 'ntb', date: '2026-06-24', tenorDays: '182', stopRate: '0.19' },
  { id: 'ntb-2026-07-08-91', kind: 'ntb', date: '2026-07-08', tenorDays: '91', stopRate: '0.185' },
];
// N10bn in cash from 30 Jun 2026, never invested: NAV is flat, so the fee is the worked example's.
const flat = { transactions: [{ id: 't1', type: 'inflow', date: '2026-06-30', amount: '10000000000.00' }], instruments: [], fundPrices: [], funds: [], mandateTerms: TERMS, auctions };

describe('quarter close', () => {
  it('benchmark: the last 91-day auction before the quarter starts', () => {
    expect(benchmarkFor(flat, '2026Q3').id).toBe('ntb-2026-06-24-91');
    expect(benchmarkFor(flat, '2026Q4').id).toBe('ntb-2026-07-08-91');
    expect(benchmarkFor(flat, '2026Q2')).toBe(null);
  });

  it('completed quarters run back to the first transaction', () => {
    expect(completedQuarters('2026-02-10', '2026-11-25').map((q) => q.label)).toEqual(['2026Q3', '2026Q2', '2026Q1']);
  });

  it('flat N10bn for 2026Q3: fee N18,904,109.59, no return, no incentive', () => {
    const c = computeClose(flat, '2026Q3');
    expect(c.error).toBe(undefined);
    expect(c.result.mgmtFee.toFixed(2)).toBe('18904109.59');
    expect(c.result.arip.toFixed(6)).toBe('0.000000');
    expect(c.result.hurdleMet).toBe(false);
    const rec = closeRecord(c);
    expect(rec).toMatchObject({ quarter: '2026Q3', periodStart: '2026-07-01', periodEnd: '2026-09-30', days: '92', mgmtFee: '18904109.59', incentiveClause8: '0.00', status: 'closed' });
    // True yield from the 18% stop: 0.18 / (1 - 0.18 x 91/365)
    expect(rec.benchmark.trueYield.slice(0, 8)).toBe('0.188457');
  });

  it('explains what is missing instead of failing', () => {
    expect(computeClose({ ...flat, auctions: [] }, '2026Q3').error).toContain('No 91-day NTB auction');
    expect(computeClose({ ...flat, mandateTerms: [] }, '2026Q3').error).toContain('No mandate terms');
  });

  it('a closed quarter locks entries dated in it', () => {
    const closed = [{ label: '2026Q3', start: '2026-07-01', end: '2026-09-30' }];
    expect(lockedBy(closed, 'transactions', { date: '2026-08-01' }).label).toBe('2026Q3');
    expect(lockedBy(closed, 'transactions', { date: '2026-10-01' })).toBe(null);
    expect(lockedBy(closed, 'fundPrices', { date: '2026-09-30' }).label).toBe('2026Q3');
    // A deal held across the quarter is locked; one that matured before it is not.
    expect(lockedBy(closed, 'instruments', { valueDate: '2026-06-01', maturityDate: '2026-12-01' }).label).toBe('2026Q3');
    expect(lockedBy(closed, 'instruments', { valueDate: '2026-01-01', maturityDate: '2026-06-30' })).toBe(null);
    expect(lockedBy(closed, 'instruments', { valueDate: '2026-05-01' }).label).toBe('2026Q3'); // open-ended fund
    expect(lockedBy(closed, 'settings', { date: '2026-08-01' })).toBe(null);
  });
});

describe('market', () => {
  it('tenor buckets absorb CBN variations', () => {
    expect([tenorBucket('90'), tenorBucket('181'), tenorBucket('363'), tenorBucket('154')]).toEqual([91, 182, 364, 154]);
    expect([tenorBucket('35', 'omo'), tenorBucket('154', 'omo'), tenorBucket('252', 'omo')]).toEqual([91, 182, 364]);
  });

  it('latest auction per tenor with the move in bps', () => {
    const l = latestByTenor(flat, 'ntb');
    expect(l.map((x) => x.tenor)).toEqual([91, 182]);
    expect(l[0].auction.id).toBe('ntb-2026-07-08-91');
    expect(l[0].changeBps.toFixed(0)).toBe('50');
  });

  it('flags NTB moves over 25 bps and new CPs', () => {
    const data = { ...flat, cpQuotes: [{ id: 'q1', date: '2026-07-10', issuer: 'Acme Ltd', confirmed: false }] };
    const keys = marketEvents(data, '2026-07-15').map((e) => e.key);
    expect(keys).toContain('ntb-move-ntb-2026-07-08-91');
    expect(keys).toContain('cp-q1');
    expect(marketEvents(data, '2026-09-30')).toEqual([]);
  });

  it('ranks options and applies the limits', () => {
    const data = {
      ...flat,
      cpQuotes: [
        { id: 'q1', date: '2026-07-10', issuer: 'Acme Ltd', confirmed: true, yield: '0.25', tenorDays: '180', rating: 'A' },
        { id: 'q2', date: '2026-07-10', issuer: 'Long Ltd', confirmed: true, yield: '0.30', tenorDays: '400', rating: 'A' },
        { id: 'q3', date: '2026-07-10', issuer: 'Draft Ltd', confirmed: false, yield: '0.40', tenorDays: '90' },
      ],
    };
    const r = rankOpportunities(data, '2026-07-15', DEFAULT_LIMITS);
    expect(r.cashToDeploy.toFixed(2)).toBe('9990000000.00');
    expect(r.ranked[0].key).toBe('cp-q1'); // 25% beats the bills
    expect(r.ranked[0].amount.toFixed(2)).toBe('2500000000.00'); // 25% of N10bn concentration headroom
    expect(r.ranked.map((o) => o.key)).notToContain('cp-q3'); // unconfirmed
    expect(r.rejected.map((o) => o.key)).toContain('cp-q2'); // tenor over 364 days
  });

  it('feed health: ok, stale, failing, never', () => {
    const data = { feedStatus: [
      { id: 'cbn_ntb', lastSuccessAt: '2026-07-14T06:30:00Z' },
      { id: 'cbn_omo', lastSuccessAt: '2026-07-01T06:30:00Z' },
      { id: 'cbn_mpc', lastSuccessAt: '2026-07-13T06:30:00Z', lastErrorAt: '2026-07-14T06:30:00Z', lastError: 'x' },
    ] };
    const s = Object.fromEntries(feedHealth(data, '2026-07-15').map((f) => [f.key, f.status]));
    expect([s.cbn_ntb, s.cbn_omo, s.cbn_mpc, s.fmdq_cp]).toEqual(['ok', 'stale', 'failing', 'never']);
  });
});
