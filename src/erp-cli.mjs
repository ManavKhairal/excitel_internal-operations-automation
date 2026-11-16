#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTask } from './task-runner.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({ args: argv, options: {
    partner: { type: 'string' }, apply: { type: 'boolean', default: false },
    pagination: { type: 'string', default: 'auto' }, environment: { type: 'string', default: 'staging' },
    'login-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  }, strict: true });
  if (args.help) {
    console.log(`Procare -> CoreHR employee deactivation (staging by default, production on request)\n
npm run login
npm start -- --partner "EXACT STAGING PARTNER NAME"
npm start -- --partner "EXACT STAGING PARTNER NAME" --apply
npm start -- --task erp-deactivation --partner "EXACT STAGING PARTNER NAME"

Production (URLs in config/production.json, PROCARE_PROD_* / COREHR_PROD_* in .env):
npm run login -- --environment production
npm start -- --environment production --partner "EXACT PRODUCTION PARTNER NAME"
npm start -- --environment production --partner "EXACT PRODUCTION PARTNER NAME" --apply

npm start -- --task deposit-refundability --help
npm start -- --task workforce-access --help
npm start -- --task procare-subscriber-synchronization --help

Default is DRY RUN. Employee collection and pagination are automatic.
--environment staging|production  Default staging. Production changes real CoreHR employees.
--apply              Save status changes without an extra confirmation prompt.
--pagination auto    Collect all pages using the configured Procare pager (default).
--pagination guided  Inspect each page manually and confirm the collected list.
--pagination single  Use only after confirming the full list fits on one page.

No Gmail, Zendesk, Joget, or automatic retry of Save is included.`);
    return;
  }
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const result = await runTask('erp-deactivation', args, {
      ask: terminal ? prompt => terminal.question(prompt) : undefined
    });
    if (result.exitCode) process.exitCode = result.exitCode;
  } finally { terminal?.close(); }
}

// Preserve direct invocation in addition to the central task-selection CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`STOPPED: ${error.code || error.name}: ${error.message.split('\n')[0]}`); process.exitCode = 1; }
}
