import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, sum, translate, pctChange, exceeds } from '../../server/lib/decimal.js';
import { makeCalendar, businessDayOffset, offsetOf, addWorkMinutes, subWorkMinutes, workMinutesBetween, fiscalPeriods445, addDays } from '../../server/lib/calendar.js';
import { computeSchedule, findCycle } from '../../server/lib/schedule.js';
import { parseCsv, toCsv, safeCell, withHeader } from '../../server/lib/csv.js';
import { writeXlsx, readXlsx, writeDocx, readDocx, PdfDoc, readPdfText, zip, unzip } from '../../server/lib/files.js';
import { shingles, jaccard, seriesStem } from '../../server/lib/similarity.js';
import { buildFeedback, outlookUrl, mailtoUrl, FEEDBACK_TO, URL_SOFT_LIMIT, browserLabel } from '../../client/src/feedback-core.js';

// ---------- decimal-safe money ----------
test('amount parsing is exact and strict', () => {
  assert.equal(toMinor('1,234.56'), 123456); assert.equal(toMinor('(1,234.56)'), -123456); assert.equal(toMinor('-0.10'), -10); assert.equal(toMinor('12'), 1200); assert.equal(toMinor('12.5'), 1250); assert.equal(toMinor(''), null); assert.equal(toMinor('$ 1,000.00'), 100000); assert.equal(toMinor('100.00-'), -10000);
  assert.throws(() => toMinor('12.345'), /decimal places/); assert.throws(() => toMinor('abc'), /Not a decimal/); assert.throws(() => toMinor('1e5'), /Not a decimal/);
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3')); // 0.1 + 0.2 === 0.3 exactly, unlike binary floats
  assert.equal(fromMinor(-123456), '-1234.56'); assert.equal(fromMinor(5), '0.05');
});
test('sums, translation and rounding use integers only', () => {
  assert.equal(sum([10, 20, null, -5]), 25); assert.throws(() => sum([0.5]), /Non-integer/);
  assert.equal(translate(100000, '0.7250'), 72500); assert.equal(translate(64806897, '0.7250'), 46985000);
  assert.equal(translate(5, '0.5', 'half-up'), 3); assert.equal(translate(5, '0.5', 'half-even'), 2); assert.equal(translate(-5, '0.5', 'half-up'), -3);
  assert.throws(() => translate(100, 'abc'), /Invalid exchange rate/);
});
test('percentages handle zero and missing comparatives honestly', () => {
  assert.equal(pctChange(110, 100), '10.0'); assert.equal(pctChange(90, 100), '-10.0'); assert.equal(pctChange(100, 0), null); assert.equal(pctChange(100, null), null);
  assert.equal(exceeds(1000, 0, { abs: 500, pct: 10 }), true); assert.equal(exceeds(100, 0, { abs: 500, pct: 10 }), false); assert.equal(exceeds(111, 100, { abs: 0, pct: 10 }), true); assert.equal(exceeds(105, 100, { abs: 0, pct: 10 }), false); assert.equal(exceeds(105, null, { abs: 1, pct: 1 }), false);
});

// ---------- business calendar ----------
const us = makeCalendar({ holidays: ['2026-11-26', '2026-09-07'] }); const mx = makeCalendar({ holidays: ['2026-11-02'] });
test('business-day offsets define Day 0 and respect weekends, holidays and entity calendars', () => {
  // Oct 31 2026 is a Saturday: BD 0 falls back to Friday Oct 30; BD +1 is Monday Nov 2
  assert.equal(businessDayOffset(us, '2026-10-31', 0), '2026-10-30'); assert.equal(businessDayOffset(us, '2026-10-31', 1), '2026-11-02'); assert.equal(businessDayOffset(us, '2026-10-31', 6), '2026-11-09'); assert.equal(businessDayOffset(us, '2026-10-31', -3), '2026-10-27');
  assert.equal(businessDayOffset(mx, '2026-10-31', 1), '2026-11-03'); // Mexico holiday on Nov 2 moves BD +1
  assert.equal(businessDayOffset(us, '2026-11-25', 1), '2026-11-27'); // Thanksgiving skipped
  for (const off of [-3, 0, 1, 4, 6]) assert.equal(offsetOf(us, '2026-10-31', businessDayOffset(us, '2026-10-31', off)), off);
  assert.throws(() => businessDayOffset(makeCalendar({ workdays: [] }), '2026-10-31', 1), /no business days/);
});
test('working-time arithmetic crosses days and weekends', () => {
  assert.equal(addWorkMinutes(us, '2026-11-05T10:00', 60), '2026-11-05T11:00'); assert.equal(addWorkMinutes(us, '2026-11-05T16:00', 120), '2026-11-06T10:00'); assert.equal(addWorkMinutes(us, '2026-11-06T16:30', 60), '2026-11-09T09:30');
  assert.equal(addWorkMinutes(us, '2026-11-07T12:00', 30), '2026-11-09T09:30'); assert.equal(subWorkMinutes(us, '2026-11-09T09:30', 60), '2026-11-06T16:30');
  assert.equal(workMinutesBetween(us, '2026-11-05T10:00', '2026-11-06T10:00'), 480); assert.equal(workMinutesBetween(us, '2026-11-06T16:00', '2026-11-09T10:00'), 120); assert.equal(workMinutesBetween(us, '2026-11-06T10:00', '2026-11-05T10:00'), 0);
});
test('4-4-5 fiscal calendar produces 12 contiguous periods over 52 weeks', () => {
  const p = fiscalPeriods445('2026-01-04'); assert.equal(p.length, 12); assert.deepEqual(p.slice(0, 3).map(x => x.weeks), [4, 4, 5]); assert.equal(p.reduce((a, x) => a + x.weeks, 0), 52);
  for (let i = 1; i < p.length; i++) assert.equal(p[i].start, addDays(p[i - 1].end, 1)); assert.equal(p[11].end, addDays('2026-01-04', 52 * 7 - 1));
});

// ---------- dependency scheduling ----------
const T = (id, o = {}) => ({ id, durationMin: 120, reviewMin: 60, status: 'not_started', reviewerId: 9, preparerId: id, ...o }); const base = { now: '2026-11-05T09:00', calendars: {}, defaultCal: us };
test('dependency cycles are detected and reported', () => {
  assert.deepEqual(findCycle([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]), [1, 2, 3, 1]); assert.equal(findCycle([1, 2], [{ from: 1, to: 2 }]), null);
  const r = computeSchedule({ ...base, tasks: [T(1), T(2)], deps: [{ from: 1, to: 2, type: 'FS', lagMin: 0, gate: 'approved' }, { from: 2, to: 1, type: 'FS', lagMin: 0, gate: 'approved' }] }); assert.equal(r.error, 'cycle');
});
test('critical path follows the longest of parallel paths', () => {
  const dep = (from, to, o = {}) => ({ from, to, type: 'FS', lagMin: 0, gate: 'approved', ...o });
  const r = computeSchedule({ ...base, tasks: [T(1), T(2, { durationMin: 60 }), T(3, { durationMin: 300 }), T(4)], deps: [dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)] });
  assert.deepEqual(r.criticalPaths[0], [1, 3, 4]); assert.equal(r.tasks[1].finish, '2026-11-05T12:00'); assert.equal(r.tasks[3].finish, '2026-11-06T10:00'); assert.equal(r.projected, '2026-11-06T13:00');
  assert.equal(r.tasks[2].slackMin, 240); assert.equal(r.tasks[3].slackMin, 0); assert.equal(r.tasks[2].critical, false);
});
test('prepared gate, start-to-start, lag, external inputs and missing durations', () => {
  const prep = computeSchedule({ ...base, tasks: [T(1), T(2)], deps: [{ from: 1, to: 2, type: 'FS', lagMin: 0, gate: 'prepared' }] }); assert.equal(prep.tasks[2].workStart, '2026-11-05T11:00'); // starts when 1 is prepared, before its review ends
  const ss = computeSchedule({ ...base, tasks: [T(1), T(2)], deps: [{ from: 1, to: 2, type: 'SS', lagMin: 30, gate: 'approved' }] }); assert.equal(ss.tasks[2].workStart, '2026-11-05T09:30');
  const ext = computeSchedule({ ...base, tasks: [T(1, { notBefore: '2026-11-06T12:00', notBeforeNote: 'report' }), T(2)], deps: [{ from: 1, to: 2, type: 'FS', lagMin: 0, gate: 'approved' }] }); assert.equal(ext.tasks[1].driver.kind, 'input'); assert.equal(ext.tasks[1].workStart, '2026-11-06T12:00'); assert.deepEqual(ext.criticalPaths[0], [1, 2]);
  const miss = computeSchedule({ ...base, tasks: [T(1, { durationMin: null }), T(2, { status: 'not_applicable' })], deps: [] }); assert.deepEqual(miss.warnings.missingDuration, [1]); assert.equal(miss.coverage.tasksWithDuration, 0); assert.equal(miss.coverage.tasks, 1);
  const done = computeSchedule({ ...base, tasks: [T(1, { status: 'approved', approvedAt: '2026-11-04T15:00' }), T(2)], deps: [{ from: 1, to: 2, type: 'FS', lagMin: 0, gate: 'approved' }] }); assert.equal(done.tasks[2].workStart, '2026-11-05T09:00');
});
test('resource-constrained date is later when one person holds parallel tasks', () => {
  const tasks = [T(1, { preparerId: 5, reviewerId: null, reviewMin: null, durationMin: 240 }), T(2, { preparerId: 5, reviewerId: null, reviewMin: null, durationMin: 240 }), T(3, { preparerId: 5, reviewerId: null, reviewMin: null, durationMin: 240 })];
  const r = computeSchedule({ ...base, tasks, deps: [], resource: true }); assert.equal(r.projected, '2026-11-05T13:00'); assert.equal(r.resource.projected, '2026-11-06T13:00'); assert.ok(r.resource.conflicts.length >= 2);
  const away = computeSchedule({ ...base, tasks: [tasks[0]], deps: [], resource: true, people: { 5: { availableFrom: '2026-11-09T09:00' } } }); assert.equal(away.resource.projected, '2026-11-09T13:00');
});

// ---------- file formats ----------
test('CSV parsing and formula-injection protection', () => {
  const rows = parseCsv('﻿name,amount\r\n"Smith, J","1,200.50"\n"say ""hi""",5\n'); assert.deepEqual(rows, [['name', 'amount'], ['Smith, J', '1,200.50'], ['say "hi"', '5']]); assert.deepEqual(parseCsv('a;b\n1;2')[1], ['1', '2']);
  assert.equal(withHeader(rows).records[0].name, 'Smith, J'); assert.equal(safeCell('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")'); assert.equal(safeCell('+cmd'), "'+cmd"); assert.equal(safeCell('@SUM(A1)'), "'@SUM(A1)"); assert.equal(safeCell('-123.45'), '-123.45'); assert.equal(safeCell(-5), '-5');
  assert.ok(toCsv([['=1+1', 'ok']]).startsWith("'=1+1,ok"));
});
test('XLSX, DOCX, PDF and ZIP round-trip', () => {
  const x = readXlsx(writeXlsx([{ name: 'TB', rows: [['Account', 'Amount'], ['1000', 125000.5], ['=cmd', { f: 'SUM(B2:B2)', v: 125000.5 }]] }])); assert.equal(x.sheets[0].name, 'TB'); assert.deepEqual(x.sheets[0].rows[1], ['1000', '125000.5']); assert.equal(x.sheets[0].rows[2][0], "'=cmd"); assert.match(x.notes.join(' '), /formula cell/);
  assert.equal(readDocx(writeDocx(['# Title', 'Step 1 & done'])), 'Title\nStep 1 & done');
  const pdf = new PdfDoc({ title: 't' }); pdf.heading('Close package'); pdf.text('Balance (USD): 1,234.56'); const buf = pdf.build(); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.match(readPdfText(buf).join('\n'), /Balance \(USD\): 1,234\.56/);
  const z = unzip(zip([['a.txt', 'hello'], ['dir/b.txt', Buffer.from('world')]])); assert.equal(z.get('dir/b.txt').data.toString(), 'world'); assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /Not a ZIP/);
});
test('similarity ignores period templates and scores near-duplicates', () => {
  const a = shingles('customer aging report current thirty sixty ninety total balance'), b = shingles('customer aging report current thirty sixty ninety grand total balance'); assert.ok(jaccard(a, b) >= 0.5); assert.equal(jaccard(a, shingles('completely different words about fixed assets and leases here')), 0);
  assert.equal(seriesStem('Legacy Margin by SKU Report — Oct 2026'), seriesStem('Legacy Margin by SKU Report — Sep 2026'));
});

// ---------- feedback draft ----------
test('feedback draft is addressed correctly and encodes Unicode, ampersands and line breaks', () => {
  const mail = buildFeedback({ type: 'Suggestion', message: 'R&D total ≠ 100% — fix “flux”\nLine two + more? #1', contact: 'me@example.com', screen: 'Process Map', env: 'demo', version: '0.1.0', browser: 'Chrome 140 on Windows' });
  assert.equal(mail.to, 'tsoai2@gmail.com'); assert.equal(FEEDBACK_TO, 'tsoai2@gmail.com'); assert.equal(mail.subject, '[CLOSE INTELLIGENCE Feedback] Suggestion — Process Map'); assert.match(mail.body, /Environment: Demo/); assert.match(mail.body, /Screen: Process Map/);
  for (const variant of ['m365', 'personal']) { const u = new URL(outlookUrl(variant, mail)); assert.equal(u.hostname, variant === 'm365' ? 'outlook.office.com' : 'outlook.live.com'); assert.match(u.pathname, /deeplink\/compose$/); assert.equal(u.searchParams.get('to'), 'tsoai2@gmail.com'); assert.equal(u.searchParams.get('subject'), mail.subject); assert.equal(u.searchParams.get('body'), mail.body); assert.ok(!u.search.includes('+'), 'spaces must be %20, not +'); assert.equal([...u.searchParams.keys()].length, 3); }
  const m = mailtoUrl(mail); assert.ok(m.startsWith('mailto:tsoai2@gmail.com?subject=')); assert.ok(m.includes('%0D%0A')); assert.ok(!/[ &]R&D/.test(m));
  const long = buildFeedback({ message: 'x'.repeat(5000) }); assert.ok(outlookUrl('m365', long).length > URL_SOFT_LIMIT);
  const bare = buildFeedback({ message: 'hi', includeContext: false }); assert.ok(!/Browser|App version/.test(bare.body)); assert.ok(!/balance|password|key/i.test(mail.body));
  assert.equal(browserLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'), 'Chrome 140 on Windows');
});
