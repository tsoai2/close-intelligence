// Live environment: the complete close workflow, driven through the real HTTP API with two users.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, Client, csv } from '../helpers.js';

let app, admin, prep, rev; const S = {};
before(async () => { app = await startApp(); admin = new Client(app.base, 'live'); prep = new Client(app.base, 'live'); rev = new Client(app.base, 'live'); });
after(async () => { await app.close(); });

test('Live starts clean and bootstraps a real organization', async () => {
  const st = await admin.get('/auth/status'); assert.equal(st.data.bootstrapped, false); assert.equal(st.data.sso.entra, 'not_configured');
  assert.equal((await admin.post('/auth/bootstrap', { orgName: 'Acme Test Co', name: 'Ada Admin', email: 'ada@acme.test', password: 'short' })).status, 422);
  assert.equal((await admin.post('/auth/bootstrap', { orgName: 'Acme Test Co', name: 'Ada Admin', email: 'ada@acme.test', password: 'correct-horse-9' })).status, 200);
  const me = (await admin.me()).data; assert.equal(me.org.name, 'Acme Test Co'); assert.equal(me.users.length, 1); assert.equal(me.periods.length, 0); assert.equal(me.entities.length, 0);
  for (const p of ['/documents', '/templates', '/improvements']) { const r = await admin.get(p); assert.equal(r.status, 200); assert.equal((r.data.improvements || r.data).length, 0, `${p} must be empty in a new Live workspace`); }
  assert.equal((await new Client(app.base, 'live').post('/auth/bootstrap', { orgName: 'Evil', name: 'x', email: 'x@x.test', password: 'correct-horse-9' })).status, 403);
});
test('entities, people, template and a period', async () => {
  await admin.ok('POST', '/entities', { code: 'US01', name: 'Acme US', currency: 'USD' });
  S.prepId = (await admin.ok('POST', '/users', { name: 'Pat Preparer', email: 'pat@acme.test', role: 'preparer', password: 'correct-horse-9' })).id;
  S.revId = (await admin.ok('POST', '/users', { name: 'Rae Reviewer', email: 'rae@acme.test', role: 'reviewer', password: 'correct-horse-9' })).id;
  await prep.login('pat@acme.test', 'correct-horse-9'); await rev.login('rae@acme.test', 'correct-horse-9');
  assert.equal((await admin.post('/templates/import-library', { kind: 'standard' })).status, 422, 'library import needs explicit review');
  const t = await admin.ok('POST', '/templates/import-library', { kind: 'standard', reviewed: true });
  assert.equal((await admin.patch(`/template-tasks/1`, { name: 'changed' })).status, 422, 'published template versions are read-only');
  const p = await admin.ok('POST', '/periods', { name: 'Oct 2026', start: '2026-10-01', end: '2026-10-31', kind: 'monthly', targetOffsetBd: 6, templateVersionId: t.versionId }); S.pid = p.periodId; assert.ok(p.tasks > 30);
  const me = (await admin.me()).data; S.eid = me.entities[0].id; assert.equal(me.periods[0].target_close, '2026-11-09T17:00');
  assert.equal((await admin.post('/periods', { name: 'Oct again', start: '2026-10-15', end: '2026-11-14', templateVersionId: t.versionId })).status, 409, 'overlapping period rejected');
});
test('checklist import: preview, validation, idempotency and rollback', async () => {
  const file = csv([['key', 'name', 'process', 'entity', 'offset_bd', 'duration_hours', 'review_hours', 'owner_email', 'reviewer_email', 'evidence', 'depends_on'], ['X-01', 'Custom bank rec', 'Cash', 'US01', '1', '2', '0.5', 'pat@acme.test', 'rae@acme.test', 'Bank statement', ''], ['X-02', 'Custom review', 'Cash', 'US01', '2', '1', '0.5', 'Pat Preparer', 'rae@acme.test', '', 'X-01'], ['X-03', '', 'Cash', 'US01', '1', '', '', '', '', '', ''], ['X-04', 'Bad entity', 'Cash', 'ZZ', '1', '', '', '', '', '', ''], ['X-05', 'Unknown owner', 'Cash', 'US01', '1', 'abc', '', 'nobody@acme.test', '', '', 'NOPE']]);
  const q = `?kind=checklist&periodId=${S.pid}&filename=checklist.csv`; const pv = (await prep.req('POST', '/imports/preview' + q, file, { raw: true })).data;
  assert.equal(pv.totals.acceptedRows, 3); assert.equal(pv.totals.rejectedRows, 2); assert.match(pv.rejected.map(r => r.reason).join('|'), /name is blank.*not set up/); assert.ok(pv.warnings.length >= 3, JSON.stringify(pv.warnings));
  const before = (await admin.get(`/periods/${S.pid}/tasks`)).data.length; const done = await prep.ok('POST', '/imports/commit' + q, file, { raw: true }); assert.equal(done.created, 3); assert.equal(done.dependencies, 1);
  assert.equal((await prep.req('POST', '/imports/commit' + q, file, { raw: true })).status, 409, 'same file cannot be imported twice');
  assert.equal((await admin.get(`/periods/${S.pid}/tasks`)).data.length, before + 3);
  const cyc = csv([['key', 'name', 'depends_on'], ['C-1', 'a', 'C-2'], ['C-2', 'b', 'C-1']]); assert.match((await prep.req('POST', `/imports/commit?kind=checklist&periodId=${S.pid}&filename=c.csv`, cyc, { raw: true })).data.message, /loop/);
  await prep.ok('POST', `/imports/${done.importId}/rollback`); assert.equal((await admin.get(`/periods/${S.pid}/tasks`)).data.length, before);
  const again = await prep.ok('POST', '/imports/commit' + q, file, { raw: true }); S.checklistImport = again.importId;
  const tasks = (await admin.get(`/periods/${S.pid}/tasks`)).data; S.t1 = tasks.find(t => t.key === 'X-01'); S.t2 = tasks.find(t => t.key === 'X-02'); assert.equal(S.t1.owner_id, S.prepId); assert.equal(S.t1.status, 'ready'); assert.equal(S.t2.status, 'not_started');
});
test('dependency cycles are rejected server-side with an explanation; informational links may be cyclic', async () => {
  const r = await admin.post(`/periods/${S.pid}/dependencies`, { from: S.t2.id, to: S.t1.id, kind: 'execution' }); assert.equal(r.status, 422); assert.match(r.data.message, /circular execution dependency: X-0[12].*→/); assert.equal(r.data.details.cycle.length, 3);
  assert.equal((await admin.post(`/periods/${S.pid}/dependencies`, { from: S.t2.id, to: S.t1.id, kind: 'informational' })).status, 200);
  assert.equal((await prep.post(`/periods/${S.pid}/dependencies`, { from: S.t1.id, to: S.t2.id })).status, 403, 'preparers cannot edit the dependency graph');
});
test('prepare, attach evidence, submit, request changes, approve; separation of duties; release of successors', async () => {
  const tr = (c, id, action, extra = {}) => c.post(`/tasks/${id}/transition`, { action, ...extra });
  assert.equal((await tr(prep, S.t2.id, 'start')).status, 422, 'cannot start before the predecessor is approved');
  assert.equal((await tr(prep, S.t1.id, 'start')).status, 200);
  let d = (await prep.get(`/tasks/${S.t1.id}`)).data; assert.equal(d.status, 'in_progress');
  const miss = await tr(prep, S.t1.id, 'submit'); assert.equal(miss.status, 422); assert.match(miss.data.message, /missing evidence \(Bank statement\)/);
  const up = await prep.ok('POST', `/documents/upload?filename=bank.csv&title=Bank%20statement%20Oct&period_id=${S.pid}`, csv([['date', 'amount'], ['2026-10-31', '125000.00']]), { raw: true }); S.doc = up; assert.equal(up.extraction.status, 'extracted');
  await prep.ok('POST', `/tasks/${S.t1.id}/evidence`, { documentVersionId: up.versionId, requirement: 'Bank statement' });
  assert.equal((await tr(prep, S.t1.id, 'submit')).status, 200);
  assert.equal((await tr(prep, S.t1.id, 'approve')).status, 403, 'a preparer cannot approve');
  const rc = await tr(rev, S.t1.id, 'request_changes', { note: 'Tie the statement to the ledger.' }); assert.equal(rc.status, 200); assert.equal(rc.data.task.status, 'changes_requested'); assert.equal(rc.data.task.review_rounds, 1);
  await tr(prep, S.t1.id, 'start'); await tr(prep, S.t1.id, 'submit');
  d = (await rev.get(`/tasks/${S.t1.id}`)).data; const stale = await rev.post(`/tasks/${S.t1.id}/transition`, { action: 'approve', expectedVersion: d.version - 1 }); assert.equal(stale.status, 409); assert.equal(stale.data.error, 'CONFLICT'); assert.equal(stale.data.details.current.status, 'submitted');
  const ap = await tr(rev, S.t1.id, 'approve', { expectedVersion: d.version }); assert.equal(ap.status, 200); assert.deepEqual(ap.data.releasedTasks.map(t => t.key), ['X-02']);
  assert.equal(ap.data.task.approvals[0].decision, 'approved'); assert.equal((await prep.get(`/tasks/${S.t2.id}`)).data.status, 'ready');
  // manager who prepared the work cannot approve it (SoD), and no exception is allowed by default
  const mine = await admin.ok('POST', `/periods/${S.pid}/tasks`, { name: 'Admin prepared', owner_id: 1, preparer_id: 1, reviewer_id: S.revId, review_min: 30 }); await tr(admin, mine.id, 'start'); await tr(admin, mine.id, 'submit');
  const sod = await tr(admin, mine.id, 'approve', { note: 'approving my own work' }); assert.equal(sod.status, 422); assert.equal(sod.data.details.sod, true); assert.equal(sod.data.details.exceptionAllowed, false);
  await admin.ok('PATCH', '/settings', { allow_sod_exception: true, confirm_sod: true });
  assert.equal((await tr(admin, mine.id, 'approve', { note: 'small team', sodException: { reason: 'short', compensatingReviewerId: S.revId } })).status, 422);
  const ex = await tr(admin, mine.id, 'approve', { note: 'small team this month', sodException: { reason: 'Reviewer on leave; two-person finance team.', compensatingReviewerId: S.revId } }); assert.equal(ex.status, 200); assert.equal(ex.data.task.approvals[0].sod_exception.compensatingReviewerId, S.revId);
  // evidence added after approval invalidates the review but keeps the approval record
  await prep.ok('POST', `/tasks/${S.t1.id}/evidence`, { documentVersionId: up.versionId, requirement: 'Additional support' }); d = (await rev.get(`/tasks/${S.t1.id}`)).data; assert.equal(d.needs_rereview, 1); assert.equal(d.approvals.filter(a => a.decision === 'approved').length, 1);
  await tr(rev, S.t1.id, 'reopen', { note: 'Evidence changed after approval' }); await tr(prep, S.t1.id, 'submit'); await tr(rev, S.t1.id, 'approve');
});
test('trial balance import: validation, unbalanced data shown not forced, duplicates blocked', async () => {
  const q = `?kind=tb&periodId=${S.pid}&filename=`; const hdr = ['entity', 'account', 'account_name', 'currency', 'debit', 'credit'];
  const bad = csv([hdr, ['US01', '1000', 'Cash', 'USD', '125000.00', '0'], ['US01', '2000', 'AP', 'USD', '0', '100000.00'], ['US01', '1000', 'Cash dup', 'USD', '5.00', '0'], ['ZZ', '1000', 'Cash', 'USD', '1', '0'], ['US01', '6000', 'Wages', 'EUR', '1', '0'], ['US01', '7000', 'Bad', 'USD', '12.345', '0']]);
  const pv = (await prep.req('POST', '/imports/preview' + q + 'bad.csv', bad, { raw: true })).data; assert.equal(pv.totals.acceptedRows, 2); assert.equal(pv.totals.rejectedRows, 4); assert.equal(pv.totals.unbalanced, true); assert.equal(pv.totals.balance[0].difference, 2500000);
  assert.match(pv.rejected.map(r => r.reason).join('|'), /Duplicate of row 2.*not set up.*not translated on import.*decimal places/); assert.equal(pv.unmapped.length, 2);
  const blocked = await prep.req('POST', '/imports/commit' + q + 'bad.csv', bad, { raw: true }); assert.equal(blocked.status, 422); assert.equal(blocked.data.details.needsConfirm, 'acceptUnbalanced');
  assert.equal((await admin.get(`/periods/${S.pid}/tb`)).data.lines.length, 0, 'nothing imported without confirmation');
  const good = csv([hdr, ['US01', '1000', 'Cash', 'USD', '125000.00', '0'], ['US01', '1100', 'AR', 'USD', '50000.00', '0'], ['US01', '2000', 'AP', 'USD', '0', '75000.00'], ['US01', '3000', 'Equity', 'USD', '0', '100000.00']]); S.tbGood = good;
  const c1 = await prep.ok('POST', '/imports/commit' + q + 'tb1.csv&createAccounts=1', good, { raw: true }); S.imp1 = c1.importId; assert.equal(c1.totals.unbalanced, false);
  assert.equal((await prep.req('POST', '/imports/commit' + q + 'tb1-copy.csv', good, { raw: true })).status, 409, 'identical file is not imported twice');
  const tb = (await admin.get(`/periods/${S.pid}/tb`)).data; assert.equal(tb.lines.length, 4); assert.equal(tb.balance[0].balanced, true); assert.equal(tb.unmapped.length, 4, 'unmapped accounts are listed, not silently placed on statements');
  const accts = (await admin.get('/accounts')).data; for (const [code, type] of [['1000', 'asset'], ['1100', 'asset'], ['2000', 'liability'], ['3000', 'equity']]) await admin.ok('PATCH', `/accounts/${accts.find(a => a.code === code).id}`, { type, line: code });
  const st = (await admin.get(`/periods/${S.pid}/statements?entity=${S.eid}`)).data; assert.equal(st.balance.totalAssets, 17500000); assert.equal(st.balance.check, 0); assert.equal(st.unmapped.length, 0);
  const v = (await admin.get(`/periods/${S.pid}/variance?entity=${S.eid}&comparison=prior_year`)).data; assert.match(v.unavailable, /No prior-year/);
});
test('reconciliation: version-bound approval, late source change forces re-review and flags downstream', async () => {
  const rec = await admin.ok('POST', `/periods/${S.pid}/recs`, { entity_id: S.eid, account: '1000', name: 'Operating cash', task_id: S.t1.id, preparer_id: S.prepId, reviewer_id: S.revId, support_source: 'Bank statement', threshold: '10.00' }); S.rec = rec.id; assert.equal(rec.gl_balance, 12500000);
  assert.match((await prep.post(`/recs/${rec.id}/transition`, { action: 'submit' })).data.message, /supporting balance/);
  await prep.ok('PATCH', `/recs/${rec.id}`, { support_balance: '124,000.00' }); assert.match((await prep.post(`/recs/${rec.id}/transition`, { action: 'submit' })).data.message, /above the threshold/);
  let r = await prep.ok('POST', `/recs/${rec.id}/items`, { description: 'Deposit in transit', amount: '1000.00', item_date: '2026-10-30' }); assert.equal(r.unexplained, 0); assert.equal(r.itemsTotal, 100000);
  await prep.ok('POST', `/recs/${rec.id}/transition`, { action: 'submit' }); assert.equal((await prep.post(`/recs/${rec.id}/transition`, { action: 'approve' })).status, 403);
  r = await rev.ok('POST', `/recs/${rec.id}/transition`, { action: 'approve' }); assert.equal(r.status, 'approved'); assert.deepEqual([r.lastApproval.target_version, r.lastApproval.source_version], [r.workpaper_version, 1]);
  assert.match((await prep.post(`/imports/${S.imp1}/rollback`)).data.message, /approved against this data/, 'an import that is relied on cannot be rolled back');
  // approve the downstream task so the re-review flag has something to hit
  await prep.post(`/tasks/${S.t2.id}/transition`, { action: 'start' }); await prep.post(`/tasks/${S.t2.id}/transition`, { action: 'submit' }); await rev.post(`/tasks/${S.t2.id}/transition`, { action: 'approve' });
  const late = csv([['entity', 'account', 'account_name', 'currency', 'debit', 'credit'], ['US01', '1000', 'Cash', 'USD', '126500.00', '0'], ['US01', '1100', 'AR', 'USD', '48500.00', '0'], ['US01', '2000', 'AP', 'USD', '0', '75000.00'], ['US01', '3000', 'Equity', 'USD', '0', '100000.00']]);
  const c2 = await prep.ok('POST', `/imports/commit?kind=tb&periodId=${S.pid}&filename=tb2-late.csv`, late, { raw: true }); assert.equal(c2.changedAccounts, 2); assert.equal(c2.reconciliations[0].reReview, true); assert.deepEqual(c2.reconciliations[0].downstream.map(d => d.key), ['X-02']);
  r = (await rev.get(`/recs/${rec.id}`)).data; assert.equal(r.status, 'needs_rereview'); assert.equal(r.source_version, 2); assert.equal(r.gl_balance, 12650000); assert.equal(r.unexplained, 150000);
  assert.equal(r.approvals.filter(a => a.decision === 'approved').length, 1, 'the earlier approval is retained'); assert.deepEqual(r.stale, { workpaper: false, source: true });
  assert.equal((await rev.get(`/tasks/${S.t1.id}`)).data.needs_rereview, 1); const dn = (await rev.get(`/tasks/${S.t2.id}`)).data; assert.equal(dn.upstream_changed, 1); assert.equal(dn.needs_rereview, 1);
  assert.throws(() => app.db.dbFor('live').run('UPDATE approvals SET decision=? WHERE id=1', 'tampered'), /immutable/); assert.throws(() => app.db.dbFor('live').run('DELETE FROM audit_events WHERE id=1'), /append-only/);
  const f = (await admin.ok('POST', `/periods/${S.pid}/findings/run?sync=1`)); assert.ok(f.total >= 1); const fs2 = (await admin.get(`/periods/${S.pid}/findings`)).data.findings; assert.ok(fs2.some(x => x.rule === 'review_invalidated' && /Operating cash/.test(x.title)));
});
test('sign-off is blocked by open items, then sign-off, lock and controlled reopen', async () => {
  const c = (await admin.get(`/periods/${S.pid}/completion`)).data; assert.equal(c.canSign, false); const so = c.signoffs[0];
  assert.match((await admin.post(`/signoffs/${so.id}/sign`)).data.message, /not ready for sign-off/); assert.match((await admin.post(`/periods/${S.pid}/lock`)).data.message, /sign-offs are required/);
  // resolve: update rec, re-approve; mark the untouched template tasks not applicable; re-approve flagged tasks
  await prep.ok('PATCH', `/recs/${S.rec}`, { support_balance: '125,500.00' }); await prep.ok('POST', `/recs/${S.rec}/transition`, { action: 'submit' }); await rev.ok('POST', `/recs/${S.rec}/transition`, { action: 'approve' });
  for (const id of [S.t2.id]) { await rev.ok('POST', `/tasks/${id}/transition`, { action: 'reopen', note: 'Upstream balance changed' }); await prep.ok('POST', `/tasks/${id}/transition`, { action: 'submit' }); await rev.ok('POST', `/tasks/${id}/transition`, { action: 'approve' }); }
  const open = (await admin.get(`/periods/${S.pid}/tasks`)).data.filter(t => !['approved', 'not_applicable'].includes(t.status)); const bulk = await admin.ok('POST', '/tasks/bulk', { ids: open.map(t => t.id), action: 'mark_na', note: 'Out of scope for this test close' }); assert.equal(bulk.failed.length, 0);
  let cc = (await admin.get(`/periods/${S.pid}/completion`)).data; assert.equal(cc.canSign, true, JSON.stringify(cc.blockers.filter(b => b.count)));
  assert.equal((await prep.post(`/signoffs/${so.id}/sign`)).status, 403); assert.equal((await admin.post(`/signoffs/${cc.signoffs[1].id}/sign`)).status, 422, 'sign-offs are ordered');
  await admin.ok('POST', `/signoffs/${cc.signoffs[0].id}/sign`, { note: 'ok' }); await admin.ok('POST', `/signoffs/${cc.signoffs[1].id}/sign`); await admin.ok('POST', `/periods/${S.pid}/lock`);
  assert.equal((await prep.post(`/tasks/${S.t1.id}/transition`, { action: 'reopen', note: 'try after lock' })).status, 423); assert.equal((await prep.req('POST', `/imports/commit?kind=tb&periodId=${S.pid}&filename=x.csv`, S.tbGood, { raw: true })).status, 423); assert.equal((await prep.patch(`/recs/${S.rec}`, { explanation: 'x' })).status, 423);
  assert.equal((await prep.post(`/periods/${S.pid}/reopen`, { reason: 'I would like to change things' })).status, 403); assert.equal((await admin.post(`/periods/${S.pid}/reopen`, { reason: 'no' })).status, 422);
  await admin.ok('POST', `/periods/${S.pid}/reopen`, { reason: 'Late vendor invoice requires an accrual adjustment.' }); cc = (await admin.get(`/periods/${S.pid}/completion`)).data; assert.equal(cc.period.status, 'reopened'); assert.ok(cc.signoffs.every(s => s.status === 'pending'), 'sign-offs must be renewed');
  const j = await prep.ok('POST', `/periods/${S.pid}/journals`, { entity_id: S.eid, description: 'Late accrual', lines: [{ account: '6000', debit: '500.00' }, { account: '2000', credit: '500.00' }], support: 'Invoice 1' }); assert.equal(j.late, 1);
  assert.match((await prep.post(`/journals/${j.id}/transition`, { action: 'confirm_posted', postingRef: 'GL-1' })).data.message, /Only an approved journal/); await prep.ok('POST', `/journals/${j.id}/transition`, { action: 'submit' });
  assert.equal((await prep.post(`/journals/${j.id}/transition`, { action: 'approve' })).status, 403); const aj = await rev.ok('POST', `/journals/${j.id}/transition`, { action: 'approve' }); assert.equal(aj.status, 'approved'); assert.equal(aj.posting_ref, null, 'approval does not imply posting');
  assert.equal((await prep.ok('POST', `/journals/${j.id}/transition`, { action: 'confirm_posted', postingRef: 'GL-2026-10-0099' })).status, 'posted_confirmed');
  const unbalanced = await prep.ok('POST', `/periods/${S.pid}/journals`, { entity_id: S.eid, description: 'x', lines: [{ account: '6000', debit: '10.00' }, { account: '2000', credit: '9.99' }], support: 's' }); assert.match((await prep.post(`/journals/${unbalanced.id}/transition`, { action: 'submit' })).data.message, /does not balance/);
});
test('rollover carries assignments and instructions but requires fresh evidence and sign-offs; data persists across restart', async () => {
  const tv = (await admin.get('/templates')).data[0].versions[0].id; const p2 = await admin.ok('POST', '/periods', { name: 'Nov 2026', start: '2026-11-01', end: '2026-11-30', templateVersionId: tv }); assert.equal(p2.carriedFrom, 'Oct 2026');
  const recs = (await admin.get(`/periods/${p2.periodId}/recs`)).data; assert.equal(recs.length, 1); assert.equal(recs[0].beginning, 12650000); assert.equal(recs[0].status, 'not_started'); assert.equal(recs[0].support_balance, null);
  const c = (await admin.get(`/periods/${p2.periodId}/completion`)).data; assert.ok(c.signoffs.every(s => s.status === 'pending')); const t = (await admin.get(`/periods/${p2.periodId}/tasks`)).data; assert.ok(t.every(x => x.evidence_have === 0));
  // "restart": close database handles and reopen from disk
  app.db.closeAll(); const me = (await admin.me()).data; assert.equal(me.periods.length, 2); assert.equal((await admin.get(`/tasks/${S.t1.id}`)).data.key, 'X-01'); assert.ok(fs.existsSync(path.join(app.dir, 'live', 'app.db')));
  const audit = (await admin.get('/audit')).data; assert.equal(audit.chain.ok, true); assert.ok(audit.total > 20);
});
