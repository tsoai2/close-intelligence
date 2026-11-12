// @ts-check
// Dependency scheduling (critical path method) over business calendars, plus an optional
// resource-constrained pass. All inputs are explicit; nothing here invents durations.
import { addWorkMinutes, subWorkMinutes, workMinutesBetween, nextWorkInstant } from './calendar.js';

/** @typedef {import('./calendar.js').Cal} Cal */
/** @typedef {{id:number, cal?:string, durationMin:number|null, reviewMin:number|null, status:string, startedAt?:string|null, submittedAt?:string|null, approvedAt?:string|null, notBefore?:string|null, notBeforeNote?:string, preparerId?:number|null, reviewerId?:number|null, dueAt?:string|null, unboundedWait?:boolean}} STask */
/** @typedef {{from:number, to:number, type:'FS'|'SS', lagMin:number, gate:'prepared'|'approved'}} SDep */

/** Find one cycle among execution edges. Returns the node ids along the cycle (first repeated at end) or null.
 * @param {number[]} ids @param {{from:number,to:number}[]} edges @returns {number[]|null} */
export function findCycle(ids, edges) {
  /** @type {Map<number, number[]>} */ const out = new Map(ids.map(i => [i, []]));
  for (const e of edges) { if (!out.has(e.from)) out.set(e.from, []); if (!out.has(e.to)) out.set(e.to, []); /** @type {number[]} */ (out.get(e.from)).push(e.to); }
  /** @type {Map<number, number>} */ const color = new Map();
  /** @type {number[]} */
  const stack = [];
  /** @param {number} n @returns {number[]|null} */
  const visit = n => {
    color.set(n, 1); stack.push(n);
    for (const m of out.get(n) || []) {
      if (color.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!color.get(m)) { const c = visit(m); if (c) return c; }
    }
    stack.pop(); color.set(n, 2); return null;
  };
  for (const id of out.keys()) if (!color.get(id)) { const c = visit(id); if (c) return c; }
  return null;
}

/** Topological order (Kahn). Throws if cyclic. @param {number[]} ids @param {{from:number,to:number}[]} edges */
export function topoOrder(ids, edges) {
  const indeg = new Map(ids.map(i => [i, 0])); /** @type {Map<number, number[]>} */ const out = new Map(ids.map(i => [i, []]));
  for (const e of edges) { if (!indeg.has(e.from) || !indeg.has(e.to)) continue; indeg.set(e.to, (indeg.get(e.to) || 0) + 1); /** @type {number[]} */ (out.get(e.from)).push(e.to); }
  const q = ids.filter(i => !indeg.get(i)); const order = [];
  while (q.length) { const n = /** @type {number} */ (q.shift()); order.push(n); for (const m of out.get(n) || []) { indeg.set(m, (indeg.get(m) || 0) - 1); if (!indeg.get(m)) q.push(m); } }
  if (order.length !== ids.length) throw new Error('Dependency cycle');
  return order;
}

const DONE = new Set(['approved']);
const maxDt = (/** @type {string} */ a, /** @type {string} */ b) => (a >= b ? a : b);

/**
 * @param {{tasks:STask[], deps:SDep[], now:string, calendars:Record<string,Cal>, defaultCal:Cal, targetClose?:string|null,
 *   people?:Record<string,{availableFrom?:string|null}>, resource?:boolean}} input
 */
export function computeSchedule(input) {
  const { tasks, now, calendars, defaultCal } = input;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const deps = input.deps.filter(d => byId.has(d.from) && byId.has(d.to));
  const ids = tasks.map(t => t.id);
  const cycle = findCycle(ids, deps);
  if (cycle) return { error: 'cycle', cycle };
  const order = topoOrder(ids, deps); const topoIdx = new Map(order.map((id, i) => [id, i]));
  /** @type {Map<number, SDep[]>} */ const incoming = new Map(ids.map(i => [i, /** @type {SDep[]} */ ([])]));
  /** @type {Map<number, SDep[]>} */
  const outgoing = new Map(ids.map(i => [i, /** @type {SDep[]} */ ([])]));
  for (const d of deps) { /** @type {SDep[]} */ (incoming.get(d.to)).push(d); /** @type {SDep[]} */ (outgoing.get(d.from)).push(d); }
  const calOf = (/** @type {STask} */ t) => (t.cal && calendars[t.cal]) || defaultCal;
  const warnings = { missingDuration: /** @type {number[]} */ ([]), unboundedWaits: /** @type {number[]} */ ([]), missingReview: /** @type {number[]} */ ([]) };
  /** @type {Record<number, any>} */ const r = {};

  /** Remaining preparation minutes for an unfinished task. @param {STask} t */
  const remaining = t => {
    const dur = t.durationMin ?? 0;
    if (t.status === 'submitted') return 0;
    if (t.startedAt && ['in_progress', 'waiting', 'blocked', 'changes_requested'].includes(t.status)) return Math.max(dur - workMinutesBetween(calOf(t), t.startedAt, now), Math.min(dur, 60));
    return dur;
  };
  /** Earliest moment the remaining work can proceed, with the constraint that drives it.
   * @param {STask} t @param {(id:number)=>any} res */
  const constraint = (t, res) => {
    const cal = calOf(t); let best = { at: now, kind: 'now', from: /** @type {number|null} */ (null), note: 'Cannot start before the current time' };
    if (t.notBefore && t.notBefore > best.at) best = { at: t.notBefore, kind: 'input', from: null, note: t.notBeforeNote || 'Waiting on an external input' };
    for (const d of incoming.get(t.id) || []) {
      const p = res(d.from); if (!p || p.na) continue;
      const base = d.type === 'SS' ? p.es : d.gate === 'prepared' ? p.prepFinish : p.finish;
      if (!base) continue;
      const at = d.lagMin > 0 ? addWorkMinutes(cal, base, d.lagMin) : base;
      if (at > best.at || (at === best.at && best.kind === 'now' && !p.done)) best = { at, kind: 'dep', from: d.from, note: `${d.type}${d.gate === 'prepared' ? ' (prepared)' : ' (approved)'}${d.lagMin ? ` +${d.lagMin}m lag` : ''}` };
    }
    return best;
  };

  for (const id of order) {
    const t = /** @type {STask} */ (byId.get(id)); const cal = calOf(t);
    if (t.status === 'not_applicable') { r[id] = { id, na: true, done: true }; continue; }
    if (DONE.has(t.status)) { const finish = t.approvedAt || t.submittedAt || now; r[id] = { id, done: true, es: t.startedAt || t.submittedAt || finish, prepFinish: t.submittedAt || finish, finish, driver: { kind: 'actual' } }; continue; }
    if (t.durationMin == null) warnings.missingDuration.push(id);
    if (t.reviewerId && t.reviewMin == null) warnings.missingReview.push(id);
    if (t.unboundedWait) warnings.unboundedWaits.push(id);
    const review = t.reviewerId ? t.reviewMin ?? 0 : 0;
    if (t.status === 'submitted') {
      const rs = nextWorkInstant(cal, maxDt(now, t.submittedAt || now));
      r[id] = { id, es: t.startedAt || t.submittedAt || now, prepFinish: t.submittedAt || now, reviewStart: rs, finish: addWorkMinutes(cal, rs, review), driver: { kind: 'in_review', note: 'Submitted; waiting for review' }, rem: 0, review };
      continue;
    }
    const c = constraint(t, x => r[x]); const rem = remaining(t); const start = nextWorkInstant(cal, c.at);
    const prepFinish = addWorkMinutes(cal, start, rem);
    r[id] = { id, es: t.startedAt && t.startedAt < start ? t.startedAt : start, workStart: start, prepFinish, finish: addWorkMinutes(cal, prepFinish, review), driver: c, rem, review };
  }
  const open = order.filter(id => !r[id].done);
  let projected = /** @type {string|null} */ (null);
  for (const id of open) if (!projected || r[id].finish > projected) projected = r[id].finish;
  let lastActual = /** @type {string|null} */ (null);
  for (const id of order) if (r[id].done && !r[id].na && (!lastActual || r[id].finish > lastActual)) lastActual = r[id].finish;

  // Backward pass: latest start/finish that does not move the projected completion.
  if (projected) for (const id of [...order].reverse()) {
    const x = r[id]; if (x.done) continue; const t = /** @type {STask} */ (byId.get(id)); const cal = calOf(t);
    let lf = projected;
    for (const d of outgoing.get(id) || []) {
      const s = r[d.to]; if (!s || s.done || !s.ls) continue;
      const base = d.lagMin > 0 ? subWorkMinutes(cal, s.ls, d.lagMin) : s.ls;
      const cand = d.type === 'SS' ? addWorkMinutes(cal, base, x.rem + x.review) : d.gate === 'prepared' ? addWorkMinutes(cal, base, x.review) : base;
      if (cand < lf) lf = cand;
    }
    x.lf = lf; x.ls = subWorkMinutes(cal, lf, x.rem + x.review);
    const from = x.workStart || x.reviewStart || now;
    x.slackMin = x.ls > from ? workMinutesBetween(cal, from, x.ls) : 0;
  }
  // Critical chain(s): follow the driving constraint back from the task(s) that finish last.
  const critical = new Set(); /** @type {number[][]} */ const paths = [];
  if (projected) for (const id of open) {
    if (r[id].finish !== projected && workMinutesBetween(calOf(/** @type {STask} */ (byId.get(id))), r[id].finish, projected) > 0) continue;
    const path = []; let cur = /** @type {number|null} */ (id); const seen = new Set();
    while (cur != null && !seen.has(cur)) { seen.add(cur); path.unshift(cur); critical.add(cur); const d = r[cur].driver; cur = d && d.kind === 'dep' && !r[d.from].done ? d.from : null; }
    paths.push(path);
  }
  for (const id of open) { r[id].critical = critical.has(id); const t = /** @type {STask} */ (byId.get(id)); r[id].late = !!(t.dueAt && r[id].finish > t.dueAt); }

  // Chain depth (number of execution predecessors in the longest chain) and linkage.
  /** @type {Record<number, number>} */ const depth = {};
  for (const id of order) depth[id] = Math.max(0, ...(incoming.get(id) || []).map(d => depth[d.from] + 1));
  const unlinked = ids.filter(id => !(incoming.get(id) || []).length && !(outgoing.get(id) || []).length);

  /** @type {any} */ let resource = null;
  if (input.resource && projected) {
    /** @type {Record<string, string>} */ const free = {}; const people = input.people || {};
    const freeAt = (/** @type {number|null|undefined} */ p) => (p == null ? now : free[p] ?? maxDt(now, people[p]?.availableFrom || now));
    /** @type {Record<number, any>} */ const rr = {}; const pending = new Set(open); const conflicts = [];
    for (const id of order) if (r[id].done) rr[id] = r[id];
    while (pending.size) {
      const eligible = [...pending].filter(id => (incoming.get(id) || []).every(d => rr[d.from]));
      eligible.sort((a, b) => (r[a].es < r[b].es ? -1 : r[a].es > r[b].es ? 1 : (topoIdx.get(a) || 0) - (topoIdx.get(b) || 0)));
      const id = eligible[0]; const t = /** @type {STask} */ (byId.get(id)); const cal = calOf(t); const x = r[id];
      let prepFinish, es = x.es;
      if (t.status === 'submitted') prepFinish = x.prepFinish;
      else {
        const c = constraint(t, y => rr[y]); const pf = freeAt(t.preparerId);
        const start = nextWorkInstant(cal, maxDt(c.at, pf)); if (pf > c.at && x.rem > 0) conflicts.push({ taskId: id, personId: t.preparerId, kind: 'prepare', waitsUntil: pf });
        prepFinish = addWorkMinutes(cal, start, x.rem); if (t.preparerId != null) free[t.preparerId] = prepFinish; es = start;
      }
      let finish = prepFinish;
      if (x.review > 0) {
        const rf = freeAt(t.reviewerId); const rs = nextWorkInstant(cal, maxDt(maxDt(prepFinish, now), rf));
        if (rf > prepFinish) conflicts.push({ taskId: id, personId: t.reviewerId, kind: 'review', waitsUntil: rf });
        finish = addWorkMinutes(cal, rs, x.review); if (t.reviewerId != null) free[t.reviewerId] = finish;
      }
      rr[id] = { id, es, prepFinish, finish }; pending.delete(id);
    }
    let rp = /** @type {string|null} */ (null); for (const id of open) if (!rp || rr[id].finish > rp) rp = rr[id].finish;
    resource = { projected: rp, conflicts, tasks: Object.fromEntries(open.map(id => [id, { es: rr[id].es, finish: rr[id].finish }])) };
  }
  const withDur = tasks.filter(t => t.status !== 'not_applicable' && t.durationMin != null).length;
  const scoped = tasks.filter(t => t.status !== 'not_applicable').length;
  return {
    now, projected, lastActual, targetClose: input.targetClose || null, tasks: r, criticalPaths: paths, critical: [...critical], depth, unlinked, warnings, resource,
    coverage: { tasksWithDuration: withDur, tasks: scoped, openTasks: open.length },
    assumptions: [
      'Dependency-only projection: assumes people are available whenever a task becomes ready.',
      'Not-started tasks use the full duration estimate; started tasks use estimate minus elapsed working time since start (minimum 1 hour or the estimate if shorter).',
      'Review time is added after preparation where a reviewer is assigned.',
      'Tasks without a duration estimate contribute zero time and are listed as a coverage gap.',
    ],
  };
}
