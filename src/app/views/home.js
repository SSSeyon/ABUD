// Home: one card per section, with a count where something needs attention, under a one-line portfolio summary.
import { navSeries } from '../portfolio.js';
import { loadedAll, state } from '../store.js';
import { fmtCompact, fmtDate, h, todayISO } from '../ui.js';

const short = fmtCompact;

export function homeView(_rerender, { sections, counts, icon, countTitle }) {
  const today = todayISO();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  let summary = null;
  if (loadedAll(['transactions', 'instruments', 'fundPrices'])) {
    try {
      const last = navSeries(state.data, today).at(-1);
      if (last) summary = h('div', { class: 'home-summary' },
        h('span', null, 'NAV ', h('strong', null, short(last.nav))),
        h('span', null, 'Cash ', h('strong', null, short(last.cash))),
        h('span', null, 'Invested ', h('strong', null, short(last.holdingsValue))));
    } catch { summary = null; }
  }
  return h('div', { class: 'home' },
    h('div', { class: 'home-head' },
      h('div', null, h('p', { class: 'eyebrow' }, fmtDate(today)), h('h1', null, greeting)),
      summary),
    h('div', { class: 'home-grid', style: `--cards:${sections.length}` },
      sections.map((s) => {
        const k = counts[s.id];
        return h('a', { class: 'home-card', href: `#/${s.routes[0]}`, style: `--hc:${s.color}` },
          h('span', { class: 'hc-icon' }, icon(s.id, 22)),
          h('span', { class: 'hc-text' }, h('strong', null, s.label), h('span', null, s.desc)),
          k ? h('span', { class: 'hc-count', title: `${k === '!' ? '' : k} ${countTitle[s.id] ?? ''}`.trim() }, String(k)) : null);
      })));
}
