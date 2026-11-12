import crypto from 'node:crypto';
import { secureCookies, SESSION_HOURS } from './config.js';

export const ROLES = ['admin', 'close_manager', 'preparer', 'reviewer', 'executive', 'auditor', 'external'];
export const ROLE_LABEL = { admin: 'Administrator', close_manager: 'Close manager', preparer: 'Preparer', reviewer: 'Reviewer', executive: 'Executive (read-only)', auditor: 'Auditor (read-only)', external: 'External contributor' };
const PERMS = {
  admin: ['*'],
  close_manager: ['read', 'work', 'review', 'manage', 'signoff', 'signoff:exec', 'lock', 'docs', 'requests', 'improve', 'improve:approve', 'import', 'export', 'team', 'templates', 'ai:use', 'doc:classify'],
  reviewer: ['read', 'work', 'review', 'docs', 'requests', 'improve', 'import', 'export', 'ai:use'],
  preparer: ['read', 'work', 'docs', 'requests', 'improve', 'import', 'export', 'ai:use'],
  executive: ['read', 'export', 'signoff:exec', 'ai:use'],
  auditor: ['read', 'export'],
  external: ['portal'],
};
export const can = (user, perm) => !!user && (PERMS[user.role] || []).some(p => p === '*' || p === perm);
export const permsOf = user => (user.role === 'admin' ? ['*', ...new Set(Object.values(PERMS).flat())].filter(p => p !== 'portal') : PERMS[user.role] || []);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false; const [alg, n, salt, hash] = stored.split('$'); if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: +n, r: 8, p: 1 }); const want = Buffer.from(hash, 'base64');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.';
  return null;
}
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
export const cookieName = env => `ci_${env}_sid`;
export function parseCookies(header) { const out = {}; for (const part of (header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }

export function createSession(db, user, { preview = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url'); const now = Date.now();
  db.insert('sessions', { id: hashToken(token), user_id: user.id, org_id: user.org_id, csrf, created_at: now, expires_at: now + SESSION_HOURS * 3600e3, last_seen: now, preview });
  return { token, csrf };
}
export function sessionCookie(env, token, { clear = false } = {}) {
  return `${cookieName(env)}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict${secureCookies() ? '; Secure' : ''}; Max-Age=${clear ? 0 : SESSION_HOURS * 3600}`;
}
/** Resolve the session for this environment only. A demo cookie can never authenticate a live request:
 * the cookie name differs and the session row only exists in that environment's database. */
export function authenticate(db, env, req) {
  const token = parseCookies(req.headers.cookie)[cookieName(env)]; if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE id=?', hashToken(token)); const now = Date.now();
  if (!s || s.revoked || s.expires_at < now) return null;
  const user = db.get('SELECT id, org_id, email, name, title, role, active, external_org, backup_user_id, capacity_min, out_from, out_to FROM users WHERE id=?', s.user_id);
  if (!user || !user.active || user.org_id !== s.org_id) return null;
  if (now - s.last_seen > 60000) db.run('UPDATE sessions SET last_seen=? WHERE id=?', now, s.id);
  return { user, session: s };
}
export const revokeSession = (db, id) => db.run('UPDATE sessions SET revoked=1 WHERE id=?', id);
export const revokeUserSessions = (db, userId) => db.run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId);
export const newInviteToken = () => { const token = crypto.randomBytes(24).toString('base64url'); return { token, hash: hashToken(token) }; };
export const hashInvite = hashToken;

const attempts = new Map();
/** Small in-memory limiter for sign-in attempts and other sensitive endpoints. */
export function rateLimit(key, max, windowMs) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < windowMs); a.push(now); attempts.set(key, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some(t => now - t < windowMs)) attempts.delete(k);
  return a.length <= max;
}
export const resetRateLimits = () => attempts.clear();
