// Period creation / rollover from a published template version, and template version management.
import { J } from './db.js';
import { orgSettings } from './core.js';
import { calendarsFor, dueAtFor, recomputeReadiness } from './engine.js';
import { businessDayOffset, monthPeriod } from './lib/calendar.js';
import { findCycle } from './lib/schedule.js';
import { LIBRARY } from './seed/templates.js';

export function importLibraryTemplate(db, orgId, kind, at) {
  const lib = LIBRARY[kind]; if (!lib) throw new Error('Unknown library template');
  const tid = db.insert('templates', { org_id: orgId, name: lib.name, kind, description: lib.description });
  const vid = db.insert('template_versions', { template_id: tid, version: 1, status: 'published', notes: 'Imported from the built-in library', created_at: at, published_at: at });
  for (const t of lib.tasks()) db.insert('template_tasks', { template_version_id: vid, ...t });
  return { templateId: tid, versionId: vid };
}
export function validateTemplateVersion(db, versionId) {
  const tasks = db.all('SELECT * FROM template_tasks WHERE template_version_id=?', versionId); const keys = new Map(tasks.map((t, i) => [t.key, i])); const problems = [], edges = [];
  if (keys.size !== tasks.length) problems.push('Task keys must be unique.');
  tasks.forEach((t, i) => { for (const d of J(t.deps, [])) { if (!keys.has(d.key)) problems.push(`${t.key} depends on "${d.key}", which is not in this version.`); else edges.push({ from: keys.get(d.key), to: i }); } });
  const cycle = findCycle(tasks.map((_, i) => i), edges); if (cycle) problems.push(`Circular dependency: ${cycle.map(i => tasks[i].key).join(' → ')}.`);
  return problems;
}
/** Create a period and its task instances from a template version. Assignments and instructions carry forward from the
 * most recent earlier period; evidence, step completion and sign-offs always start fresh. */
export function instantiatePeriod(db, orgId, o) {
  const org = db.get('SELECT * FROM orgs WHERE id=?', orgId); const settings = orgSettings(org); const cals = calendarsFor(db, orgId);
  const ver = db.get('SELECT v.*, t.org_id FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.id=?', o.templateVersionId);
  if (!ver || ver.org_id !== orgId) throw new Error('Template version not found'); if (ver.status !== 'published') throw new Error('Only a published template version can be used to open a period.');
  const targetClose = dueAtFor(cals.defaultCal, o.end, o.targetOffsetBd ?? 6, '17:00');
  const prior = db.get('SELECT * FROM periods WHERE org_id=? AND end_date<? ORDER BY end_date DESC LIMIT 1', orgId, o.start);
  const pid = db.insert('periods', { org_id: orgId, name: o.name, kind: o.kind || 'monthly', start_date: o.start, end_date: o.end, day0: o.end, target_close: targetClose, template_version_id: ver.id });
  const entities = db.all('SELECT * FROM entities WHERE org_id=? AND active=1 ORDER BY id', orgId).filter(e => !o.entityIds || o.entityIds.includes(e.id));
  const tts = db.all('SELECT * FROM template_tasks WHERE template_version_id=? ORDER BY offset_bd, id', ver.id).filter(t => o.kind !== 'monthly' ? true : t.recurrence === 'monthly' || !t.recurrence);
  const priorTasks = prior ? Object.fromEntries(db.all('SELECT * FROM tasks WHERE org_id=? AND period_id=?', orgId, prior.id).map(t => [t.key + '|' + (t.entity_id ?? ''), t])) : {};
  const made = {}; // key -> [{id, entity_id}]
  for (const tt of tts) {
    const targets = tt.scope === 'group' ? [null] : entities.filter(e => !o.only || !o.only[tt.key] || o.only[tt.key].includes(e.code));
    for (const e of targets) {
      const prev = priorTasks[tt.key + '|' + (e?.id ?? '')]; const cal = (e && cals.byEntity[e.id]) || cals.defaultCal;
      const id = db.insert('tasks', { org_id: orgId, period_id: pid, entity_id: e?.id ?? null, template_task_id: tt.id, key: tt.key, name: tt.name, process: tt.process, account: tt.account, description: tt.description, purpose: tt.purpose, instructions: prev?.instructions || tt.instructions,
        recurrence: tt.recurrence, offset_bd: tt.offset_bd, due_at: dueAtFor(cal, o.end, tt.offset_bd, tt.due_time || '17:00'), duration_min: prev?.duration_min ?? tt.duration_min, review_min: prev?.review_min ?? tt.review_min, priority: tt.priority, risk: tt.risk,
        owner_id: prev?.owner_id ?? null, preparer_id: prev?.preparer_id ?? null, reviewer_id: prev?.reviewer_id ?? null, backup_id: prev?.backup_id ?? null, consulted: prev?.consulted || '[]', informed: prev?.informed || '[]', evidence_req: tt.evidence, acceptance: tt.acceptance, updated_at: o.at });
      J(tt.steps, []).forEach((label, i) => db.insert('task_steps', { task_id: id, label, sort: i }));
      (made[tt.key] ||= []).push({ id, entity_id: e?.id ?? null });
    }
  }
  for (const tt of tts) for (const d of J(tt.deps, [])) for (const to of made[tt.key] || []) {
    const froms = (made[d.key] || []).filter(f => f.entity_id === to.entity_id || f.entity_id === null || to.entity_id === null);
    for (const f of froms) db.run('INSERT OR IGNORE INTO dependencies(org_id, period_id, from_task_id, to_task_id, type, lag_min, gate) VALUES(?,?,?,?,?,?,?)', orgId, pid, f.id, to.id, d.type || 'FS', d.lag_min || 0, d.gate || 'approved');
  }
  settings.signoff_levels.forEach((s, i) => db.insert('signoffs', { org_id: orgId, period_id: pid, level: s.level, label: s.label, required_role: s.role, sort: i }));
  const taskId = (key, entityId) => (made[key] || []).find(m => m.entity_id === (entityId ?? null))?.id || null;
  if (prior) {
    for (const r of db.all('SELECT r.*, t.key task_key FROM reconciliations r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.org_id=? AND r.period_id=?', orgId, prior.id))
      db.insert('reconciliations', { org_id: orgId, period_id: pid, entity_id: r.entity_id, task_id: r.task_key ? taskId(r.task_key, r.entity_id) : null, account: r.account, name: r.name, currency: r.currency, beginning: r.gl_balance, threshold: r.threshold, preparer_id: r.preparer_id, reviewer_id: r.reviewer_id, support_source: r.support_source, updated_at: o.at });
    for (const r of db.all("SELECT * FROM requests WHERE org_id=? AND period_id=? AND status!='cancelled'", orgId, prior.id)) {
      const linked = db.all('SELECT t.key, t.entity_id, t.offset_bd FROM request_tasks rt JOIN tasks t ON t.id=rt.task_id WHERE rt.request_id=?', r.id); const off = linked[0]?.offset_bd ?? 1;
      const rid = db.insert('requests', { org_id: orgId, period_id: pid, title: r.title, deliverable: r.deliverable, sender_id: r.sender_id, recipient_name: r.recipient_name, recipient_org: r.recipient_org, recipient_user_id: r.recipient_user_id, classification: r.classification, due_at: `${businessDayOffset(cals.defaultCal, o.end, off)}T${(r.due_at || 'T12:00').slice(11) || '12:00'}`, status: 'draft', created_at: o.at });
      for (const l of linked) { const t = taskId(l.key, l.entity_id); if (t) db.run('INSERT OR IGNORE INTO request_tasks VALUES(?,?)', rid, t); }
    }
    for (const e of db.all("SELECT * FROM exceptions WHERE org_id=? AND period_id=? AND carryforward=1 AND status='accepted'", orgId, prior.id))
      db.insert('exceptions', { org_id: orgId, period_id: pid, title: e.title, description: `Carried forward from ${prior.name}. ${e.description || ''}`, exposure: e.exposure, currency: e.currency, owner_id: e.owner_id, status: 'open', source_type: 'exception', source_id: e.id, created_at: o.at });
  }
  recomputeReadiness(db, orgId, pid, o.at);
  return { periodId: pid, tasks: Object.values(made).flat().length, taskId, carriedFrom: prior?.name || null };
}
export { monthPeriod };
