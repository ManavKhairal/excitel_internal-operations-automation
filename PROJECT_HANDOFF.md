# Project handoff — internal operations automation

Last updated: **28 October 2026**, Asia/Kolkata.

This is the resume point for the project. The user asked to leave the working functionality as it is and continue later. Creating this document does not authorize further application changes or implementation work.

## Start here next time

- **ERP employee deactivation works in staging**, including Inactive/Terminated partner support, automatic employee pagination, verified deactivation and logout.
- **Deposit refundability has completed approved North production runs**, including multiple usernames, verified saves, logout and completion-sheet entries. The duplicate Edit inline problem is fixed and verified live.
- **Important distinction:** live deposit runs used scoped local execution helpers plus the connected Google Sheets tools. The ordinary deposit CLI still supports offline demonstrations and blocks general production writes. A fully standalone production deposit runner is pending.
- **Workforce access is now implemented on `feature/workforce-access` for staging.** The task supports granting or removing exact membership in the first Sales User Group in North, South or both tenants, using `--action grant|remove`. Grant remains the default; removal is explicit. Missing users in one tenant do not prevent processing the other. See [the Workforce guide](docs/workforce-access.md) and current validation below.
- **The deposit foundation checkpoint `db3d5ff` has been pushed to `origin/feature/deposit-refundability`.** Workforce was branched from that saved foundation; Workforce is now saved in the local checkpoint containing this handoff, titled `Add staging Workforce access grant and removal automation`. Its GitHub push remains pending.
- No previously requested user update remains unfinished. Historical report usernames and local helper scripts are not a new execution queue.

## Repository and branches

Repository: [excitel_internal-operations-automation](https://github.com/ManavKhairal/excitel_internal-operations-automation).

Local folder: `/home/manav/Downloads/corehr-staging-automation`. The folder and package retain their original CoreHR name; the intended product is one modular project for several support operations.

| Branch / reference | State at this handoff | Purpose / next action |
| --- | --- | --- |
| `main` | Commit `984ef2f`; stable ERP baseline | Preserve as the known working ERP version. |
| `feature/deposit-refundability` | Commit `db3d5ff`, pushed to its origin branch | Saved multi-task/deposit foundation; preserve it while developing Workforce. |
| `feature/workforce-access` | Current branch; local checkpoint containing this handoff, based on `db3d5ff` | Staging grant/remove automation, documentation and 107 passing regressions saved locally. GitHub push pending. |
| `erp-deactivation-stable-2026-10-27` | Existing tag at `984ef2f` | Recovery point for the ERP automation before the local multi-task expansion. |
| `v1.0.0` | Existing tag at `aadaf06` | Earlier initial backup. |

There is no separate ERP feature branch in the current branch list: its stable implementation is on `main` and the ERP recovery tag.

The locally recorded `origin/main` remains at the stable ERP baseline `984ef2f`. The deposit checkpoint was pushed and its remote hash verified as `db3d5ff`. The Workforce branch was created from that checkpoint and committed locally at the user's request. No Workforce merge or push was performed by this checkpoint.

The pushed checkpoint includes the dispatcher, preserved ERP CLI, deposit modules, fixtures, tests and handoff. The Workforce implementation is saved in its separate local feature commit. Credentials, sessions and production reports remain excluded from Git. Inspect `git status` before switching branches.

## Project foundation

- Node.js **22+**, JavaScript ES modules and Playwright; no new runtime dependencies were added for the deposit foundation.
- [src/cli.mjs](src/cli.mjs) dispatches through [src/task-registry.mjs](src/task-registry.mjs).
- Registered task IDs: `erp-deactivation`, `deposit-refundability` and `workforce-access`. ERP remains the default when `--task` is omitted.
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

**Status:** grant/remove support implemented on the local `feature/workforce-access` branch. Granting has live staging verification; removal Save behavior has offline browser/request-guard coverage and the new action passed a read-only staging preview. No live access was revoked for this addition. The user supplied the manual steps and authorized grant testing `new.agent1` in **both tenants**; that membership remains verified in both. If absent in one, continue the other and report the missing tenant at the end. No production Workforce work is authorized.

The workflow signs in through staging Portal, chooses Workforce, selects the explicit tenant, opens Sales → User Groups, and selects the first group by position. It binds that group's actual name and stable ID before opening the Users field. The user-supplied CAF Counters HTML was inconsistent with the requested menu; live inspection confirmed a separate `user-groups-menu` and the implementation uses that.

Persisted group membership is checked first because the available-user search can exclude already-assigned users. New candidates are checked in both the completed tenant lookup and the scoped Users dropdown. `--action grant` skips existing members; `--action remove` skips already-absent membership. Missing users are reported per tenant. Explicit `--apply` checks or unchecks only the requested user and saves once. The outgoing group update must preserve every other member, group name, default user and other properties, and add or remove only the requested member. The group default user cannot be removed without a separate reassignment. Reload/readback verifies persistence and preservation; a visible Save footer does not prove the save failed. An uncertain save stops further writes without retrying. Logout is verified for Workforce and Portal before closing the browser.

Separate `WORKFORCE_USERNAME` and `WORKFORCE_PASSWORD` fields were added to `.env` and initialized once from Procare as requested. Future password changes are independent; no fallback to Procare is used at runtime. Only placeholders belong in `.env.example`.

Commands:

```bash
# Read-only staging preview
npm start -- --task workforce-access --username new.agent1 --tenant both

# Explicitly approved staging save and verification
npm start -- --task workforce-access --username USERNAME --tenant both --action grant --apply

# Preview removal; add --apply only for an approved membership removal
npm start -- --task workforce-access --username USERNAME --tenant both --action remove
```

The required tenant option accepts north, south or both, with Delhi/DEL and Hyderabad/HYD aliases. The browser is visible by default. Staging origins are reviewed and validated; a production rollout requires a separate change and tests.

Files:

- [src/workforce-cli.mjs](src/workforce-cli.mjs): inputs, independent credentials, lock and reports.
- [src/tasks/workforce-access.mjs](src/tasks/workforce-access.mjs): reusable tenant/user workflow.
- [src/integrations/workforce.mjs](src/integrations/workforce.mjs): UI navigation, membership identity, payload guard, persistence verification and logout.
- [config/workforce-access.json](config/workforce-access.json): staging URLs and browser settings.
- [tests/workforce.test.mjs](tests/workforce.test.mjs) and [tests/workforce-fixture.mjs](tests/workforce-fixture.mjs): isolated UI, request-scope, missing-user, uncertain-save and CLI tests.
- [docs/workforce-access.md](docs/workforce-access.md): complete commands, scope and report outcomes.

Current task scope is granting/removing membership in the first Sales User Group, selected by `--action grant|remove`. Removing membership is not account deactivation or a blanket removal of access from other groups. Additional roles, different group selection, production URLs and email/Zendesk approval retrieval need their own supplied requirements. Follow the latest validation record before relying on this development branch.

Live evidence: [Workforce completion report](output/2026-10-28T04-52-50-986Z-workforce-new.agent1/completion-report.json) and [final CLI report](output/2026-10-28T04-52-50-986Z-workforce-new.agent1/report.json). The first North save succeeded but the earlier footer-visibility wait timed out. A fresh read reconciled it; North was skipped on the final run while South was added and verified. Both UI behaviors now have regressions. No North save was replayed.

Removal evidence: [read-only staging removal preview](output/2026-10-28T05-04-51-729Z-workforce-new.agent1/report.json), both tenants `WOULD_REMOVE_ACCESS`, zero Save attempts/dispatched writes, membership unchanged and logout verified. A future actual removal test needs a specified approved target; do not treat the earlier grant test account as a standing revocation instruction.

Next steps after the staging demonstration:

- Review the run reports and demonstration with the user.
- Push the Workforce checkpoint when requested; the deposit branch remains its saved parent. The local feature commit is complete.
- Obtain separate authorization and reviewed URLs before any production rollout.
- Continue the pending standalone deposit/Google authentication work separately when prioritized.

## Longer-term backlog

- Zendesk ticket retrieval and approved task dispatch, with the same business modules callable from CLI or another trigger.
- Optional, replaceable AI classification/extraction for complex conversations. It must not invent identifiers or independently authorize sensitive changes.
- Modular Joget workflow actions after verified task completion.
- Lightweight standardized execution history and duplicate-execution controls before unattended/concurrent operation.
- Controlled production expansion per application; no rebuild, microservices or heavyweight infrastructure is currently needed.

None of these integrations has been implemented or authorized for live execution by this document.

## Validation and resumption checklist

Latest validation: **107 tests passed, 0 failed**, and `npm run check` passed. This includes the earlier 77 ERP/deposit regressions and 30 Workforce tests covering grant and removal. The approved deposit/grant executions and read-only removal preview provide separate live evidence above. The saved deposit checkpoint originally passed 77 tests; current Workforce development adds the remaining coverage.

Additional context: [TEST_RESULTS.md](TEST_RESULTS.md) and [.gsd/JOURNAL.md](.gsd/JOURNAL.md).

- [ ] Read this handoff and inspect `git status` before editing or switching branches.
- [x] Review and commit the feature foundation, tests and this handoff locally on `feature/deposit-refundability`.
- [x] Push the deposit checkpoint `db3d5ff` to GitHub and verify the remote branch.
- [x] Create `feature/workforce-access` from that saved checkpoint.
- [x] Commit the Workforce grant/remove feature, documentation and regressions locally.
- [ ] Push the Workforce checkpoint to GitHub when requested.
- [ ] Preserve the ERP stable tag. Remember that current `main` does not yet contain the local task registry/deposit foundation.
- [x] Use the committed deposit foundation as the Workforce base; `main` remains the older ERP baseline.
- [x] Gather Workforce steps; test scope agreed as `new.agent1` in both staging tenants, continuing if absent in one.
- [ ] Keep browser visibility, preview defaults, exact matching, verified saves and logout behavior intact.
- [ ] After future code changes, run appropriate regressions; the existing commands are `npm run check` and `npm test`.
- [ ] Refresh live identity, eligibility and authorization before a new execution. Never use historical reports or this checklist as permission to repeat a production change.

Credentials remain only in the ignored local `.env`: `PROCARE_USERNAME/PASSWORD`, `COREHR_USERNAME/PASSWORD`, `PMA_NORTH_USERNAME/PASSWORD` and `PMA_SOUTH_USERNAME/PASSWORD`, and `WORKFORCE_USERNAME/PASSWORD`. No passwords, Google tokens, cookies or phpMyAdmin session tokens belong in this handoff or Git.

The initial handoff created only this document. The later deposit checkpoint was committed and pushed; Workforce was then branched from it and implemented in response to the supplied steps. The Workforce grant/remove changes are now committed locally; their GitHub push remains pending. Runtime evidence and credentials stay local; do not rerun historical apply targets without fresh authorization.
