import { randomUUID } from 'node:crypto';
import { StopError, clean, validUsername } from '../utils.mjs';

const tenantAliases = { north: 'north', delhi: 'north', del: 'north', south: 'south', hyderabad: 'south', hyd: 'south' };
export function validateWorkforceInput(input, maxUsers = 20) {
  if (!Array.isArray(input.usernames) || !input.usernames.length || input.usernames.length > maxUsers) throw new StopError('INPUT', `Provide 1–${maxUsers} usernames.`);
  const key = clean(input.tenant).toLowerCase();
  const tenants = key === 'both' ? ['north', 'south'] : Object.hasOwn(tenantAliases, key) ? [tenantAliases[key]] : null;
  if (!tenants) throw new StopError('INVALID_TENANT', 'Specify --tenant north, south or both from the approved request.');
  const action = clean(input.action ?? 'grant').toLowerCase();
  if (!['grant', 'remove'].includes(action)) throw new StopError('INVALID_ACTION', 'Specify --action grant or remove.');
  return { usernames: [...new Set(input.usernames.map(validUsername))], tenants, action, apply: input.apply === true };
}
const errorInfo = error => ({ code: error.code || error.name || 'FAILED', message: error.message.split('\n')[0] });
function assertIdentity(state, result, group) {
  if (!state || state.username !== result.username || state.tenant !== result.tenant || state.groupId !== group.id || typeof state.found !== 'boolean' || typeof state.selected !== 'boolean') throw new StopError('USER_IDENTITY', 'Workforce tenant, group or exact username could not be verified.');
}

export async function runWorkforceTask(input, { config, openSession, checkpoint = async () => {}, now = () => new Date().toISOString() }) {
  const request = validateWorkforceInput(input, config.maxUsers);
  const report = { schemaVersion: 1, task: 'workforce-access', executionId: randomUUID(), environment: 'staging',
    action: request.action, mode: request.apply ? 'apply' : 'dry-run', status: 'IN_PROGRESS', startedAt: now(), finishedAt: null,
    results: request.tenants.flatMap(tenant => request.usernames.map(username => ({ username, tenant, action: request.action, outcome: 'NOT_PROCESSED', before: null, after: null, saveAttempted: false }))), cleanup: null };
  const persist = async () => {
    report.summary = { requested: report.results.length, granted: report.results.filter(r => r.outcome === 'ACCESS_GRANTED_VERIFIED').length,
      removed: report.results.filter(r => r.outcome === 'ACCESS_REMOVED_VERIFIED').length,
      alreadyMember: report.results.filter(r => r.outcome === 'ALREADY_MEMBER').length, alreadyNotMember: report.results.filter(r => r.outcome === 'ALREADY_NOT_MEMBER').length, missing: report.results.filter(r => r.outcome === 'USER_NOT_FOUND').length,
      saveAttempts: report.results.filter(r => r.saveAttempted).length };
    await checkpoint(structuredClone(report));
  };
  let session, stopped = false;
  await persist();
  try {
    session = await openSession();
    await session.ensureLogin();
    for (const tenant of request.tenants) {
      if (stopped) break;
      await session.openTenant(tenant);
      const group = await session.openFirstGroup();
      if (!group?.id || !group.name) throw new StopError('GROUP_IDENTITY', 'The first group needs a stable identity before editing.');
      for (const result of report.results.filter(r => r.tenant === tenant)) {
        result.group = group; result.outcome = 'IN_PROGRESS'; await persist();
        try {
          const state = await session.inspectUser(result.username, group);
          assertIdentity(state, result, group);
          if (!state.found) {
            result.outcome = 'USER_NOT_FOUND'; result.message = `${result.username} is not available in ${tenant} tenant.`;
            await session.cancelEditor(group); await persist(); continue;
          }
          result.before = state.selected; result.after = state.selected;
          const desired = request.action === 'grant';
          if (state.selected === desired) {
            result.outcome = desired ? 'ALREADY_MEMBER' : 'ALREADY_NOT_MEMBER'; result.message = desired ? 'The user already belongs to the selected group.' : 'The user is already outside the selected group.';
            await session.cancelEditor(group); await persist(); continue;
          }
          if (!desired && state.isDefaultUser) throw new StopError('DEFAULT_USER_REMOVAL', 'This member is the group default user. Change that assignment separately before removing membership.');
          if (!request.apply) {
            result.outcome = desired ? 'WOULD_GRANT_ACCESS' : 'WOULD_REMOVE_ACCESS'; result.message = 'Exact user found; preview left membership unchanged.';
            await session.cancelEditor(group); await persist(); continue;
          }
          const saveOnce = desired ? await session.prepareGrant(state, group) : await session.prepareRemoval(state, group);
          result.outcome = 'SAVE_STARTED_UNVERIFIED'; result.saveAttempted = true; result.saveStartedAt = now();
          await persist();
          await saveOnce();
          const fresh = desired ? await session.verifyGrant(state, group) : await session.verifyRemoval(state, group);
          assertIdentity(fresh, result, group);
          if (!fresh.found || fresh.selected !== desired) throw new StopError('SAVE_UNVERIFIED', 'The requested membership state was not verified after reopening the exact group.');
          result.after = desired; result.outcome = desired ? 'ACCESS_GRANTED_VERIFIED' : 'ACCESS_REMOVED_VERIFIED'; result.verifiedAt = now();
          if (fresh.evidence) result.evidence = fresh.evidence;
          result.message = `Group membership ${desired ? 'granted' : 'removed'} once and verified after reopening.`;
          await session.cancelEditor(group);
        } catch (error) {
          result.outcome = result.saveAttempted ? 'SAVE_UNVERIFIED' : 'FAILED'; result.error = errorInfo(error);
          result.message = result.error.message; stopped = true;
        }
        await persist();
        if (stopped) break;
      }
    }
  } catch (error) { report.error = errorInfo(error); }
  finally {
    report.cleanup = { logout: 'NOT_REQUIRED', browser: 'NOT_OPENED' };
    if (session) {
      try { report.cleanup.logout = await session.logout(); }
      catch (error) { report.cleanup.logout = 'LOGOUT_FAILED'; report.cleanup.error = errorInfo(error); }
      try { await session.close(); report.cleanup.browser = 'CLOSED'; }
      catch (error) { report.cleanup.browser = 'CLOSE_FAILED'; report.cleanup.closeError = errorInfo(error); }
      report.writeRequests = structuredClone(session.writeAudit || []);
      report.blockedRequests = structuredClone(session.blocked || []);
    }
  }
  const cleanOutcomes = new Set(['ACCESS_GRANTED_VERIFIED', 'ACCESS_REMOVED_VERIFIED', 'ALREADY_MEMBER', 'ALREADY_NOT_MEMBER', 'WOULD_GRANT_ACCESS', 'WOULD_REMOVE_ACCESS']);
  const issue = report.error || report.results.some(r => !cleanOutcomes.has(r.outcome)) || report.cleanup.logout === 'LOGOUT_FAILED' || report.cleanup.browser === 'CLOSE_FAILED';
  report.status = issue ? 'COMPLETED_WITH_EXCEPTIONS' : request.apply ? 'COMPLETED' : 'PREVIEW_COMPLETED';
  report.finishedAt = now(); await persist();
  return report;
}
