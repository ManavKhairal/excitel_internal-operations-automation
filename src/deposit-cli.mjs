import { parseArgs } from 'node:util';
import { runTask } from './task-runner.mjs';
export { saveDepositReport } from './task-runner.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    username: { type: 'string', multiple: true }, tenant: { type: 'string' }, refundable: { type: 'string', default: '1' },
    demo: { type: 'boolean', default: false }, apply: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }, strict: true });
  if (args.help) {
    console.log(`Deposit refundability: Google Sheets eligibility -> per-row validation -> verified completion.

Offline preview (synthetic records only):
  npm start -- --task deposit-refundability --demo --username demo.north
Offline save and sheet-recording simulation:
  npm start -- --task deposit-refundability --demo --username demo.north --apply
Mark non-refundable (1 -> 0), offline simulation:
  npm start -- --task deposit-refundability --demo --username demo.north --refundable 0 --apply
--refundable 1 (default): 0 -> 1; record in Changes reverted.
--refundable 0: 1 -> 0; record username in Managed users.
Multiple inputs: repeat --username. Optional --tenant north|south (Delhi/DEL/Hyderabad/HYD accepted).

Default is preview. --demo never accesses company systems or Google.
The browser opens visibly by default (config headless: false).
Production writes are disabled in code. Live preview is also disabled until
Google authorization, database schema and UI selectors are reviewed.
Without --task, existing ERP commands keep their original behavior.`);
    return;
  }
  const result = await runTask('deposit-refundability', {
    usernames: args.username, tenant: args.tenant, refundable: args.refundable,
    demo: args.demo, apply: args.apply, environment: args.demo ? 'offline-demo' : 'production-preview'
  });
  if (result.exitCode) process.exitCode = result.exitCode;
}
