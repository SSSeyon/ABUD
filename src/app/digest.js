// Daily digest (07:00 Lagos): alerts, maturities due, cash to deploy and the top three reinvestment options.
// Pure: built from loaded data, so the app (Alerts > Preview) and the scheduled job (digest.html) share it.
import { dec } from '../engine/index.js';
import { computeAlerts, limitsFrom } from './alerts.js';
import { rankOpportunities } from './market.js';
import { expectedMaturityValue, maturityWatch, navSeries, TYPE_LABELS } from './portfolio.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const naira = (x) => `₦${Number(dec(x).toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x, dp = 2) => `${dec(x).times(100).toFixed(dp)}%`;
const LEVEL = { high: 'High', medium: 'Medium', low: 'Low' };

/**
 * @returns {{subject: string, html: string, text: string, counts: {high: number, medium: number, low: number}}}
 */
export function buildDigest(data, today, appUrl = '') {
  const limits = limitsFrom(data, today);
  const alerts = computeAlerts(data, today, limits);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const a of alerts) counts[a.level] += 1;
  const watch = maturityWatch(data, today, 7);
  const nav = navSeries(data, today).at(-1);
  let opp = { ranked: [], cashToDeploy: dec(0) };
  try { opp = rankOpportunities(data, today, limits); } catch { /* no market data yet */ }
  const top = opp.ranked.slice(0, 3);
  const plural = counts.high + counts.medium === 1 ? '' : 's';
  const subject = `ABUD ${today}: ${counts.high} high, ${counts.medium} medium alert${plural}${watch.due.length ? ` · ${watch.due.length} maturing this week` : ''}`;
  const dueLine = (i, over) => `- ${over ? 'OVERDUE ' : ''}${i.maturityDate} ${TYPE_LABELS[i.type]} ${i.counterpartyName ?? ''}: ${naira(expectedMaturityValue(i))}`;

  const lines = [
    `ABUD portfolio digest for ${today}`,
    nav ? `NAV ${naira(nav.nav)} · cash ${naira(nav.cash)} · cash to deploy ${naira(opp.cashToDeploy)}` : null,
    '',
    `ALERTS (${alerts.length})`,
    ...(alerts.length ? alerts.map((a) => `- [${LEVEL[a.level]}] ${a.title}. ${a.detail}`) : ['- Nothing needs attention.']),
    '',
    'MATURING IN THE NEXT 7 DAYS',
    ...watch.overdue.map((i) => dueLine(i, true)),
    ...(watch.due.length ? watch.due.map((i) => dueLine(i, false)) : watch.overdue.length ? [] : ['- None.']),
    '',
    'TOP OPTIONS FOR CASH',
    ...(top.length ? top.map((o) => `- ${o.label}: ${pct(o.yield)} for ${o.tenorDays} days, up to ${naira(o.amount)} (${o.source})`) : ['- No ranked options (no recent market data, or no cash to deploy).']),
    appUrl ? `\nOpen the app: ${appUrl}` : null,
  ];
  const text = lines.filter((l) => l !== null).join('\n');

  const td = 'padding:6px 8px;border-bottom:1px solid #e8e8ea;vertical-align:top;';
  const color = { high: '#c4122f', medium: '#b36b00', low: '#6d6e71' };
  const section = (title, body) => `<h2 style="font-size:15px;margin:22px 0 8px;color:#222">${esc(title)}</h2>${body}`;
  const rows = (list) => `<table style="border-collapse:collapse;width:100%;font-size:13px">${list.join('')}</table>`;
  const alertRows = alerts.map((a) => `<tr><td style="${td}width:70px;color:${color[a.level]};font-weight:600">${LEVEL[a.level]}</td><td style="${td}"><b>${esc(a.title)}</b><br><span style="color:#555">${esc(a.detail)}</span></td></tr>`);
  const dueRows = [...watch.overdue.map((i) => [i, true]), ...watch.due.map((i) => [i, false])].map(([i, over]) => `<tr><td style="${td}width:110px;${over ? 'color:#c4122f;font-weight:600' : ''}">${esc(i.maturityDate)}${over ? ' (overdue)' : ''}</td><td style="${td}">${esc(TYPE_LABELS[i.type])}, ${esc(i.counterpartyName ?? '')}</td><td style="${td}text-align:right">${naira(expectedMaturityValue(i))}</td></tr>`);
  const oppRows = top.map((o) => `<tr><td style="${td}"><b>${esc(o.label)}</b><br><span style="color:#555">${esc(o.source)}${o.notes?.length ? ` · ${esc(o.notes.join(', '))}` : ''}</span></td><td style="${td}text-align:right">${pct(o.yield)}<br><span style="color:#555">${o.tenorDays} days</span></td><td style="${td}text-align:right">up to ${naira(o.amount)}</td></tr>`);
  const html = [
    '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px;color:#222">',
    `<div style="border-bottom:3px solid #c4122f;padding-bottom:8px"><span style="font-weight:700;color:#c4122f;font-size:20px">mbo</span><span style="color:#6d6e71;font-size:20px">capital</span><span style="float:right;color:#6d6e71;font-size:13px;padding-top:6px">ABUD portfolio · ${esc(today)}</span></div>`,
    nav ? `<p style="font-size:14px">NAV <b>${naira(nav.nav)}</b> · cash ${naira(nav.cash)} · cash to deploy <b>${naira(opp.cashToDeploy)}</b></p>` : '',
    section(`Alerts: ${counts.high} high, ${counts.medium} medium, ${counts.low} low`, alertRows.length ? rows(alertRows) : '<p>Nothing needs attention.</p>'),
    section('Maturing in the next 7 days', dueRows.length ? rows(dueRows) : '<p>None.</p>'),
    section('Top options for cash', oppRows.length ? rows(oppRows) : '<p>No ranked options (no recent market data, or no cash to deploy).</p>'),
    appUrl ? `<p style="margin-top:22px"><a href="${esc(appUrl)}#/alerts" style="color:#c4122f">Open alerts in the app</a></p>` : '',
    '<p style="color:#888;font-size:11px;margin-top:18px">Sent by the ABUD Portfolio daily digest (GitHub Actions). Figures are computed from the app\'s data at send time.</p></div>',
  ].join('\n');
  return { subject, html, text, counts };
}
