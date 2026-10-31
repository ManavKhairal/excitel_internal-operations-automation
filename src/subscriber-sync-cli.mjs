import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireLock, csvCell, privateDir, safeName, timestamp, writeJson, StopError } from './utils.mjs';
import { validateSyncInput, runSubscriberSync } from './tasks/procare-subscriber-synchronization.mjs';
import { validateSyncConfig, createProcareSyncSession } from './integrations/procare-subscriber-sync.mjs';
import { loadSyncWorkbook } from './integrations/sync-workbook.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    'input-file': { type: 'string' }, workbook: { type: 'string' }, limit: { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  }, strict: true });
  if (args.help) {
    console.log(`North production Procare subscriber synchronization (visible browser).

Preview the users read from the specified Google Sheet:
  npm start -- --task procare-subscriber-synchronization --input-file .state/procare-sync-users.json
Synchronize that reviewed batch:
  npm start -- --task procare-subscriber-synchronization --input-file .state/procare-sync-users.json --apply

For a local Excel workbook, use --workbook /path/to/users.xlsx instead of --input-file.
Optionally pass --limit <number> to process only the first N pending usernames.
Exact headers Username and Status are required. Apply updates only Status cells,
backs up the workbook, skips SYNCHRONIZED entries and stops on uncertain attempts.
Preview never changes the workbook. Keep the workbook closed during apply.
JSON input is a private snapshot with tenant, source metadata and exact usernames;
JSON mode does not update the source sheet.
Credentials: PROCARE_SYNC_USERNAME and PROCARE_SYNC_PASSWORD in local .env.
Preview performs no synchronization. Apply requires reviewed production UI.
Each exact subscriber is synchronized at most once per run; an uncertain
response stops the batch. Inspect reports before restarting an interrupted run.`);
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/procare-subscriber-synchronization.json'), 'utf8'));
  validateSyncConfig(config);
  if (Boolean(args['input-file']) === Boolean(args.workbook)) throw new StopError('SHEET_INPUT', 'Provide exactly one of --input-file or --workbook.');
  const limit = args.limit ? parseInt(args.limit, 10) : undefined;
  if (args.limit && (!Number.isInteger(limit) || limit < 1)) throw new StopError('LIMIT', 'Limit must be a positive integer.');
  const workbook = args.workbook ? await loadSyncWorkbook(args.workbook, { limit }) : null;
  let snapshot = workbook?.snapshot || JSON.parse(await fs.readFile(path.resolve(args['input-file']), 'utf8'));
  if (!workbook && limit) {
    snapshot = { ...snapshot, usernames: snapshot.usernames.slice(0, limit) };
  }
  const input = validateSyncInput(snapshot, config.maxUsers);
  if (args.apply && !config.liveUiReviewed) throw new StopError('SYNC_UI_NOT_REVIEWED', 'Production synchronization awaits the first reviewed preview.');
  process.loadEnvFile(path.join(root, '.env'));
  const credentials = { username: process.env.PROCARE_SYNC_USERNAME, password: process.env.PROCARE_SYNC_PASSWORD };
  if (!credentials.username || !credentials.password) throw new StopError('LOGIN_CONFIG', 'Fill PROCARE_SYNC_USERNAME and PROCARE_SYNC_PASSWORD in the local .env.');
  const release = await acquireLock(path.join(root, '.state'));
  const directory = path.join(root, 'output', `${timestamp()}-procare-sync-${safeName(input.usernames[0])}`);
  const loggedOutcomes = new Map();
  const save = async report => {
    await writeJson(path.join(directory, 'report.json'), report);
    const fields = ['username', 'subscriberId', 'outcome', 'syncAttempted', 'requestDispatched', 'finishedAt', 'message'];
    await fs.writeFile(path.join(directory, 'report.csv'), [fields.join(','), ...report.results.map(result => fields.map(field => csvCell(field === 'message' ? result.error?.message : result[field])).join(','))].join('\n') + '\n', { mode: 0o600 });
    if (workbook && args.apply) await workbook.checkpoint(report);
    for (let i = 0; i < report.results.length; i++) {
      const res = report.results[i];
      if (res.outcome !== 'NOT_PROCESSED' && loggedOutcomes.get(res.username) !== res.outcome) {
        loggedOutcomes.set(res.username, res.outcome);
        console.log(`[${i + 1}/${report.results.length}] ${res.username}: ${res.outcome}${res.error ? ' — ' + res.error.message : ''}`);
      }
    }
  };
  try {
    await privateDir(directory);
    if (workbook && args.apply) console.log(`Workbook backup: ${await workbook.backup(directory)}`);
    console.log(`MODE: ${args.apply ? 'APPLY' : 'PREVIEW'} — ${input.usernames.length} unique North subscriber(s).`);
    const report = await runSubscriberSync(snapshot, { config, apply: args.apply, checkpoint: save,
      openSession: () => createProcareSyncSession(config, credentials, { apply: args.apply, directory }) });
    console.log(`Logout: ${report.cleanup.logout}; reports: ${directory}`);
    if (report.error) console.error(`${report.error.code}: ${report.error.message}`);
    if (report.status === 'COMPLETED_WITH_EXCEPTIONS') process.exitCode = 2;
  } finally { await release(); }
}
