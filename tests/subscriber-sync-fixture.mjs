import { ProcareSyncSession, installSyncGuard, PROCARE_SYNC } from '../src/integrations/procare-subscriber-sync.mjs';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const records = () => [
  { username: 'sync.one', subscriberId: '101', subscriberErpId: '1001', name: 'First Person', accesses: { canSync: true } },
  { username: '000123', subscriberId: '102', subscriberErpId: '1002', name: 'Second Person', accesses: { canSync: true } }
];
export async function syncFixture(browser, config, { apply = true, users = records(), ...options } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const events = [];
  let signedIn = false, saves = 0;
  const nav = '<a href="/subscriber">Subscribers</a><div class="profile cpointer" onclick="document.querySelector(\'.dropdown\').hidden=false">Profile<div class="dropdown" hidden><a href="#" onclick="event.preventDefault();fetch(\'/api/index_dev.php/logout\',{method:\'POST\'}).then(()=>location.href=\'https://excitel.eu.auth0.com/login\')"><i class="fa-sign-out"></i>Logout</a></div></div>';
  const login = '<form method="post" action="https://excitel.eu.auth0.com/login"><input name="username"><input name="password" type="password"><button name="submit">Log In</button></form>';
  const list = `${nav}<input placeholder="UserID or #Number"><table><tbody></tbody></table><script>
    document.querySelector('input').oninput=async function(){
      const query=this.value;
      const body=await (await fetch('/api/index_dev.php/subscriber/list',{method:'POST',body:new URLSearchParams({searchText:query})})).json();
      if(this.value!==query)return;
      document.querySelector('tbody').replaceChildren();
      for(const user of body.result.subscriberList){
        const tr=document.createElement('tr');
        for(const value of [user.name,user.username]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
        tr.onclick=()=>location.href='/subscriber/'+user.subscriberId;
        document.querySelector('tbody').append(tr);
      }
    };
  </script>`;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (![PROCARE_SYNC.origin, PROCARE_SYNC.auth].includes(url.origin)) return route.abort();
    const params = req.method() === 'GET' ? url.searchParams : new URLSearchParams(req.postData() || '');
    if (url.origin === PROCARE_SYNC.auth) {
      if (req.method() === 'POST') { signedIn = true; return route.fulfill({ contentType: 'text/html', body: `<script>location.href='${PROCARE_SYNC.origin}/'</script>` }); }
      return route.fulfill({ contentType: 'text/html', body: login });
    }
    if (!signedIn) return route.fulfill({ contentType: 'text/html', body: `<script>location.href='${PROCARE_SYNC.auth}/login'</script>` });
    const endpoint = url.pathname.startsWith(PROCARE_SYNC.apiPrefix) ? url.pathname.slice(PROCARE_SYNC.apiPrefix.length) : '';
    const json = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result, messages: [] }) });
    if (endpoint === 'logout') { events.push({ action: 'logout' }); if (!options.logoutFails) signedIn = false; return json({}); }
    if (endpoint === 'subscriber/list') {
      const query = params.get('searchText'); events.push({ action: 'search', username: query });
      const matches = users.filter(u => u.username.includes(query));
      return json({ subscriberList: matches, totalEntries: matches.length + (options.partialResults ? 1 : 0) });
    }
    if (endpoint === 'subscriber/showDashboard') {
      const record = users.find(u => u.subscriberId === params.get('subscriberId'));
      events.push({ action: 'detail', id: record?.subscriberId });
      return json({ subscriberData: options.wrongDetail ? { ...record, username: 'wrong.user' } : record });
    }
    if (endpoint === PROCARE_SYNC.syncRoute) {
      const record = users.find(u => u.subscriberId === params.get('subscriberId'));
      events.push({ action: 'synchronize', ...Object.fromEntries(params) }); saves++;
      if (options.responseLost) return route.abort();
      if (options.serverError) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { subscriberData: record }, messages: [{ type: 'error', text: 'Failure' }] }) });
      return json({ subscriberData: options.wrongSyncIdentity ? { ...record, username: 'wrong.user' } : record });
    }
    if (endpoint) { events.push({ action: 'unexpected-api', endpoint }); return route.abort(); }
    const match = url.pathname.match(/^\/subscriber\/(\d+)$/);
    if (match) {
      const id = match[1];
      const body = `${nav}<div class="subscriber-details-container-header"><span id="identity"></span></div><button hidden>Synchronize</button><script>
        let record;
        fetch('/api/index_dev.php/subscriber/showDashboard?subscriberId=${id}').then(r=>r.json()).then(body=>{record=body.result.subscriberData;document.querySelector('#identity').textContent=record.username;document.querySelector('button').hidden=false;});
        document.querySelector('button').onclick=async()=>{
          const params=new URLSearchParams({username:record.username,subscriberId:record.subscriberId,subscriberErpId:record.subscriberErpId});
          ${options.wrongRequest ? "params.set('subscriberId','999');" : ''}
          const url='/api/index_dev.php/synchronization/syncSubscriber?'+params;
          await fetch(url).catch(()=>{});
          ${options.repeatRequest ? 'await fetch(url).catch(()=>{});' : ''}
        };
      </script>`;
      return route.fulfill({ contentType: 'text/html', body });
    }
    return route.fulfill({ contentType: 'text/html', body: list });
  });
  const page = await context.newPage();
  const session = new ProcareSyncSession(page, { close: () => context.close() }, config, { username: 'fixture', password: 'fixture-password' }, { apply });
  await installSyncGuard(context, session);
  return { session, events, page, context, get saves() { return saves; } };
}
