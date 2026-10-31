import { parseArgs } from 'node:util';
import { runTask } from './task-runner.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    username: { type: 'string', multiple: true }, tenant: { type: 'string' }, action: { type: 'string', default: 'grant' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
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
  const result = await runTask('workforce-access', { usernames: args.username, tenant: args.tenant, action: args.action, apply: args.apply, environment: 'staging' });
  if (result.exitCode) process.exitCode = result.exitCode;
}
