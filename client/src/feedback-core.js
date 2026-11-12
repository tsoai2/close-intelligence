// Pure helpers for the feedback draft. Kept free of DOM access so they can be unit-tested.
export const FEEDBACK_TO = 'tsoai2@gmail.com';
export const SCREEN_NAMES = { today: 'Today', close: 'Close', map: 'Process Map', documents: 'Documents', insights: 'Insights', reports: 'Reports', admin: 'Settings', portal: 'Requests portal' };
export const OUTLOOK_BASE = { m365: 'https://outlook.office.com/mail/deeplink/compose', personal: 'https://outlook.live.com/mail/0/deeplink/compose' };
export const URL_SOFT_LIMIT = 1900; // beyond this, browsers or Outlook may truncate the draft

export function browserLabel(ua = '') {
  const b = /Edg\/(\d+)/.exec(ua) ? `Edge ${RegExp.$1}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${RegExp.$1}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${RegExp.$1}` : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${RegExp.$1}` : 'Browser not identified';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
/** Build exactly what will go into the email. Only the fields shown here are ever included. */
export function buildFeedback({ type = 'Suggestion', message = '', contact = '', screen = 'Today', env = 'demo', version = '', browser = '', includeContext = true }) {
  const subject = `[CLOSE INTELLIGENCE Feedback] ${type} — ${screen}`;
  const lines = [`Type: ${type}`, '', message.trim() || '(no message entered)'];
  if (contact.trim()) lines.push('', `Contact: ${contact.trim()}`);
  if (includeContext) lines.push('', '---', `App version: ${version || 'unknown'}`, `Screen: ${screen}`, `Environment: ${env === 'live' ? 'Live' : 'Demo'}`, `Browser: ${browser || 'unknown'}`);
  return { to: FEEDBACK_TO, subject, body: lines.join('\n') };
}
// encodeURIComponent gives %20 for spaces (Outlook shows "+" literally in some sign-in redirects) and encodes & and Unicode safely.
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function outlookUrl(variant, { to, subject, body }) { return `${OUTLOOK_BASE[variant] || OUTLOOK_BASE.m365}?to=${enc(to)}&subject=${enc(subject)}&body=${enc(body)}`; }
export function mailtoUrl({ to, subject, body }) { return `mailto:${to}?subject=${enc(subject)}&body=${enc(body.replace(/\n/g, '\r\n'))}`; }
export function emailText({ to, subject, body }) { return `To: ${to}\nSubject: ${subject}\n\n${body}`; }
