import { describe, expect, it } from '../harness.js';
import { HISTORY_FILE, historyData, historyDocs, importStatus } from '../../src/app/history.js';
import { navSeries } from '../../src/app/portfolio.js';

// The imported history (inception to 30 Sep 2026), run through the real engine.
const file = await (await fetch(`../${HISTORY_FILE}`)).json();
const data = historyData(file);
const rows = navSeries(data, file.asOf);
const byDate = new Map(rows.map((r) => [r.date, r]));

// Same shape checks as firestore.rules, so the import cannot be rejected part way.
const isDate = (v) => typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);
const isPositiveMoney = (v) => typeof v === 'string' && /^[0-9]+([.][0-9]{1,2})?$/.test(v) && !/^0+([.]0+)?$/.test(v);
const isRate = (v) => typeof v === 'string' && /^[0-9]+([.][0-9]+)?$/.test(v);

describe('history import (inception to 30 Sep 2026)', () => {
  it('cash at 30 Sep 2026 equals the bank ledger to the kobo', () => {
    expect(rows.at(-1).date).toBe('2026-09-30');
    expect(rows.at(-1).cash.toFixed(2)).toBe(file.check.ledgerCash);
  });

  it('NAV at 30 Sep 2026 matches the generator (within 1 naira)', () => {
    const diff = rows.at(-1).nav.minus(file.check.nav).abs();
    expect(diff.lte(1)).toBe(true);
  });

  // Workbook gap: until 30 Jun 2024 the workbook carries about 5.6m at Primera that it then writes off as an
  // "unreconciled difference" (1.7% of NAV at Jun 2022); elsewhere day-count conventions, well under 0.5%.
  it('quarter-end NAVs match the generator (within 1 naira) and the workbook (within 2%)', () => {
    for (const q of file.check.quarterEnds) {
      const nav = byDate.get(q.date).nav;
      expect([q.date, nav.minus(q.nav).abs().lte(1)]).toEqual([q.date, true]);
      expect([q.date, nav.minus(q.workbookNav).abs().div(q.workbookNav).lte('0.02')]).toEqual([q.date, true]);
    }
  });

  it('cash never goes negative', () => {
    const low = rows.filter((r) => r.cash.lt(0)).map((r) => r.date);
    expect(low).toEqual([]);
  });

  it('open holdings at 30 Sep 2026: Page 3.05, Coronation call 13, Pay Aza and TrustBanc CPs', () => {
    const closed = new Set(data.transactions.filter((t) => t.type === 'mature' || t.type === 'fund_redemption').map((t) => t.instrumentId));
    expect(data.instruments.filter((i) => !closed.has(i.id)).map((i) => i.id).sort()).toEqual(['hist-COR-13', 'hist-CP-5', 'hist-CP-6', 'hist-PAG-3.05b']);
  });

  it('every document passes the Firestore rules shape checks', () => {
    const bad = [];
    for (const d of historyDocs(file)) {
      const x = d.data;
      const ok =
        d.coll === 'transactions' ? isDate(x.date) && isPositiveMoney(x.amount) && (!['invest', 'mature', 'fund_subscription', 'fund_redemption'].includes(x.type) || typeof x.instrumentId === 'string')
        : d.coll === 'instruments' ? isPositiveMoney(x.cost) && isDate(x.valueDate) && (x.type === 'money_market_fund' ? typeof x.fundId === 'string' : isDate(x.maturityDate) && x.maturityDate > x.valueDate)
          && (!['ntb', 'commercial_paper'].includes(x.type) || isPositiveMoney(x.faceValue)) && (x.type !== 'fixed_deposit' || isRate(x.rate))
        : d.coll === 'fundPrices' ? isDate(x.date) && isRate(x.priceOrYield) && typeof x.fundId === 'string'
        : typeof x.name === 'string';
      if (!ok) bad.push(`${d.coll}/${d.id}`);
    }
    expect(bad).toEqual([]);
  });

  it('every deal transaction points at an imported instrument', () => {
    const ids = new Set(data.instruments.map((i) => i.id));
    expect(data.transactions.filter((t) => t.instrumentId && !ids.has(t.instrumentId)).map((t) => t.id)).toEqual([]);
  });

  it('import is offered on an empty database or a part-finished import, not over other data', () => {
    expect(importStatus({ transactions: [], instruments: [] }, file).canImport).toBe(true);
    expect(importStatus({ transactions: data.transactions.slice(0, 10), instruments: [] }, file)).toEqual({ canImport: true, resuming: true });
    expect(importStatus(data, file).canImport).toBe(false);
    expect(importStatus({ transactions: [{ id: 'abc' }], instruments: [] }, file).canImport).toBe(false);
  });
});
