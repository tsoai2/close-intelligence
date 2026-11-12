// Shared request context, errors, routing table, audit trail, notifications and realtime fan-out.
import crypto from 'node:crypto';
import { J } from './db.js';
import { can } from './auth.js';
import { makeCalendar, localNow } from './lib/calendar.js';

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, 'BAD_REQUEST', m, extra);
export const invalid = (m, extra) => new HttpError(422, 'VALIDATION', m, extra);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found.') => new HttpError(404, 'NOT_FOUND', m);
export const conflict = (m, extra) => new HttpError(409, 'CONFLICT', m, extra);
export const locked = m => new HttpError(423, 'PERIOD_LOCKED', m || 'This period is locked. Reopen it with a recorded reason before changing it.');

export const routes = [];
/** route('POST', '/tasks/:id/transition', { perm: 'work' }, handler). Options: public, perm, raw (binary body), env, sse. */
export function route(method, pattern, opts, handler) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, re, keys, opts, handler });
}

export const DEFAULT_SETTINGS = {
  sod_enforced: true, allow_sod_exception: false, variance_abs: 2500000, variance_pct: 10, rec_threshold: 10000, rounding: 'half-up',
  outlook_variant: 'm365', usage_window_days: 90, similarity_threshold: 0.8, review_queue_warn_hours: 8,
  completion_weights: { high: 3, medium: 2, low: 1 }, escalation: { overdue_hours: 8, notify_roles: ['close_manager'] },
  notify_on_publish: ['owner', 'preparer', 'reviewer'], portal_enabled: false,
  signoff_levels: [{ level: 'controller', label: 'Controller sign-off', role: 'close_manager' }, { level: 'cfo', label: 'CFO sign-off', role: 'executive' }],
  day0_definition: 'Day 0 is the last calendar day of the period. BD 0 is Day 0 if it is a business day, otherwise the last business day on or before it. BD +n is the nth business day after Day 0.',
  hourly_cost_cents: 6500,
};

const streams = new Map(); // key env:org -> Set<res>
export function subscribe(env, orgId, res) { const k = env + ':' + orgId; if (!streams.has(k)) streams.set(k, new Set()); streams.get(k).add(res); res.on('close', () => streams.get(k)?.delete(res)); }
export function broadcast(env, orgId, payload) { for (const res of streams.get(env + ':' + orgId) || []) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ } } }
export function closeStreams() { for (const set of streams.values()) for (const res of set) { try { res.end(); } catch { /* ignore */ } } streams.clear(); }

export function orgSettings(org) { return { ...DEFAULT_SETTINGS, ...J(org.settings, {}) }; }
export function nowFor(env, org) { const s = J(org.settings, {}); return env === 'demo' && s.demo_now ? s.demo_now : localNow(org.timezone); }

export function writeAudit(db, orgId, at, userId, action, targetType, targetId, detail = {}) {
  const prev = db.val('SELECT hash FROM audit_events WHERE org_id=? ORDER BY id DESC LIMIT 1', orgId) || '';
  const d = JSON.stringify(detail); const wall = new Date().toISOString();
  const hash = crypto.createHash('sha256').update([prev, orgId, at, wall, userId ?? '', action, targetType ?? '', targetId ?? '', d].join('|')).digest('hex');
  db.insert('audit_events', { org_id: orgId, at, wall_at: wall, user_id: userId ?? null, action, target_type: targetType ?? null, target_id: targetId == null ? null : String(targetId), detail: d, prev_hash: prev, hash });
}
export function verifyAuditChain(db, orgId) {
  let prev = ''; let n = 0;
  for (const e of db.all('SELECT * FROM audit_events WHERE org_id=? ORDER BY id', orgId)) {
    const hash = crypto.createHash('sha256').update([prev, e.org_id, e.at, e.wall_at, e.user_id ?? '', e.action, e.target_type ?? '', e.target_id ?? '', e.detail].join('|')).digest('hex');
    if (hash !== e.hash || (e.prev_hash || '') !== prev) return { ok: false, brokenAt: e.id, checked: n }; prev = e.hash; n++;
  }
  return { ok: true, checked: n };
}

export function makeCtx({ env, db, req, res, auth, params, query, body }) {
  const user = auth?.user || null; const org = user ? db.get('SELECT * FROM orgs WHERE id=?', user.org_id) : null; const pending = new Set();
  const ctx = {
    env, db, req, res, user, session: auth?.session || null, org, orgId: user?.org_id, params, query, body,
    get settings() { return orgSettings(this.org); },
    now: () => nowFor(env, org),
    can: perm => can(user, perm),
    need(perm, msg) { if (!can(user, perm)) throw forbidden(msg); },
    audit: (action, type, id, detail) => writeAudit(db, user.org_id, nowFor(env, org), user.id, action, type, id, detail),
    notify(userId, type, title, text, link) { if (!userId) return; db.insert('notifications', { org_id: user.org_id, user_id: userId, type, title, body: text || null, link: link || null, at: nowFor(env, org) }); pending.add('notifications'); },
    changed(...keys) { for (const k of keys) pending.add(k); },
    flush() { if (pending.size && user) broadcast(env, user.org_id, { type: 'invalidate', keys: [...pending], by: user.id }); pending.clear(); },
    /** Fetch a row that must belong to the caller's organization. */
    own(table, id, msg) { const row = db.get(`SELECT * FROM ${table} WHERE id=? AND org_id=?`, Number(id), user.org_id); if (!row) throw notFound(msg); return row; },
    period(id) { return this.own('periods', id, 'Period not found.'); },
    openPeriod(id) { const p = this.period(id); if (p.status === 'locked') throw locked(); return p; },
    int(v, name) { const n = Number(v); if (!Number.isInteger(n)) throw bad(`${name || 'id'} must be an integer`); return n; },
    calendars() {
      const cals = {}; for (const c of db.all('SELECT * FROM calendars WHERE org_id=?', user.org_id)) cals[c.id] = makeCalendar(c);
      const byEntity = {}; for (const e of db.all('SELECT id, calendar_id FROM entities WHERE org_id=?', user.org_id)) if (e.calendar_id && cals[e.calendar_id]) byEntity[e.id] = cals[e.calendar_id];
      const first = Object.values(cals)[0] || makeCalendar(); return { byEntity, defaultCal: first, all: cals };
    },
  };
  return ctx;
}
/** Optimistic concurrency: reject when the caller edited an older version, returning the current record. */
export function checkVersion(row, expected, label = 'record') {
  if (expected != null && Number(expected) !== row.version) throw conflict(`This ${label} was changed by someone else since you opened it.`, { current: row });
}
export const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj && obj[k] !== undefined).map(k => [k, obj[k]]));
export const str = (v, max = 4000) => (v == null ? null : String(v).slice(0, max));
/** Remove anything that could execute when rendered; the client also renders all text as text nodes. */
export const cleanText = (v, max = 8000) => (v == null ? null : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max));
