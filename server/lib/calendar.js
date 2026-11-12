// @ts-check
// Business calendar arithmetic on naive local datetimes ("YYYY-MM-DDTHH:mm").
// Day 0 is the period end date. BD 0 is Day 0 when it is a business day, otherwise the last
// business day on or before it. BD +n is the nth business day after Day 0; BD -n is the nth
// business day before BD 0.

/** @typedef {{workdays:number[], holidays:Set<string>, dayStart:number, dayEnd:number}} Cal */

/** @param {{workdays?:number[]|string, holidays?:string[]|string, day_start?:number, day_end?:number}} [row] @returns {Cal} */
export function makeCalendar(row = {}) {
  const wd = typeof row.workdays === 'string' ? JSON.parse(row.workdays) : row.workdays || [1, 2, 3, 4, 5];
  const hol = typeof row.holidays === 'string' ? JSON.parse(row.holidays) : row.holidays || [];
  return { workdays: wd, holidays: new Set(hol.map((/** @type {any} */ h) => (typeof h === 'string' ? h : h.date))), dayStart: row.day_start ?? 540, dayEnd: row.day_end ?? 1020 };
}
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** @param {string} d */ const ms = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
/** @param {number} t */ const iso = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
/** @param {string} date @param {number} n */
export const addDays = (date, n) => iso(ms(date) + n * 86400000);
/** @param {string} date */ export const weekday = date => new Date(ms(date)).getUTCDay();
/** @param {Cal} cal @param {string} date */
export const isBusinessDay = (cal, date) => cal.workdays.includes(weekday(date)) && !cal.holidays.has(date);

/** @param {Cal} cal @param {string} day0 @param {number} offset @returns {string} date */
export function businessDayOffset(cal, day0, offset) {
  let d = day0, guard = 0;
  if (offset > 0) { let n = 0; while (n < offset) { d = addDays(d, 1); if (isBusinessDay(cal, d)) n++; if (++guard > 4000) throw new Error('Calendar has no business days'); } return d; }
  while (!isBusinessDay(cal, d)) { d = addDays(d, -1); if (++guard > 4000) throw new Error('Calendar has no business days'); }
  let n = 0; while (n < -offset) { d = addDays(d, -1); if (isBusinessDay(cal, d)) n++; if (++guard > 4000) throw new Error('Calendar has no business days'); }
  return d;
}
/** Business-day offset of a date relative to Day 0 (inverse of businessDayOffset, for display). @param {Cal} cal @param {string} day0 @param {string} date */
export function offsetOf(cal, day0, date) {
  const bd0 = businessDayOffset(cal, day0, 0); let n = 0, d = bd0;
  if (date > day0) { d = day0; while (d < date) { d = addDays(d, 1); if (isBusinessDay(cal, d)) n++; } return n; }
  while (d > date) { d = addDays(d, -1); if (isBusinessDay(cal, d)) n--; }
  return n;
}
const mins = (/** @type {string} */ dt) => (dt.length > 10 ? +dt.slice(11, 13) * 60 + +dt.slice(14, 16) : 0);
const at = (/** @type {string} */ date, /** @type {number} */ m) => `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Move forward to the next working instant (unchanged if already inside working hours). @param {Cal} cal @param {string} dt */
export function nextWorkInstant(cal, dt) {
  let date = dt.slice(0, 10), m = mins(dt), guard = 0;
  if (dt.length <= 10) m = cal.dayStart;
  while (!isBusinessDay(cal, date) || m >= cal.dayEnd) { date = addDays(date, 1); m = cal.dayStart; if (++guard > 4000) throw new Error('Calendar has no business days'); }
  if (m < cal.dayStart) m = cal.dayStart;
  return at(date, m);
}
/** Add working minutes. @param {Cal} cal @param {string} dt @param {number} minutes */
export function addWorkMinutes(cal, dt, minutes) {
  let cur = nextWorkInstant(cal, dt), left = Math.max(0, Math.round(minutes));
  while (left > 0) {
    const date = cur.slice(0, 10), m = mins(cur), room = cal.dayEnd - m;
    if (left <= room) return at(date, m + left);
    left -= room; cur = nextWorkInstant(cal, at(addDays(date, 1), 0));
  }
  return cur;
}
/** Subtract working minutes. @param {Cal} cal @param {string} dt @param {number} minutes */
export function subWorkMinutes(cal, dt, minutes) {
  let date = dt.slice(0, 10), m = dt.length > 10 ? mins(dt) : cal.dayEnd, left = Math.max(0, Math.round(minutes)), guard = 0;
  const prevDay = () => { do { date = addDays(date, -1); if (++guard > 4000) throw new Error('Calendar has no business days'); } while (!isBusinessDay(cal, date)); m = cal.dayEnd; };
  if (!isBusinessDay(cal, date) || m <= cal.dayStart) prevDay(); else if (m > cal.dayEnd) m = cal.dayEnd;
  while (left > 0) { const room = m - cal.dayStart; if (left <= room) return at(date, m - left); left -= room; prevDay(); }
  return at(date, m);
}
/** Working minutes between two instants (0 when b <= a). @param {Cal} cal @param {string} a @param {string} b */
export function workMinutesBetween(cal, a, b) {
  if (!a || !b || b <= a) return 0;
  let total = 0, date = a.slice(0, 10), guard = 0; const endDate = b.slice(0, 10);
  while (date <= endDate) {
    if (isBusinessDay(cal, date)) {
      const s = date === a.slice(0, 10) ? Math.min(Math.max(mins(a), cal.dayStart), cal.dayEnd) : cal.dayStart;
      const e = date === endDate ? Math.min(Math.max(b.length > 10 ? mins(b) : cal.dayEnd, cal.dayStart), cal.dayEnd) : cal.dayEnd;
      if (e > s) total += e - s;
    }
    date = addDays(date, 1); if (++guard > 4000) break;
  }
  return total;
}
/** Fiscal periods for a 52-week 4-4-5 / 4-5-4 / 5-4-4 year. @param {string} yearStart @param {'4-4-5'|'4-5-4'|'5-4-4'} [pattern] */
export function fiscalPeriods445(yearStart, pattern = '4-4-5') {
  const weeks = pattern.split('-').map(Number); const out = []; let start = yearStart;
  for (let q = 0; q < 4; q++) for (let i = 0; i < 3; i++) { const end = addDays(start, weeks[i] * 7 - 1); out.push({ index: q * 3 + i + 1, quarter: q + 1, start, end, weeks: weeks[i] }); start = addDays(end, 1); }
  return out;
}
/** Calendar-month periods. @param {number} year @param {number} month 1-12 */
export function monthPeriod(year, month) {
  const start = `${year}-${pad(month)}-01`; const end = iso(Date.UTC(year, month, 0));
  return { start, end, name: new Date(ms(start)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + year };
}
/** Current naive local time for an IANA timezone. @param {string} tz @param {Date} [d] */
export function localNow(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
