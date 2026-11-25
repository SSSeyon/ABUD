// Maturity ladder: what comes back when, bucketed from today, with the liquidity buffer marked.
import { daysBetween, dec, ZERO } from '../../engine/index.js';
import { limitsFrom } from '../alerts.js';
import { closedInstrumentIds, expectedMaturityValue, holdingsOn, navSeries, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, fmtDate, fmtNaira, fmtPct, h, table, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];
const BUCKETS = [
  { label: 'Overdue', max: -1 },
  { label: '0–7 days', max: 7 },
  { label: '8–14 days', max: 14 },
  { label: '15–30 days', max: 30 },
  { label: '31–60 days', max: 60 },
  { label: '61–90 days', max: 90 },
  { label: '91–180 days', max: 180 },
  { label: '181–365 days', max: 365 },
  { label: 'Over 1 year', max: Infinity },
];

export function ladderView() {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const limits = limitsFrom(data);
  const last = navSeries(data, today).at(-1);
  const nav = last?.nav ?? ZERO;
  const cash = last?.cash ?? ZERO;
  const closed = closedInstrumentIds(data.transactions);
  const funds = holdingsOn(data, today).filter((x) => x.inst.type === 'money_market_fund').reduce((t, x) => t.plus(x.value), ZERO);

  const open = (data.instruments ?? []).filter((i) => i.maturityDate && !closed.has(i.id)).map((i) => ({ inst: i, days: daysBetween(today, i.maturityDate), amount: dec(expectedMaturityValue(i)) }));
  let prevMax = -Infinity;
  const buckets = BUCKETS.map((b) => {
    const items = open.filter((x) => x.days > prevMax && x.days <= b.max).sort((a, z) => a.days - z.days);
    prevMax = b.max;
    return { ...b, items, total: items.reduce((t, x) => t.plus(x.amount), ZERO) };
  });
  const rows = [{ label: 'Cash now', total: cash, items: [], now: true }, { label: 'Funds (on demand)', total: funds, items: [], now: true }, ...buckets].filter((b) => b.total.gt(0) || !b.now);
  const biggest = rows.reduce((m, b) => (b.total.gt(m) ? b.total : m), dec(1));
  const liqDays = Number(limits.liquidityDays);
  let cumulative = ZERO;
  const grand = rows.reduce((t, b) => t.plus(b.total), ZERO);

  const ladder = h('div', { class: 'ladder' }, rows.map((b) => {
    cumulative = cumulative.plus(b.total);
    const inBuffer = b.now || b.max <= liqDays;
    return h('div', { class: `ladder-row ${inBuffer ? 'buffer' : ''} ${b.label === 'Overdue' && b.total.gt(0) ? 'overdue' : ''}` },
      h('div', { class: 'ladder-label' }, b.label, b.items.length ? h('span', { class: 'muted small' }, ` · ${b.items.length}`) : null),
      h('div', { class: 'ladder-track' }, h('div', { class: 'ladder-bar', style: `width:${Math.max(0.4, Number(b.total.div(biggest).times(100)))}%`, title: `${b.label}: ${fmtNaira(b.total)}` })),
      h('div', { class: 'ladder-value' }, fmtNaira(b.total)),
      h('div', { class: 'ladder-cum muted' }, grand.gt(0) ? fmtPct(cumulative.div(grand), 1) : ''));
  }));

  const buffer = rows.filter((b) => b.now || b.max <= liqDays).reduce((t, b) => t.plus(b.total), ZERO);
  const bufferShare = nav.gt(0) ? buffer.div(nav) : ZERO;
  const ok = bufferShare.gte(limits.liquidityShare);

  const detail = buckets.filter((b) => b.items.length).flatMap((b) => [
    h('tr', { class: 'group' }, h('td', { colspan: 5 }, b.label), h('td', { class: 'num' }, fmtNaira(b.total))),
    ...b.items.map((x) => h('tr', { class: x.days < 0 ? 'bad' : null },
      h('td', null, classTag(x.inst.type, TYPE_LABELS[x.inst.type])),
      h('td', null, x.inst.counterpartyName ?? ''),
      h('td', null, fmtDate(x.inst.maturityDate)),
      h('td', { class: 'num' }, x.days < 0 ? `${-x.days} overdue` : String(x.days)),
      h('td', { class: 'num' }, fmtNaira(x.inst.cost)),
      h('td', { class: 'num' }, fmtNaira(x.amount)))),
  ]);

  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Maturity ladder'), h('p', { class: 'subtitle' }, `What comes back when, from ${fmtDate(today)}. Bars show the amount due at maturity; the right column is the running share of everything on the ladder.`))),
    h('div', { class: 'stats' },
      h('div', { class: `stat ${ok ? 'up' : 'down'}` }, h('div', { class: 'stat-label' }, `Liquid within ${liqDays} days`), h('div', { class: 'stat-value' }, fmtPct(bufferShare, 1)), h('div', { class: 'stat-note' }, `${fmtNaira(buffer)} · minimum ${fmtPct(limits.liquidityShare, 0)} of NAV`)),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Due in 14 days'), h('div', { class: 'stat-value' }, fmtNaira(buckets.slice(0, 3).reduce((t, b) => t.plus(b.total), ZERO)))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'NAV today'), h('div', { class: 'stat-value' }, fmtNaira(nav)))),
    h('section', { class: 'card' }, h('h2', null, 'Ladder'), ladder, h('p', { class: 'muted small' }, `Shaded rows count toward the liquidity buffer (cash, funds and maturities within ${liqDays} days).`)),
    h('section', { class: 'card' }, h('h2', null, 'Deals by bucket'),
      table(['Instrument', 'Counterparty', 'Maturity', { label: 'Days', num: true }, { label: 'Cost', num: true }, { label: 'At maturity', num: true }], detail, 'Nothing maturing.')),
  );
}

