// Calendar dates are ISO strings (YYYY-MM-DD). They sort and compare correctly as strings.

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 (UTC). Throws on malformed or impossible dates. @param {string} d */
export function dayNumber(d) {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`Invalid date "${d}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.UTC(y, mo - 1, day);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== day) {
    throw new Error(`Invalid date "${d}"`);
  }
  return t / MS_PER_DAY;
}

/** @param {number} n */
export function fromDayNumber(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** @param {string} d @param {number} n */
export function addDays(d, n) {
  return fromDayNumber(dayNumber(d) + n);
}

/** Actual days from a to b (b - a). @param {string} a @param {string} b */
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

/** Every calendar day from start to end, both inclusive. @param {string} start @param {string} end */
export function eachDay(start, end) {
  const out = [];
  for (let n = dayNumber(start), last = dayNumber(end); n <= last; n++) out.push(fromDayNumber(n));
  return out;
}

/** Add calendar months, clamping to month end (31 Jan + 1 month = 28/29 Feb). @param {string} d @param {number} months */
export function addMonths(d, months) {
  dayNumber(d);
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7)) - 1 + months;
  const day = Number(d.slice(8, 10));
  const targetYear = y + Math.floor(mo / 12);
  const targetMonth = ((mo % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return fromDayNumber(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)) / MS_PER_DAY);
}

/** @param {string} d */
export function isWeekend(d) {
  const wd = new Date(dayNumber(d) * MS_PER_DAY).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Nigerian business-day calendar: weekends plus a supplied list of public holidays. */
export class BusinessCalendar {
  /** @param {Iterable<string>} [holidays] */
  constructor(holidays = []) {
    this.holidays = new Set(holidays);
    for (const h of this.holidays) dayNumber(h);
  }

  /** @param {string} d */
  isBusinessDay(d) {
    return !isWeekend(d) && !this.holidays.has(d);
  }
}

/**
 * @typedef {{ year: number, q: 1|2|3|4, label: string, start: string, end: string, days: number }} Quarter
 */

/** @param {number} year @param {1|2|3|4} q @returns {Quarter} */
export function quarter(year, q) {
  const startMonth = (q - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const end = addDays(addMonths(start, 3), -1);
  return { year, q, label: `${year}Q${q}`, start, end, days: daysBetween(start, end) + 1 };
}

/** @param {string} d */
export function quarterOf(d) {
  dayNumber(d);
  const month = Number(d.slice(5, 7));
  return quarter(Number(d.slice(0, 4)), /** @type {1|2|3|4} */ (Math.floor((month - 1) / 3) + 1));
}

/** @param {string} label e.g. "2026Q1" */
export function parseQuarterLabel(label) {
  const m = /^(\d{4})Q([1-4])$/.exec(label);
  if (!m) throw new Error(`Invalid quarter "${label}" (expected e.g. 2026Q1)`);
  return quarter(Number(m[1]), /** @type {1|2|3|4} */ (Number(m[2])));
}
