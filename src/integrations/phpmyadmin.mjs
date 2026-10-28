import { chromium } from 'playwright';
import { StopError, clean, exactPattern, uniqueVisible, waitFor } from '../utils.mjs';
import { TENANTS } from '../tasks/deposit-refundability.mjs';

// phpMyAdmin displays submitted SELECT statements without their final semicolon.
const queryText = value => clean(value).replace(/;$/, '');

export async function selectQueryControls(page, timeoutMs = 20000) {
  // Grid saves append an UPDATE sqlOuter/tools pair INSIDE the existing
  // result_query. Select the SELECT block, then only its adjacent tools.
  const query = await uniqueVisible(page.locator('.result_query > .sqlOuter').filter({
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
  constructor(page, { origin, rowKeyColumn, resultTableSelector, inlineEditorSelector, timeoutMs = 20000, maxDepositsPerUser = 200, beforeQuery = () => {} }) {
    Object.assign(this, { page, origin, rowKeyColumn, resultTableSelector, inlineEditorSelector, timeoutMs, maxDepositsPerUser, beforeQuery });
  }
  assertOrigin() {
    if (new URL(this.page.url()).origin !== this.origin) throw new StopError('DATABASE_ORIGIN', 'Unexpected database application origin.');
  }
  async login(username, password) {
    this.assertOrigin();
    if (!username || !password) throw new StopError('DATABASE_AUTH_REQUIRED', 'Configure this tenant’s phpMyAdmin credentials locally.');
    await (await uniqueVisible(this.page.locator('#input_username'), 'database username', this.timeoutMs)).fill(username);
    await (await uniqueVisible(this.page.locator('#input_password'), 'database password', this.timeoutMs)).fill(password);
    await (await uniqueVisible(this.page.locator('#input_go'), 'login Go', this.timeoutMs)).click();
    this.assertOrigin();
    for (const [label, selector] of [
      ['excitel_ticketing_system', 'a.hover_show_full[href*="db=excitel_ticketing_system"]'],
      ['subscriber_deposit', 'a.hover_show_full[href*="table=subscriber_deposit"]']
    ]) {
      const link = await uniqueVisible(this.page.locator(selector).filter({ hasText: exactPattern(label) }), label, this.timeoutMs);
      const url = new URL(await link.getAttribute('href'), this.page.url());
      if (url.origin !== this.origin || url.searchParams.get('db') !== 'excitel_ticketing_system') throw new StopError('DATABASE_CONTEXT', 'Wrong database navigation link.');
      await link.click(); this.assertOrigin();
    }
  }
  async lookup(username) {
    this.assertOrigin();
    const query = lookupQuery(username, this.rowKeyColumn, this.maxDepositsPerUser + 1);
    this.beforeQuery(query);
    const current = await selectQueryControls(this.page, this.timeoutMs);
    await current.edit.click();
    const editor = await uniqueVisible(this.page.locator('.CodeMirror'), 'SQL editor', this.timeoutMs);
    await editor.click();
    await this.page.keyboard.press('ControlOrMeta+A');
    await this.page.keyboard.insertText(query);
    const entered = await editor.evaluate(el => el.CodeMirror?.getValue());
    if (entered !== query) throw new StopError('QUERY_EDITOR', 'CodeMirror does not contain the exact generated read-only query.');
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
    const rows = await this.readTable(table);
    const total = message.match(/\(([\d,]+)\s+total/);
    if (!total || Number(total[1].replaceAll(',', '')) !== rows.length) throw new StopError('PARTIAL_RESULTS', 'Cannot prove all deposit rows are displayed. Stop before edits; review phpMyAdmin pagination.');
    return rows;
  }
  async readTable(table) {
    const fields = { username: 'automation_username', key: this.rowKeyColumn, subscriberId: 'subscriber_id', isCovered: 'is_covered', isBundled: 'is_bundled', refundable: 'refundable' };
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
    return snapshot.rows;
  }
  async prepareRefundable(expected) {
    this.assertOrigin();
    // Production save support is deliberately unavailable, even if called directly.
    if (this.origin !== 'https://deposit-fixture.invalid') throw new StopError('LIVE_WRITES_DISABLED', 'Production inline editing is disabled until explicitly authorized and reviewed.');
    const table = await uniqueVisible(this.page.locator(this.resultTableSelector), 'deposit results', this.timeoutMs);
    const rows = await this.readTable(table);
    const index = rows.findIndex(row => row.key === expected.key && row.username === expected.username && row.subscriberId === expected.subscriberId);
    if (index < 0 || rows.filter(row => row.key === expected.key).length !== 1) throw new StopError('ROW_IDENTITY', 'Exact deposit record is missing or ambiguous.');
    if (rows[index].refundable !== '0' || rows[index].isCovered !== '0' || rows[index].isBundled !== '0') throw new StopError('RECORD_CHANGED', 'Deposit is no longer eligible.');
    const header = await uniqueVisible(table.locator('thead th[data-column="refundable"]'), 'refundable heading', this.timeoutMs);
    const column = await header.evaluate(el => [...el.parentElement.cells].slice(0, el.cellIndex)
      .reduce((offset, cell) => offset + cell.colSpan, 0));
    const row = table.locator('tbody > tr').nth(index);
    const cell = row.locator(':scope > td').nth(column);
    await cell.dblclick();
    const input = await uniqueVisible(cell.locator(this.inlineEditorSelector), 'refundable inline editor', this.timeoutMs);
    await input.fill('1');
    let attempted = false;
    return async () => {
      if (attempted) throw new StopError('DUPLICATE_SAVE', 'Enter must not be repeated for this record.');
      attempted = true;
      this.assertOrigin();
      // Recheck the row identity and flags after editing and before Enter.
      const fresh = (await this.readTable(table))[index];
      if (!fresh || fresh.key !== expected.key || fresh.username !== expected.username || fresh.subscriberId !== expected.subscriberId || fresh.isCovered !== '0' || fresh.isBundled !== '0' || await input.inputValue() !== '1') throw new StopError('RECORD_CHANGED', 'Row changed while the editor was open.');
      await input.press('Enter');
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

export function assertPreviewConfigured(config) {
  const live = config.livePreview;
  if (!live?.enabled || !live.rowKeyColumn || !live.resultTableSelector || !live.inlineEditorSelector) throw new StopError('LIVE_PREVIEW_NOT_READY', 'Live preview is disabled pending authorized UI/schema inspection and reviewed selectors. Use --demo for offline validation.');
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
