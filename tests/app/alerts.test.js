import { describe, expect, it } from '../harness.js';
import { computeAlerts, DEFAULT_LIMITS, limitsFrom } from '../../src/app/alerts.js';
import { periodOptions, resolvePeriod } from '../../src/app/period.js';

// 100m in on 1 Jun; 80m into a deposit with Bank A on 2 Jun maturing 1 Jul; 20m left in cash.
const base = {
  transactions: [
    { id: 't1', type: 'inflow', date: '2026-06-01', amount: '100000000.00' },
    { id: 't2', type: 'invest', date: '2026-06-02', amount: '80000000.00', instrumentId: 'd1' },
  ],
  instruments: [{ id: 'd1', type: 'fixed_deposit', counterpartyName: 'Bank A', cost: '80000000.00', rate: '0.20', valueDate: '2026-06-02', maturityDate: '2026-07-01' }],
  fundPrices: [],
  funds: [],
};
const keys = (alerts) => alerts.map((a) => a.key);

describe('alerts', () => {
  it('maturity due within 14 days, then matured and not actioned', () => {
    expect(keys(computeAlerts(base, '2026-06-20'))).toContain('due-d1');
    const due = computeAlerts(base, '2026-06-30').find((a) => a.key === 'due-d1');
    expect(due.level).toBe('high'); // 1 day out
    expect(keys(computeAlerts(base, '2026-07-03'))).toContain('matured-d1');
  });

  it('a recorded maturity clears the maturity alerts', () => {
    const done = { ...base, transactions: [...base.transactions, { id: 't3', type: 'mature', date: '2026-07-01', amount: '81315068.49', instrumentId: 'd1' }] };
    expect(keys(computeAlerts(done, '2026-07-03')).filter((k) => k.endsWith('d1'))).toEqual([]);
  });

  it('idle cash: above the limit for more than 2 business days', () => {
    // 20m cash from 2 Jun (above 10m). Thu 4 Jun is only 3 business days in; by Mon 8 Jun it is well over.
    expect(keys(computeAlerts(base, '2026-06-02'))).notToContain('idle-cash');
    expect(keys(computeAlerts(base, '2026-06-08'))).toContain('idle-cash');
    const higher = { ...base, settings: [{ id: 'limits', ...DEFAULT_LIMITS, idleCash: '50000000.00' }] };
    expect(keys(computeAlerts(higher, '2026-06-08'))).notToContain('idle-cash');
  });

  it('concentration: one bank above 25% of NAV', () => {
    expect(keys(computeAlerts(base, '2026-06-08'))).toContain('conc-Bank A');
  });

  it('liquidity buffer: cash plus near maturities against NAV', () => {
    // 8 Jun: the deposit matures within 30 days, so everything is liquid: no alert.
    expect(keys(computeAlerts(base, '2026-06-08'))).notToContain('liquidity');
    const long = { ...base, instruments: [{ ...base.instruments[0], maturityDate: '2026-12-01' }] };
    const tight = { ...long, settings: [{ id: 'limits', ...DEFAULT_LIMITS, liquidityShare: '0.30' }] };
    expect(keys(computeAlerts(tight, '2026-06-08'))).toContain('liquidity'); // 20m of ~100m is under 30%
  });

  it('tenor above the limit', () => {
    const long = { ...base, instruments: [{ ...base.instruments[0], maturityDate: '2027-07-01' }] };
    expect(keys(computeAlerts(long, '2026-06-08'))).toContain('tenor-d1');
  });

  it('limits: saved values override the defaults', () => {
    expect(limitsFrom({}).idleCash).toBe('10000000.00');
    expect(limitsFrom({ settings: [{ id: 'limits', idleCash: '5000000.00' }] }).idleCash).toBe('5000000.00');
  });
});

describe('periods', () => {
  it('offers QTD, YTD, every quarter back to inception, and since inception', () => {
    const opts = periodOptions('2025-08-15', '2026-11-25');
    expect(opts.map((o) => o.key)).toEqual(['qtd', 'ytd', '2026Q3', '2026Q2', '2026Q1', '2025Q4', '2025Q3', 'inception']);
    expect(opts[0]).toEqual({ key: 'qtd', label: 'Quarter to date (2026Q4)', start: '2026-10-01', end: '2026-11-25' });
  });

  it('clips a period to inception and today', () => {
    const p = resolvePeriod({ key: '2025Q3' }, '2025-08-15', '2026-11-25');
    expect([p.start, p.end, p.prevEnd]).toEqual(['2025-08-15', '2025-09-30', '2025-08-14']);
    const c = resolvePeriod({ key: 'custom', start: '2020-01-01', end: '2030-01-01' }, '2025-08-15', '2026-11-25');
    expect([c.start, c.end]).toEqual(['2025-08-15', '2026-11-25']);
  });
});
