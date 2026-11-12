// @ts-check
// Decimal-safe money helpers. Amounts are integers in minor units (cents). No binary floats are
// used for parsing, summing, translating or rounding.

/** Parse a user/ERP amount string into minor units. Accepts 1,234.56  (1,234.56)  -12.5  1234.
 * Returns null for blank input; throws on anything that is not a plain decimal number.
 * @param {unknown} input @param {number} [scale] @returns {number|null} */
export function toMinor(input, scale = 2) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (s === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£\s,]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new Error(`Not a decimal amount: "${input}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`More than ${scale} decimal places: "${input}"`);
  const v = BigInt(whole || '0') * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Amount too large: "${input}"`);
  return Number(neg ? -v : v);
}

/** Format minor units as a plain decimal string, e.g. -123456 -> "-1234.56". @param {number} minor @param {number} [scale] */
export function fromMinor(minor, scale = 2) {
  const neg = minor < 0; const a = BigInt(Math.abs(minor)); const d = 10n ** BigInt(scale);
  const frac = scale ? '.' + String(a % d).padStart(scale, '0') : '';
  return (neg ? '-' : '') + String(a / d) + frac;
}

/** Sum integers, asserting each is a safe integer. @param {Array<number|null|undefined>} xs */
export function sum(xs) {
  let t = 0n;
  for (const x of xs) { if (x == null) continue; if (!Number.isSafeInteger(x)) throw new Error('Non-integer amount in sum'); t += BigInt(x); }
  return Number(t);
}

/** Divide two BigInts with rounding. @param {bigint} n @param {bigint} d @param {'half-up'|'half-even'} mode */
function divRound(n, d, mode) {
  const neg = (n < 0n) !== (d < 0n); const an = n < 0n ? -n : n; const ad = d < 0n ? -d : d;
  let q = an / ad; const r = an % ad; const twice = r * 2n;
  if (twice > ad || (twice === ad && (mode === 'half-up' || q % 2n === 1n))) q += 1n;
  return neg ? -q : q;
}

/** Translate minor units by an exchange rate given as a decimal string (up to 8 dp).
 * @param {number} minor @param {string} rate @param {'half-up'|'half-even'} [mode] */
export function translate(minor, rate, mode = 'half-up') {
  if (!/^\d+(\.\d{1,8})?$/.test(String(rate))) throw new Error(`Invalid exchange rate "${rate}"`);
  const [w, f = ''] = String(rate).split('.');
  const scaled = BigInt(w) * 100000000n + BigInt((f + '00000000').slice(0, 8));
  return Number(divRound(BigInt(minor) * scaled, 100000000n, mode));
}

/** Percentage change as a string with one decimal, or null when the base is zero/missing
 * (never a fake 0% or 100%). @param {number|null} current @param {number|null} base */
export function pctChange(current, base) {
  if (current == null || base == null || base === 0) return null;
  const bp = divRound(BigInt(current - base) * 1000n, BigInt(Math.abs(base)), 'half-up');
  const neg = bp < 0n; const a = neg ? -bp : bp;
  return (neg ? '-' : '') + String(a / 10n) + '.' + String(a % 10n);
}

/** Variance threshold test: flagged when |delta| >= abs threshold OR |pct| >= pct threshold.
 * @param {number|null} current @param {number|null} base @param {{abs:number, pct:number}} th */
export function exceeds(current, base, th) {
  if (current == null || base == null) return false;
  const d = Math.abs(current - base);
  if (th.abs > 0 && d >= th.abs) return true;
  // pct is in percent (10 = 10%); compare in basis points with integers only
  if (th.pct > 0 && base !== 0 && BigInt(d) * 10000n >= BigInt(Math.round(th.pct * 100)) * BigInt(Math.abs(base))) return true;
  return false;
}
