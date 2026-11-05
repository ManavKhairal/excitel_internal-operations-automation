import fs from 'node:fs/promises';
import { syncFixture } from './subscriber-sync-fixture.mjs';
import { runTask } from '../src/task-runner.mjs';

// Reuse the real Procare sync browser fixture through the shared task runner.
// The fixture intercepts all browser traffic, so production Procare is never reached.
export async function procareSyncWebExecutor(browser, job, callbacks) {
  const config = { ...JSON.parse(await fs.readFile(new URL('../config/procare-subscriber-synchronization.json', import.meta.url))),
    headless: true, timeoutMs: 1400, slowMo: 0, screenshots: false };
  const fixture = await syncFixture(browser, config, { apply: job.input.apply });
  const result = await runTask('procare-subscriber-synchronization', job.input, {
    root: job.root, outputDir: job.outputDir, lockHeld: true, onEvent: callbacks.onEvent, ask: callbacks.ask,
    settings: { screenshots: false }, openSyncSession: () => fixture.session
  });
  return { exitCode: result.exitCode, events: fixture.events };
}
