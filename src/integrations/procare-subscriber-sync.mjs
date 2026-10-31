import { chromium } from 'playwright';
import { StopError, clean, disabled, exactPattern, uniqueVisible, waitFor, safeUrl, screenshot } from '../utils.mjs';

export const PROCARE_SYNC = Object.freeze({ origin: 'https://procare-del.north.excitel.in', auth: 'https://excitel.eu.auth0.com', apiPrefix: '/api/index_dev.php/', syncRoute: 'synchronization/syncSubscriber' });
export function validateSyncConfig(config) {
  if (config.environment !== 'production' || config.tenant !== 'north' || config.origin !== PROCARE_SYNC.origin || config.authOrigin !== PROCARE_SYNC.auth || config.apiPrefix !== PROCARE_SYNC.apiPrefix) throw new StopError('SYNC_ENVIRONMENT', 'Subscriber synchronization is configured only for the approved North production Procare application.');
  for (const key of ['timeoutMs', 'maxUsers']) if (!Number.isInteger(config[key]) || config[key] < 1) throw new StopError('CONFIG', `Invalid ${key}.`);
  if (typeof config.headless !== 'boolean' || typeof config.liveUiReviewed !== 'boolean' || !Array.isArray(config.readRoutes)) throw new StopError('CONFIG', 'Invalid synchronization browser or reviewed route configuration.');
}
export function subscriberIdentity(record, username) {
  const prefix = String(username).split('_T')[0];
  if (!record || !record.username || !String(record.username).startsWith(prefix) || !/^\d+$/.test(String(record.subscriberId))) {
    throw new StopError('SUBSCRIBER_IDENTITY', 'The exact username and numeric subscriber identities could not be verified.');
  }
  const subscriberErpId = record.subscriberErpId !== undefined && record.subscriberErpId !== null ? String(record.subscriberErpId).trim() : '';
  return { username: record.username, subscriberId: String(record.subscriberId), subscriberErpId };
}
export function matchesSyncRequest(url, method, expected) {
  if (!expected || method !== 'GET' || url.origin !== PROCARE_SYNC.origin || url.pathname !== PROCARE_SYNC.apiPrefix + PROCARE_SYNC.syncRoute) return false;
  const entries = [...url.searchParams];
  return entries.length === 3 && ['username', 'subscriberId', 'subscriberErpId'].every(key => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === expected[key]);
}
export function readProcareResult(body) {
  if (!body || typeof body.result !== 'object' || !body.result || body.confirmMessage ||
      (body.messages || []).some(message => /error|danger|fail/i.test(message.type || ''))) throw new StopError('PROCARE_RESPONSE', 'Procare returned an error, confirmation request or an unrecognized result.');
  return body.result;
}
const requestParams = request => request.method() === 'GET' ? new URL(request.url()).searchParams : new URLSearchParams(request.postData() || '');
const equalIdentity = (left, right) => left.subscriberId === right.subscriberId && left.username.split('_T')[0] === right.username.split('_T')[0];

export class ProcareSyncSession {
  constructor(page, browser, config, credentials, { apply = false, directory } = {}) {
    Object.assign(this, { page, browser, config, credentials, apply, directory });
    this.audit = []; this.blocked = []; this.armed = null; this.used = new Set(); this.phase = 'login';
  }
  assertClear() { if (this.blocked.length) throw new StopError('BLOCKED_REQUEST', 'An unexpected request or dialog was blocked. Review the private report before continuing.'); }
  assertApp() { this.assertClear(); if (new URL(this.page.url()).origin !== PROCARE_SYNC.origin) throw new StopError('WRONG_APPLICATION', 'Expected North production Procare.'); }
  isResponse(response, route, subscriberId) {
    const url = new URL(response.url());
    return url.origin === PROCARE_SYNC.origin && url.pathname === PROCARE_SYNC.apiPrefix + route && (!subscriberId || requestParams(response.request()).get('subscriberId') === subscriberId);
  }
  responseFor(route, subscriberId) {
    const promise = this.page.waitForResponse(response => this.isResponse(response, route, subscriberId), { timeout: this.config.timeoutMs });
    promise.catch(() => {}); return promise;
  }
  async result(response) {
    if (!response.ok()) throw new StopError('PROCARE_HTTP', `Procare returned HTTP ${response.status()}; no synchronization is retried.`);
    return readProcareResult(await response.json());
  }
  async ensureLogin() {
    await this.page.goto(PROCARE_SYNC.origin + '/', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => await this.page.locator('a[href="/subscriber"]').isVisible() || await this.page.locator('input[name="password"]').isVisible(), { timeoutMs: this.config.timeoutMs, description: 'production Procare login or sidebar' });
    if (!await this.page.locator('a[href="/subscriber"]').isVisible()) {
      if (new URL(this.page.url()).origin !== PROCARE_SYNC.auth) throw new StopError('LOGIN_ORIGIN', 'Production credentials may only be entered on the reviewed Procare sign-in origin.');
      if (!this.credentials.username || !this.credentials.password) throw new StopError('LOGIN_CONFIG', 'Fill PROCARE_SYNC_USERNAME and PROCARE_SYNC_PASSWORD in the local .env.');
      await (await uniqueVisible(this.page.locator('input[name="username"]'), 'production username', this.config.timeoutMs)).fill(this.credentials.username);
      await (await uniqueVisible(this.page.locator('input[name="password"]'), 'production password', this.config.timeoutMs)).fill(this.credentials.password);
      await (await uniqueVisible(this.page.locator('button[name="submit"]'), 'production login', this.config.timeoutMs)).click();
    }
    await uniqueVisible(this.page.locator('a[href="/subscriber"]'), 'Subscribers navigation', this.config.timeoutMs);
    this.assertApp(); this.phase = 'read';
  }
  async assertSubscriber(expected) {
    this.assertApp();
    const match = new URL(this.page.url()).pathname.match(/^\/subscriber\/(\d+)(?:\/|$)/);
    if (!match || match[1] !== expected.subscriberId) throw new StopError('SUBSCRIBER_IDENTITY', 'The opened subscriber ID differs from the selected user.');
    const prefix = expected.username.split('_T')[0];
    const username = await uniqueVisible(this.page.locator('.subscriber-details-container-header > span').filter({ hasText: new RegExp(`^\\s*${prefix}`) }), 'subscriber detail username', this.config.timeoutMs);
    if (!clean(await username.innerText()).startsWith(prefix)) throw new StopError('SUBSCRIBER_IDENTITY', 'The opened username differs from the requested user.');
  }
  async findSubscriber(username) {
    this.assertApp(); this.current = null;
    await (await uniqueVisible(this.page.locator('a[href="/subscriber"]'), 'Subscribers navigation', this.config.timeoutMs)).click();
    const search = await uniqueVisible(this.page.locator('input[placeholder="UserID or #Number"]'), 'subscriber search', this.config.timeoutMs);
    // Clear any remembered search so even repeated lookups produce a fresh request.
    await search.fill('');
    const response = this.page.waitForResponse(res => this.isResponse(res, 'subscriber/list') && requestParams(res.request()).get('searchText') === username, { timeout: this.config.timeoutMs }); response.catch(() => {});
    await search.fill(username);
    const data = await this.result(await response);
    if (!Array.isArray(data.subscriberList) || !Number.isInteger(Number(data.totalEntries)) || Number(data.totalEntries) !== data.subscriberList.length) throw new StopError('PARTIAL_SEARCH', 'The subscriber search did not return a complete result set. Refine the username; nothing is synchronized.');
    const matches = data.subscriberList.filter(row => row.username === username);
    if (matches.length > 1) throw new StopError('AMBIGUOUS_SUBSCRIBER', 'Multiple exact username matches; no subscriber selected.');
    if (!matches.length) return null;
    const identity = subscriberIdentity(matches[0], username);
    const row = await uniqueVisible(this.page.locator('tbody tr').filter({ hasText: username }), 'exact subscriber result row', this.config.timeoutMs);
    const detail = this.responseFor('subscriber/showDashboard', identity.subscriberId);
    await row.click();
    const record = (await this.result(await detail)).subscriberData;
    const detailIdentity = subscriberIdentity(record, username);
    if (detailIdentity.subscriberId !== identity.subscriberId) throw new StopError('SUBSCRIBER_IDENTITY', 'Search and detail identities disagree.');
    await this.assertSubscriber(detailIdentity);
    const button = await uniqueVisible(this.page.locator('button').filter({ hasText: /Synchronize/i }), 'Synchronize button', this.config.timeoutMs);
    if (record.accesses?.canSync !== true && record.accesses?.canSync !== 1) throw new StopError('SYNC_PERMISSION', 'Procare does not grant synchronization permission for this subscriber.');
    if (await disabled(button)) throw new StopError('SYNC_DISABLED', 'The synchronization button is disabled.');
    this.current = { ...detailIdentity, detailUrl: safeUrl(this.page.url()) };
    return { ...this.current };
  }
  async prepareSynchronization(expected, onDispatched = async () => {}) {
    await this.assertSubscriber(expected);
    if (!this.apply || !this.config.liveUiReviewed || !this.current || !equalIdentity(expected, this.current) || this.used.has(expected.subscriberId)) throw new StopError('SYNC_SCOPE', 'Synchronization requires apply mode, reviewed UI, the exact selected subscriber, and no earlier attempt.');
    let attempted = false;
    return async () => {
      if (attempted) throw new StopError('DUPLICATE_SYNC', 'Synchronization must not be clicked again for this subscriber.');
      attempted = true;
      await this.assertSubscriber(expected);
      const button = await uniqueVisible(this.page.locator('button').filter({ hasText: /Synchronize/i }), 'Synchronize button', this.config.timeoutMs);
      if (await disabled(button)) throw new StopError('SYNC_DISABLED', 'Synchronization became disabled.');
      const response = this.responseFor(PROCARE_SYNC.syncRoute, expected.subscriberId);
      this.armed = { expected: { ...expected }, onDispatched };
      let result, httpError;
      try {
        await button.click();
        try {
          result = await this.result(await response);
          if (result?.subscriberData && !equalIdentity(subscriberIdentity(result.subscriberData, expected.username), expected)) {
            throw new StopError('SYNC_UNVERIFIED', 'Synchronization did not return the expected subscriber identity.');
          }
        } catch (error) {
          httpError = error;
        }
        this.assertClear();
        if (!this.used.has(expected.subscriberId)) throw new StopError('SYNC_UNVERIFIED', 'Synchronization request was not recorded by guard.');
      } finally { this.armed = null; }
      // Reopen the profile without replaying the synchronization request.
      const fresh = this.responseFor('subscriber/showDashboard', expected.subscriberId);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      const record = (await this.result(await fresh)).subscriberData;
      if (String(record.subscriberId) !== expected.subscriberId) throw new StopError('SYNC_UNVERIFIED', 'Subscriber identity changed after synchronization.');
      const prefix = expected.username.split('_T')[0];
      if (!record.username.startsWith(prefix)) throw new StopError('SYNC_UNVERIFIED', 'Subscriber username changed unexpectedly after synchronization.');
      if (httpError && !record.username.includes('_T')) throw httpError;
      await this.assertSubscriber(expected);
      const evidence = this.directory ? await screenshot(this.page, this.directory, `subscriber-${expected.subscriberId}-sync`, this.config.screenshots) : '';
      return { ...expected, outcome: 'SYNC_RESPONSE_VERIFIED', verifiedAt: new Date().toISOString(), evidence,
        meaning: 'Procare returned a successful synchronization result for this subscriber and its profile reloaded with the same identity. Downstream systems are not independently checked.' };
    };
  }
  async logout() {
    this.armed = null; this.phase = 'logout';
    const login = async () => new URL(this.page.url()).origin === PROCARE_SYNC.auth && await this.page.locator('input[name="password"]').isVisible();
    const already = await login();
    if (!already) {
      if (new URL(this.page.url()).origin !== PROCARE_SYNC.origin) throw new StopError('LOGOUT_ORIGIN', 'Unexpected application during logout.');
      const control = this.page.locator('.profile .dropdown a:has(i.fa-sign-out)');
      if (!await control.isVisible()) await (await uniqueVisible(this.page.locator('.profile.cpointer'), 'profile menu', this.config.timeoutMs)).click();
      await (await uniqueVisible(control, 'Procare logout', this.config.timeoutMs)).click();
    }
    await waitFor(login, { timeoutMs: this.config.timeoutMs, description: 'logged-out production login form' });
    await this.page.goto(PROCARE_SYNC.origin + '/', { waitUntil: 'domcontentloaded' });
    await waitFor(login, { timeoutMs: this.config.timeoutMs, description: 'login required after reopening Procare' });
    return already ? 'ALREADY_SIGNED_OUT' : 'SIGNED_OUT_VERIFIED';
  }
  async close() { await this.browser.close(); }
  async diagnostics() {
    return {
      url: safeUrl(this.page.url()),
      screenshot: this.directory ? await screenshot(this.page, this.directory, 'failure', this.config.screenshots) : '',
      inputs: await this.page.locator('input').evaluateAll(es => es.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder }))),
      buttons: await this.page.locator('button').evaluateAll(es => es.map(e => ({ name: e.name, text: e.textContent.trim() })))
    };
  }
}

export async function installSyncGuard(context, session) {
  const staticOrigins = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.auth0.com', 'https://cdn.eu.auth0.com', 'https://excitelresources.azureedge.net']);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const block = async reason => { session.blocked.push({ method: req.method(), url: safeUrl(url.href), reason }); return route.abort(); };
    if (url.origin === PROCARE_SYNC.origin && url.pathname.startsWith(PROCARE_SYNC.apiPrefix)) {
      const endpoint = url.pathname.slice(PROCARE_SYNC.apiPrefix.length);
      if (endpoint === PROCARE_SYNC.syncRoute) {
        const armed = session.armed; session.armed = null;
        if (!session.apply || !session.config.liveUiReviewed || !armed || !matchesSyncRequest(url, req.method(), armed.expected) || session.used.has(armed.expected.subscriberId)) return block('Synchronization outside the exact armed subscriber scope or a repeated request');
        session.used.add(armed.expected.subscriberId);
        const audit = { ...armed.expected, dispatchedAt: new Date().toISOString() };
        session.audit.push(audit);
        try { await armed.onDispatched(audit); } catch { return block('Could not persist the dispatch checkpoint'); }
        return route.fallback();
      }
      if (endpoint === 'logout' && req.method() === 'POST' && session.phase === 'logout') return route.fallback();
      if (session.config.readRoutes.includes(endpoint) && (req.method() === 'GET' || (req.method() === 'POST' && ['login', 'subscriber/list'].includes(endpoint)))) return route.fallback();
      if (req.method() === 'OPTIONS') return route.fallback();
      return block('Unreviewed Procare API route');
    }
    if (url.origin === PROCARE_SYNC.origin && url.pathname.startsWith('/api/')) return block('Unreviewed Procare API prefix');
    if (url.origin === PROCARE_SYNC.auth) return route.fallback();
    if (url.origin === PROCARE_SYNC.origin && ['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.fallback();
    if (staticOrigins.has(url.origin) && ['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.fallback();
    if (['image', 'font', 'stylesheet'].includes(req.resourceType()) || ['https://dc.services.visualstudio.com', 'https://api.mixpanel.com'].includes(url.origin)) return route.abort();
    return block('Unapproved external request');
  });
}
export async function createProcareSyncSession(config, credentials, options = {}) {
  validateSyncConfig(config);
  if (options.apply && !config.liveUiReviewed) throw new StopError('SYNC_UI_NOT_REVIEWED', 'Run and review a production preview before enabling Synchronize.');
  const browser = await chromium.launch({ headless: config.headless, slowMo: config.slowMo });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(config.timeoutMs);
    const page = await context.newPage();
    const session = new ProcareSyncSession(page, browser, config, credentials, options);
    page.on('dialog', async dialog => { session.blocked.push({ reason: 'Unexpected browser dialog', type: dialog.type() }); await dialog.dismiss(); });
    await installSyncGuard(context, session);
    return session;
  } catch (error) { await browser.close(); throw error; }
}
