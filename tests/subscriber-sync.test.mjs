import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { testBrowser } from './fixtures.mjs';
import { validateSyncInput, runSubscriberSync } from '../src/tasks/procare-subscriber-synchronization.mjs';
import { matchesSyncRequest, PROCARE_SYNC, readProcareResult, validateSyncConfig } from '../src/integrations/procare-subscriber-sync.mjs';
import { syncFixture, records } from './subscriber-sync-fixture.mjs';
let browser, config;
before(async () => { browser = await testBrowser(); config = { ...JSON.parse(await fs.readFile(new URL('../config/procare-subscriber-synchronization.json', import.meta.url))), headless: true, timeoutMs: 1400, liveUiReviewed: true, screenshots: false }; });
after(async () => { await browser?.close(); });
const input = (usernames = ['sync.one']) => ({ tenant: 'north', source: { spreadsheetId: 'fixture-sheet', tab: 'Users', range: 'A2:A10', checkedAt: '2026-10-30T00:00:00Z' }, usernames });
async function execute(options = {}) {
  const fixture = await syncFixture(browser, config, options);
  const snapshots = [];
  const report = await runSubscriberSync(input(options.usernames), { config, apply: options.apply ?? true, openSession: async () => fixture.session, checkpoint: async value => snapshots.push(value) });
  return { ...fixture, report, snapshots };
}

test('exact subscribers synchronize once, reopen for verification, return to list, and log out', async () => {
  const { report, events, snapshots } = await execute({ usernames: ['sync.one', '000123', 'sync.one'] });
  assert.equal(report.status, 'COMPLETED', JSON.stringify(report));
  assert.deepEqual(events.filter(e => e.action === 'synchronize').map(e => e.username), ['sync.one', '000123']);
  assert.equal(report.summary.dispatched, 2);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every(r => r.outcome === 'SYNC_RESPONSE_VERIFIED'));
  assert.ok(snapshots.some(r => r.results[0].outcome === 'SYNC_STARTED_UNVERIFIED' && !r.results[0].requestDispatched));
  assert.equal(report.cleanup.logout, 'SIGNED_OUT_VERIFIED');
  assert.equal(report.cleanup.browser, 'CLOSED');
});
test('preview opens the exact subscriber without a synchronization request', async () => {
  const { report, events } = await execute({ apply: false });
  assert.equal(report.status, 'PREVIEW_COMPLETED', JSON.stringify(report));
  assert.equal(report.results[0].outcome, 'WOULD_SYNCHRONIZE');
  assert.equal(events.filter(e => e.action === 'synchronize').length, 0);
});
test('a missing username is reported and the next user still runs', async () => {
  const { report, events } = await execute({ usernames: ['missing.user', 'sync.one'] });
  assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
  assert.deepEqual(report.results.map(r => r.outcome), ['USER_NOT_FOUND', 'SYNC_RESPONSE_VERIFIED']);
  assert.equal(events.filter(e => e.action === 'synchronize').length, 1);
});
for (const [name, options, code] of [
  ['duplicate exact users', { users: [...records(), { ...records()[0], subscriberId: '303' }] }, 'AMBIGUOUS_SUBSCRIBER'],
  ['incomplete search', { partialResults: true }, 'PARTIAL_SEARCH'],
  ['wrong profile', { wrongDetail: true }, 'SUBSCRIBER_IDENTITY'],
  ['no sync permission', { users: [{ ...records()[0], accesses: { canSync: false } }] }, 'SYNC_PERMISSION']
]) test(`${name} stops before synchronization`, async () => {
  const { report, events } = await execute(options);
  assert.equal(report.results[0].error.code, code, JSON.stringify(report));
  assert.equal(events.filter(e => e.action === 'synchronize').length, 0);
});
for (const options of [{ responseLost: true }, { serverError: true }, { wrongSyncIdentity: true }]) test(`uncertain synchronization halts without retry: ${Object.keys(options)[0]}`, async () => {
  const { report, events } = await execute({ ...options, usernames: ['sync.one', '000123'] });
  assert.equal(report.results[0].outcome, 'SYNC_UNVERIFIED');
  assert.equal(report.results[1].outcome, 'NOT_PROCESSED');
  assert.equal(events.filter(e => e.action === 'synchronize').length, 1);
  assert.equal(report.cleanup.logout, 'SIGNED_OUT_VERIFIED');
});
test('wrong subscriber in the outgoing GET is blocked before transmission', async () => {
  const { report, events } = await execute({ wrongRequest: true });
  assert.equal(report.results[0].outcome, 'SYNC_UNVERIFIED');
  assert.equal(events.filter(e => e.action === 'synchronize').length, 0);
  assert.ok(report.blockedRequests.length);
});
test('automatic repeated GET after synchronization is blocked', async () => {
  const { report, events } = await execute({ repeatRequest: true });
  assert.equal(events.filter(e => e.action === 'synchronize').length, 1);
  assert.equal(report.results[0].outcome, 'SYNC_UNVERIFIED');
});
test('GET mutations remain blocked during preview, including unreviewed APIs', async () => {
  const f = await syncFixture(browser, config, { apply: false });
  try {
    await f.session.ensureLogin();
    await f.page.evaluate(async () => {
      await fetch('/api/index_dev.php/synchronization/syncSubscriber?username=sync.one&subscriberId=101&subscriberErpId=1001').catch(() => {});
      await fetch('/api/index_dev.php/subscriber/resetMac?subscriberId=101').catch(() => {});
      await fetch('/api/index.php/synchronization/syncSubscriber?subscriberId=101').catch(() => {});
    });
    assert.equal(f.events.filter(e => e.action === 'synchronize' || e.action === 'unexpected-api').length, 0);
    assert.equal(f.session.blocked.length, 3);
  } finally { await f.session.logout(); await f.session.close(); }
});
test('logout errors are visible without changing the verified synchronization outcome', async () => {
  const { report } = await execute({ logoutFails: true });
  assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
  assert.equal(report.results[0].outcome, 'SYNC_RESPONSE_VERIFIED');
  assert.equal(report.cleanup.logout, 'LOGOUT_FAILED');
  assert.equal(report.cleanup.browser, 'CLOSED');
});
test('input validation preserves case/zeroes, deduplicates and rejects missing sheet scope', () => {
  assert.deepEqual(validateSyncInput(input(['000123', 'sync.one', '000123'])).usernames, ['000123', 'sync.one']);
  for (const bad of [{}, { ...input(), tenant: 'south' }, input([123]), input([]), { ...input(), source: {} }]) assert.throws(() => validateSyncInput(bad), { code: 'SHEET_INPUT' });
  assert.throws(() => validateSyncInput(input(['sync.one', '000123']), 1), { code: 'SHEET_INPUT' });
});
test('request scope binds exact origin, route, method and all three identity fields', () => {
  const record = { username: 'sync.one', subscriberId: '101', subscriberErpId: '1001' };
  const url = new URL(PROCARE_SYNC.origin + PROCARE_SYNC.apiPrefix + PROCARE_SYNC.syncRoute + '?' + new URLSearchParams(record));
  assert.equal(matchesSyncRequest(url, 'GET', record), true);
  assert.equal(matchesSyncRequest(url, 'POST', record), false);
  assert.equal(matchesSyncRequest(url, 'GET', null), false);
  url.searchParams.append('subscriberId', '101');
  assert.equal(matchesSyncRequest(url, 'GET', record), false);
  assert.throws(() => validateSyncConfig({ ...config, origin: 'https://other.invalid' }), { code: 'SYNC_ENVIRONMENT' });
  assert.throws(() => readProcareResult({ result: {}, messages: [{ type: 'error' }] }), { code: 'PROCARE_RESPONSE' });
});
