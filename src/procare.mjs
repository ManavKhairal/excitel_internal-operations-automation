import { APPS, assertStagingPage } from './browser.mjs';
import { StopError, clean, exactPattern, uniqueVisible, visibleItems, validUsername, disabled, waitFor, sleep, hash } from './utils.mjs';

const headerKey = text => clean(text).toLowerCase().replace(/[\s_-]+/g, '');

/** Extract only a named Username column, never infer usernames from name/email/phone. */
export async function readEmployeePage(page, config) {
  const s = config.procare.selectors;
  if (!!s.employeeRows !== !!s.usernameWithinRow) throw new StopError('CONFIG', 'Set employeeRows and usernameWithinRow together.');
  if (s.employeeRows) {
    const rows = await visibleItems(page.locator(s.employeeRows));
    if (!rows.length) throw new StopError('NO_EMPLOYEES', 'No employee rows found using the configured Procare selector.');
    const usernames = [];
    for (const row of rows) {
      const cell = await uniqueVisible(row.locator(s.usernameWithinRow), 'Procare username within row', 1000);
      usernames.push(validUsername(await cell.innerText()));
    }
    return { usernames, schema: 'configured-row-selector', rowCount: rows.length };
  }

  const tables = await visibleItems(s.employeeTable ? page.locator(s.employeeTable) : page.locator('table,[role="table"],[role="grid"]'));
  const candidates = [];
  for (const table of tables) {
    const headers = await table.locator('th,[role="columnheader"]').allTextContents();
    const matchingColumns = headers.map((h, i) => ['username', 'userid'].includes(headerKey(h)) ? i : -1).filter(i => i >= 0);
    if (matchingColumns.length === 1) candidates.push({ table, index: matchingColumns[0], headers });
    else if (matchingColumns.length > 1) throw new StopError('AMBIGUOUS_TABLE', 'Multiple Username headers found in one table. Configure explicit row and username selectors.');
  }
  if (candidates.length !== 1) {
    throw new StopError('PROCARE_SELECTOR_NEEDED', `Found ${candidates.length} visible tables/grids with one Username column. Need Procare employee-row HTML or selectors in config/staging.json. Extraction stopped; no guessed column.`);
  }
  const { table, index, headers } = candidates[0];
  const emptyCell = table.locator('td').filter({ hasText: /employees not found|no records found|no employees/i }).first();
  if (await emptyCell.isVisible().catch(() => false)) {
    throw new StopError('EMPTY_PARTNER', 'This partner has no employee records in Procare ("Employees not found").');
  }
  const rows = await visibleItems(table.locator('tr,[role="row"]'));
  const usernames = [];
  for (const row of rows) {
    const cells = row.locator(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]');
    if (await cells.count() === 0) continue; // header row
    if (await cells.count() <= index) throw new StopError('TABLE_SHAPE', 'A Procare employee row has fewer cells than the Username column. Inspect loading/empty-state markup.');
    const cell = cells.nth(index);
    if (Number(await cell.getAttribute('colspan') || 1) > 1) throw new StopError('TABLE_SHAPE', 'A spanning cell was found where a username was expected.');
    usernames.push(validUsername(await cell.innerText()));
  }
  if (!usernames.length) throw new StopError('NO_EMPLOYEES', 'No username rows were extracted. Empty/loading pages are not treated as a completed batch.');
  return { usernames, rowCount: usernames.length, schema: 'username-header', headers: headers.map(clean) };
}

async function automaticPager(page, config) {
  const s = config.procare.selectors;
  if (!s.nextPage) throw new StopError('PAGINATION_CONFIG', 'Automatic paging requires procare.selectors.nextPage.');
  const next = await uniqueVisible(page.locator(s.nextPage), 'Procare next-page control', config.timeoutMs);
  if (!s.pagination) return { next, last: await disabled(next) };

  // The verified Procare pager renders a sliding window of numbered <li>s.
  // Its arrow never becomes disabled; the active number reaches the rightmost
  // number only on the last page (including a one-page employee list).
  const pager = await uniqueVisible(page.locator(s.pagination), 'Procare numbered pagination', config.timeoutMs);
  const state = await pager.evaluate(el => {
    const items = [...el.children].filter(item => item.getClientRects().length);
    return {
      numbers: items.map(item => item.textContent.trim()).filter(text => /^\d+$/.test(text)).map(Number),
      active: items.filter(item => item.matches('.active,[aria-current="page"]')).map(item => item.textContent.trim())
    };
  });
  const current = Number(state.active[0]);
  if (state.active.length !== 1 || !Number.isSafeInteger(current) || current < 1 ||
      !state.numbers.includes(current) || state.numbers.some((n, i) => n < 1 || (i > 0 && n !== state.numbers[i - 1] + 1))) {
    throw new StopError('PAGINATION_STATE', 'Cannot verify the active page and consecutive Procare page numbers.');
  }
  const last = current === state.numbers.at(-1);
  if (!last && await disabled(next)) throw new StopError('PAGINATION_STATE', 'Procare Next is disabled before the last numbered page.');
  return { next, current, last };
}

async function stableEmployeePage(page, config, { automatic = false } = {}) {
  let previous = '', since = 0, emptySince = 0;
  return waitFor(async () => {
    let snapshot;
    try { snapshot = await readEmployeePage(page, config); }
    catch (error) {
      previous = ''; since = 0;
      if (error.code === 'EMPTY_PARTNER') {
        if (!emptySince) emptySince = Date.now();
        if (Date.now() - emptySince >= config.resultSettleMs) throw error;
        return false;
      }
      if (['PROCARE_SELECTOR_NEEDED', 'NO_EMPLOYEES', 'TABLE_SHAPE'].includes(error.code)) return false;
      throw error;
    }
    emptySince = 0;
    if (automatic) snapshot.pager = await automaticPager(page, config);
    const signature = JSON.stringify([snapshot.usernames, snapshot.pager?.current, snapshot.pager?.last]);
    if (signature !== previous) { previous = signature; since = Date.now(); return false; }
    return Date.now() - since >= config.resultSettleMs ? snapshot : false;
  }, { timeoutMs: config.timeoutMs, description: 'a stable Procare Username/UserID column (configure employeeRows/usernameWithinRow for a custom layout)' });
}

export async function collectEmployees(session, partnerName, config, { pagination = 'auto', ask } = {}) {
  const { page } = session;
  const s = config.procare.selectors;
  assertStagingPage(page, 'procare');
  await (await uniqueVisible(s.partnersNav ? page.locator(s.partnersNav) : page.getByText('Partners', { exact: true }), 'Partners navigation', config.timeoutMs)).click();
  const search = await uniqueVisible(page.locator(s.partnerSearch), 'Procare partner search', config.timeoutMs);
  await search.fill(partnerName);
  await search.press('Enter');
  const partnerPattern = exactPattern(partnerName, 'i');
  const exactPartner = s.partnerResult ? page.locator(s.partnerResult).filter({ hasText: partnerPattern }) : page.getByText(partnerPattern);
  const result = await uniqueVisible(exactPartner, `exact partner name: ${partnerName}`, config.searchTimeoutMs);
  await sleep(config.resultSettleMs);
  if ((await visibleItems(exactPartner)).length !== 1) throw new StopError('AMBIGUOUS_PARTNER', 'Partner search is not unique. Supply the full exact partner name and a narrower selector.');

  const partnerRow = result.locator('xpath=ancestor::tr');
  if (await partnerRow.count() > 0) {
    const cells = await partnerRow.locator('td').allInnerTexts();
    if (cells.length >= 7) {
      const partnerStatus = clean(cells[cells.length - 1]);
      console.log(`\nPartner status: ${partnerStatus}`);
      if (partnerStatus.toLowerCase() !== 'terminated') {
        throw new StopError('PARTNER_ACTIVE', `Partner "${partnerName}" status is "${partnerStatus}". Only Terminated partners can be processed. Halting automation.`);
      }
    }
  }

  await result.click();
  session.assertClear();
  assertStagingPage(page, 'procare');

  const employeeLinks = page.locator(s.employeesLink).filter({ hasText: /^\s*Employees\s*$/ });
  const link = await uniqueVisible(employeeLinks, 'the selected partner Employees link', config.timeoutMs);
  const href = await link.getAttribute('href');
  const url = new URL(href, page.url());
  const match = url.pathname.match(/^\/partner\/([^/]+)\/employee\/?$/);
  if (url.origin !== APPS.procare || !match) throw new StopError('PARTNER_URL', 'The Employees link does not match the supplied staging /partner/<id>/employee route. Inspect it before continuing.');
  const partnerId = decodeURIComponent(match[1]);
  await link.click();
  await page.waitForURL(u => u.origin === APPS.procare && u.pathname === url.pathname, { timeout: config.timeoutMs });
  console.log(`\nSelected partner: ${partnerName}\nPartner ID: ${partnerId}`);
  const collectionUrl = page.url();
  const seenPages = new Set();
  const unique = new Set();
  const pageCounts = [];
  let finished = false;

  for (let pageNo = 1; pageNo <= config.maxPages; pageNo++) {
    assertStagingPage(page, 'procare');
    if (new URL(page.url()).pathname !== url.pathname) throw new StopError('PARTNER_CHANGED', 'The partner Employees page changed during collection.');
    const snapshot = await stableEmployeePage(page, config, { automatic: pagination === 'auto' });
    session.assertClear();
    assertStagingPage(page, 'procare');
    if (new URL(page.url()).pathname !== url.pathname) throw new StopError('PARTNER_CHANGED', 'The partner Employees page changed while its employee list was loading.');
    if (snapshot.pager?.current !== undefined && snapshot.pager.current !== pageNo) {
      throw new StopError('PAGINATION_STATE', `Expected employee page ${pageNo}, but Procare shows page ${snapshot.pager.current}. Collection stopped before accepting an incomplete list.`);
    }
    const fingerprint = hash(snapshot.usernames);
    if (seenPages.has(fingerprint)) throw new StopError('REPEATED_PAGE', 'The employee list did not change. Refusing a pagination loop/incomplete collection.');
    seenPages.add(fingerprint);
    pageCounts.push(snapshot.rowCount);
    snapshot.usernames.forEach(username => unique.add(username));
    if (unique.size > config.maxEmployees) throw new StopError('BATCH_TOO_LARGE', `More than ${config.maxEmployees} employees found. Review the partner and explicitly raise maxEmployees if intended.`);
    console.log(`Page ${pageNo}: ${snapshot.rowCount} rows; ${unique.size} unique usernames collected.`);
    session.assertClear();

    if (pagination === 'single') { finished = true; break; }
    if (pagination === 'auto') {
      const { next, last } = snapshot.pager;
      if (last) { finished = true; break; }
      await next.click();
      await waitFor(async () => {
        const current = await readEmployeePage(page, config).catch(() => null);
        return current && hash(current.usernames) !== fingerprint;
      }, { timeoutMs: config.timeoutMs, description: 'the next employee page to replace the previous one' });
      continue;
    }
    if (!ask) throw new StopError('PAGINATION_CONFIRMATION', 'Guided pagination requires an interactive terminal.');
    console.log('Inspect the employee list, its page size, any filters and its pagination in Procare.');
    const instruction = clean(await ask('If more pages exist, move to the next page in the browser and type NEXT. If ALL pages are collected, type DONE: ')).toUpperCase();
    if (instruction === 'DONE') { finished = true; break; }
    if (instruction !== 'NEXT') throw new StopError('CANCELLED', 'Collection cancelled; expected NEXT or DONE.');
  }
  if (!finished) throw new StopError('PAGE_LIMIT', `Stopped at maxPages=${config.maxPages}; completeness has not been established.`);
  const usernames = [...unique];
  console.log(`\nCollected ${usernames.length} usernames for ${partnerName}:\n${usernames.map(u => `  ${u}`).join('\n')}`);
  if (pagination === 'auto') {
    console.log('All employee pages collected automatically.');
  } else if (ask) {
    const answer = clean(await ask(`Confirm the correct partner and COMPLETE employee list by typing COLLECT ${usernames.length}: `));
    if (answer !== `COLLECT ${usernames.length}`) throw new StopError('CANCELLED', 'Employee-list confirmation was not supplied.');
  } else throw new StopError('CONFIRMATION_REQUIRED', 'A human confirmation of this partner batch is required in version 1.');
  return {
    schemaVersion: 1, environment: 'staging', collectedAt: new Date().toISOString(),
    partner: { name: partnerName, id: partnerId, employeeUrl: collectionUrl },
    usernames, pageCounts, paginationMode: pagination,
    completeness: pagination === 'auto' ? 'pagination-verified' : 'operator-confirmed', datasetHash: hash({ partnerId, usernames })
  };
}
