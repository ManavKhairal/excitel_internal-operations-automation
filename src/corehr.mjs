import { assertStagingPage } from './browser.mjs';
import { StopError, clean, exactPattern, uniqueVisible, visibleItems, waitFor, sleep, disabled, screenshot, diagnostics, safeUrl } from './utils.mjs';

async function chooseText(page, text, selector, timeoutMs, { excludeEmployeeList = false } = {}) {
  if (selector) {
    const option = await uniqueVisible(page.locator(selector).filter({ hasText: exactPattern(text) }), `${text} option`, timeoutMs);
    await option.click(); return;
  }
  await waitFor(async () => {
    const semantic = await visibleItems(page.getByRole('option', { name: exactPattern(text) }));
    if (semantic.length > 1) throw new StopError('AMBIGUOUS_OPTION', `${text}: multiple visible options.`);
    if (semantic.length === 1) { await semantic[0].click(); return true; }
    let candidates = await visibleItems(page.getByText(text, { exact: true }));
    if (excludeEmployeeList) {
      const filtered = [];
      for (const item of candidates) if (!await item.evaluate(el => !!el.closest('[data-id="tenant-employees"]'))) filtered.push(item);
      candidates = filtered;
    }
    if (candidates.length > 1) throw new StopError('AMBIGUOUS_OPTION', `${text}: multiple visible text matches. Configure its dropdown option selector.`);
    if (!candidates.length) return false;
    await candidates[0].click(); return true;
  }, { timeoutMs, description: `the exact ${text} dropdown option` });
}

/** A record must display the exact username outside the results list before any edit. */
export async function verifyDetailIdentity(page, username, config) {
  const selector = config.corehr.selectors.detailUsername;
  if (selector) {
    const field = await uniqueVisible(page.locator(selector), 'detail username', config.timeoutMs);
    const text = await field.evaluate(el => 'value' in el ? el.value : el.textContent);
    const normalized = clean(text).replace(/^\(|\)$/g, '');
    if (normalized !== username) throw new StopError('IDENTITY_MISMATCH', `The detail username is not the exact requested username ${username}.`);
    return;
  }
  await waitFor(async () => {
    const candidates = await visibleItems(page.getByText(username, { exact: true }));
    for (const candidate of candidates) {
      if (!await candidate.evaluate(el => !!el.closest('[data-id="tenant-employees"]'))) return true;
    }
    const inputs = await visibleItems(page.locator('input'));
    for (const input of inputs) {
      const isSearchOrList = await input.evaluate(el => el.getAttribute('data-id') === 'tenant-employees-search-input' ||
        el.getAttribute('role') === 'searchbox' || !!el.closest('[data-id="tenant-employees"]'));
      if (!isSearchOrList && clean(await input.inputValue()) === username) return true;
    }
    return false;
  }, { timeoutMs: config.timeoutMs, description: `exact username ${username} on the opened detail record. If its field is different, set corehr.selectors.detailUsername` });
}

export async function openEmployeePermissions(session, username, config) {
  const { page } = session;
  const s = config.corehr.selectors;
  assertStagingPage(page, 'corehr');
  const navigation = s.partnerEmployeesNav ? page.locator(s.partnerEmployeesNav) : page.getByText('Partner Employees', { exact: true });
  await (await uniqueVisible(navigation, 'Partner Employees navigation', config.timeoutMs)).click();
  const input = await uniqueVisible(page.locator(s.searchInput), 'CoreHR employee search', config.timeoutMs);
  const selected = await uniqueVisible(page.locator(s.searchByValue), 'search-by value', config.timeoutMs);
  if (clean(await selected.innerText()).toLowerCase() !== 'username') {
    await (await uniqueVisible(page.locator(s.searchBy), 'search-by dropdown', config.timeoutMs)).click();
    await chooseText(page, 'Username', s.usernameOption, config.timeoutMs, { excludeEmployeeList: true });
    await waitFor(async () => clean(await selected.innerText()).toLowerCase() === 'username', { timeoutMs: config.timeoutMs, description: 'Username search mode' });
  }
  await input.fill(username);
  await input.press('Enter');
  // CoreHR commits its search into the URL. A populated input alone does not
  // prove that the controlled search component accepted Enter after rendering.
  if (config.corehr.searchQueryParam) {
    const submitted = () => new URL(page.url()).searchParams.get(config.corehr.searchQueryParam) === username;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await waitFor(async () => {
          session.assertClear();
          return submitted();
        }, { timeoutMs: attempt === 0 ? Math.min(1000, config.timeoutMs) : config.timeoutMs,
          description: 'CoreHR to commit the username search' });
        break;
      } catch (error) {
        if (!(error instanceof StopError) || error.code !== 'TIMEOUT') throw error;
        if (attempt === 1) throw new StopError('SEARCH_NOT_SUBMITTED',
          `${username}: CoreHR did not accept the username search after one retry. No record was opened or changed.`);
        // Retrying this read-only search never retries an employee status Save.
        await input.fill(username);
        await input.press('Enter');
      }
    }
  }
  const rows = page.locator(s.rows).filter({ has: page.locator(s.usernameCell).filter({ hasText: exactPattern(username) }) });
  const deadline = Date.now() + config.searchTimeoutMs;
  let row, firstSeen = 0;
  while (Date.now() < deadline) {
    session.assertClear();
    const matches = await visibleItems(rows);
    if (matches.length > 1) throw new StopError('AMBIGUOUS_MATCH', `${username}: more than one exact employee record. No record was opened.`, { stopBatch: false });
    if (matches.length === 1) {
      if (!firstSeen) firstSeen = Date.now();
      if (Date.now() - firstSeen >= config.resultSettleMs) { row = matches[0]; break; }
    } else firstSeen = 0;
    await sleep(100);
  }
  if (!row) throw new StopError('NO_EXACT_MATCH', `${username}: no exact visible result within the timeout. Check availability, filters, permissions and backend errors; no change made.`, { stopBatch: false });
  const cell = await uniqueVisible(row.locator(s.usernameCell), 'exact username cell', config.timeoutMs);
  if (clean(await cell.innerText()) !== username) throw new StopError('IDENTITY_MISMATCH', 'The employee result changed before it could be opened.');
  const partnerNameCell = row.locator('[data-id="partner-employees-body-column-name"]');
  if (await partnerNameCell.count() > 0) {
    await partnerNameCell.first().click();
  } else {
    await cell.click();
  }
  await verifyDetailIdentity(page, username, config);
  assertStagingPage(page, 'corehr');

  let tab;
  if (s.permissionsTab) tab = await uniqueVisible(page.locator(s.permissionsTab), 'employee Permissions tab', config.timeoutMs);
  else {
    const roleTabs = await visibleItems(page.getByRole('tab', { name: 'Permissions', exact: true }));
    if (roleTabs.length > 1) throw new StopError('AMBIGUOUS_CONTROL', 'Multiple Permissions tabs.');
    tab = roleTabs[0] || await uniqueVisible(
      page.locator('div[role="presentation"][tabindex="0"]').filter({ hasText: /^\s*Permissions\s*$/ }),
      'employee Permissions tab from supplied markup (not the sidebar Permissions menu)', config.timeoutMs);
  }
  await tab.click();
  session.assertClear();
  assertStagingPage(page, 'corehr');
  const status = await uniqueVisible(page.locator(s.statusValue), 'employee status', config.timeoutMs);
  return { status: clean(await status.innerText()), detailUrl: safeUrl(page.url()) };
}

async function setInactive(page, config) {
  const s = config.corehr.selectors;
  await (await uniqueVisible(page.locator(s.statusEdit), 'status edit icon', config.timeoutMs)).click();
  if (s.statusSelect) {
    const select = await uniqueVisible(page.locator(s.statusSelect), 'status select', config.timeoutMs);
    await select.selectOption({ label: 'Inactive' });
    return;
  }
  // Support a native select only if one unambiguously contains this exact option.
  const matchingSelects = [];
  for (const select of await visibleItems(page.locator('select'))) {
    const labels = await select.locator('option').allTextContents();
    if (labels.some(label => clean(label) === 'Inactive')) matchingSelects.push(select);
  }
  if (matchingSelects.length > 1) throw new StopError('AMBIGUOUS_CONTROL', 'Multiple native selects offer Inactive. Set corehr.selectors.statusSelect.');
  if (matchingSelects.length === 1) { await matchingSelects[0].selectOption({ label: 'Inactive' }); return; }
  await chooseText(page, 'Inactive', s.inactiveOption, config.timeoutMs);
}

/** Exactly one Save attempt. After uncertainty, stop the batch rather than retrying the write. */
export async function processEmployee(session, username, config, { apply = false, outputDir, onCheckpoint = async () => {} } = {}) {
  const { page } = session;
  const s = config.corehr.selectors;
  const result = { username, outcome: 'NOT_PROCESSED', before: '', after: '', saveAttempted: false, detailUrl: '', evidence: '', message: '', finishedAt: '' };
  let stopBatch = false;
  try {
    const opened = await openEmployeePermissions(session, username, config);
    result.before = opened.status;
    result.detailUrl = opened.detailUrl;
    const normalized = opened.status.toLowerCase();
    if (normalized === 'inactive') {
      result.outcome = 'ALREADY_INACTIVE'; result.after = opened.status;
      result.message = 'Already inactive; no edit or save was attempted.';
    } else if (normalized !== 'active') {
      result.outcome = 'UNEXPECTED_STATUS'; result.after = opened.status;
      result.message = 'Status is neither Active nor Inactive. Left unchanged for review.';
    } else if (!apply) {
      result.outcome = 'DRY_RUN_ACTIVE'; result.after = opened.status;
      result.message = 'Would deactivate with --apply. No status edit or save attempted.';
    } else {
      assertStagingPage(page, 'corehr');
      session.assertClear();
      await screenshot(page, outputDir, `${username}-before`, config.screenshots);
      await setInactive(page, config);
      const bar = await uniqueVisible(page.locator(s.submitBar), 'partner employee save/cancel bar', config.timeoutMs);
      const save = await uniqueVisible(bar.locator(s.save), 'Save within the partner-employee submit bar', config.timeoutMs);
      await waitFor(async () => !await disabled(save), { timeoutMs: config.timeoutMs, description: 'the Save button to be enabled' });
      assertStagingPage(page, 'corehr');
      session.assertClear();
      result.saveAttempted = true;
      await onCheckpoint({ ...result, outcome: 'SAVE_STARTED_UNVERIFIED', message: 'A Save attempt is about to occur or may be in flight. Recheck CoreHR if this run is interrupted.' });
      // No retry of this click, including after a timeout or lost connection.
      await save.click();
      await waitFor(async () => {
        session.assertClear();
        return !(await bar.isVisible().catch(() => false)) || await disabled(save).catch(() => false);
      }, { timeoutMs: config.timeoutMs, description: 'the status save to settle' });
      await sleep(config.resultSettleMs);
      let verified = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        assertStagingPage(page, 'corehr');
        await page.reload({ waitUntil: 'domcontentloaded' });
        const fresh = await openEmployeePermissions(session, username, config);
        result.after = fresh.status;
        result.detailUrl = fresh.detailUrl;
        if (fresh.status.toLowerCase() === 'inactive') { verified = true; break; }
        await sleep(1000);
      }
      if (!verified) throw new StopError('SAVE_UNVERIFIED', `${username}: Save was attempted, but Inactive was not confirmed by reopening the exact record.`);
      result.outcome = 'DEACTIVATED_VERIFIED';
      result.message = 'Saved once; reloaded and reopened the exact username; Inactive verified.';
      result.evidence = await screenshot(page, outputDir, `${username}-verified-inactive`, config.screenshots);
    }
  } catch (error) {
    result.outcome = result.saveAttempted ? 'SAVE_UNVERIFIED' : (error instanceof StopError ? error.code : 'FAILED_BEFORE_SAVE');
    result.message = error.message.split('\n')[0];
    stopBatch = result.saveAttempted || !(error instanceof StopError) || error.stopBatch;
    result.evidence = await diagnostics(page, outputDir, `${username}-${result.outcome}`, config.screenshots).catch(() => '');
  }
  result.finishedAt = new Date().toISOString();
  return { result, stopBatch };
}
