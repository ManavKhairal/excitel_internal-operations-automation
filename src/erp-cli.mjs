#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { APPS, createSession } from './browser.mjs';
import { collectEmployees } from './procare.mjs';
import { processEmployee } from './corehr.mjs';
import { clean, timestamp, safeName, privateDir, writeJson, saveReport, diagnostics, acquireLock } from './utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({ options: {
  partner: { type: 'string' }, apply: { type: 'boolean', default: false },
  pagination: { type: 'string', default: 'auto' },
  'login-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
}, strict: true });

if (args.help) {
  console.log(`Staging-only Procare -> CoreHR employee deactivation\n
npm run login
npm start -- --partner "EXACT STAGING PARTNER NAME"
npm start -- --partner "EXACT STAGING PARTNER NAME" --apply
npm start -- --task erp-deactivation --partner "EXACT STAGING PARTNER NAME"
npm start -- --task deposit-refundability --help

Default is DRY RUN. Employee collection and pagination are automatic.
--apply              Save staging status changes without an extra confirmation prompt.
--pagination auto    Collect all pages using the configured Procare pager (default).
--pagination guided  Inspect each page manually and confirm the collected list.
--pagination single  Use only after confirming the full list fits on one page.

No Gmail, Zendesk, Joget, production mode, or automatic retry of Save is included.`);
  process.exit(0);
}
if (!args['login-only'] && !clean(args.partner)) throw new Error('Provide --partner "the exact staging partner name". Run npm start -- --help for examples.');
if (!['guided', 'auto', 'single'].includes(args.pagination)) throw new Error('--pagination must be guided, auto or single.');

try { await fs.access(path.join(root, '.env')); process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = JSON.parse(await fs.readFile(path.join(root, 'config', 'staging.json'), 'utf8'));
for (const name of ['timeoutMs', 'searchTimeoutMs', 'resultSettleMs', 'maxEmployees', 'maxPages']) {
  if (!Number.isInteger(config[name]) || config[name] <= 0) throw new Error(`config.${name} must be a positive integer.`);
}
const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = terminal ? prompt => terminal.question(prompt) : undefined;
const sessions = [];
let releaseLock;
let outputDir;
let active;
let report;
try {
  releaseLock = await acquireLock(path.join(root, '.state'));
  console.log(`\nMODE: ${args.apply ? 'APPLY - status saves enabled by --apply' : 'DRY RUN - no status changes'}\nProcare: ${APPS.procare}\nCoreHR: ${APPS.corehr}\n`);
  if (args['login-only']) {
    for (const kind of ['procare', 'corehr']) {
      active = await createSession(kind, config, root, { ask }); sessions.push(active);
      await active.ensureLogin();
      active.assertClear();
      console.log(`${kind}: staging session saved locally.`);
      await active.close(); sessions.pop(); active = null;
    }
  } else {
    outputDir = path.join(root, 'output', `${timestamp()}-${safeName(args.partner)}`);
    await privateDir(outputDir);
    active = await createSession('procare', config, root, { ask }); sessions.push(active);
    await active.ensureLogin();
    const manifest = await collectEmployees(active, clean(args.partner), config, { pagination: args.pagination, ask });
    await writeJson(path.join(outputDir, 'employees.json'), manifest);
    // Keep both sessions available for logout after the task report is saved.
    active = null;

    report = {
      environment: 'staging', mode: args.apply ? 'apply' : 'dry-run', partner: manifest.partner,
      collectedAt: manifest.collectedAt, startedAt: new Date().toISOString(), finishedAt: null,
      status: 'IN_PROGRESS',
      results: manifest.usernames.map(username => ({ username, outcome: 'NOT_PROCESSED', message: 'Not started.' }))
    };
    await saveReport(outputDir, report);
    if (args.apply) {
      console.log(`\nApplying staging status changes for ${manifest.usernames.length} employee usernames for ${manifest.partner.name}.\nAlready-inactive users will be skipped.\n`);
    }
    active = await createSession('corehr', config, root, { ask }); sessions.push(active);
    await active.ensureLogin();
    let halted = false;
    for (let index = 0; index < manifest.usernames.length; index++) {
      const username = manifest.usernames[index];
      console.log(`[${index + 1}/${manifest.usernames.length}] ${username}`);
      const { result, stopBatch } = await processEmployee(active, username, config, {
        apply: args.apply, outputDir,
        onCheckpoint: async checkpoint => { report.results[index] = checkpoint; await saveReport(outputDir, report); }
      });
      report.results[index] = result;
      await saveReport(outputDir, report);
      console.log(`  ${result.outcome}: ${result.message}`);
      if (stopBatch) { halted = true; console.error('Batch stopped. Remaining employees are NOT_PROCESSED. Inspect the report before rerunning.'); break; }
    }
    const cleanOutcomes = new Set(['DRY_RUN_ACTIVE', 'ALREADY_INACTIVE', 'DEACTIVATED_VERIFIED']);
    report.status = halted ? 'HALTED_FOR_REVIEW' : report.results.every(row => cleanOutcomes.has(row.outcome)) ? 'COMPLETED' : 'COMPLETED_WITH_EXCEPTIONS';
    report.finishedAt = new Date().toISOString();
    await saveReport(outputDir, report);
    console.log('\nBatch summary:');
    for (const [outcome, count] of Object.entries(report.summary)) console.log(`  ${outcome}: ${count}`);
    console.log(`\nReports: ${outputDir}\n  employees.json\n  report.json\n  report.csv`);
    if (report.status !== 'COMPLETED') process.exitCode = 2;
  }
} catch (error) {
  console.error(`\nSTOPPED: ${error.code || error.name}: ${error.message.split('\n')[0]}`);
  if (outputDir) {
    if (active) await diagnostics(active.page, outputDir, 'stopped', config.screenshots).catch(() => {});
    await writeJson(path.join(outputDir, 'error.json'), { code: error.code || error.name, message: error.message.split('\n')[0], time: new Date().toISOString() }).catch(() => {});
    if (report) {
      report.status = 'HALTED_FOR_REVIEW'; report.finishedAt = new Date().toISOString();
      await saveReport(outputDir, report).catch(() => {});
    }
    console.error(`Local diagnostics/reports: ${outputDir}`);
  }
  process.exitCode = 1;
} finally {
  const cleanup = { status: 'COMPLETED', results: [], finishedAt: null };
  for (const session of sessions.reverse()) {
    if (!args['login-only']) {
      try {
        const result = await session.logout();
        cleanup.results.push(result);
        console.log(`${session.kind}: ${result.outcome} — ${result.message}`);
      } catch (error) {
        cleanup.status = 'COMPLETED_WITH_ERRORS';
        cleanup.results.push({ application: session.kind, outcome: 'LOGOUT_FAILED', code: error.code || error.name, message: error.message.split('\n')[0], finishedAt: new Date().toISOString() });
        console.error(`${session.kind}: logout could not be verified. ${error.message.split('\n')[0]}`);
        if (outputDir) await diagnostics(session.page, outputDir, `${session.kind}-logout-failed`, config.screenshots).catch(() => {});
      }
    }
    try { await session.close(); }
    catch (error) {
      cleanup.status = 'COMPLETED_WITH_ERRORS';
      cleanup.results.push({ application: session.kind, outcome: 'BROWSER_CLOSE_FAILED', message: error.message.split('\n')[0], finishedAt: new Date().toISOString() });
      console.error(`${session.kind}: browser cleanup failed.`);
    }
  }
  cleanup.finishedAt = new Date().toISOString();
  if (outputDir) {
    // Also covers failures before employee collection created a task report.
    try { await writeJson(path.join(outputDir, 'logout.json'), cleanup); }
    catch { console.error('Could not save logout.json.'); process.exitCode ||= 3; }
    if (report) {
      report.cleanup = cleanup;
      try { await saveReport(outputDir, report); }
      catch { console.error('Could not add logout results to report.json; check logout.json.'); process.exitCode ||= 3; }
    }
  }
  if (cleanup.status === 'COMPLETED_WITH_ERRORS') process.exitCode ||= 3;
  if (releaseLock) await releaseLock().catch(() => {});
  terminal?.close();
}
