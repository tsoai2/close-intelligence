import path from 'node:path';
import { route, bad, invalid, forbidden, notFound, HttpError, cleanText, pick, broadcast } from '../core.js';
import { J, putFile, getFile } from '../db.js';
import { hmac } from '../config.js';
import { readXlsx, readDocx, readPdfText } from '../lib/files.js';

const TYPES = { csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const CLASSIFICATIONS = { unclassified: 'Not yet classified', no_usage_observed: 'No usage observed', possibly_redundant: 'Possibly redundant', superseded: 'Superseded', required_retention: 'Required evidence / retention', confirmed_not_needed: 'Confirmed no longer needed' };
const magicOk = (ext, b) => { const h = b.subarray(0, 8); if (ext === 'pdf') return h.toString('latin1', 0, 4) === '%PDF'; if (['xlsx', 'xlsm', 'docx'].includes(ext)) return h[0] === 0x50 && h[1] === 0x4b; if (ext === 'png') return h[0] === 0x89 && h[1] === 0x50; if (['jpg', 'jpeg'].includes(ext)) return h[0] === 0xff && h[1] === 0xd8; if (ext === 'gif') return h.toString('latin1', 0, 3) === 'GIF'; if (ext === 'webp') return b.toString('latin1', 8, 12) === 'WEBP'; return !b.subarray(0, 4096).includes(0); };

/** Extract searchable text and say honestly what could not be analysed. */
export function extractText(buf, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase(); const notes = [];
  try {
    if (['csv', 'txt', 'md'].includes(ext)) return { text: buf.toString('utf8').slice(0, 400000), status: 'extracted', notes, refs: ext === 'csv' ? ['rows'] : ['text'] };
    if (ext === 'xlsx' || ext === 'xlsm') { const wb = readXlsx(buf); notes.push(...wb.notes); if (ext === 'xlsm' && !wb.notes.some(n => /macro/i.test(n))) notes.push('Macro-enabled workbook; macros were not analysed.');
      return { text: wb.sheets.map(s => `[Worksheet: ${s.name}]\n` + s.rows.map(r => r.join('\t')).join('\n')).join('\n\n').slice(0, 400000), status: wb.notes.length ? 'partial' : 'extracted', notes, refs: wb.sheets.map(s => `Worksheet "${s.name}"`) }; }
    if (ext === 'docx') return { text: readDocx(buf).slice(0, 400000), status: 'extracted', notes, refs: ['document body'] };
    if (ext === 'pdf') { const pages = readPdfText(buf); if (!pages.length) return { text: '', status: 'no_text', notes: ['No text layer could be read (scanned pages, or fonts/compression this reader does not support). OCR is optional and not configured.'], refs: [] };
      return { text: pages.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n').slice(0, 400000), status: 'extracted', notes: ['Text read from simple PDF content streams; layout, tables and images are not interpreted.'], refs: pages.map((_, i) => `Page ${i + 1}`) }; }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return { text: '', status: 'ocr_not_configured', notes: ['Image stored unchanged. OCR is optional and not configured, so its content is not searchable or analysed.'], refs: [] };
  } catch (e) { return { text: '', status: 'failed', notes: [`Extraction failed: ${e.message}`], refs: [] }; }
  return { text: '', status: 'not_supported', notes: ['This file type is stored but not analysed.'], refs: [] };
}
/** Hook for malware scanning. No scanner ships with the app; wire one in here and return 'clean' or 'infected'. */
export const scanHook = () => 'not_scanned';

export function registerUpload(ctx, buf, filename, meta = {}, documentId = null) {
  filename = path.basename(String(filename || '')).replace(/[^\w.\- ()&,+]/g, '_').slice(0, 160); const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!filename || !TYPES[ext]) throw new HttpError(415, 'UNSUPPORTED_TYPE', `File type ".${ext}" is not accepted. Allowed: ${Object.keys(TYPES).join(', ')}.`);
  if (!buf?.length) throw invalid('The file is empty.'); if (!magicOk(ext, buf)) throw new HttpError(415, 'TYPE_MISMATCH', 'The file content does not match its extension, so it was not stored.');
  const scan = scanHook(buf, filename); if (scan === 'infected') throw new HttpError(422, 'QUARANTINED', 'The file failed the malware scan and was not stored.');
  const stored = putFile(ctx.env, ctx.orgId, buf); const ex = extractText(buf, filename);
  let docId = documentId;
  if (!docId) docId = ctx.db.insert('documents', { org_id: ctx.orgId, title: cleanText(meta.title, 200) || filename.replace(/\.[^.]+$/, ''), doc_class: meta.doc_class || 'workpaper', owner_id: meta.owner_id === undefined ? ctx.user.id : meta.owner_id, purpose: cleanText(meta.purpose, 1000), entity_id: meta.entity_id || null, process: cleanText(meta.process, 80), period_id: meta.period_id || null,
    source_system: cleanText(meta.source_system, 80), cadence: cleanText(meta.cadence, 40), preparer_id: meta.preparer_id || null, reviewer_id: meta.reviewer_id || null, upstream: cleanText(meta.upstream, 300), retention: cleanText(meta.retention, 120), legal_hold: meta.legal_hold ? 1 : 0, classification: meta.classification || 'unclassified', classification_note: meta.classification_note || null, created_at: meta.at || ctx.now() });
  const version = (ctx.db.val('SELECT MAX(version) FROM document_versions WHERE document_id=?', docId) || 0) + 1;
  const versionId = ctx.db.insert('document_versions', { document_id: docId, version, filename, mime: TYPES[ext], size: stored.size, sha256: stored.sha256, storage_key: stored.key, extracted: ex.text, extraction_status: ex.status, extraction_notes: JSON.stringify({ notes: ex.notes, refs: ex.refs }), scan_status: scan, uploaded_by: meta.uploaded_by === undefined ? ctx.user.id : meta.uploaded_by, at: meta.at || ctx.now() });
  return { documentId: docId, versionId, version, sha256: stored.sha256, extraction: { status: ex.status, notes: ex.notes } };
}
export const canSeeDoc = (user, d) => user.role !== 'external' && (d.doc_class !== 'restricted' || ['admin', 'close_manager'].includes(user.role) || [d.owner_id, d.preparer_id, d.reviewer_id].includes(user.id));
const seeDoc = (ctx, id) => { const d = ctx.own('documents', id, 'Document not found.'); if (!canSeeDoc(ctx.user, d)) throw notFound('Document not found.'); return d; };
const latest = (db, id) => db.get('SELECT id, version, filename, mime, size, sha256, extraction_status, extraction_notes, scan_status, uploaded_by, at FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1', id);

export function usageSummary(db, orgId, docId, now, windowDays) {
  const since = new Date(Date.parse(now.slice(0, 10)) - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = db.all('SELECT kind, COUNT(*) n, MAX(at) last, COUNT(DISTINCT user_id) users FROM doc_usage WHERE org_id=? AND document_id=? AND at>=? GROUP BY kind', orgId, docId, since);
  return { windowDays, since, views: rows.find(r => r.kind === 'view')?.n || 0, downloads: rows.find(r => r.kind === 'download')?.n || 0, lastUsed: rows.map(r => r.last).sort().pop() || null,
    telemetrySources: ['Views and downloads inside CLOSE INTELLIGENCE'], notObserved: ['Opens from file shares, SharePoint or OneDrive', 'Copies sent by email or used offline', 'External links to the file', 'Use by people outside this app'],
    caution: 'No recorded views here does not mean the document is unused. Quarterly, annual, control and retention documents are often opened rarely or outside this app.' };
}
route('GET', '/documents', { perm: 'read' }, ctx => {
  const q = ctx.query; const where = ['d.org_id=?']; const args = [ctx.orgId];
  for (const [k, col] of [['process', 'd.process'], ['entity', 'd.entity_id'], ['period', 'd.period_id'], ['class', 'd.doc_class'], ['classification', 'd.classification'], ['owner', 'd.owner_id']]) if (q[k]) { if (q[k] === 'none') where.push(`${col} IS NULL`); else { where.push(`${col}=?`); args.push(q[k]); } }
  if (q.archived !== '1') where.push('d.archived=0');
  if (q.search?.trim()) { const s = '%' + q.search.trim().replace(/[%_]/g, m => '\\' + m) + '%'; where.push(`(d.title LIKE ? ESCAPE '\\' OR d.purpose LIKE ? ESCAPE '\\' OR d.process LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM document_versions v WHERE v.document_id=d.id AND (v.filename LIKE ? ESCAPE '\\' OR v.extracted LIKE ? ESCAPE '\\')))`); args.push(s, s, s, s, s); }
  const now = ctx.now(); const win = ctx.settings.usage_window_days; const since = new Date(Date.parse(now.slice(0, 10)) - win * 86400000).toISOString().slice(0, 10);
  const usage = Object.fromEntries(ctx.db.all('SELECT document_id, COUNT(*) n, MAX(at) last FROM doc_usage WHERE org_id=? AND at>=? GROUP BY document_id', ctx.orgId, since).map(u => [u.document_id, u]));
  const links = Object.fromEntries(ctx.db.all('SELECT document_id, COUNT(*) n FROM doc_links WHERE org_id=? GROUP BY document_id', ctx.orgId).map(l => [l.document_id, l.n]));
  return ctx.db.all(`SELECT d.* FROM documents d WHERE ${where.join(' AND ')} ORDER BY d.title LIMIT 500`, ...args).filter(d => canSeeDoc(ctx.user, d)).map(d => { const v = latest(ctx.db, d.id);
    return { ...d, latest: v ? { ...v, extraction_notes: undefined } : null, versions: ctx.db.val('SELECT COUNT(*) FROM document_versions WHERE document_id=?', d.id), usageCount: usage[d.id]?.n || 0, lastUsed: usage[d.id]?.last || null, linkCount: links[d.id] || 0, usageWindowDays: win }; });
});
function docDetail(ctx, d) {
  const versions = ctx.db.all('SELECT id, version, filename, mime, size, sha256, extraction_status, extraction_notes, scan_status, uploaded_by, at, substr(extracted,1,3000) excerpt FROM document_versions WHERE document_id=? ORDER BY version DESC', d.id).map(v => ({ ...v, extraction_notes: J(v.extraction_notes, { notes: [], refs: [] }) }));
  const links = ctx.db.all('SELECT * FROM doc_links WHERE org_id=? AND document_id=?', ctx.orgId, d.id).map(l => { let label = `${l.target_type} ${l.target_id}`, missing = false;
    if (l.target_type === 'task') { const t = ctx.db.get('SELECT key, name, period_id, status FROM tasks WHERE id=? AND org_id=?', l.target_id, ctx.orgId); if (t) label = `${t.key} ${t.name}`; else missing = true; }
    else if (l.target_type === 'control') { const c = ctx.db.get('SELECT code, name FROM controls WHERE id=? AND org_id=?', l.target_id, ctx.orgId); if (c) label = `${c.code} ${c.name}`; else missing = true; }
    else if (l.target_type === 'document') { const o = ctx.db.get('SELECT title FROM documents WHERE id=? AND org_id=?', l.target_id, ctx.orgId); if (o) label = o.title; else missing = true; }
    else if (l.target_type === 'request') { const r = ctx.db.get('SELECT title FROM requests WHERE id=? AND org_id=?', l.target_id, ctx.orgId); if (r) label = r.title; else missing = true; }
    else if (l.target_type === 'report') label = String(l.target_id === 1 ? 'Close package' : 'Management report');
    return { ...l, label, missing }; });
  const evidenceUses = ctx.db.all('SELECT e.id, e.task_id, e.period_id, v.version, t.key, t.name, t.status FROM evidence e JOIN document_versions v ON v.id=e.document_version_id JOIN tasks t ON t.id=e.task_id WHERE v.document_id=? AND e.removed=0', d.id);
  return { ...d, versions, links, evidenceUses, lineage: { producedBy: links.filter(l => l.rel === 'output'), consumedBy: links.filter(l => ['input', 'evidence', 'procedure'].includes(l.rel)), upstream: d.upstream, downstreamDocs: ctx.db.all("SELECT d2.id, d2.title FROM doc_links l JOIN documents d2 ON d2.id=l.document_id WHERE l.org_id=? AND l.target_type='document' AND l.target_id=?", ctx.orgId, d.id) },
    usage: usageSummary(ctx.db, ctx.orgId, d.id, ctx.now(), ctx.settings.usage_window_days), classificationLabel: CLASSIFICATIONS[d.classification], classifications: CLASSIFICATIONS };
}
route('GET', '/documents/:id', { perm: 'read' }, ctx => { const d = seeDoc(ctx, ctx.params.id);
  const today = ctx.now().slice(0, 10); if (!ctx.db.get("SELECT 1 x FROM doc_usage WHERE document_id=? AND user_id=? AND kind='view' AND substr(at,1,10)=?", d.id, ctx.user.id, today)) ctx.db.insert('doc_usage', { org_id: ctx.orgId, document_id: d.id, user_id: ctx.user.id, kind: 'view', at: ctx.now() });
  return docDetail(ctx, d); });
const metaFromQuery = (ctx, q) => { const m = pick(q, ['title', 'process', 'purpose', 'doc_class', 'source_system', 'cadence', 'upstream', 'retention']); if (m.doc_class && !['workpaper', 'evidence', 'procedure', 'policy', 'report', 'import', 'restricted', 'external_deliverable'].includes(m.doc_class)) throw invalid('Unknown document class.');
  if (q.entity_id) m.entity_id = ctx.own('entities', q.entity_id).id; if (q.period_id) m.period_id = ctx.period(q.period_id).id; return m; };
route('POST', '/documents/upload', { perm: 'docs', raw: true }, ctx => ctx.db.tx(() => { const r = registerUpload(ctx, ctx.body, ctx.query.filename, metaFromQuery(ctx, ctx.query)); ctx.audit('document.uploaded', 'document', r.documentId, { filename: ctx.query.filename, sha256: r.sha256 }); ctx.changed('documents', 'findings'); return r; }));
route('POST', '/documents/:id/versions', { perm: 'docs', raw: true }, ctx => ctx.db.tx(() => { const d = seeDoc(ctx, ctx.params.id); if (d.archived) throw invalid('This document is archived.'); const prev = latest(ctx.db, d.id);
  const r = registerUpload(ctx, ctx.body, ctx.query.filename, {}, d.id); if (prev && prev.sha256 === r.sha256) r.notice = 'This file is identical to the previous version.';
  ctx.audit('document.version_added', 'document', d.id, { version: r.version, sha256: r.sha256 }); ctx.changed('documents', 'findings'); return r; }));
route('POST', '/documents/link', { perm: 'docs' }, ctx => { const url = String(ctx.body.url || '').trim(); let u; try { u = new URL(url); } catch { throw invalid('Enter a full link, for example https://contoso.sharepoint.com/...'); } if (u.protocol !== 'https:') throw invalid('Only https links are accepted.');
  const hosts = ctx.settings.approved_link_hosts || []; if (hosts.length && !hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) throw invalid(`Links to ${u.hostname} are not on the approved list (${hosts.join(', ')}).`);
  const id = ctx.db.insert('documents', { org_id: ctx.orgId, title: cleanText(ctx.body.title, 200) || u.hostname, doc_class: 'workpaper', owner_id: ctx.user.id, link_url: u.toString(), purpose: cleanText(ctx.body.purpose, 1000), created_at: ctx.now(), classification_note: hosts.length ? null : 'Link host not verified against an approved list.' }); ctx.changed('documents'); return { id, note: 'Stored as a link. The linked content is not downloaded, hashed or analysed.' }; });
route('PATCH', '/documents/:id', { perm: 'docs' }, ctx => { const d = seeDoc(ctx, ctx.params.id); if (!ctx.can('manage') && d.owner_id !== ctx.user.id && d.owner_id != null) throw forbidden('Only the owner or a close manager can edit this document’s details.');
  const f = pick(ctx.body, ['title', 'purpose', 'process', 'source_system', 'cadence', 'upstream', 'retention', 'owner_id', 'entity_id', 'period_id', 'preparer_id', 'reviewer_id', 'doc_class']); for (const k of ['owner_id', 'preparer_id', 'reviewer_id']) if (f[k]) ctx.own('users', f[k]);
  if (ctx.body.legal_hold !== undefined) { if (!ctx.can('manage')) throw forbidden('Only a close manager can change a legal hold.'); f.legal_hold = ctx.body.legal_hold ? 1 : 0; }
  for (const k of ['title', 'purpose', 'process', 'source_system', 'cadence', 'upstream', 'retention']) if (f[k] != null) f[k] = cleanText(f[k], 1000);
  ctx.db.update('documents', d.id, f); ctx.audit('document.edited', 'document', d.id, f); ctx.changed('documents', 'findings'); return docDetail(ctx, ctx.own('documents', d.id)); });
route('POST', '/documents/:id/links', { perm: 'docs' }, ctx => { const d = seeDoc(ctx, ctx.params.id); const { target_type, target_id, rel } = ctx.body; if (!['task', 'control', 'document', 'report'].includes(target_type) || !['evidence', 'input', 'output', 'procedure', 'supersedes'].includes(rel)) throw invalid('Unknown link type.');
  if (target_type !== 'report') ctx.own(target_type === 'task' ? 'tasks' : target_type === 'control' ? 'controls' : 'documents', target_id); ctx.db.insert('doc_links', { org_id: ctx.orgId, document_id: d.id, target_type, target_id: Number(target_id), rel }); ctx.changed('documents', 'findings'); return docDetail(ctx, d); });
/** What depends on this document. Shown before any archive / retirement decision. */
export function docImpact(ctx, d) {
  const det = docDetail(ctx, d); const controls = det.links.filter(l => l.target_type === 'control'); const blockers = [];
  if (d.legal_hold) blockers.push('A legal hold applies. The document must be kept.');
  if (d.retention && /required|statut|lender|audit|tax|sox|legal/i.test(d.retention)) blockers.push(`Retention category "${d.retention}" requires it to be kept.`);
  if (controls.length) blockers.push(`It is evidence for ${controls.length} control(s): ${controls.map(c => c.label).join('; ')}.`);
  const current = det.evidenceUses.filter(e => !['approved', 'not_applicable'].includes(e.status));
  if (current.length) blockers.push(`It is attached as evidence to ${current.length} task(s) still in progress.`);
  return { links: det.links, evidenceUses: det.evidenceUses, usage: det.usage, blockers, canRetire: blockers.length === 0, note: 'Retiring a document archives it in this app. Source files are never deleted here.' };
}
route('GET', '/documents/:id/impact', { perm: 'read' }, ctx => docImpact(ctx, seeDoc(ctx, ctx.params.id)));
route('POST', '/documents/:id/classify', { perm: 'docs' }, ctx => ctx.db.tx(() => {
  const d = seeDoc(ctx, ctx.params.id); const c = ctx.body.classification; const note = cleanText(ctx.body.note, 1000); if (!CLASSIFICATIONS[c]) throw invalid('Unknown classification.');
  const authorised = ctx.can('doc:classify') || d.owner_id === ctx.user.id;
  if (c === 'confirmed_not_needed') {
    if (!authorised) throw forbidden('Only the document owner or a close manager can confirm a document is no longer needed.'); if (!note || note.trim().length < 10) throw invalid('Record how you confirmed nobody needs it (who you asked, what replaced it).');
    const imp = docImpact(ctx, d); if (!imp.canRetire) throw invalid('This document cannot be confirmed as not needed: ' + imp.blockers.join(' '), { blockers: imp.blockers });
  } else if (['superseded', 'required_retention'].includes(c) && !authorised) throw forbidden('Only the owner or a close manager can set this classification.');
  ctx.db.update('documents', d.id, { classification: c, classification_note: note, classified_by: ctx.user.id, classified_at: ctx.now() }); ctx.audit('document.classified', 'document', d.id, { from: d.classification, to: c, note }); ctx.changed('documents', 'findings'); return docDetail(ctx, ctx.own('documents', d.id));
}));
route('POST', '/documents/:id/archive', { perm: 'doc:classify' }, ctx => ctx.db.tx(() => { const d = seeDoc(ctx, ctx.params.id); const restore = ctx.body.restore === true;
  if (!restore) { if (d.classification !== 'confirmed_not_needed' && d.classification !== 'superseded') throw invalid('Archive only after the owner has confirmed the document is superseded or no longer needed.'); const imp = docImpact(ctx, d); if (!imp.canRetire) throw invalid('Cannot archive: ' + imp.blockers.join(' ')); }
  ctx.db.update('documents', d.id, { archived: restore ? 0 : 1 }); ctx.audit(restore ? 'document.restored' : 'document.archived', 'document', d.id, { title: d.title, note: 'File and versions retained' }); ctx.changed('documents', 'findings'); return { ok: true, archived: !restore }; }));
route('GET', '/documents/:id/compare', { perm: 'read' }, ctx => { const d = seeDoc(ctx, ctx.params.id); const get = n => ctx.db.get('SELECT version, filename, sha256, extracted, extraction_status, at FROM document_versions WHERE document_id=? AND version=?', d.id, ctx.int(n, 'version')); const a = get(ctx.query.a), b = get(ctx.query.b); if (!a || !b) throw notFound('Version not found.');
  if (a.sha256 === b.sha256) return { identical: true, a: pick(a, ['version', 'filename', 'at']), b: pick(b, ['version', 'filename', 'at']) };
  if (!a.extracted || !b.extracted) return { identical: false, comparable: false, reason: 'One or both versions have no extracted text (see extraction status), so only the checksums can be compared.', a: pick(a, ['version', 'filename', 'at', 'sha256']), b: pick(b, ['version', 'filename', 'at', 'sha256']) };
  const la = a.extracted.split('\n'), lb = b.extracted.split('\n'); const sa = new Set(la), sb = new Set(lb);
  return { identical: false, comparable: true, a: pick(a, ['version', 'filename', 'at']), b: pick(b, ['version', 'filename', 'at']), removed: la.filter(l => l.trim() && !sb.has(l)).slice(0, 150), added: lb.filter(l => l.trim() && !sa.has(l)).slice(0, 150), unchanged: la.filter(l => sb.has(l)).length, method: 'Line-by-line comparison of extracted text. Moved rows show as unchanged; reformatted rows show as changed.' }; });
// Short-lived, user-bound download links. The token is checked again against the caller's session when redeemed.
route('GET', '/documents/:id/download-url', { perm: 'read' }, ctx => { const d = seeDoc(ctx, ctx.params.id); const v = ctx.query.version ? ctx.db.get('SELECT id FROM document_versions WHERE document_id=? AND version=?', d.id, ctx.int(ctx.query.version, 'version')) : latest(ctx.db, d.id); if (!v) throw notFound('This document has no stored file.');
  const payload = Buffer.from(JSON.stringify({ v: v.id, u: ctx.user.id, o: ctx.orgId, e: ctx.env, x: Date.now() + 5 * 60000 })).toString('base64url'); return { url: `/api/${ctx.env}/files/download?t=${payload}.${hmac(payload)}`, expiresInSeconds: 300 }; });
route('GET', '/files/download', { perm: 'read' }, ctx => {
  const [payload, sig] = String(ctx.query.t || '').split('.'); if (!payload || !sig || hmac(payload) !== sig) throw forbidden('This download link is not valid.'); let t; try { t = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw forbidden('This download link is not valid.'); }
  if (t.x < Date.now()) throw new HttpError(410, 'LINK_EXPIRED', 'This download link has expired. Open the document and try again.'); if (t.e !== ctx.env || t.o !== ctx.orgId || t.u !== ctx.user.id) throw forbidden('This download link belongs to a different session.');
  const v = ctx.db.get('SELECT v.*, d.org_id, d.doc_class, d.owner_id, d.preparer_id, d.reviewer_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?', t.v); if (!v || v.org_id !== ctx.orgId || !canSeeDoc(ctx.user, v)) throw notFound();
  ctx.db.insert('doc_usage', { org_id: ctx.orgId, document_id: v.document_id, user_id: ctx.user.id, kind: 'download', at: ctx.now() });
  return { __file: getFile(ctx.env, ctx.orgId, v.storage_key), type: 'application/octet-stream', name: v.filename }; // always an attachment; never rendered inline
});
route('GET', '/controls', { perm: 'read' }, ctx => ctx.db.all('SELECT * FROM controls WHERE org_id=? ORDER BY code', ctx.orgId).map(c => ({ ...c, task_keys: J(c.task_keys, []), deficiencies: ctx.db.all('SELECT * FROM deficiencies WHERE org_id=? AND control_id=? ORDER BY id DESC', ctx.orgId, c.id),
  documents: ctx.db.all("SELECT d.id, d.title FROM doc_links l JOIN documents d ON d.id=l.document_id WHERE l.org_id=? AND l.target_type='control' AND l.target_id=?", ctx.orgId, c.id) })));
route('POST', '/controls/:id/deficiencies', { perm: 'review' }, ctx => { const c = ctx.own('controls', ctx.params.id); if (!ctx.body.description?.trim()) throw invalid('Describe the deficiency.');
  const id = ctx.db.insert('deficiencies', { org_id: ctx.orgId, control_id: c.id, period_id: ctx.body.period_id || null, description: cleanText(ctx.body.description, 2000), severity: ['deficiency', 'significant', 'material'].includes(ctx.body.severity) ? ctx.body.severity : 'deficiency', remediation: cleanText(ctx.body.remediation, 2000), owner_id: ctx.body.owner_id || c.owner_id, due_at: ctx.body.due_at || null });
  ctx.audit('control.deficiency_logged', 'control', c.id, { id }); ctx.changed('controls'); return { id }; });
export { broadcast, bad };
