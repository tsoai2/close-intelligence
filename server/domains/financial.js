import { route, bad, invalid, forbidden, notFound, conflict, checkVersion, cleanText, pick } from '../core.js';
import { J } from '../db.js';
import { sha256 } from '../config.js';
import { toMinor, sum, translate, pctChange, exceeds } from '../lib/decimal.js';
import { parseCsv, withHeader } from '../lib/csv.js';
import { readXlsx } from '../lib/files.js';
import { findCycle } from '../lib/schedule.js';
import { addDays } from '../lib/calendar.js';
import { calendarsFor, dueAtFor, recomputeReadiness } from '../engine.js';
import { flagDownstream } from './tasks.js';

// ---------- Reconciliations ----------
export function recView(db, r, periodEnd) {
  const items = db.all('SELECT * FROM rec_items WHERE rec_id=? ORDER BY id', r.id); const open = items.filter(i => !i.resolved);
  const itemsTotal = sum(open.map(i => i.amount));
  const rollforward = r.beginning != null && r.activity != null && r.gl_balance != null ? r.beginning + r.activity - r.gl_balance : null;
  const unexplained = r.gl_balance != null && r.support_balance != null ? r.gl_balance - r.support_balance - itemsTotal : null;
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, undated: 0 };
  for (const i of open) { if (!i.item_date || !periodEnd) { buckets.undated += i.amount; continue; } const days = Math.round((Date.parse(periodEnd) - Date.parse(i.item_date)) / 86400000); buckets[days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+'] += i.amount; }
  return { ...r, items, itemsTotal, rollforwardDiff: rollforward, unexplained, withinThreshold: unexplained != null && Math.abs(unexplained) <= r.threshold, aging: buckets,
    formula: { rollforward: 'Beginning balance + activity − ending GL balance (should be 0.00)', unexplained: 'GL balance − supporting balance − open reconciling items' } };
}
const recFull = (ctx, id) => {
  const r = ctx.own('reconciliations', id, 'Reconciliation not found.'); const p = ctx.period(r.period_id); const approvals = ctx.db.all("SELECT * FROM approvals WHERE org_id=? AND target_type='rec' AND target_id=? ORDER BY id DESC", ctx.orgId, r.id);
  const last = approvals.find(a => a.decision === 'approved'); const imp = r.source_import_id ? ctx.db.get('SELECT id, filename, at, created_by, note FROM imports WHERE id=?', r.source_import_id) : null;
  const downstream = r.task_id ? ctx.db.all("SELECT t.id, t.key, t.name, t.status, t.upstream_changed FROM dependencies d JOIN tasks t ON t.id=d.to_task_id WHERE d.from_task_id=? AND d.kind='execution'", r.task_id) : [];
  return { ...recView(ctx.db, r, p.end_date), approvals, lastApproval: last || null, sourceImport: imp, task: r.task_id ? ctx.db.get('SELECT id, key, name, status, needs_rereview FROM tasks WHERE id=?', r.task_id) : null, downstream,
    stale: last ? { workpaper: last.target_version !== r.workpaper_version, source: last.source_version !== r.source_version } : null };
};
route('GET', '/periods/:pid/recs', { perm: 'read' }, ctx => { const p = ctx.period(ctx.params.pid); return ctx.db.all('SELECT * FROM reconciliations WHERE org_id=? AND period_id=? ORDER BY entity_id, account', ctx.orgId, p.id).map(r => { const v = recView(ctx.db, r, p.end_date); delete v.items; return v; }); });
route('GET', '/recs/:id', { perm: 'read' }, ctx => recFull(ctx, ctx.params.id));
route('POST', '/periods/:pid/recs', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; const e = ctx.own('entities', b.entity_id, 'Choose an entity.'); const account = cleanText(b.account, 30); if (!account?.trim() || !b.name?.trim()) throw invalid('A reconciliation needs an account code and a name.');
  if (ctx.db.get('SELECT 1 x FROM reconciliations WHERE org_id=? AND period_id=? AND entity_id=? AND account=?', ctx.orgId, p.id, e.id, account)) throw conflict('That account already has a reconciliation for this entity and period.');
  for (const k of ['preparer_id', 'reviewer_id']) if (b[k]) ctx.own('users', b[k]); const task = b.task_id ? ctx.own('tasks', b.task_id) : null;
  const line = ctx.db.get('SELECT debit-credit amt, import_id FROM tb_lines WHERE org_id=? AND period_id=? AND entity_id=? AND account=? AND current=1', ctx.orgId, p.id, e.id, account); const type = ctx.db.get('SELECT type FROM accounts WHERE org_id=? AND code=?', ctx.orgId, account)?.type;
  let threshold; try { threshold = Math.abs(toMinor(b.threshold ?? '') ?? ctx.settings.rec_threshold); } catch (x) { throw invalid(x.message); }
  const id = ctx.db.insert('reconciliations', { org_id: ctx.orgId, period_id: p.id, entity_id: e.id, task_id: task?.id || null, account, name: cleanText(b.name, 160), currency: e.currency, gl_balance: line ? (['liability', 'equity', 'revenue'].includes(type) ? -line.amt : line.amt) : null, source_import_id: line?.import_id || null,
    threshold, preparer_id: b.preparer_id || task?.preparer_id || null, reviewer_id: b.reviewer_id || task?.reviewer_id || null, support_source: cleanText(b.support_source, 120), updated_at: ctx.now() });
  ctx.audit('rec.created', 'rec', id, { account, entity: e.code }); ctx.changed('recs', 'overview'); return recFull(ctx, id);
}));
const canRec = (ctx, r) => ctx.can('manage') || [r.preparer_id, r.reviewer_id].includes(ctx.user.id);
/** Any change to the workpaper after approval keeps the old approval on file and marks the current version for review. */
function bumpWorkpaper(ctx, r, fields = {}) {
  const invalidated = r.status === 'approved';
  ctx.db.update('reconciliations', r.id, { ...fields, workpaper_version: r.workpaper_version + 1, version: r.version + 1, status: invalidated ? 'needs_rereview' : r.status === 'not_started' ? 'in_progress' : r.status, updated_at: ctx.now() });
  if (invalidated) invalidateRec(ctx, r, `Workpaper for ${r.name} changed after approval (now v${r.workpaper_version + 1}).`);
  ctx.changed('recs', 'overview', 'completion');
}
function invalidateRec(ctx, r, note) {
  ctx.notify(r.reviewer_id, 'rereview', `Re-review required: ${r.name}`, note, `rec:${r.id}`); if (r.preparer_id !== ctx.user.id) ctx.notify(r.preparer_id, 'rereview', `Re-review required: ${r.name}`, note, `rec:${r.id}`);
  let affected = [];
  if (r.task_id) { const t = ctx.db.get('SELECT * FROM tasks WHERE id=?', r.task_id);
    if (t && ['approved', 'submitted'].includes(t.status)) { ctx.db.update('tasks', t.id, { needs_rereview: 1, version: t.version + 1, updated_at: ctx.now() }); ctx.db.insert('task_events', { org_id: ctx.orgId, period_id: t.period_id, task_id: t.id, type: 'review_invalidated', from_status: t.status, to_status: t.status, user_id: ctx.user.id, note, at: ctx.now() }); }
    affected = flagDownstream(ctx, r.task_id, note); }
  ctx.audit('rec.review_invalidated', 'rec', r.id, { note, affected: affected.map(a => a.key) }); ctx.changed('tasks', 'today');
  return affected;
}
/** Called when new source data changes the GL balance behind a reconciliation. */
export function bumpRecSource(ctx, r, newGl, importId) {
  const stale = ['approved', 'submitted'].includes(r.status);
  ctx.db.update('reconciliations', r.id, { gl_balance: newGl, source_version: r.source_version + 1, source_import_id: importId, version: r.version + 1, status: stale ? 'needs_rereview' : r.status, updated_at: ctx.now() });
  const affected = stale ? invalidateRec(ctx, r, `Source GL balance for ${r.name} changed after ${r.status === 'approved' ? 'approval' : 'submission'} (source v${r.source_version} → v${r.source_version + 1}).`) : [];
  return { id: r.id, name: r.name, before: r.gl_balance, after: newGl, wasStatus: r.status, reReview: stale, downstream: affected };
}
route('PATCH', '/recs/:id', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('reconciliations', ctx.params.id); ctx.openPeriod(r.period_id); checkVersion(r, ctx.body.expectedVersion, 'reconciliation'); if (!canRec(ctx, r)) throw forbidden('Only the preparer, reviewer or a close manager can edit this reconciliation.');
  const f = {}; const b = ctx.body;
  for (const k of ['support_balance', 'beginning', 'activity']) if (b[k] !== undefined) { try { f[k] = b[k] === null || b[k] === '' ? null : toMinor(b[k]); } catch (e) { throw invalid(e.message); } }
  for (const k of ['support_source', 'explanation']) if (b[k] !== undefined) f[k] = cleanText(b[k], 4000);
  if (b.threshold !== undefined && ctx.can('manage')) { try { f.threshold = Math.abs(toMinor(b.threshold) ?? 0); } catch (e) { throw invalid(e.message); } }
  for (const k of ['preparer_id', 'reviewer_id']) if (b[k] !== undefined) { if (!ctx.can('manage')) throw forbidden(); if (b[k]) ctx.own('users', b[k]); f[k] = b[k] || null; }
  bumpWorkpaper(ctx, r, f); return recFull(ctx, r.id);
}));
route('POST', '/recs/:id/items', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('reconciliations', ctx.params.id); ctx.openPeriod(r.period_id); if (!canRec(ctx, r)) throw forbidden(); const b = ctx.body; let amount; try { amount = toMinor(b.amount); } catch (e) { throw invalid(e.message); }
  if (amount == null || !b.description?.trim()) throw invalid('A reconciling item needs a description and an amount.');
  ctx.db.insert('rec_items', { rec_id: r.id, description: cleanText(b.description, 300), amount, item_date: /^\d{4}-\d{2}-\d{2}$/.test(b.item_date || '') ? b.item_date : null, category: cleanText(b.category, 60), explanation: cleanText(b.explanation, 1000), owner_id: b.owner_id || ctx.user.id });
  bumpWorkpaper(ctx, r); return recFull(ctx, r.id);
}));
route('PATCH', '/recs/:id/items/:iid', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('reconciliations', ctx.params.id); ctx.openPeriod(r.period_id); if (!canRec(ctx, r)) throw forbidden(); const it = ctx.db.get('SELECT * FROM rec_items WHERE id=? AND rec_id=?', ctx.int(ctx.params.iid), r.id); if (!it) throw notFound();
  const f = pick(ctx.body, ['description', 'explanation', 'category', 'item_date']); if (ctx.body.resolved !== undefined) f.resolved = ctx.body.resolved ? 1 : 0; if (ctx.body.amount !== undefined) { try { f.amount = toMinor(ctx.body.amount); } catch (e) { throw invalid(e.message); } }
  ctx.db.update('rec_items', it.id, f); bumpWorkpaper(ctx, r); return recFull(ctx, r.id);
}));
route('POST', '/recs/:id/transition', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('reconciliations', ctx.params.id); const p = ctx.openPeriod(r.period_id); checkVersion(r, ctx.body.expectedVersion, 'reconciliation'); const v = recView(ctx.db, r, p.end_date); const note = cleanText(ctx.body.note, 2000); const a = ctx.body.action;
  const set = f => ctx.db.update('reconciliations', r.id, { ...f, version: r.version + 1, updated_at: ctx.now() });
  if (a === 'submit') {
    if (!canRec(ctx, r)) throw forbidden(); if (!['not_started', 'in_progress', 'needs_rereview'].includes(r.status)) throw invalid('This reconciliation is already in review or approved.');
    if (r.gl_balance == null) throw invalid('No GL balance yet. Import the trial balance for this entity first.'); if (r.support_balance == null) throw invalid('Enter the supporting balance (bank statement, subledger or schedule total).');
    if (v.rollforwardDiff != null && v.rollforwardDiff !== 0) throw invalid('Beginning balance + activity does not equal the ending GL balance. Correct the roll-forward before submitting.');
    if (!v.withinThreshold && !(r.explanation || '').trim()) throw invalid('The unexplained difference is above the threshold. Add reconciling items or an explanation before submitting.');
    set({ status: 'submitted', preparer_id: r.preparer_id || ctx.user.id }); ctx.notify(r.reviewer_id, 'review', `Review requested: ${r.name}`, `Submitted by ${ctx.user.name}.`, `rec:${r.id}`);
  } else if (a === 'approve') {
    if (!['submitted', 'needs_rereview'].includes(r.status)) throw invalid('Only a submitted reconciliation can be approved.');
    if (!ctx.can('review') || !(r.reviewer_id === ctx.user.id || ctx.can('manage'))) throw forbidden('Only the assigned reviewer or a close manager can approve.');
    if (ctx.settings.sod_enforced && ctx.user.id === r.preparer_id) throw invalid('Preparer and reviewer must be different people.', { sod: true });
    set({ status: 'approved' }); ctx.db.insert('approvals', { org_id: ctx.orgId, target_type: 'rec', target_id: r.id, target_version: r.workpaper_version, source_version: r.source_version, user_id: ctx.user.id, decision: 'approved', note, at: ctx.now() });
    if (r.source_import_id) ctx.db.run('UPDATE imports SET relied_on=1 WHERE id=?', r.source_import_id);
    if (r.task_id) { const t = ctx.db.get('SELECT * FROM tasks WHERE id=?', r.task_id); if (t?.needs_rereview) ctx.db.update('tasks', t.id, { needs_rereview: 0, upstream_changed: 0, version: t.version + 1 }); }
    ctx.audit('rec.approved', 'rec', r.id, { workpaperVersion: r.workpaper_version, sourceVersion: r.source_version }); ctx.notify(r.preparer_id, 'approved', `Approved: ${r.name}`, null, `rec:${r.id}`);
  } else if (a === 'request_changes') {
    if (!['submitted', 'needs_rereview'].includes(r.status)) throw invalid('Nothing is waiting for review.'); if (!ctx.can('review') || !(r.reviewer_id === ctx.user.id || ctx.can('manage'))) throw forbidden(); if (!note?.trim()) throw invalid('Say what needs to change.');
    set({ status: 'in_progress' }); ctx.db.insert('approvals', { org_id: ctx.orgId, target_type: 'rec', target_id: r.id, target_version: r.workpaper_version, source_version: r.source_version, user_id: ctx.user.id, decision: 'changes_requested', note, at: ctx.now() }); ctx.notify(r.preparer_id, 'changes', `Changes requested: ${r.name}`, note, `rec:${r.id}`);
  } else throw bad('Unknown action.');
  ctx.changed('recs', 'overview', 'completion', 'tasks'); return recFull(ctx, r.id);
}));

// ---------- Journals ----------
const jView = j => { const lines = J(j.lines, []); return { ...j, lines, totalDebit: sum(lines.map(l => l.debit || 0)), totalCredit: sum(lines.map(l => l.credit || 0)) }; };
function parseLines(lines) {
  if (!Array.isArray(lines)) throw invalid('Journal lines are required.');
  return lines.filter(l => l.account || l.debit || l.credit).map((l, i) => { let d, c; try { d = toMinor(l.debit) || 0; c = toMinor(l.credit) || 0; } catch (e) { throw invalid(`Line ${i + 1}: ${e.message}`); }
    if (!String(l.account || '').trim()) throw invalid(`Line ${i + 1}: account is required.`); if (d < 0 || c < 0) throw invalid(`Line ${i + 1}: enter positive debit or credit amounts.`); if (d && c) throw invalid(`Line ${i + 1}: enter a debit or a credit, not both.`);
    return { account: cleanText(l.account, 30), debit: d, credit: c, memo: cleanText(l.memo, 200) }; });
}
route('GET', '/periods/:pid/journals', { perm: 'read' }, ctx => ctx.db.all('SELECT * FROM journals WHERE org_id=? AND period_id=? ORDER BY id DESC', ctx.orgId, ctx.period(ctx.params.pid).id).map(jView));
route('POST', '/periods/:pid/journals', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; const e = ctx.own('entities', b.entity_id, 'Choose an entity.'); const lines = parseLines(b.lines || []);
  const n = ctx.db.val('SELECT COUNT(*) FROM journals WHERE org_id=? AND period_id=?', ctx.orgId, p.id) + 1; const late = p.status === 'reopened' || ctx.now() > p.target_close ? 1 : 0;
  const id = ctx.db.insert('journals', { org_id: ctx.orgId, period_id: p.id, entity_id: e.id, ref: `JE-${p.name.replace(/\s+/g, '')}-${String(n).padStart(3, '0')}`, description: cleanText(b.description, 500), type: ['standard', 'recurring', 'reversal', 'accrual'].includes(b.type) ? b.type : 'standard', lines, support: cleanText(b.support, 2000), preparer_id: ctx.user.id, late, task_id: b.task_id || null, created_at: ctx.now() });
  ctx.audit('journal.created', 'journal', id, { late: !!late }); ctx.changed('journals', 'completion'); return jView(ctx.own('journals', id));
}));
route('PATCH', '/journals/:id', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const j = ctx.own('journals', ctx.params.id); ctx.openPeriod(j.period_id); checkVersion(j, ctx.body.expectedVersion, 'journal'); if (j.status !== 'draft') throw invalid('Only a draft journal can be edited. Send it back to draft first.'); if (j.preparer_id !== ctx.user.id && !ctx.can('manage')) throw forbidden();
  const f = { version: j.version + 1 }; if (ctx.body.lines) f.lines = parseLines(ctx.body.lines); for (const k of ['description', 'support']) if (ctx.body[k] !== undefined) f[k] = cleanText(ctx.body[k], 2000);
  ctx.db.update('journals', j.id, f); ctx.changed('journals'); return jView(ctx.own('journals', j.id));
}));
route('POST', '/journals/:id/transition', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const j = ctx.own('journals', ctx.params.id); const p = ctx.openPeriod(j.period_id); const v = jView(j); const a = ctx.body.action; const set = f => ctx.db.update('journals', j.id, { ...f, version: j.version + 1 });
  if (a === 'submit') { if (j.status !== 'draft') throw invalid('Already submitted.'); if (v.lines.length < 2) throw invalid('A journal needs at least two lines.'); if (v.totalDebit !== v.totalCredit) throw invalid(`Journal does not balance: debits and credits differ by ${Math.abs(v.totalDebit - v.totalCredit) / 100}.`); if (!(j.support || '').trim()) throw invalid('Describe or reference the supporting calculation.'); set({ status: 'submitted' }); }
  else if (a === 'approve') { if (j.status !== 'submitted') throw invalid('Only a submitted journal can be approved.'); if (!ctx.can('review')) throw forbidden('Only reviewers and close managers can approve journals.'); if (ctx.settings.sod_enforced && j.preparer_id === ctx.user.id) throw invalid('Preparer and approver must be different people.', { sod: true });
    set({ status: 'approved', approver_id: ctx.user.id, approved_at: ctx.now() }); ctx.db.insert('approvals', { org_id: ctx.orgId, target_type: 'journal', target_id: j.id, target_version: j.version, user_id: ctx.user.id, decision: 'approved', note: cleanText(ctx.body.note, 1000), at: ctx.now() }); ctx.audit('journal.approved', 'journal', j.id, { ref: j.ref }); }
  else if (a === 'return') { if (!['submitted', 'approved'].includes(j.status)) throw invalid('Nothing to return.'); if (!ctx.can('review')) throw forbidden(); set({ status: 'draft', approver_id: null, approved_at: null }); }
  else if (a === 'confirm_posted') { if (j.status !== 'approved') throw invalid('Only an approved journal can be confirmed as posted.'); const ref = cleanText(ctx.body.postingRef, 80); if (!ref?.trim()) throw invalid('Enter the ERP posting reference. This app does not post to the ERP; you are recording that someone posted it there.');
    set({ status: 'posted_confirmed', posting_ref: ref.trim(), posted_confirmed_at: ctx.now(), posted_confirmed_by: ctx.user.id }); ctx.audit('journal.posting_confirmed', 'journal', j.id, { ref: j.ref, postingRef: ref }); }
  else if (a === 'reverse') { if (!['approved', 'posted_confirmed'].includes(j.status)) throw invalid('Only approved or posted journals can be reversed.'); const n = ctx.db.val('SELECT COUNT(*) FROM journals WHERE org_id=? AND period_id=?', ctx.orgId, p.id) + 1;
    const id = ctx.db.insert('journals', { org_id: ctx.orgId, period_id: p.id, entity_id: j.entity_id, ref: `JE-${p.name.replace(/\s+/g, '')}-${String(n).padStart(3, '0')}`, description: `Reversal of ${j.ref}: ${j.description || ''}`, type: 'reversal', lines: v.lines.map(l => ({ ...l, debit: l.credit, credit: l.debit })), support: `Reverses ${j.ref}`, preparer_id: ctx.user.id, reverses_id: j.id, late: p.status === 'reopened' ? 1 : 0, created_at: ctx.now() }); ctx.changed('journals'); return jView(ctx.own('journals', id)); }
  else throw bad('Unknown action.');
  ctx.changed('journals', 'completion'); return jView(ctx.own('journals', j.id));
}));

// ---------- Imports (CSV / XLSX) ----------
const SYN = {
  tb: { entity: ['entity', 'entity code', 'company', 'company code', 'co'], account: ['account', 'account code', 'gl account', 'acct', 'account number'], account_name: ['account name', 'description', 'name', 'account description'], currency: ['currency', 'ccy', 'curr'], debit: ['debit', 'dr', 'debits'], credit: ['credit', 'cr', 'credits'], amount: ['amount', 'balance', 'net', 'ending balance'], period: ['period', 'period end', 'as of'] },
  checklist: { key: ['key', 'task id', 'id', 'ref', 'code'], name: ['name', 'task', 'task name', 'activity', 'description of task'], process: ['process', 'area', 'category', 'cycle'], entity: ['entity', 'entity code', 'company'], offset_bd: ['offset_bd', 'day', 'due day', 'bd', 'workday', 'close day'], duration_hours: ['duration_hours', 'hours', 'est hours', 'effort', 'duration'], review_hours: ['review_hours', 'review hrs'],
    owner_email: ['owner_email', 'owner', 'accountable'], preparer_email: ['preparer_email', 'preparer', 'assignee', 'assigned to'], reviewer_email: ['reviewer_email', 'reviewer', 'approver'], risk: ['risk', 'risk level'], evidence: ['evidence', 'required evidence', 'support'], depends_on: ['depends_on', 'depends on', 'predecessor', 'predecessors', 'dependencies'], description: ['description', 'notes', 'instructions'] },
};
const REQUIRED = { tb: [['entity'], ['account'], ['amount', 'debit']], checklist: [['name']] };
function readTable(buf, filename) {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; const ext = (filename || '').toLowerCase().split('.').pop();
  if (isZip || ext === 'xlsx') { let wb; try { wb = readXlsx(buf); } catch (e) { throw invalid(`Could not read the Excel file: ${e.message}`); } const sheet = wb.sheets.find(s => s.rows.length > 1) || wb.sheets[0]; if (!sheet) throw invalid('The workbook has no sheets with data.'); return { rows: sheet.rows.map(r => r.map(c => String(c ?? ''))).filter(r => r.some(c => c.trim())), notes: [`Read sheet "${sheet.name}"`, ...wb.notes], format: 'xlsx' }; }
  if (buf.includes(0)) throw invalid('This file is not a CSV or .xlsx workbook.');
  return { rows: parseCsv(buf.toString('utf8')), notes: [], format: 'csv' };
}
function suggestMapping(kind, header) { const m = {}; const norm = h => h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim(); for (const [field, names] of Object.entries(SYN[kind])) { const want = [field, ...names].map(norm); const i = header.findIndex(h => want.includes(norm(h))); if (i >= 0 && !Object.values(m).includes(header[i])) m[field] = header[i]; } return m; }

function analyseTb(ctx, p, records, map) {
  const ents = Object.fromEntries(ctx.db.all('SELECT * FROM entities WHERE org_id=?', ctx.orgId).map(e => [e.code.toLowerCase(), e])); const coa = new Set(ctx.db.all('SELECT code FROM accounts WHERE org_id=?', ctx.orgId).map(a => a.code));
  const accepted = [], rejected = [], seen = new Map(), unmapped = new Map(); const g = (r, f) => (map[f] ? r[map[f]] ?? '' : '');
  let fileDebit = 0, fileCredit = 0;
  for (const r of records) {
    const rej = why => rejected.push({ row: r.__row, reason: why, data: { entity: g(r, 'entity'), account: g(r, 'account'), amount: g(r, 'amount') || `${g(r, 'debit')} / ${g(r, 'credit')}` } });
    let debit = 0, credit = 0;
    try { if (map.debit || map.credit) { debit = toMinor(g(r, 'debit')) || 0; credit = toMinor(g(r, 'credit')) || 0; } else { const a = toMinor(g(r, 'amount')); if (a == null) { rej('Amount is blank.'); continue; } if (a >= 0) debit = a; else credit = -a; } } catch (e) { rej(e.message); continue; }
    if (debit < 0 || credit < 0) { rej('Debit and credit columns must not be negative; use the other column instead.'); continue; }
    fileDebit += debit; fileCredit += credit;
    const ent = ents[g(r, 'entity').toLowerCase()]; if (!ent) { rej(`Entity "${g(r, 'entity')}" is not set up.`); continue; }
    const account = g(r, 'account'); if (!account) { rej('Account code is blank.'); continue; }
    const ccy = g(r, 'currency').toUpperCase(); if (ccy && ccy !== ent.currency) { rej(`Currency ${ccy} does not match ${ent.code}'s functional currency ${ent.currency}. Amounts are not translated on import.`); continue; }
    const per = g(r, 'period'); if (per && ![p.name.toLowerCase(), p.end_date].includes(per.toLowerCase())) { rej(`Row is for period "${per}", not ${p.name}.`); continue; }
    const k = ent.id + '|' + account; if (seen.has(k)) { rej(`Duplicate of row ${seen.get(k)} (same entity and account).`); continue; } seen.set(k, r.__row);
    if (!coa.has(account)) unmapped.set(account, g(r, 'account_name') || '');
    accepted.push({ row: r.__row, entity_id: ent.id, entity: ent.code, account, account_name: g(r, 'account_name') || null, currency: ent.currency, debit, credit });
  }
  const byEntity = {}; for (const a of accepted) { const e = (byEntity[a.entity] ||= { entity: a.entity, currency: a.currency, debit: 0, credit: 0, rows: 0 }); e.debit += a.debit; e.credit += a.credit; e.rows++; }
  const balance = Object.values(byEntity).map(e => ({ ...e, difference: e.debit - e.credit, balanced: e.debit === e.credit }));
  return { accepted, rejected, totals: { fileRows: records.length, acceptedRows: accepted.length, rejectedRows: rejected.length, fileDebit, fileCredit, acceptedDebit: sum(accepted.map(a => a.debit)), acceptedCredit: sum(accepted.map(a => a.credit)), balance, unbalanced: balance.some(b => !b.balanced) },
    unmapped: [...unmapped].map(([code, name]) => ({ code, name })) };
}
function analyseChecklist(ctx, p, records, map) {
  const ents = Object.fromEntries(ctx.db.all('SELECT * FROM entities WHERE org_id=?', ctx.orgId).map(e => [e.code.toLowerCase(), e])); const users = Object.fromEntries(ctx.db.all("SELECT id, email, name FROM users WHERE org_id=? AND active=1 AND role!='external'", ctx.orgId).flatMap(u => [[u.email.toLowerCase(), u], [u.name.toLowerCase(), u]]));
  const existing = new Set(ctx.db.all('SELECT key, entity_id FROM tasks WHERE org_id=? AND period_id=?', ctx.orgId, p.id).map(t => t.key + '|' + (t.entity_id ?? ''))); const g = (r, f) => (map[f] ? r[map[f]] ?? '' : '');
  const accepted = [], rejected = [], warnings = [], keys = new Set(); let auto = 0;
  for (const r of records) {
    const rej = why => rejected.push({ row: r.__row, reason: why, data: { key: g(r, 'key'), name: g(r, 'name') } }); const name = g(r, 'name'); if (!name) { rej('Task name is blank.'); continue; }
    const ec = g(r, 'entity'); const ent = ec ? ents[ec.toLowerCase()] : null; if (ec && !ent) { rej(`Entity "${ec}" is not set up.`); continue; }
    const key = g(r, 'key') || `IMP-${String(++auto).padStart(3, '0')}`; const uk = key + '|' + (ent?.id ?? ''); if (keys.has(uk)) { rej(`Duplicate key "${key}" in the file.`); continue; } if (existing.has(uk)) { rej(`Task "${key}" already exists in ${p.name}.`); continue; } keys.add(uk);
    const num = (f, mult) => { const v = g(r, f); if (v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) { warnings.push({ row: r.__row, message: `${f} "${v}" is not a number; left blank.` }); return null; } return Math.round(n * mult); };
    const off = g(r, 'offset_bd'); const offset = off === '' ? 1 : parseInt(off.replace(/^bd\s*/i, ''), 10); if (!Number.isInteger(offset) || offset < -30 || offset > 60) { rej(`Close day "${off}" is not a business-day offset between -30 and 60.`); continue; }
    const who = f => { const v = g(r, f); if (!v) return null; const u = users[v.toLowerCase()]; if (!u) warnings.push({ row: r.__row, message: `${f.replace('_email', '')} "${v}" is not a user here; left unassigned.` }); return u?.id || null; };
    const risk = g(r, 'risk').toLowerCase(); accepted.push({ row: r.__row, key, name, process: g(r, 'process') || 'Other', entity_id: ent?.id || null, offset_bd: offset, duration_min: num('duration_hours', 60), review_min: num('review_hours', 60), owner_id: who('owner_email'), preparer_id: who('preparer_email'), reviewer_id: who('reviewer_email'),
      risk: ['low', 'medium', 'high'].includes(risk) ? risk : 'medium', evidence: g(r, 'evidence').split(';').map(s => s.trim()).filter(Boolean), depends_on: g(r, 'depends_on').split(/[;,]/).map(s => s.trim()).filter(Boolean), description: g(r, 'description') || null });
  }
  const byKey = new Map(accepted.map((a, i) => [a.key, i])); const edges = [];
  for (const [i, a] of accepted.entries()) for (const d of a.depends_on) { if (byKey.has(d)) edges.push({ from: byKey.get(d), to: i }); else if (![...existing].some(k => k.startsWith(d + '|'))) warnings.push({ row: a.row, message: `Depends on "${d}", which is not in the file or the period; link skipped.` }); }
  const cycle = findCycle(accepted.map((_, i) => i), edges);
  return { accepted, rejected, warnings, cycle: cycle ? cycle.map(i => accepted[i].key) : null, totals: { fileRows: records.length, acceptedRows: accepted.length, rejectedRows: rejected.length, dependencies: edges.length, unassigned: accepted.filter(a => !a.owner_id && !a.preparer_id).length } };
}
function importAnalysis(ctx) {
  const kind = ctx.query.kind; if (!SYN[kind]) throw bad('kind must be tb or checklist'); const p = ctx.openPeriod(ctx.query.periodId); if (!ctx.body?.length) throw invalid('The file is empty.');
  const hash = sha256(ctx.body); const table = readTable(ctx.body, ctx.query.filename); if (table.rows.length < 2) throw invalid('The file needs a header row and at least one data row.');
  const { header, records } = withHeader(table.rows); let map = suggestMapping(kind, header);
  if (ctx.query.mapping) { let m; try { m = JSON.parse(ctx.query.mapping); } catch { throw bad('mapping must be JSON'); } map = Object.fromEntries(Object.entries(m).filter(([f, h]) => SYN[kind][f] && header.includes(h))); }
  const missing = REQUIRED[kind].filter(alts => !alts.some(f => map[f])).map(alts => alts.join(' or '));
  const dup = ctx.db.get("SELECT id, at, filename FROM imports WHERE org_id=? AND period_id=? AND kind=? AND sha256=? AND status='committed'", ctx.orgId, p.id, kind, hash);
  const analysis = missing.length ? null : kind === 'tb' ? analyseTb(ctx, p, records, map) : analyseChecklist(ctx, p, records, map);
  return { kind, p, hash, header, map, missing, dup, analysis, notes: table.notes, format: table.format, sample: records.slice(0, 12), fields: Object.keys(SYN[kind]) };
}
route('POST', '/imports/preview', { perm: 'import', raw: true }, ctx => {
  const a = importAnalysis(ctx);
  return { kind: a.kind, sha256: a.hash, header: a.header, mapping: a.map, fields: a.fields, missingFields: a.missing, notes: a.notes, format: a.format, sample: a.sample, duplicateOf: a.dup, ...(a.analysis ? { totals: a.analysis.totals, rejected: a.analysis.rejected.slice(0, 200), warnings: a.analysis.warnings || [], unmapped: a.analysis.unmapped || [], cycle: a.analysis.cycle || null, acceptedSample: a.analysis.accepted.slice(0, 12) } : {}) };
});
route('POST', '/imports/commit', { perm: 'import', raw: true }, ctx => ctx.db.tx(() => {
  const a = importAnalysis(ctx); const { p, kind, analysis } = a;
  if (a.dup) throw conflict(`This exact file was already imported for ${p.name} on ${a.dup.at.replace('T', ' ')}. Nothing was imported again.`, { importId: a.dup.id });
  if (a.missing.length) throw invalid(`Map these columns first: ${a.missing.join(', ')}.`); if (!analysis.accepted.length) throw invalid('No rows passed validation, so nothing was imported.');
  const base = { org_id: ctx.orgId, period_id: p.id, kind, filename: cleanText(ctx.query.filename, 200), sha256: a.hash, row_count: analysis.accepted.length, rejected: analysis.rejected.slice(0, 500), mapping: a.map, created_by: ctx.user.id, at: ctx.now(), note: cleanText(ctx.query.note, 300) };
  if (kind === 'tb') {
    if (analysis.totals.unbalanced && ctx.query.acceptUnbalanced !== '1') throw invalid('The accepted rows do not balance for at least one entity. Review the difference, then confirm you want to import it as-is.', { balance: analysis.totals.balance, needsConfirm: 'acceptUnbalanced' });
    const entityIds = [...new Set(analysis.accepted.map(r => r.entity_id))]; const prior = ctx.db.all(`SELECT DISTINCT import_id FROM tb_lines WHERE org_id=? AND period_id=? AND current=1 AND entity_id IN (${entityIds.map(() => '?').join(',')})`, ctx.orgId, p.id, ...entityIds).map(r => r.import_id);
    const before = Object.fromEntries(ctx.db.all(`SELECT entity_id, account, debit-credit amt FROM tb_lines WHERE org_id=? AND period_id=? AND current=1`, ctx.orgId, p.id).map(l => [l.entity_id + '|' + l.account, l.amt]));
    const id = ctx.db.insert('imports', { ...base, totals: { ...analysis.totals, unmapped: analysis.unmapped, replaced: prior } });
    ctx.db.run(`UPDATE tb_lines SET current=0 WHERE org_id=? AND period_id=? AND entity_id IN (${entityIds.map(() => '?').join(',')})`, ctx.orgId, p.id, ...entityIds);
    for (const pi of prior) ctx.db.run('UPDATE imports SET superseded_by=? WHERE id=?', id, pi);
    for (const r of analysis.accepted) ctx.db.insert('tb_lines', { org_id: ctx.orgId, import_id: id, period_id: p.id, entity_id: r.entity_id, account: r.account, account_name: r.account_name, currency: r.currency, debit: r.debit, credit: r.credit });
    if (ctx.query.createAccounts === '1') for (const u of analysis.unmapped) ctx.db.run("INSERT OR IGNORE INTO accounts(org_id, code, name, type) VALUES(?,?,?, 'unmapped')", ctx.orgId, u.code, u.name || u.code);
    const changedRecs = []; const cur = Object.fromEntries(analysis.accepted.map(r => [r.entity_id + '|' + r.account, r.debit - r.credit]));
    for (const rec of ctx.db.all(`SELECT * FROM reconciliations WHERE org_id=? AND period_id=? AND entity_id IN (${entityIds.map(() => '?').join(',')})`, ctx.orgId, p.id, ...entityIds)) {
      const k = rec.entity_id + '|' + rec.account; if (!(k in cur)) continue; const sign = ctx.db.get('SELECT type FROM accounts WHERE org_id=? AND code=?', ctx.orgId, rec.account)?.type; const gl = ['liability', 'equity', 'revenue'].includes(sign) ? -cur[k] : cur[k];
      if (rec.gl_balance !== gl) changedRecs.push(bumpRecSource(ctx, rec, gl, id)); else if (!rec.source_import_id) ctx.db.update('reconciliations', rec.id, { source_import_id: id });
    }
    const changedAccounts = Object.keys(cur).filter(k => k in before && before[k] !== cur[k]).length;
    ctx.audit('import.committed', 'import', id, { kind, rows: analysis.accepted.length, rejected: analysis.rejected.length, replaced: prior, changedAccounts, reReview: changedRecs.filter(c => c.reReview).map(c => c.name) });
    ctx.changed('imports', 'tb', 'recs', 'overview', 'tasks', 'completion', 'findings'); return { importId: id, totals: analysis.totals, rejected: analysis.rejected, unmapped: analysis.unmapped, replacedImports: prior, changedAccounts, reconciliations: changedRecs };
  }
  if (analysis.cycle) throw invalid(`The dependencies in this file form a loop: ${analysis.cycle.join(' → ')}. Fix the file and re-import.`);
  const cals = calendarsFor(ctx.db, ctx.orgId); const created = [];
  for (const r of analysis.accepted) {
    const cal = (r.entity_id && cals.byEntity[r.entity_id]) || cals.defaultCal;
    const tid = ctx.db.insert('tasks', { org_id: ctx.orgId, period_id: p.id, entity_id: r.entity_id, key: cleanText(r.key, 30), name: cleanText(r.name, 200), process: cleanText(r.process, 80), offset_bd: r.offset_bd, due_at: dueAtFor(cal, p.day0, r.offset_bd), duration_min: r.duration_min, review_min: r.review_min,
      owner_id: r.owner_id || r.preparer_id, preparer_id: r.preparer_id || r.owner_id, reviewer_id: r.reviewer_id, risk: r.risk, evidence_req: r.evidence.map(e => cleanText(e, 200)), description: cleanText(r.description), updated_at: ctx.now() });
    created.push({ id: tid, key: r.key, deps: r.depends_on });
  }
  let depCount = 0; const idByKey = k => created.find(c => c.key === k)?.id || ctx.db.get('SELECT id FROM tasks WHERE org_id=? AND period_id=? AND key=? LIMIT 1', ctx.orgId, p.id, k)?.id;
  for (const c of created) for (const d of c.deps) { const from = idByKey(d); if (from && from !== c.id) { ctx.db.run("INSERT OR IGNORE INTO dependencies(org_id, period_id, from_task_id, to_task_id) VALUES(?,?,?,?)", ctx.orgId, p.id, from, c.id); depCount++; } }
  const id = ctx.db.insert('imports', { ...base, totals: { ...analysis.totals, taskIds: created.map(c => c.id), dependencies: depCount } });
  recomputeReadiness(ctx.db, ctx.orgId, p.id, ctx.now(), ctx.user.id); ctx.audit('import.committed', 'import', id, { kind, rows: created.length, rejected: analysis.rejected.length });
  ctx.changed('imports', 'tasks', 'overview', 'schedule', 'today'); return { importId: id, totals: analysis.totals, rejected: analysis.rejected, warnings: analysis.warnings, created: created.length, dependencies: depCount };
}));
route('GET', '/imports', { perm: 'read' }, ctx => ctx.db.all('SELECT * FROM imports WHERE org_id=? ORDER BY id DESC LIMIT 100', ctx.orgId).map(i => ({ ...i, rejected: J(i.rejected, []), totals: J(i.totals, {}), mapping: J(i.mapping, {}) })));
// Controlled rollback: only before anything relies on the import (no approvals bound to it, no started tasks).
route('POST', '/imports/:id/rollback', { perm: 'import' }, ctx => ctx.db.tx(() => {
  const i = ctx.own('imports', ctx.params.id); const p = ctx.openPeriod(i.period_id); if (i.status !== 'committed') throw invalid('This import was already rolled back.'); const totals = J(i.totals, {});
  if (i.superseded_by) throw invalid('A later import replaced this one. Roll back the later import first.');
  if (i.kind === 'tb') {
    if (i.relied_on) throw invalid('A reconciliation was approved against this data, so it can no longer be rolled back. Import a corrected file instead; affected approvals will be flagged for re-review.');
    const ents = ctx.db.all('SELECT DISTINCT entity_id FROM tb_lines WHERE import_id=?', i.id).map(r => r.entity_id); ctx.db.run('UPDATE tb_lines SET current=0 WHERE import_id=?', i.id);
    for (const pi of totals.replaced || []) { ctx.db.run(`UPDATE tb_lines SET current=1 WHERE import_id=? AND entity_id IN (${ents.map(() => '?').join(',')})`, pi, ...ents); ctx.db.run('UPDATE imports SET superseded_by=NULL WHERE id=?', pi); }
    const cur = Object.fromEntries(ctx.db.all('SELECT entity_id, account, debit-credit amt, import_id FROM tb_lines WHERE org_id=? AND period_id=? AND current=1', ctx.orgId, p.id).map(l => [l.entity_id + '|' + l.account, l]));
    for (const rec of ctx.db.all('SELECT * FROM reconciliations WHERE org_id=? AND period_id=? AND source_import_id=?', ctx.orgId, p.id, i.id)) { const l = cur[rec.entity_id + '|' + rec.account]; const type = ctx.db.get('SELECT type FROM accounts WHERE org_id=? AND code=?', ctx.orgId, rec.account)?.type; const gl = l ? (['liability', 'equity', 'revenue'].includes(type) ? -l.amt : l.amt) : null; bumpRecSource(ctx, rec, gl, l?.import_id || null); }
  } else {
    const ids = totals.taskIds || []; const started = ids.length ? ctx.db.all(`SELECT key FROM tasks WHERE id IN (${ids.map(() => '?').join(',')}) AND status NOT IN ('not_started','ready')`, ...ids) : [];
    if (started.length) throw invalid(`Work has started on ${started.length} imported task(s) (${started.slice(0, 5).map(t => t.key).join(', ')}), so the checklist import can no longer be rolled back.`);
    for (const id of ids) { ctx.db.run('DELETE FROM dependencies WHERE from_task_id=? OR to_task_id=?', id, id); ctx.db.run('DELETE FROM task_steps WHERE task_id=?', id); ctx.db.run('DELETE FROM task_events WHERE task_id=?', id); ctx.db.run('DELETE FROM tasks WHERE id=? AND org_id=?', id, ctx.orgId); }
  }
  ctx.db.update('imports', i.id, { status: 'rolled_back' }); ctx.audit('import.rolled_back', 'import', i.id, { kind: i.kind }); ctx.changed('imports', 'tb', 'recs', 'tasks', 'overview', 'schedule'); return { ok: true };
}));

// ---------- Trial balance, variance, statements, intercompany ----------
const tbCurrent = (ctx, pid, entityId) => ctx.db.all(`SELECT l.entity_id, l.account, COALESCE(a.name, l.account_name, l.account) name, a.type, a.statement, a.line, a.is_ic, l.currency, l.debit, l.credit, l.debit-l.credit amount, l.import_id FROM tb_lines l LEFT JOIN accounts a ON a.org_id=l.org_id AND a.code=l.account
  WHERE l.org_id=? AND l.period_id=? AND l.current=1 ${entityId ? 'AND l.entity_id=?' : ''} ORDER BY l.entity_id, l.account`, ...(entityId ? [ctx.orgId, pid, entityId] : [ctx.orgId, pid]));
route('GET', '/periods/:pid/tb', { perm: 'read' }, ctx => {
  const p = ctx.period(ctx.params.pid); const eid = ctx.query.entity ? ctx.own('entities', ctx.query.entity).id : null; const lines = tbCurrent(ctx, p.id, eid); const byE = {};
  for (const l of lines) { const e = (byE[l.entity_id] ||= { entity_id: l.entity_id, currency: l.currency, debit: 0, credit: 0, rows: 0 }); e.debit += l.debit; e.credit += l.credit; e.rows++; }
  const imports = ctx.db.all("SELECT id, filename, at, created_by, status, row_count, superseded_by, relied_on, note FROM imports WHERE org_id=? AND period_id=? AND kind='tb' ORDER BY id DESC", ctx.orgId, p.id);
  return { lines, balance: Object.values(byE).map(e => ({ ...e, difference: e.debit - e.credit, balanced: e.debit === e.credit })), unmapped: lines.filter(l => !l.type || l.type === 'unmapped').map(l => pick(l, ['entity_id', 'account', 'name', 'amount'])), imports,
    signConvention: 'Amounts are debit minus credit in each entity’s functional currency. Assets and expenses are normally positive; liabilities, equity and revenue are normally negative.' };
});
route('GET', '/accounts', { perm: 'read' }, ctx => ctx.db.all('SELECT * FROM accounts WHERE org_id=? ORDER BY code', ctx.orgId));
route('PATCH', '/accounts/:id', { perm: 'manage' }, ctx => { const a = ctx.own('accounts', ctx.params.id); const f = pick(ctx.body, ['name', 'type', 'statement', 'line', 'is_ic']); if (f.type && !['asset', 'liability', 'equity', 'revenue', 'expense', 'unmapped'].includes(f.type)) throw invalid('Unknown account type.');
  if (f.type) f.statement = ['revenue', 'expense'].includes(f.type) ? 'IS' : f.type === 'unmapped' ? null : 'BS'; ctx.db.update('accounts', a.id, f); ctx.audit('account.mapped', 'account', a.id, f); ctx.changed('tb'); return ctx.own('accounts', a.id); });

function comparisonPeriod(ctx, p, comparison) {
  if (comparison === 'prior') return ctx.db.get('SELECT * FROM periods WHERE org_id=? AND end_date<? AND kind=? ORDER BY end_date DESC LIMIT 1', ctx.orgId, p.start_date, p.kind);
  if (comparison === 'prior_year') { const end = `${+p.end_date.slice(0, 4) - 1}${p.end_date.slice(4, 7)}`; return ctx.db.get('SELECT * FROM periods WHERE org_id=? AND substr(end_date,1,7)=? AND kind=?', ctx.orgId, end, p.kind); }
  return null;
}
route('GET', '/periods/:pid/variance', { perm: 'read' }, ctx => {
  const p = ctx.period(ctx.params.pid); const ent = ctx.own('entities', ctx.query.entity, 'Choose an entity.'); const comparison = ['prior', 'budget', 'prior_year'].includes(ctx.query.comparison) ? ctx.query.comparison : 'prior'; const s = ctx.settings;
  const cur = tbCurrent(ctx, p.id, ent.id); let base = null, baseLabel = null, unavailable = null;
  if (comparison === 'budget') { const rows = ctx.db.all('SELECT account, amount FROM budgets WHERE org_id=? AND period_id=? AND entity_id=?', ctx.orgId, p.id, ent.id); if (rows.length) { base = Object.fromEntries(rows.map(r => [r.account, r.amount])); baseLabel = `Budget ${p.name}`; } else unavailable = `No budget has been loaded for ${ent.code} in ${p.name}.`; }
  else { const bp = comparisonPeriod(ctx, p, comparison); const rows = bp ? tbCurrent(ctx, bp.id, ent.id) : []; if (rows.length) { base = Object.fromEntries(rows.map(r => [r.account, r.amount])); baseLabel = bp.name; } else unavailable = comparison === 'prior_year' ? 'No prior-year trial balance exists for this entity, so no prior-year comparison is shown.' : 'No earlier period with a trial balance exists for this entity.'; }
  const notes = Object.fromEntries(ctx.db.all('SELECT * FROM variance_notes WHERE org_id=? AND period_id=? AND entity_id=? AND comparison=?', ctx.orgId, p.id, ent.id, comparison).map(n => [n.account, n]));
  const th = { abs: s.variance_abs, pct: s.variance_pct };
  const rows = cur.map(l => { const b = base ? (l.account in base ? base[l.account] : null) : null; const flagged = b != null && exceeds(l.amount, b, th);
    return { account: l.account, name: l.name, type: l.type, current: l.amount, base: b, delta: b == null ? null : l.amount - b, pct: pctChange(l.amount, b), pctNote: b == null ? 'No comparative amount' : b === 0 ? 'Comparative is zero; percentage not meaningful' : null, flagged, note: notes[l.account] || null }; });
  return { entity: ent, comparison, baseLabel, unavailable, thresholds: th, currency: ent.currency, rows, flagged: rows.filter(r => r.flagged).length, explained: rows.filter(r => r.flagged && r.note?.explanation).length,
    thresholdRule: `Flagged when the change is at least ${th.abs / 100} ${ent.currency} in absolute terms or at least ${th.pct}% of the comparative.` };
});
route('POST', '/periods/:pid/variance/note', { perm: 'work' }, ctx => { const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; const ent = ctx.own('entities', b.entity_id); const reviewed = b.status === 'reviewed'; if (reviewed && !ctx.can('review')) throw forbidden('Only a reviewer can mark a variance explanation reviewed.');
  const ex = ctx.db.get('SELECT * FROM variance_notes WHERE org_id=? AND period_id=? AND entity_id=? AND account=? AND comparison=?', ctx.orgId, p.id, ent.id, String(b.account), String(b.comparison));
  const f = { explanation: b.explanation !== undefined ? cleanText(b.explanation, 3000) : ex?.explanation, status: reviewed ? 'reviewed' : 'explained', user_id: ex?.user_id || ctx.user.id, reviewed_by: reviewed ? ctx.user.id : null, at: ctx.now() };
  if (reviewed && ctx.settings.sod_enforced && f.user_id === ctx.user.id) throw invalid('Someone other than the author must review the explanation.');
  if (ex) ctx.db.update('variance_notes', ex.id, f); else ctx.db.insert('variance_notes', { org_id: ctx.orgId, period_id: p.id, entity_id: ent.id, account: String(b.account), comparison: String(b.comparison), ...f }); ctx.changed('variance'); return { ok: true }; });

const NATURAL = { asset: 1, expense: 1, liability: -1, equity: -1, revenue: -1 };
function buildStatement(lines) {
  const groups = {}; const unmapped = [];
  for (const l of lines) { if (!l.type || !NATURAL[l.type]) { unmapped.push(pick(l, ['entity_id', 'account', 'name', 'amount'])); continue; } const g = ((groups[l.type] ||= {})[l.line || l.name] ||= { line: l.line || l.name, amount: 0, accounts: [] }); const amt = l.amount * NATURAL[l.type]; g.amount += amt; g.accounts.push({ entity_id: l.entity_id, code: l.account, name: l.name, amount: amt, import_id: l.import_id, note: l.note }); }
  const tot = t => sum(Object.values(groups[t] || {}).map(g => g.amount)); const sec = t => Object.values(groups[t] || {});
  const netIncome = tot('revenue') - tot('expense'); const unmappedTotal = sum(unmapped.map(u => u.amount));
  return { income: { revenue: sec('revenue'), expense: sec('expense'), totalRevenue: tot('revenue'), totalExpense: tot('expense'), netIncome }, balance: { asset: sec('asset'), liability: sec('liability'), equity: sec('equity'), totalAssets: tot('asset'), totalLiabilities: tot('liability'), totalEquity: tot('equity'), currentEarnings: netIncome,
    check: tot('asset') - tot('liability') - tot('equity') - netIncome + unmappedTotal }, unmapped, unmappedTotal };
}
export function icMatching(ctx, p) {
  const ents = Object.fromEntries(ctx.db.all('SELECT * FROM entities WHERE org_id=?', ctx.orgId).map(e => [e.id, e])); const base = ctx.org.base_currency; const mode = ctx.settings.rounding; const missing = new Set();
  const rate = ccy => { if (ccy === base) return '1'; const r = ctx.db.get("SELECT rate FROM fx_rates WHERE org_id=? AND period_id=? AND from_ccy=? AND to_ccy=? AND rate_type='closing'", ctx.orgId, p.id, ccy, base); if (!r) missing.add(ccy); return r?.rate || null; };
  const items = ctx.db.all('SELECT * FROM ic_items WHERE org_id=? AND period_id=? ORDER BY id', ctx.orgId, p.id); const pairs = {};
  for (const i of items) { const [a, b] = i.side === 'receivable' ? [i.entity_id, i.counterparty_id] : [i.counterparty_id, i.entity_id]; const k = a + '>' + b; const pr = (pairs[k] ||= { key: k, creditor: ents[a], debtor: ents[b], receivable: null, payable: null, items: [] }); const r = rate(i.currency);
    const tr = r ? translate(i.amount, r, mode) : null; pr.items.push({ ...i, translated: tr, rate: r }); if (i.side === 'receivable') pr.receivable = (pr.receivable || 0) + (tr ?? 0); else pr.payable = (pr.payable || 0) + (tr ?? 0); }
  const list = Object.values(pairs).map(pr => ({ ...pr, difference: pr.receivable != null && pr.payable != null ? pr.receivable - pr.payable : null, oneSided: pr.receivable == null || pr.payable == null, matched: pr.receivable != null && pr.payable != null && pr.receivable === pr.payable, open: pr.items.some(i => i.status === 'open') }));
  return { baseCurrency: base, pairs: list, missingRates: [...missing], rateType: 'closing', note: 'Each side is translated to the base currency at the period closing rate before comparison. A pair with a missing rate is not compared.' };
}
route('GET', '/periods/:pid/intercompany', { perm: 'read' }, ctx => icMatching(ctx, ctx.period(ctx.params.pid)));
route('PATCH', '/ic/:id', { perm: 'work' }, ctx => { const i = ctx.own('ic_items', ctx.params.id); ctx.openPeriod(i.period_id); const f = pick(ctx.body, ['owner_id', 'resolution', 'settlement']); if (ctx.body.status) { if (!['open', 'resolved', 'agreed'].includes(ctx.body.status)) throw invalid('Unknown status.'); if (ctx.body.status !== 'open' && !(ctx.body.resolution || i.resolution)?.trim()) throw invalid('Describe the resolution first.'); f.status = ctx.body.status; }
  if (f.resolution) f.resolution = cleanText(f.resolution, 2000); ctx.db.update('ic_items', i.id, f); ctx.audit('ic.updated', 'ic', i.id, f); ctx.changed('ic', 'overview'); return { ok: true }; });
route('GET', '/periods/:pid/statements', { perm: 'read' }, ctx => {
  const p = ctx.period(ctx.params.pid); const scope = ctx.query.entity || 'consolidated';
  if (scope !== 'consolidated') { const ent = ctx.own('entities', scope); const st = buildStatement(tbCurrent(ctx, p.id, ent.id)); return { scope: ent.code, currency: ent.currency, period: p.name, ...st, basis: 'Entity trial balance in functional currency. Income statement shows period activity.' }; }
  const base = ctx.org.base_currency; const mode = ctx.settings.rounding; const ents = ctx.db.all('SELECT * FROM entities WHERE org_id=? AND active=1', ctx.orgId); const rates = {}, missing = []; const out = []; const fxDetail = [];
  for (const e of ents) {
    const lines = tbCurrent(ctx, p.id, e.id); if (!lines.length) continue; let closing = '1', average = '1';
    if (e.currency !== base) { const get = t => ctx.db.get('SELECT rate, rate_date, source FROM fx_rates WHERE org_id=? AND period_id=? AND from_ccy=? AND to_ccy=? AND rate_type=?', ctx.orgId, p.id, e.currency, base, t); const c = get('closing'), a = get('average'); if (!c || !a) { missing.push({ entity: e.code, currency: e.currency, need: [!c && 'closing', !a && 'average'].filter(Boolean) }); continue; } closing = c.rate; average = a.rate; rates[e.currency] = { closing: c, average: a }; }
    let cta = 0; for (const l of lines) { const isPl = l.type === 'revenue' || l.type === 'expense'; const amt = translate(l.amount, isPl ? average : closing, mode); cta += amt; out.push({ ...l, amount: amt, note: e.currency !== base ? `${e.code} ${l.currency} at ${isPl ? 'average' : 'closing'} ${isPl ? average : closing}` : e.code }); }
    if (cta !== 0) { out.push({ entity_id: e.id, account: 'CTA', name: `Translation difference — ${e.code}`, type: 'equity', line: 'Cumulative translation adjustment (computed)', amount: -cta, note: 'Balancing amount from translating the balance sheet at closing and the income statement at average rates. Historical-rate equity translation is not performed.' }); fxDetail.push({ entity: e.code, cta: -cta }); }
  }
  const ic = icMatching(ctx, p); const elim = []; let elimRecv = 0, elimPay = 0;
  for (const l of out) if (l.is_ic) { if (l.type === 'asset') elimRecv += l.amount; else elimPay += -l.amount; elim.push({ entity_id: l.entity_id, account: l.account, name: l.name, amount: l.amount }); }
  const kept = out.filter(l => !l.is_ic); const icDiff = elimRecv - elimPay;
  if (icDiff !== 0) kept.push({ entity_id: null, account: 'IC-DIFF', name: 'Unreconciled intercompany difference', type: 'asset', line: 'Unreconciled intercompany difference', amount: icDiff, note: 'Receivables eliminated exceed payables eliminated. Resolve in the intercompany workpaper.' });
  const st = buildStatement(kept); const wpDiff = sum(ic.pairs.map(pr => pr.difference || 0));
  return { scope: 'consolidated', currency: base, period: p.name, ...st, missingRates: missing, rates, fx: fxDetail, eliminations: { receivables: elimRecv, payables: elimPay, difference: icDiff, lines: elim, workpaperDifference: wpDiff, reconciles: icDiff === wpDiff, note: 'Elimination difference is compared with the intercompany matching workpaper total.' },
    basis: missing.length ? 'Incomplete: entities without exchange rates are excluded rather than added in a different currency.' : `Translated to ${base}: balance sheet at closing rates, income statement at average rates. Intercompany receivable/payable accounts eliminated.`, entitiesIncluded: ents.filter(e => !missing.some(m => m.entity === e.code)).map(e => e.code) };
});
route('GET', '/periods/:pid/fx', { perm: 'read' }, ctx => ctx.db.all('SELECT * FROM fx_rates WHERE org_id=? AND period_id=?', ctx.orgId, ctx.period(ctx.params.pid).id));
route('PUT', '/periods/:pid/fx', { perm: 'manage' }, ctx => { const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; if (!/^[A-Z]{3}$/.test(b.from_ccy || '') || !['closing', 'average'].includes(b.rate_type) || !/^\d+(\.\d{1,8})?$/.test(String(b.rate)) || Number(b.rate) <= 0) throw invalid('Enter a currency code, rate type (closing or average) and a positive rate with up to 8 decimals.');
  ctx.db.run('INSERT INTO fx_rates(org_id, period_id, from_ccy, to_ccy, rate_type, rate, rate_date, source) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(org_id, period_id, from_ccy, to_ccy, rate_type) DO UPDATE SET rate=excluded.rate, rate_date=excluded.rate_date, source=excluded.source', ctx.orgId, p.id, b.from_ccy, ctx.org.base_currency, b.rate_type, String(b.rate), b.rate_date || (b.rate_type === 'closing' ? p.end_date : null), cleanText(b.source, 120) || 'Entered manually');
  ctx.audit('fx.rate_set', 'period', p.id, pick(b, ['from_ccy', 'rate_type', 'rate'])); ctx.changed('tb', 'ic'); return { ok: true }; });
export { tbCurrent, buildStatement, addDays };
