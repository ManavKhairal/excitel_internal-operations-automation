import { chromium } from 'playwright';
import { PhpMyAdmin } from '../integrations/phpmyadmin.mjs';
import { DepositSheets } from '../integrations/deposit-sheets.mjs';

export const demoUsernames = ['demo.north', 'demo.south'];
export function demoData() {
  return {
    tabs: {
      'North Tenant': [['User ID', 'ERP name'], ['demo.north', 'Demo North']],
      'South Tenant': [['User ID', 'ERP name'], ['demo.south', 'Demo South']],
      'North Changes reverted': [['Username', 'Refundable', 'Date']],
      'South Changes reverted': [['Username', 'Refundable', 'Date']],
      'North Managed users': [['Username']],
      'South Managed users': [['username']]
    },
    deposits: [
      { username: 'demo.north', key: '101', subscriberId: '10', isCovered: 0, isBundled: 0, refundable: 0 },
      { username: 'demo.north', key: '102', subscriberId: '10', isCovered: 1, isBundled: 0, refundable: 0 },
      { username: 'demo.north', key: '103', subscriberId: '10', isCovered: 0, isBundled: 1, refundable: 0 },
      { username: 'demo.north', key: '104', subscriberId: '10', isCovered: 0, isBundled: 0, refundable: 1 },
      { username: 'demo.south', key: '201', subscriberId: '20', isCovered: 0, isBundled: 0, refundable: 0 }
    ], events: []
  };
}
function columnIndex(text) { return [...text].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1; }
export function memorySheetTransport(state, options = {}) {
  return {
    metadata: async () => ({ sheets: Object.entries(state.tabs).map(([title, rows], sheetId) => ({ properties: { sheetId, title, gridProperties: { rowCount: Math.max(rows.length + 2, 20), columnCount: 6 } } })) }),
    read: async (name, range) => {
      state.events.push({ action: 'sheet-read', name, range });
      if (options.readFails === name) throw new Error('Fixture sheet read failure');
      const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!match) throw new Error('Fixture requires bounded ranges');
      const [, firstColumn, firstRow, lastColumn, lastRow] = match;
      return (state.tabs[name] || []).slice(Number(firstRow) - 1, Number(lastRow)).map(row => row.slice(columnIndex(firstColumn), columnIndex(lastColumn) + 1));
    },
    append: async (name, headerRow, values) => {
      state.events.push({ action: 'sheet-append', name, values });
      if (options.appendFails) throw new Error('Fixture append failed');
      state.tabs[name].push([...values]);
      if (options.appendResponseLost) throw new Error('Fixture append response lost');
    }
  };
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// Requests are all fulfilled in process. Even fixture programming errors cannot
// reach a company host: any request outside this synthetic origin is aborted.
export async function createDemoDatabase(browser, state, tenant, config, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.exposeFunction('__fixtureQueryEdit', query => { state.events.push({ action: 'query-edit', tenant, query }); });
  const origin = 'https://deposit-fixture.invalid';
  let selected = [], currentQuery = 'SELECT * FROM `subscriber_deposit`', signedIn = false;
  const loginHtml = '<form action="/pma/index.php" method="post"><input id="input_username" name="pma_username"><input id="input_password" name="pma_password" type="password"><input type="submit" id="input_go" value="Go"></form>';
  const html = () => {
    const fields = [['key', 'deposit_id'], ['username', 'automation_username'], ['subscriberId', 'subscriber_id'], ['isCovered', 'is_covered'], ['isBundled', 'is_bundled'], ['refundable', 'refundable']];
    const total = options.partialResults ? selected.length + 1 : selected.length;
    const actions = options.actionColumns ? '<td></td><td>Edit</td><td>Copy</td><td>Delete</td>' : '';
    const rows = selected.map(row => `<tr data-key="${escape(row.key)}">${actions}${fields.map(([field]) => `<td class="data grid_edit click2" data-field="${field}"><span>${escape(row[field])}</span></td>`).join('')}</tr>`).join('');
    return `<!doctype html><html><body>
      <a href="/pma/index.php?logout=1"><img alt="Log out"></a>
      <a class="hover_show_full" href="/pma/db_structure.php?db=excitel_ticketing_system">excitel_ticketing_system</a>
      <a class="hover_show_full" href="/pma/sql.php?db=excitel_ticketing_system&table=subscriber_deposit">subscriber_deposit</a>
      <div class="result_query"><div class="success">${selected.length ? `Showing rows 0 - ${selected.length - 1} (${total} total, Query took 0.01 seconds.)` : 'MySQL returned an empty result set (zero rows).'}</div><div class="sqlOuter"><pre>${escape(options.stripSemicolon ? currentQuery.replace(/;$/, '') : currentQuery)}</pre></div><div class="tools"><a href="#" class="inline_edit_sql">Edit inline</a></div>${options.duplicateSelectQuery ? `<div class="sqlOuter"><pre>${escape(currentQuery)}</pre></div><div class="tools"><a href="#" class="inline_edit_sql">Edit inline</a></div>` : ''}</div>
      <form id="query-form" method="post" action="/pma/sql.php"><div class="CodeMirror" hidden><textarea name="sql_query" rows="4" cols="100">${escape(currentQuery)}</textarea></div><input id="sql_query_edit_save" type="submit" value="Go" hidden></form>
      <table class="sql-results"><thead><tr>${options.actionColumns ? '<th colspan="4"></th>' : ''}${fields.map(([, name]) => `<th data-column="${name}">${name}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      <script>
      const cm=document.querySelector('.CodeMirror'), text=cm.querySelector('textarea');
      cm.CodeMirror={getValue:()=>text.value}; cm.onclick=()=>text.focus();
      document.addEventListener('click',async e=>{
        const link=e.target.closest('a.inline_edit_sql');if(!link)return;e.preventDefault();
        const query=link.closest('.tools').previousElementSibling.querySelector('pre').textContent;
        await window.__fixtureQueryEdit(query);
        text.value=query;cm.hidden=false;document.querySelector('#sql_query_edit_save').hidden=false;text.focus();
      });
      document.querySelectorAll('td[data-field=refundable]').forEach(cell=>cell.ondblclick=()=>{
        const value=cell.textContent.trim();cell.innerHTML='<input class="inline-value">';
        const editor=cell.querySelector('input');editor.value=value;editor.focus();
        editor.onkeydown=async e=>{if(e.key==='Enter'){
          e.preventDefault();
          const response=await fetch('/pma/fixture-save', {method:'POST',body:JSON.stringify({key:cell.closest('tr').dataset.key,value:editor.value})});
          if(response.ok){
            cell.innerHTML='<span>'+editor.value+'</span>';
            // phpMyAdmin 4.4 appends UPDATE SQL and its tools to the SAME
            // result_query that still contains the original SELECT and tools.
            const result=document.querySelector('.result_query');
            result.querySelectorAll('[data-saved-query]').forEach(el=>el.remove());
            const sql=document.createElement('div');sql.className='sqlOuter';sql.dataset.savedQuery='';
            const pre=document.createElement('pre');
            pre.textContent='UPDATE subscriber_deposit SET refundable = '+editor.value+' WHERE deposit_id = '+cell.closest('tr').dataset.key;
            sql.append(pre);
            const tools=document.createElement('div');tools.className='tools';tools.dataset.savedQuery='';
            tools.innerHTML='<a href="#" class="inline_edit_sql">Edit inline</a>';
            result.append(sql,tools);
          }
        }};
      });
      </script></body></html>`;
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.searchParams.has('logout')) {
      state.events.push({ action: 'logout', tenant });
      if (!options.logoutFails) signedIn = false;
    }
    if (url.pathname.endsWith('/index.php') && request.method() === 'POST') signedIn = true;
    if (!signedIn) return route.fulfill({ contentType: 'text/html', body: loginHtml });
    if (url.pathname.endsWith('/fixture-save')) {
      const { key, value } = JSON.parse(request.postData());
      state.events.push({ action: 'save', tenant, key, value });
      const row = state.deposits.find(row => row.key === key);
      if (!options.doNotPersist && options.failKey !== key) row.refundable = Number(value);
      if (options.saveResponseLost) return route.abort();
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    }
    if (url.pathname.endsWith('/sql.php') && request.method() === 'POST') {
      currentQuery = new URLSearchParams(request.postData()).get('sql_query');
      const literal = currentQuery.match(/WHERE BINARY s\.username = X'([0-9a-f]+)'/);
      const username = literal ? Buffer.from(literal[1], 'hex').toString('utf8') : '';
      state.events.push({ action: 'lookup', tenant, username });
      selected = state.deposits.filter(row => row.username === username);
      if (options.onLookup) options.onLookup(state, username);
    }
    return route.fulfill({ contentType: 'text/html', body: html() });
  });
  const page = await context.newPage();
  const adapter = new PhpMyAdmin(page, { origin, rowKeyColumn: 'deposit_id', resultTableSelector: 'table.sql-results', inlineEditorSelector: 'input.inline-value', timeoutMs: config.timeoutMs, maxDepositsPerUser: config.maxDepositsPerUser });
  try {
    await page.goto(origin + '/pma/index.php');
    await adapter.login('demo-account', 'demo-password');
    adapter.close = async () => { state.events.push({ action: 'close', tenant }); await context.close(); };
    return adapter;
  } catch (error) { await context.close(); throw error; }
}
export async function createDemoServices(config, state = demoData(), options = {}) {
  const browser = await chromium.launch({ headless: config.headless ?? false, ...(process.env.TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE } : {}) });
  return { state, sheets: new DepositSheets(memorySheetTransport(state, options), config),
    openDatabase: tenant => { state.events.push({ action: 'open-database', tenant }); return createDemoDatabase(browser, state, tenant, config, options); },
    close: () => browser.close() };
}
