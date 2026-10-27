import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { APPS } from '../src/browser.mjs';

export async function testBrowser() {
  return chromium.launch({ headless: true, ...(process.env.TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE } : {}) });
}
export async function testConfig() {
  const config = JSON.parse(await fs.readFile(new URL('../config/staging.json', import.meta.url), 'utf8'));
  Object.assign(config, { timeoutMs: 1600, searchTimeoutMs: 500, resultSettleMs: 30, screenshots: false });
  return config;
}
export const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'corehr-automation-test-'));

// Offline DOM fixtures: no company or localhost navigation, DNS or HTTP requests.
// The proxy supplies a logical staging URL and an in-memory reload operation.
// Production code has no configurable-origin bypass.
async function offlinePage(context, origin, render, onSave = async () => {}) {
  const actualPage = await context.newPage();
  let currentUrl = origin + '/';
  await actualPage.exposeFunction('__mockNavigation', p => { currentUrl = new URL(p, origin).href; });
  await actualPage.exposeFunction('__mockSave', onSave);
  await actualPage.setContent(render());
  return new Proxy(actualPage, { get(target, key) {
    if (key === 'url') return () => currentUrl;
    if (key === 'reload') return async () => target.setContent(render());
    if (key === 'waitForURL') return async (predicate, options = {}) => {
      const deadline = Date.now() + (options.timeout || 2000);
      while (Date.now() < deadline) {
        const matched = typeof predicate === 'function' ? predicate(new URL(currentUrl)) : currentUrl === predicate;
        if (matched) return;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error('Offline fixture URL did not match');
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

export async function corehrFixture(browser, options = {}) {
  const state = { users: { alpha: 'Active', alphabet: 'Active', beta: 'Inactive', ...(options.users || {}) }, saves: [], options };
  const context = await browser.newContext();
  const page = await offlinePage(context, APPS.corehr, () => corehrHtml(state), async username => {
    state.saves.push(username);
    if (!options.doNotPersist) state.users[username] = 'Inactive';
    return { ok: true };
  });
  return { state, context, page, session: { page, assertClear() {} } };
}
function corehrHtml(state) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <aside><button id="nav">Partner Employees</button><button>Permissions</button></aside><main id="main"></main>
  <script>(function(){
    const users=${JSON.stringify(state.users)};
    const settings=${JSON.stringify(state.options)};
    const main=document.getElementById('main');
    let searchBy='Name', current=null, submissions=0;
    const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function list(){
      main.innerHTML='<div data-id="search-by-dropdown-display-value-container" tabindex="0"><span data-id="search-by-display-value">'+searchBy+'</span></div><div id="options"></div><input data-id="tenant-employees-search-input" role="searchbox" placeholder="Search by '+searchBy+'"><div data-id="tenant-employees"><div><b>Username</b></div><div id="rows"></div></div>';
      document.querySelector('[data-id="search-by-dropdown-display-value-container"]').onclick=()=>{
        document.getElementById('options').innerHTML='<div role="option">Username</div>';
        document.querySelector('[role="option"]').onclick=()=>{searchBy='Username'; list()};
      };
      const input=document.querySelector('input');
      input.onkeydown=e=>{if(e.key==='Enter') {
        submissions++;
        if(settings.ignoreSearch || (settings.ignoreFirstSubmit && submissions===1)) return;
        window.__mockNavigation('/partner-employees?filter='+encodeURIComponent(input.value)+'&filterType='+searchBy);
        results(input.value);
      }};
      results('');
    }
    function results(query){
      let matches=Object.keys(users).filter(x=>x.includes(query));
      if(settings.initialEmpty && !query) matches=[];
      if(settings.duplicate && query==='alpha') matches=['alpha','alpha'];
      const holder=document.getElementById('rows'); holder.innerHTML='';
      matches.forEach((name,i)=>{
        const row=document.createElement('div'); row.setAttribute('data-id','tenant-employees-body-row-'+i);
        row.innerHTML='<div data-id="tenant-employees-body-column-name" role="button">Display '+escapeHtml(name)+'</div><div data-id="tenant-employees-body-column-user-name" role="button" tabindex="0">'+escapeHtml(name)+'</div>';
        row.querySelector('[data-id="tenant-employees-body-column-user-name"]').onclick=()=>detail(name);
        holder.appendChild(row);
      });
    }
    function detail(name){
      current=name;
      window.__mockNavigation('/partner-employees/'+encodeURIComponent(name));
      main.innerHTML='<section><span data-id="detail-username">'+escapeHtml(settings.wrongDetail || name)+'</span><div role="presentation" tabindex="0" id="permissions">Permissions</div><div id="pane"></div></section>';
      document.getElementById('permissions').onclick=permissions;
    }
    function permissions(){
      const pane=document.getElementById('pane');
      pane.innerHTML='<div role="button"><span data-id="status-form-value">'+users[current]+'</span><i data-id="status-form-edit-icon">edit</i></div><div id="status-options"></div><div id="submit-holder"></div>';
      document.querySelector('[data-id="status-form-edit-icon"]').onclick=()=>{
        const target=document.getElementById('status-options');
        if(settings.nativeSelect){target.innerHTML='<select><option>Active</option><option>Inactive</option></select>';target.querySelector('select').onchange=()=>dirty();}
        else {target.innerHTML='<div role="option">Inactive</div>'; target.querySelector('[role="option"]').onclick=()=>{target.innerHTML='';dirty()};}
      };
    }
    function dirty(){
      document.querySelector('[data-id="status-form-value"]').textContent='Inactive';
      document.getElementById('submit-holder').innerHTML='<div data-id="partner-employee-permissions-submit-bar"><button type="reset">Cancel</button><button data-id="submit-form" data-is-disabled="false" type="submit"><div role="presentation" tabindex="0">Save</div></button></div>';
      document.querySelector('[data-id="submit-form"]').onclick=async()=>{
        await window.__mockSave(current);
        users[current]='Inactive'; permissions();
      };
    }
    document.getElementById('nav').onclick=()=>{window.__mockNavigation('/partner-employees');list()};
    list();
  })();</script></body></html>`;
}

export async function procareFixture(browser, pages = [['alpha', 'beta'], ['gamma']], options = {}) {
  const context = await browser.newContext();
  const html = `<!doctype html><html><body>
    <aside><button id="nav">Partners</button></aside><main id="main"></main>
    <script>(function(){
      const pages=${JSON.stringify(pages)}, settings=${JSON.stringify(options)};
      let index=0;const main=document.getElementById('main');
      document.getElementById('nav').onclick=()=>{
        main.innerHTML='<input placeholder="Partner Name or #Default NAS Port"><div id="result"></div>';
        main.querySelector('input').onkeydown=e=>{if(e.key==='Enter'){
          document.getElementById('result').innerHTML='<table><thead><tr><th>Partner Name</th><th>Phone</th><th>Email</th><th>Address</th><th>City</th><th>State</th><th>Status</th></tr></thead><tbody><tr><td><a href="/partner/42" id="partner">Acme Staging Partner</a></td><td></td><td></td><td></td><td></td><td></td><td id="partner-status"></td></tr></tbody></table>';
          document.getElementById('partner-status').textContent=settings.partnerStatus ?? 'Terminated';
          document.getElementById('partner').onclick=e=>{e.preventDefault();window.__mockNavigation('/partner/42');main.innerHTML='<h2>Acme Staging Partner</h2><a href="/partner/42/employee" id="employees"> Employees </a>';
            document.getElementById('employees').onclick=e=>{e.preventDefault();window.__mockNavigation('/partner/42/employee'); index=settings.startPage || 0; table()};};
        }};
      };
      function table(){
        if(settings.changePartnerDuringSettle) setTimeout(()=>window.__mockNavigation('/partner/99/employee'),100);
        const size=settings.windowSize || 20;
        const start=Math.max(0,Math.min(index-1,pages.length-size));
        const numbers=pages.slice(start,start+size).map((_,i)=>'<li class="'+(start+i===index?'active':'')+'">'+(start+i+1)+'</li>').join('');
        const next='<li id="next" '+(settings.disabledNext?'class="disabled"':'')+'><i class="fa fa-angle-right"></i></li>';
        main.innerHTML='<table><thead><tr><th>Name</th><th>Username</th><th>Phone</th></tr></thead><tbody>'+pages[index].map(x=>'<tr><td>Display '+x+'</td><td>'+x+'</td><td>0000</td></tr>').join('')+'</tbody></table>'+
          (settings.missingPager?'':'<ul class="pagination"><li><i class="fa fa-angle-left"></i></li>'+numbers+next+(settings.duplicateNext?next:'')+'</ul>');
        const control=document.getElementById('next');
        if(control) control.onclick=()=>{
          if(settings.stuckNext || settings.disabledNext || index===pages.length-1)return;
          index++;
          if(settings.delayPageMs){
            main.querySelector('tbody').innerHTML='<tr><td colspan="3">Loading</td></tr>';
            setTimeout(table,settings.delayPageMs);
          }else table();
        };
      }
    })();</script></body></html>`;
  const page = await offlinePage(context, APPS.procare, () => html);
  return { context, page, session: { page, assertClear() {} } };
}
