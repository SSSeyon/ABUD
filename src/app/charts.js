// Small inline-SVG charts: a NAV line with hover read-out, and an allocation bar with legend.
// Colours come from CSS tokens (--class-<key>, --chart-*), so light and dark mode are handled in styles.css.
import { dec } from '../engine/decimal.js';
import { fmtDate, fmtNaira, h } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Short naira for axes: ₦2.26bn, ₦624.1m, ₦85k. */
export function fmtShort(x) {
  const n = Number(x);
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}₦${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}bn`;
  if (a >= 1e6) return `${sign}₦${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
  if (a >= 1e3) return `${sign}₦${(a / 1e3).toFixed(0)}k`;
  return `${sign}₦${a.toFixed(0)}`;
}

function niceTicks(min, max, count = 4) {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  // Last tick at or above the maximum, so the line never runs past the top gridline.
  for (let v = lo; ; v += step) {
    ticks.push(v);
    if (v >= max - step * 1e-9) break;
  }
  return ticks;
}

/**
 * Line chart of one series over dates, with a crosshair and tooltip on hover.
 * points: [{date, value}] (value a Decimal or number). label names the series in the tooltip.
 */
export function lineChart(points, { label = 'NAV', height = 240 } = {}) {
  const wrap = h('div', { class: 'chart', role: 'img', 'aria-label': `${label} from ${fmtDate(points[0]?.date)} to ${fmtDate(points.at(-1)?.date)}` });
  if (points.length < 2) {
    wrap.append(h('p', { class: 'muted empty' }, 'Not enough data to chart.'));
    return wrap;
  }
  // Down-sample long ranges so the path stays light; always keep the last point.
  const stride = Math.ceil(points.length / 500);
  const pts = points.filter((_, i) => i % stride === 0 || i === points.length - 1).map((p) => ({ date: p.date, v: Number(p.value) }));
  const W = 800;
  const H = height;
  const pad = { l: 64, r: 12, t: 12, b: 26 };
  const vals = pts.map((p) => p.v);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals));
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  for (const t of ticks) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' }, fmtShort(t)));
  }
  // Short ranges label day and month; long ones month and year.
  const span = (Date.parse(pts.at(-1).date) - Date.parse(pts[0].date)) / 864e5;
  const tickLabel = (d) => (span < 200 ? fmtDate(d).replace(/ \d{4}$/, '') : fmtDate(d).replace(/^\d+ /, ''));
  const xLabels = 5;
  for (let k = 0; k < xLabels; k++) {
    const i = Math.round((k / (xLabels - 1)) * (pts.length - 1));
    svg.append(s('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': k === 0 ? 'start' : k === xLabels - 1 ? 'end' : 'middle' }, tickLabel(pts[i].date)));
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  svg.append(s('path', { d: `${line}L${x(pts.length - 1)},${y(yMin)}L${x(0)},${y(yMin)}Z`, class: 'area' }));
  svg.append(s('path', { d: line, class: 'line' }));

  const cross = s('line', { y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' });
  const dot = s('circle', { r: 5, class: 'dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const hit = s('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: 'transparent' });
  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const fx = ((clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((fx - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
    const px = x(i);
    const py = y(pts[i].v);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'tip-date' }, fmtDate(pts[i].date)), h('div', null, `${label} `, h('strong', null, fmtNaira(dec(pts[i].v)))));
    tip.hidden = false;
    const left = (px / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    tip.style.top = `${(py / H) * box.height}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
  svg.append(hit);
  wrap.append(svg, tip);
  return wrap;
}

/**
 * One horizontal bar split by class, with a legend that carries the names, values and shares.
 * parts: [{key, label, value}] in the fixed class order; zero parts are skipped.
 */
export function allocationBar(parts) {
  const live = parts.filter((p) => dec(p.value).gt(0));
  const total = live.reduce((t, p) => t.plus(p.value), dec(0));
  if (total.isZero()) return h('p', { class: 'muted empty' }, 'Nothing held.');
  const share = (p) => dec(p.value).div(total);
  const bar = h(
    'div',
    { class: 'alloc-bar', role: 'img', 'aria-label': live.map((p) => `${p.label} ${share(p).times(100).toFixed(1)}%`).join(', ') },
    live.map((p) => h('span', { class: 'alloc-seg', style: `flex-grow:${Number(share(p))};background:var(--class-${p.key})`, title: `${p.label}: ${fmtNaira(p.value)} (${share(p).times(100).toFixed(1)}%)` })),
  );
  const legend = h(
    'ul',
    { class: 'legend' },
    live.map((p) =>
      h(
        'li',
        null,
        h('span', { class: 'swatch', style: `background:var(--class-${p.key})` }),
        h('span', { class: 'legend-label' }, p.label),
        h('span', { class: 'legend-value' }, fmtNaira(p.value)),
        h('span', { class: 'legend-share' }, `${share(p).times(100).toFixed(1)}%`),
      ),
    ),
  );
  return h('div', { class: 'alloc' }, bar, legend);
}
