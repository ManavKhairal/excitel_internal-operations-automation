import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class StopError extends Error {
  constructor(code, message, { stopBatch = true } = {}) {
    super(message); this.name = 'StopError'; this.code = code; this.stopBatch = stopBatch;
  }
}
export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const exactPattern = (text, flags = '') => new RegExp(`^\\s*${String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, flags);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const safeName = value => clean(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'item';
export const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const hash = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 150, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; }
    catch (error) { if (error instanceof StopError) throw error; last = error; }
    await sleep(intervalMs);
  }
  throw new StopError('TIMEOUT', `Timed out waiting for ${description}${last ? ` (${last.message.split('\n')[0]})` : ''}.`);
}

export async function visibleItems(locator) {
  const out = [];
  for (let i = 0, n = await locator.count(); i < n; i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) out.push(item);
  }
  return out;
}

export async function uniqueVisible(locator, label, timeoutMs = 20000) {
  return waitFor(async () => {
    const matches = await visibleItems(locator);
    if (matches.length > 1) throw new StopError('AMBIGUOUS_CONTROL', `${label}: ${matches.length} visible matches. Configure a narrower selector; no first-match guess was made.`);
    return matches[0] || false;
  }, { timeoutMs, description: label });
}

export async function disabled(locator) {
  return (await locator.isDisabled().catch(() => false)) ||
    await locator.evaluate(el => el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('data-is-disabled') === 'true' || el.hasAttribute('disabled') ||
      !!el.closest('[aria-disabled="true"], .disabled, [data-is-disabled="true"]'));
}

export function validUsername(value) {
  const text = clean(value);
  if (!text || text.length > 128 || /\s|[\u0000-\u001f<>"'\\]/.test(text)) {
    throw new StopError('INVALID_USERNAME', `Unexpected username value: ${JSON.stringify(text)}. Review the source column; nothing will be changed.`);
  }
  if (/^(username|user name|no data|no records|no results)$/i.test(text)) {
    throw new StopError('INVALID_USERNAME', 'The extracted value appears to be a heading or empty-state label.');
  }
  return text;
}

export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
}
export async function writeJson(file, value) {
  await privateDir(path.dirname(file));
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
export function csvCell(value) {
  let text = String(value ?? '');
  // Prevent spreadsheet formula injection when a report is opened in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function saveReport(dir, report) {
  const counts = {};
  for (const row of report.results) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  report.summary = counts;
  await writeJson(path.join(dir, 'report.json'), report);
  const fields = ['username', 'outcome', 'before', 'after', 'saveAttempted', 'detailUrl', 'evidence', 'message', 'finishedAt'];
  const lines = [fields.map(csvCell).join(','), ...report.results.map(row => fields.map(f => csvCell(row[f])).join(','))];
  await fs.writeFile(path.join(dir, 'report.csv'), lines.join('\n') + '\n', { mode: 0o600 });
}
export async function screenshot(page, dir, label, enabled = true) {
  if (!enabled) return '';
  const file = path.join(dir, `${safeName(label)}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); await fs.chmod(file, 0o600); return path.basename(file); }
  catch { return ''; }
}

export function safeUrl(raw) {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
  catch { return ''; }
}

export async function diagnostics(page, dir, label, enabled = true) {
  const info = await page.evaluate(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      headings: [...document.querySelectorAll('th,[role="columnheader"]')].filter(visible).map(el => el.textContent.trim()),
      controls: [...document.querySelectorAll('button,[role="button"],input,select')].filter(visible).slice(0, 100).map(el => ({
        tag: el.tagName.toLowerCase(), id: el.id, dataId: el.getAttribute('data-id'),
        type: el.getAttribute('type'), role: el.getAttribute('role'), placeholder: el.getAttribute('placeholder'),
        label: el.getAttribute('aria-label') || (el.matches('button,[role="button"]') ? el.textContent.trim().slice(0, 100) : '')
      }))
    };
  }).catch(() => ({ error: 'Could not inspect the current page.' }));
  info.location = safeUrl(page.url());
  await writeJson(path.join(dir, `${safeName(label)}-ui-summary.json`), info);
  return screenshot(page, dir, label, enabled);
}

export async function acquireLock(dir) {
  await privateDir(dir);
  const lockFile = path.join(dir, 'run.lock');
  let handle;
  try { handle = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new StopError('LOCKED', 'Another run may be active. Close it first. If a previous process crashed, verify no automation is running, then remove .state/run.lock.');
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await fs.unlink(lockFile).catch(() => {}); };
}
