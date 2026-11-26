import { describe, expect, it } from '../harness.js';
import { dec } from '../../src/engine/index.js';
import { cashMovements, parseBankStatement, reconcile, suggestType } from '../../src/app/bankrec.js';

const money = (x) => dec(x).toFixed(2);

describe('bank statement reading', () => {
  it('finds the table under the bank\'s header lines, prefers the value date, and sorts newest-first files', () => {
    const sheet = [
      ['ACCESS BANK PLC', '', '', '', '', ''],
      ['Account: 0123456789', '', '', '', '', ''],
      ['Trans Date', 'Value Date', 'Narration', 'Debit', 'Credit', 'Balance'],
      ['', '', 'Opening balance', '', '', '1,000.00'],
      ['05-Jan-2026', '05/01/2026', 'TRF TO ACCESS HOLDINGS', '50,000.00', '', '1,451,000.00'],
      ['03-Jan-2026', '04/01/2026', 'MATURITY FD 123', '', '500,000.00', '1,501,000.00'],
      ['02-Jan-2026', '02/01/2026', 'INFLOW ACCESS', '', '1,000,000.00', '1,001,000.00'],
    ];
    const p = parseBankStatement(sheet);
    expect(p.rows.map((r) => r.date)).toEqual(['2026-01-02', '2026-01-04', '2026-01-05']);
    expect(p.rows.map((r) => money(r.amount))).toEqual(['1000000.00', '500000.00', '-50000.00']);
    expect(money(p.rows[2].balance)).toBe('1451000.00');
    expect(money(p.opening)).toBe('1000.00');
  });
  it('reads one signed Amount column', () => {
    const p = parseBankStatement([['Date', 'Description', 'Amount', 'Balance'], ['2026-02-01', 'Fee', '(250.00)', ''], ['2026-02-02', 'In', 1000, '']]);
    expect(p.rows.map((r) => money(r.amount))).toEqual(['-250.00', '1000.00']);
  });
  it('refuses a sheet with no dated amounts', () => {
    let msg = '';
    try { parseBankStatement([['Name', 'Value'], ['a', 1]]); } catch (e) { msg = e.message; }
    expect(msg).toContain('Debit and Credit');
  });
});

describe('bank reconciliation', () => {
  const data = {
    transactions: [
      { id: 'in', type: 'inflow', date: '2026-01-02', amount: '1000000.00' },
      { id: 'i1', type: 'invest', date: '2026-01-03', amount: '600000.00', instrumentId: 'fd1' },
      { id: 'm1', type: 'mature', date: '2026-01-20', amount: '610000.00', instrumentId: 'fd1' },
      { id: 'i2', type: 'invest', date: '2026-01-20', amount: '400000.00', instrumentId: 'fd2' },
      { id: 'w1', type: 'withdrawal', date: '2026-01-25', amount: '50000.00' },
      { id: 'x1', type: 'interest', date: '2026-01-28', amount: '1000.00' },
    ],
    instruments: [
      { id: 'fd1', type: 'fixed_deposit', cost: '600000.00', rate: '0.20', valueDate: '2026-01-03', maturityDate: '2026-01-20' },
      { id: 'fd2', type: 'fixed_deposit', cost: '400000.00', rate: '0.20', valueDate: '2026-01-20', maturityDate: '2026-06-20' },
    ],
    fundPrices: [], funds: [],
  };
  const lines = [
    { line: 1, date: '2026-01-02', description: 'Inflow', reference: '', amount: dec('1000000'), balance: dec('1000000') },
    { line: 2, date: '2026-01-03', description: 'FD placement', reference: '', amount: dec('-600000'), balance: dec('400000') },
    { line: 3, date: '2026-01-15', description: 'SMS ALERT CHARGES', reference: '', amount: dec('-500'), balance: dec('399500') },
    { line: 4, date: '2026-01-20', description: 'FD rollover net', reference: '', amount: dec('210000'), balance: dec('609500') },
    { line: 5, date: '2026-01-27', description: 'Payment to Access', reference: '', amount: dec('-50000'), balance: dec('559500') },
  ];

  it('matches same-day and late lines, nets a maturity with its reinvestment, and lists what is on one side only', () => {
    const r = reconcile(data, lines, { days: 3 });
    expect(r.matched.map((m) => m.entry.tx.id)).toEqual(['in', 'i1', 'w1']);
    expect(r.matched.find((m) => m.entry.tx.id === 'w1').dayGap).toBe(-2); // recorded two days before the bank shows it
    expect(r.netted.length).toBe(1);
    expect(r.netted[0].entries.map((e) => e.tx.id).sort()).toEqual(['i2', 'm1']);
    expect(r.netted[0].line.line).toBe(4);
    expect(r.bankOnly.map((l) => l.line)).toEqual([3]);
    expect(r.appOnly.map((m) => m.tx.id)).toEqual([]); // the interest is dated after the statement's last line
  });
  it('a tighter date window leaves the late withdrawal unmatched on both sides', () => {
    const r = reconcile(data, lines, { days: 1 });
    expect(r.bankOnly.map((l) => l.line)).toEqual([3, 5]);
    expect(r.appOnly.map((m) => m.tx.id)).toEqual(['w1']);
  });
  it('compares balances day by day and shows where the difference starts', () => {
    const r = reconcile(data, lines, { days: 3 });
    expect(money(r.opening.bank)).toBe('0.00');
    // The bank charge is missing from the app from 15 Jan; the late withdrawal has caught up by the last day.
    expect(r.changes.map((d) => [d.date, money(d.diff)])).toEqual([['2026-01-02', '0.00'], ['2026-01-15', '-500.00']]);
    expect(money(r.closing.diff)).toBe('-500.00');
  });
  it('rollover entries carry their own sign; guesses an entry type from the narration', () => {
    expect(cashMovements({ transactions: [{ type: 'rollover', date: '2026-01-01', amount: '-5.00' }, { type: 'fee_debit', date: '2026-01-01', amount: '7.00' }] }).map((m) => money(m.amount))).toEqual(['-5.00', '-7.00']);
    expect(suggestType({ amount: dec(-100), description: 'SMS ALERT CHARGES', reference: '' })).toBe('fee_debit');
    expect(suggestType({ amount: dec(100), description: 'Interest paid on call deposit', reference: '' })).toBe('interest');
    expect(suggestType({ amount: dec(100), description: 'Transfer from Access Holdings', reference: '' })).toBe('inflow');
  });
});
