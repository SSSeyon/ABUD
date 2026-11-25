import { dec } from '../../engine/index.js';
import { importHistory, saveDoc } from '../actions.js';
import { HISTORY_FILE, importStatus } from '../history.js';
import { loadedAll, state } from '../store.js';
import { confirmDialog, errorText, fmtDate, fmtNaira, fmtPct, h, openForm, parseMoney, parsePercent, table, toast, todayISO } from '../ui.js';
import { limitsFrom } from '../alerts.js';

const NEEDS = ['mandateTerms', 'funds'];
let section = 'mandate';

/** History file, fetched once when the Import tab first opens. */
const history = { file: null, error: null, loading: false, progress: null };

export function settingsView(rerender) {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const tab = (key, label) =>
    h('button', { class: `tab ${section === key ? 'active' : ''}`, 'aria-pressed': String(section === key), onclick: () => { section = key; rerender(); } }, label);
  return h(
    'div',
    null,
    h('h1', null, 'Settings'),
    h('div', { class: 'tabs' }, tab('mandate', 'Mandate terms'), tab('limits', 'Limits and alerts'), tab('funds', 'Funds'), tab('import', 'Import history')),
    section === 'funds' ? fundsSection() : section === 'import' ? importSection(rerender) : section === 'limits' ? limitsSection() : mandateSection(),
  );
}

// ---------- limits and alert thresholds ----------
const LIMIT_FIELDS = [
  { name: 'idleCash', label: 'Idle cash limit (₦)', kind: 'money', help: 'Alert when uninvested cash stays above this…' },
  { name: 'idleDays', label: '…for more than this many business days', kind: 'int' },
  { name: 'maturityWarnDays', label: 'Warn about maturities this many days ahead', kind: 'int' },
  { name: 'liquidityShare', label: 'Liquidity buffer minimum (% of NAV)', kind: 'pct', help: 'Cash, funds and holdings maturing soon, as a share of NAV.' },
  { name: 'liquidityDays', label: 'Liquidity horizon (days)', kind: 'int', help: 'Holdings maturing within this many days count as liquid.' },
  { name: 'concentrationShare', label: 'Counterparty concentration limit (% of NAV)', kind: 'pct' },
  { name: 'maxTenorDays', label: 'Longest tenor for a new deal (days)', kind: 'int', help: 'New deals longer than this are refused.' },
];

function limitsSection() {
  const limits = limitsFrom(state.data);
  const saved = (state.data.settings ?? []).some((d) => d.id === 'limits');
  const show = (f) => (f.kind === 'money' ? fmtNaira(limits[f.name]) : f.kind === 'pct' ? fmtPct(limits[f.name], 1) : `${limits[f.name]} days`.replace(/^(\d+) days$/, f.name === 'idleDays' ? '$1 business days' : '$1 days'));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'page-head' }, h('h2', null, 'Limits and alert thresholds'), h('button', { class: 'primary', onclick: () => limitsForm(limits) }, 'Edit limits')),
    h('p', { class: 'muted' }, saved ? 'Alerts on the Dashboard and Alerts screen use these values.' : 'Defaults from the build plan, not yet saved. Edit to confirm them.'),
    state.errors.settings ? h('p', { class: 'bad' }, 'Limits cannot be saved until the updated firestore.rules are published.') : null,
    table(['Limit', { label: 'Value', num: true }], LIMIT_FIELDS.map((f) => h('tr', null, h('td', null, f.label.replace('…', ''), f.help ? h('div', { class: 'muted small' }, f.help) : null), h('td', { class: 'num' }, show(f))))),
  );
}

function limitsForm(limits) {
  openForm({
    title: 'Limits and alert thresholds',
    submitLabel: 'Save limits',
    fields: LIMIT_FIELDS.map((f) => ({
      name: f.name, label: f.label, help: f.help, required: true,
      type: f.kind === 'money' ? 'money' : f.kind === 'pct' ? 'percent' : 'number',
      value: f.kind === 'pct' ? dec(limits[f.name]).times(100).toFixed() : limits[f.name],
    })),
    onSubmit: async (v) => {
      const out = {};
      for (const f of LIMIT_FIELDS) {
        if (f.kind === 'money') out[f.name] = parseMoney(v[f.name], f.label);
        else if (f.kind === 'pct') out[f.name] = parsePercent(v[f.name], f.label);
        else {
          if (!/^\d+$/.test(v[f.name]) || Number(v[f.name]) < 1) throw new Error(`${f.label.replace('…', '')}: enter a whole number of days`);
          out[f.name] = String(Number(v[f.name]));
        }
      }
      await saveDoc('settings', 'limits', out);
      toast('Limits saved.');
    },
  });
}

// ---------- history import ----------
function importSection(rerender) {
  if (!history.file && !history.error && !history.loading) {
    history.loading = true;
    fetch(HISTORY_FILE)
      .then((r) => { if (!r.ok) throw new Error(`Could not load ${HISTORY_FILE} (${r.status})`); return r.json(); })
      .then((f) => { history.file = f; })
      .catch((e) => { history.error = errorText(e); })
      .finally(() => { history.loading = false; rerender(); });
  }
  const card = (...children) => h('section', { class: 'card' }, h('h2', null, 'Import transaction history'), ...children);
  if (history.error) return card(h('p', { class: 'bad' }, history.error));
  if (!history.file || !loadedAll(['transactions', 'instruments'])) return card(h('p', { class: 'muted' }, 'Loading…'));

  const f = history.file;
  const status = importStatus(state.data, f);
  const count = (type) => f.transactions.filter((t) => t.type === type).length;
  return card(
    h('p', null, `History from the ABUD schedule workbook, inception to ${fmtDate(f.asOf)}.`),
    table(
      ['What', 'Count'],
      [
        ['Deals (placements, rollovers, bills, CPs, fund holdings)', f.instruments.length],
        ['Inflows from Access', count('inflow')],
        ['Withdrawals', count('withdrawal')],
        ['Fees and bank charges', count('fee_debit')],
        ['Maturities, terminations and redemptions', count('mature') + count('fund_redemption')],
        ['Fund yield points (Cowrywise, TrustBanc)', f.fundPrices.length],
      ].map(([a, b]) => h('tr', null, h('td', null, a), h('td', { class: 'num' }, String(b)))),
    ),
    h('p', null, `After import, at ${fmtDate(f.asOf)}: cash ${fmtNaira(f.check.cash)} (equal to the bank ledger), holdings ${fmtNaira(f.check.holdings)}, NAV ${fmtNaira(f.check.nav)}.`),
    history.progress
      ? h('p', null, `Importing… ${history.progress}`)
      : status.canImport
        ? h('button', { class: 'primary', onclick: (e) => runImport(e.target, f, status, rerender) }, status.resuming ? 'Finish import' : 'Import history')
        : h('p', { class: 'muted' }, status.reason),
  );
}

async function runImport(button, file, status, rerender) {
  const ok = await confirmDialog({
    title: status.resuming ? 'Finish the import?' : 'Import transaction history?',
    message: `This writes ${file.instruments.length} deals and ${file.transactions.length} transactions to the shared database. Running it again overwrites the same records, so it never duplicates them.`,
    confirmLabel: 'Import',
  });
  if (!ok) return;
  button.disabled = true;
  try {
    await importHistory(file, (done, total) => { history.progress = `${done} of ${total} records`; rerender(); });
    toast('History imported.');
  } catch (err) {
    toast(`Import stopped: ${errorText(err)}. Run it again to finish.`, 'bad');
  } finally {
    history.progress = null;
    rerender();
  }
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
