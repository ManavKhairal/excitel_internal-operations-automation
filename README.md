# Excitel internal operations automation

One Node.js + Playwright project with independently selected tasks:

| Task | Command | Availability |
| --- | --- | --- |
| ERP employee deactivation | `npm start -- --partner "PARTNER"` or add `--task erp-deactivation` | Existing staging workflow; `--apply` enables staging saves. |
| Deposit refundability | `npm start -- --task deposit-refundability --demo --username demo.north` | Offline preview/demo implemented; production preview and writes remain disabled. |

The deposit task checks the two tenant sheets, validates individual deposit records, simulates eligible refundable changes to **1**, verifies results, logs out, and records completion in a simulated sheet. See [deposit setup and rules](docs/deposit-refundability.md) for demo commands, current limits, and the remaining production-preview setup. No additional dependencies are required.

## ERP employee deactivation

A local Node.js + Playwright project for the workflow you described:

1. Open staging Procare, authenticate, select Partners and search an exact partner name. Eligible partner statuses are **Terminated** and **Inactive**; Active and other statuses are rejected by the status check.
2. Open that partner's Employees link, extracting the actual partner ID from its URL.
3. Read usernames from the employee list, collect all pages and remove duplicate usernames.
4. Open staging CoreHR and use **Partner Employees**, not the separate Employees screen.
5. Search by Username, require an exact unique username and verify the opened record's identity.
6. Open Permissions. Skip employees already Inactive. In dry-run mode, leave Active users unchanged.
7. With `--apply`, set an Active employee to Inactive and click Save once, without an additional confirmation prompt.
8. Reload, search and reopen the same username, and confirm that Inactive persisted.
9. Write per-user results, including already-inactive, not-found, failed and unprocessed users.
10. Log out of CoreHR and Procare using their UI menus, verify that reopening each app requires login, and close both browsers.

**ERP scope:** manual trigger, staging only. No Zendesk, Gmail, AI API, Joget, production switch, or database updates are included. No extra AI subscription/API key is needed to run this script.

## Validation status and known gaps

The original ERP baseline passed **46 offline browser-fixture, CLI, and unit tests**. Current multi-task validation is recorded in `TEST_RESULTS.md`. These tests simulate CoreHR markup, the verified Procare table/pager, partner status eligibility, and logout flows. They do **not** connect to either company application or deactivate real users. Separate staging run and live logout evidence is recorded in `TEST_RESULTS.md`.

Your supplied CoreHR `data-id` selectors are used directly. Generated `css-*` and `_ngcontent-*` classes are deliberately not used.

The following information was not supplied and is not invented:

- Login form selectors: first use supports manual login in the script's own browser. Optional credential automation requires three configured selectors per app.
- Procare employee-row markup: the default collector recognizes a standard HTML table or ARIA table/grid with exactly one column named `Username` or `User Name`. A different layout requires explicit row/username selectors.
- Procare pagination controls are configured from the staging UI. Automatic collection follows the numbered pager through its last page without terminal prompts.
- The CoreHR detail username field and Inactive menu markup: defaults support visible exact username text/input values and an unambiguous Inactive option or native select. Configure these if the real UI differs.
- Any separate staging API/SSO origins: they must be verified and allowlisted locally before the script sends requests to them. It never guesses backend hosts.

The collector deliberately stops if it cannot identify a username column or a unique partner. It does not assume that the first employee page is the complete list.

## 1. Install

Use Node.js 22 or newer. Extract the ZIP, open a terminal in the project folder, then run:

```bash
npm install
npx playwright install chromium
```

On Linux, if Playwright reports missing OS dependencies:

```bash
npx playwright install --with-deps chromium
```

The dependency range supports Playwright 1.57 and later 1.x releases. Local fixture validation used Playwright 1.57.0 and the container's Chromium. Keep the `package-lock.json` created by your own `npm install` after validating your installation.

## 2. Set your staging credentials

Both Procare and CoreHR redirect to the **same Auth0 login page** (`excitel-prerelease.eu.auth0.com`). Auto-login is preconfigured.

Open [`.env`](.env) and replace the placeholders with your staging credentials:

```env
PROCARE_USERNAME=your.email@example.com
PROCARE_PASSWORD=your_staging_password
COREHR_USERNAME=your.email@example.com
COREHR_PASSWORD=your_staging_password
```

If both apps use the same account (likely, since they share the same Auth0 tenant), use the same values for both.

Never commit `.env`. The project `.gitignore` already excludes it.

When you run `npm run login` or `npm start`, the script will:
1. Navigate to the staging app
2. Wait for the Auth0 redirect
3. Fill in your username and password automatically
4. Click the "LOG IN" button
5. Wait for the app to load after the Auth0 callback redirect

If MFA/2FA is enabled on your Auth0 account, the script will fill the username and password but you will need to complete the MFA step manually in the browser that opens.

Normal task runs, including previews, sign out of both applications after saving results. The next run signs in again using configured credentials, with manual MFA if required. `npm run login` deliberately keeps its prepared sessions; it does not execute a task or immediately log out.

## 3. First run: preview only

Replace the quoted placeholder with an exact partner name in staging:

```bash
npm start -- --partner "EXACT STAGING PARTNER NAME"
```

This is a **dry run**: it opens records and reads statuses but never clicks the status edit control or Save.

Employee collection prints the partner name/ID and collects every page automatically. No `NEXT`, `DONE`, or `COLLECT` input is needed in the default mode. The collected usernames and pagination evidence are saved to `employees.json`.

The script then checks each exact username in CoreHR and produces the report. Authentication and read/search requests may still use POST; dry run means no employee-status mutation by the automation, not a blanket network-level read-only account.

## 4. Apply staging deactivations

After reviewing a successful dry run:

```bash
npm start -- --partner "EXACT STAGING PARTNER NAME" --apply
```

The `--apply` flag authorizes staging status saves. The script recollects a fresh partner list and proceeds directly, with no `DEACTIVATE N STAGING` prompt. Without `--apply`, it remains a dry run. A normal production URL cannot be supplied on the command line. Automatic collection and configured/saved login can run without terminal input; manual login/MFA and explicitly selected guided pagination still need an interactive terminal.

Active records receive at most **one Save attempt per run**. Already-inactive records do not receive any edit or Save. If persistence cannot be verified after a Save, the batch stops: that user is `SAVE_UNVERIFIED` and the remainder are `NOT_PROCESSED`.

A checkpoint is written before Save so an interrupted run is not silently recorded as untouched. After a crash, inspect `SAVE_STARTED_UNVERIFIED` or `SAVE_UNVERIFIED` records before retrying.

## 5. Outputs

Each run creates a private, timestamped `output/<run>/` folder:

| File | Purpose |
| --- | --- |
| `employees.json` | Exact partner name/ID, source URL, unique usernames, page counts and collection time. |
| `report.csv` | One row per username, suitable for Excel/Sheets review. |
| `report.json` | Same results plus counts and batch metadata. |
| `logout.json` | Per-application logout verification and browser cleanup results, including when collection fails before a task report exists. |
| `<username>-before.png` | Optional screenshot immediately before an apply attempt. |
| `<username>-verified-inactive.png` | Optional screenshot after reopening and verifying Inactive. |
| `*-ui-summary.json`, `*.png`, `error.json` | Local failure diagnostics. |

No real employee sample is bundled. Report fields include username, outcome, before/after status, whether Save was attempted, detail URL, evidence file, message and completion timestamp. Screenshots and reports can contain employee personal data; retain and share them only through approved internal channels. Screenshots can be disabled with `"screenshots": false`.

| Outcome | Meaning |
| --- | --- |
| `DRY_RUN_ACTIVE` | Active record found; no change attempted. |
| `ALREADY_INACTIVE` | Already inactive; skipped without saving. |
| `DEACTIVATED_VERIFIED` | Save attempted once, then exact record reopened and Inactive verified. |
| `NO_EXACT_MATCH` | No exact result within the timeout; absence is not proven. Check filters, availability or request failures. |
| `AMBIGUOUS_MATCH` | Multiple exact username results; skipped rather than guessing. |
| `UNEXPECTED_STATUS` | Neither Active nor Inactive; left unchanged. |
| `SAVE_STARTED_UNVERIFIED` | A Save may be in flight or the run was interrupted; recheck the record. |
| `SAVE_UNVERIFIED` | Save may have succeeded; do not blindly repeat it. Batch stopped. |
| `NOT_PROCESSED` | Not reached because the batch stopped or was cancelled. |
| Other error code | An identity, selector, login, environment or connectivity check failed. Review diagnostics. |

Successful checks verify the **CoreHR status field**, not revocation of all active sessions or permissions in downstream applications.

### Automatic logout

The script keeps Procare's session available until the task finishes, saves the task results (or failure diagnostics), then attempts CoreHR and Procare logout before closing their browsers. The verified controls are Procare's profile menu → Logout and CoreHR's avatar menu → Logout. Their selectors are in each application's `logout` configuration.

Logout succeeds only when the allowed login screen is visible and reopening the application still requires login. Results appear in `logout.json` and `report.json` under `cleanup`: `SIGNED_OUT_VERIFIED`, `ALREADY_SIGNED_OUT`, or `LOGOUT_FAILED`. Browser-close failures are also recorded. A logout problem does not overwrite employee outcomes or the task's completion status; it prints a warning and returns exit code **3** if the task otherwise succeeded. Existing task failure exit codes take precedence. Review `cleanup` as well as the task status.

Cleanup is also attempted on handled task errors. Forced process termination, a machine shutdown, or an unreachable application can prevent verified logout; browser closure alone is never reported as successful sign-out.

## Configuring the remaining selectors

Edit `config/staging.json`, not the workflow code.

### A non-table Procare employee list

Set both of these to selectors verified from the actual employee list:

```json
{
  "employeeRows": "YOUR_VERIFIED_EMPLOYEE_ROW_SELECTOR",
  "usernameWithinRow": "YOUR_VERIFIED_USERNAME_CELL_SELECTOR"
}
```

`usernameWithinRow` is relative to each employee row. It must select only the username, not the employee name, phone or email. If there is one normal table with a Username header, leave both null. Use `employeeTable` to restrict to one table when several are present.

The Employees route is discovered from the selected partner's link. `/partner/1/employee` is **not** hardcoded.

### Pagination

Default: automatic. The configured `procare.selectors.pagination` and `nextPage` match Procare's numbered pager. The standard command collects all pages without collection prompts:

```bash
npm start -- --partner "EXACT STAGING PARTNER NAME"
```

Procare's Next arrow remains enabled on the last page. The collector uses the active number and the verified sliding window of page numbers to detect completion. Missing or ambiguous controls, a skipped page, a repeated page, too many pages or too many employees stop collection. For an alternate pager without numbered pages, set `pagination` to null and configure a Next control that is visibly disabled on the last page. Infinite-scroll/virtualized lists need separate adaptation.

For manual inspection, use `--pagination guided`. It asks for `NEXT`/`DONE` and a final `COLLECT N` confirmation.

For a genuinely single-page list only:

```bash
npm start -- --partner "EXACT STAGING PARTNER NAME" --pagination single
```

Single-page mode also asks for `COLLECT N`, since it does not verify pagination. In the default automatic mode, `--apply` runs without collection or status-save confirmation prompts.

### CoreHR detail identity

If the detail username is displayed in an unusual control, set `corehr.selectors.detailUsername` to that exact field. The code compares its text/input value to the requested username. It excludes the results table and search input from default identity checks.

The employee Permissions tab is matched using the supplied `div[role="presentation"][tabindex="0"]` markup, or an accessible tab. It is not selected by blindly clicking the first sidebar item called Permissions.

Save is the actual `[data-id="submit-form"]` button within `[data-id="partner-employee-permissions-submit-bar"]`. `::before` is not used as a click target.

### Dropdown variants

`usernameOption` and `inactiveOption` may be set to verified CSS selectors for custom options. A native status `<select>` can use `statusSelect`. The default uses exact option text and refuses multiple matches.

## Staging safeguards

The two application origins are fixed in `src/browser.mjs`. There is no environment variable or CLI switch to turn this build into production automation.

Top-level navigation to other origins and POST/PUT/PATCH/DELETE-style requests to unapproved origins are blocked. If either staging app calls a separate staging API or identity service, confirm its exact origin first and add it to that app's `additionalWriteOrigins` or `additionalNavigationOrigins` as needed. Login redirects and writes may need both entries. Never add production data API origins merely to make a blocked request work.

These are frontend/origin safeguards, not proof that the staging application's backend is correctly isolated. Validate its backend configuration before applying. The script does not bypass TLS checks, SSO/MFA or application permissions.

Other controls: exact partner and username matching, verified pagination, an explicit `--apply` flag for writes, duplicate elimination, live status checks, local run lock, no blind Save retries, and checkpointed results. Identity/selector failures halt the batch; clearly missing or duplicate search matches are recorded and skipped. One actor should own the task during a run so a teammate is not changing the same records concurrently.

## Troubleshooting

**`PROCARE_SELECTOR_NEEDED` / stable Username column timeout**: the list is not a recognizable table/grid or has not loaded. Inspect `stopped-ui-summary.json` and the screenshot. Provide one employee row plus its header and pagination markup; configure exact selectors. Do not select another column just to pass the check.

**`SEARCH_NOT_SUBMITTED`**: CoreHR did not commit the username into its search URL after one read-only retry. The batch stops before opening a record. Check connectivity and the search control. `corehr.searchQueryParam` is `filter` for the current staging app.

**`NO_EXACT_MATCH`**: verify the Partner Employees screen, Username filter, case/exact ID, inactive visibility and any active-only filters. The code does not treat partial matches as valid.

**`AMBIGUOUS_CONTROL`**: narrow the selector in config. No `.first()` workaround is used for ambiguity.

**`BLOCKED_ORIGIN`**: verify the blocked staging/SSO origin in the terminal. It is printed without query parameters. Allowlist only after confirming its environment and purpose.

**`SAVE_UNVERIFIED`**: manually inspect that exact username. Never assume failure means no change happened. Rerunning recollects the partner list and checks current status, so confirmed Inactive users are skipped.

**`LOCKED`**: ensure no run or dedicated automation browser is still active. If the process crashed, remove `.state/run.lock` only after checking. Never run two workers against the same profile/batch.

**Unexpected alert or confirmation dialog**: version 1 dismisses it and stops for review. The supplied workflow used an inline Save/Cancel bar, not a JavaScript confirmation dialog. Additional dialogs require a specific, tested handler.

## Tests

```bash
npm run check
npm test
```

Tests run entirely with offline DOM fixtures; no credentials and no company network access are used. On a machine using a separately installed Chromium:

```bash
TEST_BROWSER_EXECUTABLE=/path/to/chromium npm test
```

See `TEST_RESULTS.md` for the tested scenarios and limitations.

## Future phases

`src/procare.mjs` collects a task's subjects; `src/corehr.mjs` performs this one defined action. A future Zendesk reader can create a reviewed task input, and a future Joget module can consume verified completion results. Neither is implemented or implied in this version. A production rollout should be a separately reviewed configuration with fresh selector, account, backend-origin and recovery validation, not an unreviewed URL replacement.

## Official Playwright references

- Locators and exact matching: https://playwright.dev/docs/locators
- Authentication/session security: https://playwright.dev/docs/auth
- Browser contexts and routing: https://playwright.dev/docs/api/class-browsercontext
