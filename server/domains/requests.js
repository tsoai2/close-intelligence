import { route, bad, invalid, forbidden, notFound, checkVersion, cleanText, pick } from '../core.js';
import { J, putFile } from '../db.js';
import { newInviteToken } from '../auth.js';
import { recomputeReadiness } from '../engine.js';
import { registerUpload } from './documents.js';

export const REQUEST_TEMPLATES = [
  { key: 'inventory', title: 'Period-end inventory report', recipient_org: 'Operations / 3PL', deliverable: 'On-hand quantity and value by SKU and location as of period end, with receiving cutoff confirmation.', offset_bd: 1 },
  { key: 'payroll', title: 'Payroll register and tax liability report', recipient_org: 'Payroll provider', deliverable: 'Final payroll register for all pay dates in the period, employer tax summary and accrued PTO report.', offset_bd: 1 },
  { key: 'bank', title: 'Bank statements', recipient_org: 'Bank', deliverable: 'Month-end statements for all operating, payroll and lockbox accounts.', offset_bd: 1 },
  { key: 'sales', title: 'Sales cutoff and unshipped orders', recipient_org: 'Sales operations', deliverable: 'Shipments in the last and first three days around period end with terms, plus open customer programs.', offset_bd: 2 },
  { key: 'hr', title: 'Headcount changes and bonus accrual inputs', recipient_org: 'HR', deliverable: 'New hires, terminations, compensation changes and bonus attainment estimates.', offset_bd: 2 },
  { key: 'treasury', title: 'Debt and covenant inputs', recipient_org: 'Treasury', deliverable: 'Period-end borrowings, interest rate notices and covenant calculation inputs.', offset_bd: 3 },
  { key: 'tax', title: 'Tax provision inputs', recipient_org: 'Tax / outside accountants', deliverable: 'Permanent and temporary differences, estimated payments and rate changes.', offset_bd: 4 },
  { key: 'it', title: 'System access and batch-job confirmation', recipient_org: 'IT', deliverable: 'Confirmation that period-end jobs completed and a listing of ERP access changes.', offset_bd: 1 },
  { key: 'valuation', title: 'Valuation specialist report', recipient_org: 'Valuation specialist', deliverable: 'Fair value or impairment analysis with key assumptions.', offset_bd: 4 },
];
const OPEN = ['sent', 'acknowledged'];
function view(ctx, r, now) {
  const tasks = ctx.db.all('SELECT t.id, t.key, t.name, t.status, t.due_at FROM request_tasks rt JOIN tasks t ON t.id=rt.task_id WHERE rt.request_id=?', r.id);
  const earliestTaskDue = tasks.map(t => t.due_at).filter(Boolean).sort()[0] || null;
  return { ...r, reminders: J(r.reminders, []), links: J(r.links, []), tasks, overdue: OPEN.includes(r.status) && !!r.due_at && r.due_at < now, awaitingReview: r.status === 'received',
    unanswered: r.status === 'sent' && !r.last_response_at, dueMismatch: !!(r.due_at && earliestTaskDue && r.due_at > earliestTaskDue) ? { requestDue: r.due_at, taskDue: earliestTaskDue } : null };
}
route('GET', '/request-templates', { perm: 'read' }, () => REQUEST_TEMPLATES);
route('GET', '/periods/:pid/requests', { perm: 'read' }, ctx => { const p = ctx.period(ctx.params.pid); const now = ctx.now(); return ctx.db.all('SELECT * FROM requests WHERE org_id=? AND period_id=? ORDER BY due_at, id', ctx.orgId, p.id).map(r => view(ctx, r, now)); });
route('GET', '/requests/:id', { perm: 'read' }, ctx => { const r = ctx.own('requests', ctx.params.id); return { ...view(ctx, r, ctx.now()), log: ctx.db.all("SELECT * FROM comments WHERE org_id=? AND target_type='request' AND target_id=? ORDER BY id", ctx.orgId, r.id),
  documents: ctx.db.all("SELECT d.id, d.title FROM doc_links l JOIN documents d ON d.id=l.document_id WHERE l.org_id=? AND l.target_type='request' AND l.target_id=?", ctx.orgId, r.id) }; });
const FIELDS = ['title', 'deliverable', 'recipient_name', 'recipient_org', 'recipient_user_id', 'classification', 'due_at', 'expected_at', 'next_action', 'delay_reason'];
function clean(ctx, b) {
  const f = pick(b, FIELDS); for (const k of ['title', 'deliverable', 'recipient_name', 'recipient_org', 'next_action', 'delay_reason']) if (f[k] != null) f[k] = cleanText(f[k], 1000);
  for (const k of ['due_at', 'expected_at']) if (f[k] != null && f[k] !== '' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f[k])) throw invalid('Dates must look like 2026-11-03T17:00.'); if (f.expected_at === '') f.expected_at = null;
  if (f.classification && !['internal', 'external'].includes(f.classification)) throw invalid('Classification must be internal or external.'); if (f.recipient_user_id) ctx.own('users', f.recipient_user_id);
  return f;
}
route('POST', '/periods/:pid/requests', { perm: 'requests' }, ctx => ctx.db.tx(() => {
  const p = ctx.openPeriod(ctx.params.pid); const f = clean(ctx, ctx.body); if (!f.title?.trim()) throw invalid('Give the request a title.');
  const id = ctx.db.insert('requests', { org_id: ctx.orgId, period_id: p.id, sender_id: ctx.user.id, classification: 'internal', status: 'draft', created_at: ctx.now(), ...f });
  for (const tid of ctx.body.taskIds || []) { const t = ctx.own('tasks', tid); if (t.period_id === p.id) ctx.db.run('INSERT OR IGNORE INTO request_tasks VALUES(?,?)', id, t.id); }
  ctx.audit('request.created', 'request', id, { title: f.title }); ctx.changed('requests', 'today', 'schedule'); return view(ctx, ctx.own('requests', id), ctx.now());
}));
route('PATCH', '/requests/:id', { perm: 'requests' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('requests', ctx.params.id); ctx.openPeriod(r.period_id); checkVersion(r, ctx.body.expectedVersion, 'request'); const f = clean(ctx, ctx.body.fields || {});
  ctx.db.update('requests', r.id, { ...f, version: r.version + 1 });
  if (ctx.body.taskIds) { ctx.db.run('DELETE FROM request_tasks WHERE request_id=?', r.id); for (const tid of ctx.body.taskIds) { const t = ctx.own('tasks', tid); ctx.db.run('INSERT OR IGNORE INTO request_tasks VALUES(?,?)', r.id, t.id); } }
  ctx.changed('requests', 'today', 'schedule', 'overview'); return view(ctx, ctx.own('requests', r.id), ctx.now());
}));
function log(ctx, r, kind, text) { ctx.db.insert('comments', { org_id: ctx.orgId, target_type: 'request', target_id: r.id, user_id: ctx.user.id, body: text, kind, at: ctx.now() }); }
/** When a deliverable is accepted, linked tasks that were only waiting on it resume. */
function releaseWaiting(ctx, r) {
  const resumed = [];
  for (const t of ctx.db.all("SELECT t.* FROM request_tasks rt JOIN tasks t ON t.id=rt.task_id WHERE rt.request_id=? AND t.status IN ('waiting','blocked')", r.id)) {
    const others = ctx.db.val("SELECT COUNT(*) FROM request_tasks rt JOIN requests q ON q.id=rt.request_id WHERE rt.task_id=? AND q.id!=? AND q.status IN ('draft','sent','acknowledged','received')", t.id, r.id); if (others) continue;
    ctx.db.update('tasks', t.id, { status: 'in_progress', wait_reason: null, started_at: t.started_at || ctx.now(), version: t.version + 1, updated_at: ctx.now() });
    ctx.db.insert('task_events', { org_id: ctx.orgId, period_id: t.period_id, task_id: t.id, type: 'resume', from_status: t.status, to_status: 'in_progress', user_id: ctx.user.id, note: `Deliverable accepted: ${r.title}`, at: ctx.now() });
    ctx.notify(t.preparer_id || t.owner_id, 'released', `Unblocked: ${t.key} ${t.name}`, `"${r.title}" was received and accepted.`, `task:${t.id}`); resumed.push({ id: t.id, key: t.key, name: t.name });
  }
  recomputeReadiness(ctx.db, ctx.orgId, r.period_id, ctx.now(), ctx.user.id); return resumed;
}
route('POST', '/requests/:id/transition', { perm: 'requests' }, ctx => ctx.db.tx(() => {
  const r = ctx.own('requests', ctx.params.id); ctx.openPeriod(r.period_id); const a = ctx.body.action; const note = cleanText(ctx.body.note, 2000); const set = f => ctx.db.update('requests', r.id, { ...f, version: r.version + 1 }); let resumed = [];
  const from = (...s) => { if (!s.includes(r.status)) throw invalid(`A request that is "${r.status}" cannot be moved with "${a}".`); };
  if (a === 'mark_sent') { from('draft'); set({ status: 'sent' }); log(ctx, r, 'status', 'Marked as sent by the requester. The app did not send a message.'); if (r.recipient_user_id) ctx.notify(r.recipient_user_id, 'request', `Request: ${r.title}`, r.deliverable, `request:${r.id}`); }
  else if (a === 'acknowledge') { from('sent'); set({ status: 'acknowledged', last_response_at: ctx.now(), last_response: note || 'Acknowledged' }); log(ctx, r, 'response', note || 'Acknowledged'); }
  else if (a === 'log_response') { from('sent', 'acknowledged'); if (!note?.trim()) throw invalid('Summarise the response.'); const exp = ctx.body.expected_at; if (exp && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(exp)) throw invalid('Expected date must look like 2026-11-06T12:00.');
    set({ last_response_at: ctx.now(), last_response: note, expected_at: exp || r.expected_at, delay_reason: cleanText(ctx.body.delay_reason, 500) ?? r.delay_reason, status: 'acknowledged' }); log(ctx, r, 'response', note + (ctx.body.source === 'email' ? ' (logged from email — evidence of communication, not of completion)' : '')); }
  else if (a === 'remind') { from('sent', 'acknowledged'); const rem = J(r.reminders, []); rem.push({ at: ctx.now(), by: ctx.user.id }); set({ reminders: rem }); log(ctx, r, 'reminder', 'Reminder recorded. Use the email draft to contact the recipient; nothing was sent automatically.'); }
  else if (a === 'receive') { from('sent', 'acknowledged', 'draft'); set({ status: 'received', received_at: ctx.now() }); log(ctx, r, 'status', note || 'Deliverable received; awaiting internal review.');
    if (ctx.body.documentId) { const d = ctx.own('documents', ctx.body.documentId); ctx.db.insert('doc_links', { org_id: ctx.orgId, document_id: d.id, target_type: 'request', target_id: r.id, rel: 'deliverable' }); }
    for (const t of ctx.db.all('SELECT t.* FROM request_tasks rt JOIN tasks t ON t.id=rt.task_id WHERE rt.request_id=?', r.id)) ctx.notify(t.preparer_id || t.owner_id, 'request', `Received, needs your review: ${r.title}`, null, `request:${r.id}`); }
  else if (a === 'accept') { from('received'); set({ status: 'accepted', reviewed_at: ctx.now() }); log(ctx, r, 'status', note || 'Deliverable reviewed and accepted.'); resumed = releaseWaiting(ctx, r); }
  else if (a === 'reject') { from('received'); if (!note?.trim()) throw invalid('Say what is wrong with the deliverable.'); set({ status: 'sent', received_at: null, next_action: note }); log(ctx, r, 'status', `Returned to sender: ${note}`); }
  else if (a === 'cancel') { if (!ctx.can('manage') && r.sender_id !== ctx.user.id) throw forbidden(); set({ status: 'cancelled' }); log(ctx, r, 'status', note || 'Cancelled'); resumed = releaseWaiting(ctx, r); }
  else throw bad('Unknown action.');
  ctx.audit('request.' + a, 'request', r.id, { title: r.title }); ctx.changed('requests', 'today', 'schedule', 'overview', 'tasks'); return { request: view(ctx, ctx.own('requests', r.id), ctx.now()), resumed };
}));
// Drafts only: the user reviews the text and sends it from their own mail client.
route('GET', '/requests/:id/email-draft', { perm: 'requests' }, ctx => {
  const r = ctx.own('requests', ctx.params.id); const p = ctx.period(r.period_id); const to = r.recipient_user_id ? ctx.db.get('SELECT email FROM users WHERE id=?', r.recipient_user_id)?.email : '';
  const overdue = OPEN.includes(r.status) && r.due_at && r.due_at < ctx.now();
  return { to: to || '', subject: `${overdue ? 'Follow-up: ' : ''}${r.title} — ${p.name} close`, body: `Hello ${r.recipient_name || ''},\n\n${overdue ? 'We have not yet received the item below and it is now holding up the ' + p.name + ' close.' : 'For the ' + p.name + ' close we need the following.'}\n\nDeliverable: ${r.deliverable || r.title}\nDue: ${(r.due_at || '').replace('T', ' ')}\n\n${overdue ? 'Could you confirm when we can expect it?' : 'Please let me know if the due time is a problem.'}\n\nThank you,\n${ctx.user.name}`,
    notice: 'This is a draft for you to review. CLOSE INTELLIGENCE does not send email.' };
});
route('GET', '/requests/:id/ics', { perm: 'requests' }, ctx => {
  const r = ctx.own('requests', ctx.params.id); if (!r.due_at) throw invalid('Set a due date first.'); const dt = r.due_at.replace(/[-:]/g, '') + '00'; const esc = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CLOSE INTELLIGENCE//EN', 'BEGIN:VEVENT', `UID:ci-request-${ctx.env}-${r.id}@close-intelligence`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART:${dt}`, `DTEND:${dt}`, `SUMMARY:${esc('Due: ' + r.title)}`, `DESCRIPTION:${esc(r.deliverable)}`, 'BEGIN:VALARM', 'TRIGGER:-PT4H', 'ACTION:DISPLAY', 'DESCRIPTION:Request due', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return { __file: Buffer.from(ics), type: 'text/calendar; charset=utf-8', name: `request-${r.id}.ics` };
});
// External portal (off by default). Invitations expire and are bound to a single request.
route('POST', '/requests/:id/invite', { perm: 'manage', env: 'live' }, ctx => {
  if (!ctx.settings.portal_enabled) throw invalid('External portal access is turned off. An administrator can enable it in Policies.'); const r = ctx.own('requests', ctx.params.id); if (r.classification !== 'external') throw invalid('Only external requests can have portal invitations.');
  const email = String(ctx.body.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('Enter the recipient’s email address.'); if (String(ctx.body.confirmEmail || '').trim().toLowerCase() !== email) throw invalid('Re-enter the email address to confirm the recipient.');
  const t = newInviteToken(); ctx.db.insert('invitations', { org_id: ctx.orgId, email, name: r.recipient_name, role: 'external', external_org: r.recipient_org, token_hash: t.hash, expires_at: Date.now() + 7 * 86400e3, created_by: ctx.user.id, request_id: r.id });
  ctx.audit('portal.invited', 'request', r.id, { email }); return { token: t.token, expiresInDays: 7, notice: 'Share this one-time link yourself. The app did not email it.' };
});
const portalReq = (ctx, id) => { const r = ctx.db.get('SELECT * FROM requests WHERE id=? AND org_id=? AND recipient_user_id=?', Number(id), ctx.orgId, ctx.user.id); if (!r) throw notFound('Request not found.'); return r; };
const portalView = r => pick(r, ['id', 'title', 'deliverable', 'due_at', 'status', 'last_response', 'expected_at']);
route('GET', '/portal/requests', { perm: 'portal' }, ctx => ctx.db.all("SELECT * FROM requests WHERE org_id=? AND recipient_user_id=? AND status!='cancelled' ORDER BY due_at", ctx.orgId, ctx.user.id).map(portalView));
route('POST', '/portal/requests/:id/respond', { perm: 'portal' }, ctx => { const r = portalReq(ctx, ctx.params.id); if (!['sent', 'acknowledged'].includes(r.status)) throw invalid('This request is not open for responses.'); const note = cleanText(ctx.body.note, 2000); if (!note?.trim()) throw invalid('Write a response.');
  ctx.db.update('requests', r.id, { status: 'acknowledged', last_response_at: ctx.now(), last_response: note, expected_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ctx.body.expected_at || '') ? ctx.body.expected_at : r.expected_at, version: r.version + 1 }); log(ctx, r, 'response', note); ctx.notify(r.sender_id, 'request', `Response on: ${r.title}`, note.slice(0, 200), `request:${r.id}`); ctx.changed('requests', 'schedule'); return portalView(ctx.own('requests', r.id)); });
route('POST', '/portal/requests/:id/upload', { perm: 'portal', raw: true }, ctx => ctx.db.tx(() => { const r = portalReq(ctx, ctx.params.id); if (!['sent', 'acknowledged'].includes(r.status)) throw invalid('This request is not open for uploads.');
  const doc = registerUpload(ctx, ctx.body, ctx.query.filename, { title: `${r.title} — from ${ctx.user.external_org || ctx.user.name}`, doc_class: 'external_deliverable', period_id: r.period_id, purpose: 'Deliverable uploaded through the external portal' });
  ctx.db.insert('doc_links', { org_id: ctx.orgId, document_id: doc.documentId, target_type: 'request', target_id: r.id, rel: 'deliverable' }); ctx.db.update('requests', r.id, { status: 'received', received_at: ctx.now(), version: r.version + 1 }); log(ctx, r, 'status', 'Deliverable uploaded by the external contributor; awaiting internal review.');
  ctx.notify(r.sender_id, 'request', `Deliverable uploaded: ${r.title}`, null, `request:${r.id}`); ctx.changed('requests', 'documents'); return portalView(ctx.own('requests', r.id)); }));
export { putFile };
