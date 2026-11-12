import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENVS, dataDir, sha256 } from './config.js';

export class DB {
  constructor(file) { this.raw = new DatabaseSync(file); this.stmts = new Map(); this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'); this.depth = 0; }
  stmt(sql) { let s = this.stmts.get(sql); if (!s) { s = this.raw.prepare(sql); this.stmts.set(sql, s); } return s; }
  all(sql, ...p) { return this.stmt(sql).all(...p).map(r => ({ ...r })); }
  get(sql, ...p) { const r = this.stmt(sql).get(...p); return r ? { ...r } : null; }
  run(sql, ...p) { return this.stmt(sql).run(...p); }
  val(sql, ...p) { const r = this.stmt(sql).get(...p); return r ? Object.values(r)[0] : null; }
  insert(table, obj) {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
    const r = this.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => norm(obj[k])));
    return Number(r.lastInsertRowid);
  }
  update(table, id, obj) {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined); if (!keys.length) return 0;
    return Number(this.run(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => norm(obj[k])), id).changes);
  }
  /** Run fn inside a transaction (re-entrant: nested calls join the outer transaction). */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const r = fn(); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; } finally { this.depth--; }
  }
  close() { this.stmts.clear(); this.raw.close(); }
}
const norm = v => (v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v);
export const J = (v, fallback = null) => { if (v == null || v === '') return fallback; try { return JSON.parse(v); } catch { return fallback; } };

function migrate(db) {
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(ROOT, 'server', 'migrations');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    if (db.get('SELECT 1 x FROM schema_migrations WHERE name=?', f)) continue;
    db.tx(() => { db.raw.exec(fs.readFileSync(path.join(dir, f), 'utf8')); db.run('INSERT INTO schema_migrations VALUES(?,?)', f, new Date().toISOString()); });
  }
}
const open = new Map();
const checkEnv = env => { if (!ENVS.includes(env)) throw new Error('Unknown environment'); };
/** Each environment has its own database file and file store. Nothing is shared between them. */
export function dbFor(env) {
  checkEnv(env); const key = dataDir() + '|' + env;
  if (!open.has(key)) { const dir = path.join(dataDir(), env); fs.mkdirSync(path.join(dir, 'files'), { recursive: true }); const db = new DB(path.join(dir, 'app.db')); migrate(db); open.set(key, db); }
  return open.get(key);
}
export function closeAll() { for (const db of open.values()) db.close(); open.clear(); }
/** Delete an environment's database and files. Only ever allowed for demo. */
export function wipeDemo() {
  const key = dataDir() + '|demo'; if (open.has(key)) { open.get(key).close(); open.delete(key); }
  fs.rmSync(path.join(dataDir(), 'demo'), { recursive: true, force: true });
}
const fileRoot = env => { checkEnv(env); return path.join(dataDir(), env, 'files'); };
/** Content-addressed private storage. Existing objects are never overwritten. */
export function putFile(env, orgId, buf) {
  const hash = sha256(buf); const key = `${Number(orgId)}/${hash.slice(0, 2)}/${hash}`; const full = path.join(fileRoot(env), key);
  if (!fs.existsSync(full)) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, buf, { mode: 0o600, flag: 'wx' }); }
  return { key, sha256: hash, size: buf.length };
}
export function getFile(env, orgId, key) {
  if (!/^\d+\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key) || !key.startsWith(Number(orgId) + '/')) throw new Error('Invalid storage key');
  return fs.readFileSync(path.join(fileRoot(env), key));
}
