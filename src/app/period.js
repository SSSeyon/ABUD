// Period choice shared by Dashboard, Reports and Change history: quarter to date, year to date, any quarter
// since inception, since inception, or custom dates. Pure date logic first, then the picker control.
import { addDays, quarter, quarterOf } from '../engine/index.js';
import { fmtDate, h } from './ui.js';

/** The period chosen on any screen; Dashboard, Reports and History share it so a choice carries across. */
export const sharedPeriod = { key: 'qtd', start: '', end: '' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthOf = (iso) => MONTHS[Number(iso.slice(5, 7)) - 1];

/**
 * Every period on offer, newest first: QTD, YTD, each full quarter back to inception's quarter, since inception.
 * @returns {{key: string, label: string, start: string, end: string}[]}
 */
export function periodOptions(inception, today) {
  const q = quarterOf(today);
  const out = [
    { key: 'qtd', label: `Quarter to date (${q.label})`, start: q.start, end: today },
    { key: 'ytd', label: `Year to date (${today.slice(0, 4)})`, start: `${today.slice(0, 4)}-01-01`, end: today },
  ];
  if (inception) {
    let cur = q.q === 1 ? quarter(q.year - 1, 4) : quarter(q.year, q.q - 1);
    while (cur.end >= inception) {
      out.push({ key: cur.label, label: `${cur.label} (${monthOf(cur.start)}–${monthOf(cur.end)} ${cur.year})`, start: cur.start, end: cur.end });
      cur = cur.q === 1 ? quarter(cur.year - 1, 4) : quarter(cur.year, cur.q - 1);
    }
    out.push({ key: 'inception', label: 'Since inception', start: inception, end: today });
  }
  return out;
}

/** Resolves a selection ({key, start?, end?}) to dates, clipped to inception..today. */
export function resolvePeriod(sel, inception, today) {
  const opts = periodOptions(inception, today);
  const found = sel.key === 'custom' ? { key: 'custom', label: 'Custom dates', start: sel.start, end: sel.end } : opts.find((o) => o.key === sel.key) ?? opts[0];
  let { start, end } = found;
  if (inception && start < inception) start = inception;
  if (end > today) end = today;
  return { ...found, start, end, prevEnd: addDays(start, -1) };
}

/**
 * The picker: one dropdown of periods, plus From/To when "Custom dates" is chosen.
 * sel is mutated in place and onChange called after each change.
 */
export function periodPicker(sel, inception, today, onChange, { custom = true } = {}) {
  const opts = periodOptions(inception, today);
  const p = resolvePeriod(sel, inception, today);
  const select = h(
    'select',
    { class: 'period-select', 'aria-label': 'Period', value: sel.key, onchange: (e) => { sel.key = e.target.value; if (sel.key === 'custom' && !sel.start) Object.assign(sel, { start: p.start, end: p.end }); onChange(); } },
    h('optgroup', { label: 'Current' }, opts.filter((o) => ['qtd', 'ytd'].includes(o.key)).map((o) => h('option', { value: o.key }, o.label))),
    h('optgroup', { label: 'Quarters' }, opts.filter((o) => /Q\d$/.test(o.key)).map((o) => h('option', { value: o.key }, o.label))),
    h('optgroup', { label: 'Other' }, opts.filter((o) => o.key === 'inception').map((o) => h('option', { value: o.key }, o.label)), custom ? h('option', { value: 'custom' }, 'Custom dates…') : null),
  );
  const dates = sel.key === 'custom'
    ? [
        h('label', { class: 'inline-field' }, 'From', h('input', { type: 'date', value: p.start, min: inception, max: today, onchange: (e) => { sel.start = e.target.value; onChange(); } })),
        h('label', { class: 'inline-field' }, 'To', h('input', { type: 'date', value: p.end, min: inception, max: today, onchange: (e) => { sel.end = e.target.value; onChange(); } })),
      ]
    : [h('span', { class: 'muted small' }, `${fmtDate(p.start)} – ${fmtDate(p.end)}`)];
  return h('div', { class: 'period-picker' }, h('span', { class: 'period-label' }, 'Period'), select, dates);
}
