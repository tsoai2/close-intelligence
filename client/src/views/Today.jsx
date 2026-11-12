import { useApp, useQuery } from '../api.js';
import { Card, Q, Stat, Pill, Tone, Icon, Button, Empty, dt, hours, days, setParams, navigate, href, RecordLink, Person, useUsers, useEntities, Kind, Note, A, openRecord } from '../ui.jsx';
import { Verdict } from './Deck.jsx';

export function PageHead({ title, sub, actions }) { return <div className="pagehead"><div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div>{actions && <div className="row gap wrap">{actions}</div>}</div>; }
export function TaskRow({ t, extra }) { const ent = useEntities(); return <li className="list-row"><button type="button" className="rowbtn" onClick={() => setParams({ task: t.id ?? t.taskId })}>
  <span className="row gap"><span className="mono key">{t.key}</span><strong className="grow clamp1">{t.name}</strong>{t.entity_id !== undefined && <span className="chip">{ent.code(t.entity_id)}</span>}</span>
  <span className="row gap small muted"><Pill status={t.status} small />{t.due_at && <span>Due {dt(t.due_at)}</span>}{t.critical && <Tone tone="danger">Critical path</Tone>}{t.needs_rereview ? <Tone tone="danger">Re-review</Tone> : null}{extra}</span></button></li>; }

export function Today() {
  const { me, periodId } = useApp(); const q = useQuery(`/today${periodId ? '?period=' + periodId : ''}`); const users = useUsers(); const first = me.user.name.split(' ')[0];
  if (!me.periods.length) return <><PageHead title={`Welcome, ${first}`} sub="This workspace has no close period yet." /><Empty icon="close" title="Start with guided setup" action={<Button kind="primary" onClick={() => navigate(href('admin', 'setup'))}>Open guided setup</Button>}>Add your entities, calendar and people, choose a checklist template or import your own, then open your first period. It takes a few minutes.</Empty></>;
  const exec = ['executive', 'auditor'].includes(me.user.role); const reviewer = me.user.role === 'reviewer';
  return <Q q={q} skeleton={8}>{d => { const jump = id => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    const tiles = [d.counts.reviews > 0 && <Stat key="r" label="Waiting for my review" value={d.counts.reviews} tone="indigo" onClick={jump('my-reviews')} />, d.counts.tasks > 0 && <Stat key="t" label="My open tasks" value={d.counts.tasks} onClick={jump('my-tasks')} />, d.counts.requests > 0 && <Stat key="q" label="My requests" value={d.counts.requests} onClick={() => navigate(href('close', 'requests'))} />, d.counts.blockers > 0 && <Stat key="b" label="My blockers" value={d.counts.blockers} tone="warn" />].filter(Boolean);
    const mine = <Card key="mine" title="My tasks" id="my-tasks" pad={false}>{d.myTasks.length ? <ul className="list">{d.myTasks.slice(0, 14).map(t => <TaskRow key={t.id} t={t} />)}</ul> : <Empty icon="check" title="No open tasks">Tasks assigned to you as owner, preparer or backup appear here.</Empty>}</Card>;
    const reviews = <Card key="rev" title="My reviews" id="my-reviews" pad={false}>{d.myReviews.length ? <ul className="list">{d.myReviews.slice(0, 25).map(t => <TaskRow key={t.id} t={t} extra={t.submitted_at ? <span>Submitted {dt(t.submitted_at)}</span> : null} />)}</ul> : <Empty icon="eye" title="Nothing to review">Submitted work assigned to you for review appears here.</Empty>}</Card>;
    const personal = d.myTasks.length + d.myReviews.length + d.requests.length + d.blockers.length > 0;
    return <>
    <PageHead title={`Good ${+me.now.slice(11, 13) < 12 ? 'morning' : 'afternoon'}, ${first}`} sub={<>{d.period.name} close · {dt(d.now)} · target {dt(d.period.target_close)}</>} />
    {exec && <ExecSummary pid={d.period.id} />}
    {tiles.length > 0 ? <div className="stats">{tiles}</div> : !exec && <p className="muted calm">Nothing is waiting on you right now.</p>}
    {d.team && !exec && <Card title="Close at a glance" sub="What a close manager needs to know right now" className="glance">
      <div className="glance-grid">
        <div><span className="eyebrow">Projected completion <Kind kind="calculated" /></span><div className={`big ${d.team.projected > d.team.targetClose ? 'text-warn' : 'text-ok'}`}>{dt(d.team.projected)}</div><p className="muted small">Target {dt(d.team.targetClose)}. An estimate from recorded durations and dependencies. <A to={href('map')}>See what drives it</A></p></div>
        <div><span className="eyebrow">Holding the date</span>{d.team.criticalHead ? <><div className="big clamp1"><RecordLink target={{ type: 'task', id: d.team.criticalHead.id }}>{d.team.criticalHead.key} {d.team.criticalHead.name}</RecordLink></div><p className="muted small"><Pill status={d.team.criticalHead.status} small /> {d.team.criticalHead.wait_reason || d.team.criticalHead.driver?.note}</p></> : <p className="muted">No open critical task.</p>}</div>
        <div><span className="eyebrow">Review queues</span>{d.team.reviewQueues.length ? <ul className="mini">{d.team.reviewQueues.slice(0, 4).map(r => <li key={r.userId}><span className="grow">{users.name(r.userId)}</span><strong>{r.count}</strong><span className="muted small">{hours(r.minutes)} est.</span></li>)}</ul> : <p className="muted small">Nothing is waiting for review.</p>}</div>
        <div><span className="eyebrow">Needs an owner or a chase</span><ul className="mini">{d.team.unowned.slice(0, 3).map(t => <li key={t.id}><RecordLink target={{ type: 'task', id: t.id }}>{t.key} {t.name}</RecordLink><Tone tone="warn">No owner</Tone></li>)}{d.team.overdueRequests.slice(0, 3).map(r => <li key={r.id}><RecordLink target={{ type: 'request', id: r.id }}>{r.title}</RecordLink><Tone tone="danger">Overdue</Tone></li>)}{!d.team.unowned.length && !d.team.overdueRequests.length && <li className="muted small">Nothing outstanding.</li>}</ul></div>
      </div></Card>}
    <Card title="Recommended next" sub="Ordered by rules: reviews and work on the critical path first, then overdue and returned items. Not AI.">
      {d.actions.length ? <ol className="actions">{d.actions.map((a, i) => <li key={i}><span className="action-n">{i + 1}</span><div className="grow"><div className="row gap"><span className="mono key">{a.key}</span><strong className="clamp1">{a.name}</strong>{a.critical && <Tone tone="danger">Critical path</Tone>}</div><span className="muted small">{a.why}{a.due_at ? ` · due ${dt(a.due_at)}` : ''}</span></div><Button small kind={i === 0 ? 'primary' : 'default'} onClick={() => (a.target ? openRecord(a.target) : setParams({ task: a.taskId }))}>{a.verb}</Button></li>)}</ol>
        : <Empty icon="check" title="You are clear">Nothing is waiting on you in {d.period.name}.</Empty>}</Card>
    {(personal || !exec) && <div className="grid2">
      {reviewer ? reviews : mine}
      <div className="stack">{reviewer ? mine : reviews}
        <Card title="Requests and handoffs" pad={false}>{d.requests.length ? <ul className="list">{d.requests.slice(0, 8).map(r => <li key={r.id} className="list-row"><button type="button" className="rowbtn" onClick={() => navigate(href('close', 'requests', { request: r.id }))}><strong className="clamp1">{r.title}</strong><span className="row gap small muted"><Pill status={r.status} small /><span>{r.recipient_org || r.recipient_name}</span>{r.due_at && <span>Due {dt(r.due_at)}</span>}</span></button></li>)}</ul> : <Empty icon="send" title="No open requests">Deliverables you asked for, or that were asked of you, appear here.</Empty>}</Card>
        {d.blockers.length > 0 && <Card title="My blockers" pad={false}><ul className="list">{d.blockers.map(t => <TaskRow key={t.id} t={t} extra={<span className="clamp1">{t.wait_reason}</span>} />)}</ul></Card>}</div>
    </div>}
    {me.env === 'demo' && <Note tone="info">You are in the demo: a fictional company with synthetic figures. Use <strong>Demo controls</strong> in the user menu to preview other roles, switch scenario or take the tour.</Note>}
  </>; }}</Q>;
}
export { Person, days, Icon };

/** For people who read the close rather than work it: the answer and five numbers. */
function ExecSummary({ pid }) {
  const q = useQuery(`/periods/${pid}/overview`); const tq = useQuery(`/periods/${pid}/tasks`); const ov = q.data; if (!ov) return null;
  const m = k => ov.metrics.find(x => x.key === k) || { value: 0 }; const c = ov.completion.unweighted; const locked = ov.period.status === 'locked'; const go = k => () => navigate(href('close', 'overview', { metric: k }));
  return <><Verdict ov={ov} tasks={tq.data} />
    <div className="stats stats-five"><Stat label="Tasks approved" value={`${c.total ? Math.round((c.done / c.total) * 100) : 0}%`} sub={`${c.done} of ${c.total}`} onClick={() => navigate(href('close', 'overview'))} /><Stat label={locked ? 'Closed' : 'Projected finish'} value={dt(locked ? ov.timeliness.actual : ov.timeliness.projected, { time: false })} sub={`target ${dt(ov.timeliness.planned, { time: false })}`} tone={!locked && ov.timeliness.projected > ov.period.targetClose ? 'warn' : null} onClick={() => navigate(href('close', 'overview'))} />
      <Stat label="Past due" value={m('overdue').value} tone={m('overdue').value ? 'warn' : null} onClick={go('overdue')} /><Stat label="Awaiting review" value={m('reviews').value} onClick={go('reviews')} /><Stat label="Open exceptions" value={m('exceptions').value} tone={m('exceptions').value ? 'warn' : null} onClick={go('exceptions')} /></div></>;
}
