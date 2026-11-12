import { route, bad, invalid, forbidden, notFound, conflict, checkVersion, cleanText, pick, broadcast, writeAudit } from '../core.js';
import { J } from '../db.js';
import { runFindings, findingView } from '../rules.js';
import { calendarsFor } from '../engine.js';
import { workMinutesBetween, offsetOf } from '../lib/calendar.js';

// ---- Background jobs (in-process queue with progress, retry and cancellation) ----
const running = new Map();
const JOBS = {
  findings(job, db, progress) { const p = db.get('SELECT * FROM periods WHERE id=? AND org_id=?', job.payload.periodId, job.org_id); if (!p) throw new Error('Period not found'); return runFindings(db, job.org_id, p, job.payload.now, progress); },
};
export function enqueue(ctx, kind, payload) {
  const id = ctx.db.insert('jobs', { org_id: ctx.orgId, kind, payload, created_by: ctx.user.id, created_at: ctx.now(), updated_at: ctx.now() }); runJob(ctx.env, ctx.db, id); return id;
}
function runJob(env, db, id) {
  const state = { cancelled: false }; running.set(env + ':' + id, state);
  setImmediate(() => {
    const row = db.get('SELECT * FROM jobs WHERE id=?', id); if (!row || state.cancelled) return; const job = { ...row, payload: J(row.payload, {}) };
    db.update('jobs', id, { status: 'running', attempts: row.attempts + 1, error: null, progress: 0 });
    try { const result = JOBS[job.kind](job, db, pct => { if (state.cancelled) throw new Error('Cancelled'); db.update('jobs', id, { progress: pct }); }); db.update('jobs', id, { status: 'done', progress: 100, result, updated_at: new Date().toISOString() }); broadcast(env, job.org_id, { type: 'invalidate', keys: ['findings', 'jobs'] }); }
    catch (e) { db.update('jobs', id, { status: state.cancelled ? 'cancelled' : 'failed', error: String(e.message).slice(0, 300) }); broadcast(env, job.org_id, { type: 'invalidate', keys: ['jobs'] }); }
    finally { running.delete(env + ':' + id); }
  });
}
route('GET', '/jobs/:id', { perm: 'read' }, ctx => { const j = ctx.own('jobs', ctx.params.id); return { ...j, payload: undefined, result: J(j.result) }; });
route('POST', '/jobs/:id/retry', { perm: 'work' }, ctx => { const j = ctx.own('jobs', ctx.params.id); if (!['failed', 'cancelled'].includes(j.status)) throw invalid('Only failed or cancelled jobs can be retried.'); ctx.db.update('jobs', j.id, { status: 'queued' }); runJob(ctx.env, ctx.db, j.id); return { ok: true }; });
route('POST', '/jobs/:id/cancel', { perm: 'work' }, ctx => { const j = ctx.own('jobs', ctx.params.id); const s = running.get(ctx.env + ':' + j.id); if (s) s.cancelled = true; if (j.status === 'queued') ctx.db.update('jobs', j.id, { status: 'cancelled' }); return { ok: true }; });

// ---- Findings ----
route('POST', '/periods/:pid/findings/run', { perm: 'work' }, ctx => { const p = ctx.period(ctx.params.pid); if (ctx.query.sync === '1') { const r = runFindings(ctx.db, ctx.orgId, p, ctx.now()); ctx.changed('findings'); return { done: true, ...r }; } return { jobId: enqueue(ctx, 'findings', { periodId: p.id, now: ctx.now() }) }; });
route('GET', '/periods/:pid/findings', { perm: 'read' }, ctx => { const p = ctx.period(ctx.params.pid);
  if (!ctx.db.get('SELECT 1 x FROM findings WHERE org_id=? AND period_id=? LIMIT 1', ctx.orgId, p.id) && p.status !== 'locked' && ctx.can('work')) runFindings(ctx.db, ctx.orgId, p, ctx.now());
  const imp = Object.fromEntries(ctx.db.all('SELECT finding_id, id, status, title FROM improvements WHERE org_id=? AND finding_id IS NOT NULL', ctx.orgId).map(i => [i.finding_id, i]));
  return { findings: ctx.db.all("SELECT * FROM findings WHERE org_id=? AND period_id=? AND status!='resolved' ORDER BY category, id", ctx.orgId, p.id).map(f => ({ ...findingView(f), improvement: imp[f.id] || null })), lastRun: ctx.db.val('SELECT MAX(last_seen) FROM findings WHERE org_id=? AND period_id=?', ctx.orgId, p.id),
    engine: 'Rules-based detection from recorded events and calculations. It runs without AI.' }; });
route('GET', '/findings/:id', { perm: 'read' }, ctx => findingView(ctx.own('findings', ctx.params.id)));
route('POST', '/findings/:id/review', { perm: 'work' }, ctx => { const f = ctx.own('findings', ctx.params.id); const s = ctx.body.status; if (!['open', 'acknowledged', 'dismissed', 'confirmed'].includes(s)) throw invalid('Unknown status.');
  if (s === 'dismissed' && !(ctx.body.note || '').trim()) throw invalid('Say why this is not an issue so the reasoning is kept.'); if (s === 'confirmed' && !(ctx.body.confirmedCause || '').trim()) throw invalid('Record the cause you confirmed and how.');
  ctx.db.update('findings', f.id, { status: s, confirmed_cause: s === 'confirmed' ? cleanText(ctx.body.confirmedCause, 2000) : s === 'dismissed' ? `Dismissed: ${cleanText(ctx.body.note, 1000)}` : f.confirmed_cause, reviewed_by: ctx.user.id, reviewed_at: ctx.now() });
  ctx.audit('finding.' + s, 'finding', f.id, { title: f.title }); ctx.changed('findings'); return findingView(ctx.own('findings', f.id)); });

// ---- Improvements ----
const STATES = ['proposed', 'under_review', 'approved', 'pilot', 'implemented', 'validated', 'rejected'];
const NEXT = { proposed: ['under_review', 'rejected'], under_review: ['approved', 'rejected', 'proposed'], approved: ['pilot', 'implemented', 'rejected'], pilot: ['implemented', 'rejected'], implemented: ['validated', 'pilot'], validated: [], rejected: ['proposed'] };
/** Estimate with editable assumptions and a visible calculation. Capacity released is not cash saved. */
export function estimate(details, settings) {
  const a = details.assumptions || {}; const occ = Number(a.occurrences_per_period) || 0; const lo = Number(a.minutes_low) || 0; const hi = Math.max(lo, Number(a.minutes_high) || 0); const rate = Number.isFinite(+a.hourly_cost_cents) && a.hourly_cost_cents !== '' && a.hourly_cost_cents != null ? +a.hourly_cost_cents : settings.hourly_cost_cents;
  const minLow = occ * lo, minHigh = occ * hi; const cost = m => Math.round((m * rate) / 60);
  return { minutesLow: minLow, minutesHigh: minHigh, capacityValueLowCents: cost(minLow), capacityValueHighCents: cost(minHigh), cashSavingsCents: Number(a.cash_savings_cents) || 0, hourlyCostCents: rate,
    calculation: `${occ} occurrence(s) per period × ${lo}–${hi} minutes = ${Math.round(minLow / 6) / 10}–${Math.round(minHigh / 6) / 10} hours of capacity per period; × ${(rate / 100).toFixed(2)} per hour = ${(cost(minLow) / 100).toFixed(0)}–${(cost(minHigh) / 100).toFixed(0)} of labor capacity.`,
    caveat: 'This is labor capacity released, valued at an assumed hourly cost. It is not a cash saving unless headcount, overtime or outside fees actually fall; enter any real cash saving separately with its basis.' };
}
const impView = (i, settings) => { const details = J(i.details, {}); return { ...i, details, history: J(i.history, []), estimate: estimate(details, settings), next: NEXT[i.status] }; };
route('GET', '/improvements', { perm: 'read' }, ctx => {
  const list = ctx.db.all('SELECT * FROM improvements WHERE org_id=? ORDER BY id DESC', ctx.orgId).map(i => impView(i, ctx.settings)); const groups = {};
  for (const i of list.filter(i => !['rejected'].includes(i.status))) { const g = i.details.assumptions?.overlap_group || `own-${i.id}`; (groups[g] ||= []).push(i); }
  let lo = 0, hi = 0, overlaps = 0; for (const g of Object.values(groups)) { lo += Math.max(...g.map(i => i.estimate.minutesLow)); hi += Math.max(...g.map(i => i.estimate.minutesHigh)); if (g.length > 1) overlaps++; }
  return { improvements: list, states: STATES, portfolio: { minutesLow: lo, minutesHigh: hi, overlappingGroups: overlaps, note: 'Portfolio total counts each overlap group once (the largest estimate in the group) so dependent improvements are not double-counted. Task hours released do not add up to days off the close: only changes on the critical path move the date — test that in Process Map → What-if.' } };
});
function validateDetails(d) {
  const c = d.control;
  if (c?.is_control && (!c.objective?.trim() || !c.risks?.trim() || !c.replacement?.trim() || !c.approver_id)) throw invalid('This change touches a control. Record the control objective, the risk of changing it, the replacement safeguard and the designated approver.');
  const a = d.assumptions || {}; for (const k of ['occurrences_per_period', 'minutes_low', 'minutes_high', 'cash_savings_cents']) if (a[k] != null && a[k] !== '' && (!Number.isFinite(+a[k]) || +a[k] < 0)) throw invalid('Assumptions must be non-negative numbers.');
  if (+a.cash_savings_cents > 0 && !(a.cash_basis || '').trim()) throw invalid('Explain the basis for the cash saving (which invoice, fee or cost actually goes down).');
}
const DETAIL_KEYS = ['before', 'after', 'steps', 'costs', 'risks', 'dependencies', 'pilot_period', 'rollback', 'control', 'assumptions', 'success', 'affected', 'measured'];
route('POST', '/improvements', { perm: 'improve' }, ctx => ctx.db.tx(() => {
  const b = ctx.body; if (!b.title?.trim()) throw invalid('Give the proposal a title.'); const details = pick(b.details || {}, DETAIL_KEYS); validateDetails(details); let finding = null;
  if (b.finding_id) { finding = ctx.own('findings', b.finding_id); if (J(finding.payload, {}).informational) throw invalid('This finding records a required document. No retirement or change is proposed for it.'); }
  const id = ctx.db.insert('improvements', { org_id: ctx.orgId, finding_id: finding?.id || null, title: cleanText(b.title, 200), kind: ['eliminate', 'combine', 'resequence', 'automate', 'standardize', 'input_quality', 'ownership', 'pre_close'].includes(b.kind) ? b.kind : 'standardize', description: cleanText(b.description, 4000), owner_id: b.owner_id || ctx.user.id, approver_id: b.approver_id || details.control?.approver_id || null, effort: cleanText(b.effort, 20), details,
    history: [{ at: ctx.now(), by: ctx.user.id, to: 'proposed' }], created_by: ctx.user.id, created_at: ctx.now() });
  if (finding) ctx.db.update('findings', finding.id, { status: finding.status === 'open' ? 'acknowledged' : finding.status });
  ctx.audit('improvement.proposed', 'improvement', id, { title: b.title }); ctx.changed('improvements', 'findings'); return impView(ctx.own('improvements', id), ctx.settings);
}));
route('PATCH', '/improvements/:id', { perm: 'improve' }, ctx => ctx.db.tx(() => { const i = ctx.own('improvements', ctx.params.id); checkVersion(i, ctx.body.expectedVersion, 'proposal'); if (['validated', 'rejected'].includes(i.status)) throw invalid('A closed proposal cannot be edited.'); if (i.created_by !== ctx.user.id && i.owner_id !== ctx.user.id && !ctx.can('improve:approve')) throw forbidden();
  const details = { ...J(i.details, {}), ...pick(ctx.body.details || {}, DETAIL_KEYS) }; validateDetails(details); const f = { details, version: i.version + 1, ...pick(ctx.body, ['owner_id', 'approver_id', 'effort']) }; for (const k of ['title', 'description']) if (ctx.body[k] !== undefined) f[k] = cleanText(ctx.body[k], 4000);
  if (['approved', 'pilot', 'implemented'].includes(i.status) && ctx.body.details && Object.keys(ctx.body.details).some(k => k !== 'measured')) throw invalid('This proposal is already approved. Only measured results can be added; raise a new proposal to change the design.');
  ctx.db.update('improvements', i.id, f); ctx.changed('improvements'); return impView(ctx.own('improvements', i.id), ctx.settings); }));
route('POST', '/improvements/:id/transition', { perm: 'improve' }, ctx => ctx.db.tx(() => {
  const i = ctx.own('improvements', ctx.params.id); const to = ctx.body.to; const note = cleanText(ctx.body.note, 1000); const d = J(i.details, {}); if (!NEXT[i.status].includes(to)) throw invalid(`A proposal that is "${i.status.replace('_', ' ')}" cannot move to "${String(to).replace('_', ' ')}".`);
  if (['approved', 'rejected'].includes(to) && i.status === 'under_review') { if (!ctx.can('improve:approve')) throw forbidden('Only a close manager or administrator can approve or reject a proposal.'); if (to === 'approved') { if (i.created_by === ctx.user.id) throw invalid('Someone other than the author must approve the proposal.');
    if (d.control?.is_control && d.control.approver_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden('This change affects a control and must be approved by its designated approver.'); if (!d.rollback?.trim()) throw invalid('Add a rollback plan before approval.'); } }
  if (to === 'rejected' && !note?.trim()) throw invalid('Record why the proposal is rejected.');
  if (to === 'validated') { const m = d.measured || {}; if (!m.baseline_period_id || !m.post_period_id || m.minutes_before == null || m.minutes_after == null || !(m.comparability || '').trim()) throw invalid('To validate, record the baseline period, the post-change period, measured minutes before and after, and a note on whether scope, volume and data coverage are comparable.'); ctx.period(m.baseline_period_id); ctx.period(m.post_period_id); if (!ctx.can('improve:approve')) throw forbidden('Only a close manager can validate results.'); }
  const history = [...J(i.history, []), { at: ctx.now(), by: ctx.user.id, from: i.status, to, note }]; ctx.db.update('improvements', i.id, { status: to, history, version: i.version + 1 });
  ctx.audit('improvement.' + to, 'improvement', i.id, { title: i.title, note }); if (i.owner_id !== ctx.user.id) ctx.notify(i.owner_id, 'improvement', `Proposal ${to.replace('_', ' ')}: ${i.title}`, note, 'insights/improvements');
  ctx.changed('improvements'); return impView(ctx.own('improvements', i.id), ctx.settings);
}));

// ---- Workload, timing and trends (from recorded events; gaps are reported, not filled in) ----
route('GET', '/periods/:pid/insights', { perm: 'read' }, ctx => {
  const { db, orgId } = ctx; const p = ctx.period(ctx.params.pid); const cals = calendarsFor(db, orgId); const cal = cals.defaultCal; const now = ctx.now();
  const tasks = db.all("SELECT * FROM tasks WHERE org_id=? AND period_id=? AND status!='not_applicable'", orgId, p.id); const users = db.all("SELECT id, name, title, role, capacity_min FROM users WHERE org_id=? AND active=1 AND role!='external'", orgId);
  const workload = users.map(u => { const prep = tasks.filter(t => (t.preparer_id || t.owner_id) === u.id && !['approved', 'submitted'].includes(t.status)); const rev = tasks.filter(t => t.reviewer_id === u.id && t.status === 'submitted'); const revAll = tasks.filter(t => t.reviewer_id === u.id);
    return { userId: u.id, name: u.name, title: u.title, capacityMin: u.capacity_min, openTasks: prep.length, prepMinutes: prep.reduce((a, t) => a + (t.duration_min || 0), 0), reviewQueue: rev.length, reviewMinutes: rev.reduce((a, t) => a + (t.review_min || 0), 0), reviewAssigned: revAll.length, missingEstimates: [...prep.filter(t => t.duration_min == null), ...rev.filter(t => t.review_min == null)].length, taskIds: [...prep, ...rev].map(t => t.id) }; }).filter(w => w.openTasks || w.reviewQueue || w.reviewAssigned);
  const events = db.all('SELECT task_id, type, to_status, at FROM task_events WHERE org_id=? AND period_id=? ORDER BY id', orgId, p.id); const evBy = {}; for (const e of events) (evBy[e.task_id] ||= []).push(e);
  const procs = {}; let covered = 0;
  for (const t of tasks) { const pr = (procs[t.process] ||= { process: t.process, tasks: 0, measured: 0, elapsedMin: 0, waitingMin: 0, reviewMin: 0, estimateMin: 0, rounds: 0, reopened: 0 }); pr.tasks++; pr.estimateMin += (t.duration_min || 0) + (t.review_min || 0); pr.rounds += t.review_rounds; pr.reopened += t.reopened_count;
    if (!(t.started_at && t.approved_at)) continue; pr.measured++; covered++; pr.elapsedMin += workMinutesBetween(cal, t.started_at, t.approved_at);
    let waitStart = null, subStart = null; for (const e of evBy[t.id] || []) { if (['waiting', 'blocked'].includes(e.to_status)) waitStart ||= e.at; else if (waitStart) { pr.waitingMin += workMinutesBetween(cal, waitStart, e.at); waitStart = null; } if (e.to_status === 'submitted') subStart = e.at; else if (subStart && ['approved', 'changes_requested'].includes(e.to_status)) { pr.reviewMin += workMinutesBetween(cal, subStart, e.at); subStart = null; } } }
  const history = db.all('SELECT * FROM periods WHERE org_id=? ORDER BY end_date', orgId).map(q => { const ts = db.all("SELECT status, due_at, approved_at, review_rounds, reopened_count FROM tasks WHERE org_id=? AND period_id=? AND status!='not_applicable'", orgId, q.id); const done = ts.filter(t => t.approved_at);
    const lateReq = db.val('SELECT COUNT(*) FROM requests WHERE org_id=? AND period_id=? AND received_at IS NOT NULL AND received_at>due_at', orgId, q.id); const bd = d => (d ? offsetOf(cal, q.day0, d.slice(0, 10)) : null);
    return { id: q.id, name: q.name, status: q.status, targetBd: bd(q.target_close), actualBd: bd(q.actual_close_at), tasks: ts.length, onTime: done.filter(t => t.due_at && t.approved_at <= t.due_at).length, completed: done.length, reviewRounds: ts.reduce((a, t) => a + t.review_rounds, 0), reopened: ts.reduce((a, t) => a + t.reopened_count, 0), lateRequests: lateReq }; });
  const base = history.find(h => h.id === p.id)?.tasks || 0;
  return { workload, workloadNote: 'Hours are planning estimates recorded on tasks, not measured effort. People are not monitored.', timing: Object.values(procs).sort((a, b) => b.elapsedMin - a.elapsedMin),
    timingCoverage: { tasksWithStartAndApproval: covered, tasks: tasks.length, note: 'Elapsed time runs from recorded start to approval in working hours. Waiting and review time come from status events. Active effort is not measured: a task in progress for eight hours is not eight hours of labor.' },
    history: history.map(h => ({ ...h, comparable: base ? Math.abs(h.tasks - base) / base <= 0.1 : false })), comparabilityRule: 'Periods are marked comparable when their task count is within 10% of the selected period.', now };
});

// ---- Retrospective ----
route('GET', '/periods/:pid/retro', { perm: 'read' }, ctx => { const p = ctx.period(ctx.params.pid); const { db, orgId } = ctx;
  const late = db.all("SELECT id, key, name, due_at, approved_at FROM tasks WHERE org_id=? AND period_id=? AND approved_at IS NOT NULL AND approved_at>due_at ORDER BY approved_at DESC LIMIT 12", orgId, p.id);
  const reopened = db.all('SELECT id, key, name, reopened_count, review_rounds FROM tasks WHERE org_id=? AND period_id=? AND (reopened_count>0 OR review_rounds>1) ORDER BY reopened_count DESC LIMIT 12', orgId, p.id);
  const lateReq = db.all('SELECT id, title, due_at, received_at, recipient_org FROM requests WHERE org_id=? AND period_id=? AND ((received_at IS NOT NULL AND received_at>due_at) OR (received_at IS NULL AND due_at<? AND status IN (\'sent\',\'acknowledged\')))', orgId, p.id, ctx.now());
  return { period: pick(p, ['id', 'name', 'status', 'target_close', 'actual_close_at']), facts: { lateTasks: late, reopened, lateRequests: lateReq }, items: db.all('SELECT * FROM retro_items WHERE org_id=? AND period_id=? ORDER BY id', orgId, p.id),
    sections: { delayed: 'What delayed the close', reopened: 'What was reopened or reworked', worked: 'What worked well', change: 'What we will change next month' } }; });
route('POST', '/periods/:pid/retro', { perm: 'work' }, ctx => { const p = ctx.period(ctx.params.pid); const b = ctx.body; if (!['delayed', 'reopened', 'worked', 'change'].includes(b.section) || !b.text?.trim()) throw invalid('Choose a section and write the note.'); if (b.section === 'change' && !b.owner_id) throw invalid('Every change for next month needs an owner.'); if (b.owner_id) ctx.own('users', b.owner_id);
  const id = ctx.db.insert('retro_items', { org_id: ctx.orgId, period_id: p.id, section: b.section, text: cleanText(b.text, 2000), owner_id: b.owner_id || null, due_at: b.due_at || null, created_by: ctx.user.id, at: ctx.now() }); if (b.owner_id && b.owner_id !== ctx.user.id) ctx.notify(b.owner_id, 'retro', `Action from ${p.name} retrospective`, b.text.slice(0, 200), 'reports/retro'); ctx.changed('retro'); return { id }; });
route('PATCH', '/retro/:id', { perm: 'work' }, ctx => { const r = ctx.own('retro_items', ctx.params.id); if (!['open', 'done'].includes(ctx.body.status)) throw invalid('Status must be open or done.'); ctx.db.update('retro_items', r.id, { status: ctx.body.status }); ctx.changed('retro'); return { ok: true }; });
export { bad, notFound, conflict, writeAudit };
