import { randomUUID } from 'node:crypto';
import { StopError, clean, validUsername } from '../utils.mjs';

export const TENANTS = Object.freeze({
  north: 'https://del-procare-mariadb.excitel.in',
  south: 'https://hyd-procare-mariadb.excitel.in'
});
const aliases = { north: 'north', del: 'north', delhi: 'north', south: 'south', hyd: 'south', hyderabad: 'south' };
export function normalizeTenant(value) {
  const key = clean(value).toLowerCase();
  const tenant = Object.hasOwn(aliases, key) ? aliases[key] : null;
  if (!tenant) throw new StopError('INVALID_TENANT', 'Tenant must be north/Delhi/DEL or south/Hyderabad/HYD.');
  return tenant;
}
export function validateInput(input, maxUsers = 20) {
  if (!Array.isArray(input.usernames) || !input.usernames.length || input.usernames.length > maxUsers) {
    throw new StopError('INPUT', `Provide 1–${maxUsers} usernames.`);
  }
  return { usernames: [...new Set(input.usernames.map(validUsername))], tenant: input.tenant ? normalizeTenant(input.tenant) : null, apply: input.apply === true, refundable: normalizeRefundable(input.refundable) };
}
export function normalizeRefundable(value = 1) {
  if (![0, 1, '0', '1'].includes(value)) throw new StopError('INVALID_REFUNDABLE', 'Refundable must be exactly 0 or 1.');
  return Number(value);
}
const outcomes = target => target === 1
  ? { already: 'ALREADY_REFUNDABLE', preview: 'WOULD_SET_REFUNDABLE', verified: 'REFUNDABLE_VERIFIED' }
  : { already: 'ALREADY_NON_REFUNDABLE', preview: 'WOULD_SET_NON_REFUNDABLE', verified: 'NON_REFUNDABLE_VERIFIED' };
export function resolveTenant(username, membership, suppliedTenant) {
  if (typeof membership.north !== 'boolean' || typeof membership.south !== 'boolean') throw new StopError('SHEET_READ_FAILED', 'Both source sheets must be checked successfully.');
  if (membership.north && membership.south) throw new StopError('AMBIGUOUS_TENANT', 'Username is listed in both tenant sheets. Confirm the correct tenant before proceeding.');
  if (!membership.north && !membership.south) throw new StopError('USER_NOT_LISTED', 'User is not listed in the sheet.');
  const tenant = membership.north ? 'north' : 'south';
  if (suppliedTenant && suppliedTenant !== tenant) throw new StopError('TENANT_MISMATCH', `${username}: supplied tenant does not match the source sheet.`);
  return tenant;
}
export function taskDate(iso, timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validateRows(rows, username, maxRows = 200) {
  if (!Array.isArray(rows) || !rows.length) throw new StopError('NO_DEPOSIT_RECORDS', 'No deposit records found for the exact username.');
  if (rows.length > maxRows) throw new StopError('ROW_LIMIT', `More than ${maxRows} deposit records; no changes allowed.`);
  const keys = new Set(), subscribers = new Set();
  for (const row of rows) {
    if (row.username !== username || !/^\d+$/.test(String(row.key)) || !/^\d+$/.test(String(row.subscriberId))) throw new StopError('ROW_IDENTITY', 'A deposit row lacks an exact username or verified numeric record identity.');
    if (keys.has(String(row.key))) throw new StopError('DUPLICATE_RECORD', 'Deposit record keys are not unique.');
    keys.add(String(row.key)); subscribers.add(String(row.subscriberId));
    for (const field of ['isCovered', 'isBundled', 'refundable']) {
      if (![0, 1, '0', '1'].includes(row[field])) throw new StopError('INVALID_FLAGS', `Deposit ${row.key}: ${field} must be exactly 0 or 1.`);
    }
  }
  if (subscribers.size !== 1) throw new StopError('AMBIGUOUS_SUBSCRIBER', 'The username maps to multiple subscriber IDs.');
  return rows.map(row => ({ ...row, key: String(row.key), subscriberId: String(row.subscriberId), isCovered: Number(row.isCovered), isBundled: Number(row.isBundled), refundable: Number(row.refundable) }));
}
const classification = (row, target, status) => row.isCovered || row.isBundled ? 'SKIPPED_COVERED_OR_BUNDLED' : row.refundable === target ? status.already : status.preview;
const errorInfo = error => ({ code: error.code || 'FAILED', message: error.message.split('\n')[0] });

// Business workflow independent of CLI, browser implementation, and credentials.
export async function runDepositTask(input, { sheets, openDatabase, config, checkpoint = async () => {}, now = () => new Date().toISOString(), environment = 'production-preview' }) {
  const request = validateInput(input, config.maxUsers);
  const target = request.refundable, status = outcomes(target);
  if (request.apply && environment !== 'offline-demo') throw new StopError('LIVE_WRITES_DISABLED', 'Production writes are not enabled in this development phase.');
  const report = { schemaVersion: 1, task: 'deposit-refundability', executionId: randomUUID(), environment,
    mode: request.apply ? 'apply' : 'dry-run', targetRefundable: target, status: 'IN_PROGRESS', startedAt: now(), finishedAt: null,
    results: request.usernames.map(username => ({ username, tenant: null, targetRefundable: target, outcome: 'NOT_PROCESSED', rows: [], sheet: { status: 'NOT_REQUIRED' } })) };
  const persist = () => checkpoint(structuredClone(report));
  await persist();
  // Check BOTH source sheets for ALL inputs before opening a database.
  for (const result of report.results) {
    try { result.tenant = resolveTenant(result.username, await sheets.membership(result.username), request.tenant); result.outcome = 'VALIDATED'; }
    catch (error) { result.outcome = 'BLOCKED'; result.error = errorInfo(error); }
    await persist();
  }
  const sessions = new Map();
  try {
    for (const result of report.results.filter(result => result.outcome === 'VALIDATED')) {
      let database;
      try {
        if (!sessions.has(result.tenant)) sessions.set(result.tenant, { database: await openDatabase(result.tenant), results: [] });
        const entry = sessions.get(result.tenant);
        database = entry.database; entry.results.push(result);
        const initial = validateRows(await database.lookup(result.username), result.username, config.maxDepositsPerUser);
        result.rows = initial.map(row => ({ ...row, before: row.refundable, after: row.refundable, saveAttempted: false, outcome: classification(row, target, status) }));
        await persist();
        for (const row of result.rows) {
          if (row.outcome !== status.preview || !request.apply) continue;
          const currentRows = validateRows(await database.lookup(result.username), result.username, config.maxDepositsPerUser);
          if (initial.map(r => r.key).sort().join(',') !== currentRows.map(r => r.key).sort().join(',')) throw new StopError('RECORD_SET_CHANGED', 'Deposit records changed since preview; stopping this username.');
          const current = currentRows.find(candidate => candidate.key === row.key);
          if (!current || current.subscriberId !== row.subscriberId || current.isCovered !== row.isCovered || current.isBundled !== row.isBundled || current.refundable !== 1 - target) throw new StopError('RECORD_CHANGED', `Deposit ${row.key} changed before editing.`);
          const saveOnce = await database.prepareRefundable(current, target);
          row.outcome = 'SAVE_STARTED_UNVERIFIED'; row.saveAttempted = true;
          await persist(); // durable checkpoint BEFORE Enter
          await saveOnce(); // one Enter only; never retry a write after uncertainty
          const fresh = validateRows(await database.lookup(result.username), result.username, config.maxDepositsPerUser).find(candidate => candidate.key === row.key);
          if (!fresh || fresh.subscriberId !== row.subscriberId || fresh.refundable !== target || fresh.isCovered !== 0 || fresh.isBundled !== 0) throw new StopError('SAVE_UNVERIFIED', `Deposit ${row.key}: persisted eligible refundable=${target} was not verified.`);
          row.after = target; row.outcome = status.verified; row.verifiedAt = now();
          await persist();
        }
        result.outcome = request.apply ? 'COMPLETED' : 'PREVIEW_COMPLETED';
        const changed = result.rows.filter(row => row.outcome === status.verified);
        if (changed.length) result.sheet = { status: 'PENDING', date: taskDate(changed.at(-1).verifiedAt, config.timeZone), refundable: target === 1 ? 'YES' : 'NO' };
      } catch (error) {
        const pending = result.rows.find(row => row.outcome === 'SAVE_STARTED_UNVERIFIED');
        if (pending) pending.outcome = 'SAVE_UNVERIFIED';
        result.error = errorInfo(error); result.outcome = 'HALTED_FOR_REVIEW';
        if (result.rows.some(row => row.outcome === status.verified)) result.sheet = { status: 'BLOCKED_PARTIAL_RESULT' };
      }
      await persist();
      if (result.outcome === 'HALTED_FOR_REVIEW') break;
    }
  } finally {
    // One session per tenant, closed once after all database processing.
    for (const { database, results } of [...sessions.values()].reverse()) {
      try { await database.logout(); for (const result of results) result.logout = 'SIGNED_OUT_VERIFIED'; }
      catch (error) { for (const result of results) { result.logout = 'LOGOUT_FAILED'; result.logoutError = errorInfo(error); } }
      try { await database.close(); }
      catch (error) { for (const result of results) result.closeError = errorInfo(error); }
    }
  }
  await persist();
  for (const result of report.results) {
    if (result.sheet.status === 'PENDING' && result.logout === 'SIGNED_OUT_VERIFIED' && !result.closeError) {
      await recordCompletion(result, sheets, persist);
      if (result.sheet.status === 'FAILED') break;
    }
  }
  for (const result of report.results) if (result.outcome === 'VALIDATED') result.outcome = 'NOT_PROCESSED';
  const issue = report.results.some(r => !['COMPLETED', 'PREVIEW_COMPLETED'].includes(r.outcome) || r.logout === 'LOGOUT_FAILED' || r.closeError || ['FAILED', 'PENDING', 'APPEND_STARTED_UNVERIFIED'].includes(r.sheet.status));
  report.status = issue ? 'COMPLETED_WITH_EXCEPTIONS' : request.apply ? 'COMPLETED' : 'PREVIEW_COMPLETED';
  report.finishedAt = now();
  await persist();
  return report;
}

// For a reviewed sheet-only recovery: no database access or repeated saves.
export async function recordCompletion(result, sheets, checkpoint = async () => {}) {
  const target = normalizeRefundable(result.targetRefundable), status = outcomes(target);
  if (result.outcome !== 'COMPLETED' || result.logout !== 'SIGNED_OUT_VERIFIED' || result.closeError ||
      !result.rows.some(row => row.outcome === status.verified) ||
      result.rows.some(row => ![status.verified, status.already, 'SKIPPED_COVERED_OR_BUNDLED'].includes(row.outcome) ||
        (row.outcome !== 'SKIPPED_COVERED_OR_BUNDLED' && row.after !== target)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(result.sheet.date || '')) throw new StopError('COMPLETION_NOT_VERIFIED', 'Sheet recording requires completed, verified changes and logout.');
  try {
    result.sheet.status = 'APPEND_STARTED_UNVERIFIED'; await checkpoint();
    result.sheet.status = await sheets.recordCompletion(result.tenant, result.username, result.sheet.date, target);
    if (!['RECORDED_VERIFIED', 'ALREADY_RECORDED'].includes(result.sheet.status)) throw new StopError('SHEET_UNVERIFIED', 'Completion entry could not be verified.');
    delete result.sheet.error;
  } catch (error) { result.sheet.status = 'FAILED'; result.sheet.error = errorInfo(error); }
  await checkpoint();
}
