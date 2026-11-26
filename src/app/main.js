// App shell and hash router. Screens are grouped into eight sections; Home shows one card per section, the logo
// always leads back to Home, and a section with several screens shows them as tabs. Desktop: sidebar of sections.
// Phones (≤ 860 px): a top bar (logo + title) and a bottom tab bar instead of the sidebar.
import { historyStatus } from './actions.js';
import { OPTIONAL, start, state, subscribe } from './store.js';
import { h, todayISO } from './ui.js';
import { computeAlerts, limitsFrom } from './alerts.js';
import { completedQuarters } from './close.js';
import { maturityWatch } from './portfolio.js';
import { alertsView } from './views/alerts.js';
import { dashboardView } from './views/dashboard.js';
import { ladderView } from './views/ladder.js';
import { marketView } from './views/market.js';
import { closeView } from './views/close.js';
import { historyView } from './views/history.js';
import { holdingsView } from './views/holdings.js';
import { reportsView } from './views/reports.js';
import { settingsView } from './views/settings.js';
import { transactionsView } from './views/transactions.js';
import { backtestView } from './views/backtest.js';
import { counterpartiesView } from './views/counterparties.js';
import { managementView } from './views/management.js';
import { terminationView } from './views/termination.js';
import { homeView } from './views/home.js';
import { navDailyView } from './views/navdaily.js';

// Simple line icons (24px grid, drawn with currentColor).
export const ICONS = {
  home: 'M3 11l9-8 9 8M5 9v12h14V9',
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  alerts: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4h4',
  holdings: 'M4 7h16M4 12h16M4 17h10',
  transactions: 'M7 7h13l-3-3M17 17H4l3 3',
  market: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  reports: 'M5 21V10m7 11V4m7 17v-7',
  fees: 'M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
};

/** Every screen, by its hash. */
const ROUTES = {
  home: { label: 'Home', view: homeView },
  dashboard: { label: 'Dashboard', view: dashboardView },
  alerts: { label: 'Alerts', view: alertsView },
  holdings: { label: 'Positions', view: holdingsView },
  ladder: { label: 'Maturity ladder', view: ladderView },
  transactions: { label: 'Transactions', view: transactionsView },
  history: { label: 'Change history', view: historyView },
  market: { label: 'Market', view: marketView },
  counterparties: { label: 'Counterparties', view: counterpartiesView },
  reports: { label: 'Portfolio report', view: reportsView },
  navdaily: { label: 'Daily NAV', view: navDailyView },
  management: { label: 'Management report', view: managementView },
  close: { label: 'Quarter close', view: closeView },
  backtest: { label: 'Back-test', view: backtestView },
  termination: { label: 'Termination', view: terminationView },
  settings: { label: 'Settings', view: settingsView },
};

/** The sections: one Home card and one sidebar entry each; a section with several screens shows them as tabs. */
export const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard', desc: 'NAV, return, allocation, maturities', routes: ['dashboard'], color: '#c4122f' },
  { id: 'alerts', label: 'Alerts', desc: 'What needs attention today', routes: ['alerts'], color: '#d97706' },
  { id: 'holdings', label: 'Holdings', desc: 'Positions, deals and the maturity ladder', routes: ['holdings', 'ladder'], color: '#2a78d6' },
  { id: 'transactions', label: 'Transactions', desc: 'Cash movements and change history', routes: ['transactions', 'history'], color: '#6250d6' },
  { id: 'market', label: 'Market', desc: 'Auctions, CP, news, counterparties', routes: ['market', 'counterparties'], color: '#008a5e' },
  { id: 'reports', label: 'Reports', desc: 'Period report, daily NAV make-up, management report', routes: ['reports', 'navdaily', 'management'], color: '#db2777' },
  { id: 'fees', label: 'Fees', desc: 'Quarter close, back-test, termination', routes: ['close', 'backtest', 'termination'], color: '#b45309' },
  { id: 'settings', label: 'Settings', desc: 'Terms, limits, funds, import, backup', routes: ['settings'], color: '#475569' },
];
const sectionOf = (route) => SECTIONS.find((s) => s.routes.includes(route));

/** Phone bottom bar: Home and the three most used sections. */
const BOTTOM = ['home', 'dashboard', 'alerts', 'holdings'];

const root = document.getElementById('app');

function currentRoute() {
  const key = location.hash.replace(/^#\/?/, '');
  return ROUTES[key] ? key : 'home';
}

export function icon(key, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[key] ?? ICONS.home);
  svg.append(path);
  return svg;
}

/** MBO Capital wordmark, set in type (no image file needed). Leads Home. */
function brand(cls = 'brand') {
  return h('a', { class: cls, href: '#/home', 'aria-label': 'MBO Capital ABUD Portfolio: Home' },
    h('span', { class: 'wordmark' }, h('span', { class: 'wm-mbo' }, 'mbo'), h('span', { class: 'wm-capital' }, 'capital')),
    h('span', { class: 'brand-app' }, 'ABUD Portfolio'));
}

/** Today's alerts, or [] until the data is in. */
function currentAlerts() {
  const data = state.data;
  if (!['transactions', 'instruments', 'fundPrices'].every((n) => state.loaded.has(n))) return [];
  const today = todayISO();
  try { return computeAlerts(data, today, limitsFrom(data, today)); } catch { return []; }
}

/** Badge numbers per section: high alerts, maturities overdue or due this week, last quarter not closed. */
function sectionCounts(alerts) {
  const data = state.data;
  const out = {};
  if (!['transactions', 'instruments', 'fundPrices'].every((n) => state.loaded.has(n))) return out;
  const today = todayISO();
  out.alerts = alerts.filter((a) => a.level === 'high').length;
  try { const w = maturityWatch(data, today, 7); out.holdings = w.overdue.length + w.due.length; } catch { /* ignore */ }
  if (Array.isArray(data.quarterlyResults)) {
    const inception = (data.transactions ?? []).reduce((m, t) => (!m || t.date < m ? t.date : m), '');
    const lastQ = completedQuarters(inception, today)[0];
    if (lastQ && !data.quarterlyResults.some((r) => r.id === lastQ.label)) out.fees = 1;
  }
  out.transactions = historyStatus.failing || state.errors.audit ? '!' : 0;
  return out;
}
const COUNT_TITLE = { alerts: 'high-priority alerts', holdings: 'maturities overdue or due this week', fees: 'quarter waiting to be closed', transactions: 'change history not switched on' };

// ---------- Theme (light / dark), saved per browser; index.html applies it before the first paint ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: the choice lasts this visit */ } },
};
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('abud-theme', t);
  render();
}
function themeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return h('button', { class: 'icon-btn', title: dark ? 'Switch to light mode' : 'Switch to dark mode', 'aria-label': dark ? 'Switch to light mode' : 'Switch to dark mode', onclick: () => setTheme(dark ? 'light' : 'dark') },
    icon(dark ? 'sun' : 'moon', 20));
}

// ---------- Notifications: today's alerts, with the ones not yet opened counted on the bell ----------
const notif = { open: false };
function seenKeys() {
  try { return new Set(JSON.parse(store.get('abud-seen-alerts') ?? '[]')); } catch { return new Set(); }
}
function markSeen(keys) {
  const seen = seenKeys();
  for (const k of keys) seen.add(k);
  store.set('abud-seen-alerts', JSON.stringify([...seen].slice(-500)));
}
function notifications(alerts) {
  const seen = seenKeys();
  const unseen = alerts.filter((a) => !seen.has(a.key));
  const bell = h('button', { class: 'icon-btn bell', 'aria-haspopup': 'true', 'aria-expanded': notif.open ? 'true' : 'false', title: 'Notifications', 'aria-label': `Notifications${unseen.length ? `: ${unseen.length} new` : ''}`, onclick: (e) => { e.stopPropagation(); notif.open = !notif.open; render(); } },
    icon('alerts', 20), unseen.length ? h('span', { class: 'bell-count' }, unseen.length > 99 ? '99+' : String(unseen.length)) : null);
  const panel = notif.open
    ? h('div', { class: 'notif-panel', role: 'dialog', 'aria-label': 'Notifications', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'notif-head' }, h('strong', null, 'Notifications'),
          unseen.length ? h('button', { class: 'link', onclick: () => { markSeen(alerts.map((a) => a.key)); render(); } }, 'Mark all as read') : null),
        alerts.length
          ? h('ul', { class: 'notif-list' }, alerts.slice(0, 30).map((a) => h('li', { class: seen.has(a.key) ? 'read' : 'unread' },
              h('a', { href: `#/${a.route}`, onclick: () => { markSeen([a.key]); notif.open = false; } },
                h('span', { class: `alert-level ${a.level}` }, a.level === 'high' ? 'High' : a.level === 'medium' ? 'Medium' : 'Low'),
                h('span', { class: 'notif-text' }, h('span', { class: 'notif-title' }, a.title), h('span', { class: 'muted small' }, a.detail))))))
          : h('p', { class: 'muted notif-empty' }, 'Nothing needs attention.'),
        h('a', { class: 'notif-all', href: '#/alerts', onclick: () => { notif.open = false; } }, 'See all alerts'))
    : null;
  return h('div', { class: 'notif-wrap' }, bell, panel);
}
document.addEventListener('click', () => { if (notif.open) { notif.open = false; render(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && notif.open) { notif.open = false; render(); } });

function render() {
  const key = currentRoute();
  const section = sectionOf(key);
  const errors = Object.entries(state.errors).filter(([name]) => !OPTIONAL.has(name));
  const alerts = currentAlerts();
  const counts = sectionCounts(alerts);
  let content;
  try {
    content = key === 'home' ? homeView(render, { sections: SECTIONS, counts, icon, countTitle: COUNT_TITLE }) : ROUTES[key].view(render);
  } catch (err) {
    console.error(err);
    content = h('div', { class: 'card bad' }, h('h2', null, 'Something went wrong on this screen'), h('p', null, err.message));
  }
  const badge = (id) => (counts[id] ? h('span', { class: 'nav-count', title: `${counts[id] === '!' ? '' : counts[id]} ${COUNT_TITLE[id] ?? ''}`.trim() }, String(counts[id])) : null);
  const subTabs = section && section.routes.length > 1
    ? h('nav', { class: 'section-tabs no-print', 'aria-label': section.label },
        section.routes.map((r) => h('a', { href: `#/${r}`, class: r === key ? 'active' : null, 'aria-current': r === key ? 'page' : null }, ROUTES[r].label)))
    : null;
  const title = key === 'home' ? 'Home' : section ? section.label : ROUTES[key].label;
  document.title = `${title} · ABUD Portfolio`;
  document.body.dataset.route = key;

  root.replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        brand(),
        h('nav', { 'aria-label': 'Main' },
          h('a', { href: '#/home', class: key === 'home' ? 'active' : null, 'aria-current': key === 'home' ? 'page' : null }, icon('home'), h('span', null, 'Home')),
          SECTIONS.map((s) => {
            const on = section?.id === s.id;
            return h('a', { href: `#/${s.routes[0]}`, class: on ? 'active' : null, 'aria-current': on ? 'page' : null }, icon(s.id), h('span', null, s.label), badge(s.id));
          })),
        h('div', { class: 'sidebar-foot' }, h('div', null, 'Access Holdings Plc'), h('div', { class: 'muted' }, 'Unclaimed dividend pool'))),
      h('header', { class: 'topbar' },
        brand('brand brand-top'),
        h('span', { class: 'topbar-title' }, title),
        h('div', { class: 'top-actions' }, notifications(alerts), themeButton())),
      h('main', { class: 'page' },
        errors.length ? h('div', { class: 'card bad' }, `Could not load: ${errors.map(([name, msg]) => `${name} (${msg})`).join('; ')}`) : null,
        state.stalled
          ? h('div', { class: 'card bad' },
              h('h2', null, 'The database is not responding'),
              h('p', null, 'Check the internet connection. If this is a new setup, create the Firestore database in the Firebase console (project abud-24577) and publish firestore.rules. See README.md.'))
          : null,
        subTabs,
        content),
      h('nav', { class: 'bottom-bar', 'aria-label': 'Quick' },
        BOTTOM.map((id) => {
          const s = SECTIONS.find((x) => x.id === id);
          const on = id === 'home' ? key === 'home' : section?.id === id;
          return h('a', { href: `#/${id === 'home' ? 'home' : s.routes[0]}`, class: `bb-tab ${on ? 'on' : ''}`, 'aria-current': on ? 'page' : null },
            icon(id, 22), h('span', null, id === 'home' ? 'Home' : s.label), id !== 'home' ? badge(id) : null);
        }))),
  );
  if (key === 'home') requestAnimationFrame(fitHome);
}

/** Phones: Home cards share the screen between the top bar and the bottom bar, as large as possible without scrolling. */
function fitHome() {
  const g = document.querySelector('.home-grid');
  if (!g) return;
  if (window.innerWidth > 860) { g.style.height = ''; return; }
  const bar = document.querySelector('.bottom-bar');
  const bottom = bar && bar.offsetHeight ? bar.getBoundingClientRect().top : window.innerHeight;
  const room = Math.floor(bottom - g.getBoundingClientRect().top - 12);
  g.style.height = room > 360 ? `${room}px` : '';
}
window.addEventListener('resize', () => { if (currentRoute() === 'home') fitHome(); });

let lastKey = currentRoute();
window.addEventListener('hashchange', () => {
  const key = currentRoute();
  if (key !== lastKey) window.scrollTo(0, 0);
  lastKey = key;
  render();
});
subscribe(render);
start();
render();
