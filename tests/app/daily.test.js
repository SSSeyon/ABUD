import { describe, expect, it } from '../harness.js';
import { dec, FundStatementBook } from '../../src/engine/index.js';
import { cashStatement, dailyBreakdown, positionStatement } from '../../src/app/daily.js';
import { cellDate, parseStatement, statementPlan } from '../../src/app/fundstatement.js';
import { partialLiquidationPlan } from '../../src/app/liquidation.js';
import { engineInputs, holdingsOn, navSeries, periodReport } from '../../src/app/portfolio.js';
import { fmtCompact, fmtNaira } from '../../src/app/ui.js';

const money = (x) => dec(x).toFixed(2);

describe('whole-naira display', () => {
  it('rounds half up to the naira and keeps separators', () => {
    expect([fmtNaira('1234.5'), fmtNaira('1234.49'), fmtNaira('-2500000.75'), fmtNaira('0.2')]).toEqual(['₦1,235', '₦1,234', '−₦2,500,001', '₦0']);
    expect([fmtCompact(4152345678), fmtCompact(624400000), fmtCompact(85300), fmtCompact(-1500000)]).toEqual(['₦4,152m', '₦624m', '₦85k', '−₦2m']);
  });
});

describe('fixed deposit partial liquidation', () => {
  const fd = { cost: '100000000.00', rate: '0.20', valueDate: '2026-01-01', maturityDate: '2026-12-27' };
  it('takes out the amount and the penalty, and rolls the balance to the same maturity', () => {
    const p = partialLiquidationPlan(fd, { date: '2026-04-11', amount: '30000000', penaltyBasis: 'interest_pct', penaltyValue: '0.25' });
    // 100 days at 20%: interest 5,479,452.05; value 105,479,452.05
    expect(money(p.accrued)).toBe('5479452.05');
    expect(money(p.gross)).toBe('105479452.05');
    // penalty: 25% of the interest on the 30m share of the value
    expect(money(p.penalty)).toBe(money(dec('5479452.0547945205').times(dec(30000000).div('105479452.05')).times('0.25').toDecimalPlaces(2)));
    expect(money(p.balance)).toBe(money(p.gross.minus(p.penalty).minus(30000000)));
    expect(p.remainingDays).toBe(260);
    expect(money(p.proceeds.minus(p.balance))).toBe('30000000.00');
  });
  it('refuses dates outside the deposit and amounts that leave nothing', () => {
    let msg = '';
    try { partialLiquidationPlan(fd, { date: '2026-12-27', amount: '1', penaltyBasis: 'none' }); } catch (e) { msg = e.message; }
    expect(msg).toContain('maturity');
    msg = '';
    try { partialLiquidationPlan(fd, { date: '2026-06-01', amount: '200000000', penaltyBasis: 'none' }); } catch (e) { msg = e.message; }
    expect(msg).toContain('whole deposit');
  });
  it('in the NAV: the penalty is a loss on the day, the balance carries on at the same rate', () => {
    const data = {
      transactions: [
        { id: 't0', type: 'inflow', date: '2026-01-01', amount: '100000000.00' },
        { id: 't1', type: 'invest', date: '2026-01-01', amount: '100000000.00', instrumentId: 'fd1' },
        { id: 't2', type: 'mature', date: '2026-04-11', amount: '104479452.05', instrumentId: 'fd1' }, // 1m penalty
        { id: 't3', type: 'invest', date: '2026-04-11', amount: '74479452.05', instrumentId: 'fd2' },
        { id: 't4', type: 'withdrawal', date: '2026-04-11', amount: '30000000.00' },
      ],
      instruments: [
        { id: 'fd1', type: 'fixed_deposit', cost: '100000000.00', rate: '0.20', valueDate: '2026-01-01', maturityDate: '2026-12-27' },
        { id: 'fd2', type: 'fixed_deposit', cost: '74479452.05', rate: '0.20', valueDate: '2026-04-11', maturityDate: '2026-12-27' },
      ],
      fundPrices: [], funds: [],
    };
    const b = dailyBreakdown(data, '2026-04-10', '2026-04-12');
    const day = b.days.find((d) => d.date === '2026-04-11');
    // proceeds less the value the day before (99 days' interest)
    expect(money(day.byPos.get('fd1').income)).toBe(money(dec('104479452.05').minus(dec(100000000).plus(dec(100000000).times('0.2').times(99).div(365)))));
    expect(day.byPos.get('fd1').income.isNegative()).toBe(true);
    expect(money(day.closeNav)).toBe('74479452.05');
  });
});

describe('fund statements', () => {
  const sheet = [
    ['', '', ''],
    ['', 'Date', 'Investment Amount', 'Liquidation', 'Withdrawal', 'Rate (p.a)', 'Earnings', 'New Balance'],
    ['', 46023, 1000000, '', '', 0.2, 547.95, 1000547.95],
    ['', '02/01/2026', '', '', '', '20%', 548.25, 1001096.2],
    ['', '3 Jan 2026', 500000, '', '', 20, 822.28, 1501918.48],
    ['', 'Jan 4, 2026', '', '200,000.00', '', 20, 713.09, 1302631.57],
    ['', 'Total', 1500000, 200000, '', '', '', ''],
  ];
  it('reads dates in any common form and rates as fractions', () => {
    expect([cellDate(46023), cellDate('02/01/2026'), cellDate('3 Jan 2026'), cellDate('Jan 4, 2026'), cellDate('2026-01-05'), cellDate('Total')]).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', null]);
    const { rows, cols } = parseStatement(sheet);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(cols.redemption).toEqual([3, 4]);
    expect(rows.map((r) => r.rate.toFixed())).toEqual(['0.2', '0.2', '0.2', '0.2']);
    expect(money(rows[3].redemption)).toBe('200000.00');
    expect(money(rows.at(-1).balance)).toBe('1302631.57');
  });
  it('plans the saved rows and only the movements not already recorded', () => {
    const { rows } = parseStatement(sheet);
    const data = {
      funds: [{ id: 'cw', name: 'Cowrywise', managerName: 'Cowrywise', pricingBasis: 'yield' }],
      instruments: [{ id: 'cw1', type: 'money_market_fund', fundId: 'cw', pricingBasis: 'yield', cost: '1000000.00', valueDate: '2026-01-01' }],
      transactions: [{ id: 's1', type: 'fund_subscription', date: '2026-01-01', amount: '1000000.00', instrumentId: 'cw1' }],
    };
    const plan = statementPlan(data, 'cw', rows);
    expect(plan.prices).toHaveLength(4);
    expect(plan.prices[0].id).toBe('cw_2026-01-01');
    expect(plan.prices[0].data.balance).toBe('1000547.95');
    expect(plan.matched).toBe(1);
    expect(plan.newMovements.map((m) => [m.type, m.date, m.amount])).toEqual([['fund_subscription', '2026-01-03', '500000.00'], ['fund_redemption', '2026-01-04', '200000.00']]);
    expect(plan.account.fundId).toBe('cw');
    expect(statementPlan(data, 'cw', rows, '2026-01-02').prices).toHaveLength(2);
  });
  it('values the fund at the statement balance, then accrues at the last rate', () => {
    const book = new FundStatementBook([{ fundId: 'cw', date: '2026-01-01', balance: '1000000', rate: '0.365' }]);
    expect(book.value('cw', '2025-12-31').toFixed(2)).toBe('0.00');
    expect(book.value('cw', '2026-01-01').toFixed(2)).toBe('1000000.00');
    expect(book.value('cw', '2026-01-03').toFixed(2)).toBe('1002000.00');
  });
  it('NAV, holdings and daily income use the statement once it starts', () => {
    const { rows } = parseStatement(sheet);
    const base = {
      funds: [{ id: 'cw', name: 'Cowrywise', managerName: 'Cowrywise', pricingBasis: 'yield' }],
      instruments: [{ id: 'acct-cw', type: 'money_market_fund', fundId: 'cw', pricingBasis: 'yield', cost: '1000000.00', valueDate: '2026-01-01' }],
      transactions: [
        { id: 'in', type: 'inflow', date: '2026-01-01', amount: '2000000.00' },
        { id: 's1', type: 'fund_subscription', date: '2026-01-01', amount: '1000000.00', instrumentId: 'acct-cw' },
        { id: 's2', type: 'fund_subscription', date: '2026-01-03', amount: '500000.00', instrumentId: 'acct-cw' },
        { id: 'r1', type: 'fund_redemption', date: '2026-01-04', amount: '200000.00', instrumentId: 'acct-cw' },
      ],
    };
    const plan = statementPlan(base, 'cw', rows);
    const data = { ...base, fundPrices: plan.prices.map((p) => ({ id: p.id, ...p.data })) };
    const nav = navSeries(data, '2026-01-04');
    expect(money(nav.at(-1).holdingsValue)).toBe('1302631.57');
    expect(money(nav.at(-1).cash)).toBe('700000.00');
    const held = holdingsOn(data, '2026-01-04');
    expect(held.map((x) => x.inst.id)).toEqual(['fund:cw']);
    const b = dailyBreakdown(data, '2026-01-01', '2026-01-04');
    const inc = b.days.reduce((t, d) => t.plus(d.income), dec(0));
    expect(money(inc)).toBe(money(dec('547.95').plus('548.25').plus('822.28').plus('713.09')));
    const r = periodReport(data, '2026-01-01', '2026-01-04');
    expect(money(r.classes.find((c) => c.key === 'money_market_fund').income)).toBe(money(inc));
    expect(engineInputs(data).fundStatements).toHaveLength(4);
  });
});

describe('daily NAV make-up and holding statements', () => {
  const data = {
    transactions: [
      { id: 't0', type: 'inflow', date: '2026-03-01', amount: '1000000.00' },
      { id: 't1', type: 'invest', date: '2026-03-01', amount: '730000.00', instrumentId: 'fd' },
      { id: 't2', type: 'invest', date: '2026-03-02', amount: '200000.00', instrumentId: 'tb' },
      { id: 't3', type: 'fee_debit', date: '2026-03-03', amount: '100.00' },
      { id: 't4', type: 'mature', date: '2026-03-04', amount: '731200.00', instrumentId: 'fd' },
    ],
    instruments: [
      { id: 'fd', type: 'fixed_deposit', cost: '730000.00', rate: '0.20', valueDate: '2026-03-01', maturityDate: '2026-03-04' },
      { id: 'tb', type: 'ntb', cost: '200000.00', faceValue: '201000.00', valueDate: '2026-03-02', maturityDate: '2026-03-12' },
    ],
    fundPrices: [], funds: [],
  };
  it('every day: opening + flows + income = closing NAV', () => {
    const b = dailyBreakdown(data, '2026-03-01', '2026-03-05');
    for (const d of b.days) expect(money(d.openNav.plus(d.inflows).minus(d.withdrawals).minus(d.fees).plus(d.income))).toBe(money(d.closeNav));
    expect(money(b.totals.get('fd').income)).toBe('1200.00');
    expect(money(b.totals.get('tb').income)).toBe('300.00');
  });
  it('a holding statement has opening, money in and out, income and closing per day', () => {
    const s = positionStatement(data, 'fd', '2026-03-01', '2026-03-04');
    expect(s.rows.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
    expect(money(s.rows[0].in)).toBe('730000.00');
    expect(money(s.rows[1].income)).toBe('400.00');
    expect(money(s.rows[3].out)).toBe('731200.00');
    expect(money(s.rows[3].close)).toBe('0.00');
  });
  it('the cash statement: money in and out each day, no unexplained income', () => {
    const c = cashStatement(data, '2026-03-01', '2026-03-05');
    expect(money(c.rows[0].in)).toBe('1000000.00');
    expect(money(c.rows[0].out)).toBe('730000.00');
    expect(money(c.rows[0].close)).toBe('270000.00');
    expect(money(c.total.close)).toBe(money(dec('1000000').minus('730000').minus('200000').minus('100').plus('731200')));
    expect(c.rows.every((r) => r.income.isZero())).toBe(true);
  });
});
