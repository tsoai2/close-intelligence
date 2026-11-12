// Chart series: every figure a chart draws must agree with the records it claims to summarise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, Client } from '../helpers.js';

let app, demo, me;
before(async () => { app = await startApp(); demo = new Client(app.base, 'demo'); await demo.get('/auth/status'); me = await demo.demo(); });
after(async () => { await app.close(); });

test('open period: burn-up, stages and process bars agree with the overview', async () => {
  const p = me.periods.find(x => x.status === 'open'); const d = await demo.ok('GET', `/periods/${p.id}/dashboard`); const ov = await demo.ok('GET', `/periods/${p.id}/overview`);
  const total = ov.completion.unweighted.total, done = ov.completion.unweighted.done; const b = d.burn;
  assert.equal(b.total, total); assert.equal(d.pipeline.reduce((a, s) => a + s.count, 0), total, 'every task is in exactly one stage');
  assert.equal(d.pipeline.find(s => s.key === 'approved').count, done);
  const today = b.days.find(x => x.date === b.today); assert.equal(today.actual, done, 'approved line ends at the overview count'); assert.equal(today.projected, done, 'projection starts where the approved line ends');
  assert.ok(b.days.every((x, i) => i === 0 || (x.planned >= b.days[i - 1].planned && (x.actual == null || b.days[i - 1].actual == null || x.actual >= b.days[i - 1].actual))), 'cumulative series never decrease');
  assert.ok(b.days.filter(x => x.date > b.today).every(x => x.actual === null), 'no approvals are drawn in the future');
  assert.ok(b.days.filter(x => x.date < b.today).every(x => x.projected === null), 'no projection is drawn in the past');
  assert.equal(b.days[b.days.length - 1].planned, total); assert.ok(b.days[b.days.length - 1].projected <= total);
  assert.equal(b.projectedFinish, ov.timeliness.projected, 'same projected finish as the schedule');
  assert.equal(d.processes.reduce((a, x) => a + x.total, 0), total); assert.equal(d.processes.reduce((a, x) => a + x.approved, 0), done);
});

test('income bridge adds up exactly and matches the consolidated statement', async () => {
  const p = me.periods.find(x => x.status === 'open'); const d = await demo.ok('GET', `/periods/${p.id}/dashboard`); const st = await demo.ok('GET', `/periods/${p.id}/statements?entity=consolidated`); const f = d.financial;
  assert.equal(f.available, true); const w = f.waterfall; assert.equal(w[0].amount, st.income.totalRevenue); assert.equal(w[w.length - 1].amount, st.income.netIncome);
  assert.equal(w.slice(0, -1).reduce((a, s) => a + s.amount, 0), w[w.length - 1].amount, 'revenue less each deduction equals net income, to the cent');
  assert.ok(w.every(s => Number.isInteger(s.amount)), 'amounts stay in integer minor units');
  const cur = f.trend.find(t => t.periodId === p.id); assert.equal(cur.revenue, st.income.totalRevenue); assert.equal(cur.netIncome, st.income.netIncome); assert.equal(f.trend.length, me.periods.length);
});

test('closed period shows recorded history only; Live with no data draws nothing', async () => {
  const locked = me.periods.find(x => x.status === 'locked'); const d = await demo.ok('GET', `/periods/${locked.id}/dashboard`);
  assert.equal(d.burn.today, null); assert.equal(d.burn.projectedFinish, null); assert.ok(d.burn.days.every(x => x.projected === null), 'a closed period has no projection');
  assert.equal(d.burn.days[d.burn.days.length - 1].actual, d.burn.total);
  const live = new Client(app.base, 'live'); await live.get('/auth/status'); assert.equal((await live.get(`/periods/${locked.id}/dashboard`)).status, 401, 'Live needs its own sign-in');
  await live.ok('POST', '/auth/bootstrap', { orgName: 'Chart Test Co', name: 'Lee Admin', email: 'lee@charts.test', password: 'correct-horse-9' }); await live.me();
  assert.equal((await live.get(`/periods/${locked.id}/dashboard`)).status, 404, 'a demo period id does not resolve in Live');
});
