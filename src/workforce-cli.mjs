import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireLock, csvCell, privateDir, safeName, timestamp, writeJson } from './utils.mjs';
import { validateWorkforceInput, runWorkforceTask } from './tasks/workforce-access.mjs';
import { createWorkforceSession, validateWorkforceConfig } from './integrations/workforce.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    username: { type: 'string', multiple: true }, tenant: { type: 'string' }, action: { type: 'string', default: 'grant' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  }, strict: true });
  if (args.help) {
    console.log(`Staging Workforce Sales group access (visible browser).

Preview:
  npm start -- --task workforce-access --username new.agent1 --tenant both
Save and verify approved staging changes:
  npm start -- --task workforce-access --username USERNAME --tenant both --action grant --apply
Remove approved staging group membership:
  npm start -- --task workforce-access --username USERNAME --tenant both --action remove --apply

Repeat --username for multiple users. --tenant north|south|both is required.
The first group in User Groups is selected by position, not its display name.
Missing users are reported per tenant; the other tenant still runs.
--action grant|remove selects the operation (default: grant for existing commands).
Omit --apply to preview either action. Already-correct membership is skipped.
Removal affects only the selected first Sales group, not other groups or accounts.
A Save is never blindly retried.
Credentials: WORKFORCE_USERNAME and WORKFORCE_PASSWORD in the local .env.
Production URLs are not supported by this staging implementation.`);
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/workforce-access.json'), 'utf8'));
  validateWorkforceConfig(config);
  const input = validateWorkforceInput({ usernames: args.username, tenant: args.tenant, action: args.action, apply: args.apply }, config.maxUsers);
  process.loadEnvFile(path.join(root, '.env'));
  const release = await acquireLock(path.join(root, '.state'));
  const directory = path.join(root, 'output', `${timestamp()}-workforce-${safeName(input.usernames[0])}`);
  const save = async report => {
    await writeJson(path.join(directory, 'report.json'), report);
    const fields = ['username', 'tenant', 'action', 'groupId', 'groupName', 'before', 'after', 'outcome', 'saveAttempted', 'message'];
    const rows = report.results.map(result => ({ ...result, groupId: result.group?.id, groupName: result.group?.name }));
    await fs.writeFile(path.join(directory, 'report.csv'), [fields.join(','), ...rows.map(row => fields.map(field => csvCell(row[field])).join(','))].join('\n') + '\n', { mode: 0o600 });
  };
  try {
    await privateDir(directory);
    console.log(`MODE: ${args.apply ? 'APPLY' : 'PREVIEW'} — ${input.action.toUpperCase()} staging group membership${args.apply ? '' : ' (no changes)'}`);
    const report = await runWorkforceTask({ usernames: input.usernames, tenant: args.tenant, action: input.action, apply: args.apply }, {
      config, checkpoint: save,
      openSession: () => createWorkforceSession(config, { username: process.env.WORKFORCE_USERNAME, password: process.env.WORKFORCE_PASSWORD }, { action: input.action, apply: args.apply, directory })
    });
    for (const result of report.results) console.log(`${result.username} / ${result.tenant}: ${result.outcome}${result.message ? ' — ' + result.message : ''}`);
    console.log(`Logout: ${report.cleanup.logout}; reports: ${directory}`);
    if (report.error) console.error(`${report.error.code}: ${report.error.message}`);
    if (report.status === 'COMPLETED_WITH_EXCEPTIONS') process.exitCode = 2;
  } finally { await release(); }
}
