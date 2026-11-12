// Close engine: readiness, scheduling inputs, evidence gaps and headline metrics. Pure functions of the
// database so that routes, the demo seed, the rules engine and tests all share one implementation.
import { J } from './db.js';
import { makeCalendar, addDays, businessDayOffset, offsetOf } from './lib/calendar.js';
import { computeSchedule, findCycle } from './lib/schedule.js';
import { orgSettings } from './core.js';

export const STATUS_LABEL = { not_started: 'Not started', ready: 'Ready', in_progress: 'In progress', waiting: 'Waiting', blocked: 'Blocked', submitted: 'Submitted for review', changes_requested: 'Changes requested', approved: 'Approved', not_applicable: 'Not applicable' };
export const OPEN_REQUEST = ['draft', 'sent', 'acknowledged', 'overdue'];

export function calendarsFor(db, orgId) {
  const all = {}; for (const c of db.all('SELECT * FROM calendars WHERE org_id=?', orgId)) all[c.id] = makeCalendar(c);
  const byEntity = {}; for (const e of db.all('SELECT id, calendar_id FROM entities WHERE org_id=?', orgId)) if (all[e.calendar_id]) byEntity[e.id] = all[e.calendar_id];
  return { byEntity, defaultCal: Object.values(all)[0] || makeCalendar(), all };
}
export function dueAtFor(cal, day0, offsetBd, dueTime = '17:00') { return `${businessDayOffset(cal, day0, offsetBd)}T${dueTime}`; }

/** Build explicit scheduler inputs for a period. `overrides` are scenario assumptions and never touch stored data. */
export function scheduleInput(db, orgId, period, now, overrides = {}) {
  const cals = calendarsFor(db, orgId);
  const rows = db.all('SELECT * FROM tasks WHERE org_id=? AND period_id=?', orgId, period.id);
  const removed = new Set(overrides.removeDeps || []);
  let deps = db.all("SELECT * FROM dependencies WHERE org_id=? AND period_id=? AND kind='execution'", orgId, period.id).filter(d => !removed.has(d.id)).map(d => ({ id: d.id, from: d.from_task_id, to: d.to_task_id, type: d.type, lagMin: d.lag_min, gate: d.gate }));
  for (const d of overrides.addDeps || []) deps.push({ from: +d.from, to: +d.to, type: d.type === 'SS' ? 'SS' : 'FS', lagMin: +d.lagMin || 0, gate: d.gate === 'prepared' ? 'prepared' : 'approved' });
  const reqs = db.all(`SELECT r.id, r.title, r.due_at, r.expected_at, r.status, r.recipient_org, r.recipient_name, rt.task_id FROM requests r JOIN request_tasks rt ON rt.request_id=r.id
    WHERE r.org_id=? AND r.period_id=? AND r.status IN ('draft','sent','acknowledged','overdue')`, orgId, period.id);
  const waits = {};
  for (const r of reqs) {
    const at = overrides.deliveries?.[r.id] ?? r.expected_at ?? null; const w = (waits[r.task_id] ||= { at: null, notes: [], unbounded: false });
    if (at) { if (!w.at || at > w.at) w.at = at; w.notes.push(`"${r.title}" from ${r.recipient_org || r.recipient_name || 'recipient'} expected ${at.replace('T', ' ')}`); } else { w.unbounded = true; w.notes.push(`"${r.title}" has no expected delivery date`); }
  }
  const tasks = rows.map(t => {
    const a = overrides.assignments?.[t.id] || {};
    return {
      id: t.id, cal: String(t.entity_id ?? ''), durationMin: overrides.durations?.[t.id] ?? t.duration_min, reviewMin: overrides.reviews?.[t.id] ?? t.review_min, status: t.status,
      startedAt: t.started_at, submittedAt: t.submitted_at, approvedAt: t.approved_at, dueAt: t.due_at, preparerId: a.preparerId ?? t.preparer_id ?? t.owner_id, reviewerId: a.reviewerId !== undefined ? a.reviewerId : t.reviewer_id,
      notBefore: waits[t.id]?.at || null, notBeforeNote: waits[t.id]?.notes.join('; '), unboundedWait: !!waits[t.id]?.unbounded || (['waiting', 'blocked'].includes(t.status) && !waits[t.id]),
    };
  });
  const people = {};
  for (const u of db.all('SELECT id, out_from, out_to FROM users WHERE org_id=?', orgId)) { if (u.out_from && u.out_to && now.slice(0, 10) >= u.out_from && now.slice(0, 10) <= u.out_to) people[u.id] = { availableFrom: addDays(u.out_to, 1) + 'T00:00' }; }
  for (const [uid, until] of Object.entries(overrides.unavailable || {})) people[uid] = { availableFrom: until };
  const calendars = {}; for (const [eid, c] of Object.entries(cals.byEntity)) calendars[eid] = c;
  return { tasks, deps, now, calendars, defaultCal: cals.defaultCal, targetClose: period.target_close, people, resource: true, rows };
}
export function schedulePeriod(db, orgId, period, now, overrides) {
  const input = scheduleInput(db, orgId, period, now, overrides); const result = computeSchedule(input);
  return { input, result };
}
/** Server-side validation for a new execution dependency: no self-links, same period, no cycles (with an explanation). */
export function validateDependency(db, orgId, periodId, from, to, kind) {
  if (from === to) return { ok: false, message: 'A task cannot depend on itself.' };
  if (kind !== 'execution') return { ok: true };
  const edges = db.all("SELECT from_task_id f, to_task_id t FROM dependencies WHERE org_id=? AND period_id=? AND kind='execution'", orgId, periodId).map(d => ({ from: d.f, to: d.t }));
  edges.push({ from, to });
  const cycle = findCycle([...new Set(edges.flatMap(e => [e.from, e.to]))], edges);
  if (!cycle) return { ok: true };
  const names = Object.fromEntries(db.all(`SELECT id, key, name FROM tasks WHERE org_id=? AND id IN (${cycle.map(() => '?').join(',')})`, orgId, ...cycle).map(t => [t.id, `${t.key} ${t.name}`]));
  return { ok: false, cycle, message: `This would create a circular execution dependency: ${cycle.map(id => names[id] || id).join(' → ')}. Each task in the loop would be waiting on itself. Use an informational relationship if you only need to record that they are related.` };
}

const PREPARED = new Set(['submitted', 'approved', 'changes_requested']);
/** Is a predecessor satisfied for the given dependency rule? */
export function depSatisfied(dep, pred) {
  if (pred.status === 'not_applicable') return true;
  if (dep.type === 'SS') return !!pred.started_at || PREPARED.has(pred.status) || pred.status === 'in_progress';
  return dep.gate === 'prepared' ? PREPARED.has(pred.status) && pred.status !== 'changes_requested' : pred.status === 'approved';
}
/** Recalculate Ready / Not started from predecessor state. Returns the ids of tasks released by this pass. */
export function recomputeReadiness(db, orgId, periodId, now, userId = null) {
  const tasks = db.all('SELECT id, status, started_at FROM tasks WHERE org_id=? AND period_id=?', orgId, periodId); const byId = new Map(tasks.map(t => [t.id, t]));
  const deps = db.all("SELECT * FROM dependencies WHERE org_id=? AND period_id=? AND kind='execution'", orgId, periodId); const incoming = new Map();
  for (const d of deps) { if (!incoming.has(d.to_task_id)) incoming.set(d.to_task_id, []); incoming.get(d.to_task_id).push(d); }
  const released = [];
  for (const t of tasks) {
    if (t.status !== 'not_started' && t.status !== 'ready') continue;
    const ok = (incoming.get(t.id) || []).every(d => depSatisfied(d, byId.get(d.from_task_id)));
    const next = ok ? 'ready' : 'not_started'; if (next === t.status) continue;
    db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=?', next, now, t.id);
    db.insert('task_events', { org_id: orgId, period_id: periodId, task_id: t.id, type: ok ? 'released' : 'held', from_status: t.status, to_status: next, user_id: userId, at: now, note: ok ? 'All predecessor requirements met' : 'A predecessor is no longer complete' });
    if (ok) released.push(t.id);
  }
  return released;
}
export function unmetPredecessors(db, task) {
  return db.all(`SELECT d.*, p.key, p.name, p.status, p.started_at FROM dependencies d JOIN tasks p ON p.id=d.from_task_id WHERE d.to_task_id=? AND d.kind='execution'`, task.id).filter(d => !depSatisfied(d, d));
}
/** What still prevents submission: mandatory steps and required evidence for THIS period. */
export function taskGaps(db, task) {
  const steps = db.all('SELECT * FROM task_steps WHERE task_id=? AND mandatory=1 AND done=0 ORDER BY sort', task.id).map(s => s.label);
  const reqs = J(task.evidence_req, []); const ev = db.all(`SELECT e.requirement, d.period_id doc_period, d.title FROM evidence e JOIN document_versions v ON v.id=e.document_version_id JOIN documents d ON d.id=v.document_id WHERE e.task_id=? AND e.removed=0`, task.id);
  const missing = reqs.filter(r => !ev.some(e => e.requirement === r));
  const stale = ev.filter(e => e.doc_period != null && e.doc_period !== task.period_id).map(e => e.title);
  return { steps, evidence: missing, stale, ok: !steps.length && !missing.length };
}

/** Headline metrics with their calculations and the record ids behind every number. */
export function overview(db, orgId, period, now) {
  const org = db.get('SELECT * FROM orgs WHERE id=?', orgId); const settings = orgSettings(org); const cals = calendarsFor(db, orgId);
  const all = db.all('SELECT * FROM tasks WHERE org_id=? AND period_id=?', orgId, period.id); const tasks = all.filter(t => t.status !== 'not_applicable'); const ids = l => l.map(t => t.id);
  const approved = tasks.filter(t => t.status === 'approved' && !t.needs_rereview); const prepared = tasks.filter(t => PREPARED.has(t.status) && t.status !== 'changes_requested');
  const open = tasks.filter(t => t.status !== 'approved'); const overdue = open.filter(t => t.due_at && t.due_at < now);
  const blocked = tasks.filter(t => t.status === 'blocked' || t.status === 'waiting'); const unassigned = tasks.filter(t => !t.owner_id);
  const highRisk = open.filter(t => t.risk === 'high'); const inReview = tasks.filter(t => t.status === 'submitted'); const rereview = tasks.filter(t => t.needs_rereview);
  const evCount = Object.fromEntries(db.all('SELECT task_id, COUNT(*) n FROM evidence WHERE org_id=? AND period_id=? AND removed=0 GROUP BY task_id', orgId, period.id).map(r => [r.task_id, r.n]));
  const missingEvidence = tasks.filter(t => PREPARED.has(t.status) && J(t.evidence_req, []).length > (evCount[t.id] || 0));
  const dueByNow = tasks.filter(t => t.due_at && t.due_at <= now); const dueDone = dueByNow.filter(t => t.status === 'approved');
  const w = settings.completion_weights; const wt = t => w[t.risk] ?? 1; const wsum = l => l.reduce((a, t) => a + wt(t), 0);
  const { result: sched } = schedulePeriod(db, orgId, period, now);
  const recs = db.all('SELECT * FROM reconciliations WHERE org_id=? AND period_id=?', orgId, period.id);
  const recIssues = recs.filter(r => r.status !== 'approved'); const recStale = recs.filter(r => r.status === 'needs_rereview');
  const exceptions = db.all('SELECT * FROM exceptions WHERE org_id=? AND period_id=?', orgId, period.id); const openEx = exceptions.filter(e => e.status === 'open'); const acceptedEx = exceptions.filter(e => e.status === 'accepted');
  const ic = db.all("SELECT COUNT(*) n FROM ic_items WHERE org_id=? AND period_id=? AND status='open'", orgId, period.id)[0].n;
  const reqOpen = db.all(`SELECT id, due_at, status FROM requests WHERE org_id=? AND period_id=? AND status IN ('sent','acknowledged','overdue')`, orgId, period.id);
  const reqOverdue = reqOpen.filter(r => r.due_at && r.due_at < now);
  const reviewAge = inReview.map(t => ({ id: t.id, since: t.submitted_at }));
  const cal = cals.defaultCal; const bd = d => (d ? offsetOf(cal, period.day0, d.slice(0, 10)) : null);
  const quality = [
    { key: 'recs', label: 'Reconciliations approved on current data', pass: recs.length - recIssues.length, total: recs.length, records: recIssues.map(r => ({ type: 'rec', id: r.id })), note: recStale.length ? `${recStale.length} approved on superseded source data` : null },
    { key: 'reviews', label: 'Approvals still valid (no re-review required)', pass: tasks.filter(t => t.status === 'approved').length - rereview.filter(t => t.status === 'approved').length, total: tasks.filter(t => t.status === 'approved').length, records: rereview.map(t => ({ type: 'task', id: t.id })) },
    { key: 'evidence', label: 'Prepared work has all required evidence', pass: prepared.length - missingEvidence.length, total: prepared.length, records: missingEvidence.map(t => ({ type: 'task', id: t.id })) },
    { key: 'highrisk', label: 'High-risk tasks approved', pass: tasks.filter(t => t.risk === 'high').length - highRisk.length, total: tasks.filter(t => t.risk === 'high').length, records: highRisk.map(t => ({ type: 'task', id: t.id })) },
    { key: 'exceptions', label: 'Exceptions dispositioned', pass: exceptions.length - openEx.length, total: exceptions.length, records: openEx.map(e => ({ type: 'exception', id: e.id })) },
  ];
  const metric = (key, label, value, denom, calc, list, extra = {}) => ({ key, label, value, denominator: denom, calculation: calc, records: list.map(t => ({ type: extra.type || 'task', id: t.id ?? t })), ...extra });
  return {
    period: { id: period.id, name: period.name, status: period.status, day0: period.day0, targetClose: period.target_close, actualClose: period.actual_close_at, day0Definition: settings.day0_definition, targetBd: bd(period.target_close) },
    now, nowBd: bd(now),
    counts: Object.fromEntries(Object.keys(STATUS_LABEL).map(s => [s, all.filter(t => t.status === s).length])),
    metrics: [
      metric('approved', 'Approved', approved.length, tasks.length, 'Tasks with status Approved and no re-review flag ÷ tasks in scope (Not applicable excluded).', approved),
      metric('prepared', 'Prepared', prepared.length, tasks.length, 'Tasks Submitted for review or Approved ÷ tasks in scope. Prepared work is not yet reviewed work.', prepared),
      metric('overdue', 'Overdue', overdue.length, open.length, 'Open tasks whose due time is before the current time ÷ open tasks.', overdue),
      metric('blocked', 'Blocked or waiting', blocked.length, open.length, 'Open tasks with status Blocked or Waiting.', blocked),
      metric('unassigned', 'No accountable owner', unassigned.length, tasks.length, 'Tasks with no accountable owner recorded.', unassigned),
      metric('highrisk', 'High-risk unfinished', highRisk.length, tasks.filter(t => t.risk === 'high').length, 'High-risk tasks not yet Approved ÷ high-risk tasks.', highRisk),
      metric('evidence', 'Missing evidence', missingEvidence.length, prepared.length, 'Prepared tasks with fewer attached evidence items than required ÷ prepared tasks.', missingEvidence),
      metric('reviews', 'Awaiting review', inReview.length, tasks.length, 'Tasks in Submitted for review.', inReview, { queue: reviewAge }),
      metric('rereview', 'Re-review required', rereview.length, tasks.length, 'Approved or submitted work whose inputs changed after approval.', rereview),
      metric('exceptions', 'Accepted exceptions', acceptedEx.length, exceptions.length, 'Exceptions accepted for this period ÷ all exceptions logged.', acceptedEx, { type: 'exception' }),
      metric('requests', 'Overdue requests', reqOverdue.length, reqOpen.length, 'Outstanding requests past their due time ÷ outstanding requests.', reqOverdue, { type: 'request' }),
    ],
    completion: {
      unweighted: { done: approved.length, total: tasks.length }, weighted: { done: wsum(approved), total: wsum(tasks), weights: w },
      note: 'Weighted completion counts each task by its risk weight so many low-risk items cannot hide an unfinished high-risk one.',
    },
    timeliness: {
      dueByNow: { done: dueDone.length, total: dueByNow.length, records: dueByNow.filter(t => t.status !== 'approved').map(t => ({ type: 'task', id: t.id })) },
      planned: period.target_close, projected: sched.error ? null : sched.projected, projectedResource: sched.resource?.projected || null, actual: period.actual_close_at,
      definitions: { planned: 'Target close date set for the period.', projected: 'Latest projected approval among open tasks from the dependency schedule (an estimate).', actual: 'Time the period was locked.' },
      coverage: sched.coverage, warnings: sched.warnings, assumptions: sched.assumptions,
      slipMin: null,
    },
    quality, icOpen: ic,
    criticalPath: sched.error ? [] : (sched.criticalPaths[0] || []), cycle: sched.error ? sched.cycle : null,
  };
}
