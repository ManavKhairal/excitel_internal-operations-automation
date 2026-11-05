import { taskCatalog } from '../task-registry.mjs';
import { validateInput } from '../tasks/deposit-refundability.mjs';
import { validateWorkforceInput } from '../tasks/workforce-access.mjs';
import { validateSyncInput, dashboardSyncSnapshot } from '../tasks/procare-subscriber-synchronization.mjs';
import { HttpError, onlyKeys, assertObject } from './security.mjs';

export const PROCARE_DASHBOARD_MAX_USERS = 100;

export function validateRequest(body, maxUsers = 20) {
  onlyKeys(body, ['taskId', 'environment', 'mode', 'input', 'idempotencyKey', 'previewId', 'confirmed', 'direct']);
  const task = taskCatalog.find(task => task.id === body.taskId);
  if (!task) throw new HttpError(400, 'UNKNOWN_TASK', 'Select an available automation task.');
  if (!task.environments.includes(body.environment)) throw new HttpError(400, 'ENVIRONMENT_DISABLED', 'Choose an environment supported by the selected task.');
  if (!['preview', 'apply'].includes(body.mode) || !task.modes.includes(body.mode)) throw new HttpError(400, 'INVALID_MODE', 'Choose a mode supported by this task.');
  if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey)) throw new HttpError(400, 'INVALID_REQUEST_KEY', 'A unique request key of 16–100 characters is required.');
  assertObject(body.input, 'Task inputs');
  let input;
  if (task.id === 'erp-deactivation') {
    onlyKeys(body.input, ['partner', 'pagination']);
    if (typeof body.input.partner !== 'string' || !body.input.partner.trim() || body.input.partner.length > 200 || /[\u0000-\u001f<>]/.test(body.input.partner)) throw new HttpError(400, 'INVALID_PARTNER', 'Enter an exact partner name (1–200 characters).');
    if (body.input.pagination !== undefined && body.input.pagination !== 'auto') throw new HttpError(400, 'INVALID_PAGINATION', 'The dashboard supports automatic pagination. Use the CLI for guided collection.');
    input = { partner: body.input.partner.replace(/\s+/g, ' ').trim(), pagination: 'auto' };
  } else if (task.id === 'deposit-refundability') {
    onlyKeys(body.input, ['usernames', 'tenant', 'refundable']);
    if (!Array.isArray(body.input.usernames) || body.input.usernames.some(value => typeof value !== 'string')) throw new HttpError(400, 'INVALID_USERNAMES', 'Provide a list of usernames.');
    if (body.input.tenant !== undefined && !['', 'auto', 'north', 'south'].includes(body.input.tenant)) throw new HttpError(400, 'INVALID_TENANT', 'Select automatic tenant detection, north, or south.');
    try {
      const valid = validateInput({ ...body.input, manual: body.environment === 'production-manual', tenant: ['', 'auto'].includes(body.input.tenant) ? undefined : body.input.tenant, apply: body.mode === 'apply' }, maxUsers);
      input = { usernames: valid.usernames, refundable: valid.refundable, ...(valid.tenant ? { tenant: valid.tenant } : {}) };
    } catch (error) { throw new HttpError(400, error.code || 'INVALID_INPUT', error.message); }
  } else if (task.id === 'workforce-access') {
    onlyKeys(body.input, ['usernames', 'tenant', 'action']);
    if (!Array.isArray(body.input.usernames) || body.input.usernames.some(value => typeof value !== 'string')) throw new HttpError(400, 'INVALID_USERNAMES', 'Provide a list of exact usernames.');
    if (!['north', 'south', 'both'].includes(body.input.tenant)) throw new HttpError(400, 'INVALID_TENANT', 'Choose the approved North, South or both-tenant scope.');
    if (!['grant', 'remove'].includes(body.input.action)) throw new HttpError(400, 'INVALID_ACTION', 'Choose grant or remove explicitly.');
    try {
      const valid = validateWorkforceInput({ ...body.input, apply: body.mode === 'apply' }, maxUsers);
      input = { usernames: valid.usernames, tenant: body.input.tenant, action: valid.action };
    } catch (error) { throw new HttpError(400, error.code || 'INVALID_INPUT', error.message); }
  } else if (task.id === 'procare-subscriber-synchronization') {
    onlyKeys(body.input, ['usernames']);
    if (!Array.isArray(body.input.usernames) || body.input.usernames.some(value => typeof value !== 'string')) throw new HttpError(400, 'INVALID_USERNAMES', 'Provide a list of exact usernames.');
    try {
      const valid = validateSyncInput(dashboardSyncSnapshot(body.input.usernames), PROCARE_DASHBOARD_MAX_USERS);
      input = { usernames: valid.usernames };
    } catch (error) {
      throw new HttpError(400, error.code === 'SHEET_INPUT' ? 'INVALID_USERNAMES' : error.code || 'INVALID_INPUT',
        error.code === 'SHEET_INPUT' ? `Provide 1–${PROCARE_DASHBOARD_MAX_USERS} exact usernames. Use the CLI --workbook option for larger batches.` : error.message);
    }
  } else {
    throw new HttpError(400, 'TASK_UNAVAILABLE', 'This task has not yet registered a server-side input validator.');
  }
  const direct = body.direct !== undefined;
  if (direct) {
    if (body.direct !== true || body.mode !== 'apply' || task.directApply !== true) throw new HttpError(400, 'DIRECT_APPLY_UNAVAILABLE', 'This task requires a reviewed preview before apply.');
    if (body.confirmed !== true || body.previewId !== undefined) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Explicitly confirm the direct apply. A direct apply does not reference a preview.');
  } else if (body.mode === 'apply' && (body.confirmed !== true || typeof body.previewId !== 'string')) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Review a successful preview and explicitly confirm its apply operation.');
  if (body.mode === 'preview' && (body.confirmed !== undefined || body.previewId !== undefined)) throw new HttpError(400, 'INVALID_INPUT', 'Preview requests cannot include apply approval.');
  return { task, taskId: task.id, environment: body.environment, mode: body.mode, input, idempotencyKey: body.idempotencyKey, previewId: body.previewId || null, direct };
}
