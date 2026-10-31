import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testBrowser } from './fixtures.mjs';
import { workforceFixture } from './workforce-fixture.mjs';
import { runWorkforceTask, validateWorkforceInput } from '../src/tasks/workforce-access.mjs';
import { approvedMembershipUpdate, validateWorkforceConfig } from '../src/integrations/workforce.mjs';

let browser, config;
before(async () => { browser = await testBrowser(); config = { ...JSON.parse(await fs.readFile(new URL('../config/workforce-access.json', import.meta.url))), timeoutMs: 1100, headless: true, slowMo: 0, screenshots: false }; });
after(async () => { await browser?.close(); });
async function execute(options = {}, apply = true, action = 'grant') {
  const fixture = await workforceFixture(browser, config, options, apply, action), checkpoints = [];
  const report = await runWorkforceTask({ usernames: ['new.agent1'], tenant: 'both', apply, action }, { config, openSession: async () => fixture.session, checkpoint: async r => checkpoints.push(r) });
  return { ...fixture, report, checkpoints };
}
test('Workforce both tenants add only the exact user, preserve existing members, verify reload and logout', async () => {
  const { report, state, checkpoints } = await execute({ prefix: true });
  assert.equal(report.status, 'COMPLETED', JSON.stringify(report));
  assert.deepEqual(report.results.map(r => r.outcome), ['ACCESS_GRANTED_VERIFIED', 'ACCESS_GRANTED_VERIFIED']);
  assert.deepEqual(state.saves.map(s => s.tenant), ['north', 'south']);
  for (const tenant of ['north', 'south']) assert.deepEqual(state.groups[tenant].users.map(u => u.userName), ['existing.agent', 'new.agent1']);
  assert.notEqual(report.results[0].group.name, report.results[1].group.name);
  assert.ok(checkpoints.some(r => r.results.some(row => row.outcome === 'SAVE_STARTED_UNVERIFIED')));
  assert.equal(report.writeRequests.length, 2); assert.equal(report.cleanup.logout, 'SIGNED_OUT_VERIFIED'); assert.equal(state.logoutClicks, 1);
});
test('Workforce preview searches both tenants but never changes a checkbox or sends a membership PUT', async () => {
  const { report, state } = await execute({}, false);
  assert.equal(report.status, 'PREVIEW_COMPLETED'); assert.equal(state.saves.length, 0);
  assert.deepEqual(report.results.map(r => r.outcome), ['WOULD_GRANT_ACCESS', 'WOULD_GRANT_ACCESS']);
});
test('regional Auth0 scripts work while optional external avatars remain blocked without failing the task', async () => {
  const { report } = await execute({ regionalAuthAssets: true }, false);
  assert.equal(report.status, 'PREVIEW_COMPLETED', JSON.stringify(report.error)); assert.equal(report.blockedRequests.length, 0);
});
test('persistent Save footer does not block verified readback or trigger a repeated save', async () => {
  const { report, state } = await execute({ keepSaveBar: true });
  assert.equal(report.status, 'COMPLETED', JSON.stringify(report.results)); assert.equal(state.saves.length, 2);
  assert.deepEqual(report.results.map(r => r.outcome), ['ACCESS_GRANTED_VERIFIED', 'ACCESS_GRANTED_VERIFIED']);
});
for (const tenant of ['north', 'south']) test(`missing username in ${tenant} still completes the other tenant and names the missing tenant`, async () => {
  const { report, state } = await execute({ missing: tenant });
  assert.equal(report.results.find(r => r.tenant === tenant).outcome, 'USER_NOT_FOUND');
  assert.match(report.results.find(r => r.tenant === tenant).message, new RegExp(tenant));
  assert.equal(report.results.find(r => r.tenant !== tenant).outcome, 'ACCESS_GRANTED_VERIFIED');
  assert.equal(state.saves.length, 1);
});
test('already selected North membership is preserved without another save while South is granted', async () => {
  const { report, state } = await execute({ already: 'north' });
  assert.deepEqual(report.results.map(r => r.outcome), ['ALREADY_MEMBER', 'ACCESS_GRANTED_VERIFIED']); assert.equal(state.saves.length, 1);
});
test('assigned users excluded from candidate search are recognized from persisted membership', async () => {
  const { report, state } = await execute({ already: 'north', excludeMembers: true });
  assert.deepEqual(report.results.map(r => r.outcome), ['ALREADY_MEMBER', 'ACCESS_GRANTED_VERIFIED']);
  assert.equal(state.searches.filter(search => search.tenant === 'north').length, 0);
  assert.equal(state.saves.length, 1); assert.equal(report.cleanup.logout, 'SIGNED_OUT_VERIFIED');
});
for (const options of [{ doNotPersist: true }, { saveResponseLost: true }]) test(`uncertain Workforce save halts without a repeated PUT: ${Object.keys(options)[0]}`, async () => {
  const { report, state } = await execute(options);
  assert.equal(report.results[0].outcome, 'SAVE_UNVERIFIED'); assert.equal(report.results[1].outcome, 'NOT_PROCESSED'); assert.equal(state.saves.length, 1);
});
for (const options of [{ duplicate: 'north' }, { searchFails: 'north' }, { wrongTenant: true }]) test(`invalid search or tenant cannot cause a save: ${Object.keys(options)[0]}`, async () => {
  const { report, state } = await execute(options);
  assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS'); assert.equal(state.saves.length, 0);
});
test('logout failure is separate from the verified membership outcomes', async () => {
  const { report } = await execute({ logoutFails: true });
  assert.equal(report.results[1].outcome, 'ACCESS_GRANTED_VERIFIED'); assert.equal(report.cleanup.logout, 'LOGOUT_FAILED'); assert.equal(report.status, 'COMPLETED_WITH_EXCEPTIONS');
});
test('actual request interception blocks a group-property change before transmission', async () => {
  const { report, state } = await execute({ editName: true });
  assert.equal(state.saves.length, 0); assert.equal(report.writeRequests.length, 0);
  assert.ok(report.blockedRequests.length > 0); assert.equal(report.results[1].outcome, 'NOT_PROCESSED');
  assert.equal(state.groups.north.name, 'First North Group');
});
test('membership request guard allows one addition but blocks other group properties, members, tenants and origins', () => {
  const record = { id: '11111111-1111-4111-8111-111111111111', name: 'Any first group', employeeUserId: '1', isDefault: true, users: [{ id: 'old', userId: '1', userName: 'existing', userGroupId: '11111111-1111-4111-8111-111111111111' }] };
  const candidate = { id: 'new', userId: '2', userName: 'new.agent1', userGroupId: null }, arm = { tenant: 'north', username: 'new.agent1', record, candidate };
  const url = new URL('https://staging-wf.excitel.in/api/v1.0/delhi/UserGroup'), body = { ...record, users: [...record.users, candidate] };
  assert.equal(approvedMembershipUpdate(url, 'PUT', body, arm), true);
  for (const bad of [{ ...body, name: 'Changed' }, { ...body, employeeUserId: '2' }, { ...body, extra: 1 }, { ...body, users: [candidate] }, { ...body, users: [...body.users, { ...candidate, id: 'third' }] }]) assert.equal(approvedMembershipUpdate(url, 'PUT', bad, arm), false);
  assert.equal(approvedMembershipUpdate(url, 'PUT', body, null), false);
  assert.equal(approvedMembershipUpdate(new URL('https://wf.excitel.in/api/v1.0/delhi/UserGroup'), 'PUT', body, arm), false);
  assert.equal(approvedMembershipUpdate(new URL('https://staging-wf.excitel.in/api/v1.0/hyderabad/UserGroup'), 'PUT', body, arm), false);
});
test('Workforce requires an explicit tenant, keeps exact usernames and rejects production configuration', () => {
  assert.deepEqual(validateWorkforceInput({ usernames: ['SAHIL_240', 'SAHIL_240'], tenant: 'both' }).tenants, ['north', 'south']);
  assert.equal(validateWorkforceInput({ usernames: ['000123'], tenant: 'DELHI' }).usernames[0], '000123');
  assert.throws(() => validateWorkforceInput({ usernames: ['new.agent1'] }), { code: 'INVALID_TENANT' });
  assert.throws(() => validateWorkforceConfig({ ...config, workforceOrigin: 'https://wf.excitel.in' }), { code: 'WRONG_ENVIRONMENT' });
});
test('registered Workforce CLI exposes help without opening a browser', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.mjs', '--task', 'workforce-access', '--help'], { timeout: 5000 });
  assert.match(stdout, /--tenant north\|south\|both/); assert.match(stdout, /WORKFORCE_PASSWORD/); assert.match(stdout, /--action grant\|remove/);
});

test('removal in both tenants removes only the exact member, preserves others and logs out', async () => {
  const { report, state, checkpoints } = await execute({ already: ['north', 'south'], excludeMembers: true, keepSaveBar: true }, true, 'remove');
  assert.equal(report.status, 'COMPLETED', JSON.stringify(report));
  assert.equal(report.action, 'remove'); assert.equal(report.summary.removed, 2); assert.equal(report.summary.granted, 0);
  assert.deepEqual(report.results.map(r => [r.before, r.after, r.outcome]), [[true, false, 'ACCESS_REMOVED_VERIFIED'], [true, false, 'ACCESS_REMOVED_VERIFIED']]);
  assert.deepEqual(state.saves.map(save => save.tenant), ['north', 'south']);
  for (const tenant of ['north', 'south']) assert.deepEqual(state.groups[tenant].users.map(user => user.userName), ['existing.agent']);
  assert.equal(state.searches.length, 0); assert.ok(checkpoints.some(r => r.results.some(row => row.outcome === 'SAVE_STARTED_UNVERIFIED')));
  assert.ok(report.writeRequests.every(write => write.action === 'remove')); assert.equal(report.cleanup.logout, 'SIGNED_OUT_VERIFIED');
});
test('removal preview leaves checked membership and the backend unchanged', async () => {
  const { report, state } = await execute({ already: ['north', 'south'] }, false, 'remove');
  assert.equal(report.status, 'PREVIEW_COMPLETED'); assert.equal(state.saves.length, 0);
  assert.deepEqual(report.results.map(r => r.outcome), ['WOULD_REMOVE_ACCESS', 'WOULD_REMOVE_ACCESS']);
  assert.equal(state.groups.north.users.length, 2); assert.equal(state.groups.south.users.length, 2);
});
test('removal skips already-absent membership and still removes the member in the other tenant', async () => {
  const { report, state } = await execute({ already: 'south' }, true, 'remove');
  assert.deepEqual(report.results.map(r => r.outcome), ['ALREADY_NOT_MEMBER', 'ACCESS_REMOVED_VERIFIED']); assert.equal(state.saves.length, 1);
});
for (const tenant of ['north', 'south']) test(`removal reports unavailable user in ${tenant} and processes the other tenant`, async () => {
  const other = tenant === 'north' ? 'south' : 'north';
  const { report, state } = await execute({ already: other, missing: tenant }, true, 'remove');
  assert.equal(report.results.find(r => r.tenant === tenant).outcome, 'USER_NOT_FOUND');
  assert.equal(report.results.find(r => r.tenant === other).outcome, 'ACCESS_REMOVED_VERIFIED'); assert.equal(state.saves.length, 1);
});
for (const option of ['doNotPersist', 'saveResponseLost']) test(`uncertain removal stops without repeating Save: ${option}`, async () => {
  const { report, state } = await execute({ already: ['north', 'south'], [option]: true }, true, 'remove');
  assert.equal(report.results[0].outcome, 'SAVE_UNVERIFIED'); assert.equal(report.results[1].outcome, 'NOT_PROCESSED'); assert.equal(state.saves.length, 1);
});
test('group default-user removal is blocked before any checkbox or Save change', async () => {
  const { report, state } = await execute({ already: ['north', 'south'], defaultTarget: true }, true, 'remove');
  assert.equal(report.results[0].error.code, 'DEFAULT_USER_REMOVAL'); assert.equal(state.saves.length, 0); assert.equal(state.groups.north.users.length, 2);
});
test('removal transport rejects edits to unrelated group settings', async () => {
  const { report, state } = await execute({ already: ['north', 'south'], editName: true }, true, 'remove');
  assert.equal(state.saves.length, 0); assert.equal(report.writeRequests.length, 0); assert.ok(report.blockedRequests.length > 0);
});
test('removal request guard permits one exact deletion and rejects extra deletions, additions or member edits', () => {
  const groupId = '11111111-1111-4111-8111-111111111111';
  const owner = { id: 'owner', userId: '1', userName: 'owner', userGroupId: groupId }, candidate = { id: 'target', userId: '2', userName: 'target', userGroupId: groupId };
  const record = { id: groupId, name: 'Group', employeeUserId: '1', isDefault: true, users: [owner, candidate] };
  const body = { ...record, users: [owner] }, arm = { tenant: 'north', username: 'target', record, candidate, action: 'remove' }, url = new URL('https://staging-wf.excitel.in/api/v1.0/delhi/UserGroup');
  assert.equal(approvedMembershipUpdate(url, 'PUT', body, arm), true);
  for (const bad of [{ ...body, users: [] }, { ...body, users: [owner, candidate] }, { ...body, users: [{ ...owner, userName: 'modified' }] }, { ...body, employeeUserId: '2' }]) assert.equal(approvedMembershipUpdate(url, 'PUT', bad, arm), false);
  assert.equal(approvedMembershipUpdate(url, 'PUT', body, { ...arm, action: 'grant' }), false);
  assert.equal(approvedMembershipUpdate(url, 'PUT', { ...record, users: [candidate] }, { ...arm, username: 'owner', candidate: owner }), false);
  assert.equal(approvedMembershipUpdate(new URL('https://staging-wf.excitel.in/api/v1.0/hyderabad/UserGroup'), 'PUT', body, arm), false);
});
test('action defaults to grant and invalid removal aliases are rejected before browser access', async () => {
  assert.equal(validateWorkforceInput({ usernames: ['user'], tenant: 'north' }).action, 'grant');
  assert.equal(validateWorkforceInput({ usernames: ['user'], tenant: 'south', action: ' REMOVE ' }).action, 'remove');
  assert.throws(() => validateWorkforceInput({ usernames: ['user'], tenant: 'north', action: 'delete-account' }), { code: 'INVALID_ACTION' });
  await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.mjs', '--task', 'workforce-access', '--username', 'user', '--tenant', 'north', '--action', 'delete-account'], { timeout: 5000 }), error => error.code === 1 && /INVALID_ACTION/.test(error.stderr));
});
test('Workforce CLI rejects a missing tenant before reading credentials or launching a browser', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.mjs', '--task', 'workforce-access', '--username', 'new.agent1'], { timeout: 5000 }), error => error.code === 1 && /INVALID_TENANT/.test(error.stderr));
});
