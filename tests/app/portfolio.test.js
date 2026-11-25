import { describe, expect, it } from '../harness.js';
import { closedInstrumentIds, engineInputs, expectedMaturityValue, mandateOn, maturityWatch, navSeries, openingTransactions } from '../../src/app/portfolio.js';

// Firestore-shaped data: money and rates as strings. No approvals: every entry counts.
const data = {
  transactions: [
    { id: 't1', type: 'inflow', date: '2026-01-01', amount: '1000000.00' },
    { id: 't2', type: 'invest', date: '2026-01-02', amount: '950000.00', instrumentId: 'i1' },
    { id: 't3', type: 'invest', date: '2026-01-03', amount: '40000.00', instrumentId: 'i2' },
    { id: 't4', type: 'withdrawal', date: '2026-01-04', amount: '5000.00' },
  ],
  instruments: [
    { id: 'i1', type: 'ntb', faceValue: '1000000.00', cost: '950000.00', valueDate: '2026-01-02', maturityDate: '2026-01-12' },
    { id: 'i2', type: 'fixed_deposit', cost: '40000.00', rate: '0.219', valueDate: '2026-01-03', maturityDate: '2026-02-02' },
  ],
  fundPrices: [],
};

describe('portfolio (Firestore data to engine)', () => {
  it('every instrument and transaction counts', () => {
    expect(engineInputs(data).instruments.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(engineInputs(data).transactions.every((t) => t.approved)).toBe(true);
    expect(openingTransactions(data.transactions).get('i2').id).toBe('t3');
  });

  it('NAV: cash plus holdings', () => {
    const rows = navSeries(data, '2026-01-07');
    expect(rows[0].date).toBe('2026-01-01');
    // Cash 1,000,000 - 950,000 - 40,000 - 5,000 = 5,000
    // Bill 950,000 + 50,000 x 5/10 = 975,000; FD 40,000 + 40,000 x 21.9% x 4/365 = 40,096
    expect(rows.at(-1).nav.toFixed(2)).toBe('1020096.00');
  });

  it('no transactions: empty series', () => {
    expect(navSeries({ transactions: [], instruments: [] }, '2026-01-07')).toHaveLength(0);
  });

  it('a recorded maturity takes the holding off and the cash in', () => {
    const matured = { ...data, transactions: [...data.transactions, { id: 't5', type: 'mature', date: '2026-01-12', amount: '1000000.00', instrumentId: 'i1' }] };
    expect([...closedInstrumentIds(matured.transactions)]).toEqual(['i1']);
    const last = navSeries(matured, '2026-01-12').at(-1);
    expect(last.cash.toFixed(2)).toBe('1005000.00');
  });

  it('an early termination takes the holding out of NAV that day', () => {
    // Deposit i2 matures 2026-02-02 but is terminated on 2026-01-13 for 40,250.
    const early = { ...data, transactions: [...data.transactions, { id: 't5', type: 'mature', date: '2026-01-13', amount: '40250.00', instrumentId: 'i2' }] };
    expect(engineInputs(early).instruments.find((i) => i.id === 'i2').closeDate).toBe('2026-01-13');
    const row = navSeries(early, '2026-01-13').at(-1);
    // Bill has matured (no maturity recorded, so it is off NAV and its cash is not in); deposit is out, its cash is in.
    expect(row.holdingsValue.toFixed(2)).toBe('0.00');
    expect(row.cash.toFixed(2)).toBe('45250.00');
    // A maturity on (or after) the contract date sets no early close.
    const onTime = { ...data, transactions: [...data.transactions, { id: 't5', type: 'mature', date: '2026-02-02', amount: '40720.00', instrumentId: 'i2' }] };
    expect(engineInputs(onTime).instruments.find((i) => i.id === 'i2').closeDate).toBe(undefined);
  });

  it('expected maturity value', () => {
    expect(expectedMaturityValue(data.instruments[0])).toBe('1000000.00');
    // 40,000 x 21.9% x 30/365 = 720
    expect(expectedMaturityValue(data.instruments[1])).toBe('40720.00');
  });

  it('maturity watch: due soon and overdue, until a maturity is recorded', () => {
    expect(maturityWatch(data, '2026-01-10', 14).due.map((i) => i.id)).toEqual(['i1']);
    expect(maturityWatch(data, '2026-01-13', 14).overdue.map((i) => i.id)).toEqual(['i1']);
    const recorded = { ...data, transactions: [...data.transactions, { id: 't5', type: 'mature', date: '2026-01-12', amount: '1000000.00', instrumentId: 'i1' }] };
    expect(maturityWatch(recorded, '2026-01-13', 14).overdue).toHaveLength(0);
  });

  it('mandate terms in force on a date', () => {
    const d = { mandateTerms: [{ effectiveFrom: '2022-06-01', mgmtFeeRate: '0.0075' }, { effectiveFrom: '2024-08-30', mgmtFeeRate: '0.0080' }] };
    expect(mandateOn(d, '2023-01-01').mgmtFeeRate).toBe('0.0075');
    expect(mandateOn(d, '2025-01-01').mgmtFeeRate).toBe('0.0080');
    expect(mandateOn(d, '2021-01-01')).toBe(null);
  });
});
