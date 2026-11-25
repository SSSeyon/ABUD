import { start, state, subscribe } from './store.js';
import { h } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { holdingsView } from './views/holdings.js';
import { settingsView } from './views/settings.js';
import { transactionsView } from './views/transactions.js';

const ROUTES = {
  dashboard: { label: 'Dashboard', view: dashboardView },
  holdings: { label: 'Holdings', view: holdingsView },
  transactions: { label: 'Transactions', view: transactionsView },
  settings: { label: 'Settings', view: settingsView },
};

const root = document.getElementById('app');

function currentRoute() {
  const key = location.hash.replace(/^#\/?/, '');
  return ROUTES[key] ? key : 'dashboard';
}

function render() {
  const key = currentRoute();
  const errors = Object.entries(state.errors);
  let content;
  try {
    content = ROUTES[key].view(render);
  } catch (err) {
    console.error(err);
    content = h('div', { class: 'card bad' }, h('h2', null, 'Something went wrong on this screen'), h('p', null, err.message));
  }

  root.replaceChildren(
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, 'ABUD Portfolio'),
      h(
        'nav',
        { 'aria-label': 'Main' },
        Object.entries(ROUTES).map(([k, r]) => h('a', { href: `#/${k}`, class: k === key ? 'active' : null, 'aria-current': k === key ? 'page' : null }, r.label)),
      ),
      h('div', { class: 'who' }, 'Access Holdings Plc · MBO Capital'),
    ),
    h(
      'main',
      { class: 'page' },
      errors.length ? h('div', { class: 'card bad' }, `Could not load: ${errors.map(([name, msg]) => `${name} (${msg})`).join('; ')}`) : null,
      state.stalled
        ? h(
            'div',
            { class: 'card bad' },
            h('h2', null, 'The database is not responding'),
            h('p', null, 'Check the internet connection. If this is a new setup, create the Firestore database in the Firebase console (project abud-24577) and publish firestore.rules. See README.md.'),
          )
        : null,
      content,
    ),
  );
}

window.addEventListener('hashchange', render);
subscribe(render);
start();
render();
