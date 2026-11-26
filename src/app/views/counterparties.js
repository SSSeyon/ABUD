// Counterparty register: banks, CP issuers, fund managers and custodians, each with its rating history.
// Shows today's exposure to each name against the concentration and minimum-rating limits.
import { dec } from '../../engine/index.js';
import { limitsFrom } from '../alerts.js';
import { deleteDoc, saveDoc, saveDocs } from '../actions.js';
import {
  AGENCIES, counterpartyName, custodianExposure, exposures, findCounterparty, KINDS, normRating, ratingHistory, ratingOn, RATING_SCALE,
} from '../counterparties.js';
import { closedInstrumentIds } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { confirmDialog, excelButton, fmtDate, fmtNaira, fmtPct, h, openForm, runAction, table, toast, todayISO, xDate, xMoney, xPct } from '../ui.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds'];
const sel = { open: '', kind: '' };
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

export function counterpartiesView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const data = state.data;
  const today = todayISO();
  const limits = limitsFrom(data, today);
  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Counterparties'), h('p', { class: 'subtitle' }, `Banks, issuers, fund managers and custodians, with ratings. Minimum rating for new deals: ${limits.minRating}.`)),
    h('button', { class: 'primary', onclick: () => cpForm() }, 'Add counterparty'));
  const parts = [head];
  if (state.errors.counterparties || state.errors.ratings) parts.push(h('div', { class: 'card warn' }, h('p', null, 'The register needs the updated Firestore rules (publish firestore.rules) before it can be saved.')));

  let ex = [];
  try { ex = exposures(data, today, limits.minRating); } catch (err) { console.error(err); }
  const exByCp = new Map(ex.filter((e) => e.cp).map((e) => [e.cp.id, e]));
  const register = [...(data.counterparties ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  // Held names not yet in the register.
  const missing = ex.filter((e) => !e.fgn && !e.cp);
  if (missing.length) {
    parts.push(h('div', { class: 'card warn' },
      h('p', null, `${missing.length} name${missing.length === 1 ? '' : 's'} held today ${missing.length === 1 ? 'is' : 'are'} not in the register: ${missing.map((m) => m.name).join(', ')}.`),
      h('button', { onclick: (e) => runAction(e.currentTarget, () => saveDocs('counterparties', missing.map((m) => ({ name: m.name, kind: guessKind(data, m.name) })), `Added ${missing.length} counterparties from holdings`), 'Added to the register') }, 'Add them to the register')));
  }

  // Exposure today.
  const conc = dec(limits.concentrationShare);
  const exRows = ex.map((e) => h('tr', { class: e.below ? 'bad' : null },
    h('td', null, e.name, e.fgn ? h('div', { class: 'muted small' }, 'FGN: exempt from rating and concentration limits') : null),
    h('td', null, e.fgn ? '—' : e.rating ? `${e.rating.rating} (${e.rating.agency})` : h('span', { class: 'badge warn' }, 'Unrated')),
    h('td', { class: 'num' }, String(e.count)),
    h('td', { class: 'num' }, fmtNaira(e.value)),
    h('td', { class: 'num' }, fmtPct(e.share, 1)),
    h('td', null, e.below ? h('span', { class: 'badge bad' }, `Below ${limits.minRating}`) : !e.fgn && e.share.gt(conc) ? h('span', { class: 'badge bad' }, 'Over concentration limit') : h('span', { class: 'badge ok' }, 'Within limits'))));
  parts.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, `Exposure at ${fmtDate(today)}`),
      excelButton('Download Excel', () => `ABUD counterparties ${today}.xlsx`, () => workbook(data, ex, register, today))),
    table(['Counterparty', 'Rating in force', { label: 'Holdings', num: true }, { label: 'Value', num: true }, { label: '% of NAV', num: true }, 'Status'], exRows, 'No holdings today.'),
    h('p', { class: 'muted small' }, `Concentration limit ${fmtPct(conc, 0)} of NAV. The rating in force is each agency's latest and, where agencies differ, the lowest.`)));

  // Register.
  const filterBtn = (key, label) => h('button', { class: `tab ${sel.kind === key ? 'active' : ''}`, onclick: () => { sel.kind = key; rerender(); } }, label);
  const shown = register.filter((c) => !sel.kind || c.kind === sel.kind);
  const regRows = [];
  for (const c of shown) {
    const r = ratingOn(data, c.id, today);
    const e = exByCp.get(c.id);
    regRows.push(h('tr', null,
      h('td', null, h('a', { href: '#/counterparties', onclick: (ev) => { ev.preventDefault(); sel.open = sel.open === c.id ? '' : c.id; rerender(); } }, c.name),
        c.aliases ? h('div', { class: 'muted small' }, `Also: ${c.aliases}`) : null),
      h('td', null, KIND_LABEL[c.kind] ?? c.kind),
      h('td', null, r ? r.rating : '—'),
      h('td', null, r ? `${r.agency}, ${fmtDate(r.date)}` : ''),
      h('td', { class: 'num' }, e ? fmtNaira(e.value) : '—'),
      h('td', null, h('div', { class: 'row-actions' },
        h('button', { class: 'primary', onclick: () => ratingForm(c) }, 'Add rating'),
        h('button', { onclick: () => cpForm(c) }, 'Edit')))));
    if (sel.open === c.id) regRows.push(h('tr', { class: 'detail' }, h('td', { colspan: 6 }, historyTable(data, c))));
  }
  parts.push(h('section', { class: 'card' },
    h('h2', null, 'Register'),
    h('div', { class: 'tabs' }, filterBtn('', 'All'), KINDS.map((k) => filterBtn(k.key, `${k.label}s`))),
    table(['Name', 'Type', 'Rating', 'Agency and date', { label: 'Held today', num: true }, ''], regRows, sel.kind ? 'None of this type yet.' : 'The register is empty. Add counterparties, or add the names held today from the prompt above.'),
    h('p', { class: 'muted small' }, 'Click a name for its rating history. Aliases let deals recorded under a different spelling match the entry.')));

  // Custodians.
  let cust = [];
  try { cust = custodianExposure(data, today); } catch { cust = []; }
  parts.push(h('section', { class: 'card' }, h('h2', null, 'Custodians'),
    table(['Custodian', 'In register', { label: 'Holdings', num: true }, { label: 'Value', num: true }],
      cust.map((c) => {
        const reg = c.name === 'Not recorded' ? null : findCounterparty(data, c.name);
        return h('tr', null, h('td', null, c.name), h('td', null, reg ? KIND_LABEL[reg.kind] : c.name === 'Not recorded' ? '—' : h('button', { onclick: () => cpForm({ name: c.name, kind: 'custodian' }) }, 'Add')),
          h('td', { class: 'num' }, String(c.count)), h('td', { class: 'num' }, fmtNaira(c.value)));
      }), 'No holdings.')));
  return h('div', null, parts);
}

function historyTable(data, c) {
  const list = ratingHistory(data, c.id);
  if (!list.length) return h('p', { class: 'muted' }, 'No ratings recorded yet.');
  return table(['Date', 'Agency', 'Rating', 'Outlook', 'Source', ''], list.map((r) => h('tr', null,
    h('td', null, fmtDate(r.date)), h('td', null, r.agency), h('td', null, normRating(r.rating) ?? r.rating), h('td', null, r.outlook ?? ''),
    h('td', null, r.sourceUrl ? h('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener' }, 'Link') : ''),
    h('td', null, h('button', { class: 'danger', onclick: (e) => confirmDialog({ title: 'Delete this rating?', message: `${r.agency} ${r.rating} on ${fmtDate(r.date)} for ${c.name}.`, confirmLabel: 'Delete', danger: true })
      .then((ok) => ok && runAction(e.target, () => deleteDoc('ratings', r.id, `Deleted ${r.agency} rating of ${c.name}`), 'Rating deleted')) }, 'Delete')))));
}

/** Fixed and call deposits are with banks, CPs with issuers, funds with their managers. */
function guessKind(data, name) {
  const closed = closedInstrumentIds(data.transactions);
  const i = (data.instruments ?? []).find((x) => !closed.has(x.id) && counterpartyName(x, data.funds) === name);
  return i?.type === 'commercial_paper' ? 'issuer' : i?.type === 'money_market_fund' ? 'fund_manager' : 'bank';
}

function cpForm(c) {
  const editing = Boolean(c?.id);
  openForm({
    title: editing ? `Edit ${c.name}` : 'Add counterparty',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, value: c?.name ?? '' },
      { name: 'kind', label: 'Type', type: 'select', required: true, value: c?.kind ?? 'bank', options: KINDS.map((k) => ({ value: k.key, label: k.label })) },
      { name: 'aliases', label: 'Other spellings (comma separated)', type: 'text', value: c?.aliases ?? '', help: 'Names used on deals that should count as this counterparty.' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: c?.notes ?? '' },
    ],
    onSubmit: async (v) => {
      const clash = findCounterparty(state.data, v.name);
      if (clash && clash.id !== c?.id) throw new Error(`${clash.name} is already in the register.`);
      await saveDoc('counterparties', editing ? c.id : null, { name: v.name.trim(), kind: v.kind, aliases: v.aliases.trim(), notes: v.notes });
      toast(editing ? 'Counterparty updated.' : 'Counterparty added.');
    },
  });
}

function ratingForm(c) {
  openForm({
    title: `Rating for ${c.name}`,
    intro: 'Long-term national scale. Agusto styles such as Aa- and Moody\'s styles such as Baa1 are converted.',
    fields: [
      { name: 'agency', label: 'Agency', type: 'select', required: true, value: 'Agusto', options: AGENCIES.map((a) => ({ value: a, label: a })) },
      { name: 'rating', label: 'Rating', type: 'text', required: true, value: '', help: `Scale: ${RATING_SCALE.slice(0, 12).join(', ')}…` },
      { name: 'date', label: 'Rating date', type: 'date', required: true, value: todayISO() },
      { name: 'outlook', label: 'Outlook', type: 'select', value: 'Stable', options: ['Stable', 'Positive', 'Negative', 'Developing', 'Watch'].map((o) => ({ value: o, label: o })) },
      { name: 'sourceUrl', label: 'Source link', type: 'text', value: '' },
    ],
    onSubmit: async (v) => {
      const rating = normRating(v.rating);
      if (!rating) throw new Error(`"${v.rating}" is not a rating on the scale (for example AA-, A+, BBB).`);
      await saveDoc('ratings', null, { counterpartyId: c.id, counterparty: c.name, agency: v.agency, rating, date: v.date, outlook: v.outlook, sourceUrl: v.sourceUrl.trim() });
      toast('Rating saved.');
    },
  });
}

function workbook(data, ex, register, today) {
  const exposure = [['Counterparty', 'FGN', 'Rating', 'Agency', 'Rating date', 'Holdings', 'Value', 'Share of NAV']];
  for (const e of ex) exposure.push([e.name, e.fgn ? 'Yes' : '', e.rating?.rating ?? '', e.rating?.agency ?? '', xDate(e.rating?.date), e.count, xMoney(e.value), xPct(e.share, 1)]);
  const ratings = [['Counterparty', 'Type', 'Agency', 'Rating', 'Date', 'Outlook', 'Source']];
  for (const c of register) for (const r of ratingHistory(data, c.id)) ratings.push([c.name, KIND_LABEL[c.kind] ?? c.kind, r.agency, r.rating, xDate(r.date), r.outlook ?? '', r.sourceUrl ?? '']);
  return [{ name: `Exposure ${today}`, rows: exposure }, { name: 'Rating history', rows: ratings }];
}
