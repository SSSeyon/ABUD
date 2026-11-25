import { historyStatus } from './actions.js';
import { OPTIONAL, start, state, subscribe } from './store.js';
import { h, todayISO } from './ui.js';
import { computeAlerts, limitsFrom } from './alerts.js';
import { alertsView } from './views/alerts.js';
import { dashboardView } from './views/dashboard.js';
import { ladderView } from './views/ladder.js';
import { historyView } from './views/history.js';
import { holdingsView } from './views/holdings.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';
import { transactionsView } from './views/transactions.js';

// Simple line icons (24px grid, drawn with currentColor).
const ICONS = {
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  alerts: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4h4',
  holdings: 'M4 7h16M4 12h16M4 17h10',
  ladder: 'M4 19h4v-4H4zm6 0h4V9h-4zm6 0h4V4h-4z',
  transactions: 'M7 7h13l-3-3M17 17H4l3 3',
  reports: 'M5 21V10m7 11V4m7 17v-7',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
};

const ROUTES = {
  dashboard: { label: 'Dashboard', view: dashboardView },
  alerts: { label: 'Alerts', view: alertsView },
  holdings: { label: 'Holdings', view: holdingsView },
  ladder: { label: 'Maturity ladder', view: ladderView },
  transactions: { label: 'Transactions', view: transactionsView },
  reports: { label: 'Reports', view: reportsView },
  history: { label: 'Change history', view: historyView },
  settings: { label: 'Settings', view: settingsView },
};

const root = document.getElementById('app');

function currentRoute() {
  const key = location.hash.replace(/^#\/?/, '');
  return ROUTES[key] ? key : 'dashboard';
}

function icon(key) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[key]);
  svg.append(path);
  return svg;
}

/** MBO Capital wordmark, set in type (no image file needed). */
function brand() {
  return h('a', { class: 'brand', href: '#/dashboard', 'aria-label': 'MBO Capital: ABUD Portfolio' },
    h('span', { class: 'wordmark' }, h('span', { class: 'wm-mbo' }, 'mbo'), h('span', { class: 'wm-capital' }, 'capital')),
    h('span', { class: 'brand-app' }, 'ABUD Portfolio'));
}

function render() {
  const key = currentRoute();
  const errors = Object.entries(state.errors).filter(([name]) => !OPTIONAL.has(name));
  let content;
  try {
    content = ROUTES[key].view(render);
  } catch (err) {
    console.error(err);
    content = h('div', { class: 'card bad' }, h('h2', null, 'Something went wrong on this screen'), h('p', null, err.message));
  }
  const historyOff = Boolean(state.errors.audit) || historyStatus.failing;
  let highAlerts = 0;
  if (['transactions', 'instruments', 'fundPrices'].every((n) => state.loaded.has(n))) {
    try { highAlerts = computeAlerts(state.data, todayISO(), limitsFrom(state.data)).filter((a) => a.level === 'high').length; } catch { highAlerts = 0; }
  }

  root.replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        brand(),
        h('nav', { 'aria-label': 'Main' },
          Object.entries(ROUTES).map(([k, r]) =>
            h('a', { href: `#/${k}`, class: k === key ? 'active' : null, 'aria-current': k === key ? 'page' : null },
              icon(k), h('span', null, r.label),
              k === 'history' && historyOff ? h('span', { class: 'dot-warn', title: 'Not switched on yet' }) : null,
              k === 'alerts' && highAlerts ? h('span', { class: 'nav-count', title: `${highAlerts} high-priority alert${highAlerts === 1 ? '' : 's'}` }, String(highAlerts)) : null))),
        h('div', { class: 'sidebar-foot' }, h('div', null, 'Access Holdings Plc'), h('div', { class: 'muted' }, 'Unclaimed dividend pool'))),
      h('main', { class: 'page' },
        errors.length ? h('div', { class: 'card bad' }, `Could not load: ${errors.map(([name, msg]) => `${name} (${msg})`).join('; ')}`) : null,
        state.stalled
          ? h('div', { class: 'card bad' },
              h('h2', null, 'The database is not responding'),
              h('p', null, 'Check the internet connection. If this is a new setup, create the Firestore database in the Firebase console (project abud-24577) and publish firestore.rules. See README.md.'))
          : null,
        content)),
  );
}

window.addEventListener('hashchange', render);
subscribe(render);
start();
render();
