import { dec } from '../../engine/index.js';
import { importHistory, restoreBackup, saveDoc, saveLimits } from '../actions.js';
import { RATING_SCALE } from '../counterparties.js';
import { backupFile } from '../backup.js';
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
    h('div', { class: 'tabs' }, tab('mandate', 'Mandate terms'), tab('limits', 'Limits and alerts'), tab('funds', 'Funds'), tab('import', 'Import history'), tab('backup', 'Backup')),
    section === 'backup' ? backupSection() : section === 'funds' ? fundsSection() : section === 'import' ? importSection(rerender) : section === 'limits' ? limitsSection() : mandateSection(),
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
  { name: 'minRating', label: 'Minimum counterparty rating', kind: 'rating', help: 'New deals with a bank, issuer or fund manager rated below this are refused; FGN bills are exempt.' },
];

function limitsSection() {
  const limits = limitsFrom(state.data);
  const saved = (state.data.settings ?? []).some((d) => d.id === 'limits');
  const show = (f) => (f.kind === 'rating' ? limits[f.name] : f.kind === 'money' ? fmtNaira(limits[f.name]) : f.kind === 'pct' ? fmtPct(limits[f.name], 1) : `${limits[f.name]} days`.replace(/^(\d+) days$/, f.name === 'idleDays' ? '$1 business days' : '$1 days'));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'page-head' }, h('h2', null, 'Limits and alert thresholds'), h('button', { class: 'primary', onclick: () => limitsForm(limits) }, 'Edit limits')),
    h('p', { class: 'muted' }, saved ? 'Alerts on the Dashboard and Alerts screen use these values.' : 'Defaults from the build plan, not yet saved. Edit to confirm them.'),
    state.errors.settings ? h('p', { class: 'bad' }, 'Limits cannot be saved until the updated firestore.rules are published.') : null,
    table(['Limit', { label: 'Value', num: true }], LIMIT_FIELDS.map((f) => h('tr', null, h('td', null, f.label.replace('…', ''), f.help ? h('div', { class: 'muted small' }, f.help) : null), h('td', { class: 'num' }, show(f))))),
    limitHistory(),
  );
}

function limitsForm(limits) {
  openForm({
    title: 'Limits and alert thresholds',
    submitLabel: 'Save limits',
    fields: [{ name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true, value: todayISO(), help: 'Breaches before this date are judged against the limits then in force.' }, ...LIMIT_FIELDS.map((f) => ({
      name: f.name, label: f.label, help: f.help, required: true,
      type: f.kind === 'rating' ? 'select' : f.kind === 'money' ? 'money' : f.kind === 'pct' ? 'percent' : 'number',
      options: f.kind === 'rating' ? RATING_SCALE.slice(0, 12).map((r) => ({ value: r, label: r })) : undefined,
      value: f.kind === 'pct' ? dec(limits[f.name]).times(100).toFixed() : limits[f.name],
    }))],
    onSubmit: async (v) => {
      const out = {};
      for (const f of LIMIT_FIELDS) {
        if (f.kind === 'money') out[f.name] = parseMoney(v[f.name], f.label);
        else if (f.kind === 'pct') out[f.name] = parsePercent(v[f.name], f.label);
        else if (f.kind === 'rating') out[f.name] = v[f.name];
        else {
          if (!/^\d+$/.test(v[f.name]) || Number(v[f.name]) < 1) throw new Error(`${f.label.replace('…', '')}: enter a whole number of days`);
          out[f.name] = String(Number(v[f.name]));
        }
      }
      if (!/^d{4}-d{2}-d{2}$/.test(v.effectiveFrom ?? '')) throw new Error('Effective from: enter a date');
      await saveLimits(out, v.effectiveFrom);
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
      ['Effective from', 'Client', 'Start date', 'Anniversary', 'Mgmt fee', 'Fee day count', 'Incentive', 'Hurdle spread', 'Billing reading', ''],
      list.map((m) =>
        h(
          'tr',
          null,
          h('td', null, fmtDate(m.effectiveFrom)),
          h('td', null, m.clientName ?? ''),
          h('td', null, fmtDate(m.startDate)),
          h('td', null, fmtDate(m.anniversary)),
          h('td', null, fmtPct(m.mgmtFeeRate)),
          h('td', null, (m.feeDayCount ?? 'quarterly') === 'quarterly' ? 'Quarterly ÷ 4' : 'Actual/365'),
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
      { name: 'anniversary', label: 'Anniversary (renewal) date', type: 'date', value: prev?.anniversary ?? '2021-08-11', help: 'Commencement 11 Aug 2021 (first inflow), confirmed 26 Nov 2026; renewal alerts count to each anniversary.' },
      { name: 'mgmtFeeRate', label: 'Management fee (% p.a.)', type: 'percent', required: true, value: pctInput(prev?.mgmtFeeRate, '0.75') },
      { name: 'incentiveRate', label: 'Incentive fee (% of outperformance)', type: 'percent', required: true, value: pctInput(prev?.incentiveRate, '10') },
      { name: 'hurdleSpread', label: 'Hurdle spread over 91-day true yield (%)', type: 'percent', required: true, value: pctInput(prev?.hurdleSpread, '2') },
      {
        name: 'incentiveReading', label: 'Incentive billing reading', type: 'select', required: true, value: prev?.incentiveReading ?? 'clause_8',
        options: [{ value: 'clause_8', label: 'Clause 8: outperformance over WATBR (current practice)' }, { value: 'clause_12', label: 'Clause 12: outperformance over the hurdle' }],
      },
      {
        name: 'feeDayCount', label: 'Management fee day count', type: 'select', required: true, value: prev?.feeDayCount ?? 'quarterly',
        options: [{ value: 'quarterly', label: 'Annual rate ÷ 4 per quarter, spread over its days (as billed; confirmed)' }, { value: 'act365', label: 'Actual/365 per day' }],
      },
    ],
    onSubmit: async (v) => {
      const data = {
        ...v,
        mgmtFeeRate: parsePercent(v.mgmtFeeRate, 'Management fee'),
        incentiveRate: parsePercent(v.incentiveRate, 'Incentive fee'),
        hurdleSpread: parsePercent(v.hurdleSpread, 'Hurdle spread'),
        noticeDays: 30,
        feeDayCount: v.feeDayCount,
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

/** Every saved version of the limits, newest first. */
function limitHistory() {
  const versions = [...(state.data.limitSets ?? [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  if (!versions.length) return h('p', { class: 'muted small' }, 'No dated versions yet: the next save starts the history, so later breach reports judge each date against the limits then in force.');
  return h('div', null, h('h3', null, 'Versions'),
    table(['Effective from', { label: 'Idle cash', num: true }, { label: 'Liquidity', num: true }, { label: 'Concentration', num: true }, { label: 'Max tenor', num: true }, 'Min rating'],
      versions.map((v) => h('tr', null, h('td', null, fmtDate(v.effectiveFrom)), h('td', { class: 'num' }, fmtNaira(v.idleCash)), h('td', { class: 'num' }, fmtPct(v.liquidityShare, 1)),
        h('td', { class: 'num' }, fmtPct(v.concentrationShare, 1)), h('td', { class: 'num' }, `${v.maxTenorDays} days`), h('td', null, v.minRating ?? '—')))));
}

// ---------- backup ----------
function backupSection() {
  const counts = Object.entries(state.data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k} ${v.length}`).join(' · ');
  const status = h('p', { class: 'muted small' });
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  return h('section', { class: 'card' },
    h('h2', null, 'Backup and restore'),
    h('p', null, 'Download every collection as one JSON file. A scheduled GitHub job also saves a copy each night (Actions > Nightly backup, kept 30 days).'),
    h('p', { class: 'muted small' }, counts),
    h('div', { class: 'toolbar actions-row' },
      h('button', { class: 'primary', onclick: () => {
        const file = backupFile(state.data);
        const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `ABUD backup ${todayISO()}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }, 'Download backup')),
    h('h3', null, 'Restore'),
    h('p', { class: 'muted small' }, 'Writes every document in the file back, replacing documents with the same id. Documents added since the backup stay. The change history is not restored (it is append-only).'),
    h('div', { class: 'toolbar actions-row' }, input,
      h('button', { class: 'danger', onclick: async (e) => {
        const btn = e.currentTarget;
        const file = input.files?.[0];
        if (!file) { toast('Choose a backup file first.', 'bad'); return; }
        let parsed;
        try { parsed = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', 'bad'); return; }
        const n = Object.values(parsed.collections ?? {}).reduce((s, l) => s + l.length, 0);
        const ok = await confirmDialog({ title: 'Restore this backup?', message: `${n} documents from ${parsed.takenAt ?? 'an unknown date'} will be written back, replacing current versions with the same id.`, confirmLabel: 'Restore', danger: true });
        if (!ok) return;
        btn.disabled = true;
        try {
          await restoreBackup(parsed, (done, total) => { status.textContent = `${done} of ${total} documents written…`; });
          status.textContent = `Restored ${n} documents.`;
          toast('Backup restored.');
        } catch (err) { status.textContent = ''; toast(errorText(err), 'bad'); } finally { btn.disabled = false; }
      } }, 'Restore from file')),
    status);
}
