// Minimal, dependency-free readers/writers for the formats the app supports: ZIP, XLSX, DOCX, PDF, PNG.
// Readers are deliberately conservative and report what they could not analyse.
import zlib from 'node:zlib';

const MAX_ENTRIES = 2000, MAX_UNZIPPED = 60 * 1024 * 1024;
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP container');
  const n = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  if (n > MAX_ENTRIES) throw new Error('Archive has too many entries');
  const files = new Map(); let total = 0;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nl);
    total += usize; if (total > MAX_UNZIPPED) throw new Error('Archive expands beyond the allowed size');
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28); const start = lho + 30 + lnl + lel;
    const raw = buf.subarray(start, start + csize);
    files.set(name, { method, get data() { return method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }); } });
    off += 46 + nl + el + cl;
  }
  return files;
}
export function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'); const comp = zlib.deflateRawSync(data); const nameB = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, comp); central.push(ch, nameB); offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const xmlUn = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const colName = i => { let s = ''; i++; while (i > 0) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

/** Write an .xlsx. sheets: [{name, rows:[[cell]]}] where cell is string | number | {f:'SUM(A1:A2)', v?:number} | null. */
export function writeXlsx(sheets) {
  const sheetXml = rows => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.map((row, r) => `<row r="${r + 1}">` + row.map((c, i) => {
    const ref = colName(i) + (r + 1), st = r === 0 ? ' s="1"' : '';
    if (c === null || c === undefined || c === '') return '';
    if (typeof c === 'number') return `<c r="${ref}"${st}><v>${c}</v></c>`;
    if (typeof c === 'object') return `<c r="${ref}"${st}><f>${xmlEsc(c.f)}</f>${c.v != null ? `<v>${c.v}</v>` : ''}</c>`;
    let s = String(c); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // formula-injection guard for text cells
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
  }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ];
  return zip(entries);
}
/** Read an .xlsx into sheets of string cells, noting anything that limits analysis. */
export function readXlsx(buf) {
  const files = unzip(buf); const get = n => (files.has(n) ? files.get(n).data.toString('utf8') : null); const notes = [];
  const wb = get('xl/workbook.xml'); if (!wb) throw new Error('Not an Excel workbook (xl/workbook.xml missing)');
  const rels = get('xl/_rels/workbook.xml.rels') || ''; const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]); if (id && tg) relMap[id[1]] = tg[1]; }
  const shared = []; const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUn(x[1])).join(''));
  if ([...files.keys()].some(k => k.startsWith('xl/externalLinks/'))) notes.push('Workbook links to external workbooks; linked sources were not followed, so lineage is incomplete.');
  if (files.has('xl/vbaProject.bin')) notes.push('Workbook contains macros (VBA); macros were not executed or analysed.');
  let formulas = 0; const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUn((/name="([^"]*)"/.exec(m[0]) || [])[1] || 'Sheet'); const rid = (/r:id="([^"]+)"/.exec(m[0]) || [])[1];
    let target = relMap[rid] || ''; target = target.startsWith('/') ? target.slice(1) : 'xl/' + target; const xml = get(target); if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (/r="([A-Z]+)\d+"/.exec(cm[1]) || [])[1]; const type = (/t="([^"]+)"/.exec(cm[1]) || [])[1]; const inner = cm[2] || '';
        if (/<f[\s>]/.test(inner)) formulas++;
        let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (type === 's') v = shared[+v] ?? ''; else if (type === 'inlineStr') v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUn(x[1])).join(''); else if (v != null) v = xmlUn(v);
        const idx = ref ? colIndex(ref) : row.length; while (row.length < idx) row.push(''); row[idx] = v ?? '';
      }
      rows.push(row);
    }
    sheets.push({ name, rows });
  }
  if (formulas) notes.push(`${formulas} formula cell(s) found; values shown are the results last saved by Excel. Formula logic was not traced.`);
  return { sheets, notes };
}
export function readDocx(buf) {
  const files = unzip(buf); const doc = files.get('word/document.xml'); if (!doc) throw new Error('Not a Word document (word/document.xml missing)');
  const xml = doc.data.toString('utf8');
  return [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(p => [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(t => xmlUn(t[1])).join('')).filter(Boolean).join('\n');
}
export function writeDocx(paragraphs) {
  const body = paragraphs.map(p => { const h = p.startsWith('# '); return `<w:p>${h ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r>${h ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEsc(h ? p.slice(2) : p)}</w:t></w:r></w:p>`; }).join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
  ]);
}
/** Tiny greyscale PNG (used for a synthetic "scanned" demo document). */
export function writePng(w, h, pixel) {
  const raw = Buffer.alloc((w + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = pixel(x, y); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- PDF ----------
const WIDTHS = { ' ': 278, i: 222, j: 222, l: 222, t: 278, f: 278, r: 333, I: 278, '.': 278, ',': 278, ':': 278, ';': 278, '-': 333, '(': 333, ')': 333, m: 833, w: 722, M: 833, W: 944 };
const textWidth = (s, size, mono) => (mono ? s.length * 0.6 * size : [...s].reduce((a, ch) => a + (WIDTHS[ch] ?? (/[A-Z0-9]/.test(ch) ? 667 : 556)), 0) / 1000 * size);
const pdfStr = s => '(' + [...String(s)].map(ch => { const c = ch.charCodeAt(0); if (ch === '(' || ch === ')' || ch === '\\') return '\\' + ch; if (ch === '—' || ch === '–') return '-'; if (ch === '→') return '->'; if (ch === '’' || ch === '‘') return "'"; if (ch === '“' || ch === '”') return '"'; if (ch === '•') return '\\267'; return c < 32 || c > 255 ? '?' : c > 126 ? '\\' + c.toString(8).padStart(3, '0') : ch; }).join('') + ')';
/** Small text-and-table PDF writer using the built-in Helvetica/Courier fonts (Latin-1 only). */
export class PdfDoc {
  constructor({ title = '', footer = '' } = {}) { this.pages = []; this.title = title; this.footer = footer; this.W = 612; this.H = 792; this.m = 54; this.newPage(); }
  newPage() { this.cur = []; this.pages.push(this.cur); this.y = this.H - this.m; }
  need(h) { if (this.y - h < this.m + 24) this.newPage(); }
  line(str, { size = 10, bold = false, mono = false, color = [0.1, 0.12, 0.16], indent = 0 } = {}) {
    this.need(size * 1.45); this.y -= size * 1.45;
    this.cur.push(`BT /${mono ? 'F3' : bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg ${this.m + indent} ${this.y.toFixed(1)} Td ${pdfStr(str)} Tj ET`);
  }
  text(str, opts = {}) {
    const size = opts.size || 10, max = this.W - 2 * this.m - (opts.indent || 0);
    for (const para of String(str ?? '').split('\n')) { let cur = ''; for (const word of para.split(/\s+/)) { const next = cur ? cur + ' ' + word : word; if (textWidth(next, size, opts.mono) > max && cur) { this.line(cur, opts); cur = word; } else cur = next; } this.line(cur, opts); }
  }
  heading(str, level = 1) { this.y -= level === 1 ? 10 : 6; this.text(str, { size: level === 1 ? 16 : 12, bold: true, color: [0.05, 0.25, 0.32] }); if (level === 1) this.rule(); }
  rule() { this.y -= 4; this.cur.push(`0.75 0.8 0.84 RG 0.6 w ${this.m} ${this.y.toFixed(1)} m ${this.W - this.m} ${this.y.toFixed(1)} l S`); this.y -= 2; }
  gap(h = 8) { this.y -= h; }
  /** rows of cells; widths in characters; numeric columns (align 'r') are right-aligned. Monospace keeps columns aligned. */
  table(rows, cols) {
    const fmt = row => cols.map((c, i) => { let s = String(row[i] ?? ''); if (s.length > c.w) s = s.slice(0, c.w - 1) + '~'; return c.align === 'r' ? s.padStart(c.w) : s.padEnd(c.w); }).join(' ');
    rows.forEach((row, i) => { this.line(fmt(row), { size: 8, mono: true, bold: false, color: i === 0 ? [0.05, 0.25, 0.32] : [0.1, 0.12, 0.16] }); if (i === 0) this.rule(); });
  }
  build() {
    const objs = []; const add = s => { objs.push(s); return objs.length; };
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'), f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1 + this.pages.length * 2; const kids = [];
    this.pages.forEach((ops, i) => {
      const foot = `BT /F1 8 Tf 0.45 0.5 0.55 rg ${this.m} 30 Td ${pdfStr(`${this.footer}   Page ${i + 1} of ${this.pages.length}`)} Tj ET`;
      const stream = zlib.deflateSync(Buffer.from(ops.join('\n') + '\n' + foot, 'latin1'));
      const c = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]));
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${c} 0 R >>`));
    });
    add(`<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
    const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`); const info = add(`<< /Title ${pdfStr(this.title)} /Producer (CLOSE INTELLIGENCE) >>`);
    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offs = []; let pos = parts[0].length;
    objs.forEach((o, i) => { offs.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n')]); parts.push(b); pos += b.length; });
    parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    return Buffer.concat(parts);
  }
}
/** Basic PDF text extraction: Flate or plain content streams with simple-font text operators.
 * Returns one string per content stream (treated as a page). PDFs that use compressed object streams,
 * CID fonts or image-only pages come back empty and are reported as not extracted. */
export function readPdfText(buf) {
  const s = buf.toString('latin1'); const pages = []; const re = /<<([^]*?)>>\s*stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const dict = m[1]; const start = m.index + m[0].length; const end = s.indexOf('endstream', start); if (end < 0) break;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XRef|\/Type\s*\/ObjStm|\/FontFile/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) { try { data = zlib.inflateSync(data, { maxOutputLength: 20 * 1024 * 1024 }); } catch { try { data = zlib.inflateSync(data.subarray(0, data.length - 1)); } catch { continue; } } } else if (/\/Filter/.test(dict)) continue;
    const c = data.toString('latin1'); if (!/\bBT\b/.test(c)) continue;
    let out = ''; const tok = /\((?:\\.|[^\\)])*\)|\[(?:\((?:\\.|[^\\)])*\)|[^\]])*\]\s*TJ|\bT\*|\bTd\b|\bTD\b|\bET\b|\bTj\b|'/g; let t; let pending = '';
    const un = x => x.slice(1, -1).replace(/\\(\d{1,3})|\\(.)/g, (_, o, ch) => (o ? String.fromCharCode(parseInt(o, 8)) : ch === 'n' ? '\n' : ch === 'r' ? '' : ch === 't' ? '\t' : ch));
    while ((t = tok.exec(c))) {
      const v = t[0];
      if (v[0] === '(') pending = un(v);
      else if (v[0] === '[') out += [...v.matchAll(/\((?:\\.|[^\\)])*\)/g)].map(x => un(x[0])).join('');
      else if (v === 'Tj' || v === "'") { out += pending; pending = ''; }
      else if (v === 'ET' || v === 'T*' || v === 'Td' || v === 'TD') { if (out && !out.endsWith('\n')) out += '\n'; }
    }
    if (out.trim()) pages.push(out.trim());
  }
  return pages;
}
