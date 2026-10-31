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
for (const scenario of [
  { name: 'default preview saves nothing', apply: false },
  { name: '--apply saves once', apply: true },
  { name: 'explicit ERP task dispatch preserves preview behavior', apply: false, explicitTask: true },
  { name: 'logout failure preserves successful employee results and closes both browsers', apply: true, logoutFails: true },
  { name: 'collection failure still logs out and records cleanup', collectionFails: true },
  { name: 'login-only preserves prepared sessions', loginOnly: true }
]) {
  test(`CLI ${scenario.name} without terminal input`, async () => {
    const { apply, logoutFails, collectionFails, loginOnly } = scenario;
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
            ? await procareFixture(browser, ${collectionFails ? '[[]]' : "[['alpha']]"}) : await corehrFixture(browser);
          const event = value => fs.appendFile(path.join(root, 'cleanup-events.jsonl'), JSON.stringify(value) + '\\n');
          return { ...fixture.session, kind,
            async ensureLogin() {},
            async logout() {
              const [directory] = await fs.readdir(path.join(root, 'output'));
              const report = await fs.readFile(path.join(root, 'output', directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => null);
              await event({ kind, action: 'logout', taskStatus: report?.status });
              if (${!!logoutFails} && kind === 'corehr') throw new Error('Fixture logout failure');
              return { application: kind, outcome: 'SIGNED_OUT_VERIFIED', message: 'Fixture signed out' };
            }, async close() {
            await event({ kind, action: 'close' });
            try {
              if (fixture.state) await fs.writeFile(path.join(root, 'corehr-state.json'), JSON.stringify(fixture.state));
              await fixture.context.close();
            } finally { await browser.close(); }
          } };
        }
      `);
      const args = [path.join(root, 'src/cli.mjs'), '--partner', 'Acme Staging Partner'];
      if (scenario.explicitTask) args.push('--task', 'erp-deactivation');
      if (apply) args.push('--apply');
      if (loginOnly) args.push('--login-only');
      const response = await run(process.execPath, args, { timeout: 20000 }).catch(error => {
        if (!logoutFails && !collectionFails) throw error;
        return error;
      });
      const { stdout, stderr } = response;
      assert.equal(response.code, collectionFails ? 1 : logoutFails ? 3 : undefined);
      if (!logoutFails && !collectionFails) assert.equal(stderr, '');
      assert.doesNotMatch(stdout, /Type DEACTIVATE|anything else to cancel|confirmation required/);
      const events = (await fs.readFile(path.join(root, 'cleanup-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      if (loginOnly) {
        assert.deepEqual(events, [{ kind: 'procare', action: 'close' }, { kind: 'corehr', action: 'close' }]);
        return;
      }
      const [directory] = await fs.readdir(path.join(root, 'output'));
      const cleanup = JSON.parse(await fs.readFile(path.join(root, 'output', directory, 'logout.json'), 'utf8'));
      if (collectionFails) {
        assert.deepEqual(events, [{ kind: 'procare', action: 'logout' }, { kind: 'procare', action: 'close' }]);
        assert.equal(cleanup.results[0].outcome, 'SIGNED_OUT_VERIFIED');
        return;
      }
      const report = JSON.parse(await fs.readFile(path.join(root, 'output', directory, 'report.json'), 'utf8'));
      const state = JSON.parse(await fs.readFile(path.join(root, 'corehr-state.json'), 'utf8'));
      assert.equal(report.status, 'COMPLETED');
      assert.equal(report.mode, apply ? 'apply' : 'dry-run');
      assert.equal(report.results[0].outcome, apply ? 'DEACTIVATED_VERIFIED' : 'DRY_RUN_ACTIVE');
      assert.equal(report.results[0].saveAttempted, apply);
      assert.deepEqual(state.saves, apply ? ['alpha'] : []);
      assert.deepEqual(report.cleanup, cleanup);
      assert.equal(cleanup.status, logoutFails ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED');
      assert.deepEqual(cleanup.results.map(result => result.outcome), [logoutFails ? 'LOGOUT_FAILED' : 'SIGNED_OUT_VERIFIED', 'SIGNED_OUT_VERIFIED']);
      assert.deepEqual(events, [
        { kind: 'corehr', action: 'logout', taskStatus: 'COMPLETED' }, { kind: 'corehr', action: 'close' },
        { kind: 'procare', action: 'logout', taskStatus: 'COMPLETED' }, { kind: 'procare', action: 'close' }
      ]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
