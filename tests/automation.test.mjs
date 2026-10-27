import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testBrowser, testConfig, corehrFixture, procareFixture, tempDir } from './fixtures.mjs';
import { processEmployee, verifyDetailIdentity } from '../src/corehr.mjs';
import { readEmployeePage, collectEmployees } from '../src/procare.mjs';
import { assertStagingPage } from '../src/browser.mjs';
import { clean, exactPattern, validUsername, csvCell, acquireLock, saveReport } from '../src/utils.mjs';
let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

async function runCorehr(options, username, apply) {
  const fixture = await corehrFixture(browser, options);
  const config = await testConfig();
  const dir = await tempDir();
  const checkpoints = [];
  try {
    const response = await processEmployee(fixture.session, username, config, { apply, outputDir: dir, onCheckpoint: async r => checkpoints.push(r) });
    return { ...response, state: fixture.state, checkpoints };
  } finally { await fixture.context.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

test('dry run finds exact username, not a prefix match, and does not write', async () => {
  const r = await runCorehr({}, 'alpha', false);
  assert.equal(r.result.outcome, 'DRY_RUN_ACTIVE'); assert.equal(r.result.before, 'Active');
  assert.deepEqual(r.state.saves, []); assert.equal(r.stopBatch, false);
});
test('a dropped initial search submission is retried before matching results', async () => {
  const r = await runCorehr({ ignoreFirstSubmit: true, initialEmpty: true }, 'alpha', false);
  assert.equal(r.result.outcome, 'DRY_RUN_ACTIVE');
  assert.deepEqual(r.state.saves, []);
});
test('an unsubmitted search is distinguished from an absent employee', async () => {
  const r = await runCorehr({ ignoreSearch: true }, 'alpha', true);
  assert.equal(r.result.outcome, 'SEARCH_NOT_SUBMITTED');
  assert.equal(r.stopBatch, true);
  assert.deepEqual(r.state.saves, []);
});
test('apply clicks Save once, reopens the exact record and verifies persisted Inactive', async () => {
  const r = await runCorehr({}, 'alpha', true);
  assert.equal(r.result.outcome, 'DEACTIVATED_VERIFIED'); assert.equal(r.result.after, 'Inactive');
  assert.deepEqual(r.state.saves, ['alpha']); assert.equal(r.state.users.alphabet, 'Active');
  assert.equal(r.checkpoints.length, 1); assert.equal(r.checkpoints[0].outcome, 'SAVE_STARTED_UNVERIFIED');
});
test('already inactive is skipped without clicking Save', async () => {
  const r = await runCorehr({}, 'beta', true);
  assert.equal(r.result.outcome, 'ALREADY_INACTIVE'); assert.deepEqual(r.state.saves, []);
});
test('a native Inactive dropdown is supported', async () => {
  const r = await runCorehr({ nativeSelect: true }, 'alpha', true);
  assert.equal(r.result.outcome, 'DEACTIVATED_VERIFIED'); assert.deepEqual(r.state.saves, ['alpha']);
});
test('missing exact username does not edit another employee', async () => {
  const r = await runCorehr({}, 'missing', true);
  assert.equal(r.result.outcome, 'NO_EXACT_MATCH'); assert.equal(r.stopBatch, false); assert.deepEqual(r.state.saves, []);
});
test('multiple exact usernames are skipped instead of taking first result', async () => {
  const r = await runCorehr({ duplicate: true }, 'alpha', true);
  assert.equal(r.result.outcome, 'AMBIGUOUS_MATCH'); assert.deepEqual(r.state.saves, []);
});
test('mismatched detail identity stops before save', async () => {
  const r = await runCorehr({ wrongDetail: 'somebody-else' }, 'alpha', true);
  assert.notEqual(r.result.outcome, 'DEACTIVATED_VERIFIED'); assert.equal(r.stopBatch, true); assert.deepEqual(r.state.saves, []);
});
test('unexpected status is left unchanged', async () => {
  const r = await runCorehr({ users: { alpha: 'Suspended' } }, 'alpha', true);
  assert.equal(r.result.outcome, 'UNEXPECTED_STATUS'); assert.deepEqual(r.state.saves, []);
});
test('optimistic UI success is not enough: unpersisted change stops without a second save', async () => {
  const r = await runCorehr({ doNotPersist: true }, 'alpha', true);
  assert.equal(r.result.outcome, 'SAVE_UNVERIFIED'); assert.equal(r.stopBatch, true); assert.deepEqual(r.state.saves, ['alpha']);
});
test('Procare collects all configured pages and deduplicates usernames', async () => {
  const f = await procareFixture(browser, [['alpha', 'beta'], ['beta', 'gamma']]);
  try {
    const config = await testConfig(); config.procare.selectors.nextPage = '#next';
    const manifest = await collectEmployees(f.session, 'Acme Staging Partner', config, { ask: async () => assert.fail('Automatic collection must not prompt') });
    assert.deepEqual(manifest.usernames, ['alpha', 'beta', 'gamma']);
    assert.equal(manifest.partner.id, '42'); assert.deepEqual(manifest.pageCounts, [2, 2]);
    assert.equal(manifest.paginationMode, 'auto'); assert.equal(manifest.completeness, 'pagination-verified');
  } finally { await f.context.close(); }
});
test('Procare one-page list finishes automatically although its Next arrow stays enabled', async () => {
  const f = await procareFixture(browser, [['alpha']]);
  try {
    const manifest = await collectEmployees(f.session, 'Acme Staging Partner', await testConfig());
    assert.deepEqual(manifest.usernames, ['alpha']); assert.deepEqual(manifest.pageCounts, [1]);
  } finally { await f.context.close(); }
});
test('Procare follows a sliding page window through the actual last page', async () => {
  const f = await procareFixture(browser, [['a'], ['b'], ['c'], ['d'], ['e']], { windowSize: 3 });
  try {
    const manifest = await collectEmployees(f.session, 'Acme Staging Partner', await testConfig());
    assert.deepEqual(manifest.usernames, ['a', 'b', 'c', 'd', 'e']);
  } finally { await f.context.close(); }
});
test('Procare waits through a loading row when advancing pages', async () => {
  const f = await procareFixture(browser, [['alpha'], ['beta']], { delayPageMs: 250 });
  try {
    const manifest = await collectEmployees(f.session, 'Acme Staging Partner', await testConfig());
    assert.deepEqual(manifest.usernames, ['alpha', 'beta']);
  } finally { await f.context.close(); }
});
test('Procare rejects a partner route change while the employee page settles', async () => {
  const f = await procareFixture(browser, [['alpha']], { changePartnerDuringSettle: true });
  try {
    await assert.rejects(collectEmployees(f.session, 'Acme Staging Partner', await testConfig()), error => error.code === 'PARTNER_CHANGED');
  } finally { await f.context.close(); }
});
for (const [label, options, code] of [
  ['missing pagination', { missingPager: true }, 'TIMEOUT'],
  ['ambiguous Next controls', { duplicateNext: true }, 'AMBIGUOUS_CONTROL'],
  ['Next disabled before the last page', { disabledNext: true }, 'PAGINATION_STATE'],
  ['Next leaving the same rows', { stuckNext: true }, 'TIMEOUT'],
  ['collection starting after page one', { startPage: 1 }, 'PAGINATION_STATE']
]) {
  test(`Procare stops on ${label} instead of accepting a partial list`, async () => {
    const f = await procareFixture(browser, [['alpha'], ['beta']], options);
    try {
      await assert.rejects(collectEmployees(f.session, 'Acme Staging Partner', await testConfig()), error => error.code === code);
    } finally { await f.context.close(); }
  });
}
test('Procare explicit guided mode retains operator page and batch confirmation', async () => {
  const f = await procareFixture(browser, [['alpha']]); const prompts = [];
  try {
    const manifest = await collectEmployees(f.session, 'Acme Staging Partner', await testConfig(), {
      pagination: 'guided', ask: async prompt => { prompts.push(prompt); return prompts.length === 1 ? 'DONE' : 'COLLECT 1'; }
    });
    assert.equal(prompts.length, 2); assert.equal(manifest.completeness, 'operator-confirmed');
  } finally { await f.context.close(); }
});
test('Procare refuses extraction when a Username column is unavailable', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await page.setContent('<table><tr><th>Name</th><th>Phone</th></tr><tr><td>Alice</td><td>123</td></tr></table>');
    await assert.rejects(readEmployeePage(page, await testConfig()), error => error.code === 'PROCARE_SELECTOR_NEEDED');
  } finally { await context.close(); }
});
test('Procare custom row and username selectors work without a table', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await page.setContent('<div class="employee"><span class="username">alpha</span></div><div class="employee"><span class="username">beta</span></div>');
    const c = await testConfig(); c.procare.selectors.employeeRows = '.employee'; c.procare.selectors.usernameWithinRow = '.username';
    assert.deepEqual((await readEmployeePage(page, c)).usernames, ['alpha', 'beta']);
  } finally { await context.close(); }
});
test('production and lookalike hostnames are rejected', () => {
  for (const url of ['https://hr.excitel.in/', 'https://staging-hr.excitel.in.evil.example/', 'http://staging-hr.excitel.in/']) {
    assert.throws(() => assertStagingPage({ url: () => url }, 'corehr'), error => error.code === 'WRONG_ENVIRONMENT');
  }
});
test('text matching is exact, escaped, and case sensitive', () => {
  assert.equal(exactPattern('a.b').test('a.b'), true); assert.equal(exactPattern('a.b').test('axb'), false);
  assert.equal(exactPattern('alpha').test('alphabet'), false); assert.equal(clean('  a\n b  '), 'a b');
});
test('extracted username validation and CSV formula escaping', () => {
  assert.equal(validUsername('000124'), '000124'); assert.throws(() => validUsername('Alice Smith'));
  assert.equal(csvCell('=1+1'), '"\'=1+1"'); assert.equal(csvCell('a"b'), '"a""b"');
});
test('a local lock prevents concurrent project runs', async () => {
  const dir = await tempDir(); const release = await acquireLock(dir);
  try { await assert.rejects(acquireLock(dir), error => error.code === 'LOCKED'); }
  finally { await release(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('report includes skips and unprocessed users, not just successful changes', async () => {
  const dir = await tempDir();
  try {
    const report = { results: [{ username: 'a', outcome: 'ALREADY_INACTIVE' }, { username: 'b', outcome: 'NOT_PROCESSED' }] };
    await saveReport(dir, report);
    const data = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
    assert.deepEqual(data.summary, { ALREADY_INACTIVE: 1, NOT_PROCESSED: 1 });
    assert.match(await fs.readFile(path.join(dir, 'report.csv'), 'utf8'), /NOT_PROCESSED/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
