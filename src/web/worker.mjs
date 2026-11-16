import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runTask } from '../task-runner.mjs';
import { StopError } from '../utils.mjs';
import { redact, safeError } from './security.mjs';

// This fixed worker is forked by the local manager after it owns the common lock.
// Browser console output is deliberately not part of the monitoring protocol.
console.log = () => {};
console.error = () => {};
console.warn = () => {};
let started = false;
let pendingPrompt = null;
const send = message => new Promise(resolve => {
  if (!process.connected || !process.send) return resolve(false);
  try { process.send(message, error => resolve(!error)); }
  catch { resolve(false); }
});
const disconnected = () => new StopError('LOGIN_REQUIRED', 'The local operator connection closed. Reopen the dashboard and review the execution report before retrying.');
function rejectPrompt(error) {
  if (!pendingPrompt) return;
  clearTimeout(pendingPrompt.timer);
  pendingPrompt.reject(error); pendingPrompt = null;
}
async function ask(message) {
  if (!process.connected) throw disconnected();
  if (pendingPrompt) throw new StopError('OPERATOR_STATE', 'Another operator action is already pending.');
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => rejectPrompt(new StopError('LOGIN_REQUIRED', 'The operator login confirmation timed out. Review the application session before retrying.')), 10 * 60 * 1000);
    pendingPrompt = { id, resolve, reject, timer };
    send({ type: 'prompt', id, message: redact(message).slice(0, 1000) }).then(sent => { if (!sent) rejectPrompt(disconnected()); });
  });
}

function webInput(taskId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.apply !== 'boolean') throw new StopError('INPUT', 'The worker requires validated task input.');
  if (taskId === 'erp-deactivation') {
    if (!['staging', 'production'].includes(input.environment)) throw new StopError('WRONG_ENVIRONMENT', 'ERP execution runs only in staging or production.');
    if (typeof input.partner !== 'string' || !input.partner.trim() || input.partner.length > 200 || /[\u0000-\u001f<>]/.test(input.partner)) throw new StopError('INPUT', 'Provide an exact valid staging partner name.');
    if (input.pagination !== 'auto') throw new StopError('INPUT', 'The dashboard uses automatic employee collection.');
    if (Object.keys(input).some(key => !['partner', 'pagination', 'apply', 'environment'].includes(key))) throw new StopError('INPUT', 'Unsupported ERP worker input.');
    return input;
  }
  if (taskId === 'deposit-refundability') {
    const demo = input.environment === 'offline-demo' && input.demo === true && input.manual !== true;
    const manual = input.environment === 'production-manual' && input.manual === true && input.demo !== true && ['north', 'south'].includes(input.tenant);
    if (!demo && !manual) throw new StopError('WRONG_ENVIRONMENT', 'Choose an offline demo or manual live deposit execution with an explicit tenant.');
    if (!Array.isArray(input.usernames) || input.usernames.some(username => typeof username !== 'string') || (input.tenant != null && !['north', 'south'].includes(input.tenant))) throw new StopError('INPUT', 'Invalid deposit worker input.');
    if (Object.keys(input).some(key => !['usernames', 'tenant', 'refundable', 'apply', 'environment', 'demo', 'manual'].includes(key))) throw new StopError('INPUT', 'Unsupported deposit worker input.');
    return input;
  }
  if (taskId === 'workforce-access') {
    if (input.environment !== 'staging') throw new StopError('WRONG_ENVIRONMENT', 'Workforce execution is restricted to staging.');
    if (!Array.isArray(input.usernames) || input.usernames.some(username => typeof username !== 'string') ||
        !['north', 'south', 'both'].includes(input.tenant) || !['grant', 'remove'].includes(input.action)) throw new StopError('INPUT', 'Workforce requires exact usernames, an approved tenant and an explicit grant or remove action.');
    if (Object.keys(input).some(key => !['usernames', 'tenant', 'action', 'apply', 'environment'].includes(key))) throw new StopError('INPUT', 'Unsupported Workforce worker input.');
    return input;
  }
  if (taskId === 'procare-subscriber-synchronization') {
    if (input.environment !== 'production') throw new StopError('WRONG_ENVIRONMENT', 'Subscriber synchronization runs only against North production Procare.');
    if (!Array.isArray(input.usernames) || input.usernames.some(username => typeof username !== 'string')) throw new StopError('INPUT', 'Subscriber synchronization requires exact usernames.');
    if (Object.keys(input).some(key => !['usernames', 'apply', 'environment'].includes(key))) throw new StopError('INPUT', 'Unsupported synchronization worker input.');
    return input;
  }
  throw new StopError('UNKNOWN_TASK', 'Unknown automation task.');
}
async function start(message) {
  try {
    if (typeof message.root !== 'string' || typeof message.outputDir !== 'string') throw new StopError('INPUT', 'A local execution directory is required.');
    const root = path.resolve(message.root), outputDir = path.resolve(message.outputDir);
    if (path.dirname(outputDir) !== path.join(root, 'output')) throw new StopError('INPUT', 'The execution directory must be inside the local output directory.');
    const input = webInput(message.taskId, message.input);
    const settings = {};
    if (typeof message.settings?.screenshots === 'boolean') settings.screenshots = message.settings.screenshots;
    if (typeof message.settings?.demoHeadless === 'boolean') settings.demoHeadless = message.settings.demoHeadless;
    const result = await runTask(message.taskId, input, {
      root, outputDir, ask, lockHeld: true, settings, approvedDeposits: message.approvedDeposits,
      onEvent: event => send({ type: 'event', event: event.type === 'checkpoint' ? { type: 'checkpoint' } : {
        type: 'stage', stage: redact(event.stage).slice(0, 80), message: redact(event.message).slice(0, 1000),
        ...(event.currentRecord ? { currentRecord: redact(event.currentRecord).slice(0, 200) } : {})
      } })
    });
    await send({ type: 'done', exitCode: result.exitCode });
    process.exitCode = result.exitCode;
  } catch (error) {
    await send({ type: 'failed', ...safeError(error) });
    process.exitCode = 1;
  } finally {
    rejectPrompt(disconnected());
    process.off('message', onMessage);
    if (process.connected) process.disconnect();
  }
}
function onMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'answer' && pendingPrompt?.id === message.id) {
    if (message.error) {
      const safe = safeError(message.error);
      rejectPrompt(new StopError(safe.code, safe.message));
    } else {
      clearTimeout(pendingPrompt.timer);
      const { resolve } = pendingPrompt; pendingPrompt = null; resolve('');
    }
  }
  if (message.type === 'start' && !started) { started = true; void start(message); }
}
process.on('message', onMessage);
// A disconnected browser tab never affects this IPC channel. If the server dies,
// finish any current automation safely; only a pending/future human login fails.
process.on('disconnect', () => { rejectPrompt(disconnected()); if (!started) process.off('message', onMessage); });
