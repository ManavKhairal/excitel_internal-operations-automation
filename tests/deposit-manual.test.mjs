import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { approvedDepositSave, approvedDepositRead } from '../src/integrations/phpmyadmin.mjs';
import { runDepositTask, validateInput, TENANTS } from '../src/tasks/deposit-refundability.mjs';
import { createDemoDatabase } from '../src/demo/deposit-demo.mjs';
import { testBrowser } from './fixtures.mjs';
import { manualDepositFixture } from './deposit-web-fixtures.mjs';

const config = JSON.parse(await fs.readFile(new URL('../config/deposit-refundability.json', import.meta.url)));
const origin = TENANTS.north;
const saveBody = () => new URLSearchParams({ db: 'excitel_ticketing_system', table: 'subscriber_deposit', submit_type: 'save', clause_is_unique: '1',
  'where_clause[]': 'subscriber_deposit.deposit_id=101', 'fields_name[multi_edit][0][]': 'refundable', 'fields[multi_edit][0][]': '1' });

test('live save scope rejects different tenants, records, fields, values, duplicate keys and arbitrary SQL', () => {
  const url = new URL(origin + '/pma/tbl_replace.php'), scope = { key: '101', target: 1 };
  assert.equal(approvedDepositSave(url, 'POST', saveBody(), scope, origin), true);
  assert.equal(approvedDepositSave(url, 'GET', saveBody(), scope, origin), false);
  assert.equal(approvedDepositSave(new URL(TENANTS.south + url.pathname), 'POST', saveBody(), scope, origin), false);
  assert.equal(approvedDepositSave(url, 'POST', saveBody(), null, origin), false);
  for (const [key, value] of [['where_clause[]', 'deposit_id=102'], ['fields_name[multi_edit][0][]', 'is_covered'], ['fields[multi_edit][0][]', '0'], ['sql_query', 'UPDATE subscriber_deposit SET refundable=1'], ['fields[multi_edit][1][]', '1'], ['fields_null[multi_edit][0][]', '1'], ['db', 'other_database']]) {
    const body = saveBody(); body.set(key, value);
    assert.equal(approvedDepositSave(url, 'POST', body, scope, origin), false, key);
  }
  const duplicate = saveBody(); duplicate.append('db', 'excitel_ticketing_system');
  assert.equal(approvedDepositSave(url, 'POST', duplicate, scope, origin), false);
  const southBody = saveBody(); southBody.set('db', 'excitel_ticketing_system_hyd');
  assert.equal(approvedDepositSave(new URL(TENANTS.south + '/pma/tbl_replace.php'), 'POST', southBody, scope, TENANTS.south), true);
  southBody.set('db', 'excitel_ticketing_system');
  assert.equal(approvedDepositSave(new URL(TENANTS.south + '/pma/tbl_replace.php'), 'POST', southBody, scope, TENANTS.south), false);
  const reverse = saveBody(); reverse.set('fields[multi_edit][0][]', '0');
  assert.equal(approvedDepositSave(url, 'POST', reverse, { key: '101', target: 0 }, origin), true);
});

test('manual input requires an explicit tenant and cannot enable writes in another environment', async () => {
  assert.throws(() => validateInput({ usernames: ['manual.First'], manual: true }), { code: 'TENANT_REQUIRED' });
  await assert.rejects(runDepositTask({ usernames: ['manual.First'], tenant: 'north', manual: true, apply: true }, { config, environment: 'production-preview' }), { code: 'WRONG_ENVIRONMENT' });
  await assert.rejects(runDepositTask({ usernames: ['manual.First'], tenant: 'north', apply: true }, { config, environment: 'production-manual' }), { code: 'LIVE_WRITES_DISABLED' });
});

for (const tenant of ['north', 'south']) for (const target of [1, 0]) {
  test(`manual ${tenant} target ${target} uses exact input without Sheets, editable single-table view, external editor and verified logout`, async t => {
    const browser = await testBrowser(); t.after(() => browser.close());
    const { state } = manualDepositFixture(browser);
    const snapshots = [];
    const report = await runDepositTask({ usernames: ['manual.First', '000123', 'manual.First'], tenant, manual: true, refundable: target, apply: true }, {
      config, environment: 'production-manual', checkpoint: async value => snapshots.push(value),
      sheets: new Proxy({}, { get() { throw new Error('Manual mode must never access Sheets'); } }),
      openDatabase: value => createDemoDatabase(browser, state, value, config, { manualGrid: true, actionColumns: true, stripSemicolon: true, nativeSqlEditor: tenant === 'south' })
    });
    assert.equal(report.status, 'COMPLETED', JSON.stringify(report.results.map(row => row.error)));
    assert.equal(report.inputSource, 'manual');
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every(row => row.sheet.status === 'NOT_REQUESTED_MANUAL' && row.logout === 'SIGNED_OUT_VERIFIED'));
    const saves = state.events.filter(event => event.action === 'save');
    assert.deepEqual(saves.map(event => event.key), target ? ['101', '301'] : ['104']);
    assert.ok(saves.every(event => event.value === String(target)));
    assert.equal(state.events.filter(event => event.action.startsWith('sheet-')).length, 0);
    assert.ok(snapshots.some(report => report.results.some(result => result.rows.some(row => row.outcome === 'SAVE_STARTED_UNVERIFIED'))));
    assert.equal(state.events.filter(event => event.action === 'logout').length, 1);
    assert.deepEqual(state.deposits.filter(row => row.isCovered || row.isBundled).map(row => row.refundable), [0, 0]);
  });
}

for (const options of [{ doNotPersist: true }, { saveResponseLost: true }, { wrongClause: true }]) {
  test(`manual failure preserves uncertainty and stops batch without replay: ${Object.keys(options)[0]}`, async t => {
    const browser = await testBrowser(); t.after(() => browser.close());
    const { state } = manualDepositFixture(browser);
    const report = await runDepositTask({ usernames: ['manual.First', '000123'], tenant: 'north', manual: true, apply: true }, {
      config: { ...config, timeoutMs: 700 }, environment: 'production-manual',
      openDatabase: tenant => createDemoDatabase(browser, state, tenant, { ...config, timeoutMs: 700 }, { manualGrid: true, ...options })
    });
    assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
    assert.equal(report.results[0].outcome, 'HALTED_FOR_REVIEW');
    assert.equal(report.results[1].outcome, 'NOT_PROCESSED');
    assert.equal(state.events.filter(event => event.action === 'save').length, options.wrongClause ? 0 : 1);
    assert.equal(state.events.filter(event => event.action === 'logout').length, 1);
    if (!options.wrongClause) assert.equal(report.results[0].rows[0].outcome, 'SAVE_UNVERIFIED');
  });
}


test('live read requests support blank asset context and AJAX navigation while rejecting mutation forms and unreviewed queries', () => {
  const queries = new Set(['SELECT * FROM `subscriber_deposit`']);
  const allowed = (pathname, method = 'GET', fields = {}) => approvedDepositRead(new URL(origin + pathname), method, new URLSearchParams(fields), queries, origin);
  assert.equal(allowed('/pma/js/whitelist.php?db=&table=&server=1'), true);
  assert.equal(allowed('/pma/db_structure.php?db=excitel_ticketing_system&token=test&ajax_request=true&ajax_page_request=true', 'POST', { _nocache: '123' }), true);
  const autocomplete = { ajax_request: 'true', token: 'test', server: '1', db: 'excitel_ticketing_system', _nocache: '123' };
  assert.equal(allowed('/pma/db_sql_autocomplete.php', 'POST', autocomplete), true);
  assert.equal(allowed('/pma/db_sql_autocomplete.php', 'GET', autocomplete), false);
  assert.equal(allowed('/pma/db_sql_autocomplete.php', 'POST', { ...autocomplete, db: 'other_database' }), false);
  assert.equal(allowed('/pma/db_sql_autocomplete.php', 'POST', { ...autocomplete, sql_query: 'UPDATE subscriber_deposit SET refundable=1' }), false);
  assert.equal(allowed('/pma/db_sql_autocomplete.php', 'POST', { ...autocomplete, 'fields[multi_edit][0][]': '1' }), false);
  assert.equal(allowed('/pma/index.php', 'POST', { pma_username: 'fixture-account', pma_password: 'fixture-password' }), true);
  assert.equal(allowed('/pma/sql.php', 'POST', { sql_query: 'SELECT * FROM `subscriber_deposit`;' }), true);
  assert.equal(allowed('/pma/import.php', 'POST', { sql_query: 'SELECT * FROM `subscriber_deposit`' }), true);
  assert.equal(allowed('/pma/sql.php', 'POST', { sql_query: 'UPDATE subscriber_deposit SET refundable=1' }), false);
  assert.equal(allowed('/pma/db_structure.php?db=other_database'), false);
  assert.equal(allowed('/pma/sql.php?table=subscriber'), false);
  assert.equal(allowed('/pma/db_structure.php?db=excitel_ticketing_system', 'POST', { mult_btn: 'Drop', 'selected_tbl[]': 'subscriber_deposit' }), false);
  assert.equal(allowed('/pma/tbl_replace.php', 'POST'), false);
  assert.equal(allowed('/pma/sql.php', 'POST', { 'where_clause[]': 'deposit_id=101' }), false);
  assert.equal(allowed('/pma/import.php', 'GET'), false);
  assert.equal(approvedDepositRead(new URL(TENANTS.south + '/pma/sql.php?db=excitel_ticketing_system_hyd&table=subscriber_deposit'), 'GET', new URLSearchParams(), queries, TENANTS.south), true);
  assert.equal(approvedDepositRead(new URL(TENANTS.south + '/pma/sql.php?db=excitel_ticketing_system'), 'GET', new URLSearchParams(), queries, TENANTS.south), false);
  assert.equal(approvedDepositRead(new URL(TENANTS.south + '/pma/sql.php'), 'GET', new URLSearchParams(), queries, origin), false);
});


test('missing manual user with a separate SQL acknowledgement reports no deposits and signs out', async t => {
  const browser = await testBrowser(); t.after(() => browser.close());
  const { state } = manualDepositFixture(browser);
  const report = await runDepositTask({ usernames: ['missing.user'], tenant: 'north', manual: true, apply: false }, {
    config, environment: 'production-manual',
    openDatabase: tenant => createDemoDatabase(browser, state, tenant, config, { manualGrid: true, sqlAcknowledgement: true })
  });
  assert.equal(report.results[0].error.code, 'NO_DEPOSIT_RECORDS');
  assert.equal(report.results[0].logout, 'SIGNED_OUT_VERIFIED');
  assert.equal(state.events.filter(event => event.action === 'save').length, 0);
});
