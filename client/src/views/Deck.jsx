// Dashboard panels built from the chart kit. Each panel names its source (recorded or rules-based)
// and offers the same numbers as a table.
import { useRef } from 'react';
import { useQuery, setPref } from '../api.js';
import { Kind, Skeleton, Empty, Button, Card, dt, hours, money, href, navigate, setParams, STATUS } from '../ui.jsx';
import { useReveal, Viz, Gauge, Trajectory, Pipeline, HStack, Columns, Waterfall, compactMoney, dayLabel, S1, S2, S3, REF } from '../charts.jsx';

const PIPE_ORDER = ['approved', 'in_review', 'in_progress', 'ready', 'not_started', 'attention'];
const pipeColor = k => ({ approved: 'var(--o5)', in_review: 'var(--o4)', in_progress: 'var(--o3)', ready: 'var(--o2)', not_started: 'var(--o1)', attention: 'var(--attn)' }[k]);
const burnTable = b => ({ head: ['Day', 'Business day', 'Planned', 'Approved', 'Projected'], rows: b.days.map(d => [dayLabel(d.date), (d.bd >= 0 ? '+' : '') + d.bd, d.planned, d.actual ?? '—', d.projected ?? '—']) });
const burnLegend = b => [{ label: 'Approved', color: 'var(--line1)', shape: 'line' }, b.today && { label: 'Projected', color: 'var(--line1)', shape: 'dash' }, { label: 'Planned, by end of day', color: REF, shape: 'line' }].filter(Boolean);
const burnNote = b => (b.today ? `${b.basis.projected}${b.rereview ? ` ${b.rereview} task(s) awaiting re-review are assumed to be re-approved without further delay.` : ''}${b.unprojected ? ` ${b.unprojected} open task(s) have no projected finish and are not in the projected line.` : ''}` : 'Planned from due dates; approved from recorded approval times.');

const NO_FILTER = { q: '', status: '', process: '', owner: '', risk: '', flag: '' };
/** Opens the task list filtered to what a chart mark represents. */
export function goTasks(filter) { setPref('tasks-f', { ...NO_FILTER, ...filter }); setPref('tasks-page', 0); navigate(href('close', 'tasks')); }
const STAGE_FILTER = { approved: 'approved', in_review: 'submitted', in_progress: 'in_progress', ready: 'ready', not_started: 'not_started', attention: 'attention' };
const dayDiff = (a, b) => Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 864e5);
const days = n => `${n} day${n === 1 ? '' : 's'}`;

/** One sentence that says where the close stands and what is holding it, with one action. */
export function Verdict({ ov, tasks }) {
  const t = ov.timeliness; const target = ov.period.targetClose; const locked = ov.period.status === 'locked'; const byId = Object.fromEntries((tasks || []).map(x => [x.id, x]));
  const head = locked ? null : ov.criticalPath.map(id => byId[id]).find(x => x && x.status !== 'approved');
  let tone = 'ok', text;
  if (locked) { const d = t.actual && target ? dayDiff(t.actual, target) : null; tone = d > 0 ? 'warn' : 'ok'; text = d == null ? `Closed ${dt(t.actual)}.` : d > 0 ? `Closed ${dt(t.actual, { time: false })}, ${days(d)} after the target.` : d < 0 ? `Closed ${dt(t.actual, { time: false })}, ${days(-d)} ahead of the target.` : `Closed on the target date, ${dt(t.actual, { time: false })}.`; }
  else if (!t.projected) { tone = 'neutral'; text = 'No finish date can be projected yet: tasks need duration estimates and dependencies.'; }
  else { const d = dayDiff(t.projected, target); const late = t.projected > target; tone = late ? 'warn' : 'ok';
    text = late ? (d > 0 ? `${days(d)[0].toUpperCase() + days(d).slice(1)} behind target: projected to finish ${dt(t.projected, { time: false })} against ${dt(target, { time: false })}.` : `Behind target by a few hours: projected to finish ${dt(t.projected)} against ${dt(target)}.`) : d < 0 ? `On track: projected to finish ${dt(t.projected, { time: false })}, ${days(-d)} ahead of the target.` : `On track: projected to finish on the target date, ${dt(target, { time: false })}.`; }
  const why = head ? `${tone === 'warn' ? 'Held by' : 'Next on the critical path:'} ${head.key} ${head.name}${head.wait_reason ? ` — ${head.wait_reason.replace(/\.$/, '')}` : ['waiting', 'blocked', 'changes_requested'].includes(head.status) ? ` (${STATUS[head.status][0].toLowerCase()})` : ''}.` : null;
  return <section className={`verdict verdict-${tone}`} aria-label="Where the close stands"><div className="grow"><p className="verdict-line">{text}</p>{why && <p className="verdict-why">{why}</p>}
    {!locked && t.projected && <p className="muted small">A rules-based estimate from recorded durations and dependencies, not a commitment.{t.projectedResource && t.projectedResource > t.projected ? ` With one task at a time per person it becomes ${dt(t.projectedResource, { time: false })}.` : ''}</p>}</div>
    {head && <Button kind="primary" onClick={() => setParams({ task: head.id })}>Open {head.key}</Button>}</section>;
}

const ATTENTION = ['overdue', 'blocked', 'reviews', 'rereview', 'evidence', 'highrisk', 'unassigned', 'requests', 'exceptions'];
/** Only what needs someone's attention; checks that are clear are counted, not listed. */
export function NeedsAttention({ ov }) {
  const m = ATTENTION.map(k => ov.metrics.find(x => x.key === k)).filter(Boolean); const open = m.filter(x => x.value > 0); const clear = m.length - open.length;
  return <Card title="Needs attention" sub={open.length ? 'Select a line to see how it is counted and the records behind it' : null} className="attention">
    {open.length ? <ul className="attn">{open.map(x => <li key={x.key}><button type="button" className="attn-row" onClick={() => setParams({ metric: x.key })}><strong>{x.value}</strong><span className="grow">{x.label}{x.denominator != null && <span className="muted small"> of {x.denominator}</span>}</span><span className="attn-go" aria-hidden="true">›</span></button></li>)}</ul> : <p className="muted">Nothing needs attention right now.</p>}
    {clear > 0 && open.length > 0 && <p className="muted tiny">{clear} other check{clear === 1 ? ' is' : 's are'} clear.</p>}</Card>;
}

/** Hero: how far along, and whether the line is going to land on the target. */
function Hero({ d, ov }) {
  const b = d.burn; const done = ov.completion.unweighted; const t = ov.timeliness; const locked = ov.period.status === 'locked'; const late = !locked && t.projected && t.projected > ov.period.targetClose;
  const planNow = locked ? null : t.dueByNow.total; const ref = useRef(null); const on = useReveal(ref);
  return <section ref={ref} className={`hud deck-hero${on ? ' is-on' : ''}`} aria-label="Close trajectory"><span className="scan" aria-hidden="true" />
    <div className="hero-left">
      <Gauge value={done.done} max={done.total} plan={planNow} on={on} label="Tasks approved" caption={`${done.done} of ${done.total} approved`} />
      <dl className="hero-facts">
        {planNow != null && <div><dt><i className="vkey vkey-tick" style={{ '--k': 'var(--text)' }} />Due by now</dt><dd>{planNow} of {done.total}</dd></div>}
        <div><dt>Risk-weighted</dt><dd>{ov.completion.weighted.done} of {ov.completion.weighted.total} points</dd></div>
      </dl>
    </div>
    <Viz bare className="hero-right" title="Close trajectory" sub="Tasks approved day by day, against the plan" badge={<Kind kind={b.today ? 'calculated' : 'recorded'} />} legend={burnLegend(b)} table={burnTable(b)} note={burnNote(b)}>{on => <Trajectory burn={b} on={on} height={280} />}</Viz>
  </section>;
}

function Stages({ d }) {
  const stages = PIPE_ORDER.map(k => d.pipeline.find(s => s.key === k)).filter(Boolean); const total = stages.reduce((a, s) => a + s.count, 0);
  return <Viz title="Where the work stands" sub="Every task counted once, by stage" badge={<Kind kind="recorded" />} legend={stages.filter(s => s.count).map(s => ({ label: s.label, color: pipeColor(s.key) }))}
    table={{ head: ['Stage', 'Tasks', 'Share'], rows: stages.map(s => [s.label, s.count, total ? Math.round((s.count / total) * 100) + '%' : '—']) }}>{on => <Pipeline stages={stages} on={on} onSelect={st => goTasks({ status: STAGE_FILTER[st.key] })} />}</Viz>;
}

function Processes({ d }) {
  const rows = d.processes.slice().sort((a, b) => b.late - a.late || b.open - a.open || a.process.localeCompare(b.process)); const open = rows.filter(p => p.open > 0); const list = open.length ? open : rows; const complete = rows.length - open.length;
  return <Viz title="Progress by process" sub={open.length ? `Each bar is that process's own tasks. Past due first.${complete ? ` ${complete} fully approved process${complete === 1 ? ' is' : 'es are'} not listed.` : ''}` : 'Every process is fully approved'} badge={<Kind kind="recorded" />} legend={[{ label: 'Approved', color: S1 }, { label: 'In review', color: S2 }]}
    table={{ head: ['Process', 'Tasks', 'Approved', 'In review', 'Open and past due'], rows: rows.map(p => [p.process, p.total, p.approved, p.inReview, p.late]) }}>
    <HStack className="hs-two" rows={list.map(p => ({ label: p.process, segments: [{ key: 'approved', value: p.approved }, { key: 'review', value: p.inReview }], max: p.total, aria: `${p.total} tasks, ${p.late} past due`, extra: [{ label: 'tasks in all', value: p.total }, { label: 'open and past due', value: p.late }],
      value: <>{p.late > 0 && <span className="late-n">{p.late} past due</span>}<span>{p.approved} / {p.total}</span></>, onSelect: () => goTasks({ process: p.process, status: 'open' }) }))} series={[{ key: 'approved', label: 'Approved', color: S1 }, { key: 'review', label: 'In review', color: S2 }]} />
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

/** The Close overview deck: the answer first, then the evidence. */
export function CloseDeck({ pid, ov, tasks }) {
  const q = useQuery(`/periods/${pid}/dashboard`);
  if (q.error) return null; if (!q.data) return <Skeleton lines={8} />; const d = q.data; if (!d.burn) return null;
  return <div className="deck">
    <Verdict ov={ov} tasks={tasks} />
    <Hero d={d} ov={ov} />
    <NeedsAttention ov={ov} />
    <Stages d={d} />
    <Processes d={d} />
  </div>;
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
    <HStack rows={rows.map(w => ({ label: w.name, sub: w.title, segments: [{ key: 'prep', value: w.prepMinutes }, { key: 'rev', value: w.reviewMinutes }], marker: w.capacityMin, value: hours(w.prepMinutes + w.reviewMinutes), onSelect: () => goTasks({ owner: String(w.userId), status: 'open' }), extra: w.missingEstimates ? [{ label: 'task(s) without an estimate', value: w.missingEstimates }] : [] }))} series={[{ key: 'prep', label: 'Preparation remaining', color: S1 }, { key: 'rev', label: 'Review queued', color: S2 }]} format={hours} markerLabel="capacity per day" />
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

