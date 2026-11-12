// Dashboard panels built from the chart kit. Each panel names its source (recorded or rules-based)
// and offers the same numbers as a table.
import { useQuery } from '../api.js';
import { Kind, Skeleton, Empty, A, dt, hours, money, href } from '../ui.jsx';
import { Viz, Gauge, Trajectory, Pipeline, HStack, Columns, Waterfall, compactMoney, dayLabel, S1, S2, S3, REF } from '../charts.jsx';

const PIPE_ORDER = ['approved', 'in_review', 'in_progress', 'ready', 'not_started', 'attention'];
const pipeColor = k => ({ approved: 'var(--o5)', in_review: 'var(--o4)', in_progress: 'var(--o3)', ready: 'var(--o2)', not_started: 'var(--o1)', attention: 'var(--attn)' }[k]);
const burnTable = b => ({ head: ['Day', 'Business day', 'Planned', 'Approved', 'Projected'], rows: b.days.map(d => [dayLabel(d.date), (d.bd >= 0 ? '+' : '') + d.bd, d.planned, d.actual ?? '—', d.projected ?? '—']) });
const burnLegend = b => [{ label: 'Approved', color: 'var(--line1)', shape: 'line' }, b.today && { label: 'Projected', color: 'var(--line1)', shape: 'dash' }, { label: 'Planned, by end of day', color: REF, shape: 'line' }].filter(Boolean);
const burnNote = b => (b.today ? `${b.basis.projected}${b.rereview ? ` ${b.rereview} task(s) awaiting re-review are assumed to be re-approved without further delay.` : ''}${b.unprojected ? ` ${b.unprojected} open task(s) have no projected finish and are not in the projected line.` : ''}` : 'Planned from due dates; approved from recorded approval times.');

/** Hero: how far along, and whether the line is going to land on the target. */
function Hero({ d, ov }) {
  const b = d.burn; const done = ov.completion.unweighted; const t = ov.timeliness; const locked = ov.period.status === 'locked'; const late = !locked && t.projected && t.projected > ov.period.targetClose;
  const planNow = locked ? null : t.dueByNow.total;
  return <section className="hud deck-hero" aria-label="Close trajectory"><span className="scan" aria-hidden="true" />
    <div className="hero-left">
      <Gauge value={done.done} max={done.total} plan={planNow} label="Tasks approved" caption={`${done.done} of ${done.total} approved`} />
      <dl className="hero-facts">
        {planNow != null && <div><dt><i className="vkey vkey-tick" style={{ '--k': 'var(--text)' }} />Due by now</dt><dd>{planNow} of {done.total}</dd></div>}
        <div><dt>Risk-weighted</dt><dd>{ov.completion.weighted.done} of {ov.completion.weighted.total} points</dd></div>
        <div><dt>{locked ? 'Closed' : 'Projected finish'}</dt><dd className={late ? 'text-warn' : ''}>{dt(locked ? t.actual : t.projected)}</dd></div>
        <div><dt>Target</dt><dd>{dt(t.planned)}</dd></div>
      </dl>
    </div>
    <Viz bare className="hero-right" title="Close trajectory" sub="Tasks approved day by day, against the plan" badge={<Kind kind={b.today ? 'calculated' : 'recorded'} />} legend={burnLegend(b)} table={burnTable(b)} note={burnNote(b)}>{on => <Trajectory burn={b} on={on} height={280} />}</Viz>
  </section>;
}

function Stages({ d }) {
  const stages = PIPE_ORDER.map(k => d.pipeline.find(s => s.key === k)).filter(Boolean); const total = stages.reduce((a, s) => a + s.count, 0);
  return <Viz title="Where the work stands" sub="Every task counted once, by stage" badge={<Kind kind="recorded" />} legend={stages.filter(s => s.count).map(s => ({ label: s.label, color: pipeColor(s.key) }))}
    table={{ head: ['Stage', 'Tasks', 'Share'], rows: stages.map(s => [s.label, s.count, total ? Math.round((s.count / total) * 100) + '%' : '—']) }}>{on => <Pipeline stages={stages} on={on} />}</Viz>;
}

function Processes({ d }) {
  const rows = d.processes; const shown = rows.filter(p => p.open > 0).slice(0, 10); const list = shown.length ? shown : rows.slice(0, 10); const complete = rows.filter(p => p.open === 0).length;
  return <Viz title="Progress by process" sub={shown.length ? 'Processes with open work, most remaining first' : 'All processes'} badge={<Kind kind="recorded" />} legend={[{ label: 'Approved', color: S1 }, { label: 'In review', color: S2 }, { label: 'Total tasks', color: 'var(--text)', shape: 'tick' }]}
    table={{ head: ['Process', 'Tasks', 'Approved', 'In review', 'Open and past due'], rows: rows.map(p => [p.process, p.total, p.approved, p.inReview, p.late]) }}
    note={complete && shown.length ? `${complete} other process(es) are fully approved. Switch to the table for all ${rows.length}.` : null}>
    <HStack rows={list.map(p => ({ label: p.process, sub: p.late ? `${p.late} past due` : null, segments: [{ key: 'approved', value: p.approved }, { key: 'review', value: p.inReview }], marker: p.total, value: `${p.approved} / ${p.total}` }))} series={[{ key: 'approved', label: 'Approved', color: S1 }, { key: 'review', label: 'In review', color: S2 }]} markerLabel="total tasks" />
  </Viz>;
}

export function IncomeBridge({ f, preliminary }) {
  if (!f.available) return <Viz title="From revenue to net income" sub={f.reason}><Empty title="No trial balance yet">Import a trial balance to see this chart.</Empty></Viz>;
  const ccy = f.currency; const exact = v => money(v, ccy);
  return <Viz title="From revenue to net income" sub={`${f.period}, consolidated in ${ccy}${preliminary ? '. Preliminary: the period is still open.' : ''}`} badge={<Kind kind="calculated" />} legend={[{ label: 'Total', color: S2 }, { label: 'Deduction', color: S3 }, f.waterfall.some(s => s.kind !== 'total' && s.amount > 0) && { label: 'Addition', color: S1 }].filter(Boolean)}
    table={{ head: ['Line', `Amount (${ccy})`], rows: f.waterfall.map(s => [s.label, money(s.amount)]) }} note={f.complete ? f.basis : `Incomplete: ${f.basis}`}>
    <Waterfall steps={f.waterfall} format={(v, tight) => compactMoney(v, ccy, tight)} exact={exact} height={300} /></Viz>;
}

export function ResultTrend({ f, openId }) {
  if (!f.trend?.length || f.trend.length < 2) return null; const ccy = f.currency || 'USD';
  const col = key => f.trend.map(t => ({ label: t.name, value: Math.max(0, t[key]), exact: money(t[key], ccy), flag: t.periodId === openId ? 'preliminary' : null }));
  const neg = f.trend.some(t => t.netIncome < 0);
  return <div className="grid2">
    <Viz title="Net revenue by period" sub={`Consolidated, ${ccy}`} badge={<Kind kind="calculated" />} table={{ head: ['Period', `Net revenue (${ccy})`], rows: f.trend.map(t => [t.name, money(t.revenue)]) }}><Columns data={col('revenue')} format={(v, tight) => compactMoney(v, ccy, tight)} valueLabel="net revenue" height={200} /></Viz>
    <Viz title="Net income by period" sub={`Consolidated, ${ccy}. Its own scale; compare shape, not height, with revenue.`} badge={<Kind kind="calculated" />} table={{ head: ['Period', `Net income (${ccy})`], rows: f.trend.map(t => [t.name, money(t.netIncome)]) }} note={neg ? 'A period with a loss is drawn at zero; the exact amount is in the table.' : null}><Columns data={col('netIncome')} format={v => compactMoney(v, ccy)} color={S2} valueLabel="net income" height={200} /></Viz>
  </div>;
}

/** The Close overview deck. */
export function CloseDeck({ pid, ov }) {
  const q = useQuery(`/periods/${pid}/dashboard`);
  if (q.error) return null; if (!q.data) return <Skeleton lines={8} />; const d = q.data; if (!d.burn) return null;
  return <div className="deck">
    <Hero d={d} ov={ov} />
    <Stages d={d} />
    <div className="grid2"><Processes d={d} /><IncomeBridge f={d.financial} preliminary={ov.period.status !== 'locked'} /></div>
  </div>;
}

/** Compact trajectory for the Today screen. */
export function TodayTrajectory({ pid }) {
  const q = useQuery(`/periods/${pid}/dashboard`); const b = q.data?.burn; if (!b) return null; const done = b.days.reduce((a, d) => (d.actual != null ? d.actual : a), 0);
  return <Viz bare className="today-traj" title="Trajectory" sub={<>{done} of {b.total} tasks approved. <A to={href('close', 'overview')}>Open the full dashboard</A></>} badge={<Kind kind={b.today ? 'calculated' : 'recorded'} />} legend={burnLegend(b)} table={burnTable(b)}>{on => <Trajectory burn={b} on={on} height={210} />}</Viz>;
}

export function StatementCharts({ pid, open }) {
  const q = useQuery(`/periods/${pid}/dashboard`); const f = q.data?.financial; if (!f) return null;
  return <div className="deck"><IncomeBridge f={f} preliminary={open} />{f.available && <ResultTrend f={f} openId={open ? pid : null} />}</div>;
}

export function WorkloadChart({ d }) {
  const rows = d.workload.slice().sort((a, b) => b.prepMinutes + b.reviewMinutes - a.prepMinutes - a.reviewMinutes).filter(w => w.prepMinutes + w.reviewMinutes > 0 || w.openTasks > 0);
  if (!rows.length) return <Viz title="Workload by person" sub={d.workloadNote}><Empty icon="users" title="No open workload">Assign tasks with estimates to see the load on each person.</Empty></Viz>;
  return <Viz title="Workload by person" sub={d.workloadNote} badge={<Kind kind="calculated" />} legend={[{ label: 'Preparation remaining', color: S1 }, { label: 'Review queued', color: S2 }, { label: 'One day of recorded capacity', color: 'var(--text)', shape: 'tick' }]}
    table={{ head: ['Person', 'Preparation remaining', 'Review queued', 'Tasks in review queue', 'Capacity per day', 'Without an estimate'], rows: rows.map(w => [w.name, hours(w.prepMinutes), hours(w.reviewMinutes), w.reviewQueue, hours(w.capacityMin), w.missingEstimates]) }}>
    <HStack rows={rows.map(w => ({ label: w.name, sub: w.title, segments: [{ key: 'prep', value: w.prepMinutes }, { key: 'rev', value: w.reviewMinutes }], marker: w.capacityMin, value: hours(w.prepMinutes + w.reviewMinutes), extra: w.missingEstimates ? [{ label: 'task(s) without an estimate', value: w.missingEstimates }] : [] }))} series={[{ key: 'prep', label: 'Preparation remaining', color: S1 }, { key: 'rev', label: 'Review queued', color: S2 }]} format={hours} markerLabel="capacity per day" />
  </Viz>;
}

export function TimingChart({ d }) {
  const rows = d.timing.filter(p => p.measured > 0).map(p => ({ ...p, work: Math.max(0, p.elapsedMin - p.waitingMin - p.reviewMin) })).sort((a, b) => b.elapsedMin - a.elapsedMin).slice(0, 12); if (!rows.length) return null;
  return <Viz title="Where the time went, by process" sub="Elapsed working time from recorded start to approval, summed over measured tasks" badge={<Kind kind="recorded" />} legend={[{ label: 'Preparation and other', color: S1 }, rows.some(p => p.waitingMin > 0) && { label: 'Waiting', color: S3 }, { label: 'In review', color: S2 }].filter(Boolean)}
    table={{ head: ['Process', 'Tasks', 'Measured', 'Elapsed', 'Waiting', 'In review', 'Estimated effort', 'Review rounds', 'Reopened'], rows: d.timing.map(p => [p.process, p.tasks, p.measured, p.measured ? hours(p.elapsedMin) : 'no events', p.measured ? hours(p.waitingMin) : '', p.measured ? hours(p.reviewMin) : '', hours(p.estimateMin), p.rounds, p.reopened]) }}
    note={`${d.timingCoverage.note} Event coverage: ${d.timingCoverage.tasksWithStartAndApproval} of ${d.timingCoverage.tasks} tasks have both a recorded start and approval. Measured active effort: not collected.`}>
    <HStack rows={rows.map(p => ({ label: p.process, sub: `${p.measured} of ${p.tasks} tasks measured`, segments: [{ key: 'work', value: p.work }, { key: 'wait', value: p.waitingMin }, { key: 'rev', value: p.reviewMin }], value: hours(p.elapsedMin) }))} series={[{ key: 'work', label: 'Preparation and other', color: S1 }, { key: 'wait', label: 'Waiting', color: S3 }, { key: 'rev', label: 'In review', color: S2 }]} format={hours} />
  </Viz>;
}

export function DurationChart({ d, title = 'Close duration by period' }) {
  const h = d.history; if (!h.length) return null;
  return <Viz title={title} sub="Business days from period end to lock" badge={<Kind kind="recorded" />} legend={[{ label: 'Actual', color: S1 }, { label: 'Target', color: REF, shape: 'line' }]}
    table={{ head: ['Period', 'Target', 'Actual', 'Tasks', 'Approved on time', 'Review rounds', 'Late inputs', 'Comparable scope'], rows: h.map(x => [x.name, 'BD +' + x.targetBd, x.actualBd != null ? 'BD +' + x.actualBd : 'open', x.tasks, `${x.onTime} / ${x.completed}`, x.reviewRounds, x.lateRequests, x.comparable ? 'Yes' : 'Scope differs']) }} note={d.comparabilityRule}>
    <Columns data={h.map(x => ({ label: x.name, value: x.actualBd, ref: x.targetBd }))} format={v => 'BD +' + v} tickFormat={v => v} refLabel="Target" valueLabel="actual close" height={220} integer /></Viz>;
}

export function OnTimeChart({ d }) {
  const h = d.history.filter(x => x.completed > 0); if (!h.length) return null;
  return <Viz title="Approved by the due time" sub="Share of approved tasks that were approved on or before their due time" badge={<Kind kind="recorded" />}
    table={{ head: ['Period', 'Approved on time', 'Approved', 'Share'], rows: h.map(x => [x.name, x.onTime, x.completed, Math.round((x.onTime / x.completed) * 100) + '%']) }} note="An open period counts only the tasks approved so far.">
    <Columns data={h.map(x => ({ label: x.name, value: (x.onTime / x.completed) * 100, exact: `${x.onTime} of ${x.completed}`, flag: x.status === 'locked' ? null : 'in progress' }))} format={v => Math.round(v) + '%'} color={S2} valueLabel="approved on time" height={220} max={100} /></Viz>;
}

