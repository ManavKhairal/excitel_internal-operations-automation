import { WorkforceSession, installWorkforceGuard, WORKFORCE_STAGING as hosts } from '../src/integrations/workforce.mjs';

export async function workforceFixture(browser, config, options = {}, apply = true, action = 'grant') {
  const ids = { north: '11111111-1111-4111-8111-111111111111', south: '22222222-2222-4222-8222-222222222222' };
  const target = tenant => ({ id: tenant === 'north' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444', userId: tenant === 'north' ? '3' : '4', userName: 'new.agent1', userGroupId: null });
  const groups = Object.fromEntries(['north', 'south'].map(tenant => [tenant, { id: ids[tenant], name: tenant === 'north' ? 'First North Group' : 'Different South Group', employeeUserId: options.defaultTarget ? target(tenant).userId : '2', isDefault: true,
    users: [{ id: '55555555-5555-4555-8555-555555555555', userId: '2', userName: 'existing.agent', userGroupId: ids[tenant] }, ...((Array.isArray(options.already) ? options.already.includes(tenant) : options.already === tenant) ? [{ ...target(tenant), userGroupId: ids[tenant] }] : [])] }]));
  const state = { signedIn: false, tenant: 'north', groups, saves: [], searches: [], groupReads: [], logoutClicks: 0 };
  const context = await browser.newContext({ serviceWorkers: 'block' }); context.setDefaultTimeout(config.timeoutMs);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), tenant = state.tenant, key = tenant === 'north' ? 'delhi' : 'hyderabad';
    const html = body => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>' + body + '</body></html>' });
    // Use a new document navigation: Playwright routing does not re-intercept
    // every hop of an HTTP redirect chain, which could escape the fixture.
    const redirect = location => html(`<script>location=${JSON.stringify(location)}</script>`);
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin === 'https://cdn.eu.auth0.com') return route.fulfill({ contentType: 'application/javascript', body: 'window.fixtureAuthAssetLoaded=true;' });
    if (url.origin === hosts.auth) {
      if (url.pathname === '/logout') { state.logoutClicks++; if (!options.logoutFails) state.signedIn = false; return redirect(hosts.portal + '/choose-app'); }
      if (request.method() === 'POST') { state.signedIn = true; return redirect(hosts.portal + '/choose-app'); }
      return html((options.regionalAuthAssets ? '<script src="https://cdn.eu.auth0.com/client/fixture.js"></script><img src="https://s.gravatar.com/avatar/fixture">' : '') + '<form method="post"><input name="username"><input name="password" type="password"><button name="submit">Log in</button></form>');
    }
    if (![hosts.app, hosts.portal].includes(url.origin)) return route.abort();
    if (!state.signedIn) return redirect(hosts.auth + '/login');
    const profile = `<div data-id="avatar" onclick="document.querySelector('[data-id=logout]').hidden=false">Profile</div><div data-id="logout" hidden onclick="location='${hosts.auth}/logout'">Logout</div>`;
    if (url.origin === hosts.portal) {
      if (url.pathname === '/fixture-tenant') { state.tenant = url.searchParams.get('tenant'); return json({ ok: true }); }
      if (url.pathname === '/choose-tenant') return html(profile + `<h2>Workforce</h2>${['north', 'south'].map(t => `<div role="button" onclick="fetch('/fixture-tenant?tenant=${t}').then(()=>location='${hosts.app}/home')"><img alt="${t === 'north' ? 'North India' : 'South India'}"></div>`).join('')}`);
      return html(profile + '<figure onclick="location=\'/choose-tenant\'"><img alt="Workforce"></figure>');
    }
    const api = `/api/v1.0/${key}/UserGroup`;
    if (url.pathname.startsWith(api + '/UsersByUserName/')) {
      const username = decodeURIComponent(url.pathname.slice((api + '/UsersByUserName/').length)); state.searches.push({ tenant, username });
      if (options.searchFails === tenant) return route.fulfill({ status: 503, body: 'Unavailable' });
      let users = options.missing === tenant ? [] : [{ ...target(tenant), userGroupId: groups[tenant].users.some(user => user.userName === username) ? ids[tenant] : null }];
      if (options.excludeMembers && groups[tenant].users.some(user => user.userName === username)) users = [];
      if (options.duplicate === tenant) users.push({ ...target(tenant), id: '66666666-6666-4666-8666-666666666666' });
      if (options.prefix && users.length) users.unshift({ ...target(tenant), id: '77777777-7777-4777-8777-777777777777', userName: username + '0' });
      return json(users);
    }
    if (url.pathname === api + '/' + ids[tenant]) { state.groupReads.push({ tenant, id: ids[tenant] }); return json(groups[tenant]); }
    if (url.pathname === api && request.method() === 'PUT') {
      const body = JSON.parse(request.postData()); state.saves.push({ tenant, body });
      if (!options.doNotPersist) groups[tenant] = { ...body, users: body.users.map(user => ({ ...user, userGroupId: body.id })) };
      if (options.saveResponseLost) return route.abort();
      return json({ ok: true });
    }
    const shell = profile + `<button onclick="location='${hosts.portal}/choose-tenant'">${options.wrongTenant ? 'wrong tenant' : key}</button>`;
    if (url.pathname === '/home') return html(shell + '<figure onclick="location=\'/sales\'"><img alt="Sales"></figure>');
    if (url.pathname === '/sales') return html(shell + '<div data-id="user-groups-menu" onclick="location=\'/sales/user-group-list\'">User Groups</div><div>CAF Counters</div>');
    if (url.pathname === '/sales/user-group-list') return html(shell + `<div data-id="user-groups-body-column-name" onclick="location='/sales/user-group-edit/${ids[tenant]}'">${groups[tenant].name} DEFAULT</div><div data-id="user-groups-body-column-name">Second group must not be selected</div>`);
    if (url.pathname === '/sales/user-group-edit/' + ids[tenant]) return html(shell + `
      <span data-id="name-form-value"></span><i data-id="users-form-edit-icon" onclick="this.hidden=true;document.querySelector('#editor').hidden=false;renderSelected()">edit</i>
      <div id="editor" hidden><input data-id="users-form-dropdown-dropdown-search-input"><div id="options"></div></div>
      <div data-id="user-groups-form-submit-bar" hidden><span data-id="user-groups-form-update-indicator">1 edited</span><button data-id="submit-form" type="submit" data-is-disabled="false">Save</button></div>
      <script>
      let record;fetch('${api}/${ids[tenant]}').then(r=>r.json()).then(data=>{record=data;document.querySelector('[data-id=name-form-value]').textContent=data.name});
      const search=document.querySelector('input'),holder=document.querySelector('#options'),bar=document.querySelector('[data-id=user-groups-form-submit-bar]');
      function renderOptions(users){holder.innerHTML='';users.forEach(user=>{const option=document.createElement('div');option.dataset.id='users-form-dropdown-option-'+user.id;option.innerHTML='<i data-id="option-checkbox-icon"></i><span data-id="option-content"></span>';option.querySelector('span').textContent=user.userName;const icon=option.querySelector('i');icon.textContent=record.users.some(member=>member.userId===user.userId)?'check_box':'check_box_outline_blank';option.onclick=()=>{if(icon.textContent==='check_box_outline_blank'){record.users.push(user);icon.textContent='check_box';}else{record.users=record.users.filter(member=>member.id!==user.id);icon.textContent='check_box_outline_blank';}bar.hidden=false};holder.append(option)});}
      function renderSelected(){renderOptions([...record.users]);}
      search.oninput=async()=>{const response=await fetch('${api}/UsersByUserName/'+encodeURIComponent(search.value));if(!response.ok)return;renderOptions(await response.json());};
      document.querySelector('[data-id=submit-form]').onclick=async()=>{${options.editName ? "record.name='Unexpected changed name';" : ''}const response=await fetch('${api}',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});if(response.ok&&${!options.keepSaveBar})bar.hidden=true;};
      </script>`);
    return route.abort();
  });
  const page = await context.newPage();
  const session = new WorkforceSession(page, context, config, { username: 'fixture-user', password: 'fixture-password' }, { apply, action });
  await installWorkforceGuard(session);
  return { state, session };
}
