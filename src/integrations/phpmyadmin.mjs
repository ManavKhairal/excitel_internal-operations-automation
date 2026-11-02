import { chromium } from 'playwright';
import { StopError, clean, exactPattern, uniqueVisible, waitFor } from '../utils.mjs';
import { TENANTS, TENANT_DATABASES, normalizeRefundable, validateRows } from '../tasks/deposit-refundability.mjs';

// phpMyAdmin displays submitted SELECT statements without their final semicolon.
const queryText = value => clean(value).replace(/;$/, '');

export async function selectQueryControls(page, timeoutMs = 20000) {
  // Grid saves append an UPDATE sqlOuter/tools pair INSIDE the existing
  // result_query. Select the SELECT block, then only its adjacent tools.
  // AJAX SELECT execution may prepend a separate generic SQL acknowledgement
  // containing the same query. Only the result with a row count/empty status
  // supplies the controls for the actual deposit result.
  const results = page.locator('.result_query').filter({ has: page.locator(':scope > .success').filter({ hasText: /empty result set|zero rows|\([\d,]+\s+total/i }) });
  const query = await uniqueVisible(results.locator(':scope > .sqlOuter').filter({
    has: page.locator('pre').filter({ hasText: /^\s*SELECT\b/i })
  }), 'SELECT query block', timeoutMs);
  const tools = await uniqueVisible(query.locator('xpath=following-sibling::*[1][contains(concat(" ", normalize-space(@class), " "), " tools ")]'), 'SELECT query tools', timeoutMs);
  const edit = await uniqueVisible(tools.locator('a.inline_edit_sql'), 'SELECT query Edit inline SQL', timeoutMs);
  return { query, result: query.locator('xpath=..'), edit };
}

export function lookupQuery(username, rowKeyColumn, limit) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowKeyColumn || '') || !Number.isInteger(limit) || limit < 1 || limit > 201) throw new StopError('DATABASE_SCHEMA', 'A reviewed deposit primary-key column and bounded query limit are required.');
  if (typeof username !== 'string' || !username.length || username.length > 128) throw new StopError('INPUT', 'Invalid lookup username.');
  // Hex literal prevents SQL syntax injection independently of SQL string modes.
  // Binary comparison preserves exact case rather than trusting DB collation.
  const literal = Buffer.from(username, 'utf8').toString('hex');
  return `SELECT s.username AS automation_username, sd.* FROM subscriber_deposit AS sd INNER JOIN subscriber AS s ON s.subscriber_id = sd.subscriber_id WHERE BINARY s.username = X'${literal}' ORDER BY sd.\`${rowKeyColumn}\` LIMIT ${limit};`;
}

export class PhpMyAdmin {
  constructor(page, { origin, database = 'excitel_ticketing_system', rowKeyColumn, resultTableSelector, inlineEditorSelector, timeoutMs = 20000, maxDepositsPerUser = 200, beforeQuery = () => {}, liveWrites = false, armSave = () => {}, assertClear = () => {} }) {
    Object.assign(this, { page, origin, database, rowKeyColumn, resultTableSelector, inlineEditorSelector, timeoutMs, maxDepositsPerUser, beforeQuery, liveWrites, armSave, assertClear });
  }
  assertOrigin() {
    if (new URL(this.page.url()).origin !== this.origin) throw new StopError('DATABASE_ORIGIN', 'Unexpected database application origin.');
  }
  async ready() {
    await waitFor(async () => { this.assertOrigin(); this.assertClear(); return this.page.evaluate(() => window.AJAX?.active !== true); }, { timeoutMs: this.timeoutMs, description: 'phpMyAdmin navigation and event handlers to finish loading' });
  }
  async login(username, password) {
    this.assertOrigin();
    if (!username || !password) throw new StopError('DATABASE_AUTH_REQUIRED', 'Configure this tenant’s phpMyAdmin credentials locally.');
    await (await uniqueVisible(this.page.locator('#input_username'), 'database username', this.timeoutMs)).fill(username);
    await (await uniqueVisible(this.page.locator('#input_password'), 'database password', this.timeoutMs)).fill(password);
    await (await uniqueVisible(this.page.locator('#input_go'), 'login Go', this.timeoutMs)).click();
    this.assertOrigin();
    await this.navigate();
  }
  async navigate() {
    for (const [label, selector] of [
      [this.database, `a.hover_show_full[href*="db=${this.database}"]`],
      ['subscriber_deposit', 'a.hover_show_full[href*="table=subscriber_deposit"]']
    ]) {
      const link = await uniqueVisible(this.page.locator(selector).filter({ hasText: exactPattern(label) }), label, this.timeoutMs);
      const url = new URL(await link.getAttribute('href'), this.page.url());
      if (url.origin !== this.origin || url.searchParams.get('db') !== this.database) throw new StopError('DATABASE_CONTEXT', 'Wrong database navigation link.');
      await link.click(); await this.ready();
    }
  }
  async lookup(username) {
    const query = lookupQuery(username, this.rowKeyColumn, this.maxDepositsPerUser + 1);
    return this.select(query);
  }
  async select(query, username) {
    await this.ready();
    this.beforeQuery(query);
    const current = await selectQueryControls(this.page, this.timeoutMs);
    await current.edit.click();
    const editor = await uniqueVisible(this.page.locator('.CodeMirror, textarea#sql_query_edit'), 'SQL editor', this.timeoutMs);
    const codeMirror = await editor.evaluate(el => el.classList.contains('CodeMirror'));
    if (codeMirror) {
      await editor.click();
      await this.page.keyboard.press('ControlOrMeta+A');
      await this.page.keyboard.insertText(query);
    } else await editor.fill(query);
    const entered = codeMirror ? await editor.evaluate(el => el.CodeMirror?.getValue()) : await editor.inputValue();
    if (entered !== query) throw new StopError('QUERY_EDITOR', 'The SQL editor does not contain the exact generated read-only query.');
    this.assertOrigin();
    const previousResult = await current.result.elementHandle();
    await (await uniqueVisible(this.page.locator('#sql_query_edit_save'), 'SQL Go', this.timeoutMs)).click();
    if (previousResult) {
      try {
        await waitFor(() => previousResult.evaluate(el => !el.isConnected).catch(() => true),
          { timeoutMs: this.timeoutMs, description: 'a fresh SQL result document (not the previous query)' });
      } finally { await previousResult.dispose(); }
    }
    const fresh = await selectQueryControls(this.page, this.timeoutMs);
    await waitFor(async () => {
      this.assertOrigin();
      const queries = await fresh.query.locator('pre').allTextContents();
      return queries.some(text => queryText(text) === queryText(query));
    }, { timeoutMs: this.timeoutMs, description: 'the exact lookup query result' });
    // A result must belong to the executed query, not stale rows from a prior user.
    const success = await uniqueVisible(fresh.result.locator(':scope > .success'), 'SELECT result status', this.timeoutMs);
    const message = clean(await success.innerText());
    if (/empty result set|zero rows/i.test(message)) return [];
    const table = await uniqueVisible(this.page.locator(this.resultTableSelector), 'deposit results', this.timeoutMs);
    const rows = await this.readTable(table, username);
    const total = message.match(/\(([\d,]+)\s+total/);
    if (!total || Number(total[1].replaceAll(',', '')) !== rows.length) throw new StopError('PARTIAL_RESULTS', 'Cannot prove all deposit rows are displayed. Stop before edits; review phpMyAdmin pagination.');
    this.assertClear();
    return rows;
  }
  async readTable(table, username) {
    const fields = { ...(username === undefined ? { username: 'automation_username' } : {}), key: this.rowKeyColumn, subscriberId: 'subscriber_id', isCovered: 'is_covered', isBundled: 'is_bundled', refundable: 'refundable' };
    const snapshot = await table.evaluate((el, fields) => {
      const indices = {};
      for (const [key, column] of Object.entries(fields)) {
        const matches = [...el.querySelectorAll('thead th[data-column]')].filter(th => th.getAttribute('data-column') === column);
        if (matches.length !== 1) return { error: `Missing/ambiguous column: ${column}` };
        // phpMyAdmin groups checkbox/Edit/Copy/Delete under one colspan=4
        // heading. Header cellIndex therefore differs from the body cell index.
        const heading = matches[0];
        indices[key] = [...heading.parentElement.cells].slice(0, heading.cellIndex)
          .reduce((offset, cell) => offset + cell.colSpan, 0);
      }
      const rows = [...el.querySelectorAll('tbody > tr')];
      return { rows: rows.map(row => Object.fromEntries(Object.entries(indices).map(([key, index]) => [key, row.cells[index]?.textContent.trim() ?? null]))) };
    }, fields);
    if (snapshot.error) throw new StopError('RESULT_COLUMNS', snapshot.error);
    return snapshot.rows.map(row => username === undefined ? row : { ...row, username });
  }
  async prepareRefundable(expected, refundable = 1) {
    const target = normalizeRefundable(refundable), before = String(1 - target);
    this.assertOrigin();
    if (this.origin !== 'https://deposit-fixture.invalid' && (!this.liveWrites || !Object.values(TENANTS).includes(this.origin))) throw new StopError('LIVE_WRITES_DISABLED', 'Live editing requires an explicit manual apply.');
    if (this.liveWrites) {
      // A joined SELECT disables phpMyAdmin grid editing. Bind the editable
      // single-table result back to the exact username lookup before editing.
      const verified = validateRows(await this.lookup(expected.username), expected.username, this.maxDepositsPerUser);
      const match = verified.find(row => row.key === expected.key);
      if (!match || match.subscriberId !== expected.subscriberId || match.refundable !== 1 - target || match.isCovered || match.isBundled) throw new StopError('RECORD_CHANGED', 'Exact deposit identity or eligibility changed.');
      const query = `SELECT * FROM ${this.database}.subscriber_deposit WHERE subscriber_id = ${match.subscriberId} AND deposit_id IN (${verified.map(row => row.key).join(', ')}) ORDER BY deposit_id LIMIT ${this.maxDepositsPerUser + 1};`;
      const editable = validateRows(await this.select(query, expected.username), expected.username, this.maxDepositsPerUser);
      if (editable.length !== verified.length || editable.some(row => {
        const original = verified.find(item => item.key === row.key);
        return !original || ['subscriberId', 'isCovered', 'isBundled', 'refundable'].some(field => original[field] !== row[field]);
      })) throw new StopError('RECORD_CHANGED', 'Editable deposits differ from the exact username lookup.');
    }
    const table = await uniqueVisible(this.page.locator(this.resultTableSelector), 'deposit results', this.timeoutMs);
    const rows = await this.readTable(table, this.liveWrites ? expected.username : undefined);
    const index = rows.findIndex(row => row.key === expected.key && row.username === expected.username && row.subscriberId === expected.subscriberId);
    if (index < 0 || rows.filter(row => row.key === expected.key).length !== 1) throw new StopError('ROW_IDENTITY', 'Exact deposit record is missing or ambiguous.');
    if (rows[index].refundable !== before || rows[index].isCovered !== '0' || rows[index].isBundled !== '0') throw new StopError('RECORD_CHANGED', 'Deposit is no longer eligible.');
    const header = await uniqueVisible(table.locator('thead th[data-column="refundable"]'), 'refundable heading', this.timeoutMs);
    const column = await header.evaluate(el => [...el.parentElement.cells].slice(0, el.cellIndex)
      .reduce((offset, cell) => offset + cell.colSpan, 0));
    const row = table.locator('tbody > tr').nth(index);
    const cell = row.locator(':scope > td').nth(column);
    if (this.liveWrites) {
      const clauses = await row.locator('input.where_clause').evaluateAll(inputs => inputs.map(input => input.value));
      if (!clauses.length || clauses.some(value => !exactDepositClause(decodeURIComponent(value.replace(/\+/g, ' ')), expected.key, this.database))) throw new StopError('ROW_IDENTITY', 'Editable row primary-key controls do not match the verified deposit.');
      if (!await cell.evaluate(el => el.classList.contains('grid_edit'))) throw new StopError('ROW_NOT_EDITABLE', 'The refundable cell does not support grid editing.');
    }
    await cell.dblclick();
    const input = await uniqueVisible((this.liveWrites ? this.page : cell).locator(this.inlineEditorSelector), 'refundable inline editor', this.timeoutMs);
    if (await input.inputValue() !== before) throw new StopError('RECORD_CHANGED', 'Inline editor value changed before editing.');
    await input.fill(String(target));
    let attempted = false;
    return async () => {
      if (attempted) throw new StopError('DUPLICATE_SAVE', 'Enter must not be repeated for this record.');
      attempted = true;
      this.assertOrigin(); this.assertClear();
      // Recheck the row identity and flags after editing and before Enter.
      const fresh = (await this.readTable(table, this.liveWrites ? expected.username : undefined))[index];
      if (!fresh || fresh.key !== expected.key || fresh.username !== expected.username || fresh.subscriberId !== expected.subscriberId || fresh.isCovered !== '0' || fresh.isBundled !== '0' || await input.inputValue() !== String(target)) throw new StopError('RECORD_CHANGED', 'Row changed while the editor was open.');
      if (this.liveWrites) {
        this.armSave({ key: expected.key, target });
        const response = this.page.waitForResponse(response => new URL(response.url()).origin === this.origin && new URL(response.url()).pathname === '/pma/tbl_replace.php', { timeout: this.timeoutMs });
        response.catch(() => {});
        await input.press('Enter');
        const saved = await response;
        if (!saved.ok() || (await saved.json()).success !== true) throw new StopError('SAVE_UNVERIFIED', 'phpMyAdmin did not acknowledge the save. Do not retry Enter.');
      } else await input.press('Enter');
      await waitFor(async () => !await input.isVisible(), { timeoutMs: this.timeoutMs, description: 'inline editor save to finish' });
    };
  }
  async logout() {
    this.assertOrigin();
    const control = this.page.locator('a').filter({ has: this.page.locator('img[alt="Log out"]') });
    await (await uniqueVisible(control, 'phpMyAdmin Log out', this.timeoutMs)).click();
    await uniqueVisible(this.page.locator('#input_username'), 'signed-out username field', this.timeoutMs);
    await uniqueVisible(this.page.locator('#input_password'), 'signed-out password field', this.timeoutMs);
    this.assertOrigin();
    await this.page.goto(this.origin + '/pma/index.php', { waitUntil: 'domcontentloaded' });
    await uniqueVisible(this.page.locator('#input_password'), 'login required after reopening', this.timeoutMs);
    this.assertOrigin();
  }
}

function exactDepositClause(value, key, database) {
  return [`subscriber_deposit.deposit_id=${key}`, `${database}.subscriber_deposit.deposit_id=${key}`, `deposit_id=${key}`].includes(value.replace(/[`\s]/g, ''));
}
const databaseForOrigin = origin => origin === TENANTS.south ? TENANT_DATABASES.south : TENANT_DATABASES.north;

// Only the currently armed deposit may change, with one refundable field and
// no arbitrary SQL, expressions, nulls, extra records or extra columns.
export function approvedDepositSave(url, method, body, scope, origin) {
  if (!scope || !/^\d+$/.test(scope.key) || ![0, 1].includes(scope.target) || method !== 'POST' || url.origin !== origin || url.pathname !== '/pma/tbl_replace.php' || url.search) return false;
  if (body.has('server') && body.get('server') !== '1') return false;
  const database = databaseForOrigin(origin);
  if (body.get('db') !== database || body.get('table') !== 'subscriber_deposit' || body.get('submit_type') !== 'save' || body.get('clause_is_unique') !== '1' || (body.get('sql_query') || '').trim()) return false;
  const where = [], names = [], values = [];
  const metadata = new Set(['ajax_request', 'sql_query', 'token', 'server', 'db', 'table', 'clause_is_unique', 'rel_fields_list', 'do_transformations', 'transform_fields_list', 'relational_display', 'goto', 'submit_type', '_nocache']);
  const seen = new Set();
  for (const [key, value] of body) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (/^where_clause(?:\[\]|\[0\])$/.test(key)) where.push(value);
    else if (/^fields_name\[multi_edit\]\[0\](?:\[\]|\[0\])$/.test(key)) names.push(value);
    else if (/^fields\[multi_edit\]\[0\](?:\[\]|\[0\])$/.test(key)) values.push(value);
    else if (/^fields_(?:null|type)\[multi_edit\]\[0\](?:\[\]|\[0\])$/.test(key)) { if (value !== '') return false; }
    else if (!metadata.has(key)) return false;
  }
  return where.length === 1 && exactDepositClause(where[0], scope.key, database) && names.length === 1 && names[0] === 'refundable' && values.length === 1 && values[0] === String(scope.target) &&
    !(body.get('rel_fields_list') || '') && !(body.get('transform_fields_list') || '') && ['', 'false', '0'].includes(body.get('do_transformations') || '');
}

export function approvedDepositRead(url, method, body, queries, origin) {
  if (url.origin !== origin || !url.pathname.startsWith('/pma/')) return false;
  const endpoint = url.pathname.split('/').at(-1);
  const sql = [...url.searchParams.getAll('sql_query'), ...body.getAll('sql_query')];
  const parameters = [...url.searchParams.keys(), ...body.keys()];
  if (parameters.some(key => /^(?:sql_query_edit|where_clause|submit_type|do_delete|row_delete|insert_rows|fields\[)/i.test(key))) return false;
  if (['db', 'table', 'server'].some(key => [...url.searchParams.getAll(key), ...body.getAll(key)].some(value => value !== '' && value !== ({ db: databaseForOrigin(origin), table: 'subscriber_deposit', server: '1' })[key]))) return false;
  if (sql.some(query => !queries.has(queryText(query)))) return false;
  const login = method === 'POST' && endpoint === 'index.php' && body.has('pma_username') && body.has('pma_password') && !sql.length;
  const select = method === 'POST' && ['sql.php', 'import.php'].includes(endpoint) && sql.length > 0;
  const php = ['index.php', 'db_structure.php', 'tbl_structure.php', 'sql.php', 'navigation.php', 'get_scripts.js.php', 'get_image.js.php', 'get_css.php', 'phpmyadmin.css.php', 'whitelist.php'];
  const asset = /\.(js|css|png|gif|jpg|svg|ico|woff2?|ttf)$/.test(endpoint) || url.pathname.endsWith('/js/messages.php');
  const read = ['GET', 'HEAD'].includes(method) && (asset || php.includes(endpoint));
  // phpMyAdmin AJAX navigation posts _nocache while its context is in the URL.
  // Permit only navigation metadata, never arbitrary form operations.
  const navigationFields = new Set(['db', 'table', 'server', 'token', 'ajax_request', 'ajax_page_request', '_nocache']);
  const navigation = method === 'POST' && ['index.php', 'db_structure.php', 'tbl_structure.php', 'sql.php', 'navigation.php'].includes(endpoint) && !sql.length && parameters.every(key => navigationFields.has(key));
  // CodeMirror fetches table/column names when its SQL editor first opens.
  // This endpoint receives only database context and AJAX metadata.
  const autocompleteFields = new Set(['ajax_request', 'token', 'server', 'db', '_nocache']);
  const autocomplete = method === 'POST' && url.pathname === '/pma/db_sql_autocomplete.php' && !sql.length &&
    parameters.every(key => autocompleteFields.has(key)) &&
    [...url.searchParams.getAll('db'), ...body.getAll('db')].some(value => value === databaseForOrigin(origin));
  return read || login || select || navigation || autocomplete;
}

export function assertPreviewConfigured(config) {
  const live = config.livePreview;
  if (!live?.enabled || !live.rowKeyColumn || !live.resultTableSelector || !live.inlineEditorSelector) throw new StopError('LIVE_PREVIEW_NOT_READY', 'Live preview is disabled pending authorized UI/schema inspection and reviewed selectors. Use --demo for offline validation.');
}

export async function createPmaManual(tenant, config, credentials, { apply = false, ask } = {}) {
  const origin = TENANTS[tenant];
  if (!origin) throw new StopError('INVALID_TENANT', 'Select North or South explicitly.');
  const browser = await chromium.launch({ headless: false });
  let blockedRequest;
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(config.timeoutMs);
    const queries = new Set(['SELECT * FROM `subscriber_deposit`']);
    const used = new Set();
    let blocked = false, armed = null;
    const assertClear = () => { if (blocked) throw new StopError('BLOCKED_REQUEST', `An unexpected database request or dialog was blocked${blockedRequest ? ': ' + blockedRequest : ''}. Review the report before retrying.`); };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const body = new URLSearchParams(request.postData() || '');
      const endpoint = url.pathname.split('/').at(-1);
      // phpMyAdmin checks for its own software updates in the background.
      // Answer locally; this request is unrelated to deposit operations.
      if (url.origin === origin && url.pathname === '/pma/version_check.php') return route.fulfill({ contentType: 'application/json', body: '{"success":false}' });
      // Fresh automation contexts do not need to synchronize personal favorites.
      // Return the shape consumed by phpMyAdmin's functions.js, without a POST.
      if (url.origin === origin && url.pathname === '/pma/db_structure.php' && (url.searchParams.has('sync_favorite_tables') || body.has('sync_favorite_tables'))) return route.fulfill({ contentType: 'application/json', body: '{"success":true,"favorite_tables":"[]","list":""}' });
      if (endpoint === 'tbl_replace.php') {
        const scope = armed; armed = null;
        if (blocked || !apply || !approvedDepositSave(url, request.method(), body, scope, origin) || used.has(scope?.key)) { blocked = true; blockedRequest ||= `${request.method()} ${url.pathname} (save outside the armed deposit scope)`; return route.abort(); }
        used.add(scope.key);
        return route.continue();
      }
      if (!approvedDepositRead(url, request.method(), body, queries, origin)) { blocked = true; blockedRequest ||= `${request.method()} ${url.pathname} (unreviewed request; fields=${[...new Set([...url.searchParams.keys(), ...body.keys()])].join(',')})`; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('dialog', dialog => { blocked = true; void dialog.dismiss(); });
    await page.goto(origin + '/pma/index.php', { waitUntil: 'domcontentloaded' });
    const adapter = new PhpMyAdmin(page, { origin, database: TENANT_DATABASES[tenant], rowKeyColumn: 'deposit_id', resultTableSelector: 'table.table_results', inlineEditorSelector: 'input.edit_box', timeoutMs: config.timeoutMs, maxDepositsPerUser: config.maxDepositsPerUser,
      liveWrites: apply, beforeQuery: query => queries.add(queryText(query)), assertClear,
      armSave: scope => { assertClear(); if (!apply || armed || used.has(scope.key)) throw new StopError('DUPLICATE_SAVE', 'This deposit cannot be saved again in this execution.'); armed = scope; } });
    if (!credentials.username || !credentials.password) {
      if (!ask) throw new StopError('DATABASE_AUTH_REQUIRED', `Set PMA_${tenant.toUpperCase()}_USERNAME and PMA_${tenant.toUpperCase()}_PASSWORD in .env, or use dashboard interactive login.`);
      await ask(`Log in to the ${tenant} phpMyAdmin browser using your database credentials, then continue. Do not edit deposit records manually during this run.`);
      adapter.assertOrigin();
      await uniqueVisible(page.locator('a').filter({ has: page.locator('img[alt="Log out"]') }), 'authenticated database logout', config.timeoutMs);
      // Use the normal reviewed database/table navigation after manual login.
      await adapter.navigate();
    } else await adapter.login(credentials.username, credentials.password);
    assertClear();
    adapter.close = () => browser.close();
    return adapter;
  } catch (error) { await browser.close(); if (blockedRequest) throw new StopError('BLOCKED_REQUEST', `Blocked ${blockedRequest}. No unreviewed request was sent.`); throw error; }
}

export async function createPmaPreview(tenant, config, credentials) {
  assertPreviewConfigured(config);
  const origin = TENANTS[tenant];
  if (!origin) throw new StopError('INVALID_TENANT', 'Unsupported database tenant.');
  const browser = await chromium.launch({ headless: config.headless ?? false });
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
  context.setDefaultTimeout(config.timeoutMs);
  const queries = new Set(['SELECT * FROM `subscriber_deposit`', 'SELECT * FROM `subscriber_deposit`;']);
  let blocked = false;
  try {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const body = new URLSearchParams(request.postData() || '');
      const query = body.get('sql_query') ?? url.searchParams.get('sql_query');
      const endpoint = url.pathname.split('/').at(-1);
      const phpRead = ['index.php', 'db_structure.php', 'tbl_structure.php', 'sql.php', 'navigation.php'];
      const login = endpoint === 'index.php' && body.has('pma_username') && body.has('pma_password');
      const select = endpoint === 'sql.php' && queries.has(query);
      const allowed = url.origin === origin &&
        (!endpoint.endsWith('.php') || phpRead.includes(endpoint)) &&
        (!query || queries.has(query)) &&
        (['GET', 'HEAD'].includes(request.method()) || (request.method() === 'POST' && (login || select))) &&
        ![...url.searchParams.keys(), ...body.keys()].some(key => /^(?:sql_query_edit|where_clause|submit_type|do_delete|row_delete|insert_rows|fields\[)/i.test(key));
      if (!allowed) { blocked = true; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('dialog', dialog => { blocked = true; void dialog.dismiss(); });
    await page.goto(origin + '/pma/index.php', { waitUntil: 'domcontentloaded' });
    const adapter = new PhpMyAdmin(page, { ...config.livePreview, origin, timeoutMs: config.timeoutMs, maxDepositsPerUser: config.maxDepositsPerUser, beforeQuery: query => queries.add(query) });
    await adapter.login(credentials.username, credentials.password);
    const lookup = adapter.lookup.bind(adapter);
    adapter.lookup = async username => {
      if (blocked) throw new StopError('BLOCKED_REQUEST', 'Unreviewed phpMyAdmin request blocked.');
      const rows = await lookup(username);
      if (blocked) throw new StopError('BLOCKED_REQUEST', 'Unreviewed phpMyAdmin request blocked.');
      return rows;
    };
    adapter.close = () => browser.close();
    return adapter;
  } catch (error) { await browser.close(); throw error; }
}
