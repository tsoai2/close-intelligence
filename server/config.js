import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const APP_VERSION = '0.1.0';
export const ENVS = ['demo', 'live'];
export const dataDir = () => process.env.CI_DATA_DIR || path.join(ROOT, 'data');
export const port = () => +(process.env.PORT || 4600);
export const secureCookies = () => process.env.CI_SECURE_COOKIES === '1';
export const openaiBase = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
export const SESSION_HOURS = +(process.env.CI_SESSION_HOURS || 12);
export const MAX_UPLOAD = 20 * 1024 * 1024;

let cachedKey = null;
/** 32-byte key used to encrypt stored secrets and sign download links. In production set CI_SECRET_KEY
 * (base64, 32 bytes) from a secret manager/KMS. Without it a local development key file is created
 * next to the data directory - acceptable on one workstation, not for a shared deployment. */
export function secretKey() {
  if (cachedKey && cachedKey.dir === dataDir() && cachedKey.env === process.env.CI_SECRET_KEY) return cachedKey.key;
  let key;
  if (process.env.CI_SECRET_KEY) {
    key = Buffer.from(process.env.CI_SECRET_KEY, 'base64');
    if (key.length !== 32) throw new Error('CI_SECRET_KEY must be 32 bytes, base64 encoded');
  } else {
    const f = path.join(dataDir(), '.local-secret.key');
    if (!fs.existsSync(f)) { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 }); }
    key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
  }
  cachedKey = { key, dir: dataDir(), env: process.env.CI_SECRET_KEY };
  return key;
}
export const usingLocalKey = () => !process.env.CI_SECRET_KEY;
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function decryptSecret(blob) {
  const [v, iv, tag, enc] = String(blob).split('.'); if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
export const hmac = s => crypto.createHmac('sha256', secretKey()).update(s).digest('base64url');
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
