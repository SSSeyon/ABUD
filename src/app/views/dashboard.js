import { BusinessCalendar, daysBetween, dec, managementFeeForPeriod, periodRates, quarterOf } from '../../engine/index.js';
import { appTerms, auctionYield, benchmarkFor } from '../close.js';
import { rankOpportunities } from '../market.js';
import { computeAlerts, limitsFrom } from '../alerts.js';
import { allocationBar, donut, flowsAs, lineChart, sankey, segmented } from '../charts.js';
import { periodFlows } from '../flows.js';
import { periodPicker, resolvePeriod, sharedPeriod } from '../period.js';
import { ASSET_CLASSES, CLASS_LABELS, expectedMaturityValue, holdingsOn, mandateOn, maturityWatch, periodReport, TYPE_LABELS } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { classTag, fmtDate, fmtNaira, fmtPct, h, table, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'mandateTerms', 'funds'];

/** A remembered display choice (per browser); falls back when storage is blocked or the value is unknown. */
function pref(key, allowed, fallback) {
  let v = null;
  try { v = localStorage.getItem(key); } catch { v = null; }
  return allowed.includes(v) ? v : fallback;
}
function savePref(key, v) { try { localStorage.setItem(key, v); } catch { /* this visit only */ } }

function stat(label, value, note, tone) {
  return h('div', { class: `stat ${tone ?? ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
}

/** Compact alert list, shared with the Alerts screen. */
export function alertList(alerts, { limit } = {}) {
  const shown = limit ? alerts.slice(0, limit) : alerts;
  return h('ul', { class: 'alerts' }, shown.map((a) =>
    h('li', { class: `alert ${a.level}` },
      h('span', { class: `alert-level ${a.level}` }, a.level === 'high' ? 'High' : a.level === 'medium' ? 'Medium' : 'Low'),
      h('div', null, h('a', { class: 'alert-title', href: `#/${a.route}` }, a.title), h('div', { class: 'muted small' }, a.detail)))));
}

export function dashboardView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Dashboard'), h('p', { class: 'subtitle' }, `Access Holdings Plc unclaimed dividend portfolio · ${fmtDate(today)}`)),
    inception ? periodPicker(sharedPeriod, inception, today, rerender) : null);
  if (!inception) return h('div', null, head, h('div', { class: 'card' }, h('p', null, 'No transactions yet. Record the opening inflow under Transactions.')));

  const period = resolvePeriod(sharedPeriod, inception, today);
  let r;
  try {
    r = periodReport(data, period.start, period.end);
  } catch (err) {
    return h('div', null, head, h('div', { class: 'card bad' }, h('h2', null, 'NAV could not be calculated'), h('p', null, err.message)));
  }
  const endRow = r.rows.at(-1);
  const isToday = period.end === today;
  const at = isToday ? 'today' : `at ${fmtDate(period.end)}`;
  const terms = appTerms(mandateOn(data, period.end));
  let fee = null;
  try {
    fee = terms ? managementFeeForPeriod(r.allRows, period.start, period.end, terms.mgmtFeeRate, new BusinessCalendar(), terms.feeDayCount) : null;
  } catch { fee = null; }
  const tone = (x) => (x.isNegative() ? 'down' : 'up');
  // Hurdle for the same days, when the period sits inside one quarter (that quarter's benchmark).
  let hurdleNote = '';
  const pq = quarterOf(period.start);
  if (period.end <= pq.end && terms) {
    const bench = benchmarkFor(data, pq.label);
    if (bench) {
      const { hurdle } = periodRates(auctionYield(bench), terms.hurdleSpread, r.days);
      hurdleNote = ` · hurdle ${fmtPct(hurdle, 2)} (${r.twr.gt(hurdle) ? 'beaten' : 'not yet met'})`;
    }
  }
  const alerts = computeAlerts(data, today, limitsFrom(data));
  const highs = alerts.filter((a) => a.level === 'high').length;

  const parts = [head];
  parts.push(
    h('div', { class: 'stats' },
      stat(`NAV ${at}`, fmtNaira(r.closingNav), `Gross of fees · opening ${fmtNaira(r.openingNav)}`),
      stat(`Cash ${at}`, fmtNaira(endRow?.cash ?? 0)),
      stat(`Holdings ${at}`, fmtNaira(endRow?.holdingsValue ?? 0)),
      stat(`Return: ${period.key === 'custom' ? 'period' : period.label.replace(/ \(.*\)$/, '')}`, fmtPct(r.twr, 2), `Time-weighted, gross of fees${r.annualised ? ` · ${fmtPct(r.annualised, 2)} p.a.` : ''}${hurdleNote}`, tone(r.twr)),
      stat('Investment income', fmtNaira(r.income), `${r.days} days`, tone(r.income)),
      stat('Management fee accrued', fee ? fmtNaira(fee.posted) : '—', terms ? `${fmtPct(terms.mgmtFeeRate)} p.a.` : 'Set mandate terms in Settings')),
  );

  // Alerts and the top reinvestment options (always as of today, whatever the period).
  const opp = rankOpportunities(data, today, limitsFrom(data));
  const top = opp.ranked.slice(0, 3);
  parts.push(h('div', { class: 'grid-2' },
    h('section', { class: `card alerts-card ${highs ? 'has-high' : ''}` },
      h('div', { class: 'card-head' }, h('h2', null, `Alerts today${alerts.length ? ` (${alerts.length})` : ''}`), alerts.length > 5 ? h('a', { href: '#/alerts' }, 'See all') : null),
      alerts.length ? alertList(alerts, { limit: 5 }) : h('p', { class: 'muted' }, 'Nothing needs attention.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Top options for cash'), h('a', { href: '#/market' }, 'Market')),
      h('p', { class: 'muted small' }, `Cash to deploy ${fmtNaira(opp.cashToDeploy)}${opp.hurdle ? ` · hurdle ${fmtPct(opp.hurdle.hurdle, 2)}` : ''}`),
      top.length
        ? h('ol', { class: 'opps' }, top.map((o) => h('li', null,
            h('div', null, h('strong', null, o.label), h('div', { class: 'muted small' }, `${o.tenorDays} days · ${o.source}`)),
            h('div', { class: 'num' }, h('strong', null, fmtPct(o.yield, 2)), h('div', { class: 'muted small' }, o.pickup ? `${o.pickup.gte(0) ? '+' : '−'}${o.pickup.abs().times(10000).toFixed(0)} bps vs hurdle` : '')))))
        : h('p', { class: 'muted' }, 'No options yet. They appear once auction results, confirmed CP quotations or recent bank deals are in.'))));

  const held = holdingsOn(data, period.end);
  const alloc = [
    ...ASSET_CLASSES.filter((c) => c.key !== 'cash').map((c) => ({ ...c, value: held.filter((x) => x.inst?.type === c.key).reduce((t, x) => t.plus(x.value), dec(0)) })),
    { key: 'cash', label: CLASS_LABELS.cash, value: endRow?.cash ?? dec(0) },
  ];
  const allocKind = pref('abud-alloc-chart', ['bar', 'donut'], 'bar');
  parts.push(
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h2', null, `Net asset value: ${fmtDate(period.start)} – ${fmtDate(period.end)}`), lineChart(r.rows.map((x) => ({ date: x.date, value: x.nav })), { label: 'NAV' })),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, `Allocation ${at}`),
          segmented([['bar', 'Bar'], ['donut', 'Donut']], allocKind, (v) => { savePref('abud-alloc-chart', v); rerender(); })),
        allocKind === 'donut'
          ? donut(alloc.map((c) => ({ label: c.label, value: c.value, color: `var(--class-${c.key})` })), { label: 'Allocation', centre: 'NAV' })
          : allocationBar(alloc))),
  );

  // Money flows for the period, as a Sankey, bars or donuts.
  const flowKind = pref('abud-flow-chart', ['sankey', 'bars', 'donut'], 'sankey');
  try {
    const f = periodFlows(r);
    parts.push(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, `Money flows: ${fmtDate(period.start)} – ${fmtDate(period.end)}`),
        segmented([['sankey', 'Sankey'], ['bars', 'Bar'], ['donut', 'Donut']], flowKind, (v) => { savePref('abud-flow-chart', v); rerender(); })),
      flowKind === 'sankey' ? sankey(f.left, f.right, { middle: 'Portfolio', label: 'Money flows for the period' }) : flowsAs(flowKind, f.left, f.right),
      h('p', { class: 'muted small' }, 'Opening NAV + inflows + income = withdrawals + fees + closing NAV. ', h('a', { href: '#/navdaily' }, 'Daily NAV make-up'))));
  } catch (err) { console.error(err); }

  // Maturities ahead (always from today).
  const { due, overdue } = maturityWatch(data, today, 14);
  const matRow = (i, late) =>
    h('tr', { class: late ? 'bad' : null },
      h('td', null, fmtDate(i.maturityDate)),
      h('td', null, late ? `${-daysBetween(today, i.maturityDate)} days overdue` : `${daysBetween(today, i.maturityDate)} days`),
      h('td', null, classTag(i.type, TYPE_LABELS[i.type])),
      h('td', null, i.counterpartyName ?? ''),
      h('td', { class: 'num' }, fmtNaira(expectedMaturityValue(i))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Maturities: next 14 days'), h('a', { href: '#/ladder' }, 'Maturity ladder')),
    table(['Maturity', 'When', 'Instrument', 'Counterparty', { label: 'Expected cash', num: true }],
      [...overdue.map((i) => matRow(i, true)), ...due.map((i) => matRow(i, false))], 'No maturities in the next 14 days.')));
  return h('div', null, parts);
}
