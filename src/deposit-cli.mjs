import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireLock, csvCell, privateDir, safeName, StopError, timestamp, writeJson } from './utils.mjs';
import { runDepositTask, validateInput } from './tasks/deposit-refundability.mjs';
import { DepositSheets, googleSheetsTransport } from './integrations/deposit-sheets.mjs';
import { assertPreviewConfigured, createPmaPreview } from './integrations/phpmyadmin.mjs';

export async function saveDepositReport(directory, report) {
  const counts = {};
  for (const result of report.results) for (const row of result.rows) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  report.summary = counts;
  await writeJson(path.join(directory, 'report.json'), report);
  const fields = ['username', 'tenant', 'recordKey', 'subscriberId', 'isCovered', 'isBundled', 'before', 'after', 'saveAttempted', 'outcome', 'sheetStatus', 'message'];
  const lines = [fields.map(csvCell).join(',')];
  for (const result of report.results) {
    for (const row of result.rows.length ? result.rows : [{}]) {
      const values = { ...row, username: result.username, tenant: result.tenant, recordKey: row.key,
        outcome: row.outcome || result.outcome, sheetStatus: result.sheet.status, message: result.error?.message || result.sheet.error?.message || '' };
      lines.push(fields.map(field => csvCell(values[field])).join(','));
    }
  }
  await fs.writeFile(path.join(directory, 'report.csv'), lines.join('\n') + '\n', { mode: 0o600 });
}
export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    username: { type: 'string', multiple: true }, tenant: { type: 'string' },
    demo: { type: 'boolean', default: false }, apply: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }, strict: true });
  if (args.help) {
    console.log(`Deposit refundability: Google Sheets eligibility -> per-row validation -> verified completion.

Offline preview (synthetic records only):
  npm start -- --task deposit-refundability --demo --username demo.north
Offline save and sheet-recording simulation:
  npm start -- --task deposit-refundability --demo --username demo.north --apply
Multiple inputs: repeat --username. Optional --tenant north|south (Delhi/DEL/Hyderabad/HYD accepted).

Default is preview. --demo never accesses company systems or Google.
The browser opens visibly by default (config headless: false).
Production writes are disabled in code. Live preview is also disabled until
Google authorization, database schema and UI selectors are reviewed.
Without --task, existing ERP commands keep their original behavior.`);
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/deposit-refundability.json'), 'utf8'));
  for (const key of ['timeoutMs', 'maxUsers', 'maxDepositsPerUser']) if (!Number.isInteger(config[key]) || config[key] <= 0) throw new StopError('CONFIG', `${key} must be a positive integer.`);
  if (config.headless !== undefined && typeof config.headless !== 'boolean') throw new StopError('CONFIG', 'headless must be true or false.');
  const input = validateInput({ usernames: args.username, tenant: args.tenant, apply: args.apply }, config.maxUsers);
  // All live gates run BEFORE .env loading, API access or browser creation.
  if (!args.demo) {
    if (input.apply) throw new StopError('LIVE_WRITES_DISABLED', 'Production database and sheet updates are disabled. No external action was attempted.');
    assertPreviewConfigured(config);
  }
  const releaseLock = await acquireLock(path.join(root, '.state'));
  let services;
  const directory = path.join(root, 'output', `${timestamp()}-deposit-${args.demo ? 'demo-' : ''}${safeName(input.usernames[0])}`);
  try {
    await privateDir(directory);
    if (args.demo) {
      const { createDemoServices } = await import('./demo/deposit-demo.mjs');
      services = await createDemoServices(config);
      console.log('OFFLINE DEMO: synthetic browser pages and an in-memory spreadsheet. No company access.');
    } else {
      try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      services = {
        sheets: new DepositSheets(googleSheetsTransport(config, { accessToken: process.env.GOOGLE_SHEETS_ACCESS_TOKEN }), config),
        openDatabase: tenant => createPmaPreview(tenant, config, { username: process.env[`PMA_${tenant.toUpperCase()}_USERNAME`], password: process.env[`PMA_${tenant.toUpperCase()}_PASSWORD`] }),
        close: async () => {}
      };
    }
    console.log(`MODE: ${input.apply ? 'DEMO APPLY' : 'PREVIEW — no deposit or sheet writes'}`);
    const report = await runDepositTask(input, { ...services, config, environment: args.demo ? 'offline-demo' : 'production-preview', checkpoint: value => saveDepositReport(directory, value) });
    for (const result of report.results) {
      console.log(`${result.username}: ${result.outcome}${result.error ? ' — ' + result.error.message : ''}`);
      for (const row of result.rows) console.log(`  Deposit ${row.key}: ${row.outcome}`);
      console.log(`  Logout: ${result.logout || 'NOT_REQUIRED'}; sheet: ${result.sheet.status}`);
    }
    console.log(`Reports: ${directory}`);
    if (report.status === 'COMPLETED_WITH_EXCEPTIONS') process.exitCode = 2;
  } catch (error) {
    await writeJson(path.join(directory, 'error.json'), { code: error.code || 'FAILED', message: error.message.split('\n')[0] }).catch(() => {});
    throw error;
  } finally {
    try {
      if (services?.state) await writeJson(path.join(directory, 'demo-state.json'), services.state);
    } finally {
      try { await services?.close(); } finally { await releaseLock(); }
    }
  }
}
