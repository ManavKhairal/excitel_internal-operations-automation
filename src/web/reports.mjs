import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { HttpError, redact } from './security.mjs';

export async function readArtifact(directory, name, maxBytes = 20 * 1024 * 1024) {
  if (!name || path.basename(name) !== name || name.includes('\\') || name.includes('\0')) throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.');
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.');
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new HttpError(404, 'NOT_FOUND', 'Artifact unavailable or exceeds the download size limit.');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function readJson(directory, name) {
  try { return JSON.parse((await readArtifact(directory, name)).toString('utf8')); }
  catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code) || error instanceof SyntaxError || error.status === 404) return null; throw error; }
}

const allowed = new Set(['schemaVersion', 'inputSource', 'task', 'executionId', 'environment', 'mode', 'partner', 'name', 'id', 'collectedAt', 'startedAt', 'finishedAt', 'status', 'results', 'rows', 'summary', 'cleanup', 'username', 'tenant', 'targetRefundable', 'key', 'subscriberId', 'isCovered', 'isBundled', 'refundable', 'before', 'after', 'saveAttempted', 'outcome', 'detailUrl', 'evidence', 'message', 'verifiedAt', 'error', 'code', 'time', 'logout', 'logoutError', 'closeError', 'application', 'sheet', 'date', 'usernames', 'pages', 'pageCount', 'sourceUrl', 'count', 'uniqueCount', 'total', 'url', 'action', 'group', 'groupId', 'groupName', 'writeRequests', 'blockedRequests', 'dispatchedAt', 'reason', 'method', 'browser', 'requested', 'granted', 'removed', 'alreadyMember', 'alreadyNotMember', 'missing', 'saveAttempts']);
export function sanitizeReport(value, key = '', depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, 20000).map(item => sanitizeReport(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([field]) => allowed.has(field) || (key === 'summary' && /^[A-Z0-9_]+$/.test(field)))
      .map(([field, item]) => [field, sanitizeReport(item, field, depth + 1)]));
  }
  if (typeof value === 'string') return redact(value).slice(0, 5000);
  return value;
}
export function category(outcome) {
  if (['NOT_PROCESSED', 'VALIDATED', 'SAVE_STARTED_UNVERIFIED', 'IN_PROGRESS', 'APPEND_STARTED_UNVERIFIED'].includes(outcome)) return 'pending';
  if (/^(ALREADY_|SKIPPED_)/.test(outcome)) return 'skipped';
  if (/^(DRY_RUN_|WOULD_)|^(DEACTIVATED_VERIFIED|REFUNDABLE_VERIFIED|NON_REFUNDABLE_VERIFIED|ACCESS_GRANTED_VERIFIED|ACCESS_REMOVED_VERIFIED|COMPLETED|PREVIEW_COMPLETED)$/.test(outcome)) return 'successful';
  return 'failed';
}
export function recordsOf(report) {
  if (!Array.isArray(report?.results)) return [];
  return report.results.flatMap(result => {
    const rows = Array.isArray(result.rows) && result.rows.length ? result.rows : [result];
    return rows.map(row => ({ username: result.username || row.username || '', recordKey: row.key || '', tenant: result.tenant || '',
      outcome: row.outcome || result.outcome || 'NOT_PROCESSED', before: row.before ?? '', after: row.after ?? '', saveAttempted: Boolean(row.saveAttempted),
      message: redact(row.message || result.error?.message || result.sheet?.error?.message || ''),
      category: report.mode === 'apply' && /^WOULD_/.test(row.outcome || '') ? 'pending' : category(row.outcome || result.outcome || 'NOT_PROCESSED') }));
  });
}
export function progressOf(report) {
  if (!report || !Array.isArray(report.results)) return null;
  const rows = recordsOf(report), counts = { completed: 0, total: rows.length, successful: 0, skipped: 0, failed: 0, pending: 0 };
  for (const row of rows) counts[row.category]++;
  counts.completed = counts.total - counts.pending;
  return counts;
}
export function cleanupOf(report, fallback = null) {
  if (report?.task === 'workforce-access' && report.cleanup) {
    const cleanup = report.cleanup;
    return { status: cleanup.logout === 'LOGOUT_FAILED' || cleanup.browser === 'CLOSE_FAILED' ? 'COMPLETED_WITH_ERRORS' :
      cleanup.logout === 'NOT_REQUIRED' && cleanup.browser === 'NOT_OPENED' ? 'NOT_REQUIRED' : !report.finishedAt ? 'IN_PROGRESS' : 'COMPLETED',
      results: [{ application: 'Workforce', outcome: cleanup.logout, ...(cleanup.error ? { error: cleanup.error } : {}) },
        { application: 'Browser', outcome: cleanup.browser, ...(cleanup.closeError ? { error: cleanup.closeError } : {}) }] };
  }
  if (report?.cleanup) return report.cleanup;
  if (fallback) return fallback;
  // Deposit records carry their own verified logout/close results instead of an
  // ERP-style top-level cleanup object. Present those actual outcomes as well.
  if (report?.task !== 'deposit-refundability' || !Array.isArray(report.results)) return null;
  const results = report.results.flatMap(row => [
    ...(row.logout ? [{ application: `${row.tenant || 'unknown'} deposit session`, username: row.username, outcome: row.logout, ...(row.logoutError || {}) }] : []),
    ...(row.closeError ? [{ application: `${row.tenant || 'unknown'} deposit session`, username: row.username, outcome: 'BROWSER_CLOSE_FAILED', ...row.closeError }] : [])
  ]);
  const failed = results.some(row => ['LOGOUT_FAILED', 'BROWSER_CLOSE_FAILED'].includes(row.outcome));
  return { status: failed ? 'COMPLETED_WITH_ERRORS' : !report.finishedAt ? 'IN_PROGRESS' : results.length ? 'COMPLETED' : 'NOT_REQUIRED', results };
}
export function statusOf(report, exitCode = 0) {
  if (!report) return 'failed';
  if (['IN_PROGRESS', 'RUNNING'].includes(report.status) || !report.finishedAt) return 'interrupted';
  const progress = progressOf(report);
  if (report.error && !progress?.completed && !report.results?.some(row => row.saveAttempted)) return 'failed';
  const cleanupFailed = report.cleanup?.status === 'COMPLETED_WITH_ERRORS' || report.results?.some(row => row.logout === 'LOGOUT_FAILED' || row.closeError || ['FAILED', 'PENDING', 'APPEND_STARTED_UNVERIFIED', 'BLOCKED_PARTIAL_RESULT'].includes(row.sheet?.status));
  if (['HALTED_FOR_REVIEW', 'COMPLETED_WITH_EXCEPTIONS'].includes(report.status) || exitCode !== 0 || cleanupFailed || progress?.failed || progress?.pending) return 'partial';
  if (!['COMPLETED', 'PREVIEW_COMPLETED'].includes(report.status)) return 'failed';
  if (progress?.total && progress.skipped === progress.total) return 'skipped';
  return 'succeeded';
}
export async function artifactsOf(directory, id, allowScreenshots) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const report = await readJson(directory, 'report.json');
  const evidence = new Set((report?.results || []).flatMap(row => [row.evidence, ...(row.rows || []).map(item => item.evidence)]).filter(Boolean));
  return entries.filter(entry => entry.isFile() && (['report.json', 'report.csv', 'employees.json', 'logout.json'].includes(entry.name) || (allowScreenshots && evidence.has(entry.name) && /^[a-zA-Z0-9._-]+\.png$/.test(entry.name))))
    .map(entry => ({ name: entry.name, type: entry.name.endsWith('.png') ? 'image' : entry.name.endsWith('.csv') ? 'csv' : 'json', url: `/api/executions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(entry.name)}` }));
}
