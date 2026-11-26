// Counterparty register (banks, CP issuers, fund managers, custodians) with rating history, the minimum-rating
// limit, and exposure by counterparty and by custodian. Pure functions over the loaded data (testable).
import { dec, ZERO } from '../engine/index.js';
import { holdingsOn, navSeries, TYPE_LABELS } from './portfolio.js';
import { fmtNaira } from './ui.js';

/** Long-term national scale, best first. Agusto, GCR, DataPro, Fitch and S&P all map onto it. */
export const RATING_SCALE = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC', 'CC', 'C', 'D'];
export const AGENCIES = ['Agusto', 'GCR', 'DataPro', 'Fitch', "Moody's", 'S&P'];
export const KINDS = [
  { key: 'bank', label: 'Bank' },
  { key: 'issuer', label: 'CP issuer' },
  { key: 'fund_manager', label: 'Fund manager' },
  { key: 'custodian', label: 'Custodian' },
];
/** Federal Government paper carries no counterparty rating test. */
const FGN = new Set(['ntb', 'omo']);

const MOODYS = { Aaa: 'AAA', Aa1: 'AA+', Aa2: 'AA', Aa3: 'AA-', A1: 'A+', A2: 'A', A3: 'A-', Baa1: 'BBB+', Baa2: 'BBB', Baa3: 'BBB-', Ba1: 'BB+', Ba2: 'BB', Ba3: 'BB-', B1: 'B+', B2: 'B', B3: 'B-', Caa1: 'CCC', Caa2: 'CCC', Caa3: 'CCC', Ca: 'CC', C: 'C' };

/** "Aa-(NG)", "A+ (ngn)", "Baa1", "bbb−" → the scale's form, or null when not a recognised rating. */
export function normRating(r) {
  if (!r) return null;
  let s = String(r).trim().replace(/\s*\(.*\)\s*$/, '').replace(/[−–]/g, '-').replace(/\s+/g, '');
  if (MOODYS[s]) return MOODYS[s];
  s = s.toUpperCase();
  return RATING_SCALE.includes(s) ? s : null;
}

/** Position on the scale (0 = AAA); null when unrated or unrecognised. */
export function ratingRank(r) {
  const n = normRating(r);
  return n ? RATING_SCALE.indexOf(n) : null;
}

/** True when the rating is at or above the minimum. Unrated is not "below": it is flagged separately. */
export function belowMinimum(rating, minRating) {
  const a = ratingRank(rating);
  const m = ratingRank(minRating);
  return a != null && m != null && a > m;
}

const normName = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/\b(plc|limited|ltd|nigeria|nig|company|co)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** The register entry for a name (matching the name or any alias, ignoring Plc, Limited, punctuation). */
export function findCounterparty(data, name) {
  const n = normName(name);
  if (!n) return null;
  return (data.counterparties ?? []).find((c) => normName(c.name) === n || String(c.aliases ?? '').split(',').some((a) => a.trim() && normName(a) === n)) ?? null;
}

/** Ratings for a counterparty, newest first. */
export function ratingHistory(data, cpId) {
  return (data.ratings ?? []).filter((r) => r.counterpartyId === cpId).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Rating in force on a date: each agency's latest rating on or before it, and the lowest of those (conservative).
 * @returns {{rating: string, agency: string, date: string} | null}
 */
export function ratingOn(data, cpId, date) {
  const latest = new Map();
  for (const r of ratingHistory(data, cpId)) {
    if (r.date > date || latest.has(r.agency)) continue;
    if (normRating(r.rating)) latest.set(r.agency, r);
  }
  let worst = null;
  for (const r of latest.values()) if (!worst || ratingRank(r.rating) > ratingRank(worst.rating)) worst = r;
  return worst ? { rating: normRating(worst.rating), agency: worst.agency, date: worst.date } : null;
}

/** Downgrades within `days` of today: an agency's latest rating lower than its previous one. */
export function recentDowngrades(data, cpId, today, days = 30) {
  const byAgency = new Map();
  for (const r of ratingHistory(data, cpId).filter((x) => x.date <= today)) {
    const list = byAgency.get(r.agency) ?? byAgency.set(r.agency, []).get(r.agency);
    list.push(r);
  }
  const out = [];
  const since = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  for (const [agency, list] of byAgency) {
    const [now, prev] = list;
    if (prev && now.date >= since && ratingRank(now.rating) > ratingRank(prev.rating)) out.push({ agency, from: normRating(prev.rating), to: normRating(now.rating), date: now.date });
  }
  return out;
}

/** Who a holding's money sits with: the bank or issuer, or for a fund its manager. */
export function counterpartyName(inst, funds = []) {
  if (inst.type === 'money_market_fund') return funds.find((f) => f.id === inst.fundId)?.managerName ?? inst.counterpartyName ?? 'Fund';
  if (FGN.has(inst.type)) return 'Federal Government of Nigeria';
  return inst.counterpartyName || TYPE_LABELS[inst.type];
}

/**
 * Holdings on a date grouped by counterparty, with the share of NAV and the rating in force.
 * @returns {{name, value, share, count, fgn, cp, rating, below}[]} largest first
 */
export function exposures(data, date, minRating) {
  const held = holdingsOn(data, date);
  const nav = navSeries(data, date).at(-1)?.nav ?? ZERO;
  const map = new Map();
  for (const { inst, value } of held) {
    const name = counterpartyName(inst, data.funds);
    const e = map.get(name) ?? map.set(name, { name, value: ZERO, count: 0, fgn: FGN.has(inst.type) }).get(name);
    e.value = e.value.plus(value);
    e.count += 1;
  }
  return [...map.values()].map((e) => {
    const cp = e.fgn ? null : findCounterparty(data, e.name);
    const rating = cp ? ratingOn(data, cp.id, date) : null;
    return { ...e, share: nav.isZero() ? ZERO : e.value.div(nav), cp, rating, below: rating ? belowMinimum(rating.rating, minRating) : false };
  }).sort((a, b) => b.value.cmp(a.value));
}

/** Holdings on a date grouped by custodian (blank custodian shown as "Not recorded"). */
export function custodianExposure(data, date) {
  const map = new Map();
  for (const { inst, value } of holdingsOn(data, date)) {
    const name = inst.custodianName?.trim() || 'Not recorded';
    const e = map.get(name) ?? map.set(name, { name, value: ZERO, count: 0 }).get(name);
    e.value = e.value.plus(value);
    e.count += 1;
  }
  return [...map.values()].sort((a, b) => b.value.cmp(a.value));
}

/** Refusal message for a new deal with a counterparty rated below the minimum; null when it may go ahead. */
export function dealRatingCheck(data, inst, minRating, date) {
  if (!minRating || FGN.has(inst.type)) return null;
  const name = inst.type === 'money_market_fund' ? counterpartyName(inst, data.funds) : inst.counterpartyName;
  const cp = findCounterparty(data, name);
  const r = cp ? ratingOn(data, cp.id, date) : null;
  if (r && belowMinimum(r.rating, minRating)) return `${cp.name} is rated ${r.rating} (${r.agency}, ${r.date}), below the ${minRating} minimum in Settings > Limits.`;
  return null;
}

/** Rating alerts for today's holdings: below minimum (high), recent downgrade (medium), unrated names (low). */
export function ratingAlerts(data, today, minRating) {
  if (!Array.isArray(data.counterparties) || !Array.isArray(data.ratings)) return [];
  const out = [];
  let ex = [];
  try { ex = exposures(data, today, minRating); } catch { ex = []; }
  const unrated = [];
  for (const e of ex.filter((x) => !x.fgn)) {
    if (!e.rating) { unrated.push(e.name); continue; }
    if (e.below) out.push({ key: `rating-low-${e.name}`, level: 'high', title: `Rating below minimum: ${e.name} (${e.rating.rating})`, detail: `${fmtNaira(e.value)} held. ${e.rating.agency} rated it ${e.rating.rating} on ${e.rating.date}; the minimum is ${minRating}. Plan an exit at maturity or earlier.`, route: 'counterparties', sort: e.rating.date });
    for (const d of recentDowngrades(data, e.cp.id, today)) {
      out.push({ key: `downgrade-${e.name}-${d.agency}-${d.date}`, level: 'medium', title: `Downgrade: ${e.name} ${d.from} → ${d.to} (${d.agency})`, detail: `On ${d.date}. ${fmtNaira(e.value)} held (${dec(e.share).times(100).toFixed(1)}% of NAV).`, route: 'counterparties', sort: d.date });
    }
  }
  if (unrated.length) out.push({ key: `unrated-${unrated.length}`, level: 'low', title: `${unrated.length} counterpart${unrated.length === 1 ? 'y has' : 'ies have'} no rating recorded`, detail: `${unrated.slice(0, 5).join(', ')}${unrated.length > 5 ? '…' : ''}. Add them on the Counterparties screen.`, route: 'counterparties', sort: today });
  return out;
}
