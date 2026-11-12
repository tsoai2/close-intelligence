// Client data layer: environment-scoped requests, stale-response rejection, a small query cache,
// realtime invalidation and a visible save state. Nothing sensitive is written to browser storage.
import { useEffect, useState, useSyncExternalStore, useCallback, useRef } from 'react';

export const net = { env: 'demo', epoch: 0, csrf: null, controllers: new Set(), es: null };
export class ApiError extends Error { constructor(status, body) { super(body?.message || 'The request failed.'); this.status = status; this.code = body?.error; this.details = body?.details; this.errorId = body?.errorId; } }
export class StaleError extends Error { constructor() { super('stale'); this.stale = true; } }

export async function request(method, path, body, { raw = false, env, blob = false } = {}) {
  const e = env || net.env; const epoch = net.epoch; const ac = new AbortController(); net.controllers.add(ac);
  const headers = {}; if (method !== 'GET') { headers['X-CI-Env'] = e; if (net.csrf && e === net.env) headers['X-CSRF-Token'] = net.csrf; headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json'; }
  try {
    let res; try { res = await fetch(`/api/${e}${path}`, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined, signal: ac.signal, credentials: 'same-origin' }); }
    catch (err) { if (ac.signal.aborted || epoch !== net.epoch) throw new StaleError(); throw new ApiError(0, { error: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.' }); }
    // A response that belongs to a previously selected environment is discarded, never rendered.
    if (epoch !== net.epoch || (res.headers.get('X-CI-Env') && res.headers.get('X-CI-Env') !== e)) throw new StaleError();
    if (blob && res.ok) return { blob: await res.blob(), name: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'download' };
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (epoch !== net.epoch) throw new StaleError();
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  } finally { net.controllers.delete(ac); }
}
// ---- tiny external stores ----
function store(initial) { let v = initial; const subs = new Set(); return { get: () => v, set(n) { v = typeof n === 'function' ? n(v) : n; subs.forEach(f => f()); }, sub(f) { subs.add(f); return () => subs.delete(f); } }; }
export const saveStore = store({ status: 'idle', message: '' });
export const useSave = () => useSyncExternalStore(saveStore.sub, saveStore.get);
export const appStore = store({ env: 'demo', me: null, auth: null, periodId: null, entityId: 'all', assistant: false, toasts: [], conflict: null, booting: true });
export const useApp = () => useSyncExternalStore(appStore.sub, appStore.get);
export const setApp = patch => appStore.set(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
let toastId = 0;
export function toast(message, { kind = 'info', action, ttl = 5000 } = {}) { const id = ++toastId; setApp(s => ({ toasts: [...s.toasts, { id, message, kind, action }] })); if (ttl) setTimeout(() => setApp(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), ttl); return id; }
export const dismissToast = id => setApp(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));

// ---- query cache (scoped by environment; cleared on every switch and sign-out) ----
const cache = new Map(); const watchers = new Map();
const keyOf = path => net.env + '|' + path;
const notify = k => (watchers.get(k) || []).forEach(f => f());
async function load(path) {
  const k = keyOf(path); const cur = cache.get(k) || {}; if (cur.promise) return cur.promise;
  const promise = request('GET', path).then(data => { if (cache.get(k)?.promise === promise) { cache.set(k, { data, at: Date.now() }); notify(k); } return data; })
    .catch(error => { if (error.stale) return; if (cache.get(k)?.promise === promise) { cache.set(k, { data: cur.data, error, at: Date.now() }); notify(k); } });
  cache.set(k, { ...cur, promise, error: undefined }); notify(k); return promise;
}
export function useQuery(path, { enabled = true } = {}) {
  const k = path && enabled ? keyOf(path) : null; const [, tick] = useState(0);
  useEffect(() => { if (!k) return; const f = () => tick(n => n + 1); if (!watchers.has(k)) watchers.set(k, new Set()); watchers.get(k).add(f); const c = cache.get(k); if (!c || (!c.promise && Date.now() - (c.at || 0) > 20000)) load(path); return () => { watchers.get(k)?.delete(f); }; }, [k]);
  const c = k ? cache.get(k) : null;
  return { data: c?.data, error: c?.error, loading: !!k && !c?.data && !c?.error, refreshing: !!c?.promise, reload: useCallback(() => path && load(path), [path]) };
}
export const prefetch = path => { const c = cache.get(keyOf(path)); if (!c) load(path); };
let refreshTimer = null;
/** Refetch everything on screen and forget the rest. Used after mutations and on realtime invalidation. */
export function refreshAll() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { for (const k of [...cache.keys()]) { const [env, path] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; if (env !== net.env) { cache.delete(k); continue; } if (watchers.get(k)?.size) load(path); else cache.delete(k); } }, 120); }

/** Mutations report their state (saving / saved / failed / conflicted) and refresh affected views on success. */
export async function mutate(method, path, body, opts = {}) {
  saveStore.set({ status: 'saving', message: 'Saving…' });
  try { const r = await request(method, path, body, opts); saveStore.set({ status: 'saved', message: 'Saved' });
    // Put the server's answer straight into the cache so the next action uses the new version number, then refresh the rest.
    const m = /^\/(tasks|recs)\/(\d+)/.exec(path); const fresh = r && (r.task?.steps ? r.task : m && r.version != null && (r.steps || r.items) ? r : null);
    if (m && fresh) { const k = keyOf(`/${m[1]}/${m[2]}`); cache.set(k, { data: fresh, at: Date.now() }); notify(k); }
    refreshAll(); return r; }
  catch (e) { if (e.stale) { saveStore.set({ status: 'idle', message: '' }); throw e; }
    if (e.status === 409 && e.code === 'CONFLICT') saveStore.set({ status: 'conflict', message: 'Changed by someone else' }); else saveStore.set({ status: 'failed', message: e.status === 0 ? 'Not saved — offline' : 'Not saved' });
    if (e.status === 401) setApp({ me: null, auth: null }); throw e; }
}
export const api = { get: p => request('GET', p), post: (p, b, o) => mutate('POST', p, b, o), patch: (p, b) => mutate('PATCH', p, b), put: (p, b) => mutate('PUT', p, b), del: p => mutate('DELETE', p), upload: (p, file) => mutate('POST', p, file, { raw: true }) };
export async function download(path) { try { const { blob, name } = await request('GET', path, undefined, { blob: true }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } catch (e) { if (!e.stale) toast(e.message, { kind: 'error' }); } }

export function connectEvents() {
  net.es?.close(); if (!appStore.get().me || appStore.get().me.user.role === 'external') return;
  const env = net.env; const es = new EventSource(`/api/${env}/events`); net.es = es;
  es.onmessage = ev => { if (env !== net.env) return; try { const m = JSON.parse(ev.data); if (m.type === 'invalidate') { refreshAll(); if (m.keys.includes('me')) loadMe(); if (m.by && m.by !== appStore.get().me?.user.id && m.keys.includes('tasks')) pulse(); } } catch { /* ignore */ } };
}
const pulseStore = store(0); const pulse = () => pulseStore.set(n => n + 1); export const usePulse = () => useSyncExternalStore(pulseStore.sub, pulseStore.get);
export async function loadMe() {
  try { const me = await request('GET', '/me'); net.csrf = me.csrf; const s = appStore.get(); const open = me.periods.find(p => p.status !== 'locked') || me.periods[0];
    setApp({ me, periodId: me.periods.some(p => p.id === s.periodId) ? s.periodId : open?.id ?? null, entityId: s.entityId === 'all' || me.entities.some(e => e.id === s.entityId) ? s.entityId : 'all' }); return me; }
  catch (e) { if (!e.stale) setApp({ me: null }); return null; }
}
/** Establish the session for an environment. Demo signs in as a preview persona; Live requires real credentials. */
export async function boot(env) {
  setApp({ booting: true, env }); net.env = env;
  try { const auth = await request('GET', '/auth/status'); if (env === 'demo' && !auth.authenticated) { await request('POST', '/session/preview', {}); }
    setApp({ auth }); if (env === 'demo' || auth.authenticated) { await loadMe(); connectEvents(); } else setApp({ me: null }); }
  catch (e) { if (!e.stale) setApp({ auth: { error: e.message }, me: null }); }
  finally { if (net.env === env) setApp({ booting: false }); }
}
/** Switching environments cancels in-flight work, drops every cached record and rejects late responses. */
export function switchEnv(env) {
  if (env === net.env) return; net.epoch++; for (const c of net.controllers) c.abort(); net.controllers.clear(); net.es?.close(); net.es = null; cache.clear(); net.csrf = null; net.env = env;
  saveStore.set({ status: 'idle', message: '' }); setApp({ env, me: null, auth: null, periodId: null, entityId: 'all', assistant: false, conflict: null, toasts: [] }); try { sessionStorage.clear(); } catch { /* ignore */ }
  return boot(env);
}
export async function signOut() { try { await request('POST', '/auth/logout', {}); } catch { /* ignore */ } net.epoch++; cache.clear(); net.es?.close(); net.csrf = null; try { sessionStorage.clear(); } catch { /* ignore */ } setApp({ me: null }); boot(net.env); }
/** Harmless per-screen preferences (filters, theme). Never financial data. */
/** Sets a stored view preference from outside the component that owns it (for example before navigating to it). */
export function setPref(key, value) { try { sessionStorage.setItem(`ci:${net.env}:${key}`, JSON.stringify(value)); } catch { /* ignore */ } }
export function usePref(key, initial) {
  const k = `ci:${net.env}:${key}`; const [v, setV] = useState(() => { try { const s = sessionStorage.getItem(k); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  const ref = useRef(v); ref.current = v; const set = useCallback(n => { const next = typeof n === 'function' ? n(ref.current) : n; setV(next); try { sessionStorage.setItem(k, JSON.stringify(next)); } catch { /* ignore */ } }, [k]);
  return [v, set];
}
