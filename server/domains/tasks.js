import { route, bad, invalid, forbidden, notFound, conflict, checkVersion, cleanText, pick } from '../core.js';
import { J } from '../db.js';
import { can } from '../auth.js';
import { STATUS_LABEL, overview, schedulePeriod, recomputeReadiness, taskGaps, unmetPredecessors, validateDependency, calendarsFor, dueAtFor } from '../engine.js';
import { workMinutesBetween, offsetOf } from '../lib/calendar.js';

const LIST_COLS = 'id, period_id, entity_id, key, name, process, account, status, owner_id, preparer_id, reviewer_id, backup_id, due_at, offset_bd, risk, priority, duration_min, review_min, needs_rereview, upstream_changed, wait_reason, started_at, submitted_at, approved_at, review_rounds, reopened_count, recurrence, version';
const EDITABLE = ['name', 'process', 'account', 'description', 'purpose', 'instructions', 'recurrence', 'due_at', 'duration_min', 'review_min', 'priority', 'risk', 'owner_id', 'preparer_id', 'reviewer_id', 'backup_id', 'acceptance', 'entity_id'];
const isWorker = (u, t) => can(u, 'manage') || (can(u, 'work') && [t.owner_id, t.preparer_id, t.backup_id].includes(u.id));

function decorate(db, orgId, periodId, tasks) {
  const ev = Object.fromEntries(db.all('SELECT task_id, COUNT(*) n FROM evidence WHERE org_id=? AND period_id=? AND removed=0 GROUP BY task_id', orgId, periodId).map(r => [r.task_id, r.n]));
  const st = {}; for (const r of db.all('SELECT s.task_id, COUNT(*) n, SUM(s.done) d FROM task_steps s JOIN tasks t ON t.id=s.task_id WHERE t.org_id=? AND t.period_id=? GROUP BY s.task_id', orgId, periodId)) st[r.task_id] = r;
  return tasks.map(t => ({ ...t, evidence_have: ev[t.id] || 0, evidence_need: undefined, steps_done: st[t.id]?.d || 0, steps_total: st[t.id]?.n || 0 }));
}
route('GET', '/periods/:pid/tasks', { perm: 'read' }, ctx => {
  const p = ctx.period(ctx.params.pid);
  const rows = ctx.db.all(`SELECT ${LIST_COLS}, evidence_req FROM tasks WHERE org_id=? AND period_id=? ORDER BY due_at, key, entity_id`, ctx.orgId, p.id);
  return decorate(ctx.db, ctx.orgId, p.id, rows).map(t => ({ ...t, evidence_need: J(t.evidence_req, []).length, evidence_req: undefined }));
});
export function taskDetail(ctx, id) {
  const { db } = ctx; const t = ctx.own('tasks', id, 'Task not found.');
  const deps = db.all(`SELECT d.id, d.type, d.lag_min, d.gate, d.kind, d.from_task_id, d.to_task_id, a.key from_key, a.name from_name, a.status from_status, a.entity_id from_entity, a.started_at,
    b.key to_key, b.name to_name, b.status to_status, b.entity_id to_entity FROM dependencies d JOIN tasks a ON a.id=d.from_task_id JOIN tasks b ON b.id=d.to_task_id WHERE d.org_id=? AND (d.from_task_id=? OR d.to_task_id=?)`, ctx.orgId, t.id, t.id);
  const evidence = db.all(`SELECT e.id, e.requirement, e.at, e.attached_by, v.id version_id, v.version, v.filename, v.sha256, d.id document_id, d.title, d.period_id doc_period FROM evidence e
    JOIN document_versions v ON v.id=e.document_version_id JOIN documents d ON d.id=v.document_id WHERE e.task_id=? AND e.removed=0 ORDER BY e.id`, t.id).map(e => ({ ...e, stale: e.doc_period != null && e.doc_period !== t.period_id }));
  return {
    ...t, consulted: J(t.consulted, []), informed: J(t.informed, []), evidence_req: J(t.evidence_req, []),
    steps: db.all('SELECT * FROM task_steps WHERE task_id=? ORDER BY sort, id', t.id), evidence,
    upstream: deps.filter(d => d.to_task_id === t.id), downstream: deps.filter(d => d.from_task_id === t.id),
    comments: db.all("SELECT * FROM comments WHERE org_id=? AND target_type='task' AND target_id=? ORDER BY id", ctx.orgId, t.id).map(c => ({ ...c, mentions: J(c.mentions, []) })),
    events: db.all('SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 80', t.id),
    approvals: db.all("SELECT * FROM approvals WHERE org_id=? AND target_type='task' AND target_id=? ORDER BY id DESC", ctx.orgId, t.id).map(a => ({ ...a, sod_exception: J(a.sod_exception) })),
    requests: db.all('SELECT r.id, r.title, r.status, r.due_at, r.expected_at, r.recipient_name, r.recipient_org, r.classification FROM requests r JOIN request_tasks rt ON rt.request_id=r.id WHERE rt.task_id=? AND r.org_id=?', t.id, ctx.orgId),
    rec: db.get('SELECT id, name, status FROM reconciliations WHERE org_id=? AND task_id=?', ctx.orgId, t.id),
    controls: db.all('SELECT id, code, name, task_keys FROM controls WHERE org_id=?', ctx.orgId).filter(c => J(c.task_keys, []).includes(t.key)).map(c => ({ id: c.id, code: c.code, name: c.name })),
    gaps: taskGaps(db, t), unmet: unmetPredecessors(db, t).map(d => ({ id: d.from_task_id, key: d.key, name: d.name, status: d.status, gate: d.gate, type: d.type })),
    statusLabel: STATUS_LABEL[t.status],
  };
}
route('GET', '/tasks/:id', { perm: 'read' }, ctx => taskDetail(ctx, ctx.params.id));

function logEvent(ctx, t, type, to, note) { ctx.db.insert('task_events', { org_id: ctx.orgId, period_id: t.period_id, task_id: t.id, type, from_status: t.status, to_status: to ?? t.status, user_id: ctx.user.id, note: note || null, at: ctx.now() }); }
function touch(ctx, t, fields) { ctx.db.update('tasks', t.id, { ...fields, version: t.version + 1, updated_at: ctx.now() }); }
function afterChange(ctx, t) {
  const released = recomputeReadiness(ctx.db, ctx.orgId, t.period_id, ctx.now(), ctx.user.id);
  for (const id of released) { const r = ctx.db.get('SELECT id, key, name, owner_id, preparer_id FROM tasks WHERE id=?', id); ctx.notify(r.preparer_id || r.owner_id, 'released', `Ready to start: ${r.key} ${r.name}`, 'All predecessor requirements are met.', `task:${id}`); }
  ctx.changed('tasks', 'overview', 'schedule', 'today', 'findings');
  return released;
}
/** Flag every prepared/approved execution successor of a task whose approved input changed. */
export function flagDownstream(ctx, taskId, note) {
  const { db } = ctx; const seen = new Set(); const queue = [taskId]; const affected = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const d of db.all("SELECT to_task_id FROM dependencies WHERE org_id=? AND from_task_id=? AND kind='execution'", ctx.orgId, cur)) {
      if (seen.has(d.to_task_id)) continue; seen.add(d.to_task_id); queue.push(d.to_task_id);
      const s = db.get('SELECT * FROM tasks WHERE id=?', d.to_task_id);
      if (!['submitted', 'approved', 'in_progress', 'changes_requested'].includes(s.status)) continue;
      db.update('tasks', s.id, { upstream_changed: 1, needs_rereview: s.status === 'approved' ? 1 : s.needs_rereview, version: s.version + 1, updated_at: ctx.now() });
      db.insert('task_events', { org_id: ctx.orgId, period_id: s.period_id, task_id: s.id, type: 'upstream_changed', from_status: s.status, to_status: s.status, user_id: ctx.user.id, note, at: ctx.now() });
      ctx.notify(s.reviewer_id || s.owner_id, 'rereview', `Input changed: ${s.key} ${s.name}`, note, `task:${s.id}`); affected.push({ id: s.id, key: s.key, name: s.name, status: s.status });
    }
  }
  return affected;
}

export function transition(ctx, t, action, body = {}) {
  const { db, user } = ctx; const note = cleanText(body.note, 2000); const s = ctx.settings;
  const need = (ok, msg) => { if (!ok) throw forbidden(msg); }; const from = (...st) => { if (!st.includes(t.status)) throw invalid(`A task that is "${STATUS_LABEL[t.status]}" cannot be moved with "${action}".`); };
  const reason = () => { if (!note || note.trim().length < 5) throw invalid('Record a reason (at least a few words) for this action.'); return note.trim(); };
  let result = {};
  switch (action) {
    case 'start': {
      need(isWorker(user, t), 'Only the owner, preparer, backup or a close manager can start this task.'); from('not_started', 'ready', 'changes_requested', 'waiting', 'blocked');
      const unmet = t.status === 'not_started' ? unmetPredecessors(db, t) : [];
      if (unmet.length) { if (!can(user, 'manage')) throw invalid(`Not ready: waiting on ${unmet.map(u => u.key).join(', ')}. A close manager can override with a reason.`, { unmet: unmet.map(u => u.key) }); reason(); }
      logEvent(ctx, t, unmet.length ? 'override_start' : 'start', 'in_progress', note); touch(ctx, t, { status: 'in_progress', started_at: t.started_at || ctx.now(), wait_reason: null, override_note: unmet.length ? note : t.override_note }); break;
    }
    case 'wait': case 'block': {
      need(isWorker(user, t)); from('in_progress', 'ready', 'not_started', 'changes_requested', 'waiting', 'blocked'); const r = reason(); const to = action === 'wait' ? 'waiting' : 'blocked';
      logEvent(ctx, t, action, to, r); touch(ctx, t, { status: to, wait_reason: r }); break;
    }
    case 'resume': { need(isWorker(user, t)); from('waiting', 'blocked'); logEvent(ctx, t, 'resume', 'in_progress', note); touch(ctx, t, { status: 'in_progress', wait_reason: null, started_at: t.started_at || ctx.now() }); break; }
    case 'submit': {
      need(isWorker(user, t), 'Only the owner, preparer, backup or a close manager can submit this task.'); from('in_progress', 'changes_requested');
      const gaps = taskGaps(db, t);
      if (!gaps.ok) { if (!(body.override && can(user, 'manage'))) throw invalid('Not ready to submit: ' + [gaps.steps.length ? `${gaps.steps.length} mandatory step(s) open` : '', gaps.evidence.length ? `missing evidence (${gaps.evidence.join('; ')})` : ''].filter(Boolean).join(' and ') + '.', { gaps }); reason(); }
      const to = t.reviewer_id ? 'submitted' : 'approved';
      logEvent(ctx, t, gaps.ok ? 'submit' : 'override_submit', to, note); touch(ctx, t, { status: to, submitted_at: ctx.now(), approved_at: to === 'approved' ? ctx.now() : null, upstream_changed: 0, needs_rereview: 0, override_note: gaps.ok ? t.override_note : note });
      if (t.reviewer_id) ctx.notify(t.reviewer_id, 'review', `Review requested: ${t.key} ${t.name}`, `Submitted by ${user.name}.`, `task:${t.id}`);
      else db.insert('approvals', { org_id: ctx.orgId, target_type: 'task', target_id: t.id, target_version: t.version + 1, user_id: user.id, decision: 'completed_no_review', note: 'No reviewer is assigned to this task.', at: ctx.now() });
      break;
    }
    case 'approve': {
      from('submitted'); const mine = t.reviewer_id === user.id;
      need(can(user, 'review') && (mine || can(user, 'manage')), 'Only the assigned reviewer or a close manager can approve this task.');
      if (!mine) reason();
      const submitter = db.get("SELECT user_id FROM task_events WHERE task_id=? AND type IN ('submit','override_submit') ORDER BY id DESC LIMIT 1", t.id)?.user_id;
      let sod = null;
      if (s.sod_enforced && (user.id === t.preparer_id || user.id === submitter)) {
        const ex = body.sodException;
        if (!s.allow_sod_exception || !can(user, 'manage') || !ex?.reason || String(ex.reason).trim().length < 10 || !ex.compensatingReviewerId || +ex.compensatingReviewerId === user.id)
          throw invalid(s.allow_sod_exception ? 'You prepared this work. A small-team exception needs a recorded reason and a different person named for the compensating review.' : 'Preparer and reviewer must be different people. An administrator can enable a documented small-team exception in Policies.', { sod: true, exceptionAllowed: !!s.allow_sod_exception });
        ctx.own('users', ex.compensatingReviewerId, 'Compensating reviewer not found.');
        sod = { reason: cleanText(ex.reason, 1000), compensatingReviewerId: +ex.compensatingReviewerId };
        ctx.notify(sod.compensatingReviewerId, 'compensating', `Compensating review needed: ${t.key} ${t.name}`, sod.reason, `task:${t.id}`);
      }
      logEvent(ctx, t, 'approve', 'approved', note); touch(ctx, t, { status: 'approved', approved_at: ctx.now(), needs_rereview: 0, upstream_changed: 0 });
      db.insert('approvals', { org_id: ctx.orgId, target_type: 'task', target_id: t.id, target_version: t.version + 1, user_id: user.id, decision: 'approved', note, sod_exception: sod, at: ctx.now() });
      ctx.audit('task.approved', 'task', t.id, { key: t.key, version: t.version + 1, sod: !!sod }); ctx.notify(t.preparer_id || t.owner_id, 'approved', `Approved: ${t.key} ${t.name}`, null, `task:${t.id}`); break;
    }
    case 'request_changes': {
      from('submitted'); need(can(user, 'review') && (t.reviewer_id === user.id || can(user, 'manage')), 'Only the assigned reviewer or a close manager can request changes.'); const r = reason();
      logEvent(ctx, t, 'request_changes', 'changes_requested', r); touch(ctx, t, { status: 'changes_requested', review_rounds: t.review_rounds + 1 });
      db.insert('approvals', { org_id: ctx.orgId, target_type: 'task', target_id: t.id, target_version: t.version, user_id: user.id, decision: 'changes_requested', note: r, at: ctx.now() });
      db.insert('comments', { org_id: ctx.orgId, target_type: 'task', target_id: t.id, user_id: user.id, body: r, kind: 'review_note', at: ctx.now() });
      ctx.notify(t.preparer_id || t.owner_id, 'changes', `Changes requested: ${t.key} ${t.name}`, r, `task:${t.id}`); break;
    }
    case 'reopen': {
      from('approved', 'not_applicable'); need(can(user, 'manage') || (can(user, 'review') && t.reviewer_id === user.id), 'Only the reviewer or a close manager can reopen approved work.'); const r = reason();
      logEvent(ctx, t, 'reopen', 'in_progress', r); touch(ctx, t, { status: 'in_progress', reopened_count: t.reopened_count + 1, approved_at: null, submitted_at: null, needs_rereview: 0 });
      ctx.audit('task.reopened', 'task', t.id, { key: t.key, reason: r }); result.affected = flagDownstream(ctx, t.id, `${t.key} was reopened: ${r}`);
      ctx.notify(t.preparer_id || t.owner_id, 'reopened', `Reopened: ${t.key} ${t.name}`, r, `task:${t.id}`); break;
    }
    case 'mark_na': { need(can(user, 'manage'), 'Only a close manager can mark a task not applicable.'); from('not_started', 'ready', 'in_progress', 'waiting', 'blocked', 'changes_requested'); const r = reason(); logEvent(ctx, t, 'mark_na', 'not_applicable', r); touch(ctx, t, { status: 'not_applicable', override_note: r }); ctx.audit('task.not_applicable', 'task', t.id, { key: t.key, reason: r }); break; }
    case 'accept': { need([t.owner_id, t.preparer_id].includes(user.id), 'Only the assignee can accept the assignment.'); logEvent(ctx, t, 'accept', t.status, null); touch(ctx, t, { accepted_at: ctx.now() }); break; }
    default: throw bad(`Unknown action "${action}".`);
  }
  result.released = afterChange(ctx, t);
  return result;
}
route('POST', '/tasks/:id/transition', { perm: 'read' }, ctx => {
  if (!ctx.can('work') && !ctx.can('review')) throw forbidden('Your role is read-only.');
  return ctx.db.tx(() => {
    const t = ctx.own('tasks', ctx.params.id, 'Task not found.'); ctx.openPeriod(t.period_id); checkVersion(t, ctx.body.expectedVersion, 'task');
    const r = transition(ctx, t, String(ctx.body.action), ctx.body);
    return { ...r, task: taskDetail(ctx, t.id), releasedTasks: r.released.map(id => ctx.db.get('SELECT id, key, name FROM tasks WHERE id=?', id)) };
  });
});
route('PATCH', '/tasks/:id', { perm: 'work' }, ctx => ctx.db.tx(() => {
  const t = ctx.own('tasks', ctx.params.id, 'Task not found.'); ctx.openPeriod(t.period_id); checkVersion(t, ctx.body.expectedVersion, 'task');
  const f = pick(ctx.body.fields || {}, EDITABLE); const structural = Object.keys(f).some(k => !['description', 'instructions', 'purpose'].includes(k));
  if (structural && !ctx.can('manage')) throw forbidden('Only a close manager can change assignments, dates, estimates or risk.');
  if (!ctx.can('manage') && !isWorker(ctx.user, t)) throw forbidden();
  for (const k of ['owner_id', 'preparer_id', 'reviewer_id', 'backup_id']) if (f[k] != null) { const u = ctx.own('users', f[k], 'User not found.'); if (!u.active || u.role === 'external') throw invalid(`${u.name} cannot be assigned.`); }
  if (f.entity_id != null) ctx.own('entities', f.entity_id);
  for (const k of ['duration_min', 'review_min']) if (f[k] != null && (!Number.isInteger(f[k]) || f[k] < 0 || f[k] > 60000)) throw invalid('Estimates must be whole minutes.');
  if (f.due_at != null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.due_at)) throw invalid('Due time must look like 2026-11-03T17:00.');
  if (f.risk && !['low', 'medium', 'high'].includes(f.risk)) throw invalid('Risk must be low, medium or high.');
  for (const k of ['name', 'description', 'purpose', 'instructions', 'acceptance', 'process', 'account']) if (f[k] != null) f[k] = cleanText(f[k]);
  if (f.name !== undefined && !f.name?.trim()) throw invalid('A task needs a name.');
  const before = pick(t, Object.keys(f)); touch(ctx, t, f);
  ctx.db.insert('task_events', { org_id: ctx.orgId, period_id: t.period_id, task_id: t.id, type: 'edit', from_status: t.status, to_status: t.status, user_id: ctx.user.id, note: Object.keys(f).join(', '), at: ctx.now() });
  ctx.audit('task.edited', 'task', t.id, { before, after: f });
  for (const k of ['owner_id', 'preparer_id', 'reviewer_id']) if (f[k] && f[k] !== t[k] && f[k] !== ctx.user.id) ctx.notify(f[k], 'assigned', `Assigned to you: ${t.key} ${f.name || t.name}`, k.replace('_id', ''), `task:${t.id}`);
  ctx.changed('tasks', 'overview', 'schedule', 'today'); return { task: taskDetail(ctx, t.id), undo: { fields: before } };
}));
route('POST', '/periods/:pid/tasks', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; if (!b.name?.trim()) throw invalid('A task needs a name.');
  const cals = calendarsFor(ctx.db, ctx.orgId); const cal = (b.entity_id && cals.byEntity[b.entity_id]) || cals.defaultCal; const off = Number.isInteger(b.offset_bd) ? b.offset_bd : 1;
  if (b.entity_id) ctx.own('entities', b.entity_id);
  const key = cleanText(b.key, 20) || 'ADHOC-' + (ctx.db.val('SELECT COUNT(*) FROM tasks WHERE org_id=? AND period_id=?', ctx.orgId, p.id) + 1);
  const id = ctx.db.insert('tasks', { org_id: ctx.orgId, period_id: p.id, entity_id: b.entity_id || null, key, name: cleanText(b.name, 200), process: cleanText(b.process, 80) || 'Other', offset_bd: off, due_at: dueAtFor(cal, p.day0, off, b.due_time || '17:00'),
    duration_min: b.duration_min ?? null, review_min: b.review_min ?? null, risk: b.risk || 'medium', priority: b.priority || 'normal', owner_id: b.owner_id || null, preparer_id: b.preparer_id || b.owner_id || null, reviewer_id: b.reviewer_id || null,
    description: cleanText(b.description), instructions: cleanText(b.instructions), evidence_req: Array.isArray(b.evidence_req) ? b.evidence_req.map(x => cleanText(x, 200)) : [], recurrence: 'one-time', updated_at: ctx.now() });
  for (const [i, label] of (b.steps || []).entries()) ctx.db.insert('task_steps', { task_id: id, label: cleanText(label, 300), sort: i });
  recomputeReadiness(ctx.db, ctx.orgId, p.id, ctx.now(), ctx.user.id); ctx.audit('task.created', 'task', id, { key }); ctx.changed('tasks', 'overview', 'schedule'); return { id };
}));
route('POST', '/tasks/bulk', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const ids = (ctx.body.ids || []).map(Number).filter(Number.isInteger).slice(0, 500); const { action, value, note } = ctx.body; const done = [], failed = [], undo = [];
  for (const id of ids) {
    const t = ctx.db.get('SELECT * FROM tasks WHERE id=? AND org_id=?', id, ctx.orgId); if (!t) { failed.push({ id, message: 'Not found' }); continue; }
    try {
      ctx.openPeriod(t.period_id);
      if (['owner_id', 'preparer_id', 'reviewer_id'].includes(action)) { if (value != null) { const u = ctx.own('users', value); if (!u.active || u.role === 'external') throw invalid('User cannot be assigned.'); } undo.push({ id, field: action, value: t[action] }); touch(ctx, t, { [action]: value ?? null }); if (value && value !== ctx.user.id) ctx.notify(value, 'assigned', `Assigned to you: ${t.key} ${t.name}`, action.replace('_id', ''), `task:${t.id}`); }
      else if (action === 'risk') { if (!['low', 'medium', 'high'].includes(value)) throw invalid('Bad risk'); undo.push({ id, field: 'risk', value: t.risk }); touch(ctx, t, { risk: value }); }
      else if (action === 'mark_na') transition(ctx, t, 'mark_na', { note });
      else throw bad('Unknown bulk action');
      done.push(id);
    } catch (e) { failed.push({ id, key: t.key, message: e.message }); }
  }
  ctx.audit('task.bulk', 'task', null, { action, count: done.length }); ctx.changed('tasks', 'overview', 'schedule', 'today'); return { done, failed, undo };
}));
route('POST', '/tasks/:id/steps', { perm: 'work' }, ctx => {
  const t = ctx.own('tasks', ctx.params.id); ctx.openPeriod(t.period_id); if (!isWorker(ctx.user, t)) throw forbidden(); if (!ctx.body.label?.trim()) throw invalid('Describe the step.');
  ctx.db.insert('task_steps', { task_id: t.id, label: cleanText(ctx.body.label, 300), mandatory: ctx.body.mandatory === false ? 0 : 1, sort: 999 }); ctx.changed('tasks'); return taskDetail(ctx, t.id);
});
route('POST', '/tasks/:id/steps/:sid', { perm: 'work' }, ctx => {
  const t = ctx.own('tasks', ctx.params.id); ctx.openPeriod(t.period_id); if (!isWorker(ctx.user, t)) throw forbidden('Only people assigned to this task can update its steps.');
  if (['approved', 'submitted'].includes(t.status)) throw invalid('Steps cannot change while the task is in review or approved. Reopen it or ask for changes first.');
  const s = ctx.db.get('SELECT * FROM task_steps WHERE id=? AND task_id=?', ctx.int(ctx.params.sid), t.id); if (!s) throw notFound();
  ctx.db.update('task_steps', s.id, { done: ctx.body.done ? 1 : 0, done_by: ctx.body.done ? ctx.user.id : null, done_at: ctx.body.done ? ctx.now() : null }); ctx.changed('tasks'); return taskDetail(ctx, t.id);
});
route('POST', '/tasks/:id/comments', { perm: 'read' }, ctx => {
  if (!ctx.can('work') && !ctx.can('review') && !ctx.can('signoff:exec')) throw forbidden(); const t = ctx.own('tasks', ctx.params.id); const body = cleanText(ctx.body.body, 4000); if (!body?.trim()) throw invalid('Write a comment first.');
  const users = ctx.db.all("SELECT id, name FROM users WHERE org_id=? AND active=1 AND role!='external'", ctx.orgId); const mentions = users.filter(u => body.includes('@' + u.name)).map(u => u.id);
  ctx.db.insert('comments', { org_id: ctx.orgId, target_type: 'task', target_id: t.id, user_id: ctx.user.id, body, mentions, at: ctx.now() });
  for (const m of mentions) if (m !== ctx.user.id) ctx.notify(m, 'mention', `${ctx.user.name} mentioned you on ${t.key}`, body.slice(0, 200), `task:${t.id}`);
  ctx.changed('tasks'); return taskDetail(ctx, t.id);
});
route('POST', '/tasks/:id/evidence', { perm: 'docs' }, ctx => ctx.db.tx(() => {
  const t = ctx.own('tasks', ctx.params.id); ctx.openPeriod(t.period_id); if (!isWorker(ctx.user, t)) throw forbidden('Only people assigned to this task can attach evidence.');
  const v = ctx.db.get('SELECT v.*, d.org_id, d.title FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?', ctx.int(ctx.body.documentVersionId));
  if (!v || v.org_id !== ctx.orgId) throw notFound('Document version not found.');
  ctx.db.insert('evidence', { org_id: ctx.orgId, task_id: t.id, period_id: t.period_id, document_version_id: v.id, requirement: cleanText(ctx.body.requirement, 200), attached_by: ctx.user.id, at: ctx.now() });
  if (!ctx.db.get("SELECT 1 x FROM doc_links WHERE document_id=? AND target_type='task' AND target_id=?", v.document_id, t.id)) ctx.db.insert('doc_links', { org_id: ctx.orgId, document_id: v.document_id, target_type: 'task', target_id: t.id, rel: 'evidence' });
  const wasApproved = t.status === 'approved'; logEvent(ctx, t, 'evidence_added', t.status, `${v.title} v${v.version}`);
  touch(ctx, t, wasApproved ? { needs_rereview: 1 } : {});
  if (wasApproved) ctx.notify(t.reviewer_id, 'rereview', `Evidence changed after approval: ${t.key}`, `${v.title} v${v.version} was attached after approval.`, `task:${t.id}`);
  ctx.changed('tasks', 'overview', 'documents'); return taskDetail(ctx, t.id);
}));
route('DELETE', '/tasks/:id/evidence/:eid', { perm: 'docs' }, ctx => ctx.db.tx(() => {
  const t = ctx.own('tasks', ctx.params.id); ctx.openPeriod(t.period_id); if (!isWorker(ctx.user, t)) throw forbidden();
  const e = ctx.db.get('SELECT * FROM evidence WHERE id=? AND task_id=? AND removed=0', ctx.int(ctx.params.eid), t.id); if (!e) throw notFound();
  ctx.db.run('UPDATE evidence SET removed=1 WHERE id=?', e.id); logEvent(ctx, t, 'evidence_removed', t.status, 'Detached (the file and its history are retained)');
  touch(ctx, t, t.status === 'approved' ? { needs_rereview: 1 } : {}); ctx.changed('tasks', 'overview'); return taskDetail(ctx, t.id);
}));
route('POST', '/periods/:pid/dependencies', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; const from = ctx.own('tasks', b.from, 'Predecessor not found.'); const to = ctx.own('tasks', b.to, 'Successor not found.');
  if (from.period_id !== p.id || to.period_id !== p.id) throw invalid('Both tasks must be in this period.');
  const kind = b.kind === 'informational' ? 'informational' : 'execution'; const type = b.type === 'SS' ? 'SS' : 'FS'; const lag = Number.isInteger(b.lagMin) ? b.lagMin : 0;
  if (lag < -4800 || lag > 9600) throw invalid('Lag must be between -80 and 160 working hours.');
  if (ctx.db.get('SELECT 1 x FROM dependencies WHERE from_task_id=? AND to_task_id=? AND kind=?', from.id, to.id, kind)) throw conflict('That relationship already exists.');
  const v = validateDependency(ctx.db, ctx.orgId, p.id, from.id, to.id, kind); if (!v.ok) throw invalid(v.message, { cycle: v.cycle });
  const id = ctx.db.insert('dependencies', { org_id: ctx.orgId, period_id: p.id, from_task_id: from.id, to_task_id: to.id, type, lag_min: Math.max(0, lag), gate: b.gate === 'prepared' ? 'prepared' : 'approved', kind });
  recomputeReadiness(ctx.db, ctx.orgId, p.id, ctx.now(), ctx.user.id); ctx.audit('dependency.added', 'dependency', id, { from: from.key, to: to.key, kind, type }); ctx.changed('tasks', 'schedule', 'overview'); return { id };
}));
route('DELETE', '/dependencies/:id', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const d = ctx.own('dependencies', ctx.params.id); ctx.openPeriod(d.period_id); ctx.db.run('DELETE FROM dependencies WHERE id=?', d.id);
  recomputeReadiness(ctx.db, ctx.orgId, d.period_id, ctx.now(), ctx.user.id); ctx.audit('dependency.removed', 'dependency', d.id, { from: d.from_task_id, to: d.to_task_id }); ctx.changed('tasks', 'schedule', 'overview'); return { ok: true, removed: d };
}));

route('GET', '/periods/:pid/overview', { perm: 'read' }, ctx => overview(ctx.db, ctx.orgId, ctx.period(ctx.params.pid), ctx.now()));

function graphPayload(ctx, p, overrides) {
  const { input, result } = schedulePeriod(ctx.db, ctx.orgId, p, ctx.now(), overrides); if (result.error) return { error: result.error, cycle: result.cycle };
  const cals = calendarsFor(ctx.db, ctx.orgId); const bd = (d, eid) => (d ? offsetOf(cals.byEntity[eid] || cals.defaultCal, p.day0, d.slice(0, 10)) : null);
  const tasks = input.rows.map(t => { const r = result.tasks[t.id] || {}; return { id: t.id, key: t.key, name: t.name, process: t.process, entity_id: t.entity_id, status: t.status, risk: t.risk, owner_id: t.owner_id, preparer_id: t.preparer_id, reviewer_id: t.reviewer_id, due_at: t.due_at, offset_bd: t.offset_bd,
    duration_min: t.duration_min, review_min: t.review_min, needs_rereview: t.needs_rereview, es: r.es || null, finish: r.finish || null, prepFinish: r.prepFinish || null, ls: r.ls || null, slackMin: r.slackMin ?? null, critical: !!r.critical, late: !!r.late, done: !!r.done,
    driver: r.driver || null, depth: result.depth[t.id], finishBd: bd(r.finish, t.entity_id), rFinish: result.resource?.tasks[t.id]?.finish || null }; });
  const edges = ctx.db.all('SELECT id, from_task_id f, to_task_id t, type, lag_min, gate, kind FROM dependencies WHERE org_id=? AND period_id=?', ctx.orgId, p.id);
  const slip = result.projected && p.target_close && result.projected > p.target_close ? workMinutesBetween(cals.defaultCal, p.target_close, result.projected) : 0;
  return { now: result.now, targetClose: p.target_close, projected: result.projected, projectedResource: result.resource?.projected || null, resourceConflicts: result.resource?.conflicts || [], slipMin: slip, criticalPaths: result.criticalPaths, tasks, edges,
    unlinked: result.unlinked, warnings: result.warnings, coverage: result.coverage, assumptions: result.assumptions, lastActual: result.lastActual };
}
route('GET', '/periods/:pid/schedule', { perm: 'read' }, ctx => graphPayload(ctx, ctx.period(ctx.params.pid)));

const cleanOverrides = o => ({ durations: o?.durations || {}, reviews: o?.reviews || {}, deliveries: o?.deliveries || {}, assignments: o?.assignments || {}, removeDeps: (o?.removeDeps || []).map(Number), addDeps: o?.addDeps || [], unavailable: o?.unavailable || {} });
function describeOverrides(ctx, o) {
  const tn = id => { const t = ctx.db.get('SELECT key, name FROM tasks WHERE id=? AND org_id=?', Number(id), ctx.orgId); return t ? `${t.key} ${t.name}` : `task ${id}`; }; const un = id => ctx.db.get('SELECT name FROM users WHERE id=? AND org_id=?', Number(id), ctx.orgId)?.name || 'nobody'; const out = [];
  for (const [id, m] of Object.entries(o.durations)) out.push({ kind: 'duration', taskId: +id, text: `Preparation estimate for ${tn(id)} set to ${m / 60} h` });
  for (const [id, m] of Object.entries(o.reviews)) out.push({ kind: 'review', taskId: +id, text: `Review estimate for ${tn(id)} set to ${m / 60} h` });
  for (const [id, at] of Object.entries(o.deliveries)) { const r = ctx.db.get('SELECT title FROM requests WHERE id=? AND org_id=?', Number(id), ctx.orgId); out.push({ kind: 'delivery', requestId: +id, text: `"${r?.title || 'Request ' + id}" delivered ${String(at).replace('T', ' ')}` }); }
  for (const [id, a] of Object.entries(o.assignments)) out.push({ kind: 'assignment', taskId: +id, text: `${tn(id)}: ${a.preparerId ? 'preparer → ' + un(a.preparerId) : ''}${a.preparerId && a.reviewerId ? ', ' : ''}${a.reviewerId ? 'reviewer → ' + un(a.reviewerId) : ''}` });
  for (const id of o.removeDeps) { const d = ctx.db.get('SELECT from_task_id f, to_task_id t FROM dependencies WHERE id=? AND org_id=?', id, ctx.orgId); if (d) out.push({ kind: 'removeDep', depId: id, text: `Remove dependency ${tn(d.f)} → ${tn(d.t)}` }); }
  for (const d of o.addDeps) out.push({ kind: 'addDep', text: `Add dependency ${tn(d.from)} → ${tn(d.to)} (${d.type || 'FS'})` });
  for (const [id, until] of Object.entries(o.unavailable)) out.push({ kind: 'unavailable', userId: +id, text: `${un(id)} unavailable until ${String(until).replace('T', ' ')}` });
  return out;
}
function evaluateScenario(ctx, p, overrides) {
  const o = cleanOverrides(overrides); const base = graphPayload(ctx, p); const sc = graphPayload(ctx, p, o);
  if (sc.error) return { error: sc.error, cycle: sc.cycle, message: 'These assumptions create a circular dependency and cannot be scheduled.' };
  const cals = calendarsFor(ctx.db, ctx.orgId); const delta = (a, b) => (!a || !b ? null : a === b ? 0 : a > b ? -workMinutesBetween(cals.defaultCal, b, a) : workMinutesBetween(cals.defaultCal, a, b));
  const bt = new Map(base.tasks.map(t => [t.id, t])); const changed = sc.tasks.filter(t => !t.done && bt.get(t.id)?.finish !== t.finish).map(t => ({ id: t.id, key: t.key, name: t.name, before: bt.get(t.id)?.finish, after: t.finish, deltaMin: delta(t.finish, bt.get(t.id)?.finish) }));
  const feasible = !sc.projectedResource || sc.projectedResource <= sc.projected;
  return { baseline: pick(base, ['projected', 'projectedResource', 'criticalPaths', 'targetClose', 'slipMin']), scenario: pick(sc, ['projected', 'projectedResource', 'criticalPaths', 'slipMin', 'resourceConflicts', 'warnings', 'coverage']), scenarioTasks: sc.tasks,
    deltaMin: delta(sc.projected, base.projected), deltaResourceMin: delta(sc.projectedResource, base.projectedResource), changed, assumptions: describeOverrides(ctx, o), feasible,
    feasibilityNote: feasible ? 'People constraints do not push the date beyond the dependency-only projection.' : `The dependency-only date assumes parallel work by the same people. With one task at a time per person the projection is ${sc.projectedResource.replace('T', ' ')}; use that date, not the earlier one.`,
    caveats: ['Projections are estimates from recorded durations and dependencies, not commitments.', `${sc.coverage.tasksWithDuration} of ${sc.coverage.tasks} tasks have duration estimates.`, ...(sc.warnings.unboundedWaits.length ? [`${sc.warnings.unboundedWaits.length} waiting task(s) have no expected resolution date; their wait is not included.`] : [])], overrides: o };
}
route('POST', '/periods/:pid/scenario/evaluate', { perm: 'read' }, ctx => evaluateScenario(ctx, ctx.period(ctx.params.pid), ctx.body.overrides)); // read-only: computes, stores nothing
route('GET', '/periods/:pid/scenarios', { perm: 'read' }, ctx => ctx.db.all('SELECT id, name, status, created_by, at, published_at, overrides FROM scenarios WHERE org_id=? AND period_id=? ORDER BY id DESC', ctx.orgId, ctx.period(ctx.params.pid).id).map(s => ({ ...s, overrides: J(s.overrides, {}) })));
route('POST', '/periods/:pid/scenarios', { perm: 'work' }, ctx => { const p = ctx.period(ctx.params.pid); if (!ctx.body.name?.trim()) throw invalid('Name the scenario.'); const r = evaluateScenario(ctx, p, ctx.body.overrides); if (r.error) throw invalid(r.message);
  const id = ctx.db.insert('scenarios', { org_id: ctx.orgId, period_id: p.id, name: cleanText(ctx.body.name, 120), overrides: r.overrides, result: { projected: r.scenario.projected, projectedResource: r.scenario.projectedResource, baseline: r.baseline.projected }, created_by: ctx.user.id, at: ctx.now() }); ctx.changed('scenarios'); return { id }; });
// Publishing is explicit: preview first, then confirm. Only durations, assignments, dependency edits and expected delivery dates are applied.
route('POST', '/scenarios/:id/publish', { perm: 'manage' }, ctx => ctx.db.tx(() => {
  const s = ctx.own('scenarios', ctx.params.id); const p = ctx.openPeriod(s.period_id); if (s.status === 'published') throw conflict('This scenario was already published.');
  const o = cleanOverrides(J(s.overrides, {})); const changes = describeOverrides(ctx, o).filter(c => c.kind !== 'unavailable');
  const skipped = Object.keys(o.unavailable).length ? ['Availability assumptions are not stored; record absences in Team instead.'] : [];
  if (!ctx.body.confirm) return { preview: true, changes, skipped, notify: ctx.settings.notify_on_publish };
  const affected = new Set(); const upd = (id, f) => { const t = ctx.own('tasks', id); ctx.db.update('tasks', t.id, { ...f, version: t.version + 1, updated_at: ctx.now() }); [t.owner_id, t.preparer_id, t.reviewer_id, f.preparer_id, f.reviewer_id].forEach(u => u && affected.add(u)); };
  for (const [id, m] of Object.entries(o.durations)) upd(id, { duration_min: +m }); for (const [id, m] of Object.entries(o.reviews)) upd(id, { review_min: +m });
  for (const [id, a] of Object.entries(o.assignments)) upd(id, { ...(a.preparerId ? { preparer_id: +a.preparerId } : {}), ...(a.reviewerId ? { reviewer_id: +a.reviewerId } : {}) });
  for (const [id, at] of Object.entries(o.deliveries)) { const r = ctx.own('requests', id); ctx.db.update('requests', r.id, { expected_at: at, version: r.version + 1 }); }
  for (const id of o.removeDeps) ctx.db.run('DELETE FROM dependencies WHERE id=? AND org_id=?', id, ctx.orgId);
  for (const d of o.addDeps) { const v = validateDependency(ctx.db, ctx.orgId, p.id, +d.from, +d.to, 'execution'); if (!v.ok) throw invalid(v.message); ctx.db.insert('dependencies', { org_id: ctx.orgId, period_id: p.id, from_task_id: +d.from, to_task_id: +d.to, type: d.type === 'SS' ? 'SS' : 'FS', lag_min: +d.lagMin || 0, gate: d.gate === 'prepared' ? 'prepared' : 'approved' }); }
  ctx.db.update('scenarios', s.id, { status: 'published', published_at: ctx.now(), published_by: ctx.user.id }); ctx.db.run('UPDATE periods SET version=version+1 WHERE id=?', p.id);
  recomputeReadiness(ctx.db, ctx.orgId, p.id, ctx.now(), ctx.user.id); ctx.audit('scenario.published', 'scenario', s.id, { name: s.name, changes: changes.map(c => c.text) });
  for (const u of affected) if (u !== ctx.user.id) ctx.notify(u, 'plan', `Close plan updated: ${s.name}`, `${changes.length} change(s) published by ${ctx.user.name}.`, 'map');
  ctx.changed('tasks', 'schedule', 'overview', 'scenarios', 'requests'); return { published: true, changes, notified: affected.size };
}));

// ---- Today ----
route('GET', '/today', { perm: 'read' }, ctx => {
  const { db, user, orgId } = ctx; const p = ctx.query.period ? ctx.period(ctx.query.period) : db.get("SELECT * FROM periods WHERE org_id=? ORDER BY (status='locked'), end_date DESC LIMIT 1", orgId);
  if (!p) return { period: null, myTasks: [], myReviews: [], requests: [], blockers: [], actions: [], team: null };
  const now = ctx.now(); const tasks = db.all(`SELECT ${LIST_COLS} FROM tasks WHERE org_id=? AND period_id=?`, orgId, p.id); const { result: sched } = schedulePeriod(db, orgId, p, now); const crit = new Set(sched.critical || []);
  const mine = tasks.filter(t => [t.owner_id, t.preparer_id].includes(user.id) || (t.backup_id === user.id)); const open = t => !['approved', 'not_applicable'].includes(t.status);
  const myTasks = mine.filter(t => open(t) && t.status !== 'submitted').sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
  const myReviews = tasks.filter(t => t.reviewer_id === user.id && (t.status === 'submitted' || t.needs_rereview)).sort((a, b) => (a.submitted_at || '').localeCompare(b.submitted_at || ''));
  const reqs = db.all(`SELECT * FROM requests WHERE org_id=? AND period_id=? AND status NOT IN ('accepted','cancelled') AND (sender_id=? OR recipient_user_id=?) ORDER BY due_at`, orgId, p.id, user.id, user.id);
  const blockers = mine.filter(t => ['waiting', 'blocked'].includes(t.status));
  const actions = []; const push = (rank, t, why, verb) => actions.push({ rank, taskId: t.id, key: t.key, name: t.name, status: t.status, due_at: t.due_at, critical: crit.has(t.id), why, verb });
  for (const t of myReviews) push(t.needs_rereview ? 15 : crit.has(t.id) ? 10 : 30, t, t.needs_rereview ? 'An input changed after you approved this; it needs re-review.' : crit.has(t.id) ? 'On the critical path: the projected close date moves with this review.' : 'Waiting in your review queue.', 'Review');
  for (const t of myTasks) {
    if (t.status === 'changes_requested') push(20, t, 'The reviewer asked for changes.', 'Revise');
    else if (['ready', 'in_progress'].includes(t.status) && crit.has(t.id)) push(12, t, 'On the critical path and ready for you.', t.status === 'ready' ? 'Start' : 'Continue');
    else if (['ready', 'in_progress'].includes(t.status) && t.due_at && t.due_at < now) push(25, t, 'Past its due time and ready for you.', t.status === 'ready' ? 'Start' : 'Continue');
    else if (['ready', 'in_progress'].includes(t.status)) push(40, t, t.status === 'ready' ? 'Ready to start.' : 'In progress.', t.status === 'ready' ? 'Start' : 'Continue');
    else if (['waiting', 'blocked'].includes(t.status)) push(35, t, `Waiting: ${t.wait_reason || 'no reason recorded'}`, 'Follow up');
  }
  let team = null;
  if (ctx.can('manage') || user.role === 'executive' || user.role === 'auditor') {
    const queue = {}; for (const t of tasks.filter(t => t.status === 'submitted')) { const q = (queue[t.reviewer_id] ||= { userId: t.reviewer_id, count: 0, minutes: 0, taskIds: [] }); q.count++; q.minutes += t.review_min || 0; q.taskIds.push(t.id); }
    team = { reviewQueues: Object.values(queue).sort((a, b) => b.minutes - a.minutes), unowned: tasks.filter(t => !t.owner_id && open(t)).map(t => pick(t, ['id', 'key', 'name'])),
      overdueRequests: db.all(`SELECT id, title, due_at, expected_at, recipient_org, recipient_name FROM requests WHERE org_id=? AND period_id=? AND status IN ('sent','acknowledged','overdue') AND due_at < ?`, orgId, p.id, now),
      criticalHead: (sched.criticalPaths?.[0] || []).slice(0, 1).map(id => { const t = tasks.find(x => x.id === id); return t && { ...pick(t, ['id', 'key', 'name', 'status', 'wait_reason']), driver: sched.tasks[id].driver }; }).filter(Boolean)[0] || null,
      projected: sched.projected, targetClose: p.target_close };
    // Close-manager actions: what moves the date or removes a risk, from recorded state only.
    const head = team.criticalHead; const act = (rank, target, title, why, verb) => actions.push({ rank, target, key: '', name: title, why, verb, critical: rank <= 6 });
    for (const r of team.overdueRequests) { const onPath = db.all('SELECT task_id FROM request_tasks WHERE request_id=?', r.id).some(x => crit.has(x.task_id)); act(onPath ? 5 : 18, { type: 'request', id: r.id }, `Chase: ${r.title}`, `${r.recipient_org || r.recipient_name} is past the due time${r.expected_at ? `; they expect ${r.expected_at.replace('T', ' ')}` : ' and has given no delivery date'}.${onPath ? ' It is holding the critical path.' : ''}`, 'Open request'); }
    if (head && !team.overdueRequests.length) act(6, { type: 'task', id: head.id }, `Unblock: ${head.key} ${head.name}`, 'First unfinished task on the critical path.', 'Open');
    for (const t of team.unowned) act(14, { type: 'task', id: t.id }, `Assign an owner: ${t.key} ${t.name}`, 'No one is accountable for this task.', 'Assign');
    for (const q of team.reviewQueues) { const u = db.get('SELECT name, capacity_min FROM users WHERE id=?', q.userId); if (u && q.minutes > u.capacity_min) act(16, { type: 'screen', id: 'close/tasks' }, `Rebalance reviews: ${u.name}`, `${q.count} tasks queued, about ${Math.round(q.minutes / 6) / 10} h of review against ${Math.round(u.capacity_min / 6) / 10} h a day.`, 'See queue'); }
    for (const t of tasks.filter(x => x.needs_rereview)) act(17, { type: 'task', id: t.id }, `Re-review required: ${t.key} ${t.name}`, 'An input changed after approval.', 'Open');
  }
  actions.sort((a, b) => a.rank - b.rank || (a.due_at || '').localeCompare(b.due_at || ''));
  return { period: pick(p, ['id', 'name', 'status', 'target_close']), now, myTasks: myTasks.slice(0, 50), myReviews, requests: reqs, blockers, actions: actions.slice(0, 12), team, counts: { tasks: myTasks.length, reviews: myReviews.length, requests: reqs.length, blockers: blockers.length } };
});

// ---- Completion: sign-offs, exceptions, lock / reopen ----
function completion(ctx, p) {
  const { db, orgId } = ctx; const tasks = db.all("SELECT id, key, name, status, needs_rereview, process FROM tasks WHERE org_id=? AND period_id=? AND status!='not_applicable'", orgId, p.id);
  const unfinished = tasks.filter(t => t.status !== 'approved' && t.process !== 'Period lock'); const rereview = tasks.filter(t => t.needs_rereview);
  const recs = db.all("SELECT id, name, status FROM reconciliations WHERE org_id=? AND period_id=? AND status!='approved'", orgId, p.id);
  const exceptions = db.all('SELECT * FROM exceptions WHERE org_id=? AND period_id=? ORDER BY id', orgId, p.id); const openEx = exceptions.filter(e => e.status === 'open');
  const journals = db.all("SELECT id, ref, status FROM journals WHERE org_id=? AND period_id=? AND status IN ('draft','submitted')", orgId, p.id);
  const blockers = [
    { key: 'tasks', label: 'Unapproved tasks', count: unfinished.length, records: unfinished.slice(0, 200).map(t => ({ type: 'task', id: t.id, label: `${t.key} ${t.name}` })) },
    { key: 'rereview', label: 'Approvals needing re-review', count: rereview.length, records: rereview.map(t => ({ type: 'task', id: t.id, label: `${t.key} ${t.name}` })) },
    { key: 'recs', label: 'Reconciliations not approved on current data', count: recs.length, records: recs.map(r => ({ type: 'rec', id: r.id, label: r.name })) },
    { key: 'exceptions', label: 'Exceptions without a disposition', count: openEx.length, records: openEx.map(e => ({ type: 'exception', id: e.id, label: e.title })) },
    { key: 'journals', label: 'Journals not yet approved', count: journals.length, records: journals.map(j => ({ type: 'journal', id: j.id, label: j.ref })) },
  ];
  return { period: p, signoffs: db.all('SELECT * FROM signoffs WHERE org_id=? AND period_id=? ORDER BY sort', orgId, p.id).map(s => ({ ...s, snapshot: J(s.snapshot) })), blockers, canSign: blockers.every(b => b.count === 0), exceptions,
    lateJournals: db.all('SELECT id, ref, description, status FROM journals WHERE org_id=? AND period_id=? AND late=1', orgId, p.id) };
}
route('GET', '/periods/:pid/completion', { perm: 'read' }, ctx => completion(ctx, ctx.period(ctx.params.pid)));
route('POST', '/signoffs/:id/sign', { perm: 'read' }, ctx => ctx.db.tx(() => {
  const s = ctx.own('signoffs', ctx.params.id); const p = ctx.openPeriod(s.period_id); const c = completion(ctx, p);
  if (!(ctx.user.role === s.required_role || ctx.user.role === 'admin' || (s.required_role === 'executive' && false))) throw forbidden(`This sign-off must be given by a user with the ${s.required_role.replace('_', ' ')} role.`);
  if (s.status === 'signed') throw conflict('Already signed.');
  if (!c.canSign) throw invalid('The period is not ready for sign-off: ' + c.blockers.filter(b => b.count).map(b => `${b.count} ${b.label.toLowerCase()}`).join('; ') + '.', { blockers: c.blockers.filter(b => b.count) });
  const prior = c.signoffs.filter(x => x.sort < s.sort && x.status !== 'signed'); if (prior.length) throw invalid(`"${prior[0].label}" must be completed first.`);
  const snapshot = { tasksApproved: ctx.db.val("SELECT COUNT(*) FROM tasks WHERE org_id=? AND period_id=? AND status='approved'", ctx.orgId, p.id), acceptedExceptions: c.exceptions.filter(e => e.status === 'accepted').length, periodVersion: p.version };
  ctx.db.update('signoffs', s.id, { status: 'signed', user_id: ctx.user.id, at: ctx.now(), note: cleanText(ctx.body.note, 1000), snapshot });
  ctx.audit('period.signoff', 'period', p.id, { level: s.level, snapshot }); ctx.changed('completion', 'overview'); return completion(ctx, p);
}));
route('POST', '/periods/:pid/lock', { perm: 'lock' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const c = completion(ctx, p); const pending = c.signoffs.filter(s => s.status !== 'signed');
  if (pending.length) throw invalid(`All sign-offs are required before locking. Outstanding: ${pending.map(s => s.label).join(', ')}.`);
  if (!c.canSign) throw invalid('Something changed after sign-off. Resolve the open items and renew sign-off before locking.', { blockers: c.blockers.filter(b => b.count) });
  for (const t of ctx.db.all("SELECT * FROM tasks WHERE org_id=? AND period_id=? AND process='Period lock' AND status NOT IN ('approved','not_applicable')", ctx.orgId, p.id)) { ctx.db.update('tasks', t.id, { status: 'approved', approved_at: ctx.now(), version: t.version + 1 }); ctx.db.insert('task_events', { org_id: ctx.orgId, period_id: p.id, task_id: t.id, type: 'approve', from_status: t.status, to_status: 'approved', user_id: ctx.user.id, note: 'Completed by the period lock action', at: ctx.now() }); }
  ctx.db.update('periods', p.id, { status: 'locked', actual_close_at: p.actual_close_at || ctx.now(), locked_by: ctx.user.id, lock_note: cleanText(ctx.body.note, 1000), version: p.version + 1 });
  ctx.audit('period.locked', 'period', p.id, { name: p.name, note: 'Locked in CLOSE INTELLIGENCE only. The ERP period is not locked by this action.' }); ctx.changed('me', 'completion', 'overview', 'tasks'); return { ok: true, celebrated: true };
}));
route('POST', '/periods/:pid/reopen', { perm: 'lock' }, ctx => ctx.db.tx(() => {
  const p = ctx.period(ctx.params.pid); if (p.status !== 'locked') throw invalid('Only a locked period can be reopened.'); const reason = cleanText(ctx.body.reason, 1000); if (!reason || reason.trim().length < 10) throw invalid('Record why the period is being reopened (at least 10 characters).');
  ctx.db.update('periods', p.id, { status: 'reopened', version: p.version + 1, lock_note: `Reopened: ${reason}` });
  ctx.db.run("UPDATE signoffs SET status='pending', user_id=NULL, at=NULL, note=NULL WHERE org_id=? AND period_id=?", ctx.orgId, p.id);
  ctx.audit('period.reopened', 'period', p.id, { reason, priorClose: p.actual_close_at });
  for (const u of ctx.db.all("SELECT id FROM users WHERE org_id=? AND role IN ('close_manager','executive') AND active=1", ctx.orgId)) if (u.id !== ctx.user.id) ctx.notify(u.id, 'reopen', `${p.name} was reopened`, reason, 'close/completion');
  ctx.changed('me', 'completion', 'overview', 'tasks'); return { ok: true };
}));
route('POST', '/periods/:pid/exceptions', { perm: 'work' }, ctx => { const p = ctx.openPeriod(ctx.params.pid); const b = ctx.body; if (!b.title?.trim()) throw invalid('Give the exception a title.');
  const id = ctx.db.insert('exceptions', { org_id: ctx.orgId, period_id: p.id, title: cleanText(b.title, 200), description: cleanText(b.description), exposure: Number.isSafeInteger(b.exposure) ? b.exposure : null, currency: b.currency || ctx.org.base_currency, owner_id: b.owner_id || ctx.user.id, due_at: b.due_at || null, source_type: b.source_type || null, source_id: b.source_id || null, created_at: ctx.now() });
  ctx.audit('exception.created', 'exception', id, { title: b.title }); ctx.changed('completion', 'overview'); return { id }; });
route('PATCH', '/exceptions/:id', { perm: 'work' }, ctx => { const e = ctx.own('exceptions', ctx.params.id); ctx.openPeriod(e.period_id); const b = ctx.body; const f = pick(b, ['title', 'description', 'owner_id', 'due_at', 'exposure']);
  if (b.status) { if (!['open', 'resolved', 'accepted'].includes(b.status)) throw invalid('Unknown status.'); if (b.status !== 'open' && !ctx.can('manage')) throw forbidden('Only a close manager can resolve or accept an exception.');
    if (b.status !== 'open' && !(b.disposition || e.disposition)?.trim()) throw invalid('Record the disposition before closing an exception.'); f.status = b.status; f.disposition = cleanText(b.disposition || e.disposition, 2000); f.carryforward = b.carryforward ? 1 : 0; f.approved_by = b.status === 'accepted' ? ctx.user.id : null; }
  ctx.db.update('exceptions', e.id, f); ctx.audit('exception.updated', 'exception', e.id, f); ctx.changed('completion', 'overview'); return ctx.own('exceptions', e.id); });
