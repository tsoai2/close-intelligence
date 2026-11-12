// @ts-check
/** @param {string} text @param {{maskNumbers?:boolean}} [o] */
export function shingles(text, o = {}) {
  let t = (text || '').toLowerCase(); if (o.maskNumbers) t = t.replace(/\d[\d,.]*/g, '#');
  const words = t.split(/[^a-z0-9#]+/).filter(Boolean); const set = new Set();
  for (let i = 0; i + 2 < words.length; i++) set.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
  if (!set.size && words.length) set.add(words.join(' '));
  return set;
}
/** Jaccard similarity of two sets, 0..1. @param {Set<string>} a @param {Set<string>} b */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0; let inter = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Strip period tokens (months, years, quarter labels, version suffixes) from a title to find its series stem. @param {string} title */
export function seriesStem(title) {
  return (title || '').toLowerCase().replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\bq[1-4]\b/g, ' ').replace(/\b\d{1,2}[-/]\d{2,4}\b/g, ' ').replace(/\b(v|ver|version)\s*\d+\b/g, ' ').replace(/\b(final|copy|draft)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
