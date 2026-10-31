import fs from 'node:fs/promises';
import { workforceFixture } from './workforce-fixture.mjs';
import { runTask } from '../src/task-runner.mjs';

// Reuse the real Workforce browser fixture and the CLI/web shared task runner.
// The fixture intercepts all browser traffic, so no company origin is reached.
export async function workforceWebExecutor(browser, job, callbacks) {
  const config = { ...JSON.parse(await fs.readFile(new URL('../config/workforce-access.json', import.meta.url))),
    timeoutMs: 1600, headless: true, slowMo: 0, screenshots: false };
  const options = job.input.action === 'remove' ? { already: ['north', 'south'] } : {};
  const fixture = await workforceFixture(browser, config, options, job.input.apply, job.input.action);
  const result = await runTask('workforce-access', job.input, {
    root: job.root, outputDir: job.outputDir, lockHeld: true, onEvent: callbacks.onEvent, ask: callbacks.ask,
    settings: { screenshots: false }, openWorkforceSession: () => fixture.session
  });
  return { exitCode: result.exitCode };
}
