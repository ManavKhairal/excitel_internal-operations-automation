import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { privateDir } from '../utils.mjs';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function assertObject(value, label = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_INPUT', `${label} must be an object.`);
}
export function onlyKeys(value, keys) {
  assertObject(value);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'INVALID_INPUT', 'The request contains an unsupported field.');
}
export function equalSecret(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// Reports are data, never HTML. Apply the same redaction to persisted web events,
// API responses and downloads. Browser diagnostics and profile files are excluded.
export function redact(value) {
  let text = String(value ?? '');
  const secrets = Object.entries(process.env).filter(([key, secret]) => /PASSWORD|TOKEN|SECRET|API_KEY|COOKIE/i.test(key) && secret)
    .map(([, secret]) => secret).sort((left, right) => right.length - left.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]+/gi, '[REDACTED]')
    .replace(/(["']?(?:password|passwd|access_token|refresh_token|id_token|api_key|secret|cookie|authorization)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1"[REDACTED]"')
    .replace(/\b(password|passwd|access_token|refresh_token|id_token|api_key|secret|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/gi, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
    });
}
export function safeError(error) {
  return { code: /^[A-Z][A-Z0-9_]{0,80}$/.test(error?.code || '') ? error.code : 'EXECUTION_FAILED',
    message: redact(error?.message || 'Execution failed. Review the local report.').split('\n')[0].slice(0, 1000) };
}
export async function privateStorage(root, name) {
  const directory = path.join(root, name);
  const existing = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`${name} must be a local directory, not a symlink.`);
  await privateDir(directory);
  if (await fs.realpath(directory) !== path.join(await fs.realpath(root), name)) throw new Error(`${name} must be a local directory, not a symlink.`);
  return directory;
}
export async function dashboardToken(root) {
  if (process.env.DASHBOARD_TOKEN) {
    if (process.env.DASHBOARD_TOKEN.length < 32) throw new Error('DASHBOARD_TOKEN must contain at least 32 characters.');
    return process.env.DASHBOARD_TOKEN;
  }
  const directory = await privateStorage(root, '.state');
  const file = path.join(directory, 'dashboard-token');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(crypto.randomBytes(32).toString('base64url') + '\n'); } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The dashboard token must be a regular private file.');
  await fs.chmod(file, 0o600);
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (token.length < 32) throw new Error('The dashboard token is invalid.');
  return token;
}
