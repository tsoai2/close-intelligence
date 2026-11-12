import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, setApp, boot, switchEnv, signOut, useQuery, useSave, saveStore, api, request, net, prefetch, loadMe, toast, usePulse } from './api.js';
import { Icon, IconButton, Button, Modal, Drawer, Toasts, useRoute, navigate, href, A, openRecord, setParams, Select, Field, Note, Skeleton, dt, Avatar, useDebounced, can, Pill } from './ui.jsx';
import { Today } from './views/Today.jsx';
import { Close } from './views/Close.jsx';
import { TaskDrawer } from './views/TaskDrawer.jsx';
import { ProcessMap } from './views/ProcessMap.jsx';
import { Documents, DocDrawer } from './views/Documents.jsx';
import { Insights } from './views/Insights.jsx';
import { Reports } from './views/Reports.jsx';
import { Admin } from './views/Admin.jsx';
import { Assistant, Feedback, Portal } from './views/Panels.jsx';

const NAV = [['today', 'Today', 'today', '/today'], ['close', 'Close', 'close', null], ['map', 'Process Map', 'map', null], ['documents', 'Documents', 'docs', '/documents'], ['insights', 'Insights', 'insights', null], ['reports', 'Reports', 'reports', null]];
const ADMIN = [['setup', 'Guided setup'], ['team', 'Team and roles'], ['templates', 'Templates and periods'], ['policies', 'Policies and thresholds'], ['calendar', 'Calendars'], ['integrations', 'Integrations'], ['ai', 'AI Connection'], ['audit', 'Audit trail']];

function EnvSwitch() {
  const { env, booting } = useApp();
  return <div className={`envswitch env-${env}`} role="group" aria-label="Environment">
    {['demo', 'live'].map(e => <button key={e} type="button" className={env === e ? 'active' : ''} aria-pressed={env === e} disabled={booting && env !== e} onClick={() => { if (e !== env) { navigate(`/${e}/today`); switchEnv(e); } }}>{e === 'demo' ? 'Demo' : 'Live'}</button>)}
  </div>;
}
function SaveIndicator() { const s = useSave(); useEffect(() => { if (s.status === 'saved') { const t = setTimeout(() => saveStore.set(c => (c.status === 'saved' ? { status: 'idle', message: '' } : c)), 2500); return () => clearTimeout(t); } }, [s]);
  if (s.status === 'idle') return <span className="savestate" aria-live="polite" />; return <span className={`savestate save-${s.status}`} role="status" aria-live="polite"><span className="save-dot" aria-hidden="true" />{s.message}</span>; }
function Notifications({ onClose }) { const q = useQuery('/notifications'); useEffect(() => { const t = setTimeout(() => api.post('/notifications/read', {}).then(loadMe).catch(() => {}), 1200); return () => clearTimeout(t); }, []);
  return <Drawer open onClose={onClose} title="Notifications" sub="In-app only. Nothing is emailed.">{!q.data ? <Skeleton /> : q.data.length === 0 ? <p className="muted">Nothing yet. You will be told here when work is assigned, released, returned or needs re-review.</p> :
    <ul className="list">{q.data.map(n => <li key={n.id} className={n.read ? 'list-row' : 'list-row unread'}><button type="button" className="rowbtn" onClick={() => { onClose(); if (n.link) openRecord(n.link); }}><strong>{n.title}</strong>{n.body && <span className="muted small clamp">{n.body}</span>}<span className="muted tiny">{dt(n.at)}</span></button></li>)}</ul>}</Drawer>; }
function Palette({ onClose }) {
  const { me, periodId } = useApp(); const [q, setQ] = useState(''); const dq = useDebounced(q, 180); const res = useQuery(dq.trim().length >= 2 ? `/search?q=${encodeURIComponent(dq.trim())}${periodId ? '&period=' + periodId : ''}` : null); const [i, setI] = useState(0);
  const commands = useMemo(() => [...NAV.map(n => ({ title: `Go to ${n[1]}`, sub: 'Navigate', run: () => navigate(href(n[0])) })), ...['overview', 'tasks', 'timeline', 'reconciliations', 'journals', 'financials', 'requests', 'completion'].map(s => ({ title: `Close → ${s[0].toUpperCase() + s.slice(1)}`, sub: 'Navigate', run: () => navigate(href('close', s)) })),
    ...ADMIN.map(a => ({ title: a[1], sub: 'Settings', run: () => navigate(href('admin', a[0])) })), { title: 'Open the assistant', sub: 'Command', run: () => setApp({ assistant: true }) }, { title: 'Send feedback', sub: 'Command', run: () => setParams({ feedback: 1 }) }, { title: 'Toggle light / dark theme', sub: 'Command', run: toggleTheme }], [me]);
  const items = q.trim().length < 2 ? commands.slice(0, 9) : [...(res.data?.results || []).map(r => ({ title: r.title, sub: r.sub, run: () => openRecord(r) })), ...commands.filter(c => c.title.toLowerCase().includes(q.toLowerCase()))];
  useEffect(() => setI(0), [q, res.data]);
  return <Modal open onClose={onClose} title="Search and commands"><input autoFocus className="input input-lg" placeholder="Search tasks, documents, requests, people… or type a command" aria-label="Search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(items.length - 1, x + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); } if (e.key === 'Enter' && items[i]) { e.preventDefault(); onClose(); items[i].run(); } }} />
    <ul className="palette" role="listbox" aria-label="Results">{items.map((it, k) => <li key={k} role="option" aria-selected={k === i}><button type="button" className={k === i ? 'palette-item active' : 'palette-item'} onMouseEnter={() => setI(k)} onClick={() => { onClose(); it.run(); }}><span>{it.title}</span><span className="muted small">{it.sub}</span></button></li>)}
      {q.trim().length >= 2 && res.loading && <li className="muted pad">Searching…</li>}{q.trim().length >= 2 && res.data && !items.length && <li className="muted pad">No matches. Search covers records you are allowed to see.</li>}</ul><p className="muted tiny">↑ ↓ to move · Enter to open · Esc to close</p></Modal>;
}
export function toggleTheme() { const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem('ci-theme', next); } catch { /* preference only */ } }
function DemoControls({ onClose }) {
  const { me, auth } = useApp(); const [busy, setBusy] = useState(null); const personas = auth?.demoPersonas || [];
  const as = async id => { setBusy('p' + id); try { await request('POST', '/session/preview', { userId: id }); location.assign('/demo/today'); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(null); };
  const reset = async sc => { setBusy(sc); try { await request('POST', '/reset', { scenario: sc }); location.assign('/demo/today'); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(null); };
  return <Drawer open onClose={onClose} title="Demo controls" sub="Everything here affects the demo environment only.">
    <h4>Scenario</h4><p className="muted small">Choosing a scenario erases demo changes and reloads the fictional company in that state.</p>
    <div className="stack">{Object.entries(me.demoScenarios).map(([k, s]) => <button key={k} type="button" className={`choice${me.org.demoScenario === k ? ' active' : ''}`} disabled={!!busy} onClick={() => reset(k)}><strong>{s.label}{me.org.demoScenario === k ? ' · current' : ''}</strong><span className="muted small">{s.description}</span>{busy === k && <span className="spinner" />}</button>)}</div>
    <h4>Preview a role</h4><p className="muted small">See what each role can see and do. A preview session exists only in the demo database.</p>
    <div className="stack">{personas.map(p => <button key={p.id} type="button" className={`choice choice-row${me.user.id === p.id ? ' active' : ''}`} disabled={!!busy} onClick={() => as(p.id)}><Avatar name={p.name} /><span className="grow"><strong>{p.name}</strong><span className="muted small">{p.title} · {p.roleLabel}</span></span>{busy === 'p' + p.id && <span className="spinner" />}</button>)}</div>
    <h4>Guided tour</h4><Button icon="play" onClick={() => { onClose(); setParams({ tour: 1 }); }}>Start the tour</Button>
  </Drawer>;
}
const TOUR = [['Readiness at a glance', 'Close → Overview separates timeliness from quality. Every number opens its calculation and the records behind it.', 'close/overview'], ['Find the bottleneck', 'Process Map highlights the critical path. The pulsing node is where the projected date is being held.', 'map'], ['Resolve a handoff', 'Close → Requests shows what other teams and third parties owe. Receiving and accepting a deliverable releases the waiting task.', 'close/requests'], ['Version-bound review', 'Close → Reconciliations shows an approval that no longer matches its source data and needs re-review.', 'close/reconciliations'], ['Evidence-based findings', 'Insights lists rules-based findings with their evidence, confidence and control implications.', 'insights'], ['Your own data', 'Switch to Live in the header to set up your company. Nothing from Demo is carried over.', 'today']];
function Tour() { const { params } = useRoute(); const step = +params.tour - 1; if (!(step >= 0) || !TOUR[step]) return null; const [t, text, to] = TOUR[step]; const go = n => { if (!TOUR[n]) return setParams({ tour: null }); navigate(href(...TOUR[n][2].split('/')) + '?tour=' + (n + 1)); };
  return <div className="tour" role="dialog" aria-label="Guided tour"><div className="tour-step">Step {step + 1} of {TOUR.length}</div><h4>{t}</h4><p>{text}</p><div className="row gap"><Button small onClick={() => setParams({ tour: null })}>End tour</Button><span className="grow" />{step > 0 && <Button small onClick={() => go(step - 1)}>Back</Button>}<Button small kind="primary" onClick={() => go(step + 1)}>{step === TOUR.length - 1 ? 'Finish' : 'Next'}</Button></div><span className="sr-only">{to}</span></div>; }

function ChangePassword({ onClose }) {
  const [f, setF] = useState({ current: '', next: '', again: '' }); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const save = async () => { if (f.next !== f.again) { setErr('The two new passwords do not match.'); return; } setBusy(true); setErr(null); try { await api.post('/me/password', { current: f.current, next: f.next }); toast('Password changed. Other devices were signed out.'); onClose(); } catch (x) { setErr(x.message); } setBusy(false); };
  return <Modal open onClose={onClose} title="Change password" footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Change password</Button></>}>
    <div className="form"><Field label="Current password" wide>{id => <input id={id} className="input" type="password" autoComplete="current-password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })} />}</Field>
      <Field label="New password" wide hint="At least 10 characters with a letter and a number.">{id => <input id={id} className="input" type="password" autoComplete="new-password" value={f.next} onChange={e => setF({ ...f, next: e.target.value })} />}</Field>
      <Field label="New password again" wide>{id => <input id={id} className="input" type="password" autoComplete="new-password" value={f.again} onChange={e => setF({ ...f, again: e.target.value })} />}</Field></div>
    {err && <Note tone="danger">{err}</Note>}</Modal>;
}
function Header({ onMenu }) {
  const { me, env, periodId, entityId, assistant } = useApp(); const [open, setOpen] = useState(null); const route = useRoute(); const pulse = usePulse();
  useEffect(() => { const k = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen('palette'); } if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName)) { e.preventDefault(); setOpen('palette'); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const period = me.periods.find(p => p.id === periodId);
  return <header className="header glass">
    <button type="button" className="iconbtn only-mobile" aria-label="Menu" onClick={onMenu}><Icon name="menu" /></button>
    <A to={href('today')} className="brand" aria-label="CLOSE INTELLIGENCE home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span className="brand-text">CLOSE <b>INTELLIGENCE</b></span></A>
    <EnvSwitch />
    <div className="scope" aria-label="Current scope"><span className="scope-org" title={me.org.name}>{me.org.name}</span>
      {me.entities.length > 0 && <Select label="Entity" value={entityId} onChange={v => setApp({ entityId: v === 'all' ? 'all' : +v })} options={[{ value: 'all', label: 'All entities' }, ...me.entities.map(e => ({ value: e.id, label: e.code }))]} />}
      {me.periods.length > 0 && <Select label="Period" value={periodId} onChange={v => setApp({ periodId: +v })} options={me.periods.map(p => ({ value: p.id, label: `${p.name}${p.status === 'locked' ? ' · locked' : p.status === 'reopened' ? ' · reopened' : ''}` }))} />}
      {period && <span className={`period-flag ${period.status}`}>{period.status === 'locked' ? <Icon name="lock" size={13} /> : null}</span>}</div>
    <span className="grow" /><SaveIndicator />{me.clockPinned && <span className="clock" title="The demo clock is fixed so the scenario stays consistent."><Icon name="clock" size={13} /> Demo clock {dt(me.now)}</span>}
    <button type="button" className="searchbtn" onClick={() => setOpen('palette')} aria-label="Search and commands"><Icon name="search" size={15} /><span>Search</span><kbd>Ctrl K</kbd></button>
    <IconButton icon="bell" label={`Notifications${me.unread ? ` (${me.unread} unread)` : ''}`} badge={me.unread || null} onClick={() => setOpen('notes')} />
    <IconButton icon="spark" label="Assistant" aria-pressed={assistant} onClick={() => setApp({ assistant: !assistant })} />
    <IconButton icon="sun" label="Switch light or dark theme" onClick={toggleTheme} />
    <div className="menuwrap"><button type="button" className="userbtn" aria-haspopup="menu" aria-expanded={open === 'user'} onClick={() => setOpen(open === 'user' ? null : 'user')}><Avatar name={me.user.name} /><span className="only-wide">{me.user.name.split(' ')[0]}</span><Icon name="down" size={14} /></button>
      {open === 'user' && <div className="menu" role="menu" onMouseLeave={() => setOpen(null)}><div className="menu-head"><strong>{me.user.name}</strong><span className="muted small">{me.user.roleLabel}{me.preview ? ' · demo preview' : ''}</span></div>
        {ADMIN.filter(a => a[0] !== 'audit' || can('manage') || me.user.role === 'auditor').map(a => <button key={a[0]} role="menuitem" type="button" onClick={() => { setOpen(null); navigate(href('admin', a[0])); }}>{a[1]}</button>)}<hr />
        {env === 'demo' ? <button role="menuitem" type="button" onClick={() => setOpen('demo')}>Demo controls: roles, scenarios, reset</button> : <><button role="menuitem" type="button" onClick={() => setOpen('password')}>Change password</button><button role="menuitem" type="button" onClick={() => { setOpen(null); signOut(); }}>Sign out</button></>}</div>}</div>
    {open === 'palette' && <Palette onClose={() => setOpen(null)} />}{open === 'notes' && <Notifications onClose={() => setOpen(null)} />}{open === 'password' && <ChangePassword onClose={() => setOpen(null)} />}{open === 'demo' && <DemoControls onClose={() => setOpen(null)} />}
    <span className="sr-only" aria-live="polite">{pulse ? 'Updated by a colleague' : ''}</span><span className="sr-only">{route.section}</span>
  </header>;
}
function Nav({ open, onClose }) { const { section } = useRoute(); const { periodId } = useApp();
  return <nav className={`nav${open ? ' open' : ''}`} aria-label="Primary">{NAV.map(([id, label, icon, pre]) => <A key={id} to={href(id)} className={section === id ? 'nav-item active' : 'nav-item'} aria-current={section === id ? 'page' : undefined} onClick={onClose} onMouseEnter={() => pre && prefetch(pre)}><Icon name={icon} size={20} /><span>{label}</span></A>)}
    <span className="grow" /><A to={href('admin', 'setup')} className={section === 'admin' ? 'nav-item active' : 'nav-item'} onClick={onClose}><Icon name="gear" size={20} /><span>Settings</span></A><span className="sr-only">{periodId}</span></nav>; }

function LiveAuth() {
  const { auth } = useApp(); const { params } = useRoute(); const invite = params.invite; const [f, setF] = useState({ orgName: '', name: '', email: '', password: '' }); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const mode = invite ? 'invite' : auth?.bootstrapped ? 'login' : 'bootstrap';
  const submit = async e => { e.preventDefault(); setBusy(true); setErr(null); try { if (mode === 'login') await request('POST', '/auth/login', { email: f.email, password: f.password }); else if (mode === 'invite') await request('POST', '/auth/accept-invite', { token: invite, name: f.name, password: f.password }); else await request('POST', '/auth/bootstrap', { ...f, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); navigate('/live/' + (mode === 'bootstrap' ? 'admin/setup' : 'today'), { replace: true }); await boot('live'); } catch (e2) { if (!e2.stale) setErr(e2.message); } setBusy(false); };
  const set = k => e => setF({ ...f, [k]: e.target.value });
  if (auth?.error) return <div className="authwrap"><div className="authcard"><h1>Live is not reachable</h1><p className="muted">{auth.error}</p><Button onClick={() => boot('live')}>Try again</Button></div></div>;
  return <div className="authwrap"><form className="authcard" onSubmit={submit}><div className="brand-mark big" aria-hidden="true"><i /><i /><i /></div>
    <h1>{mode === 'login' ? 'Sign in to Live' : mode === 'invite' ? 'Accept your invitation' : 'Set up your Live workspace'}</h1>
    <p className="muted">{mode === 'bootstrap' ? 'Live starts empty. Nothing from the demo is copied here. You will be the first administrator.' : mode === 'invite' ? 'Choose a password to finish creating your account.' : 'Your organization’s real close data. Demo sessions cannot sign in here.'}</p>
    {mode === 'bootstrap' && <Field label="Company name">{id => <input id={id} className="input" required value={f.orgName} onChange={set('orgName')} autoComplete="organization" />}</Field>}
    {mode !== 'login' && <Field label="Your name">{id => <input id={id} className="input" required value={f.name} onChange={set('name')} autoComplete="name" />}</Field>}
    {mode !== 'invite' && <Field label="Work email">{id => <input id={id} className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="username" />}</Field>}
    <Field label="Password" hint={mode !== 'login' ? 'At least 10 characters with a letter and a number.' : null}>{id => <input id={id} className="input" type="password" required value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}</Field>
    {err && <Note tone="danger">{err}</Note>}<Button kind="primary" busy={busy} type="submit" onClick={undefined}>{mode === 'login' ? 'Sign in' : mode === 'invite' ? 'Create account' : 'Create workspace'}</Button>
    <p className="muted tiny">Single sign-on: {auth?.sso?.note || 'not configured.'}</p></form></div>;
}
function ConflictDialog() { const { conflict } = useApp(); if (!conflict) return null; const close = () => setApp({ conflict: null });
  return <Modal open onClose={close} title="Someone else changed this" footer={<><Button onClick={() => { conflict.onReload?.(); close(); }}>Use their version</Button><Button kind="primary" onClick={() => { conflict.onRetry?.(); close(); }}>Apply my change on top</Button></>}>
    <p>{conflict.message}</p><p className="muted small">Your change has not been saved. Review the current values below, then choose.</p><dl className="kv">{(conflict.fields || []).map(([k, theirs, mine]) => <div key={k}><dt>{k}</dt><dd><span className="muted">Theirs:</span> {String(theirs ?? '—')} <span className="muted"> · Yours:</span> {String(mine ?? '—')}</dd></div>)}</dl></Modal>; }

function Shell() {
  const { me, env, booting } = useApp(); const route = useRoute(); const [menu, setMenu] = useState(false); const main = useRef(null);
  useEffect(() => { if (route.env !== env) switchEnv(route.env); }, [route.env]);
  useEffect(() => { document.title = `${{ today: 'Today', close: 'Close', map: 'Process Map', documents: 'Documents', insights: 'Insights', reports: 'Reports', admin: 'Settings' }[route.section] || 'CLOSE INTELLIGENCE'} · CLOSE INTELLIGENCE (${env === 'demo' ? 'Demo' : 'Live'})`; }, [route.section, env]);
  if (booting && !me) return <div className="boot"><div className="brand-mark big spin" aria-hidden="true"><i /><i /><i /></div><p className="muted">Opening {env === 'demo' ? 'Demo' : 'Live'}…</p></div>;
  if (!me) return <><div className="header glass header-min"><span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span className="brand-text">CLOSE <b>INTELLIGENCE</b></span></span><EnvSwitch /><span className="grow" /><IconButton icon="sun" label="Switch theme" onClick={toggleTheme} /></div><LiveAuth /><Feedback /><Toasts /></>;
  if (me.user.role === 'external') return <><div className="header glass header-min"><span className="brand"><span className="brand-text">CLOSE <b>INTELLIGENCE</b></span></span><span className={`envbadge env-${env}`}>{env}</span><span className="grow" /><Button small onClick={signOut}>Sign out</Button></div><Portal /><Feedback /><Toasts /></>;
  const View = { today: Today, close: Close, map: ProcessMap, documents: Documents, insights: Insights, reports: Reports, admin: Admin }[route.section] || Today;
  return <div className={`app env-${env}`}><a className="skip" href="#main">Skip to content</a><Header onMenu={() => setMenu(m => !m)} /><Nav open={menu} onClose={() => setMenu(false)} />
    <main id="main" ref={main} className="main" tabIndex={-1}><div key={route.section} className="page"><View /></div></main>
    <Assistant /><TaskDrawer /><DocDrawer /><Feedback /><ConflictDialog /><Tour /><Toasts />
    </div>;
}
try { const t = localStorage.getItem('ci-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* preference only */ }
const first = location.pathname.split('/')[1]; const startEnv = first === 'live' ? 'live' : 'demo'; if (!['demo', 'live'].includes(first)) history.replaceState(null, '', '/demo/today');
createRoot(document.getElementById('root')).render(<Shell />); boot(startEnv);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {}); // no offline cache of financial data by design
