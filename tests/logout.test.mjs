import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testBrowser, testConfig } from './fixtures.mjs';
import { APPS, logoutSession } from '../src/browser.mjs';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

// All requests are fulfilled locally; no company or identity-provider traffic.
async function fixture(kind, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const config = await testConfig();
  config.timeoutMs = 600;
  const state = { authenticated: !options.signedOut, logoutClicks: 0, appVisits: 0 };
  const sso = config[kind].additionalNavigationOrigins[0];
  const form = '<input name="username"><input name="password" type="password"><button name="submit">Log in</button>';
  const control = kind === 'procare'
    ? '<a onclick="location.href=\'/logout\'"><i class="fa fa-sign-out"></i>Logout</a>'
    : '<div role="button" data-id="logout" onclick="location.href=\'/logout\'">Logout</div>';
  const menu = kind === 'procare'
    ? `<div class="profile cpointer" onclick="document.querySelector('.dropdown').hidden=false">Profile<div class="dropdown" hidden>${control.repeat(options.ambiguous ? 2 : 1)}</div></div>`
    : `<div data-id="avatar" onclick="document.querySelector('[data-id=avatar-content]').hidden=false">Avatar<div data-id="avatar-content" hidden>${control.repeat(options.ambiguous ? 2 : 1)}</div></div>`;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === sso || url.origin === 'https://unapproved.invalid') {
      return route.fulfill({ contentType: 'text/html', body: form });
    }
    if (url.origin !== APPS[kind]) return route.abort();
    if (url.pathname === '/logout') {
      state.logoutClicks++;
      state.authenticated = !!options.noLogout;
    } else {
      state.appVisits++;
      if (options.restoresSession && state.logoutClicks) state.authenticated = true;
    }
    // Use a new document navigation so Playwright routes the login request too;
    // redirects within an intercepted HTTP request do not get routed again.
    if (!state.authenticated) return route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(sso + '/login')})</script>` });
    return route.fulfill({ contentType: 'text/html', body: '<nav id="ready">App</nav>' + menu });
  });
  await page.goto(options.foreign ? 'https://unapproved.invalid/login' : APPS[kind]);
  if (options.signedOut) await page.locator('input[name="password"]').waitFor({ state: 'visible' });
  return { context, config, state, session: { page, kind, readyLocator: () => page.locator('#ready') } };
}

for (const kind of ['procare', 'corehr']) {
  test(`${kind}: opens verified UI menu, logs out once and checks app cannot reopen signed in`, async () => {
    const f = await fixture(kind);
    try {
      const result = await logoutSession(f.session, f.config);
      assert.equal(result.outcome, 'SIGNED_OUT_VERIFIED');
      assert.equal(result.application, kind);
      assert.equal(f.state.logoutClicks, 1);
      assert.equal(f.state.appVisits, 2);
      assert.equal(f.state.authenticated, false);
    } finally { await f.context.close(); }
  });
}

test('already signed out is verified without clicking Logout', async () => {
  const f = await fixture('procare', { signedOut: true });
  try {
    assert.equal((await logoutSession(f.session, f.config)).outcome, 'ALREADY_SIGNED_OUT');
    assert.equal(f.state.logoutClicks, 0);
    assert.equal(f.state.appVisits, 2);
  } finally { await f.context.close(); }
});

for (const scenario of [
  { name: 'ambiguous logout controls are refused', options: { ambiguous: true }, code: 'AMBIGUOUS_CONTROL', clicks: 0 },
  { name: 'a click that leaves the session active is not success', options: { noLogout: true }, code: 'TIMEOUT', clicks: 1 },
  { name: 'automatic session restoration after logout is not success', options: { restoresSession: true }, code: 'TIMEOUT', clicks: 1, visits: 2 },
  { name: 'a login form on an unapproved origin is not proof of logout', options: { foreign: true }, code: 'WRONG_ENVIRONMENT', clicks: 0 }
]) {
  test(scenario.name, async () => {
    const f = await fixture('corehr', scenario.options);
    try {
      await assert.rejects(logoutSession(f.session, f.config), { code: scenario.code });
      assert.equal(f.state.logoutClicks, scenario.clicks);
      if (scenario.visits) assert.equal(f.state.appVisits, scenario.visits);
    } finally { await f.context.close(); }
  });
}
