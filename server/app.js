import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, ENVS, APP_VERSION, MAX_UPLOAD, usingLocalKey } from './config.js';
import { dbFor } from './db.js';
import { authenticate, can, rateLimit } from './auth.js';
import { routes, HttpError, makeCtx, closeStreams } from './core.js';
import './domains/session.js';
import './domains/admin.js';
import './domains/tasks.js';
import './domains/financial.js';
import './domains/requests.js';
import './domains/documents.js';
import './domains/insights.js';
import './domains/reports.js';
import './domains/dashboard.js';
import './domains/ai.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body); const payload = isBuf ? body : body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY, 'Cache-Control': 'no-store', ...(isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...headers });
  res.end(payload);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'TOO_LARGE', `Upload is larger than the ${Math.round(limit / 1048576)} MB limit.`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  const pub = path.join(ROOT, 'public'); let file = path.normalize(path.join(pub, pathname));
  if (!file.startsWith(pub)) return send(res, 400, { error: 'BAD_PATH' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { if (path.extname(pathname)) return send(res, 404, { error: 'NOT_FOUND' }); file = path.join(pub, 'index.html'); }
  const ext = path.extname(file); const body = fs.readFileSync(file);
  send(res, 200, body, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache' });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://local'); const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) { if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'METHOD' }); return serveStatic(req, res, p === '/' ? '/index.html' : p); }
    if (p === '/api/health') {
      const out = { status: 'ok', version: APP_VERSION, environments: {}, secretKey: usingLocalKey() ? 'local-development-key-file' : 'configured' };
      for (const e of ENVS) { try { dbFor(e).get('SELECT 1 x'); out.environments[e] = 'ok'; } catch { out.environments[e] = 'error'; out.status = 'degraded'; } }
      return send(res, out.status === 'ok' ? 200 : 503, out);
    }
    const m = /^\/api\/([a-z]+)(\/.*)$/.exec(p); if (!m || !ENVS.includes(m[1])) throw new HttpError(404, 'NOT_FOUND', 'Unknown API path.');
    const env = m[1], sub = m[2]; const db = dbFor(env);
    let match = null, params = {};
    for (const r of routes) { if (r.method !== req.method) continue; const mm = r.re.exec(sub); if (!mm) continue; if (r.opts.env && r.opts.env !== env) continue; match = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(mm[i + 1]))); break; }
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'Unknown API path.');
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {
      // Behind a reverse proxy or port forwarder the public host arrives in X-Forwarded-Host; it is honoured only when CI_TRUST_PROXY=1.
      const origin = req.headers.origin; const hosts = [req.headers.host, ...(process.env.CI_TRUST_PROXY === '1' ? String(req.headers['x-forwarded-host'] || '').split(',').map(h => h.trim()).filter(Boolean) : [])];
      if (origin && !hosts.includes(new URL(origin).host)) throw new HttpError(403, 'ORIGIN', 'Cross-site request rejected.');
      // The client states which environment it believes it is talking to; a mismatch means a stale tab or in-flight request.
      const claimed = req.headers['x-ci-env']; if (claimed && claimed !== env) throw new HttpError(409, 'ENV_MISMATCH', 'This request was prepared for a different environment and was not applied.');
    }
    const auth = authenticate(db, env, req);
    if (!match.opts.public) {
      if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
      if (mutating && req.headers['x-csrf-token'] !== auth.session.csrf) throw new HttpError(403, 'CSRF', 'Security token missing or expired. Reload and try again.');
      if (auth.user.role === 'external' && match.opts.perm && match.opts.perm !== 'portal') throw new HttpError(403, 'FORBIDDEN', 'External contributors can only access requests addressed to them.');
      if (match.opts.perm && !can(auth.user, match.opts.perm)) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to do that.');
      if (!rateLimit(`s:${auth.session.id}`, 900, 60000)) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
    } else if (mutating && !rateLimit(`pub:${req.socket.remoteAddress}:${sub}`, 20, 15 * 60000)) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    let body = null;
    if (mutating) {
      const raw = await readBody(req, match.opts.raw ? MAX_UPLOAD : 2 * 1024 * 1024);
      if (match.opts.raw) body = raw; else if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'Request body is not valid JSON.'); } } else body = {};
    }
    const ctx = makeCtx({ env, db, req, res, auth, params, query: Object.fromEntries(url.searchParams), body });
    res.setHeader('X-CI-Env', env);
    const result = await match.handler(ctx);
    ctx.flush();
    if (match.opts.sse || res.headersSent) return;
    if (result && result.__file) return send(res, 200, result.__file, { 'Content-Type': result.type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${String(result.name).replace(/[^\w.\- ()]/g, '_')}"`, 'X-CI-Env': env });
    send(res, result === undefined ? 204 : 200, result, { 'X-CI-Env': env });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...(e.extra ? { details: e.extra } : {}) });
    const errorId = crypto.randomBytes(4).toString('hex');
    console.error(`[error ${errorId}] ${req.method} ${p}: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`); // request bodies and secrets are never logged
    send(res, 500, { error: 'INTERNAL', message: `Something went wrong on our side. Reference ${errorId}.`, errorId });
  }
}
export function createServer() {
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('close', closeStreams);
  return server;
}
