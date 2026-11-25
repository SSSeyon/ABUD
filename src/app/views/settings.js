import { dec } from '../../engine/index.js';
import { saveDoc } from '../actions.js';
import { loadedAll, state } from '../store.js';
import { fmtDate, fmtPct, h, openForm, parsePercent, table, toast, todayISO } from '../ui.js';

const NEEDS = ['mandateTerms', 'funds'];
let section = 'mandate';

export function settingsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const tab = (key, label) =>
    h('button', { class: `tab ${section === key ? 'active' : ''}`, 'aria-pressed': String(section === key), onclick: () => { section = key; rerender(); } }, label);
  return h(
    'div',
    null,
    h('h1', null, 'Settings'),
    h('div', { class: 'tabs' }, tab('mandate', 'Mandate terms'), tab('funds', 'Funds')),
    section === 'funds' ? fundsSection() : mandateSection(),
  );
}

// ---------- mandate terms ----------
function mandateSection() {
  const list = [...(state.data.mandateTerms ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'page-head' }, h('h2', null, 'Mandate terms'), h('button', { class: 'primary', onclick: () => mandateForm(list[0]) }, 'Add version')),
    h('p', { class: 'muted' }, 'Terms are dated: a change at renewal applies only from its effective date.'),
    table(
      ['Effective from', 'Client', 'Start date', 'Anniversary', 'Mgmt fee', 'Incentive', 'Hurdle spread', 'Billing reading', ''],
      list.map((m) =>
        h(
          'tr',
          null,
          h('td', null, fmtDate(m.effectiveFrom)),
          h('td', null, m.clientName ?? ''),
          h('td', null, fmtDate(m.startDate)),
          h('td', null, fmtDate(m.anniversary)),
          h('td', null, fmtPct(m.mgmtFeeRate)),
          h('td', null, fmtPct(m.incentiveRate, 1)),
          h('td', null, fmtPct(m.hurdleSpread, 2)),
          h('td', null, m.incentiveReading === 'clause_12' ? 'Clause 12' : 'Clause 8'),
          h('td', null, h('button', { onclick: () => mandateForm(m, true) }, 'Edit')),
        ),
      ),
      'No mandate terms yet. Add the current agreement terms.',
    ),
  );
}

/** A stored fraction shown as a percentage for editing ("0.0075" -> "0.75"), or the default. */
const pctInput = (fraction, fallback) => (fraction ? dec(fraction).times(100).toFixed() : fallback);

function mandateForm(prev, editing = false) {
  openForm({
    title: editing ? 'Edit mandate terms' : 'New mandate terms version',
    submitLabel: 'Save terms',
    fields: [
      { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true, value: editing ? prev.effectiveFrom : todayISO(), help: editing ? 'Changing this date saves a new version; the old one stays.' : null },
      { name: 'clientName', label: 'Client', type: 'text', required: true, value: prev?.clientName ?? 'Access Holdings Plc' },
      { name: 'clientAddress', label: 'Client address', type: 'textarea', value: prev?.clientAddress ?? '' },
      { name: 'clientContact', label: 'Client contact', type: 'text', value: prev?.clientContact ?? '' },
      { name: 'startDate', label: 'Mandate start date', type: 'date', required: true, value: prev?.startDate ?? '' },
      { name: 'anniversary', label: 'Anniversary (renewal) date', type: 'date', value: prev?.anniversary ?? '', help: 'Open decision: the 2024 agreement leaves the commencement date blank.' },
      { name: 'mgmtFeeRate', label: 'Management fee (% p.a.)', type: 'percent', required: true, value: pctInput(prev?.mgmtFeeRate, '0.75') },
      { name: 'incentiveRate', label: 'Incentive fee (% of outperformance)', type: 'percent', required: true, value: pctInput(prev?.incentiveRate, '10') },
      { name: 'hurdleSpread', label: 'Hurdle spread over 91-day true yield (%)', type: 'percent', required: true, value: pctInput(prev?.hurdleSpread, '2') },
      {
        name: 'incentiveReading', label: 'Incentive billing reading', type: 'select', required: true, value: prev?.incentiveReading ?? 'clause_8',
        options: [{ value: 'clause_8', label: 'Clause 8: outperformance over WATBR (current practice)' }, { value: 'clause_12', label: 'Clause 12: outperformance over the hurdle' }],
      },
    ],
    onSubmit: async (v) => {
      const data = {
        ...v,
        mgmtFeeRate: parsePercent(v.mgmtFeeRate, 'Management fee'),
        incentiveRate: parsePercent(v.incentiveRate, 'Incentive fee'),
        hurdleSpread: parsePercent(v.hurdleSpread, 'Hurdle spread'),
        noticeDays: 30,
      };
      await saveDoc('mandateTerms', v.effectiveFrom, data);
      toast('Mandate terms saved.');
    },
  });
}

// ---------- funds ----------
function fundsSection() {
  const list = [...(state.data.funds ?? [])].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'page-head' }, h('h2', null, 'Money market funds'), h('button', { class: 'primary', onclick: () => fundForm() }, 'Add fund')),
    table(
      ['Fund', 'Manager', 'Pricing', 'MBO-managed (Clause 11)', ''],
      list.map((f) =>
        h(
          'tr',
          null,
          h('td', null, f.name ?? ''),
          h('td', null, f.managerName ?? ''),
          h('td', null, f.pricingBasis === 'yield' ? 'Balance plus daily yield' : 'Units × price'),
          h('td', null, f.isMboManaged ? 'Yes: no management fee' : 'No'),
          h('td', null, h('button', { onclick: () => fundForm(f) }, 'Edit')),
        ),
      ),
      'No funds yet.',
    ),
  );
}

function fundForm(f) {
  openForm({
    title: f ? 'Edit fund' : 'Add fund',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Fund name', type: 'text', required: true, value: f?.name ?? '' },
      { name: 'managerName', label: 'Fund manager', type: 'text', required: true, value: f?.managerName ?? '' },
      { name: 'pricingBasis', label: 'How the fund reports value', type: 'select', required: true, value: f?.pricingBasis ?? 'yield', options: [{ value: 'yield', label: 'Balance plus daily yield' }, { value: 'price', label: 'Units × published price' }] },
      { name: 'isMboManaged', label: 'Managed by MBO?', type: 'select', required: true, value: f ? String(Boolean(f.isMboManaged)) : 'false', options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }] },
    ],
    onSubmit: async (v) => {
      await saveDoc('funds', f?.id ?? null, { ...v, isMboManaged: v.isMboManaged === 'true' });
      toast('Fund saved.');
    },
  });
}
