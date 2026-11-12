// @ts-check
/** RFC 4180-style CSV parser with BOM removal and delimiter detection. @param {string} text @returns {string[][]} */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (/** @type {string} */ ch) => first.split(ch).length - 1;
  const delim = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  /** @type {string[][]} */ const rows = []; /** @type {string[]} */ let row = []; let cell = '', inQ = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; } cell += ch; i++; continue; }
    if (ch === '"' && cell === '') { inQ = true; i++; continue; }
    if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
/** Neutralise spreadsheet formula injection: text cells that start with = + - @ tab or CR get a leading apostrophe.
 * Plain numbers (including negatives) are left alone. @param {unknown} v */
export function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + s;
  return s;
}
/** @param {unknown[][]} rows */
export function toCsv(rows) {
  return rows.map(r => r.map(v => { const s = safeCell(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n') + '\r\n';
}
/** Rows -> objects using a header row. Header names are trimmed. @param {string[][]} rows */
export function withHeader(rows) {
  const header = (rows[0] || []).map(h => h.trim());
  return { header, records: rows.slice(1).map((r, i) => ({ __row: i + 2, ...Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])) })) };
}
