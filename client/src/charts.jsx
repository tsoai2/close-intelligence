// Chart kit. Plain SVG and HTML, no libraries. Every chart:
//  - draws only the values it is given (no smoothing, no synthetic points)
//  - animates once when it first scrolls into view, and not at all under reduced motion
//  - has a hover/focus readout and a table twin, so no value is reachable only by pointer
//  - keeps text in text colours; marks carry the series colour
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayLabel = d => (d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : '');
export const S1 = 'var(--s1)', S2 = 'var(--s2)', S3 = 'var(--s3)', REF = 'var(--viz-ref)';

/** Compact money for labels only (exact amounts stay in tooltips and tables). Input is integer minor units. */
export function compactMoney(minor, ccy = 'USD', tight = false) {
  if (minor == null) return '—'; const v = minor / 100, a = Math.abs(v);
  const s = a >= 1e9 ? (a / 1e9).toFixed(tight ? 1 : 2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(tight ? 1 : 2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(tight ? 0 : 1) + 'K' : a.toFixed(0);
  return `${v < 0 ? '−' : ''}${ccy === 'USD' ? '$' : ccy + ' '}${s}`;
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function ticksTo(max, count = 4, integer = false) { const step = integer ? Math.max(1, Math.round(niceStep(max / 5))) : niceStep(max / count) || 1; const out = []; for (let v = 0; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6); return { step, ticks: out, top: Math.max(out[out.length - 1] || 0, max) }; }
function wrapLabel(text, max = 12) { const words = String(text).split(' '); const lines = ['']; for (const w of words) { const cur = lines[lines.length - 1]; if (!cur) lines[lines.length - 1] = w; else if ((cur + ' ' + w).length <= max) lines[lines.length - 1] = cur + ' ' + w; else lines.push(w); } return lines.slice(0, 3); }

export function useSize(ref) {
  const [w, setW] = useState(0);
  useEffect(() => { const el = ref.current; if (!el) return; setW(el.clientWidth); if (typeof ResizeObserver !== 'function') return; const ro = new ResizeObserver(e => setW(Math.round(e[0].contentRect.width))); ro.observe(el); return () => ro.disconnect(); }, [ref]);
  return w;
}
/** True once the element has been on screen. Reduced motion: true immediately, so nothing animates. */
export function useReveal(ref) {
  const [on, setOn] = useState(reduced);
  useEffect(() => { if (on) return; const el = ref.current; if (!el || typeof IntersectionObserver !== 'function') { setOn(true); return; } const io = new IntersectionObserver(e => { if (e.some(x => x.isIntersecting)) { setOn(true); io.disconnect(); } }, { threshold: 0.15 }); io.observe(el); return () => io.disconnect(); }, [ref, on]);
  return on;
}
/** Counts up to the value once. Screen readers and reduced motion get the final value only. */
export function CountUp({ value, format = v => Math.round(v).toLocaleString('en-US'), on = true, ms = 1200 }) {
  const [v, setV] = useState(reduced() ? value : 0);
  useEffect(() => { if (!on) return; if (reduced()) { setV(value); return; } let raf, t0; const tick = t => { t0 ??= t; const k = Math.min(1, (t - t0) / ms); setV(value * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [value, on, ms]);
  return <span className="countup"><span className="sr-only">{format(value)}</span><span aria-hidden="true">{format(v)}</span></span>;
}

const TipCtx = createContext({ show() {}, hide() {} });
const useTip = () => useContext(TipCtx);
/** Tooltip body: value leads, label follows, series keyed by a short stroke. */
export function TipRows({ title, rows }) { return <><div className="tip-title">{title}</div>{rows.filter(Boolean).map(r => <div key={r.label} className="tip-row">{r.color && <i className={`vkey vkey-${r.shape || 'line'}`} style={{ '--k': r.color }} />}<strong>{r.value}</strong><span>{r.label}</span></div>)}</>; }

/** Chart frame: title, legend, chart/table switch, note, and the shared tooltip. */
export function Viz({ title, sub, badge, legend, table, note, className = '', bare, children }) {
  const ref = useRef(null); const on = useReveal(ref); const [asTable, setAsTable] = useState(false); const [tip, setTip] = useState(null);
  const api = useMemo(() => ({
    show(el, content, pt) { const host = ref.current?.getBoundingClientRect(); if (!host) return; const r = el.getBoundingClientRect(); setTip({ x: (pt ? pt.x : r.left + r.width / 2) - host.left, y: (pt ? pt.y : r.top) - host.top, w: host.width, content }); },
    hide() { setTip(null); },
  }), []);
  return <figure ref={ref} className={`viz${bare ? '' : ' hud'}${on ? ' is-on' : ''} ${className}`}>
    <header className="viz-head"><div className="grow"><h3>{title} {badge}</h3>{sub && <p className="muted small">{sub}</p>}</div>
      {table && <button type="button" className="viz-toggle" aria-pressed={asTable} onClick={() => { setAsTable(!asTable); setTip(null); }}>{asTable ? 'Show chart' : 'Show table'}</button>}</header>
    {legend && !asTable && <ul className="viz-legend" aria-label="Legend">{legend.map(l => <li key={l.label}><i className={`vkey vkey-${l.shape || 'rect'}`} style={{ '--k': l.color }} />{l.label}</li>)}</ul>}
    {asTable ? <div className="tablewrap viz-table"><table className="table"><caption className="sr-only">{title}</caption><thead><tr>{table.head.map((h, i) => <th key={h} className={i ? 'num' : ''}>{h}</th>)}</tr></thead><tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j ? <td key={j} className="num">{c}</td> : <th key={j} scope="row">{c}</th>))}</tr>)}</tbody></table></div>
      : <TipCtx.Provider value={api}>{typeof children === 'function' ? children(on) : children}</TipCtx.Provider>}
    {note && <figcaption className="viz-note muted tiny">{note}</figcaption>}
    {tip && !asTable && <div className="viz-tip" role="status" style={{ left: Math.max(96, Math.min(tip.w - 96, tip.x)), top: Math.max(8, tip.y) }}>{tip.content}</div>}
  </figure>;
}

/** Radial gauge: the arc is the share done; the tick marks where the plan says we should be. */
export function Gauge({ value, max, plan, on = true, size = 208, label, caption }) {
  const R = size / 2 - 18, cx = size / 2, cy = size / 2, A0 = 135, SWEEP = 270; const p = max ? Math.min(1, value / max) : 0; const len = 2 * Math.PI * R * (SWEEP / 360);
  const pt = (deg, r) => { const a = (deg * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = () => { const [x0, y0] = pt(A0, R), [x1, y1] = pt(A0 + SWEEP, R); return `M${x0},${y0} A${R},${R} 0 1 1 ${x1},${y1}`; };
  const planP = plan != null && max ? Math.min(1, plan / max) : null;
  return <div className="gauge" style={{ width: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${value} of ${max}${plan != null ? `; due by now ${plan}` : ''}`}>
      {Array.from({ length: 31 }, (_, i) => { const [x0, y0] = pt(A0 + (SWEEP * i) / 30, R + 9), [x1, y1] = pt(A0 + (SWEEP * i) / 30, R + (i % 5 ? 12 : 15)); return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={`g-tick${i / 30 <= p ? ' lit' : ''}`} />; })}
      <path d={arc()} className="g-track" /><path d={arc()} className="g-val" strokeDasharray={len} strokeDashoffset={on ? len * (1 - p) : len} />
      {planP != null && (() => { const [x0, y0] = pt(A0 + SWEEP * planP, R - 11), [x1, y1] = pt(A0 + SWEEP * planP, R + 11); return <line x1={x0} y1={y0} x2={x1} y2={y1} className="g-plan" />; })()}
    </svg>
    <div className="gauge-mid"><div className="hero-num"><CountUp value={p * 100} on={on} format={v => Math.round(v)} /><span className="hero-unit">%</span></div><div className="muted small">{caption}</div></div>
  </div>;
}

/** Burn-up: planned, approved and projected cumulative task counts by day, with a crosshair readout. */
export function Trajectory({ burn, height = 270, on = true }) {
  const ref = useRef(null); const w = useSize(ref); const tip = useTip(); const [hi, setHi] = useState(null);
  const days = burn.days, n = days.length; const m = { l: 34, r: 20, t: 26, b: 30 }; const W = Math.max(300, w || 640), H = height, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const ticks = ticksTo(burn.total).ticks.filter(t => t === burn.total || burn.total - t > burn.total * 0.08); const x = i => m.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2); const y = v => m.t + ph - (v / burn.total) * ph;
  const path = key => { let d = ''; days.forEach((p, i) => { if (p[key] != null) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`; }); return d; };
  const idx = date => (date ? days.findIndex(d => d.date === date) : -1); const iToday = idx(burn.today), iTarget = idx(burn.target);
  const lastActual = days.reduce((a, p, i) => (p.actual != null ? i : a), -1); const lastProj = days.reduce((a, p, i) => (p.projected != null ? i : a), -1);
  const iDone = days.findIndex(p => p.projected != null && p.projected >= burn.total); const iEnd = iDone >= 0 ? iDone : lastProj;
  const actualPath = path('actual'); const area = actualPath && lastActual >= 0 ? `${actualPath}L${x(lastActual).toFixed(1)},${y(0)}L${x(days.findIndex(p => p.actual != null)).toFixed(1)},${y(0)}Z` : '';
  const every = Math.max(1, Math.ceil(64 / (pw / Math.max(1, n - 1)))); const showTick = i => i === n - 1 || (i % every === 0 && n - 1 - i >= every);
  const readout = i => { const p = days[i]; return <TipRows title={`${dayLabel(p.date)} · business day ${p.bd >= 0 ? '+' : ''}${p.bd}`} rows={[p.actual != null && { label: 'approved', value: p.actual, color: S1 }, p.projected != null && i !== lastActual && { label: 'projected', value: p.projected, color: S1, shape: 'dash' }, { label: 'planned', value: p.planned, color: REF }]} />; };
  const point = (i, el) => { setHi(i); tip.show(el, readout(i), { x: el.getBoundingClientRect().left + (x(i) / W) * el.getBoundingClientRect().width, y: el.getBoundingClientRect().top + m.t }); };
  const move = e => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; point(Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / pw) * (n - 1)))), e.currentTarget); };
  const key = e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const cur = hi ?? (iToday >= 0 ? iToday : n - 1); point(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))), e.currentTarget); };
  const clip = 'clip-' + useMemo(() => Math.random().toString(36).slice(2, 8), []);
  return <div ref={ref} className="traj">
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="group" tabIndex={0} aria-label="Approved, projected and planned tasks by day. Use the left and right arrow keys to read each day." onPointerMove={move} onPointerLeave={() => { setHi(null); tip.hide(); }} onKeyDown={key} onBlur={() => { setHi(null); tip.hide(); }}>
      <defs><clipPath id={clip}><rect x={m.l - 6} y={0} width={pw + 12 + m.r} height={H} className="wipe" /></clipPath></defs>
      {ticks.map(t => <g key={t}><line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className="v-grid" /><text x={m.l - 8} y={y(t)} className="v-tick" textAnchor="end" dominantBaseline="central">{t}</text></g>)}
      {!ticks.includes(burn.total) && <g><line x1={m.l} x2={W - m.r} y1={y(burn.total)} y2={y(burn.total)} className="v-axis" /><text x={m.l - 8} y={y(burn.total)} className="v-tick" textAnchor="end" dominantBaseline="central">{burn.total}</text></g>}
      <line x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} className="v-axis" />
      {days.map((p, i) => (showTick(i) ? <text key={p.date} x={x(i)} y={H - 9} className="v-tick" textAnchor="middle">{dayLabel(p.date)}</text> : null))}
      {iTarget >= 0 && <g><line x1={x(iTarget)} x2={x(iTarget)} y1={m.t - 6} y2={y(0)} className="v-mark" /><text x={x(iTarget) + 6} y={m.t - 12} className="v-marklabel" textAnchor={iTarget > n * 0.8 ? 'end' : 'start'} dx={iTarget > n * 0.8 ? -12 : 0}>Target</text></g>}
      {iToday >= 0 && <g><line x1={x(iToday)} x2={x(iToday)} y1={m.t - 6} y2={y(0)} className="v-mark v-now" /><text x={x(iToday) - 6} y={m.t - 12} className="v-marklabel" textAnchor="end">Today</text></g>}
      <g clipPath={`url(#${clip})`}>
        <path d={path('planned')} className="l-ref" />
        {area && <path d={area} className="a-s1" />}
        <path d={path('projected')} className="l-s1 l-dash" /><path d={actualPath} className="l-s1 l-glow" />
      </g>
      {lastActual >= 0 && <g className="pop"><circle cx={x(lastActual)} cy={y(days[lastActual].actual)} r="9" className={`d-halo${burn.today ? ' pulse' : ''}`} /><circle cx={x(lastActual)} cy={y(days[lastActual].actual)} r="5" className="d-s1" />
        <text x={x(lastActual) + (lastActual > n * 0.75 ? -10 : 10)} y={y(days[lastActual].actual) + 16} textAnchor={lastActual > n * 0.75 ? 'end' : 'start'} className="v-label">{days[lastActual].actual} approved</text></g>}
      {iEnd > lastActual && <g className="pop"><circle cx={x(iEnd)} cy={y(days[iEnd].projected)} r="5" className="d-open" /><text x={x(iEnd) - 4} y={y(days[iEnd].projected) + 34} textAnchor="end" className="v-label">{iDone >= 0 ? `Projected finish ${dayLabel(days[iEnd].date)}` : `${days[iEnd].projected} projected`}</text></g>}
      {hi != null && <g><line x1={x(hi)} x2={x(hi)} y1={m.t} y2={y(0)} className="v-cross" />{['planned', 'projected', 'actual'].map(k => (days[hi][k] != null ? <circle key={k} cx={x(hi)} cy={y(days[hi][k])} r="4" className={k === 'planned' ? 'd-ref' : 'd-s1'} /> : null))}</g>}
    </svg>
  </div>;
}

/** One whole split into ordered stages. Counts print inside a block only when they fit. */
export function Pipeline({ stages, on = true }) {
  const ref = useRef(null); const w = useSize(ref) || 600; const tip = useTip(); const total = stages.reduce((a, s) => a + s.count, 0);
  if (!total) return <p className="muted">No tasks in this period yet.</p>;
  return <div ref={ref} className="pipe" role="list" aria-label="Tasks by stage">{stages.filter(s => s.count > 0).map(s => { const share = s.count / total; const fits = share * w >= 34; const text = `${s.label}: ${s.count} of ${total} (${Math.round(share * 100)}%)`;
    return <div key={s.key} role="listitem" tabIndex={0} className={`pipe-seg pipe-${s.key}`} style={{ flexGrow: s.count }} aria-label={text} onPointerEnter={e => tip.show(e.currentTarget, <TipRows title={s.label} rows={[{ label: 'tasks', value: s.count }, { label: 'of all tasks', value: Math.round(share * 100) + '%' }]} />)} onPointerLeave={tip.hide} onFocus={e => tip.show(e.currentTarget, <TipRows title={s.label} rows={[{ label: 'tasks', value: s.count }, { label: 'of all tasks', value: Math.round(share * 100) + '%' }]} />)} onBlur={tip.hide}>{fits ? s.count : ''}</div>; })}</div>;
}

/** Ranked horizontal bars, optionally stacked, with an optional per-row reference tick. */
export function HStack({ rows, series, format = v => v, markerLabel, max }) {
  const tip = useTip(); const top = max ?? Math.max(1, ...rows.map(r => Math.max(r.marker || 0, r.segments.reduce((a, s) => a + (s.value || 0), 0))));
  const sOf = k => series.find(s => s.key === k);
  return <div className="hs">{rows.map((r, i) => { const sum = r.segments.reduce((a, s) => a + (s.value || 0), 0);
    const body = <TipRows title={r.label} rows={[...r.segments.map(s => ({ label: sOf(s.key).label.toLowerCase(), value: format(s.value || 0), color: sOf(s.key).color, shape: 'rect' })), r.marker != null && { label: markerLabel, value: format(r.marker) }, ...(r.extra || [])]} />;
    return <div key={r.label} className="hs-row" style={{ '--i': i }} tabIndex={0} aria-label={`${r.label}: ${r.segments.map(s => `${sOf(s.key).label} ${format(s.value || 0)}`).join(', ')}${r.marker != null ? `, ${markerLabel} ${format(r.marker)}` : ''}`} onPointerEnter={e => tip.show(e.currentTarget.querySelector('.hs-track'), body)} onPointerLeave={tip.hide} onFocus={e => tip.show(e.currentTarget.querySelector('.hs-track'), body)} onBlur={tip.hide}>
      <div className="hs-label"><span className="clamp1">{r.label}</span>{r.sub && <span className="muted tiny clamp1">{r.sub}</span>}</div>
      <div className="hs-track"><div className="hs-fill" style={{ width: (sum / top) * 100 + '%' }}>{r.segments.filter(s => s.value > 0).map(s => <span key={s.key} className="hs-seg" style={{ flexGrow: s.value, background: sOf(s.key).color }} />)}</div>{r.marker != null && <i className="hs-mark" style={{ left: Math.min(100, (r.marker / top) * 100) + '%' }} />}</div>
      <div className="hs-val small">{r.value}</div></div>; })}</div>;
}

const colPath = (x, yTop, w, base) => { const h = base - yTop; const r = Math.min(4, w / 2, Math.max(0, h)); return h <= 0.5 ? '' : `M${x},${base}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${base}Z`; };
const dropPath = (x, yTop, w, yBot) => { const h = yBot - yTop; const r = Math.min(4, w / 2, h / 2); return `M${x},${yTop}H${x + w}V${yBot - r}Q${x + w},${yBot} ${x + w - r},${yBot}H${x + r}Q${x},${yBot} ${x},${yBot - r}Z`; };

/** Columns for a handful of periods, with an optional per-column reference tick (for example a target). */
export function Columns({ data, format = v => v, height = 210, color = S1, refLabel, valueLabel = 'value', tickFormat, integer, max }) {
  const ref = useRef(null); const w = useSize(ref); const tip = useTip(); const n = data.length; const m = { l: 44, r: 10, t: 22, b: 34 }; const W = Math.max(240, w || 480), H = height, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { ticks, top } = ticksTo(max ?? Math.max(1, ...data.map(d => Math.max(d.value || 0, d.ref || 0))), 4, integer); const y = v => m.t + ph - (v / top) * ph; const band = pw / Math.max(1, n); const bw = Math.min(24, band * 0.5); const tf = tickFormat || format;
  return <div ref={ref} className="vz-cols"><svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={data.map(d => `${d.label}: ${d.value == null ? 'no value' : format(d.value)}${d.ref != null ? `, ${refLabel} ${format(d.ref)}` : ''}`).join('; ')}>
    {ticks.map(t => <g key={t}><line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className={t ? 'v-grid' : 'v-axis'} /><text x={m.l - 8} y={y(t)} className="v-tick" textAnchor="end" dominantBaseline="central">{tf(t, true)}</text></g>)}
    {data.map((d, i) => { const cx = m.l + band * i + band / 2; const body = <TipRows title={d.label + (d.flag ? ` · ${d.flag}` : '')} rows={[{ label: valueLabel, value: d.value == null ? 'not yet' : (d.exact ?? format(d.value)), color, shape: 'rect' }, d.ref != null && { label: refLabel.toLowerCase(), value: format(d.ref), color: REF }]} />;
      return <g key={d.label} className="col" style={{ '--i': i }}>
        {d.value != null && <path d={colPath(cx - bw / 2, y(d.value), bw, y(0))} className={`c-bar${d.flag ? ' c-prelim' : ''}`} style={{ fill: color }} />}
        {d.ref != null && <line x1={cx - bw * 0.95} x2={cx + bw * 0.95} y1={y(d.ref)} y2={y(d.ref)} className="c-ref" />}
        <text x={cx} y={(d.value != null ? Math.min(y(d.value), d.ref != null ? y(d.ref) : Infinity) : y(0)) - 7} textAnchor="middle" className={d.value == null ? 'v-tick' : 'v-label'}>{d.value == null ? 'open' : format(d.value, band < 76)}</text>
        <text x={cx} y={H - 16} textAnchor="middle" className="v-tick">{d.label}</text>{d.flag && <text x={cx} y={H - 4} textAnchor="middle" className="v-tick v-faint">{d.flag}</text>}
        <rect x={cx - band / 2} y={m.t} width={band} height={ph} className="hit" tabIndex={0} onPointerEnter={e => tip.show(e.currentTarget, body)} onPointerLeave={tip.hide} onFocus={e => tip.show(e.currentTarget, body)} onBlur={tip.hide} /></g>; })}
  </svg></div>;
}

/** Waterfall from an opening total through signed changes to a closing total. */
export function Waterfall({ steps, format = v => v, exact = v => v, height = 250 }) {
  const ref = useRef(null); const w = useSize(ref); const tip = useTip(); const n = steps.length; const m = { l: 10, r: 10, t: 24, b: 46 }; const W = Math.max(260, w || 520), H = height, pw = W - m.l - m.r, ph = H - m.t - m.b;
  let run = 0; const bars = steps.map(s => { if (s.kind === 'total') { run = s.amount; return { ...s, lo: Math.min(0, s.amount), hi: Math.max(0, s.amount), end: s.amount }; } const start = run; run += s.amount; return { ...s, lo: Math.min(start, run), hi: Math.max(start, run), end: run }; });
  const top = Math.max(1, ...bars.map(b => b.hi)), bottom = Math.min(0, ...bars.map(b => b.lo)); const y = v => m.t + ph - ((v - bottom) / (top - bottom)) * ph; const band = pw / n; const bw = Math.min(24, band * 0.5); const chars = Math.max(8, Math.floor(band / 6.4));
  return <div ref={ref} className="wf"><svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={steps.map(s => `${s.label}: ${exact(s.amount)}`).join('; ')}>
    <line x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} className="v-axis" />
    {bars.map((b, i) => { const cx = m.l + band * i + band / 2; const yt = y(b.hi), yb = Math.max(y(b.lo), yt + 2); const isTotal = b.kind === 'total'; const cls = isTotal ? 'w-total' : b.amount < 0 ? 'w-down' : 'w-up';
      const body = <TipRows title={b.label} rows={[{ label: isTotal ? 'total' : b.amount < 0 ? 'deducted' : 'added', value: exact(b.amount), color: isTotal ? S2 : b.amount < 0 ? S3 : S1, shape: 'rect' }, !isTotal && { label: 'running total', value: exact(b.end) }]} />;
      return <g key={b.label} className="col" style={{ '--i': i }}>
        {i < n - 1 && <line x1={cx + bw / 2 + 2} x2={cx + band - bw / 2 - 2} y1={y(b.end)} y2={y(b.end)} className="w-link" />}
        <path d={isTotal ? colPath(cx - bw / 2, yt, bw, yb) : b.amount < 0 ? dropPath(cx - bw / 2, yt, bw, yb) : colPath(cx - bw / 2, yt, bw, yb)} className={`c-bar ${cls}`} />
        <text x={cx} y={yt - 7} textAnchor="middle" className="v-label">{format(b.amount, band < 76)}</text>
        <text x={cx} y={H - 30} textAnchor="middle" className="v-tick">{wrapLabel(b.label, chars).map((l, j) => <tspan key={j} x={cx} dy={j ? 12 : 0}>{l}</tspan>)}</text>
        <rect x={cx - band / 2} y={m.t} width={band} height={ph} className="hit" tabIndex={0} onPointerEnter={e => tip.show(e.currentTarget, body)} onPointerLeave={tip.hide} onFocus={e => tip.show(e.currentTarget, body)} onBlur={tip.hide} /></g>; })}
  </svg></div>;
}
