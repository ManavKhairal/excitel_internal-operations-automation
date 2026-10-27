import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APPS } from '../src/browser.mjs';
import { tempDir, testConfig } from './fixtures.mjs';

const run = promisify(execFile);
const fixturesUrl = new URL('./fixtures.mjs', import.meta.url).href;

// Run the real CLI, collector, employee processor, and report writer. Replace
// only live login/browser creation with offline DOM fixtures in a private copy.
for (const apply of [false, true]) {
  test(`CLI ${apply ? '--apply saves once' : 'default preview saves nothing'} without terminal input`, async () => {
    const root = await tempDir();
    try {
      await fs.cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
      await fs.mkdir(path.join(root, 'config'));
      await fs.writeFile(path.join(root, 'config/staging.json'), JSON.stringify(await testConfig()));
      await fs.writeFile(path.join(root, 'src/browser.mjs'), `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { testBrowser, procareFixture, corehrFixture } from ${JSON.stringify(fixturesUrl)};
        export const APPS = ${JSON.stringify(APPS)};
        export { assertStagingPage } from ${JSON.stringify(new URL('../src/browser.mjs', import.meta.url).href)};
        export async function createSession(kind, config, root) {
          const browser = await testBrowser();
          const fixture = kind === 'procare'
            ? await procareFixture(browser, [['alpha']]) : await corehrFixture(browser);
          return { ...fixture.session, async ensureLogin() {}, async close() {
            try {
              if (fixture.state) await fs.writeFile(path.join(root, 'corehr-state.json'), JSON.stringify(fixture.state));
              await fixture.context.close();
            } finally { await browser.close(); }
          } };
        }
      `);
      const args = [path.join(root, 'src/cli.mjs'), '--partner', 'Acme Staging Partner'];
      if (apply) args.push('--apply');
      const { stdout, stderr } = await run(process.execPath, args, { timeout: 20000 });
      assert.equal(stderr, '');
      assert.doesNotMatch(stdout, /Type DEACTIVATE|anything else to cancel|confirmation required/);
      const [directory] = await fs.readdir(path.join(root, 'output'));
      const report = JSON.parse(await fs.readFile(path.join(root, 'output', directory, 'report.json'), 'utf8'));
      const state = JSON.parse(await fs.readFile(path.join(root, 'corehr-state.json'), 'utf8'));
      assert.equal(report.status, 'COMPLETED');
      assert.equal(report.mode, apply ? 'apply' : 'dry-run');
      assert.equal(report.results[0].outcome, apply ? 'DEACTIVATED_VERIFIED' : 'DRY_RUN_ACTIVE');
      assert.equal(report.results[0].saveAttempted, apply);
      assert.deepEqual(state.saves, apply ? ['alpha'] : []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
