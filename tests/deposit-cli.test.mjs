import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures.mjs';
const run = promisify(execFile);

for (const refundable of [1, 0]) for (const apply of [false, true]) {
  test(`deposit CLI offline ${apply ? 'apply' : 'preview'} target ${refundable} creates reports and preserves skipped rows`, async () => {
    const root = await tempDir();
    try {
      await fs.cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
      await fs.cp(new URL('../config/', import.meta.url), path.join(root, 'config'), { recursive: true });
      // Keep subprocess fixture validation independent of a desktop display.
      const configFile = path.join(root, 'config/deposit-refundability.json');
      const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
      config.headless = true;
      await fs.writeFile(configFile, JSON.stringify(config));
      await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
      const args = [path.join(root, 'src/cli.mjs'), '--task', 'deposit-refundability', '--demo', '--username', 'demo.north', '--username', 'demo.south'];
      if (refundable === 0) args.push('--refundable', '0'); // omitted option still means the original direction
      if (apply) args.push('--apply');
      const { stdout, stderr } = await run(process.execPath, args, { timeout: 20000 });
      assert.equal(stderr, '');
      assert.match(stdout, /OFFLINE DEMO/);
      const [name] = await fs.readdir(path.join(root, 'output'));
      const report = JSON.parse(await fs.readFile(path.join(root, 'output', name, 'report.json')));
      const state = JSON.parse(await fs.readFile(path.join(root, 'output', name, 'demo-state.json')));
      const csv = await fs.readFile(path.join(root, 'output', name, 'report.csv'), 'utf8');
      assert.equal(report.environment, 'offline-demo');
      assert.equal(report.targetRefundable, refundable);
      assert.equal(report.status, apply ? 'COMPLETED' : 'PREVIEW_COMPLETED');
      assert.equal(state.events.filter(e => e.action === 'save').length, apply ? (refundable === 1 ? 2 : 1) : 0);
      assert.equal(state.events.filter(e => e.action === 'sheet-append').length, apply ? (refundable === 1 ? 2 : 1) : 0);
      assert.ok(state.events.filter(e => e.action === 'save').every(e => e.value === String(refundable)));
      assert.match(csv, /SKIPPED_COVERED_OR_BUNDLED/);
      assert.match(csv, refundable === 1 ? /ALREADY_REFUNDABLE/ : /ALREADY_NON_REFUNDABLE/);
      assert.match(csv, /targetRefundable/);
      if (apply && refundable === 0) assert.deepEqual(state.tabs['North Managed users'].at(-1), ['demo.north']);
      await assert.rejects(fs.access(path.join(root, '.state/run.lock')));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const refundable of [1, 0]) for (const apply of [false, true]) {
  test(`deposit CLI rejects production ${apply ? 'apply' : 'preview'} target ${refundable} before creating browser/API state`, async () => {
    const root = await tempDir();
    try {
      await fs.cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
      await fs.cp(new URL('../config/', import.meta.url), path.join(root, 'config'), { recursive: true });
      await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
      const args = [path.join(root, 'src/cli.mjs'), '--task', 'deposit-refundability', '--username', 'not-a-real-user'];
      if (refundable === 0) args.push('--refundable', '0');
      if (apply) args.push('--apply');
      await assert.rejects(run(process.execPath, args, { timeout: 5000 }), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, apply ? /LIVE_WRITES_DISABLED/ : /LIVE_PREVIEW_NOT_READY/);
        return true;
      });
      await assert.rejects(fs.access(path.join(root, 'output')));
      await assert.rejects(fs.access(path.join(root, '.state')));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
