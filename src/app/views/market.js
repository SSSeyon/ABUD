// Market: ranked reinvestment options, notable events, NTB/OMO auctions, MPC decisions, CP quotations and the
// status of the scheduled feeds. Every feed has a manual form for when the source page changes.
import { dec } from '../../engine/index.js';
import { deleteDoc, saveDoc } from '../actions.js';
import { limitsFrom } from '../alerts.js';
import { auctionYield } from '../close.js';
import { feedHealth, latestByTenor, marketEvents, mpcHistory, rankOpportunities } from '../market.js';
import { loadedAll, state } from '../store.js';
import { confirmDialog, fmtDate, fmtNaira, fmtPct, h, openForm, parseDecimal, parseMoney, parsePercent, runAction, table, todayISO } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds', 'mandateTerms'];
const bps = (x) => (x == null ? '—' : `${x.gt(0) ? '+' : x.lt(0) ? '−' : ''}${x.abs().toFixed(0)} bps`);
const pctOrDash = (x, dp = 2) => (x == null ? '—' : fmtPct(x, dp));

export function marketView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const limits = limitsFrom(data);
  const missing = ['auctions', 'mpc', 'cpQuotes', 'feedStatus'].filter((n) => state.errors[n]);
  const opp = rankOpportunities(data, today, limits);
  const mpc = mpcHistory(data);
  const cpi = (data.feedStatus ?? []).find((d) => d.id === 'cbn_cpi');

  const kpi = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note' }, note) : null);
  const parts = [
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Market'), h('p', { class: 'subtitle' }, 'Public market data and ranked reinvestment options. Nothing from the portfolio leaves the app.'))),
  ];
  if (missing.length) parts.push(h('div', { class: 'card warn' }, h('p', null, 'Market data needs the updated Firestore rules (publish firestore.rules). Until then nothing here can load or be saved.')));
  parts.push(h('div', { class: 'stats' },
    kpi('Cash to deploy', fmtNaira(opp.cashToDeploy), `Cash above the ${fmtNaira(limits.idleCash)} idle limit`),
    kpi('Hurdle now', opp.hurdle ? fmtPct(opp.hurdle.hurdle, 2) : '—', opp.hurdle ? `91-day true yield ${fmtPct(opp.hurdle.trueYield, 2)} (${fmtDate(opp.hurdle.auction.date)}) + ${fmtPct(opp.hurdle.spread, 2)}` : 'No 91-day auction stored'),
    kpi('Portfolio running yield', pctOrDash(opp.running), 'Value-weighted, holdings today'),
    kpi('MPR', mpc[0] ? fmtPct(mpc[0].mpr, 2) : '—', mpc[0] ? `MPC ${fmtDate(mpc[0].date)}${mpc[0].changeBps ? ` · ${bps(mpc[0].changeBps)}` : ''}` : 'No decision stored'),
    kpi('Headline inflation', cpi?.value ? fmtPct(cpi.value, 2) : '—', cpi?.lastSuccessAt ? `CBN, as of ${fmtDate(cpi.lastSuccessAt.slice(0, 10))}` : 'Year on year')));

  // Opportunities.
  const oppRows = opp.ranked.map((o, i) => h('tr', null,
    h('td', { class: 'num' }, String(i + 1)),
    h('td', { style: 'min-width:200px' }, o.label, h('div', { class: 'muted small' }, o.source)),
    h('td', { class: 'num' }, String(o.tenorDays)),
    h('td', { class: 'num' }, fmtPct(o.yield, 2)),
    h('td', { class: `num ${o.pickup?.isNegative() ? 'neg' : ''}` }, o.pickup == null ? '—' : bps(o.pickup.times(10000))),
    h('td', { class: `num ${o.overRunning?.isNegative() ? 'neg' : ''}` }, o.overRunning == null ? '—' : bps(o.overRunning.times(10000))),
    h('td', { class: 'num' }, fmtNaira(o.amount), o.notes.length ? h('div', { class: 'muted small' }, o.notes.join('; ')) : null),
    h('td', { class: 'num' }, o.headroom == null ? 'FGN' : fmtNaira(o.headroom))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Reinvestment options')),
    table(['#', 'Option', { label: 'Tenor (days)', num: true }, { label: 'Yield', num: true }, { label: 'Over hurdle', num: true }, { label: 'Over portfolio', num: true }, { label: 'Suggested amount', num: true }, { label: 'Limit headroom', num: true }], oppRows,
      'No options yet: they come from recent auctions, confirmed CP quotations and the last 90 days of bank deals.'),
    opp.rejected.length ? h('details', null, h('summary', { class: 'muted small' }, `${opp.rejected.length} excluded by limits`),
      h('ul', { class: 'small' }, opp.rejected.map((o) => h('li', null, `${o.label} (${fmtPct(o.yield, 2)}, ${o.tenorDays} days): ${o.reason}`)))) : null,
    h('p', { class: 'muted small' }, `Ranked by yield over the hurdle, then over the portfolio's running yield. Amounts keep within the ${fmtPct(limits.concentrationShare, 0)} counterparty limit (FGN paper exempt) and the ${fmtPct(limits.liquidityShare, 0)} liquidity buffer for anything over ${limits.liquidityDays} days. Bank deposit rates are indicative, from your last deal with each bank. Yields are simple annual (Actual/365); bills and CPs as true yield.`)));

  // Events.
  const events = marketEvents(data, today);
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Notable events (last 14 days)'),
    events.length ? h('ul', { class: 'alerts' }, events.map((e) => h('li', { class: 'alert low' }, h('span', { class: 'muted small' }, fmtDate(e.date)), h('div', null, h('div', { class: 'alert-title' }, e.title), h('div', { class: 'muted small' }, e.detail)))))
      : h('p', { class: 'muted' }, 'No NTB moves over 25 bps, new CP quotations or MPR changes.')));

  // Auctions.
  const auctionCard = (kind, title) => {
    const rows = latestByTenor(data, kind).map((l) => h('tr', null,
      h('td', null, fmtDate(l.auction.date)), h('td', { class: 'num' }, String(l.auction.tenorDays)),
      h('td', { class: 'num' }, fmtPct(l.auction.stopRate, 2)), h('td', { class: 'num' }, fmtPct(l.trueYield, 2)),
      h('td', { class: 'num' }, bps(l.changeBps)),
      h('td', { class: 'num' }, l.auction.offeredM ? `₦${Number(l.auction.offeredM).toLocaleString('en-US', { maximumFractionDigits: 0 })}m` : '—'),
      h('td', { class: 'num' }, l.auction.subscribedM ? `₦${Number(l.auction.subscribedM).toLocaleString('en-US', { maximumFractionDigits: 0 })}m` : '—'),
      h('td', null, l.auction.source === 'manual' ? 'Entered' : 'CBN', ' ', h('button', { class: 'link', onclick: () => auctionForm(l.auction) }, 'Edit'))));
    const count = (data.auctions ?? []).filter((a) => a.kind === kind).length;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, title), h('button', { onclick: () => auctionForm({ kind }) }, 'Add result')),
      table(['Latest auction', { label: 'Tenor', num: true }, { label: 'Stop rate', num: true }, { label: 'True yield', num: true }, { label: 'Change', num: true }, { label: 'Offered', num: true }, { label: 'Subscribed', num: true }, 'Source'], rows, 'No auction results stored.'),
      h('p', { class: 'muted small' }, `${count} results stored. Change is the stop rate against the previous auction ${kind === 'omo' ? 'in the same band (up to 3, 6 or 12 months)' : 'at the same tenor'}.`));
  };
  parts.push(h('div', { class: 'grid-2' }, auctionCard('ntb', 'NTB primary auctions'), auctionCard('omo', 'OMO auctions')));

  // MPC.
  const mpcRows = mpc.slice(0, 8).map((m) => h('tr', null,
    h('td', null, fmtDate(m.date)), h('td', { class: 'num' }, fmtPct(m.mpr, 2)), h('td', { class: 'num' }, bps(m.changeBps)), h('td', null, m.corridor ?? ''),
    h('td', null, m.sourceUrl ? h('a', { href: m.sourceUrl, target: '_blank', rel: 'noopener' }, 'Communiqué') : '', ' ', h('button', { class: 'link', onclick: () => mpcForm(m) }, 'Edit'))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'MPC decisions'), h('button', { onclick: () => mpcForm() }, 'Add decision')),
    table(['Meeting', { label: 'MPR', num: true }, { label: 'Change', num: true }, 'Corridor', ''], mpcRows, 'No MPC decisions stored.')));

  // CP quotations.
  const quotes = [...(data.cpQuotes ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 15);
  const cpRows = quotes.map((q) => h('tr', null,
    h('td', null, fmtDate(q.date)),
    h('td', null, q.issuer || '—', q.title ? h('div', { class: 'muted small' }, q.sourceUrl ? h('a', { href: q.sourceUrl, target: '_blank', rel: 'noopener' }, q.title) : q.title) : null),
    h('td', { class: 'num' }, q.size ? fmtNaira(q.size) : '—'),
    h('td', { class: 'num' }, q.tenorDays ?? '—'),
    h('td', { class: 'num' }, q.yield ? fmtPct(q.yield, 2) : '—'),
    h('td', null, q.rating ?? '—'),
    h('td', null, q.confirmed ? h('span', { class: 'badge ok' }, 'Confirmed') : h('span', { class: 'badge warn' }, 'Needs details')),
    h('td', null, h('button', { class: 'link', onclick: () => cpForm(q) }, q.confirmed ? 'Edit' : 'Confirm'), ' ',
      h('button', { class: 'link', onclick: (e) => confirmDialog({ title: 'Delete this quotation?', message: q.title || q.issuer, confirmLabel: 'Delete', danger: true }).then((ok) => ok && runAction(e.target, () => deleteDoc('cpQuotes', q.id, `Deleted CP quotation ${q.issuer || q.title}`), 'Deleted')) }, 'Delete'))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Commercial paper quotations (FMDQ)'), h('button', { onclick: () => cpForm() }, 'Add quotation')),
    table(['Date', 'Issuer', { label: 'Size', num: true }, { label: 'Tenor', num: true }, { label: 'Yield', num: true }, 'Rating', 'Status', ''], cpRows, 'No CP quotations stored.'),
    h('p', { class: 'muted small' }, 'The feed picks up FMDQ quotation notices; confirm the yield, tenor and rating from the issue documents before a CP counts as an option.')));

  // Feeds.
  const feedRows = feedHealth(data, today).map((f) => h('tr', null,
    h('td', null, f.label),
    h('td', null, h('span', { class: `badge ${f.status === 'ok' ? 'ok' : f.status === 'never' ? '' : 'warn'}` }, { ok: 'Up to date', stale: 'Stale', failing: 'Failing', never: 'Not run yet' }[f.status])),
    h('td', null, f.doc?.lastSuccessAt ? fmtDate(f.doc.lastSuccessAt.slice(0, 10)) : '—'),
    h('td', { class: 'num' }, f.doc?.added ?? '—'),
    h('td', { class: 'small' }, f.status === 'failing' ? f.doc?.lastError ?? '' : '')));
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Feed status'),
    table(['Feed', 'Status', 'Last success', { label: 'Added last run', num: true }, 'Last error'], feedRows),
    h('p', { class: 'muted small' }, 'A GitHub Actions job ("Market feeds", tools/feeds/fetch-feeds.ps1) reads the CBN and FMDQ sites twice each weekday and adds anything new. It can also be run by hand from the repository\'s Actions tab. Bank deposit rates are not captured.')));
  return h('div', null, parts);
}

// ---------- forms ----------

function auctionForm(a = {}) {
  const editing = Boolean(a.id);
  return openForm({
    title: editing ? 'Edit auction result' : 'Add auction result',
    intro: 'Rates as published by the CBN. The stop rate is a discount rate; the true yield is worked out from it.',
    fields: [
      { name: 'kind', label: 'Auction', type: 'select', required: true, value: a.kind ?? 'ntb', options: [{ value: 'ntb', label: 'NTB primary auction' }, { value: 'omo', label: 'OMO auction' }] },
      { name: 'date', label: 'Auction date', type: 'date', required: true, value: a.date ?? todayISO() },
      { name: 'tenorDays', label: 'Tenor (days)', type: 'number', required: true, value: a.tenorDays ?? '91' },
      { name: 'stopRate', label: 'Stop rate (%)', type: 'percent', required: true, value: a.stopRate ? dec(a.stopRate).times(100).toFixed() : '' },
      { name: 'offeredM', label: 'Offered (₦ millions)', type: 'decimal', value: a.offeredM ?? '' },
      { name: 'subscribedM', label: 'Subscribed (₦ millions)', type: 'decimal', value: a.subscribedM ?? '' },
      { name: 'allottedM', label: 'Allotted (₦ millions)', type: 'decimal', value: a.allottedM ?? '' },
      { name: 'sourceUrl', label: 'Source link', type: 'text', value: a.sourceUrl ?? '' },
    ],
    onSubmit: async (v) => {
      if (!/^\d+$/.test(v.tenorDays)) throw new Error('Tenor: enter whole days');
      const doc = {
        ...a, kind: v.kind, date: v.date, tenorDays: v.tenorDays, stopRate: parsePercent(v.stopRate, 'Stop rate'),
        offeredM: v.offeredM ? parseDecimal(v.offeredM, 'Offered') : '', subscribedM: v.subscribedM ? parseDecimal(v.subscribedM, 'Subscribed') : '',
        allottedM: v.allottedM ? parseDecimal(v.allottedM, 'Allotted') : '', sourceUrl: v.sourceUrl, source: a.source ?? 'manual',
      };
      delete doc.id;
      delete doc.trueYield;
      auctionYield(doc); // throws if the rate is impossible for the tenor
      const id = `${v.kind}-${v.date}-${v.tenorDays}`;
      if (editing && id !== a.id) await deleteDoc('auctions', a.id, `Replaced auction result ${a.id}`);
      await saveDoc('auctions', id, doc);
    },
  });
}

function mpcForm(m = {}) {
  return openForm({
    title: m.id ? 'Edit MPC decision' : 'Add MPC decision',
    fields: [
      { name: 'date', label: 'Decision date (last day of the meeting)', type: 'date', required: true, value: m.date ?? todayISO() },
      { name: 'mpr', label: 'MPR (%)', type: 'percent', required: true, value: m.mpr ? dec(m.mpr).times(100).toFixed() : '' },
      { name: 'corridor', label: 'Corridor', type: 'text', value: m.corridor ?? '', help: 'For example +50/−450 bps around the MPR' },
      { name: 'sourceUrl', label: 'Communiqué link', type: 'text', value: m.sourceUrl ?? '' },
    ],
    onSubmit: async (v) => {
      const doc = { ...m, date: v.date, mpr: parsePercent(v.mpr, 'MPR'), corridor: v.corridor, sourceUrl: v.sourceUrl, source: m.source ?? 'manual' };
      delete doc.id;
      delete doc.changeBps;
      if (m.id && m.id !== v.date) await deleteDoc('mpc', m.id, `Replaced MPC decision ${m.id}`);
      await saveDoc('mpc', v.date, doc);
    },
  });
}

function cpForm(q = {}) {
  return openForm({
    title: q.id ? 'Confirm CP quotation' : 'Add CP quotation',
    intro: 'Confirm the terms from the issue documents. A CP counts as an option once yield, tenor and rating are in and it is marked confirmed.',
    fields: [
      { name: 'date', label: 'Quotation date', type: 'date', required: true, value: q.date ?? todayISO() },
      { name: 'issuer', label: 'Issuer', type: 'text', required: true, value: q.issuer ?? '' },
      { name: 'size', label: 'Size (₦)', type: 'money', value: q.size ?? '' },
      { name: 'tenorDays', label: 'Tenor (days)', type: 'number', value: q.tenorDays ?? '' },
      { name: 'yield', label: 'Yield (%)', type: 'percent', value: q.yield ? dec(q.yield).times(100).toFixed() : '', help: 'True yield, simple annual (Actual/365)' },
      { name: 'rating', label: 'Rating', type: 'text', value: q.rating ?? '' },
      { name: 'sourceUrl', label: 'Source link', type: 'text', value: q.sourceUrl ?? '' },
      { name: 'confirmed', label: 'Terms confirmed', type: 'select', value: q.confirmed ? 'yes' : 'no', options: [{ value: 'no', label: 'Not yet' }, { value: 'yes', label: 'Yes: yield, tenor and rating checked' }] },
    ],
    onSubmit: async (v) => {
      const confirmed = v.confirmed === 'yes';
      if (confirmed && (!v.yield || !v.tenorDays || !v.rating)) throw new Error('Enter yield, tenor and rating before marking it confirmed.');
      if (v.tenorDays && !/^\d+$/.test(v.tenorDays)) throw new Error('Tenor: enter whole days');
      const doc = { ...q, date: v.date, issuer: v.issuer, size: v.size ? parseMoney(v.size, 'Size') : '', tenorDays: v.tenorDays, yield: v.yield ? parsePercent(v.yield, 'Yield') : '', rating: v.rating, sourceUrl: v.sourceUrl, confirmed, source: q.source ?? 'manual' };
      delete doc.id;
      await saveDoc('cpQuotes', q.id ?? null, doc);
    },
  });
}
