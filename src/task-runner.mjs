import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, createSession } from './browser.mjs';
import { collectEmployees } from './procare.mjs';
import { processEmployee } from './corehr.mjs';
import { clean, timestamp, safeName, privateDir, writeJson, saveReport, diagnostics, acquireLock, csvCell, StopError } from './utils.mjs';
import { runDepositTask, validateInput } from './tasks/deposit-refundability.mjs';
import { DepositSheets, googleSheetsTransport } from './integrations/deposit-sheets.mjs';
import { validateWorkforceInput, runWorkforceTask } from './tasks/workforce-access.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firstLine = error => String(error.message || 'Execution failed.').split('\n')[0];
async function loadEnvironment(root) {
  try { process.loadEnvFile(path.join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function readConfig(root, filename, positiveKeys) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'config', filename), 'utf8'));
  for (const key of positiveKeys) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new StopError('CONFIG', `config.${key} must be a positive integer.`);
  }
  return config;
}

// Both the CLI and the local web worker use these exact orchestration paths.
// The caller may already own the shared filesystem lock (the web manager does).
// Output paths and settings are server-side values, never browser-supplied paths.
export async function runTask(taskId, input, {
  root = defaultRoot, outputDir, ask, onEvent = async () => {}, lockHeld = false, settings = {}, openWorkforceSession
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StopError('INPUT', 'Task input must be an object.');
  if (input.apply !== undefined && typeof input.apply !== 'boolean') throw new StopError('INPUT', 'Apply must be true or false.');
  const context = { root, outputDir, ask, onEvent, lockHeld, settings, openWorkforceSession };
  if (taskId === 'erp-deactivation') return runErp(input, context);
  if (taskId === 'deposit-refundability') return runDeposit(input, context);
  if (taskId === 'workforce-access') return runWorkforce(input, context);
  throw new StopError('UNKNOWN_TASK', 'Unknown automation task.');
}

async function runErp(input, { root, outputDir: requestedOutput, ask, onEvent, lockHeld, settings }) {
  const args = { ...input, apply: input.apply === true, pagination: input.pagination || 'auto' };
  if (args.environment !== undefined && args.environment !== 'staging') throw new StopError('WRONG_ENVIRONMENT', 'ERP execution is restricted to staging.');
  if (!args['login-only'] && !clean(args.partner)) throw new StopError('INPUT', 'Provide --partner "the exact staging partner name". Run npm start -- --help for examples.');
  if (!['guided', 'auto', 'single'].includes(args.pagination)) throw new StopError('INPUT', '--pagination must be guided, auto or single.');
  const config = await readConfig(root, 'staging.json', ['timeoutMs', 'searchTimeoutMs', 'resultSettleMs', 'maxEmployees', 'maxPages']);
  if (typeof settings.screenshots === 'boolean') config.screenshots = settings.screenshots;
  await loadEnvironment(root);
  const stage = async (name, message, currentRecord) => onEvent({ type: 'stage', stage: name, message, ...(currentRecord ? { currentRecord } : {}) });
  const sessions = [];
  let releaseLock, outputDir, active, report, failure;
  let exitCode = 0;
  const persist = async () => { await saveReport(outputDir, report); await onEvent({ type: 'checkpoint' }); };
  try {
    if (!lockHeld) releaseLock = await acquireLock(path.join(root, '.state'));
    console.log(`\nMODE: ${args.apply ? 'APPLY - status saves enabled by --apply' : 'DRY RUN - no status changes'}\nProcare: ${APPS.procare}\nCoreHR: ${APPS.corehr}\n`);
    if (args['login-only']) {
      for (const kind of ['procare', 'corehr']) {
        await stage('authenticating', `Opening ${kind} and checking its staging session.`);
        active = await createSession(kind, config, root, { ask }); sessions.push(active);
        await active.ensureLogin();
        active.assertClear();
        console.log(`${kind}: staging session saved locally.`);
        await active.close(); sessions.pop(); active = null;
      }
    } else {
      outputDir = requestedOutput || path.join(root, 'output', `${timestamp()}-${safeName(args.partner)}`);
      await privateDir(outputDir);
      await stage('authenticating', 'Opening Procare and checking its staging session.');
      active = await createSession('procare', config, root, { ask }); sessions.push(active);
      await active.ensureLogin();
      await stage('collecting', 'Checking partner eligibility and collecting the current employee list.');
      const manifest = await collectEmployees(active, clean(args.partner), config, { pagination: args.pagination, ask });
      await writeJson(path.join(outputDir, 'employees.json'), manifest);
      // Keep both sessions available for verified logout after the task report.
      active = null;
      report = {
        environment: 'staging', mode: args.apply ? 'apply' : 'dry-run', partner: manifest.partner,
        collectedAt: manifest.collectedAt, startedAt: new Date().toISOString(), finishedAt: null,
        status: 'IN_PROGRESS',
        results: manifest.usernames.map(username => ({ username, outcome: 'NOT_PROCESSED', message: 'Not started.' }))
      };
      await persist();
      if (args.apply) console.log(`\nApplying staging status changes for ${manifest.usernames.length} employee usernames for ${manifest.partner.name}.\nAlready-inactive users will be skipped.\n`);
      await stage('authenticating', 'Opening CoreHR and checking its staging session.');
      active = await createSession('corehr', config, root, { ask }); sessions.push(active);
      await active.ensureLogin();
      let halted = false;
      for (let index = 0; index < manifest.usernames.length; index++) {
        const username = manifest.usernames[index];
        await stage('processing', `Checking employee ${index + 1} of ${manifest.usernames.length}.`, username);
        console.log(`[${index + 1}/${manifest.usernames.length}] ${username}`);
        const { result, stopBatch } = await processEmployee(active, username, config, {
          apply: args.apply, outputDir,
          onCheckpoint: async checkpoint => {
            report.results[index] = checkpoint;
            await persist();
            await stage('saving', 'A single status Save is being attempted; its outcome must be verified.', username);
          }
        });
        report.results[index] = result;
        await persist();
        console.log(`  ${result.outcome}: ${result.message}`);
        if (stopBatch) { halted = true; console.error('Batch stopped. Remaining employees are NOT_PROCESSED. Inspect the report before rerunning.'); break; }
      }
      const cleanOutcomes = new Set(['DRY_RUN_ACTIVE', 'ALREADY_INACTIVE', 'DEACTIVATED_VERIFIED']);
      report.status = halted ? 'HALTED_FOR_REVIEW' : report.results.every(row => cleanOutcomes.has(row.outcome)) ? 'COMPLETED' : 'COMPLETED_WITH_EXCEPTIONS';
      report.finishedAt = new Date().toISOString();
      await persist();
      console.log('\nBatch summary:');
      for (const [outcome, count] of Object.entries(report.summary)) console.log(`  ${outcome}: ${count}`);
      console.log(`\nReports: ${outputDir}\n  employees.json\n  report.json\n  report.csv`);
      if (report.status !== 'COMPLETED') exitCode = 2;
    }
  } catch (error) {
    failure = error; exitCode = 1;
    if (outputDir) {
      if (active) await diagnostics(active.page, outputDir, 'stopped', config.screenshots).catch(() => {});
      await writeJson(path.join(outputDir, 'error.json'), { code: error.code || error.name, message: firstLine(error), time: new Date().toISOString() }).catch(() => {});
      if (report) {
        report.status = 'HALTED_FOR_REVIEW'; report.finishedAt = new Date().toISOString();
        await persist().catch(() => {});
      }
    }
  } finally {
    if (sessions.length && !args['login-only']) await stage('cleanup', 'Saving results, signing out and verifying application logout.').catch(() => {});
    const cleanup = { status: 'COMPLETED', results: [], finishedAt: null };
    for (const session of sessions.reverse()) {
      if (!args['login-only']) {
        try {
          const result = await session.logout(); cleanup.results.push(result);
          console.log(`${session.kind}: ${result.outcome} — ${result.message}`);
        } catch (error) {
          cleanup.status = 'COMPLETED_WITH_ERRORS';
          cleanup.results.push({ application: session.kind, outcome: 'LOGOUT_FAILED', code: error.code || error.name, message: firstLine(error), finishedAt: new Date().toISOString() });
          console.error(`${session.kind}: logout could not be verified. ${firstLine(error)}`);
          if (outputDir) await diagnostics(session.page, outputDir, `${session.kind}-logout-failed`, config.screenshots).catch(() => {});
        }
      }
      try { await session.close(); }
      catch (error) {
        cleanup.status = 'COMPLETED_WITH_ERRORS';
        cleanup.results.push({ application: session.kind, outcome: 'BROWSER_CLOSE_FAILED', message: firstLine(error), finishedAt: new Date().toISOString() });
        console.error(`${session.kind}: browser cleanup failed.`);
      }
    }
    cleanup.finishedAt = new Date().toISOString();
    if (outputDir) {
      try { await writeJson(path.join(outputDir, 'logout.json'), cleanup); }
      catch { console.error('Could not save logout.json.'); exitCode ||= 3; }
      if (report) {
        report.cleanup = cleanup;
        try { await persist(); }
        catch { console.error('Could not add logout results to report.json; check logout.json.'); exitCode ||= 3; }
      }
    }
    if (cleanup.status === 'COMPLETED_WITH_ERRORS') exitCode ||= 3;
    if (releaseLock) await releaseLock().catch(() => {});
  }
  if (failure) throw failure;
  return { report, outputDir, exitCode };
}

export async function saveDepositReport(directory, report) {
  const counts = {};
  for (const result of report.results) for (const row of result.rows) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  report.summary = counts;
  await writeJson(path.join(directory, 'report.json'), report);
  const fields = ['username', 'tenant', 'targetRefundable', 'recordKey', 'subscriberId', 'isCovered', 'isBundled', 'before', 'after', 'saveAttempted', 'outcome', 'sheetStatus', 'message'];
  const lines = [fields.map(csvCell).join(',')];
  for (const result of report.results) {
    for (const row of result.rows.length ? result.rows : [{}]) {
      const values = { ...row, username: result.username, tenant: result.tenant, targetRefundable: result.targetRefundable ?? 1, recordKey: row.key,
        outcome: row.outcome || result.outcome, sheetStatus: result.sheet.status, message: result.error?.message || result.sheet.error?.message || '' };
      lines.push(fields.map(field => csvCell(values[field])).join(','));
    }
  }
  await fs.writeFile(path.join(directory, 'report.csv'), lines.join('\n') + '\n', { mode: 0o600 });
}

async function runDeposit(input, { root, outputDir, onEvent, lockHeld, settings }) {
  const { assertPreviewConfigured, createPmaPreview } = await import('./integrations/phpmyadmin.mjs');
  const config = await readConfig(root, 'deposit-refundability.json', ['timeoutMs', 'maxUsers', 'maxDepositsPerUser']);
  if (config.headless !== undefined && typeof config.headless !== 'boolean') throw new StopError('CONFIG', 'headless must be true or false.');
  if (typeof settings.demoHeadless === 'boolean') config.headless = settings.demoHeadless;
  const request = validateInput(input, config.maxUsers);
  const demo = input.demo === true;
  const environment = demo ? 'offline-demo' : 'production-preview';
  if (input.environment !== undefined && input.environment !== environment) throw new StopError('WRONG_ENVIRONMENT', 'The selected deposit environment does not match its execution mode.');
  // Preserve the legacy CLI gates before credentials, browser creation or API access.
  if (!demo) {
    if (request.apply) throw new StopError('LIVE_WRITES_DISABLED', 'Production database and sheet updates are disabled. No external action was attempted.');
    assertPreviewConfigured(config);
  }
  const releaseLock = lockHeld ? null : await acquireLock(path.join(root, '.state'));
  const directory = outputDir || path.join(root, 'output', `${timestamp()}-deposit-${demo ? 'demo-' : ''}${safeName(request.usernames[0])}`);
  const stage = async (name, message, currentRecord) => onEvent({ type: 'stage', stage: name, message, ...(currentRecord ? { currentRecord } : {}) });
  let services, report;
  try {
    await privateDir(directory);
    await stage('starting', demo ? 'Starting the isolated offline browser and in-memory sheets.' : 'Starting the reviewed read-only deposit services.');
    if (demo) {
      const { createDemoServices } = await import('./demo/deposit-demo.mjs');
      services = await createDemoServices(config);
      console.log('OFFLINE DEMO: synthetic browser pages and an in-memory spreadsheet. No company access.');
    } else {
      await loadEnvironment(root);
      services = {
        sheets: new DepositSheets(googleSheetsTransport(config, { accessToken: process.env.GOOGLE_SHEETS_ACCESS_TOKEN }), config),
        openDatabase: tenant => createPmaPreview(tenant, config, { username: process.env[`PMA_${tenant.toUpperCase()}_USERNAME`], password: process.env[`PMA_${tenant.toUpperCase()}_PASSWORD`] }),
        close: async () => {}
      };
    }
    // Wrap service operations to emit genuine stages without changing business rules.
    const sheets = {
      membership: async username => { await stage('validating', 'Checking membership in both tenant sheets.', username); return services.sheets.membership(username); },
      recordCompletion: async (...args) => { await stage('recording', 'Recording and verifying simulated sheet completion.', args[1]); return services.sheets.recordCompletion(...args); }
    };
    const openDatabase = async tenant => {
      await stage('authenticating', `Opening the ${tenant} deposit session.`);
      const database = await services.openDatabase(tenant);
      return {
        lookup: async username => { await stage('processing', 'Reading the exact deposit records and current eligibility.', username); return database.lookup(username); },
        prepareRefundable: async (row, target) => {
          const saveOnce = await database.prepareRefundable(row, target);
          return async () => { await stage('saving', 'Attempting one simulated save, followed by fresh verification.', row.username); return saveOnce(); };
        },
        logout: async () => { await stage('cleanup', `Signing out of the ${tenant} deposit session and verifying logout.`); return database.logout(); },
        close: () => database.close()
      };
    };
    console.log(`MODE: ${request.apply ? 'DEMO APPLY' : 'PREVIEW — no deposit or sheet writes'}`);
    console.log(`TARGET: refundable=${request.refundable}`);
    report = await runDepositTask(request, { sheets, openDatabase, config, environment, checkpoint: async value => {
      report = value; await saveDepositReport(directory, value); await onEvent({ type: 'checkpoint' });
    } });
    for (const result of report.results) {
      console.log(`${result.username}: ${result.outcome}${result.error ? ' — ' + result.error.message : ''}`);
      for (const row of result.rows) console.log(`  Deposit ${row.key}: ${row.outcome}`);
      console.log(`  Logout: ${result.logout || 'NOT_REQUIRED'}; sheet: ${result.sheet.status}`);
    }
    console.log(`Reports: ${directory}`);
    return { report, outputDir: directory, exitCode: report.status === 'COMPLETED_WITH_EXCEPTIONS' ? 2 : 0 };
  } catch (error) {
    await writeJson(path.join(directory, 'error.json'), { code: error.code || 'FAILED', message: firstLine(error) }).catch(() => {});
    throw error;
  } finally {
    try { if (services?.state) await writeJson(path.join(directory, 'demo-state.json'), services.state); }
    finally { try { await services?.close(); } finally { if (releaseLock) await releaseLock(); } }
  }
}

export async function saveWorkforceReport(directory, report) {
  await writeJson(path.join(directory, 'report.json'), report);
  const fields = ['username', 'tenant', 'action', 'groupId', 'groupName', 'before', 'after', 'outcome', 'saveAttempted', 'message'];
  const rows = report.results.map(result => ({ ...result, groupId: result.group?.id, groupName: result.group?.name }));
  await fs.writeFile(path.join(directory, 'report.csv'),
    [fields.join(','), ...rows.map(row => fields.map(field => csvCell(row[field])).join(','))].join('\n') + '\n', { mode: 0o600 });
}

async function runWorkforce(input, { root, outputDir, ask, onEvent, lockHeld, settings, openWorkforceSession }) {
  const { createWorkforceSession, validateWorkforceConfig } = await import('./integrations/workforce.mjs');
  const config = await readConfig(root, 'workforce-access.json', ['timeoutMs', 'maxUsers']);
  validateWorkforceConfig(config);
  if (input.environment !== undefined && input.environment !== 'staging') throw new StopError('WRONG_ENVIRONMENT', 'Workforce execution is restricted to staging.');
  const request = validateWorkforceInput(input, config.maxUsers);
  if (typeof settings.screenshots === 'boolean') config.screenshots = settings.screenshots;
  if (ask) config.headless = false;
  await loadEnvironment(root);
  const credentials = { username: process.env.WORKFORCE_USERNAME, password: process.env.WORKFORCE_PASSWORD };
  if (!ask && (!credentials.username || !credentials.password)) throw new StopError('LOGIN_CONFIG', 'Set WORKFORCE_USERNAME and WORKFORCE_PASSWORD in the local .env.');
  const releaseLock = lockHeld ? null : await acquireLock(path.join(root, '.state'));
  const directory = outputDir || path.join(root, 'output', `${timestamp()}-workforce-${safeName(request.usernames[0])}`);
  const stage = (name, message, currentRecord) => onEvent({ type: 'stage', stage: name, message, ...(currentRecord ? { currentRecord } : {}) });
  try {
    await privateDir(directory);
    await stage('authenticating', 'Opening staging Portal and checking the Workforce login.');
    console.log(`MODE: ${request.apply ? 'APPLY' : 'PREVIEW'} — ${request.action.toUpperCase()} staging group membership${request.apply ? '' : ' (no changes)'}`);
    const report = await runWorkforceTask({ usernames: request.usernames, tenant: input.tenant, action: request.action, apply: request.apply }, {
      config,
      checkpoint: async value => { await saveWorkforceReport(directory, value); await onEvent({ type: 'checkpoint' }); },
      onStage: stage,
      openSession: () => openWorkforceSession ? openWorkforceSession() : createWorkforceSession(config, credentials, { action: request.action, apply: request.apply, directory, ask })
    });
    for (const result of report.results) console.log(`${result.username} / ${result.tenant}: ${result.outcome}${result.message ? ' — ' + result.message : ''}`);
    console.log(`Logout: ${report.cleanup.logout}; reports: ${directory}`);
    if (report.error) console.error(`${report.error.code}: ${report.error.message}`);
    return { report, outputDir: directory, exitCode: report.status === 'COMPLETED_WITH_EXCEPTIONS' ? 2 : 0 };
  } catch (error) {
    await writeJson(path.join(directory, 'error.json'), { code: error.code || 'FAILED', message: firstLine(error) }).catch(() => {});
    throw error;
  } finally { if (releaseLock) await releaseLock(); }
}
