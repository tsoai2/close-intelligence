// Chart series for the dashboards. Every number here is derived from recorded tasks,
// the rules-based schedule or imported trial balances; nothing is smoothed or invented.
import { route } from '../core.js';
import { schedulePeriod, calendarsFor } from '../engine.js';
import { offsetOf } from '../lib/calendar.js';
import { statementFor } from './financial.js';

const addDay = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const STAGES = [
  ['not_started', 'Not started', ['not_started']],
  ['ready', 'Ready to start', ['ready']],
  ['in_progress', 'In progress', ['in_progress']],
  ['in_review', 'In review', ['submitted']],
  ['approved', 'Approved', ['approved']],
  ['attention', 'Waiting, blocked, returned or re-review', ['waiting', 'blocked', 'changes_requested']],
];

/** Cumulative tasks approved by day: planned (due dates), actual (approval times), projected (schedule). */
function burnUp(ctx, p, now) {
  const { db, orgId } = ctx; const rows = db.all("SELECT id, status, due_at, approved_at, needs_rereview FROM tasks WHERE org_id=? AND period_id=? AND status!='not_applicable'", orgId, p.id);
  if (!rows.length) return null;
  const { result } = schedulePeriod(db, orgId, p, now); const proj = result.error ? {} : result.tasks; const today = now.slice(0, 10); const closed = p.status === 'locked';
  const done = rows.filter(r => r.status === 'approved' && !r.needs_rereview && r.approved_at); const doneIds = new Set(done.map(r => r.id)); const open = rows.filter(r => !doneIds.has(r.id)); const rereview = rows.filter(r => r.status === 'approved' && r.needs_rereview).length;
  const dates = [...rows.map(r => r.due_at), ...done.map(r => r.approved_at), ...open.map(r => proj[r.id]?.finish), p.target_close, closed ? p.actual_close_at : now].filter(Boolean).map(d => d.slice(0, 10)).sort();
  const cal = calendarsFor(db, orgId).defaultCal; const days = []; let guard = 0;
  for (let d = dates[0]; d <= dates[dates.length - 1] && guard++ < 120; d = addDay(d)) {
    const last = closed ? (p.actual_close_at || dates[dates.length - 1]).slice(0, 10) : today;
    const doneBy = done.filter(r => r.approved_at.slice(0, 10) <= d).length;
    // The projection starts from today's actual count so the two lines meet.
    const projected = closed || d < today ? null : d === today ? doneBy : done.length + open.filter(r => proj[r.id]?.finish && proj[r.id].finish.slice(0, 10) <= d).length;
    days.push({ date: d, bd: offsetOf(cal, p.day0, d), planned: rows.filter(r => r.due_at && r.due_at.slice(0, 10) <= d).length, actual: d <= last ? doneBy : null, projected });
  }
  const unprojected = open.filter(r => !proj[r.id]?.finish).length;
  return { total: rows.length, today: closed ? null : today, target: p.target_close ? p.target_close.slice(0, 10) : null, projectedFinish: closed ? null : (result.projected || null), actualClose: p.actual_close_at || null, days, unprojected, rereview,
    basis: { planned: 'Cumulative tasks by due date.', actual: 'Cumulative tasks by recorded approval time.', projected: 'Rules-based estimate: recorded task durations and dependencies, assuming people are available. Not a commitment.' } };
}

function byProcess(ctx, p, now) {
  const rows = ctx.db.all("SELECT process, status, due_at, needs_rereview FROM tasks WHERE org_id=? AND period_id=? AND status!='not_applicable'", ctx.orgId, p.id); const m = new Map();
  for (const r of rows) { const g = m.get(r.process || 'Unassigned') || { process: r.process || 'Unassigned', total: 0, approved: 0, inReview: 0, late: 0 }; g.total++; if (r.status === 'approved' && !r.needs_rereview) g.approved++; else { if (r.status === 'submitted') g.inReview++; if (r.due_at && r.due_at < now) g.late++; } m.set(g.process, g); }
  return [...m.values()].map(g => ({ ...g, open: g.total - g.approved })).sort((a, b) => b.open - a.open || b.total - a.total || a.process.localeCompare(b.process));
}

function financial(ctx, p) {
  const periods = ctx.db.all('SELECT * FROM periods WHERE org_id=? AND end_date<=? ORDER BY end_date DESC LIMIT 6', ctx.orgId, p.end_date).reverse(); const trend = []; let current = null;
  for (const q of periods) {
    if (!ctx.db.val('SELECT count(*) FROM tb_lines WHERE org_id=? AND period_id=? AND current=1', ctx.orgId, q.id)) continue;
    const st = statementFor(ctx, q, 'consolidated'); if (q.id === p.id) current = st;
    trend.push({ periodId: q.id, name: q.name, revenue: st.income.totalRevenue, expense: st.income.totalExpense, netIncome: st.income.netIncome, complete: !st.missingRates.length && !st.unmapped.length });
  }
  if (!current) return { available: false, reason: 'No trial balance has been imported for this period.', trend };
  const steps = [{ label: 'Net revenue', amount: current.income.totalRevenue, kind: 'total' }, ...current.income.expense.slice().sort((a, b) => b.amount - a.amount).map(e => ({ label: e.line, amount: -e.amount, kind: 'change' })), { label: 'Net income', amount: current.income.netIncome, kind: 'total' }];
  return { available: true, currency: current.currency, period: current.period, basis: current.basis, complete: !current.missingRates.length && !current.unmapped.length, entities: current.entitiesIncluded, waterfall: steps, trend };
}

route('GET', '/periods/:pid/dashboard', { perm: 'read' }, ctx => {
  const p = ctx.period(ctx.params.pid); const now = ctx.now();
  const counts = Object.fromEntries(ctx.db.all("SELECT status, count(*) n FROM tasks WHERE org_id=? AND period_id=? AND NOT (status='approved' AND needs_rereview=1) GROUP BY status", ctx.orgId, p.id).map(r => [r.status, r.n]));
  const rereview = ctx.db.val("SELECT count(*) FROM tasks WHERE org_id=? AND period_id=? AND status='approved' AND needs_rereview=1", ctx.orgId, p.id);
  return { period: { id: p.id, name: p.name, status: p.status }, now,
    pipeline: STAGES.map(([key, label, statuses]) => ({ key, label, statuses, count: statuses.reduce((a, s) => a + (counts[s] || 0), 0) + (key === 'attention' ? rereview : 0) })),
    burn: burnUp(ctx, p, now), processes: byProcess(ctx, p, now), financial: financial(ctx, p) };
});
