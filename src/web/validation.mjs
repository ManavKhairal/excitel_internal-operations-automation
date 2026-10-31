import { taskCatalog } from '../task-registry.mjs';
import { validateInput } from '../tasks/deposit-refundability.mjs';
import { HttpError, onlyKeys, assertObject } from './security.mjs';

export function validateRequest(body, maxUsers = 20) {
  onlyKeys(body, ['taskId', 'environment', 'mode', 'input', 'idempotencyKey', 'previewId', 'confirmed']);
  const task = taskCatalog.find(task => task.id === body.taskId);
  if (!task) throw new HttpError(400, 'UNKNOWN_TASK', 'Select an available automation task.');
  if (!['staging', 'offline-demo'].includes(body.environment) || !task.environments.includes(body.environment)) throw new HttpError(400, 'ENVIRONMENT_DISABLED', 'Only the listed staging or offline demo environment is enabled. Production execution is disabled.');
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
      const valid = validateInput({ ...body.input, tenant: ['', 'auto'].includes(body.input.tenant) ? undefined : body.input.tenant, apply: body.mode === 'apply' }, maxUsers);
      input = { usernames: valid.usernames, refundable: valid.refundable, ...(valid.tenant ? { tenant: valid.tenant } : {}) };
    } catch (error) { throw new HttpError(400, error.code || 'INVALID_INPUT', error.message); }
  } else {
    throw new HttpError(400, 'TASK_UNAVAILABLE', 'This task has not yet registered a server-side input validator.');
  }
  if (body.mode === 'apply' && (body.confirmed !== true || typeof body.previewId !== 'string')) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Review a successful preview and explicitly confirm its apply operation.');
  if (body.mode === 'preview' && (body.confirmed !== undefined || body.previewId !== undefined)) throw new HttpError(400, 'INVALID_INPUT', 'Preview requests cannot include apply approval.');
  return { task, taskId: task.id, environment: body.environment, mode: body.mode, input, idempotencyKey: body.idempotencyKey, previewId: body.previewId || null };
}
