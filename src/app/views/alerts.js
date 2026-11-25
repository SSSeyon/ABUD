// Alerts screen: everything that needs attention today, with the limits that drive it.
import { computeAlerts, limitsFrom } from '../alerts.js';
import { loadedAll, state } from '../store.js';
import { fmtDate, fmtNaira, fmtPct, h, todayISO } from '../ui.js';
import { alertList } from './dashboard.js';

const NEEDS = ['transactions', 'instruments', 'fundPrices', 'funds', 'mandateTerms'];

export function alertsView() {
  if (!loadedAll(NEEDS)) return h('p', { class: 'muted' }, 'Loading…');
  const today = todayISO();
  const limits = limitsFrom(state.data);
  const alerts = computeAlerts(state.data, today, limits);
  const count = (lvl) => alerts.filter((a) => a.level === lvl).length;
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Alerts'), h('p', { class: 'subtitle' }, `As of ${fmtDate(today)}. Each alert clears by itself once it is dealt with.`))),
    h('div', { class: 'stats' },
      h('div', { class: 'stat down' }, h('div', { class: 'stat-label' }, 'High'), h('div', { class: 'stat-value' }, String(count('high')))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Medium'), h('div', { class: 'stat-value' }, String(count('medium')))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Low'), h('div', { class: 'stat-value' }, String(count('low'))))),
    h('section', { class: 'card' }, alerts.length ? alertList(alerts) : h('p', { class: 'muted' }, 'Nothing needs attention.')),
    h('p', { class: 'muted small' },
      `Limits in use: idle cash ${fmtNaira(limits.idleCash)} for over ${limits.idleDays} business days · liquidity ${fmtPct(limits.liquidityShare, 0)} of NAV within ${limits.liquidityDays} days · concentration ${fmtPct(limits.concentrationShare, 0)} of NAV · tenor ${limits.maxTenorDays} days · maturities flagged ${limits.maturityWarnDays} days ahead. Change them in `,
      h('a', { href: '#/settings' }, 'Settings'), '. Email alerts are not set up yet.'),
  );
}
