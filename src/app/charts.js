// Small inline-SVG charts: a NAV line with hover read-out, and an allocation bar with legend.
// Colours come from CSS tokens (--class-<key>, --chart-*), so light and dark mode are handled in styles.css.
import { dec } from '../engine/decimal.js';
import { fmtCompact, fmtDate, fmtNaira, h } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Short naira for axes and labels, no decimals: ₦2,260m, ₦624m, ₦85k. */
export const fmtShort = fmtCompact;

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

/**
 * Grouped bars: one group per category, one bar per series (at most 3), legend above, hover read-out per group.
 * series: [{label, values: (number|null)[], cls: 'series-a'|'series-b'|'series-c'}]; format(value) for axis and tooltip.
 * Bars grow from zero, so negative values hang below the baseline.
 */
export function groupedBars(categories, series, { format = fmtShort, height = 240, label = 'Chart' } = {}) {
  const wrap = h('div', { class: 'chart', role: 'img', 'aria-label': `${label}: ${series.map((x) => x.label).join(', ')} by ${categories.length} periods` });
  if (!categories.length) {
    wrap.append(h('p', { class: 'muted empty' }, 'Nothing to chart.'));
    return wrap;
  }
  wrap.append(h('div', { class: 'legend-row' }, series.map((x) => h('span', { class: 'legend-item' }, h('span', { class: `swatch ${x.cls}` }), x.label))));
  const W = 800;
  const H = height;
  const pad = { l: 64, r: 12, t: 12, b: 26 };
  const vals = series.flatMap((x) => x.values).filter((v) => v != null);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const groupW = (W - pad.l - pad.r) / categories.length;
  const gap = 2;
  const barW = Math.max(2, Math.min(18, (groupW * 0.8 - gap * (series.length - 1)) / series.length));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  for (const t of ticks) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' }, format(t)));
  }
  const every = Math.ceil(categories.length / 8);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  categories.forEach((cat, i) => {
    const gx = pad.l + i * groupW;
    const inner = series.length * barW + (series.length - 1) * gap;
    const start = gx + (groupW - inner) / 2;
    series.forEach((x, k) => {
      const v = x.values[i];
      if (v == null) return;
      const y0 = y(0);
      const y1 = y(v);
      svg.append(s('rect', { x: start + k * (barW + gap), y: Math.min(y0, y1), width: barW, height: Math.max(1, Math.abs(y1 - y0)), rx: Math.min(3, barW / 2), class: `bar ${x.cls}` }));
    });
    if (i % every === 0) svg.append(s('text', { x: gx + groupW / 2, y: H - 6, class: 'axis', 'text-anchor': 'middle' }, cat));
    const hit = s('rect', { x: gx, y: pad.t, width: groupW, height: H - pad.t - pad.b, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      const box = svg.getBoundingClientRect();
      tip.replaceChildren(h('div', { class: 'tip-date' }, cat), ...series.map((x) => h('div', null, h('span', { class: `swatch ${x.cls}` }), ` ${x.label} `, h('strong', null, x.values[i] == null ? '—' : format(x.values[i])))));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(((gx + groupW / 2) / W) * box.width, 90), box.width - 90)}px`;
      tip.style.top = `${box.height * 0.45}px`;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(hit);
  });
  svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'baseline' }));
  wrap.append(svg, tip);
  return wrap;
}

/**
 * Sankey in the Apowo cash-flow style: money in (left) flows straight to where it went (right), each source feeding
 * each target in proportion to its size, the band shading from the source's colour to the target's.
 * left/right: [{label, value (number or Decimal), color (CSS colour or var)}]; zero values are dropped.
 * Each target is labelled on one line beside its bar ("Fixed deposits ₦1,203m (52%)", share of money in); the
 * sources are listed under the chart, top to bottom as their bars are. Hover a band for "from → to". Redraws at its
 * real width (ResizeObserver). A figures table follows. `middle` is kept for callers and only used in the aria label.
 */
let skId = 0;
export function sankey(left, right, { middle = 'Portfolio', height = 360, format = fmtShort, label = 'Money flows' } = {}) {
  const L = left.map((x) => ({ ...x, v: Number(x.value) })).filter((x) => x.v > 0);
  const R = right.map((x) => ({ ...x, v: Number(x.value) })).filter((x) => x.v > 0);
  const inTotal = L.reduce((t, x) => t + x.v, 0);
  const outTotal = R.reduce((t, x) => t + x.v, 0);
  const total = Math.max(inTotal, outTotal);
  const base = inTotal || outTotal;
  const wrap = h('div', { class: 'chart sankey', role: 'img', 'aria-label': `${label}: from ${L.map((x) => `${x.label} ${format(x.v)}`).join(', ')}; to ${R.map((x) => `${x.label} ${format(x.v)}`).join(', ')}` });
  if (!total) { wrap.append(h('p', { class: 'muted empty' }, 'No flows in this period.')); return wrap; }
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const pct = (v) => `${Math.round((v / base) * 100)}%`;
  const id = `sk${++skId}`;

  const draw = (W) => {
    const lh = 15;
    const nodeW = 12;
    const padT = 6;
    const padB = 14 + lh * L.length; // source labels go under the chart
    const H = height + lh * Math.max(0, L.length - 2);
    const ph = H - padT - padB;
    const stack = (list) => {
      const gap = list.length > 1 ? Math.min(16, (ph * 0.25) / (list.length - 1)) : 0;
      const avail = ph - gap * (list.length - 1);
      let y = padT;
      return list.map((x) => { const n = { ...x, y, h: Math.max(1.5, (x.v / total) * avail), inOff: 0, outOff: 0 }; y += n.h + gap; return n; });
    };
    const ln = stack(L);
    const rn = stack(R);
    const xL = 0;
    const xR = W - nodeW;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg' });
    const defs = s('defs');
    svg.append(defs);
    const showTip = (e, lines) => {
      const box = wrap.getBoundingClientRect();
      tip.replaceChildren(...lines.map((t, i) => h('div', { class: i ? null : 'tip-date' }, t)));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(e.clientX - box.left, 110), box.width - 110)}px`;
      tip.style.top = `${e.clientY - box.top}px`;
    };
    // Bands: source i → target j carries vi × vj / total, stacked in order on both sides.
    let g = 0;
    for (const a of ln) {
      for (const b of rn) {
        const f = (a.v * b.v) / total;
        if (f <= 0) continue;
        const h0 = (f / a.v) * a.h;
        const h1 = (f / b.v) * b.h;
        const y0 = a.y + a.outOff;
        const y1 = b.y + b.inOff;
        a.outOff += h0;
        b.inOff += h1;
        const gid = `${id}-${g++}`;
        defs.append(s('linearGradient', { id: gid, x1: '0', x2: '1', y1: '0', y2: '0' },
          s('stop', { offset: '0', style: `stop-color:${a.color}` }), s('stop', { offset: '1', style: `stop-color:${b.color}` })));
        const x0 = xL + nodeW;
        const x1 = xR;
        const c = (x0 + x1) / 2;
        const d = `M${x0},${y0}C${c},${y0} ${c},${y1} ${x1},${y1}L${x1},${y1 + h1}C${c},${y1 + h1} ${c},${y0 + h0} ${x0},${y0 + h0}Z`;
        const p = s('path', { d, class: 'sk-band', fill: `url(#${gid})` });
        p.addEventListener('pointermove', (e) => showTip(e, [`${a.label} → ${b.label}`, `${format(f)} (${pct(f)})`]));
        p.addEventListener('pointerleave', () => { tip.hidden = true; });
        svg.append(p);
      }
    }
    for (const n of [...ln.map((x) => [xL, x]), ...rn.map((x) => [xR, x])]) {
      const r = s('rect', { x: n[0], y: n[1].y, width: nodeW, height: n[1].h, class: 'sk-node', fill: n[1].color });
      r.addEventListener('pointermove', (e) => showTip(e, [n[1].label, `${format(n[1].v)} (${pct(n[1].v)})`]));
      r.addEventListener('pointerleave', () => { tip.hidden = true; });
      svg.append(r);
    }
    // Target labels: one line on the band, just left of the bar; nudged apart when bars are too close.
    const labels = rn.map((n) => ({ n, y: n.y + n.h / 2 })).sort((a, b) => a.y - b.y);
    let prev = padT + lh / 2 - lh;
    for (const t of labels) { t.y = Math.max(t.y, prev + lh); prev = t.y; }
    let lim = padT + ph - lh / 2 + 4;
    for (let i = labels.length - 1; i >= 0; i--) { labels[i].y = Math.min(labels[i].y, lim); lim = labels[i].y - lh; }
    for (const t of labels) {
      svg.append(s('text', { x: xR - 6, y: t.y + 4, 'text-anchor': 'end', class: 'sk-label' },
        s('tspan', { class: 'sk-name' }, t.n.label), s('tspan', { class: 'sk-val', dx: 5 }, `${format(t.n.v)} (${pct(t.n.v)})`)));
    }
    // Money in: under the chart, one line per source with its colour.
    ln.forEach((n, i) => {
      const y = padT + ph + 14 + i * lh;
      svg.append(s('rect', { x: xL, y: y - 8, width: 9, height: 9, fill: n.color, class: 'sk-key' }));
      svg.append(s('text', { x: xL + 14, y, class: 'sk-label sk-in' }, s('tspan', { class: 'sk-name' }, n.label), s('tspan', { class: 'sk-val', dx: 5 }, format(n.v))));
    });
    return svg;
  };

  const holder = h('div', { class: 'sk-holder' });
  let lastW = 0;
  const paint = () => {
    const W = Math.round(holder.clientWidth || 760);
    if (Math.abs(W - lastW) < 4) return;
    lastW = W;
    holder.replaceChildren(draw(W));
  };
  holder.append(draw(760));
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(paint).observe(holder);
  const rows = [...L.map((x) => ['In', x]), ...R.map((x) => ['Out', x])];
  const figures = h('details', { class: 'sk-figures' }, h('summary', null, 'Figures'),
    h('table', null, h('tbody', null, rows.map(([dir, x]) => h('tr', null,
      h('td', null, h('span', { class: 'swatch', style: `background:${x.color}` }), ` ${dir}: ${x.label}`),
      h('td', { class: 'num' }, fmtNaira(dec(x.value))), h('td', { class: 'num muted' }, pct(x.v)))))));
  wrap.append(holder, tip, figures);
  return wrap;
}

/**
 * Donut of parts [{label, value, color}] with the total in the middle, a hover read-out and a legend
 * (name, amount, share) underneath, so no figure depends on colour alone.
 */
export function donut(parts, { label = 'Chart', centre = 'Total', size = 200 } = {}) {
  const live = parts.map((p) => ({ ...p, v: Number(p.value) })).filter((p) => p.v > 0);
  const total = live.reduce((t, p) => t + p.v, 0);
  const wrap = h('div', { class: 'chart donut', role: 'img', 'aria-label': `${label}: ${live.map((p) => `${p.label} ${fmtShort(p.v)}`).join(', ')}` });
  if (!total) { wrap.append(h('p', { class: 'muted empty' }, 'Nothing to show for this period.')); return wrap; }
  const r = size / 2;
  const ring = 26;
  const rad = r - ring / 2 - 2;
  const C = 2 * Math.PI * rad;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'donut-svg' });
  svg.append(s('circle', { cx: r, cy: r, r: rad, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': ring }));
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const share = (v) => `${((v / total) * 100).toFixed(1)}%`;
  let at = 0;
  for (const p of live) {
    const len = (p.v / total) * C;
    const gap = live.length > 1 ? Math.min(2, len / 2) : 0;
    const arc = s('circle', {
      cx: r, cy: r, r: rad, fill: 'none', stroke: p.color, 'stroke-width': ring, class: 'donut-seg',
      'stroke-dasharray': `${Math.max(0, len - gap)} ${C}`, 'stroke-dashoffset': -at, transform: `rotate(-90 ${r} ${r})`,
    });
    arc.addEventListener('pointermove', (e) => {
      const box = wrap.getBoundingClientRect();
      tip.replaceChildren(h('div', { class: 'tip-date' }, p.label), h('div', null, `${fmtNaira(dec(p.value))} · ${share(p.v)}`));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(e.clientX - box.left, 90), box.width - 90)}px`;
      tip.style.top = `${e.clientY - box.top}px`;
    });
    arc.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(arc);
    at += len;
  }
  svg.append(s('text', { x: r, y: r - 4, 'text-anchor': 'middle', class: 'donut-total' }, fmtShort(total)));
  svg.append(s('text', { x: r, y: r + 14, 'text-anchor': 'middle', class: 'donut-caption' }, centre));
  const legend = h('ul', { class: 'legend' }, live.map((p) => h('li', null,
    h('span', { class: 'swatch', style: `background:${p.color}` }), h('span', { class: 'legend-label' }, p.label),
    h('span', { class: 'legend-value' }, fmtNaira(dec(p.value))), h('span', { class: 'legend-share' }, share(p.v)))));
  wrap.append(h('div', { class: 'donut-ring' }, svg), tip, legend);
  return wrap;
}

/** Horizontal bars for a list [{label, value, color}], all on one scale (max = the longest bar's scale). */
export function hBars(parts, { label = 'Chart', max } = {}) {
  const live = parts.map((p) => ({ ...p, v: Number(p.value) })).filter((p) => p.v > 0);
  const top = max ?? Math.max(0, ...live.map((p) => p.v));
  if (!top) return h('p', { class: 'muted empty' }, 'Nothing to show for this period.');
  return h('ul', { class: 'hbars', role: 'img', 'aria-label': `${label}: ${live.map((p) => `${p.label} ${fmtShort(p.v)}`).join(', ')}` },
    live.map((p) => h('li', { title: `${p.label}: ${fmtNaira(dec(p.value))}` },
      h('span', { class: 'hbar-label' }, p.label),
      h('span', { class: 'hbar-track' }, h('span', { class: 'hbar', style: `width:${Math.max(0.6, (p.v / top) * 100)}%;background:${p.color}` })),
      h('span', { class: 'hbar-value' }, fmtShort(p.v)))));
}

/** Money flows as two side-by-side views (where it came from, where it went) in the chosen form: 'bars' or 'donut'. */
export function flowsAs(kind, left, right) {
  const sum = (l) => l.reduce((t, x) => t + Number(x.value), 0);
  const max = Math.max(...[...left, ...right].map((x) => Number(x.value)), 0);
  const side = (title, list, centre) => h('div', { class: 'flow-side' }, h('h3', null, `${title} · ${fmtShort(sum(list))}`),
    kind === 'donut' ? donut(list, { label: title, centre }) : hBars(list, { label: title, max }));
  return h('div', { class: 'flow-pair' }, side('Where the money came from', left, 'in'), side('Where it went', right, 'out'));
}

/** Segmented control: options [[value, label]], the current value, onPick(value). */
export function segmented(options, value, onPick, label = 'Chart type') {
  return h('div', { class: 'seg no-print', role: 'group', 'aria-label': label },
    options.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': v === value ? 'true' : 'false', onclick: () => onPick(v) }, l)));
}
