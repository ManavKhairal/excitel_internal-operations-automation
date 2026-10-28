# Project handoff — internal operations automation

Last updated: **28 October 2026**, Asia/Kolkata.

This is the resume point for the project. The user asked to leave the working functionality as it is and continue later. Creating this document does not authorize further application changes or implementation work.

## Start here next time

- **ERP employee deactivation works in staging**, including Inactive/Terminated partner support, automatic employee pagination, verified deactivation and logout.
- **Deposit refundability has completed approved North production runs**, including multiple usernames, verified saves, logout and completion-sheet entries. The duplicate Edit inline problem is fixed and verified live.
- **Important distinction:** live deposit runs used scoped local execution helpers plus the connected Google Sheets tools. The ordinary deposit CLI still supports offline demonstrations and blocks general production writes. A fully standalone production deposit runner is pending.
- **Next feature requested by the user: Workforce access management / giving rights.** No Workforce code, configuration or branch exists yet. Obtain the actual manual process before designing its permissions workflow.
- **The deposit foundation and multi-task dispatcher are saved in the local checkpoint commit containing this handoff**, titled `Add modular deposit refundability workflow and project handoff`. Pushing that checkpoint to GitHub remains pending; no push was requested for this checkpoint.
- No previously requested user update remains unfinished. Historical report usernames and local helper scripts are not a new execution queue.

## Repository and branches

Repository: [excitel_internal-operations-automation](https://github.com/ManavKhairal/excitel_internal-operations-automation).

Local folder: `/home/manav/Downloads/corehr-staging-automation`. The folder and package retain their original CoreHR name; the intended product is one modular project for several support operations.

| Branch / reference | State at this handoff | Purpose / next action |
| --- | --- | --- |
| `main` | Commit `984ef2f`; stable ERP baseline | Preserve as the known working ERP version. |
| `feature/deposit-refundability` | Current branch; local checkpoint commit containing this document, titled `Add modular deposit refundability workflow and project handoff` | Multi-task foundation, deposit module, regressions and handoff saved locally. Push remains pending. |
| `feature/workforce-access` | Proposed name only; **not created** | Future branch for Workforce rights management, after preserving the current work and choosing its committed starting point. |
| `erp-deactivation-stable-2026-10-27` | Existing tag at `984ef2f` | Recovery point for the ERP automation before the local multi-task expansion. |
| `v1.0.0` | Existing tag at `aadaf06` | Earlier initial backup. |

There is no separate ERP feature branch in the current branch list: its stable implementation is on `main` and the ERP recovery tag.

The locally recorded `origin/main` and `origin/feature/deposit-refundability` still point to `984ef2f`. No remote fetch or push was performed for this checkpoint. The local commit is not yet backed up on GitHub. To identify its hash without embedding a commit's own hash in its contents, use `git log -1 --format='%h %s' -- PROJECT_HANDOFF.md`.

This checkpoint includes the dispatcher, preserved ERP CLI, deposit modules and configuration, fixtures, tests, documentation and development notes. Existing credentials, sessions and production reports remain excluded. Inspect `git status` when resuming before switching branches or changing the checkpoint.

## Project foundation

- Node.js **22+**, JavaScript ES modules and Playwright; no new runtime dependencies were added for the deposit foundation.
- [src/cli.mjs](src/cli.mjs) dispatches through [src/task-registry.mjs](src/task-registry.mjs).
- Registered task IDs: `erp-deactivation` and `deposit-refundability`. ERP remains the default when `--task` is omitted.
- The original ERP CLI was moved to [src/erp-cli.mjs](src/erp-cli.mjs), preserving its working behavior.
- Deposit business logic is separate from CLI/browser/spreadsheet adapters, so later approved triggers can call it without parsing terminal output.
- Reports/checkpoints are local JSON/CSV, with screenshots where applicable. There is a local exclusive run lock, not a distributed scheduler or cross-machine locking system.
- Keep execution **visible** for now. The user prefers `headless: false`; offline automated tests use headless browsers explicitly.
- No AI provider is required by the Playwright scripts. Zendesk, AI request interpretation and Joget are future integrations, not implemented features.

## Feature 1 — ERP employee deactivation

**Status:** working staging workflow, retained as the stable baseline.

### Existing behavior

1. Sign in to staging Procare and find the exact ERP/partner.
2. Allow partner status **Terminated or Inactive**. Active and other unsupported statuses are blocked.
3. Discover the selected partner's Employees URL and actual partner ID; collect all employee pages automatically and deduplicate usernames.
4. Open staging CoreHR **Partner Employees**, search by exact username and verify a unique matching identity.
5. Skip already-Inactive employees. In preview mode, report Active employees without editing.
6. With explicit `--apply`, change Active to Inactive and attempt Save once.
7. Reload/search/reopen the same employee to verify that Inactive persisted. This second search is deliberate verification.
8. Write outcomes/checkpoints, then sign out of CoreHR and Procare, verify login is required again and close browsers.

The old default NEXT/DONE pagination prompts and DEACTIVATE confirmation phrase were removed. Explicit guided pagination and manual MFA can still require user interaction.

### Commands for reference

Preview, without employee-status saves:

```bash
npm start -- --partner "EXACT STAGING PARTNER NAME"
```

Explicit task selection works as well:

```bash
npm start -- --task erp-deactivation --partner "EXACT STAGING PARTNER NAME"
```

Adding `--apply` enables staging saves. These are reference instructions, not an instruction to execute a new run when resuming this document.

### Relevant files and remaining scope

- [config/staging.json](config/staging.json): ERP configuration and selectors.
- [src/procare.mjs](src/procare.mjs), [src/corehr.mjs](src/corehr.mjs), [src/browser.mjs](src/browser.mjs), [src/utils.mjs](src/utils.mjs): existing application and shared utilities.
- [README.md](README.md): detailed commands, outcomes, pagination and cleanup behavior.
- ERP production execution is not enabled or validated. Do not assume the successful deposit production work changes the ERP environment restriction.
- Preserve this workflow when adding Workforce; run its existing regression tests after future shared-code changes.

## Feature 2 — deposit refundability correction

**Status:** business rules and offline task module implemented; scoped North production execution demonstrated successfully. General standalone production CLI integration remains pending.

### Final agreed rules

1. Use exact usernames, preserving case and leading zeroes. ERP/partner names are **not** matching criteria.
2. Check only **North Tenant** and **South Tenant** for eligibility. Missing from both means stop with an error; present in both means stop with an ambiguity error. A sheet-access failure is not equivalent to an empty sheet.
3. Choose the database tenant from verified membership. A manually supplied tenant must agree.
4. Look up deposits through the `subscriber` → `subscriber_deposit` join. Bind every result to the exact username, subscriber ID and unique `deposit_id`; reject incomplete or ambiguous results.
5. Inspect each row independently. Skip rows with `is_covered = 1` **or** `is_bundled = 1`, while continuing with other eligible rows for the same username.
6. For eligible rows, skip/report `refundable = 1` as already refundable. Change only eligible `refundable = 0` rows to **1**. The earlier discussion of setting 0 was superseded by this final rule.
7. Recheck identity and flags immediately before editing. Double-click the refundable cell, fill `1` and press Enter once, with a checkpoint before submission.
8. Re-query the actual persisted record and verify the same identity, eligible flags and refundable value. An optimistic cell display is insufficient. Stop on an uncertain save; never blindly repeat Enter.
9. After database verification, log out, verify that login is required again and close the browser.
10. Record completed changes in **North Changes reverted** or **South Changes reverted**, with `Username`, `YES` and the execution date in Asia/Kolkata. Check for an existing completion entry before appending and verify the written cells afterward.
11. If all eligible rows were already refundable, skip the changes and report that outcome; do not create a new completion entry for an untouched user. Incomplete/uncertain processing must not be recorded as completed.

This task changes refundability eligibility; it does not itself process a monetary refund.

### Applications and spreadsheet

| Tenant | phpMyAdmin base URL | Source tab | Completion tab |
| --- | --- | --- | --- |
| North / Delhi / DEL | `https://del-procare-mariadb.excitel.in/pma/` | North Tenant | North Changes reverted |
| South / Hyderabad / HYD | `https://hyd-procare-mariadb.excitel.in/pma/` | South Tenant | South Changes reverted |

Database: `excitel_ticketing_system`. Deposit table: `subscriber_deposit`. Sessions must acquire their own tokens through login/navigation; do not reuse session-token URLs copied from earlier messages.

Spreadsheet ID is configured in [config/deposit-refundability.json](config/deposit-refundability.json). Completion columns A:C are Username / Refundable / Date; preserve the additional historical columns. Live dates were stored as native DATE cells using `d-mmm-yyyy`, not just displayed text.

North was inspected and exercised live. **South has not been validated against its live UI**; tenant routing and South workflow behavior have offline coverage.

### Actual implementation boundary — do not lose this distinction

| Capability | Current state |
| --- | --- |
| Offline deposit preview and apply simulation through the normal CLI | Working with synthetic browser pages and in-memory Sheets. |
| Scoped North production updates demonstrated in this session | Working through explicitly scoped local helpers, with connected Google Sheets reads/writes coordinated by the assistant. |
| Normal CLI production preview | Disabled: `livePreview.enabled` is false and reviewed selector fields are not populated. |
| Normal CLI production database writes | Blocked by `LIVE_WRITES_DISABLED` in the CLI/workflow/browser adapter boundaries. |
| Standalone Google Sheets completion writes | Not implemented/enabled in the local Google transport; connected chat tools are a separate authentication path. |
| New arbitrary production usernames through one general command | Pending generalization; previous helpers were restricted to specific approved usernames and deposit IDs. |

Normal CLI demo references:

```bash
npm start -- --task deposit-refundability --demo --username demo.north
npm start -- --task deposit-refundability --demo --username demo.north --apply
```

`--demo` never reads or updates real users. Adding `--apply` without `--demo` does not currently enable the general production path. Do not remove the write guards just to make that command run.

### Fixed issue: duplicate Edit inline links

phpMyAdmin **4.4.15.10** appends UPDATE SQL and its tools inside the same `.result_query` as the original SELECT. Selecting the entire container still finds two Edit inline links.

The shared `selectQueryControls()` in [src/integrations/phpmyadmin.mjs](src/integrations/phpmyadmin.mjs) selects the SELECT `.sqlOuter` block and its immediately adjacent `.tools`. Multiple SELECT blocks remain an error. Both the adapter and local execution helpers use this fix.

The failure was reproduced offline before the fix. Tests and subsequent North live runs confirmed successful post-save verification despite two visible links, with one save per deposit and no separate recovery session.

Other North UI facts to preserve: `deposit_id` is the primary key; the result table is `table.table_results`; action headings span four body columns; displayed SELECT text may omit its trailing semicolon; the actual grid editor is an external `input.edit_box` overlay; Enter submits through `tbl_replace.php`. Joined username lookup disables grid editing, so the editable single-table view must stay bound to previously verified subscriber/deposit IDs.

### Last successful live runs and evidence

These are historical results, not fresh live reads at handoff time:

| Latest validation sequence | Verified deposit changes | Completion entries | Result |
| --- | --- | --- | --- |
| One-user North retest after the user manually reset the test data | 2, each 0 → 1 | 1 | Completed, verified logout; selector fix confirmed live. |
| Subsequent four-user North batch | 4, each 0 → 1 | 4 | Completed, one save per deposit, verified logout; no task errors. |

Evidence:

- [One-user retest report](output/2026-10-27T19-08-05-378Z-deposit-north-yogesh-selector-retest/report.json).
- [Four-user batch report](output/2026-10-28T02-49-46-625Z-deposit-north-four-users-approved-apply/report.json).
- [Four-user sheet readback](output/2026-10-28T02-49-46-625Z-deposit-north-four-users-approved-apply/sheet-verification.json).
- The latest sequence recorded five completion entries in North rows 1670–1674, dated **28-Oct-2026**. Output folder timestamps are UTC; the earlier-looking date in the retest folder is consistent with the India execution date.

Earlier trial/reset reports also exist. Do not add their saves to the latest sequence or treat an earlier halted report as evidence that the final completed run is still pending.

### Deposit files and local-only dependencies

- [src/deposit-cli.mjs](src/deposit-cli.mjs): CLI, configuration, locking and reports.
- [src/tasks/deposit-refundability.mjs](src/tasks/deposit-refundability.mjs): business workflow and reviewed sheet-only recovery hook.
- [src/integrations/deposit-sheets.mjs](src/integrations/deposit-sheets.mjs): eligibility, completion checks and Google read transport.
- [src/integrations/phpmyadmin.mjs](src/integrations/phpmyadmin.mjs): lookup, result parsing, shared SELECT controls, demo editor and logout.
- [src/demo/deposit-demo.mjs](src/demo/deposit-demo.mjs): isolated browser and spreadsheet fixtures.
- [tests/deposit.test.mjs](tests/deposit.test.mjs), [tests/deposit-cli.test.mjs](tests/deposit-cli.test.mjs): deposit regressions.
- [docs/deposit-refundability.md](docs/deposit-refundability.md): setup, rules and implementation limits.

Ignored `.state/` contains `retry-yogesh-only.mjs`, `apply-four-users.mjs`, their approved save-scope modules, eligibility snapshots and execution checkpoints. They are historical scoped executors, **not general-purpose commands to rerun**. Earlier recovery/inspection helpers also remain there.

`.state/` and `output/` are excluded from Git. A fresh clone will not contain these helpers, reports, screenshots or sessions. Preserve needed runtime evidence privately through an approved backup process; do not commit browser profiles, credentials or production reports to make the clone work.

### Deposit work still pending

- Company-approved, renewable Google Sheets authentication for the local Node.js application. The organization blocked the earlier Google Developers route; permission was to be requested. The working chat connector does not automatically authenticate the local application.
- Move reviewed production lookup/edit/save/readback logic from scoped helpers into maintained, reusable modules. Retain exact identity binding, request allowlisting, per-row eligibility and single-save behavior.
- Implement authorized standalone completion writes, native date/format preservation and verified duplicate handling. Keep recovery separate so a failed sheet write never causes another database save.
- Complete reviewed live-preview configuration and request allowlists. South needs its own authorized inspection before claiming live readiness there.
- Add meaningful fixture/CLI regressions for the generalized live path before enabling it. Preserve the working ERP behavior.
- Review limits/recovery before larger unattended batches: current default is 20 usernames and 200 deposits per username; partial result pages stop rather than being guessed. The local lock and completion checks are not cross-machine idempotency or a transaction across several records.

These items can be scheduled later. The user's next feature priority is Workforce; do not silently expand deposit scope before that discussion.

## Feature 3 — Workforce access / giving rights

**Status:** next requested feature; not implemented. Proposed task ID: `workforce-access`. Proposed branch: `feature/workforce-access`.

When the user resumes, collect the following before implementing:

- Application URL and intended environment; login/SSO/MFA and logout steps.
- Exact manual navigation, search and user-selection steps, with screenshots or relevant HTML where needed.
- The unique input identifier: username, employee code or other exact key.
- The exact rights/roles to grant, how an authorized request specifies them, and any environment/tenant restrictions.
- Existing-rights behavior: skip already-granted rights; confirm what must be preserved. Do not infer additional rights or remove unrelated access.
- Missing users, duplicate results, inactive accounts, unavailable roles, rejected saves and other known error cases.
- The final Save action and how to verify persistence after reloading/reopening the exact account.
- A suitable test account and allowed test scope, plus expected report/completion requirements.

Recommended incremental implementation after the manual process is understood:

1. Push the local checkpoint when requested, then choose a committed multi-task starting point for the Workforce branch.
2. Add a separate Workforce workflow and application adapter. Reuse the task registry, useful browser/auth utilities, logging, reporting and cleanup patterns; avoid changing unrelated ERP/deposit modules.
3. Start with a visible, read-only lookup/current-rights preview. Add explicitly selected saves only after identity, permission mapping and verification are proven.
4. Require exact identity, one save attempt per intended change, persisted-rights verification, already-granted skips, reports and verified logout.
5. Test failure and ambiguous-match cases locally, then perform a small authorized test run before broader use.

Possible files, **proposals only**: `src/tasks/workforce-access.mjs`, `src/integrations/workforce.mjs`, `src/workforce-cli.mjs`, `config/workforce-access.json`, and task-specific tests/docs. Register only `workforce-access` centrally; do not put Workforce logic into the ERP or deposit workflow.

A future command could use `npm start -- --task workforce-access ...`, but that task ID is not registered today. Exact arguments depend on the manual specification.

## Longer-term backlog

- Zendesk ticket retrieval and approved task dispatch, with the same business modules callable from CLI or another trigger.
- Optional, replaceable AI classification/extraction for complex conversations. It must not invent identifiers or independently authorize sensitive changes.
- Modular Joget workflow actions after verified task completion.
- Lightweight standardized execution history and duplicate-execution controls before unattended/concurrent operation.
- Controlled production expansion per application; no rebuild, microservices or heavyweight infrastructure is currently needed.

None of these integrations has been implemented or authorized for live execution by this document.

## Validation and resumption checklist

Checkpoint validation: **77 tests passed, 0 failed**, and `npm run check` passed. This includes ERP regressions and the post-save SELECT/UPDATE duplicate-control tests. The approved North executions provide the live deposit evidence above. The offline checks were rerun before this commit; no live automation or application changes were performed for the checkpoint.

Additional context: [TEST_RESULTS.md](TEST_RESULTS.md) and [.gsd/JOURNAL.md](.gsd/JOURNAL.md).

- [ ] Read this handoff and inspect `git status` before editing or switching branches.
- [x] Review and commit the feature foundation, tests and this handoff locally on `feature/deposit-refundability`.
- [ ] Push the local checkpoint to GitHub when requested; it has not been pushed by this operation.
- [ ] Preserve the ERP stable tag. Remember that current `main` does not yet contain the local task registry/deposit foundation.
- [ ] Choose the Workforce base: merge the reviewed foundation to `main`, or branch from a committed deposit snapshot if that feature remains in progress. Do not start from the old ERP-only tree expecting the local modules to be present.
- [ ] Gather the Workforce manual process and agree on the first test scope.
- [ ] Keep browser visibility, preview defaults, exact matching, verified saves and logout behavior intact.
- [ ] After future code changes, run appropriate regressions; the existing commands are `npm run check` and `npm test`.
- [ ] Refresh live identity, eligibility and authorization before a new execution. Never use historical reports or this checklist as permission to repeat a production change.

Credentials remain only in the ignored local `.env`: `PROCARE_USERNAME/PASSWORD`, `COREHR_USERNAME/PASSWORD`, `PMA_NORTH_USERNAME/PASSWORD` and `PMA_SOUTH_USERNAME/PASSWORD`. No passwords, Google tokens, cookies or phpMyAdmin session tokens belong in this handoff or Git.

The initial handoff request created only this Markdown file. The subsequent checkpoint request updated this document and committed the existing feature work with a detailed commit message. No workflow code was changed for the checkpoint, no branches were created or merged, and no live application changes were performed.
