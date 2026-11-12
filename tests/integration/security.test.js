// Demo/Live isolation, authorization by role, organization boundaries, private files and exports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, Client, csv } from '../helpers.js';

let app, demo, live, S = {};
before(async () => { app = await startApp(); demo = new Client(app.base, 'demo'); live = new Client(app.base, 'live'); await demo.get('/auth/status'); S.me = await demo.demo();
  await live.post('/auth/bootstrap', { orgName: 'Live Co', name: 'Lee Admin', email: 'lee@live.test', password: 'correct-horse-9' }); await live.me(); });
after(async () => { await app.close(); });
const persona = async role => { const c = new Client(app.base, 'demo'); const u = S.me.users.find(x => x.role === role); await c.demo(u.id); return c; };

test('Demo and Live use separate databases, file stores and sessions', async () => {
  assert.ok(fs.existsSync(path.join(app.dir, 'demo', 'app.db'))); assert.ok(fs.existsSync(path.join(app.dir, 'live', 'app.db'))); assert.ok(fs.readdirSync(path.join(app.dir, 'demo', 'files')).length > 0); assert.equal(fs.readdirSync(path.join(app.dir, 'live', 'files')).length, 0);
  // a demo session cookie presented to Live (even renamed to the Live cookie name) authenticates nothing
  const hijack = new Client(app.base, 'live'); hijack.cookie = demo.cookie; assert.equal((await hijack.get('/me')).status, 401); hijack.cookie = demo.cookie.replace('ci_demo_sid', 'ci_live_sid'); assert.equal((await hijack.get('/me')).status, 401);
  const me = (await live.me()).data; assert.equal(me.users.length, 1); assert.equal(me.entities.length, 0); assert.equal(me.periods.length, 0); assert.equal(me.org.demoScenario, null); assert.equal(me.clockPinned, false);
  for (const p of ['/documents', '/templates', '/notifications', '/imports', '/accounts', '/controls']) assert.equal((await live.get(p)).data.length, 0, `${p}: no demo records may appear in Live`);
  assert.equal((await live.get('/audit')).data.events.some(e => /demo/.test(e.action)), false);
  assert.equal((await live.post('/session/preview', {})).status, 404, 'role preview does not exist in Live'); assert.equal((await live.post('/reset', {})).status, 404); assert.equal((await live.get('/demo/manifest')).status, 404);
});
test('requests prepared for one environment are never applied in the other', async () => {
  await live.post('/entities', { code: 'L1', name: 'Live entity', currency: 'USD' });
  const wrong = await demo.req('POST', '/entities', { code: 'XX', name: 'stale tab', currency: 'USD' }, { headers: { 'x-ci-env': 'live' } }); assert.equal(wrong.status, 409); assert.equal(wrong.data.error, 'ENV_MISMATCH');
  assert.equal(S.me.entities.length, (await demo.me()).data.entities.length, 'the mismatched mutation was not applied');
  const cross = await demo.req('POST', '/entities', { code: 'XX', name: 'x', currency: 'USD' }, { env: 'live' }); assert.equal(cross.status, 409, 'demo client posting to the live path with its demo header is rejected');
  const nocsrf = await live.req('POST', '/entities', { code: 'L2', name: 'x', currency: 'USD' }, { headers: { 'x-csrf-token': 'wrong' } }); assert.equal(nocsrf.status, 403); assert.equal(nocsrf.data.error, 'CSRF');
  const xo = await live.req('POST', '/entities', { code: 'L3', name: 'x', currency: 'USD' }, { headers: { origin: 'https://evil.example' } }); assert.equal(xo.status, 403);
  assert.equal((await demo.get('/me')).headers.get('x-ci-env'), 'demo'); assert.equal((await live.get('/me')).headers.get('x-ci-env'), 'live');
});
test('Demo reset never touches Live; role preview never grants Live privileges', async () => {
  const before = fs.statSync(path.join(app.dir, 'live', 'app.db')).size; const liveUsers = (await live.me()).data.users.length;
  const docBefore = (await demo.get('/documents')).data.length; await demo.post('/documents/upload?filename=mine.csv', csv([['a'], ['1']]), { raw: true }); assert.equal((await demo.get('/documents')).data.length, docBefore + 1);
  assert.equal((await demo.post('/reset', { scenario: 'on_track' })).status, 200); const me = (await demo.me()).data; assert.equal(me.org.demoScenario, 'on_track'); assert.equal((await demo.get('/documents?search=mine')).data.filter(d => d.title === 'mine').length, 0, 'reset discards demo changes');
  const after = (await live.me()).data; assert.equal(after.users.length, liveUsers); assert.equal(after.entities.length, 1); assert.equal(after.entities[0].code, 'L1'); assert.ok(fs.statSync(path.join(app.dir, 'live', 'app.db')).size >= before);
  await demo.post('/reset', { scenario: 'baseline' }); S.me = (await demo.me()).data;
  const adminPersona = await persona('admin'); assert.equal((await adminPersona.me()).data.user.role, 'admin'); const asLive = new Client(app.base, 'live'); asLive.cookie = adminPersona.cookie; assert.equal((await asLive.get('/users')).status, 404); assert.equal((await asLive.get('/audit')).status, 401);
  assert.match((await adminPersona.put('/ai/key', { apiKey: 'sk-test-0123456789abcdefghij' })).data.message, /Live only/, 'Demo never stores or calls an OpenAI key');
});
test('role-based authorization is enforced on the API, not only in the UI', async () => {
  const pid = S.me.periods[0].id; const tasks = (await demo.get(`/periods/${pid}/tasks`)).data; const sub = tasks.find(t => t.status === 'submitted'); const ready = tasks.find(t => t.status === 'ready' && t.preparer_id);
  const anon = new Client(app.base, 'demo'); assert.equal((await anon.get(`/periods/${pid}/tasks`)).status, 401); assert.equal((await anon.get('/documents')).status, 401); assert.equal((await anon.get(`/periods/${pid}/export/tasks.csv`)).status, 401);
  const exec = await persona('executive'); const aud = await persona('auditor'); const prepUser = S.me.users.find(u => u.id === sub.preparer_id); const prep = new Client(app.base, 'demo'); await prep.demo(prepUser.id);
  for (const c of [exec, aud]) { assert.equal((await c.get(`/periods/${pid}/tasks`)).status, 200); assert.equal((await c.post(`/tasks/${ready.id}/transition`, { action: 'start' })).status, 403); assert.equal((await c.patch(`/tasks/${ready.id}`, { fields: { risk: 'low' } })).status, 403); assert.equal((await c.post('/documents/upload?filename=a.csv', csv([['a']]), { raw: true })).status, 403); assert.equal((await c.get(`/periods/${pid}/export/tasks.csv`)).status, 200); assert.equal((await c.get('/export/backup.json')).status, 403); }
  assert.equal((await aud.get('/audit')).status, 200); assert.equal((await prep.get('/audit')).status, 403); assert.equal((await exec.post('/ai/ask', { question: 'status?' })).status, 200); assert.equal((await aud.post('/ai/ask', { question: 'status?' })).status, 403);
  assert.equal((await prep.post(`/tasks/${sub.id}/transition`, { action: 'approve' })).status, 403); assert.equal((await prep.patch(`/tasks/${sub.id}`, { fields: { owner_id: prepUser.id } })).status, 403); assert.equal((await prep.post('/tasks/bulk', { ids: [sub.id], action: 'risk', value: 'low' })).status, 403);
  assert.equal((await prep.patch('/settings', { sod_enforced: false })).status, 403); assert.equal((await prep.post('/users', { name: 'x', email: 'x@x.test', role: 'admin' })).status, 403); assert.equal((await prep.post(`/periods/${pid}/lock`)).status, 403); assert.equal((await demo.patch('/settings', { sod_enforced: false })).status, 403, 'close manager is not an administrator');
  const other = tasks.find(t => t.status === 'ready' && t.preparer_id && ![t.owner_id, t.preparer_id, t.backup_id].includes(prepUser.id)); assert.equal((await prep.post(`/tasks/${other.id}/transition`, { action: 'start' })).status, 403, 'cannot work a task assigned to someone else');
  // reviewer overload persona cannot approve as someone else's preparer session; deactivation revokes access immediately
  const admin = await persona('admin'); await admin.ok('PATCH', `/users/${prepUser.id}`, { active: false }); assert.equal((await prep.get('/me')).status, 401); await admin.ok('PATCH', `/users/${prepUser.id}`, { active: true });
});
test('external contributors see only their own requests', async () => {
  const pid = S.me.periods[0].id; const ext = await persona('external'); const me = (await ext.me()).data; assert.equal(me.users.length, 0); assert.equal(me.periods.length, 0); assert.deepEqual(me.org.settings, {});
  for (const p of [`/periods/${pid}/tasks`, '/documents', `/periods/${pid}/overview`, '/search?q=inventory', `/periods/${pid}/requests`, `/periods/${pid}/export/tasks.csv`, '/audit', `/periods/${pid}/report`, '/events']) assert.equal((await ext.get(p)).status, 403, p);
  assert.equal((await ext.post('/ai/ask', { question: 'What is blocking the close?' })).status, 403);
  const mine = (await ext.get('/portal/requests')).data; assert.equal(mine.length >= 1, true); assert.ok(mine.every(r => /inventory report/i.test(r.title))); assert.deepEqual(Object.keys(mine[0]).sort(), ['deliverable', 'due_at', 'expected_at', 'id', 'last_response', 'status', 'title']);
  const all = (await demo.get(`/periods/${pid}/requests`)).data; const notMine = all.find(r => !/inventory report/i.test(r.title)); assert.equal((await ext.post(`/portal/requests/${notMine.id}/respond`, { note: 'hello' })).status, 404);
  const cur = mine.find(r => ['sent', 'acknowledged'].includes(r.status)); assert.equal((await ext.post(`/portal/requests/${cur.id}/respond`, { note: 'Sending Friday.', expected_at: '2026-11-06T11:00' })).status, 200);
});
test('organization boundaries hold for direct API access, search, files and AI retrieval', async () => {
  // a second organization inside the same Live database
  const db = app.db.dbFor('live'); const { hashPassword } = app.auth; const org2 = db.insert('orgs', { name: 'Other Org', created_at: 'x' }); db.insert('calendars', { org_id: org2, name: 'c' }); const e2 = db.insert('entities', { org_id: org2, code: 'O1', name: 'Other', currency: 'USD' });
  const u2 = db.insert('users', { org_id: org2, email: 'olga@other.test', name: 'Olga Other', role: 'admin', password_hash: hashPassword('correct-horse-9'), created_at: 'x' }); const p2 = db.insert('periods', { org_id: org2, name: 'Oct 2026', start_date: '2026-10-01', end_date: '2026-10-31', day0: '2026-10-31', target_close: '2026-11-09T17:00' });
  const t2 = db.insert('tasks', { org_id: org2, period_id: p2, entity_id: e2, key: 'SECRET-1', name: 'Zebra acquisition accrual', process: 'Accruals', status: 'ready', owner_id: u2 }); const olga = new Client(app.base, 'live'); await olga.login('olga@other.test', 'correct-horse-9');
  const up = await olga.ok('POST', `/documents/upload?filename=secret.csv&title=Zebra%20deal%20model&period_id=${p2}`, csv([['zebra', 'purchase price'], ['x', '9900000']]), { raw: true });
  for (const p of [`/tasks/${t2}`, `/documents/${up.documentId}`, `/periods/${p2}/tasks`, `/periods/${p2}/overview`, `/documents/${up.documentId}/download-url`, `/periods/${p2}/export/tasks.csv`]) assert.equal((await live.get(p)).status, 404, `org A must not reach org B: ${p}`);
  assert.equal((await live.patch(`/tasks/${t2}`, { fields: { name: 'pwned' } })).status, 404); assert.equal((await live.post(`/tasks/${t2}/transition`, { action: 'start' })).status, 404);
  assert.equal((await live.get('/search?q=zebra')).data.results.length, 0); assert.equal((await olga.get('/search?q=zebra')).data.results.length, 2); assert.equal((await live.get('/documents?search=zebra')).data.length, 0);
  const ans = (await live.post('/ai/ask', { question: 'Tell me about the zebra acquisition accrual and SECRET-1', context: { taskId: t2, periodId: p2 } })).data; assert.ok(!/zebra|SECRET-1/i.test(JSON.stringify(ans)), 'AI retrieval must not cross organizations');
  assert.equal((await live.get('/me')).data.users.some(u => u.email === 'olga@other.test'), false);
  // download links are bound to the user, the organization and the environment, and expire
  const link = (await olga.get(`/documents/${up.documentId}/download-url`)).data.url.replace('/api/live', ''); assert.equal((await olga.get(link)).status, 200); assert.equal((await live.get(link)).status, 403); assert.equal((await new Client(app.base, 'live').get(link)).status, 401); assert.equal((await demo.get(link)).status, 403);
  const [payload] = link.split('t=')[1].split('.'); assert.equal((await olga.get(`/files/download?t=${payload}.forged`)).status, 403); const stored = fs.readdirSync(path.join(app.dir, 'live', 'files')); assert.deepEqual(stored, [String(org2)], 'files are stored under the owning organization');
  assert.equal((await olga.get('/export/backup.json')).status, 200); const bk = (await live.get('/export/backup.json')).data; assert.equal(bk.tables.tasks.length, 0); assert.ok(!/zebra/i.test(JSON.stringify(bk))); assert.ok(!/password_hash|scrypt|key_cipher/.test(JSON.stringify(bk)));
});
test('restricted documents, upload validation and export safety', async () => {
  const prep = new Client(app.base, 'demo'); const two = S.me.users.filter(u => u.role === 'preparer'); await prep.demo(two[0].id); const peer = new Client(app.base, 'demo'); await peer.demo(two[1].id);
  const up = await prep.ok('POST', '/documents/upload?filename=payroll_detail.csv&title=Payroll%20detail%20quokka&doc_class=restricted', csv([['employee', 'salary'], ['quokka person', '100000']]), { raw: true });
  assert.equal((await prep.get(`/documents/${up.documentId}`)).status, 200); assert.equal((await peer.get(`/documents/${up.documentId}`)).status, 404); assert.equal((await peer.get('/documents?search=quokka')).data.length, 0); assert.equal((await peer.get('/search?q=quokka')).data.results.length, 0); assert.equal((await peer.get(`/documents/${up.documentId}/download-url`)).status, 404);
  assert.ok(!/quokka/i.test(JSON.stringify((await peer.post('/ai/ask', { question: 'quokka payroll detail salary' })).data))); assert.equal((await demo.get(`/documents/${up.documentId}`)).status, 200, 'close manager can see restricted documents');
  assert.equal((await prep.post('/documents/upload?filename=run.exe', Buffer.from('MZ...'), { raw: true })).status, 415); assert.equal((await prep.post('/documents/upload?filename=fake.pdf', Buffer.from('not a pdf'), { raw: true })).status, 415); assert.equal((await prep.post('/documents/upload?filename=..%2F..%2Fetc%2Fpasswd.csv', csv([['a']]), { raw: true })).status, 200);
  assert.equal((await prep.post('/documents/link', { url: 'http://insecure.example/x', title: 'x' })).status, 422);
  // CSV export neutralises formula injection
  const pid = S.me.periods[0].id; const t = await demo.ok('POST', `/periods/${pid}/tasks`, { name: '=HYPERLINK("http://evil.example","click")', process: '@SUM(A1)' }); const out = (await demo.get(`/periods/${pid}/export/tasks.csv`)).data.toString();
  assert.ok(out.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`)); assert.ok(out.includes("'@SUM(A1)")); assert.ok(!/\n=|,=H/.test(out)); assert.ok(t.id > 0);
  const pdf = (await demo.get(`/periods/${pid}/export/package.pdf`)).data; assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); const xlsx = (await demo.get(`/periods/${pid}/export/workbook.xlsx`)).data; assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  const hd = (await demo.get('/me')).headers; assert.match(hd.get('content-security-policy'), /default-src 'self'/); assert.equal(hd.get('x-content-type-options'), 'nosniff'); assert.match(demo.cookie, /^ci_demo_sid=/);
});

test('a Live user can change their own password; other sessions end; Demo cannot use the route', async () => {
  const admin = new Client(app.base, 'live'); await admin.login('lee@live.test', 'correct-horse-9');
  await admin.ok('POST', '/users', { name: 'Pat Preparer', email: 'pat@live.test', role: 'preparer', password: 'initial-pass-1' });
  const a = new Client(app.base, 'live'); await a.login('pat@live.test', 'initial-pass-1'); const b = new Client(app.base, 'live'); await b.login('pat@live.test', 'initial-pass-1');
  assert.equal((await a.post('/me/password', { current: 'wrong-pass-00', next: 'brand-new-pass-2' })).status, 422);
  assert.equal((await a.post('/me/password', { current: 'initial-pass-1', next: 'short1' })).status, 422);
  assert.equal((await a.post('/me/password', { current: 'initial-pass-1', next: 'brand-new-pass-2' })).status, 200);
  assert.equal((await a.get('/me')).status, 200, 'the session that changed the password stays signed in');
  assert.equal((await b.get('/me')).status, 401, 'other sessions are signed out');
  const c = new Client(app.base, 'live'); assert.equal((await c.post('/auth/login', { email: 'pat@live.test', password: 'initial-pass-1' })).status, 401); await c.login('pat@live.test', 'brand-new-pass-2');
  // an administrator reset signs the person out everywhere
  const pat = (await admin.me()).data.users.find(u => u.email === 'pat@live.test'); await admin.ok('PATCH', `/users/${pat.id}`, { password: 'admin-reset-pass-3' }); assert.equal((await c.get('/me')).status, 401);
  assert.notEqual((await demo.post('/me/password', { current: 'x', next: 'brand-new-pass-2' })).status, 200);
  const audit = await admin.ok('GET', '/audit'); assert.ok(JSON.stringify(audit).includes('auth.password_changed')); assert.ok(!JSON.stringify(audit).includes('brand-new-pass-2'));
});
