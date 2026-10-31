import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { testBrowser } from './fixtures.mjs';
import { runDepositTask, normalizeTenant, taskDate, validateRows, recordCompletion, validateInput } from '../src/tasks/deposit-refundability.mjs';
import { DepositSheets, googleSheetsTransport } from '../src/integrations/deposit-sheets.mjs';
import { lookupQuery, PhpMyAdmin } from '../src/integrations/phpmyadmin.mjs';
import { demoData, memorySheetTransport, createDemoDatabase } from '../src/demo/deposit-demo.mjs';
import { selectTask } from '../src/task-registry.mjs';

let browser, config;
before(async () => {
  browser = await testBrowser();
  config = JSON.parse(await fs.readFile(new URL('../config/deposit-refundability.json', import.meta.url)));
  config.timeoutMs = 900;
});
after(async () => { await browser?.close(); });
async function execute({ state = demoData(), options = {}, usernames = ['demo.north'], apply = true, tenant, refundable } = {}) {
  const snapshots = [];
  const sheets = new DepositSheets(memorySheetTransport(state, options), config);
  const report = await runDepositTask({ usernames, apply, tenant, refundable }, {
    config, sheets, environment: 'offline-demo', now: () => '2026-10-27T20:00:00.000Z',
    checkpoint: async value => snapshots.push(structuredClone(value)),
    openDatabase: async value => { state.events.push({ action: 'open-database', tenant: value }); return createDemoDatabase(browser, state, value, config, options); }
  });
  return { state, report, snapshots, sheets };
}
const events = (state, action) => state.events.filter(event => event.action === action);

test('post-save UPDATE tools beside SELECT tools do not interrupt verification or repeat a save', async () => {
  const state = demoData();
  state.deposits[1].isCovered = 0;
  const { report } = await execute({ state });
  assert.equal(report.status, 'COMPLETED', JSON.stringify(report.results[0].error));
  assert.deepEqual(events(state, 'save').map(event => event.key), ['101', '102']);
  assert.deepEqual(report.results[0].rows.map(row => row.outcome), ['REFUNDABLE_VERIFIED', 'REFUNDABLE_VERIFIED', 'SKIPPED_COVERED_OR_BUNDLED', 'ALREADY_REFUNDABLE']);
  const edits = events(state, 'query-edit');
  assert.equal(edits.length, 5); // initial, two pre-save reads, two post-save reads
  assert.ok(edits.every(event => /^SELECT\b/.test(event.query)));
  assert.equal(events(state, 'logout').length, 1);
  assert.equal(events(state, 'sheet-append').length, 1);
  assert.equal(report.results[0].sheet.status, 'RECORDED_VERIFIED');
});

test('multiple SELECT query blocks remain ambiguous and stop before a deposit save', async () => {
  const { state, report } = await execute({ options: { duplicateSelectQuery: true } });
  assert.equal(report.results[0].error.code, 'AMBIGUOUS_CONTROL');
  assert.equal(events(state, 'query-edit').length, 0);
  assert.equal(events(state, 'save').length, 0);
  assert.equal(events(state, 'sheet-append').length, 0);
  assert.equal(events(state, 'logout').length, 1);
});

test('phpMyAdmin action heading colspan maps the refundable body cell correctly', async () => {
  const { state, report } = await execute({ options: { actionColumns: true } });
  assert.equal(report.status, 'COMPLETED');
  assert.deepEqual(events(state, 'save').map(event => event.key), ['101']);
  assert.equal(report.results[0].rows[0].after, 1);
});

test('phpMyAdmin may omit the submitted SELECT semicolon from displayed results', async () => {
  const { report } = await execute({ options: { stripSemicolon: true }, apply: false });
  assert.equal(report.status, 'PREVIEW_COMPLETED');
  assert.equal(report.results[0].rows[0].outcome, 'WOULD_SET_REFUNDABLE');
});

test('mixed rows: one Enter on eligible deposit, skipped rows preserved, date in India and sheet after logout', async () => {
  const { state, report, snapshots } = await execute();
  assert.equal(report.status, 'COMPLETED');
  assert.deepEqual(report.results[0].rows.map(row => row.outcome), ['REFUNDABLE_VERIFIED', 'SKIPPED_COVERED_OR_BUNDLED', 'SKIPPED_COVERED_OR_BUNDLED', 'ALREADY_REFUNDABLE']);
  assert.deepEqual(events(state, 'save').map(e => e.key), ['101']);
  assert.deepEqual(state.deposits.slice(0, 4).map(row => row.refundable), [1, 0, 0, 1]);
  assert.deepEqual(state.tabs['North Changes reverted'].at(-1), ['demo.north', 'YES', '2026-10-28']);
  assert.ok(state.events.findIndex(e => e.action === 'logout') < state.events.findIndex(e => e.action === 'sheet-append'));
  assert.ok(snapshots.some(s => s.results[0].rows.some(row => row.outcome === 'SAVE_STARTED_UNVERIFIED' && row.saveAttempted)));
  assert.ok(events(state, 'lookup').length >= 3);
});

test('preview reads both source tabs and deposits without save or completion append', async () => {
  const { state, report } = await execute({ apply: false });
  assert.equal(report.status, 'PREVIEW_COMPLETED');
  assert.equal(events(state, 'save').length, 0);
  assert.equal(events(state, 'sheet-append').length, 0);
  assert.equal(report.results[0].rows[0].outcome, 'WOULD_SET_REFUNDABLE');
  assert.equal(events(state, 'logout').length, 1);
  const firstDatabase = state.events.findIndex(e => e.action === 'open-database');
  assert.deepEqual(new Set(state.events.slice(0, firstDatabase).filter(e => e.action === 'sheet-read').map(e => e.name)), new Set(['North Tenant', 'South Tenant']));
});

for (const scenario of [
  { label: 'missing from both sheets', username: 'missing', code: 'USER_NOT_LISTED' },
  { label: 'listed in both sheets', both: true, code: 'AMBIGUOUS_TENANT' },
  { label: 'supplied tenant conflicts with sheet', tenant: 'south', code: 'TENANT_MISMATCH' },
  { label: 'source tab read fails', options: { readFails: 'South Tenant' }, code: 'FAILED' }
]) {
  test(`eligibility blocks before database access: ${scenario.label}`, async () => {
    const state = demoData();
    if (scenario.both) state.tabs['South Tenant'].push(['demo.north']);
    const { report } = await execute({ state, usernames: [scenario.username || 'demo.north'], tenant: scenario.tenant, options: scenario.options });
    assert.equal(report.results[0].error.code, scenario.code);
    assert.equal(events(state, 'open-database').length, 0);
    assert.equal(events(state, 'sheet-append').length, 0);
  });
}

test('source header may be on row 2, usernames are matched exactly and by identified column', async () => {
  const state = demoData();
  state.tabs['North Tenant'] = [['ignored'], ['', 'User ID', 'ERP name'], ['', 'demo.north.extra', 'demo.north'], ['', '000123', 'Demo']];
  const sheets = new DepositSheets(memorySheetTransport(state), config);
  assert.deepEqual(await sheets.membership('demo.north'), { north: false, south: false });
  assert.deepEqual(await sheets.membership('000123'), { north: true, south: false });
  assert.equal(state.events.some(e => /Changes reverted/.test(e.name || '')), false);
});

test('already-refundable and ineligible-only users cause no save or sheet append', async () => {
  const state = demoData();
  state.deposits[0].refundable = 1;
  const { report } = await execute({ state });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(events(state, 'save').length, 0);
  assert.equal(events(state, 'sheet-append').length, 0);
  assert.equal(report.results[0].sheet.status, 'NOT_REQUIRED');
});

test('multiple usernames reuse each tenant session and append to the correct completion tabs', async () => {
  const state = demoData();
  state.tabs['North Tenant'].push(['demo.north2']);
  state.deposits.push({ ...state.deposits[0], key: '301', subscriberId: '30', username: 'demo.north2' });
  const { report } = await execute({ state, usernames: ['demo.north', 'demo.north2', 'demo.south'] });
  assert.equal(report.status, 'COMPLETED');
  assert.deepEqual(events(state, 'open-database').map(e => e.tenant), ['north', 'south']);
  assert.equal(events(state, 'logout').length, 2);
  assert.equal(events(state, 'save').length, 3);
  assert.equal(events(state, 'sheet-append').length, 3);
  const lastClose = state.events.findLastIndex(e => e.action === 'close');
  assert.ok(lastClose < state.events.findIndex(e => e.action === 'sheet-append'));
  assert.equal(state.tabs['South Changes reverted'].at(-1)[0], 'demo.south');
});

for (const scenario of [
  { label: 'save displays 1 but backend does not persist', options: { doNotPersist: true }, code: 'SAVE_UNVERIFIED', saves: 1 },
  { label: 'response lost after save', options: { saveResponseLost: true }, code: 'TIMEOUT', saves: 1 },
  { label: 'query results are incomplete', options: { partialResults: true }, code: 'PARTIAL_RESULTS', saves: 0 }
]) {
  test(`stops without repeated Enter: ${scenario.label}`, async () => {
    const { state, report } = await execute({ options: scenario.options, usernames: ['demo.north', 'demo.south'] });
    assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
    assert.equal(report.results[0].error.code, scenario.code);
    assert.equal(events(state, 'save').length, scenario.saves);
    assert.equal(report.results[1].outcome, 'NOT_PROCESSED');
    assert.equal(events(state, 'sheet-append').length, 0);
    assert.equal(events(state, 'logout').length, 1);
    assert.equal(events(state, 'close').length, 1);
  });
}

test('partial username completion records verified and uncertain rows and withholds sheet entry', async () => {
  const state = demoData();
  state.deposits[1].isCovered = 0;
  const { report } = await execute({ state, options: { failKey: '102' } });
  assert.equal(report.results[0].rows[0].outcome, 'REFUNDABLE_VERIFIED');
  assert.equal(report.results[0].rows[1].outcome, 'SAVE_UNVERIFIED');
  assert.equal(report.results[0].sheet.status, 'BLOCKED_PARTIAL_RESULT');
  assert.equal(events(state, 'save').length, 2);
  assert.equal(events(state, 'sheet-append').length, 0);
});

test('flags changing after lookup block editing before Enter', async () => {
  let count = 0;
  const { state, report } = await execute({ options: { onLookup(state) { if (++count === 2) state.deposits[0].isCovered = 1; } } });
  assert.equal(report.results[0].error.code, 'RECORD_CHANGED');
  assert.equal(events(state, 'save').length, 0);
});

test('logout failure preserves verified changes but defers sheet recording', async () => {
  const { state, report } = await execute({ options: { logoutFails: true } });
  assert.equal(report.results[0].rows[0].outcome, 'REFUNDABLE_VERIFIED');
  assert.equal(report.results[0].logout, 'LOGOUT_FAILED');
  assert.equal(report.results[0].sheet.status, 'PENDING');
  assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
  assert.equal(events(state, 'sheet-append').length, 0);
  assert.equal(events(state, 'close').length, 1);
});

test('lost sheet append response is recovered by rereading, without duplicate append or database save', async () => {
  const { state, report } = await execute({ options: { appendResponseLost: true } });
  const result = report.results[0];
  assert.equal(result.sheet.status, 'FAILED');
  assert.equal(result.rows[0].outcome, 'REFUNDABLE_VERIFIED');
  const appendCount = events(state, 'sheet-append').length;
  const saveCount = events(state, 'save').length;
  await recordCompletion(result, new DepositSheets(memorySheetTransport(state), config));
  assert.equal(result.sheet.status, 'ALREADY_RECORDED');
  assert.equal(result.sheet.error, undefined);
  assert.equal(events(state, 'sheet-append').length, appendCount);
  assert.equal(events(state, 'save').length, saveCount);
});

test('existing completion entry prevents duplicate append while a historical date does not', async () => {
  const state = demoData();
  state.tabs['North Changes reverted'].push(['demo.north', 'YES', '2026-10-27']);
  const sheets = new DepositSheets(memorySheetTransport(state), config);
  assert.equal(await sheets.recordCompletion('north', 'demo.north', '2026-10-27'), 'ALREADY_RECORDED');
  assert.equal(await sheets.recordCompletion('north', 'demo.north', '2026-10-28'), 'RECORDED_VERIFIED');
  assert.equal(events(state, 'sheet-append').length, 1);
});

test('record validation rejects uncertain identities and invalid flags before any editing', () => {
  const row = demoData().deposits[0];
  for (const [rows, code] of [
    [[], 'NO_DEPOSIT_RECORDS'], [[row, row], 'DUPLICATE_RECORD'],
    [[{ ...row, username: 'other' }], 'ROW_IDENTITY'], [[{ ...row, refundable: null }], 'INVALID_FLAGS'],
    [[row, { ...row, key: '999', subscriberId: '99' }], 'AMBIGUOUS_SUBSCRIBER']
  ]) assert.throws(() => validateRows(rows, 'demo.north'), { code });
  assert.throws(() => validateRows([row, { ...row, key: '222' }], 'demo.north', 1), { code: 'ROW_LIMIT' });
});

test('SQL generation uses fixed SELECT and encoded username, with no arbitrary query or schema', () => {
  const query = lookupQuery("name');DELETE FROM subscriber;--", 'deposit_id', 201);
  assert.match(query, /^SELECT s.username AS automation_username, sd\.\*/);
  assert.doesNotMatch(query, /DELETE/);
  assert.match(query, /WHERE BINARY s.username = X'[0-9a-f]+'/);
  assert.throws(() => lookupQuery('demo.north', 'id; DROP TABLE x', 201), { code: 'DATABASE_SCHEMA' });
});

test('live workflow, inline save and sheet append cannot be enabled by --apply', async () => {
  let accessed = false;
  await assert.rejects(runDepositTask({ usernames: ['demo.north'], apply: true }, {
    config, sheets: { membership() { accessed = true; } }, environment: 'production-preview'
  }), { code: 'LIVE_WRITES_DISABLED' });
  const adapter = new PhpMyAdmin({ url: () => 'https://del-procare-mariadb.excitel.in/pma/' }, { origin: 'https://del-procare-mariadb.excitel.in' });
  await assert.rejects(adapter.prepareRefundable({}), { code: 'LIVE_WRITES_DISABLED' });
  const transport = googleSheetsTransport(config, { accessToken: 'test-not-real', fetchImpl: async () => { accessed = true; } });
  await assert.rejects(transport.append('North Changes reverted', 1, []), { code: 'LIVE_WRITES_DISABLED' });
  assert.equal(accessed, false);
});

test('Google Sheets read errors fail closed without leaking token or server error text', async () => {
  const token = 'sensitive-test-token';
  const transport = googleSheetsTransport(config, { accessToken: token, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(new URL(url).origin, 'https://sheets.googleapis.com');
    return { ok: false, status: 403 };
  } });
  await assert.rejects(transport.metadata(), error => error.code === 'SHEETS_ACCESS_DENIED' && !error.message.includes(token));
});

test('task selection preserves legacy ERP arguments and rejects unknown or duplicate task options', () => {
  assert.deepEqual(selectTask(['--partner', 'Acme']), { task: 'erp-deactivation', args: ['--partner', 'Acme'] });
  assert.equal(selectTask(['--task=deposit-refundability', '--demo']).task, 'deposit-refundability');
  assert.equal(selectTask(['--task', 'erp-deactivation']).task, 'erp-deactivation');
  assert.throws(() => selectTask(['--task', '../unsafe']), { code: 'UNKNOWN_TASK' });
  assert.throws(() => selectTask(['--task=erp-deactivation', '--task=deposit-refundability']), { code: 'TASK_INPUT' });
  assert.equal(normalizeTenant(' HYD '), 'south');
  assert.throws(() => normalizeTenant('toString'), { code: 'INVALID_TENANT' });
  assert.equal(taskDate('2026-10-27T20:00:00Z'), '2026-10-28');
});

test('reverse direction changes only eligible 1 rows and records each tenant in Managed users after logout', async () => {
  const state = demoData();
  state.deposits[1].refundable = 1; // covered: must remain 1
  state.deposits[2].refundable = 1; // bundled: must remain 1
  state.deposits[4].refundable = 1;
  const { report, snapshots } = await execute({ state, refundable: 0, usernames: ['demo.north', 'demo.south'], options: { actionColumns: true } });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.targetRefundable, 0);
  assert.deepEqual(state.deposits.map(row => row.refundable), [0, 1, 1, 0, 0]);
  assert.deepEqual(events(state, 'save').map(({ key, value }) => [key, value]), [['104', '0'], ['201', '0']]);
  assert.deepEqual(report.results[0].rows.map(row => row.outcome), ['ALREADY_NON_REFUNDABLE', 'SKIPPED_COVERED_OR_BUNDLED', 'SKIPPED_COVERED_OR_BUNDLED', 'NON_REFUNDABLE_VERIFIED']);
  assert.deepEqual(state.tabs['North Managed users'], [['Username'], ['demo.north']]);
  assert.deepEqual(state.tabs['South Managed users'], [['username'], ['demo.south']]);
  assert.equal(state.tabs['North Changes reverted'].length, 1);
  assert.equal(state.tabs['South Changes reverted'].length, 1);
  assert.ok(state.events.findLastIndex(e => e.action === 'close') < state.events.findIndex(e => e.action === 'sheet-append'));
  assert.ok(snapshots.some(s => s.results[0].targetRefundable === 0 && s.results[0].rows.some(row => row.saveAttempted && row.outcome === 'SAVE_STARTED_UNVERIFIED')));
});

test('reverse preview and already-non-refundable runs make no saves or sheet entries', async () => {
  const preview = await execute({ refundable: 0, apply: false });
  assert.equal(preview.report.status, 'PREVIEW_COMPLETED');
  assert.equal(preview.report.results[0].rows[3].outcome, 'WOULD_SET_NON_REFUNDABLE');
  assert.equal(events(preview.state, 'save').length, 0);
  assert.equal(events(preview.state, 'sheet-append').length, 0);
  const state = demoData();
  state.deposits[3].refundable = 0;
  const already = await execute({ state, refundable: 0 });
  assert.equal(already.report.status, 'COMPLETED');
  assert.equal(already.report.results[0].sheet.status, 'NOT_REQUIRED');
  assert.equal(events(state, 'save').length, 0);
  assert.equal(events(state, 'sheet-append').length, 0);
});

for (const options of [{ doNotPersist: true }, { saveResponseLost: true }]) {
  test(`reverse uncertain save halts without retry or Managed users entry: ${Object.keys(options)[0]}`, async () => {
    const { state, report } = await execute({ refundable: 0, options, usernames: ['demo.north', 'demo.south'] });
    assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
    assert.equal(report.results[0].rows[3].outcome, 'SAVE_UNVERIFIED');
    assert.equal(report.results[1].outcome, 'NOT_PROCESSED');
    assert.equal(events(state, 'save').length, 1);
    assert.equal(events(state, 'save')[0].value, '0');
    assert.equal(events(state, 'sheet-append').length, 0);
  });
}

test('reverse lost sheet response recovers in Managed users without replaying save or append', async () => {
  const { state, report } = await execute({ refundable: 0, options: { appendResponseLost: true } });
  const result = report.results[0];
  assert.equal(result.sheet.status, 'FAILED');
  await recordCompletion(result, new DepositSheets(memorySheetTransport(state), config));
  assert.equal(result.sheet.status, 'ALREADY_RECORDED');
  assert.equal(events(state, 'save').length, 1);
  assert.equal(events(state, 'sheet-append').length, 1);
  assert.deepEqual(state.tabs['North Managed users'].at(-1), ['demo.north']);
  await assert.rejects(recordCompletion({ ...result, targetRefundable: 1 }, new DepositSheets(memorySheetTransport(state), config)), { code: 'COMPLETION_NOT_VERIFIED' });
});

test('Managed users deduplicates by username, preserves numeric usernames, and never writes invented columns', async () => {
  const state = demoData();
  state.tabs['North Managed users'].push([1100177113]);
  const sheets = new DepositSheets(memorySheetTransport(state), config);
  assert.equal(await sheets.recordCompletion('north', '1100177113', '2026-10-28', 0), 'ALREADY_RECORDED');
  assert.equal(await sheets.recordCompletion('south', '000123', '2026-10-28', 0), 'RECORDED_VERIFIED');
  assert.equal(await sheets.recordCompletion('south', '000123', '2026-10-29', 0), 'ALREADY_RECORDED');
  assert.deepEqual(events(state, 'sheet-append').map(e => e.values), [['000123']]);
  state.tabs['South Managed users'].push(['000123']);
  await assert.rejects(sheets.recordCompletion('south', '000123', '2026-10-29', 0), { code: 'DUPLICATE_COMPLETION' });
});

test('direction accepts only 0 or 1, defaults to the original direction, and preserves live write guards', async () => {
  assert.equal(validateInput({ usernames: ['demo.north'] }).refundable, 1);
  assert.equal(validateInput({ usernames: ['demo.north'], refundable: '0' }).refundable, 0);
  for (const refundable of [null, false, '', 'yes', 2, '01']) {
    assert.throws(() => validateInput({ usernames: ['demo.north'], refundable }), { code: 'INVALID_REFUNDABLE' });
  }
  await assert.rejects(runDepositTask({ usernames: ['demo.north'], refundable: 0, apply: true }, { config, sheets: {}, environment: 'production-preview' }), { code: 'LIVE_WRITES_DISABLED' });
  const adapter = new PhpMyAdmin({ url: () => 'https://del-procare-mariadb.excitel.in/pma/' }, { origin: 'https://del-procare-mariadb.excitel.in' });
  await assert.rejects(adapter.prepareRefundable({}, 0), { code: 'LIVE_WRITES_DISABLED' });
});

test('changing back to refundable uses the original completion tab without deleting Managed users history', async () => {
  const state = demoData();
  await execute({ state, refundable: 0 });
  const { report } = await execute({ state, refundable: 1 });
  assert.equal(report.status, 'COMPLETED');
  assert.deepEqual(state.tabs['North Managed users'], [['Username'], ['demo.north']]);
  assert.deepEqual(state.tabs['North Changes reverted'], [['Username', 'Refundable', 'Date'], ['demo.north', 'YES', '2026-10-28']]);
  assert.deepEqual(events(state, 'save').map(e => [e.key, e.value]), [['104', '0'], ['101', '1'], ['104', '1']]);
});

test('reverse partial result withholds Managed users recording and retains verified row evidence', async () => {
  const state = demoData();
  state.deposits[0].refundable = 1;
  const { report } = await execute({ state, refundable: 0, options: { failKey: '104' } });
  assert.equal(report.results[0].rows[0].outcome, 'NON_REFUNDABLE_VERIFIED');
  assert.equal(report.results[0].rows[3].outcome, 'SAVE_UNVERIFIED');
  assert.equal(report.results[0].sheet.status, 'BLOCKED_PARTIAL_RESULT');
  assert.equal(events(state, 'save').length, 2);
  assert.equal(events(state, 'sheet-append').length, 0);
});

test('reverse changes in eligibility flags stop before saving', async () => {
  let count = 0;
  const { state, report } = await execute({ refundable: 0, options: { onLookup(state) { if (++count === 2) state.deposits[3].isBundled = 1; } } });
  assert.equal(report.results[0].error.code, 'RECORD_CHANGED');
  assert.equal(events(state, 'save').length, 0);
  assert.equal(events(state, 'sheet-append').length, 0);
});

test('Managed users layout mismatch fails without writing to another column', async () => {
  const state = demoData();
  state.tabs['North Managed users'] = [['Other', 'Username']];
  const sheets = new DepositSheets(memorySheetTransport(state), config);
  await assert.rejects(sheets.recordCompletion('north', 'demo.north', '2026-10-28', 0), { code: 'COMPLETION_LAYOUT' });
  assert.equal(events(state, 'sheet-append').length, 0);
});
