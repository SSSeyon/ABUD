import { describe, expect, it } from '../harness.js';
import { NET_PAYOUT_FROM, payoutBasis, payoutQuarters, payoutSchedule, payoutsByQuarter } from '../../src/app/payout.js';

const money = (x) => x.toFixed(2);

describe('quarterly income payout to Access', () => {
  it('gross before 2026Q4, net of MBO fees from then on', () => {
    expect(NET_PAYOUT_FROM).toBe('2026Q4');
    expect([payoutBasis('2026Q3'), payoutBasis('2026Q4'), payoutBasis('2027Q1')]).toEqual(['gross', 'net', 'net']);
    expect(payoutQuarters('2027-02-01').map((q) => q.label)).toEqual(['2027Q1', '2026Q4']);
  });

  const data = {
    transactions: [
      { id: 'in', type: 'inflow', date: '2026-10-01', amount: '100000000.00' },
      { id: 'w1', type: 'withdrawal', date: '2027-01-10', amount: '300000.00', purpose: 'income_payout', quarter: '2026Q4' },
      { id: 'w2', type: 'withdrawal', date: '2027-01-11', amount: '5000000.00' },
    ],
    instruments: [], fundPrices: [], funds: [],
    quarterlyResults: [{ id: '2026Q4', quarter: '2026Q4', periodStart: '2026-10-01', periodEnd: '2026-12-31', income: '1000000.00', mgmtFee: '100000.00', incentiveClause8: '50000.00' }],
  };

  it('a closed quarter: payable = income − management fee − Clause 8 incentive, less what is paid', () => {
    const s = payoutSchedule(data, '2027-01-20');
    expect(s.map((r) => r.quarter)).toEqual(['2027Q1', '2026Q4']);
    const q4 = s[1];
    expect(q4.closed).toBe(true);
    expect(money(q4.payable)).toBe('850000.00');
    expect(money(q4.paid)).toBe('300000.00');
    expect(money(q4.outstanding)).toBe('550000.00');
    expect(s[0].closed).toBe(false);
    expect(s[0].payable).toBe(null);
  });

  it('only tagged withdrawals count as payouts, and a loss means nothing to pay', () => {
    expect([...payoutsByQuarter(data.transactions).keys()]).toEqual(['2026Q4']);
    const loss = { ...data, quarterlyResults: [{ ...data.quarterlyResults[0], income: '100000.00' }] };
    expect(money(payoutSchedule(loss, '2027-01-20')[1].payable)).toBe('0.00');
  });
});
