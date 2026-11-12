import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Start the real HTTP server on a random port with an isolated temporary data directory. */
export async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-')); process.env.CI_DATA_DIR = dir; delete process.env.CI_SECRET_KEY;
  const { createServer } = await import('../server/app.js'); const db = await import('../server/db.js'); const auth = await import('../server/auth.js');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  return { base, dir, db, auth, close: async () => { await new Promise(r => { server.close(r); server.closeAllConnections?.(); }); db.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
export class Client {
  constructor(base, env) { this.base = base; this.env = env; this.cookie = ''; this.csrf = ''; }
  async req(method, p, body, { raw = false, headers = {}, env } = {}) {
    const h = { ...headers }; if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET') { if (h['x-csrf-token'] === undefined) h['x-csrf-token'] = this.csrf; if (h['x-ci-env'] === undefined) h['x-ci-env'] = this.env; h['content-type'] = raw ? 'application/octet-stream' : 'application/json'; }
    const res = await fetch(`${this.base}/api/${env || this.env}${p}`, { method, headers: h, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || ''; const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); } post(p, b = {}, o) { return this.req('POST', p, b, o); } patch(p, b, o) { return this.req('PATCH', p, b, o); } put(p, b, o) { return this.req('PUT', p, b, o); } del(p, o) { return this.req('DELETE', p, undefined, o); }
  async me() { const r = await this.get('/me'); if (r.status === 200) this.csrf = r.data.csrf; return r; }
  async demo(userId) { const r = await this.post('/session/preview', userId ? { userId } : {}); if (r.status !== 200) throw new Error('preview failed ' + JSON.stringify(r.data)); return (await this.me()).data; }
  async login(email, password) { const r = await this.post('/auth/login', { email, password }); if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.data)); return (await this.me()).data; }
  /** Expect a 2xx and return the body. */
  async ok(method, p, body, o) { const r = await this.req(method, p, body, o); if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; }
}
export const csv = rows => Buffer.from(rows.map(r => r.join(',')).join('\n'));
