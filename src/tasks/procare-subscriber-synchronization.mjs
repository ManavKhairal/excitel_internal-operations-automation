import { randomUUID } from 'node:crypto';
import { StopError, validUsername, hash } from '../utils.mjs';

// The connector reads the requested sheet range into this local, private snapshot.
// This file is input data only: it cannot supply URLs, selectors or request paths.
export function validateSyncInput(snapshot, maxUsers = 500) {
  const source = snapshot?.source;
  const recognizedSource = source?.kind === 'xlsx'
    ? typeof source.path === 'string' && source.path.endsWith('.xlsx') && /^[a-f0-9]{64}$/.test(source.sha256 || '')
    : /^[A-Za-z0-9_-]+$/.test(source?.spreadsheetId || '');
  if (!snapshot || snapshot.tenant !== 'north' || !snapshot.source ||
      !recognizedSource ||
      typeof snapshot.source.tab !== 'string' || !snapshot.source.tab.trim() ||
      !/^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/.test(snapshot.source.range || '') ||
      !Number.isFinite(Date.parse(snapshot.source.checkedAt))) {
    throw new StopError('SHEET_INPUT', 'Provide a North sheet snapshot with source identity, tab, bounded range, checkedAt and usernames.');
  }
  if (!Array.isArray(snapshot.usernames) || !snapshot.usernames.length || snapshot.usernames.length > maxUsers) {
    throw new StopError('SHEET_INPUT', `The selected sheet range must contain 1–${maxUsers} usernames. Split larger batches explicitly.`);
  }
  const usernames = [...new Set(snapshot.usernames.map(value => {
    if (typeof value !== 'string') throw new StopError('SHEET_INPUT', 'Sheet usernames must be strings so case and leading zeroes are preserved.');
    return validUsername(value);
  }))];
  return { tenant: 'north', source: { ...snapshot.source }, usernames, inputHash: hash(usernames) };
}

export async function runSubscriberSync(input, { config, apply = false, openSession, checkpoint = async () => {}, now = () => new Date().toISOString() }) {
  const request = validateSyncInput(input, config.maxUsers);
  const report = {
    schemaVersion: 1, task: 'procare-subscriber-synchronization', executionId: randomUUID(),
    environment: config.environment, tenant: 'north', mode: apply ? 'apply' : 'preview',
    source: request.source, inputHash: request.inputHash, startedAt: now(), status: 'IN_PROGRESS',
    results: request.usernames.map(username => ({ username, outcome: 'NOT_PROCESSED', syncAttempted: false, requestDispatched: false })),
    cleanup: { logout: 'NOT_REQUIRED', browser: 'NOT_OPENED' }
  };
  const persist = () => checkpoint(structuredClone(report));
  let session;
  const errorInfo = error => ({ code: error.code || 'FAILED', message: error.message.split('\n')[0] });
  await persist();
  try {
    session = await openSession();
    await session.ensureLogin();
    for (const result of report.results) {
      try {
        const subscriber = await session.findSubscriber(result.username);
        if (!subscriber) { result.outcome = 'USER_NOT_FOUND'; await persist(); continue; }
        result.subscriberId = subscriber.subscriberId;
        result.subscriberErpId = subscriber.subscriberErpId;
        result.detailUrl = subscriber.detailUrl;
        if (!apply) { result.outcome = 'WOULD_SYNCHRONIZE'; await persist(); continue; }
        const synchronizeOnce = await session.prepareSynchronization(subscriber, async audit => {
          result.requestDispatched = true; result.dispatchedAt = audit.dispatchedAt; await persist();
        });
        result.syncAttempted = true;
        result.outcome = 'SYNC_STARTED_UNVERIFIED';
        await persist(); // checkpoint before the UI click; no automatic replay
        const verification = await synchronizeOnce();
        if (!verification || verification.username !== result.username || verification.subscriberId !== result.subscriberId || verification.outcome !== 'SYNC_RESPONSE_VERIFIED') {
          throw new StopError('SYNC_UNVERIFIED', 'The synchronization response and reloaded subscriber identity were not verified.');
        }
        result.outcome = verification.outcome;
        result.verification = verification;
        result.finishedAt = now();
        await persist();
      } catch (error) {
        result.outcome = result.syncAttempted ? 'SYNC_UNVERIFIED' : 'FAILED';
        result.error = errorInfo(error);
        await persist();
        break;
      }
    }
  } catch (error) { report.error = errorInfo(error); }
  finally {
    if (session) {
      if (report.error || report.results.some(result => result.error)) {
        try { report.diagnostics = await session.diagnostics?.(); } catch {}
      }
      try { report.cleanup.logout = await session.logout(); }
      catch (error) { report.cleanup.logout = 'LOGOUT_FAILED'; report.cleanup.logoutError = errorInfo(error); }
      try { await session.close(); report.cleanup.browser = 'CLOSED'; }
      catch (error) { report.cleanup.browser = 'CLOSE_FAILED'; report.cleanup.closeError = errorInfo(error); }
      report.requestAudit = session.audit || [];
      report.blockedRequests = session.blocked || [];
    }
  }
  const ok = apply ? 'SYNC_RESPONSE_VERIFIED' : 'WOULD_SYNCHRONIZE';
  report.status = !report.error && report.results.every(result => result.outcome === ok) &&
    ['SIGNED_OUT_VERIFIED', 'ALREADY_SIGNED_OUT'].includes(report.cleanup.logout) && report.cleanup.browser === 'CLOSED'
    ? (apply ? 'COMPLETED' : 'PREVIEW_COMPLETED') : 'COMPLETED_WITH_EXCEPTIONS';
  report.summary = { requested: report.results.length, verified: report.results.filter(r => r.outcome === 'SYNC_RESPONSE_VERIFIED').length,
    missing: report.results.filter(r => r.outcome === 'USER_NOT_FOUND').length, attempted: report.results.filter(r => r.syncAttempted).length,
    dispatched: report.results.filter(r => r.requestDispatched).length };
  report.finishedAt = now(); await persist();
  return report;
}
