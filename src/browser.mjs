import { chromium } from 'playwright';
import path from 'node:path';
import { StopError, uniqueVisible, visibleItems, privateDir, safeUrl, waitFor } from './utils.mjs';

// Staging origins are fixed in code. Production origins come only from the reviewed
// config/production.json file, never from CLI arguments, environment variables or the browser.
export const APPS = Object.freeze({
  procare: 'https://procare-del-prerelease.north.excitel.in',
  corehr: 'https://staging-hr.excitel.in'
});
export const ERP_ENVIRONMENTS = Object.freeze(['staging', 'production']);
const APP_NAMES = { procare: 'Procare', corehr: 'CoreHR' };

// Returns the exact application origins for the configured ERP environment.
export function erpOrigins(config = {}) {
  const environment = config.environment || 'staging';
  if (environment === 'staging') return APPS;
  if (environment !== 'production') throw new StopError('WRONG_ENVIRONMENT', 'ERP environment must be staging or production.');
  const origins = {};
  for (const kind of ['procare', 'corehr']) {
    const value = config.origins?.[kind];
    if (!value) throw new StopError('PRODUCTION_URL_MISSING', `Add the production ${APP_NAMES[kind]} URL to config/production.json under origins.${kind}.`);
    let url;
    try { url = new URL(value); } catch { throw new StopError('CONFIG', `origins.${kind} in config/production.json is not a valid URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new StopError('CONFIG', `origins.${kind} must be an HTTPS address such as https://example.excitel.in, without a path.`);
    }
    if (Object.values(APPS).includes(url.origin)) throw new StopError('CONFIG', `origins.${kind} points to a staging application. Use the production URL.`);
    origins[kind] = url.origin;
  }
  return Object.freeze(origins);
}

// Pages opened by createSession remember which environment's origins they belong to.
const pageOrigins = new WeakMap();
export function appOrigin(page, kind) { return pageOrigins.get(page)?.[kind] ?? APPS[kind]; }

export function assertStagingPage(page, kind) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch { origin = ''; }
  const expected = appOrigin(page, kind);
  if (origin !== expected) throw new StopError('WRONG_ENVIRONMENT', `${kind}: expected ${expected}, found ${origin || 'an invalid page'}. No changes allowed.`);
}

function exactOrigins(values) {
  return (values || []).map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new StopError('CONFIG', 'Additional origins must be exact HTTPS origins, without paths, credentials or wildcards.');
    }
    return url.origin;
  });
}

// Use the application's real logout action, then check that revisiting the app
// still requires login. Closing a persistent context alone preserves its session.
export async function logoutSession(session, config) {
  const { page, kind } = session;
  const app = config[kind];
  const home = appOrigin(page, kind);
  const allowedOrigins = new Set([home, ...exactOrigins(app.additionalNavigationOrigins)]);
  const signedOut = async () => {
    if (!allowedOrigins.has(new URL(page.url()).origin)) return false;
    if ((await visibleItems(session.readyLocator())).length) return false;
    for (const selector of [app.login.usernameSelector, app.login.passwordSelector, app.login.submitSelector]) {
      if (!selector || (await visibleItems(page.locator(selector))).length !== 1) return false;
    }
    return true;
  };
  const alreadySignedOut = await signedOut();
  if (!alreadySignedOut) {
    assertStagingPage(page, kind);
    if (!app.logout?.menuSelector || !app.logout?.logoutSelector) {
      throw new StopError('LOGOUT_CONFIG', `${kind}: verified logout selectors are required.`);
    }
    const logout = page.locator(app.logout.logoutSelector);
    if (!(await visibleItems(logout)).length) {
      await (await uniqueVisible(page.locator(app.logout.menuSelector), `${kind} profile menu`, config.timeoutMs)).click();
    }
    const control = await uniqueVisible(logout, `${kind} Logout`, config.timeoutMs);
    assertStagingPage(page, kind);
    await control.click();
  }
  await waitFor(signedOut, { timeoutMs: config.timeoutMs, description: `${kind} signed-out login form` });
  await page.goto(home + '/', { waitUntil: 'domcontentloaded' });
  await waitFor(signedOut, { timeoutMs: config.timeoutMs, description: `${kind} requires login after reopening` });
  return {
    application: kind,
    outcome: alreadySignedOut ? 'ALREADY_SIGNED_OUT' : 'SIGNED_OUT_VERIFIED',
    message: 'Login is required after reopening the application.',
    finishedAt: new Date().toISOString()
  };
}

export async function createSession(kind, config, root, { headless = false, ask } = {}) {
  const app = config[kind];
  const environment = config.environment || 'staging';
  const origins = erpOrigins(config);
  const home = origins[kind];
  // Production keeps its own browser profile so staging and production sessions never mix.
  const profile = path.join(root, '.state', 'profiles', environment === 'production' ? `production-${kind}` : kind);
  await privateDir(profile);
  const navigationOrigins = new Set([home, ...exactOrigins(app.additionalNavigationOrigins)]);
  const writeOrigins = new Set([home, ...exactOrigins(app.additionalWriteOrigins)]);
  const blocked = [];
  const unexpectedDialogs = [];
  const context = await chromium.launchPersistentContext(profile, {
    headless,
    ...(config.browserExecutablePath ? { executablePath: config.browserExecutablePath } : {}),
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
    serviceWorkers: 'block'
  });
  context.setDefaultTimeout(config.timeoutMs);
  context.setDefaultNavigationTimeout(config.timeoutMs);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    const mainNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
    const mutatingMethod = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
    if ((mainNavigation && !navigationOrigins.has(url.origin)) || (mutatingMethod && !writeOrigins.has(url.origin))) {
      blocked.push({ method: request.method(), url: safeUrl(url.href), navigation: mainNavigation });
      console.error(`[BLOCKED] ${request.method()} ${safeUrl(url.href)}. Review the ${environment}/SSO origin allowlist.`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const configurePage = page => { pageOrigins.set(page, origins); page.on('dialog', async dialog => {
    unexpectedDialogs.push(dialog.type());
    await dialog.dismiss().catch(() => {});
  }); };
  for (const page of context.pages()) configurePage(page);
  context.on('page', configurePage);
  const page = context.pages()[0] || await context.newPage();
  const session = {
    page, context, kind,
    assertClear() {
      if (blocked.length) throw new StopError('BLOCKED_ORIGIN', `Blocked ${blocked.length} unapproved navigation/API request(s). See terminal for the origin; confirm its ${environment}/SSO purpose before editing config.`);
      if (unexpectedDialogs.length) throw new StopError('UNEXPECTED_DIALOG', 'An unexpected browser dialog was dismissed. Review the workflow before retrying.');
    },
    async close() { await context.close(); }
  };
  session.readyLocator = () => {
    const selector = kind === 'procare' ? app.selectors.partnersNav : app.selectors.partnerEmployeesNav;
    return selector ? page.locator(selector) : page.getByText(kind === 'procare' ? 'Partners' : 'Partner Employees', { exact: true });
  };
  session.logout = () => logoutSession(session, config);
  session.ensureLogin = async () => {
    await page.goto(home + '/', { waitUntil: 'domcontentloaded' });
    const ready = async () => (await visibleItems(session.readyLocator())).length === 1;
    try { await uniqueVisible(session.readyLocator(), `${kind} sidebar`, 4000); return; }
    catch (error) { if (error.code === 'AMBIGUOUS_CONTROL') throw error; }
    session.assertClear();
    // Production uses separate credentials: PROCARE_PROD_* and COREHR_PROD_*.
    const prefix = environment === 'production' ? `${kind.toUpperCase()}_PROD` : kind.toUpperCase();
    const username = process.env[`${prefix}_USERNAME`];
    const password = process.env[`${prefix}_PASSWORD`];
    if ((username || password) && !await ready()) {
      if (!(username && password && app.login.usernameSelector && app.login.passwordSelector && app.login.submitSelector)) {
        throw new StopError('LOGIN_CONFIG', `${kind}: automatic login requires both local credentials and all three login selectors. Otherwise unset credentials and log in manually.`);
      }
      // Wait for the Auth0/SSO redirect to complete and the login form to render.
      // The page may need several seconds to redirect from the app origin to Auth0.
      await (await uniqueVisible(page.locator(app.login.usernameSelector), 'username input', config.timeoutMs)).fill(username);
      if (!navigationOrigins.has(new URL(page.url()).origin)) throw new StopError('LOGIN_ORIGIN', 'Refusing credentials on an unapproved login origin.');
      await (await uniqueVisible(page.locator(app.login.passwordSelector), 'password input', config.timeoutMs)).fill(password);
      await (await uniqueVisible(page.locator(app.login.submitSelector), 'login button', config.timeoutMs)).click();
      // Auth0 callback redirect back to the app can take time; wait up to 30s.
      try { await uniqueVisible(session.readyLocator(), `${kind} logged-in sidebar`, 30000); return; }
      catch (error) { if (error.code === 'AMBIGUOUS_CONTROL') throw error; }
    }
    session.assertClear();
    if (headless || !ask) throw new StopError('LOGIN_REQUIRED', `${kind}: log in once with npm run login${environment === 'production' ? ' -- --environment production' : ''} in headed mode. Session/MFA may need renewal.`);
    console.log(`\nLog in to ${kind.toUpperCase()} in the opened browser. Use your ${environment.toUpperCase()} credentials and complete any SSO/MFA normally.`);
    await ask(`When the correct ${environment} application and its sidebar are visible, press Enter: `);
    session.assertClear();
    assertStagingPage(page, kind);
    await uniqueVisible(session.readyLocator(), `${kind} logged-in sidebar`, config.timeoutMs);
  };
  return session;
}
