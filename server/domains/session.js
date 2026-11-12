import { route, bad, invalid, forbidden, notFound, HttpError, subscribe, orgSettings, nowFor, writeAudit } from '../core.js';
import { dbFor, wipeDemo, J } from '../db.js';
import { createSession, sessionCookie, verifyPassword, hashPassword, passwordProblem, revokeSession, permsOf, ROLE_LABEL, rateLimit, hashInvite } from '../auth.js';
import { APP_VERSION } from '../config.js';
import { seedDemo, DEMO_SCENARIOS, checkManifest } from '../seed/demo.js';

const publicUser = u => ({ id: u.id, name: u.name, email: u.email, title: u.title, role: u.role, roleLabel: ROLE_LABEL[u.role], active: !!u.active, externalOrg: u.external_org, backupUserId: u.backup_user_id, capacityMin: u.capacity_min, outFrom: u.out_from, outTo: u.out_to });
function ensureDemo() { const db = dbFor('demo'); if (!db.get('SELECT 1 x FROM orgs LIMIT 1')) seedDemo(db, 'baseline'); return db; }

route('GET', '/auth/status', { public: true }, ctx => {
  if (ctx.env === 'demo') ensureDemo();
  const org = ctx.db.get('SELECT id, name FROM orgs LIMIT 1');
  return { env: ctx.env, bootstrapped: !!org, authenticated: !!ctx.user, sso: { entra: 'not_configured', note: 'Microsoft Entra SSO adapter is present but not configured. Email and password sign-in is active.' },
    demoPersonas: ctx.env === 'demo' ? ctx.db.all("SELECT id, name, title, role FROM users WHERE active=1 ORDER BY id").map(u => ({ ...u, roleLabel: ROLE_LABEL[u.role] })) : undefined };
});
// Demo role preview: issues a session that exists only in the demo database, so it can never carry Live privileges.
route('POST', '/session/preview', { public: true, env: 'demo' }, ctx => {
  const db = ensureDemo(); const id = ctx.body.userId;
  const user = id ? db.get('SELECT * FROM users WHERE id=? AND active=1', Number(id)) : db.get("SELECT * FROM users WHERE role='close_manager' ORDER BY id LIMIT 1");
  if (!user) throw notFound('Demo persona not found.');
  if (ctx.session) revokeSession(db, ctx.session.id);
  const s = createSession(db, user, { preview: true }); ctx.res.setHeader('Set-Cookie', sessionCookie('demo', s.token));
  return { ok: true, userId: user.id };
});
route('POST', '/reset', { env: 'demo' }, ctx => {
  const scenario = DEMO_SCENARIOS[ctx.body.scenario] ? ctx.body.scenario : 'baseline'; const email = ctx.user.email;
  wipeDemo(); const db = dbFor('demo'); seedDemo(db, scenario);
  const user = db.get('SELECT * FROM users WHERE email=?', email) || db.get("SELECT * FROM users WHERE role='close_manager' LIMIT 1");
  const s = createSession(db, user, { preview: true }); ctx.res.setHeader('Set-Cookie', sessionCookie('demo', s.token));
  return { ok: true, scenario };
});
route('POST', '/auth/bootstrap', { public: true, env: 'live' }, ctx => {
  const { orgName, name, email, password, timezone } = ctx.body;
  if (ctx.db.get('SELECT 1 x FROM orgs LIMIT 1')) throw forbidden('This workspace is already set up. Ask an administrator for an invitation.');
  if (!orgName?.trim() || !name?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw invalid('Company name, your name and a valid email are required.');
  const prob = passwordProblem(password); if (prob) throw invalid(prob);
  let tz = 'America/Chicago'; try { if (timezone) { new Intl.DateTimeFormat('en', { timeZone: timezone }); tz = timezone; } } catch { /* keep default */ }
  const user = ctx.db.tx(() => {
    const at = new Date().toISOString();
    const orgId = ctx.db.insert('orgs', { name: orgName.trim().slice(0, 120), timezone: tz, created_at: at, onboarding: { step: 'company', done: [] } });
    ctx.db.insert('calendars', { org_id: orgId, name: 'Standard business calendar' });
    const uid = ctx.db.insert('users', { org_id: orgId, email: email.trim().toLowerCase(), name: name.trim().slice(0, 120), title: 'Administrator', role: 'admin', password_hash: hashPassword(password), created_at: at });
    const org = ctx.db.get('SELECT * FROM orgs WHERE id=?', orgId);
    writeAudit(ctx.db, orgId, nowFor('live', org), uid, 'org.created', 'org', orgId, { name: org.name });
    return ctx.db.get('SELECT * FROM users WHERE id=?', uid);
  });
  const s = createSession(ctx.db, user); ctx.res.setHeader('Set-Cookie', sessionCookie('live', s.token));
  return { ok: true };
});
route('POST', '/auth/login', { public: true, env: 'live' }, ctx => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  if (!rateLimit(`login:${email}`, 8, 15 * 60000)) throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts for this account. Try again in 15 minutes.');
  const user = ctx.db.get('SELECT * FROM users WHERE email=?', email);
  if (!user || !user.active || !verifyPassword(String(ctx.body.password || ''), user.password_hash)) throw new HttpError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
  const s = createSession(ctx.db, user); ctx.res.setHeader('Set-Cookie', sessionCookie('live', s.token));
  const org = ctx.db.get('SELECT * FROM orgs WHERE id=?', user.org_id); writeAudit(ctx.db, user.org_id, nowFor('live', org), user.id, 'auth.login', 'user', user.id);
  return { ok: true };
});
route('POST', '/auth/accept-invite', { public: true, env: 'live' }, ctx => {
  const inv = ctx.db.get('SELECT * FROM invitations WHERE token_hash=?', hashInvite(String(ctx.body.token || '')));
  if (!inv || inv.accepted_at || inv.expires_at < Date.now()) throw new HttpError(410, 'INVITE_EXPIRED', 'This invitation is no longer valid. Ask for a new one.');
  const prob = passwordProblem(ctx.body.password); if (prob) throw invalid(prob);
  if (ctx.db.get('SELECT 1 x FROM users WHERE email=?', inv.email)) throw invalid('An account already exists for this email.');
  const uid = ctx.db.tx(() => {
    const id = ctx.db.insert('users', { org_id: inv.org_id, email: inv.email, name: String(ctx.body.name || inv.name || inv.email).slice(0, 120), role: inv.role, external_org: inv.external_org, password_hash: hashPassword(ctx.body.password), created_at: new Date().toISOString() });
    ctx.db.run('UPDATE invitations SET accepted_at=? WHERE id=?', Date.now(), inv.id);
    if (inv.request_id) ctx.db.run('UPDATE requests SET recipient_user_id=? WHERE id=? AND org_id=?', id, inv.request_id, inv.org_id);
    return id;
  });
  const s = createSession(ctx.db, ctx.db.get('SELECT * FROM users WHERE id=?', uid)); ctx.res.setHeader('Set-Cookie', sessionCookie('live', s.token));
  return { ok: true };
});
route('POST', '/me/password', { env: 'live' }, ctx => {
  if (!rateLimit(`pw:${ctx.user.id}`, 6, 15 * 60000)) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again in 15 minutes.');
  const u = ctx.db.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!verifyPassword(String(ctx.body.current || ''), u.password_hash)) throw invalid('Your current password is incorrect.');
  const prob = passwordProblem(ctx.body.next); if (prob) throw invalid(prob);
  if (ctx.body.next === ctx.body.current) throw invalid('Choose a password different from the current one.');
  ctx.db.update('users', u.id, { password_hash: hashPassword(ctx.body.next) });
  ctx.db.run('DELETE FROM sessions WHERE user_id=? AND id<>?', u.id, ctx.session.id); // other devices are signed out
  ctx.audit('auth.password_changed', 'user', u.id, {});
  return { ok: true };
});
route('POST', '/auth/logout', {}, ctx => { revokeSession(ctx.db, ctx.session.id); ctx.res.setHeader('Set-Cookie', sessionCookie(ctx.env, '', { clear: true })); return { ok: true }; });

route('GET', '/me', { perm: undefined }, ctx => {
  const { db, user, org } = ctx; const s = orgSettings(org); const ai = db.get('SELECT status, model FROM ai_settings WHERE org_id=?', org.id);
  const external = user.role === 'external';
  return {
    env: ctx.env, version: APP_VERSION, csrf: ctx.session.csrf, preview: !!ctx.session.preview, user: publicUser(user), perms: permsOf(user), now: ctx.now(), clockPinned: ctx.env === 'demo',
    org: { id: org.id, name: org.name, baseCurrency: org.base_currency, timezone: org.timezone, onboarding: J(org.onboarding, {}), settings: external ? {} : s, demoScenario: J(org.settings, {}).demo_scenario || null },
    entities: external ? [] : db.all('SELECT id, code, name, currency, timezone, calendar_id FROM entities WHERE org_id=? AND active=1 ORDER BY id', org.id),
    periods: external ? [] : db.all('SELECT id, name, kind, start_date, end_date, day0, target_close, status, actual_close_at FROM periods WHERE org_id=? ORDER BY end_date DESC', org.id),
    users: external ? [] : db.all('SELECT * FROM users WHERE org_id=? ORDER BY name', org.id).map(publicUser),
    ai: { status: ai?.status || 'disconnected', model: ai?.model || null }, unread: db.val('SELECT COUNT(*) FROM notifications WHERE org_id=? AND user_id=? AND read=0', org.id, user.id),
    demoScenarios: ctx.env === 'demo' ? DEMO_SCENARIOS : undefined,
  };
});
// Realtime invalidation channel, scoped to this environment and organization.
route('GET', '/events', { sse: true, perm: 'read' }, ctx => {
  ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-CI-Env': ctx.env, 'X-Accel-Buffering': 'no' });
  ctx.res.write(`data: ${JSON.stringify({ type: 'hello', env: ctx.env })}\n\n`); subscribe(ctx.env, ctx.orgId, ctx.res);
  const t = setInterval(() => { try { ctx.res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25000); ctx.res.on('close', () => clearInterval(t));
});
route('GET', '/notifications', {}, ctx => ctx.db.all('SELECT * FROM notifications WHERE org_id=? AND user_id=? ORDER BY id DESC LIMIT 60', ctx.orgId, ctx.user.id));
route('POST', '/notifications/read', {}, ctx => { ctx.db.run('UPDATE notifications SET read=1 WHERE org_id=? AND user_id=?', ctx.orgId, ctx.user.id); ctx.changed('notifications', 'me'); return { ok: true }; });
route('GET', '/views', { perm: 'read' }, ctx => ctx.db.all('SELECT id, screen, name, filters FROM saved_views WHERE org_id=? AND user_id=? ORDER BY name', ctx.orgId, ctx.user.id).map(v => ({ ...v, filters: J(v.filters, {}) })));
route('POST', '/views', { perm: 'read' }, ctx => { if (!ctx.body.name?.trim()) throw bad('Name the view.'); const id = ctx.db.insert('saved_views', { org_id: ctx.orgId, user_id: ctx.user.id, screen: String(ctx.body.screen || 'tasks'), name: ctx.body.name.trim().slice(0, 60), filters: ctx.body.filters || {} }); return { id }; });
route('DELETE', '/views/:id', { perm: 'read' }, ctx => { ctx.db.run('DELETE FROM saved_views WHERE id=? AND org_id=? AND user_id=?', ctx.int(ctx.params.id), ctx.orgId, ctx.user.id); return { ok: true }; });
route('GET', '/demo/manifest', { perm: 'read', env: 'demo' }, ctx => checkManifest(ctx.db, ctx.orgId));
