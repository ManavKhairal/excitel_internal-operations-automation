import { chromium } from 'playwright';
import { isDeepStrictEqual } from 'node:util';
import { StopError, clean, disabled, exactPattern, screenshot, uniqueVisible, visibleItems, waitFor, safeUrl } from '../utils.mjs';

export const WORKFORCE_STAGING = Object.freeze({ portal: 'https://staging-portal.excitel.in', app: 'https://staging-wf.excitel.in', auth: 'https://excitel-prerelease.eu.auth0.com' });
const tenantKeys = { north: 'delhi', south: 'hyderabad' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const clone = value => structuredClone(value);
export function validateWorkforceConfig(config) {
  if (config.environment !== 'staging' || config.portalUrl !== WORKFORCE_STAGING.portal + '/choose-app' || config.workforceOrigin !== WORKFORCE_STAGING.app || config.authOrigin !== WORKFORCE_STAGING.auth) throw new StopError('WRONG_ENVIRONMENT', 'Only the reviewed staging Portal, Workforce and Auth0 URLs are supported.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || !Number.isInteger(config.maxUsers) || config.maxUsers < 1 || typeof config.headless !== 'boolean') throw new StopError('CONFIG', 'Invalid Workforce timeout, maximum users or browser visibility setting.');
}
export function approvedMembershipUpdate(url, method, body, armed) {
  if (!armed || method !== 'PUT' || url.origin !== WORKFORCE_STAGING.app || url.search || url.pathname !== `/api/v1.0/${tenantKeys[armed.tenant]}/UserGroup`) return false;
  const before = armed.record, candidate = armed.candidate;
  const action = armed.action ?? 'grant';
  if (!['grant', 'remove'].includes(action)) return false;
  if (!before || !candidate || !uuid.test(before.id) || candidate.userName !== armed.username || (candidate.userGroupId && candidate.userGroupId !== before.id)) return false;
  if (!body || !Array.isArray(body.users) || !Array.isArray(before.users) || !isDeepStrictEqual(Object.keys(body).sort(), Object.keys(before).sort())) return false;
  for (const key of Object.keys(before)) if (key !== 'users' && !isDeepStrictEqual(before[key], body[key])) return false;
  if (new Set(body.users.map(user => user.id)).size !== body.users.length) return false;
  if (action === 'remove') {
    if (String(candidate.userId) === String(before.employeeUserId) || before.users.filter(user => user.userId === candidate.userId).length !== 1 || !isDeepStrictEqual(candidate, before.users.find(user => user.id === candidate.id))) return false;
    const remaining = before.users.filter(user => user.id !== candidate.id);
    return body.users.length === remaining.length && !body.users.some(user => user.userId === candidate.userId) && remaining.every(member => isDeepStrictEqual(member, body.users.find(user => user.id === member.id)));
  }
  if (body.users.length !== before.users.length + 1 || before.users.some(user => user.userId === candidate.userId)) return false;
  for (const member of before.users) if (!isDeepStrictEqual(member, body.users.find(user => user.id === member.id))) return false;
  return isDeepStrictEqual(candidate, body.users.find(user => user.id === candidate.id));
}

export class WorkforceSession {
  constructor(page, context, config, credentials, { apply = false, action = 'grant', directory } = {}) {
    Object.assign(this, { page, context, config, credentials, apply, action, directory });
    this.tenant = null; this.armed = null; this.usedSaves = new Set(); this.blocked = []; this.writeAudit = [];
  }
  assertClear() { if (this.blocked.length) throw new StopError('BLOCKED_REQUEST', 'An unapproved Workforce request or dialog was blocked. No write is retried.'); }
  assertApp() { this.assertClear(); if (new URL(this.page.url()).origin !== WORKFORCE_STAGING.app) throw new StopError('WRONG_ENVIRONMENT', 'Workforce left the approved staging application.'); }
  async assertTenant() {
    this.assertApp();
    await uniqueVisible(this.page.getByRole('button', { name: exactPattern(tenantKeys[this.tenant], 'i') }), 'current Workforce tenant', this.config.timeoutMs);
  }
  async ensureLogin() {
    await this.page.goto(this.config.portalUrl, { waitUntil: 'domcontentloaded' });
    const ready = this.page.getByAltText('Workforce', { exact: true });
    await waitFor(async () => await ready.isVisible() || await this.page.locator('input[name="username"]').isVisible(), { timeoutMs: this.config.timeoutMs, description: 'Portal or its staging login form' });
    if (!await ready.isVisible()) {
      if (new URL(this.page.url()).origin !== WORKFORCE_STAGING.auth) throw new StopError('LOGIN_ORIGIN', 'Refusing Workforce credentials on an unapproved login origin.');
      if (!this.credentials.username || !this.credentials.password) throw new StopError('LOGIN_CONFIG', 'Set WORKFORCE_USERNAME and WORKFORCE_PASSWORD independently in the local .env.');
      await (await uniqueVisible(this.page.locator('input[name="username"]'), 'Workforce login username', this.config.timeoutMs)).fill(this.credentials.username);
      await (await uniqueVisible(this.page.locator('input[name="password"]'), 'Workforce login password', this.config.timeoutMs)).fill(this.credentials.password);
      await (await uniqueVisible(this.page.locator('button[name="submit"]'), 'Workforce login', this.config.timeoutMs)).click();
    }
    await uniqueVisible(ready, 'Workforce app tile', this.config.timeoutMs); this.assertClear();
  }
  async openTenant(tenant) {
    if (!Object.hasOwn(tenantKeys, tenant)) throw new StopError('INVALID_TENANT', 'Unknown Workforce tenant.');
    const origin = new URL(this.page.url()).origin;
    if (origin === WORKFORCE_STAGING.app && this.tenant) {
      await this.assertTenant();
      await (await uniqueVisible(this.page.getByRole('button', { name: exactPattern(tenantKeys[this.tenant], 'i') }), 'change tenant', this.config.timeoutMs)).click();
    } else {
      await this.page.goto(this.config.portalUrl, { waitUntil: 'domcontentloaded' });
      await (await uniqueVisible(this.page.getByAltText('Workforce', { exact: true }), 'Workforce tile', this.config.timeoutMs)).click();
    }
    await waitFor(() => new URL(this.page.url()).origin === WORKFORCE_STAGING.portal, { timeoutMs: this.config.timeoutMs, description: 'Portal tenant selection' });
    await uniqueVisible(this.page.getByRole('heading', { name: 'Workforce', exact: true }), 'Workforce tenant chooser', this.config.timeoutMs);
    const label = tenant === 'north' ? 'North India' : 'South India';
    const tile = this.page.getByRole('button').filter({ has: this.page.getByAltText(label, { exact: true }) });
    await (await uniqueVisible(tile, label, this.config.timeoutMs)).click(); this.tenant = tenant;
    await uniqueVisible(this.page.getByAltText('Sales', { exact: true }), 'Workforce Sales tile', this.config.timeoutMs);
    await this.assertTenant();
    await this.page.getByAltText('Sales', { exact: true }).click();
    await (await uniqueVisible(this.page.locator('[data-id="user-groups-menu"]'), 'User Groups (not CAF Counters)', this.config.timeoutMs)).click();
    await this.assertTenant();
  }
  groupPath(id) { return `/api/v1.0/${tenantKeys[this.tenant]}/UserGroup/${id}`; }
  async jsonResponse(response) { if (!response.ok()) throw new StopError('WORKFORCE_READ_FAILED', `Workforce returned HTTP ${response.status()}.`); return response.json(); }
  responseFor(path, method = 'GET') { return this.page.waitForResponse(response => new URL(response.url()).origin === WORKFORCE_STAGING.app && decodeURIComponent(new URL(response.url()).pathname) === decodeURIComponent(path) && response.request().method() === method, { timeout: this.config.timeoutMs }); }
  async openFirstGroup() {
    await this.assertTenant();
    // Position is intentional: the user requested the first group regardless of its name.
    const cell = this.page.locator('[data-id="user-groups-body-column-name"]').first();
    await cell.waitFor({ state: 'visible', timeout: this.config.timeoutMs });
    const response = this.page.waitForResponse(res => new URL(res.url()).origin === WORKFORCE_STAGING.app && new RegExp(`^/api/v1\\.0/${tenantKeys[this.tenant]}/UserGroup/[0-9a-f-]{36}$`, 'i').test(new URL(res.url()).pathname) && res.request().method() === 'GET', { timeout: this.config.timeoutMs }); response.catch(() => {});
    await cell.click(); const record = await this.jsonResponse(await response);
    const group = { id: record.id, name: record.name, url: safeUrl(this.page.url()) };
    this.validateRecord(record, group); this.record = record; await this.assertGroup(group);
    return group;
  }
  validateRecord(record, group) {
    if (!record || !uuid.test(record.id || '') || record.id !== group.id || record.name !== group.name || !Array.isArray(record.users) || record.users.some(user => !user.id || !user.userId || !user.userName) || new Set(record.users.map(user => user.id)).size !== record.users.length) throw new StopError('GROUP_IDENTITY', 'Missing or ambiguous group/member identity.');
  }
  async assertGroup(group) {
    await this.assertTenant();
    if (safeUrl(this.page.url()) !== WORKFORCE_STAGING.app + '/sales/user-group-edit/' + group.id) throw new StopError('GROUP_IDENTITY', 'The opened group ID differs from the selected group.');
    const name = await uniqueVisible(this.page.locator('[data-id="name-form-value"]'), 'group name', this.config.timeoutMs);
    if (clean(await name.innerText()) !== clean(group.name)) throw new StopError('GROUP_IDENTITY', 'The opened group name changed.');
  }
  async reloadGroup(group) {
    await this.assertGroup(group);
    const response = this.responseFor(this.groupPath(group.id)); response.catch(() => {});
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const record = await this.jsonResponse(await response); this.validateRecord(record, group); this.record = record;
    await this.assertGroup(group);
  }
  async inspectUser(username, group) {
    await this.assertGroup(group);
    // The available-user search can omit already assigned users. Establish
    // existing access from the persisted group before searching candidates.
    const members = this.record.users.filter(member => member.userName === username);
    if (members.length > 1) throw new StopError('AMBIGUOUS_USER', 'The group contains multiple exact username memberships.');
    if (members.length === 1) return { username, tenant: this.tenant, groupId: group.id, found: true, selected: true, isDefaultUser: String(members[0].userId) === String(this.record.employeeUserId), source: 'persisted-group' };
    await (await uniqueVisible(this.page.locator('[data-id="users-form-edit-icon"]'), 'group Users edit pencil', this.config.timeoutMs)).click();
    const search = await uniqueVisible(this.page.locator('[data-id="users-form-dropdown-dropdown-search-input"]'), 'group username search', this.config.timeoutMs);
    const response = this.responseFor(`/api/v1.0/${tenantKeys[this.tenant]}/UserGroup/UsersByUserName/${encodeURIComponent(username)}`); response.catch(() => {});
    await search.fill(username); const users = await this.jsonResponse(await response);
    if (!Array.isArray(users)) throw new StopError('USER_SEARCH', 'Username search did not return a complete candidate list.');
    const exact = users.filter(user => user.userName === username);
    if (exact.length > 1) throw new StopError('AMBIGUOUS_USER', 'Multiple exact username matches; no access changed.');
    const state = { username, tenant: this.tenant, groupId: group.id, found: exact.length === 1, selected: false };
    if (!exact.length) return state;
    const candidate = exact[0];
    if (!candidate.id || !candidate.userId || (candidate.userGroupId && candidate.userGroupId !== group.id)) throw new StopError('USER_IDENTITY', 'Candidate identity is incomplete or belongs to another group; reassignment is not allowed.');
    const option = this.page.locator('[data-id^="users-form-dropdown-option-"]').filter({ has: this.page.locator('[data-id="option-content"]').filter({ hasText: exactPattern(username) }) });
    const control = await uniqueVisible(option, 'exact username option', this.config.timeoutMs);
    const icon = clean(await (await uniqueVisible(control.locator('[data-id="option-checkbox-icon"]'), 'membership checkbox', this.config.timeoutMs)).innerText());
    if (!['check_box', 'check_box_outline_blank'].includes(icon)) throw new StopError('MEMBERSHIP_STATE', 'Unknown membership checkbox state.');
    state.selected = icon === 'check_box';
    if (state.selected !== this.record.users.some(member => member.userId === candidate.userId)) throw new StopError('MEMBERSHIP_STATE', 'Displayed checkbox and persisted group membership disagree.');
    this.selection = { state: clone(state), candidate: clone(candidate), record: clone(this.record), option: control };
    return state;
  }
  async prepareGrant(state, group) { return this.prepareMembershipChange(state, group, 'grant'); }
  async prepareRemoval(state, group) { return this.prepareMembershipChange(state, group, 'remove'); }
  async prepareMembershipChange(state, group, action) {
    await this.assertGroup(group);
    const desired = action === 'grant';
    if (!this.apply || this.action !== action || !state.found || state.selected === desired || state.tenant !== this.tenant || state.groupId !== group.id) throw new StopError('MEMBERSHIP_STATE', 'Apply mode and the verified membership state must match the requested action.');
    if (!desired) {
      const members = this.record.users.filter(member => member.userName === state.username);
      if (members.length !== 1 || this.record.users.filter(user => user.userId === members[0].userId).length !== 1) throw new StopError('USER_IDENTITY', 'The exact member to remove is missing or ambiguous.');
      if (String(members[0].userId) === String(this.record.employeeUserId)) throw new StopError('DEFAULT_USER_REMOVAL', 'The group default user cannot be removed without a separate default-user reassignment.');
      await (await uniqueVisible(this.page.locator('[data-id="users-form-edit-icon"]'), 'group Users edit pencil', this.config.timeoutMs)).click();
      await uniqueVisible(this.page.locator('[data-id="users-form-dropdown-dropdown-search-input"]'), 'Users dropdown', this.config.timeoutMs);
      // Selected members are already in the dropdown. Do not depend on the
      // available-user endpoint, which can exclude exactly these members.
      const option = await uniqueVisible(this.page.locator('[data-id^="users-form-dropdown-option-"]').filter({ has: this.page.locator('[data-id="option-content"]').filter({ hasText: exactPattern(state.username) }) }), 'exact selected member', this.config.timeoutMs);
      this.selection = { state: clone(state), candidate: clone(members[0]), record: clone(this.record), option };
    }
    const selected = this.selection;
    if (!selected || !isDeepStrictEqual(selected.state, state)) throw new StopError('MEMBERSHIP_STATE', 'A freshly verified exact member is required.');
    const icon = selected.option.locator('[data-id="option-checkbox-icon"]');
    if (clean(await icon.innerText()) !== (desired ? 'check_box_outline_blank' : 'check_box')) throw new StopError('MEMBERSHIP_STATE', 'Membership changed before the requested edit.');
    await selected.option.click();
    await waitFor(async () => clean(await icon.innerText()) === (desired ? 'check_box' : 'check_box_outline_blank'), { timeoutMs: this.config.timeoutMs, description: 'only the requested membership changed' });
    const bar = await uniqueVisible(this.page.locator('[data-id="user-groups-form-submit-bar"]'), 'group submit bar', this.config.timeoutMs);
    if (clean(await bar.locator('[data-id="user-groups-form-update-indicator"]').innerText()) !== '1 edited') throw new StopError('UNEXPECTED_EDITS', 'Only the Users field may be edited.');
    let attempted = false;
    return async () => {
      if (attempted) throw new StopError('DUPLICATE_SAVE', 'Workforce Save must not be repeated.'); attempted = true;
      await this.assertGroup(group);
      const save = await uniqueVisible(bar.locator('button[data-id="submit-form"]'), 'group Save', this.config.timeoutMs);
      if (await disabled(save)) throw new StopError('SAVE_DISABLED', 'Workforce Save is disabled.');
      this.armed = { record: clone(selected.record), candidate: clone(selected.candidate), tenant: this.tenant, username: state.username, action };
      const response = this.responseFor(`/api/v1.0/${tenantKeys[this.tenant]}/UserGroup`, 'PUT'); response.catch(() => {});
      try {
        await save.click(); const saved = await response;
        if (!saved.ok()) throw new StopError('SAVE_UNVERIFIED', `Save returned HTTP ${saved.status()}; no retry allowed.`);
        await saved.finished(); this.assertClear();
        // The live form can retain its footer after a successful PUT. Completion
        // is proved by fresh group readback, not footer visibility.
      } finally { this.armed = null; }
    };
  }
  async verifyGrant(state, group) { return this.verifyMembershipChange(state, group, 'grant'); }
  async verifyRemoval(state, group) { return this.verifyMembershipChange(state, group, 'remove'); }
  async verifyMembershipChange(state, group, action) {
    await this.reloadGroup(group);
    const actual = this.record, before = this.selection.record, candidate = this.selection.candidate;
    const member = actual.users.filter(user => user.userId === candidate.userId && user.userName === state.username);
    const removing = action === 'remove', preserved = removing ? before.users.filter(user => user.id !== candidate.id) : before.users;
    const targetCorrect = removing ? !actual.users.some(user => user.userId === candidate.userId || user.id === candidate.id || user.userName === state.username) : member.length === 1;
    if (!targetCorrect || actual.users.length !== before.users.length + (removing ? -1 : 1) || preserved.some(user => !isDeepStrictEqual(user, actual.users.find(fresh => fresh.id === user.id)))) throw new StopError('SAVE_UNVERIFIED', 'The requested membership change did not persist or other members changed.');
    for (const key of Object.keys(before)) if (key !== 'users' && !isDeepStrictEqual(before[key], actual[key])) throw new StopError('SAVE_UNVERIFIED', 'An unrelated group property changed.');
    const fresh = removing ? { username: state.username, tenant: this.tenant, groupId: group.id, found: true, selected: false, source: 'persisted-group-absence' } : await this.inspectUser(state.username, group);
    if (this.directory) fresh.evidence = await screenshot(this.page, this.directory, `${state.tenant}-${state.username}-${action}-verified`, this.config.screenshots);
    return fresh;
  }
  async cancelEditor(group) { this.armed = null; await this.reloadGroup(group); this.selection = null; }
  async logout() {
    this.armed = null; await this.page.keyboard.press('Escape').catch(() => {});
    const signOut = async () => {
      await (await uniqueVisible(this.page.locator('[data-id="avatar"]'), 'Workforce/Portal profile', this.config.timeoutMs)).click();
      await (await uniqueVisible(this.page.locator('[data-id="logout"]'), 'Workforce/Portal logout', this.config.timeoutMs)).click();
      await uniqueVisible(this.page.locator('input[name="password"]'), 'signed-out staging login form', this.config.timeoutMs);
      if (new URL(this.page.url()).origin !== WORKFORCE_STAGING.auth) throw new StopError('LOGOUT_FAILED', 'Logout did not reach the approved login origin.');
    };
    if ([WORKFORCE_STAGING.app, WORKFORCE_STAGING.portal].includes(new URL(this.page.url()).origin)) await signOut();
    await this.page.goto(this.config.portalUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => await this.page.locator('input[name="password"]').isVisible() || await this.page.getByAltText('Workforce', { exact: true }).isVisible(), { timeoutMs: this.config.timeoutMs, description: 'Portal logout verification' });
    if (await this.page.getByAltText('Workforce', { exact: true }).isVisible()) { await signOut(); await this.page.goto(this.config.portalUrl, { waitUntil: 'domcontentloaded' }); }
    await uniqueVisible(this.page.locator('input[name="password"]'), 'Portal requires login again', this.config.timeoutMs);
    await this.page.goto(WORKFORCE_STAGING.app + '/home', { waitUntil: 'domcontentloaded' });
    await uniqueVisible(this.page.locator('input[name="password"]'), 'Workforce requires login again', this.config.timeoutMs);
    if (new URL(this.page.url()).origin !== WORKFORCE_STAGING.auth) throw new StopError('LOGOUT_FAILED', 'Workforce login verification is on an unexpected origin.');
    return 'SIGNED_OUT_VERIFIED';
  }
  async close() { await this.context.close(); }
}

export async function installWorkforceGuard(session) {
  const reads = new Set([...Object.values(WORKFORCE_STAGING), 'https://excitelresources.blob.core.windows.net', 'https://excitelresources.azureedge.net', 'https://cdn.auth0.com', 'https://cdn.eu.auth0.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
    await session.context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.fallback();
      if (request.isNavigationRequest() && request.frame().parentFrame() === null && !Object.values(WORKFORCE_STAGING).includes(url.origin)) { session.blocked.push({ reason: 'UNAPPROVED_NAVIGATION', url: safeUrl(request.url()) }); return route.abort(); }
      if (url.origin === 'https://dc.services.visualstudio.com') return route.abort();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && reads.has(url.origin)) return route.fallback();
      // Optional external avatars/fonts can fail without invalidating a task.
      // They remain blocked; functional scripts, APIs and writes still stop it.
      if (['GET', 'HEAD'].includes(request.method()) && ['image', 'font'].includes(request.resourceType())) return route.abort();
      if (url.origin === WORKFORCE_STAGING.auth && request.method() === 'POST') return route.fallback();
      if (url.origin === WORKFORCE_STAGING.app && url.pathname === '/notification-hub/negotiate' && request.method() === 'POST') return route.fallback();
      let body; try { body = JSON.parse(request.postData() || 'null'); } catch {}
      const armed = session.armed, key = armed && `${armed.tenant}/${armed.record.id}/${armed.username}`;
      if (session.apply && (armed?.action ?? 'grant') === session.action && approvedMembershipUpdate(url, request.method(), body, armed) && !session.usedSaves.has(key)) {
        session.armed = null; session.usedSaves.add(key); session.writeAudit.push({ tenant: armed.tenant, groupId: armed.record.id, username: armed.username, action: armed.action ?? 'grant', dispatchedAt: new Date().toISOString() });
        return route.fallback();
      }
      session.blocked.push({ method: request.method(), url: safeUrl(request.url()) }); return route.abort();
    });
}

export async function createWorkforceSession(config, credentials, options = {}) {
  validateWorkforceConfig(config);
  const browser = await chromium.launch({ headless: config.headless, slowMo: config.slowMo ?? 0 });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(config.timeoutMs); const page = await context.newPage();
    const session = new WorkforceSession(page, context, config, credentials, options);
    session.close = () => browser.close();
    page.on('dialog', dialog => { session.blocked.push({ reason: 'UNEXPECTED_DIALOG' }); void dialog.dismiss(); });
    await installWorkforceGuard(session);
    return session;
  } catch (error) { await browser.close(); throw error; }
}
