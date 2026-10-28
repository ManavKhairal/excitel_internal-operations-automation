# Current validation: Workforce grant and remove actions (2026-10-28)

`npm run check` passed. The full `npm test` suite passed **107 tests, 0 failures**, comprising the original 77 ERP/deposit regressions and 30 Workforce tests. Existing grant commands remain compatible; `--action grant` is the default and removal requires explicit `--action remove`. Both actions remain preview-only unless `--apply` is supplied.

Offline browser tests verify removal in both tenants, exact-member selection from the unfiltered selected-members dropdown, preservation of other members/settings, unchanged membership in preview, already-absent skips, unavailable-user continuation in either tenant, default-user protection and uncertain saves without replay. Request interception rejects extra removals/additions, member edits, wrong action/tenant and unrelated group-property changes. Reports and write audits include the selected action.

The [live staging removal preview](output/2026-10-28T05-04-51-729Z-workforce-new.agent1/report.json) completed with `WOULD_REMOVE_ACCESS` in both tenants, **0 Save attempts / 0 dispatched writes**, unchanged before/after membership and verified logout. Removal Save behavior was tested offline; **no live access was revoked** for this feature addition. Earlier grant live evidence remains below.

# Previous validation: Workforce staging access (2026-10-28)

`npm run check` passed; the full `npm test` suite passed **96 tests, 0 failures**: the existing 77 regressions plus 19 Workforce tests. New coverage includes both tenants, distinct first-group identities, exact usernames versus prefix matches, missing-user continuation in either tenant, existing membership, preservation of other members/properties, blocked out-of-scope PUTs, uncertain saves without replay, tenant/environment guards, regional login assets, logout and CLI dispatch.

Live staging Portal → Workforce → tenant → Sales → User Groups navigation was inspected. The correct menu is `user-groups-menu`, distinct from the supplied CAF Counters HTML. Separate Workforce credentials were initialized locally from Procare once; the runtime uses its own fields and the browser remains visible.

The approved `new.agent1` test completed for North and South: **one membership PUT per tenant**, persisted membership verified, existing group properties/members preserved by the request guard, and Portal/Workforce logout verified. The [consolidated completion report](output/2026-10-28T04-52-50-986Z-workforce-new.agent1/completion-report.json) links the original North save, fresh verification and final South save. The [final CLI report](output/2026-10-28T04-52-50-986Z-workforce-new.agent1/report.json) records North `ALREADY_MEMBER`, South `ACCESS_GRANTED_VERIFIED`, status `COMPLETED`, no blocked functional requests and verified logout.

Two live UI assumptions were corrected with regressions: the Save footer can remain visible after a successful PUT, and the available-user search may exclude users already assigned to the group. Completion now uses fresh persisted-group readback; existing members are detected from that group before searching available candidates. The first North save was reconciled from a fresh read and never repeated. Login resources also require the reviewed regional Auth0 CDN; optional external avatars remain blocked without failing the task.

Workforce changes are saved in a local checkpoint on `feature/workforce-access`; GitHub push remains pending. ERP and deposit application workflows were not edited or executed during Workforce validation. Production Workforce URLs remain blocked by configuration/origin validation.

# Previous validation: approved North post-save retest (2026-10-28)

After the user manually reset the two approved deposits and removed the completion entry, a fresh North-only run confirmed exact source-sheet membership, no South membership, no existing completion entry, and refundable=0 on both deposits. The visible browser saved each deposit once, verified both persisted values as 1, verified the final complete record set, logged out and required login again. Report status: **COMPLETED**, **2 save attempts / 2 save dispatches / 2 verified deposits**.

The previous failure condition occurred after both saves: two visible Edit inline links, with SELECT and UPDATE statements inside the same result_query. The shared selector chose SELECT each time, and the subsequent verification completed in that same browser session. No separate recovery session or repeated save was required. This confirms the selector fix against the live North UI for the approved one-user scope.

After verified logout, the connected Google Sheets tools recorded exactly one completion entry, then re-read its username, YES value, native date and neighboring cells. Completion uniqueness: **1 match**; sheet writes: **1**. The [private execution report](output/2026-10-27T19-08-05-378Z-deposit-north-yogesh-selector-retest/report.json) contains per-save control observations, readback evidence, logout and sheet confirmation. This scoped execution does not enable general production CLI writes.

# Previous validation: phpMyAdmin post-save query controls (2026-10-28)

The duplicate “Edit inline” failure was reproduced offline before the fix: after one grid save, lookup stopped with `AMBIGUOUS_CONTROL` and `Edit inline SQL: 2 visible matches`. The fixture now mirrors phpMyAdmin's grid code: an UPDATE `.sqlOuter` and `.tools` pair is appended inside the same `.result_query` as the original SELECT.

The shared selector now binds the visible SELECT block to its immediately following tools. It is used by the reusable adapter and local inspection/apply helpers. The lookup's freshness check and result-status read are scoped to that SELECT result. Multiple visible SELECT blocks remain an error; no first-match fallback or save retry was added.

After the fix, both targeted regressions passed. The two-deposit case confirms one save per deposit, both post-save lookups, five SELECT-only query-editor openings, one logout and one verified completion entry. The ambiguity case confirms zero edits, saves or completion appends. Existing non-persistence, uncertain-save, production-write rejection and ERP regressions also pass.

`npm run check` passed. Full `npm test` output: **77 tests, 77 passed, 0 failed**. The local inspection/apply helpers also passed `node --check`. All validation for this fix was offline; no production database or Google Sheets changes were performed, and general production CLI writes remain disabled.

# Previous validation: North read-only inspection (2026-10-27)

An authorized live inspection checked exact username membership in the two source tabs through the connected Google account, authenticated to North phpMyAdmin, read schema metadata and the selected deposits, and verified logout. The [private preview report](output/2026-10-27T18-11-11-080Z-deposit-north-readonly-inspection/report.json) records two eligible deposit rows, zero save attempts, and zero sheet writes. No data editors were opened.

North schema metadata confirms `deposit_id` is the non-null bigint primary key. The joined lookup returns exact username identity but disables grid editing in phpMyAdmin 4.4.15.10. A single-table SELECT restricted to those exact deposit IDs and subscriber ID exposes grid controls; production editing must account for this before future enablement. Automatic Google authorization and the inline editor/save behavior remain unverified. South was not accessed, and live operations remain disabled in configuration.

The inspection also exposed two DOM differences: query display omits the final semicolon, and action headings span four body columns. Both are handled in the parser/editor mapping and covered by added offline regressions. `npm run check` and the full `npm test` suite passed: **75 passed, 0 failed**. Earlier inspection attempts encountered asynchronous loading/server notices; the final lookup and view inspection completed with verified logout. Browser traffic was limited to authentication, read pages, and allowlisted SELECT statements.

# Previous validation: deposit task foundation and task selection (2026-10-27)

`npm run check` and the full `npm test` suite passed: **73 passed, 0 failed**. Tests execute offline; no production database or live Google Sheets changes were made.

The original ERP command is preserved in `src/erp-cli.mjs` and selected by default through a static registry. Both legacy invocation and explicit `--task erp-deactivation` pass the CLI tests. The existing preview, apply, pagination, partner eligibility, and logout regressions continue to pass.

The deposit workflow has 22 business/adapter tests and four CLI tests. Coverage includes: exact sheet membership; missing/conflicting tenants and sheet-read failures before database access; mixed deposit eligibility; all-already-refundable records; multiple usernames and tenant-session reuse; exact record identity and generated SELECT queries; fresh-query verification; unpersisted and uncertain saves without another Enter; partial result pages; changed flags; partial completion; logout failure; independent sheet recording; duplicate prevention; and lost append-response recovery without another database write. CLI tests verify reports, lock release, demo preview/apply, and rejection of production preview/apply before external access.

The final two-tenant offline demonstration completed with two verified simulated updates, two skipped covered/bundled rows, one already-refundable row, one logout per tenant, and two verified in-memory sheet entries. Evidence: [demo report](output/2026-10-27T17-20-45-996Z-deposit-demo-demo.north/report.json). The final report and demo state are private ignored runtime files.

Production preview remains disabled pending standalone Google authorization and verified phpMyAdmin primary-key/editor/results/pagination details. Database editing and Google appends are independently blocked in live adapters. Fixture selectors and row keys are not presented as verified production selectors. Setup and current limitations are documented in [deposit task guide](docs/deposit-refundability.md).

# Previous validation: Inactive partner support (2026-10-27)

`npm run check` and `npm test` passed: **46 passed, 0 failed**.

The Procare partner status check now accepts Terminated and Inactive, case-insensitively with whitespace normalization, for both preview and apply. Active partners remain blocked with `PARTNER_ACTIVE`; other disallowed statuses use `PARTNER_STATUS_NOT_ALLOWED`. The latest Partner 4 failure had reported Inactive, which the previous Terminated-only rule rejected.

The offline Procare fixture now includes the seven-column partner search result and its status. Five added regressions exercise Terminated, Inactive, mixed-case/whitespace Inactive, Active, and Suspended; rejected statuses stop before opening the partner. Existing employee processing and logout tests pass. No live employee changes or new live automation runs were performed for this update.

# Previous validation: automatic logout (2026-10-27)

`npm run check` and `npm test` passed: **41 passed, 0 failed**.

Live UI inspection confirmed Procare's `.profile.cpointer` menu and `.profile .dropdown a:has(i.fa-sign-out)` logout action, and CoreHR's `[data-id="avatar"]` menu and `[data-id="logout"]` action. Both menus open with a click. No generated CSS classes are used.

The implemented `session.logout()` passed live staging checks for both apps: `SIGNED_OUT_VERIFIED` for Procare at 12:06:14 UTC and CoreHR at 12:06:26 UTC. Each returned to the approved Auth0 login form, then required login again after navigating back to its application root. These checks only signed in, opened account menus, and signed out; no live employee was edited or saved. Full live employee processing was not rerun for this change.

Offline regressions cover both UI menus, already-signed-out sessions, ambiguous logout controls, failed logout, automatic session restoration, and rejecting a login form on an unapproved origin. CLI coverage verifies logout happens after the task report is saved, both browsers close even if one logout fails, employee results remain unchanged by cleanup failures, collection errors still produce `logout.json`, and login-only preserves prepared sessions. Existing preview/apply tests still verify zero Saves in preview and exactly one Save in apply.

The following sections preserve previous validation records.

# Previous validation: apply without an extra prompt

`npm run check`, `npm test` (**31 passed, 0 failed**), and CLI help validation passed.

`--apply` now authorizes staging status saves directly. The DEACTIVATE phrase prompt and unconditional terminal requirement were removed. Default runs still perform no status edits or Saves. Manual login/MFA and explicitly selected guided pagination can still require terminal interaction.

Two integration tests execute the actual CLI, Procare collector, CoreHR processor, and report writer in a temporary project, replacing only login/browser creation with offline DOM fixtures. Both run without terminal input: default preview produces DRY_RUN_ACTIVE with zero Saves; --apply produces DEACTIVATED_VERIFIED with exactly one Save and persisted Inactive status. No live employee was modified during these tests.

The user’s latest completed staging apply report was reviewed: [successful report](output/2026-10-27T06-36-30-053Z-Test_Delhi_ERP/report.json). It records COMPLETED, del.erpemployee Active → Inactive, DEACTIVATED_VERIFIED, and one Save followed by reload/reopen verification. The earlier 06-36-07 run halted before processing; the subsequent 06-36-30 run succeeded. No new live apply run was needed for this prompt change.

The following sections preserve previous validation records and their then-current confirmation behavior.

# Previous validation: automatic employee collection

`npm run check`, `npm test` (**29 passed, 0 failed**), and CLI help validation passed.

Automatic pagination is now the default. The Procare selectors and numbered-page behavior were verified against the staging UI and its public table service. The Next arrow stays enabled on the final page, so completion uses the active page number and the verified sliding number window. Automatic collection does not ask for NEXT, DONE, or COLLECT. Explicit apply confirmation remains required.

Regression coverage includes a one-page list with an enabled Next arrow, multiple pages with deduplication, a sliding page window, delayed row loading, missing/ambiguous controls, disabled Next before the final page, unchanged results after Next, starting after page one, a partner route change during settling, and explicitly requested guided mode.

Live collection succeeded without any collection callback for **Test Delhi ERP**, partner **5608**: one page, one username (`del.erpemployee`), completeness `pagination-verified`. Evidence: [employee manifest](output/2026-10-27T06-19-24-805Z-automatic-collection-verification/employees.json). This was collection only; no employee status was edited or saved. Live multiple-page collection was not exercised; that behavior is covered by offline fixtures.

The following sections preserve previous validation records.

# Previous validation: search submission fix

`npm run check` passed. `npm test` passed all **19 tests**, including two new regressions:

- A dropped initial Enter submission is retried and the exact employee is found.
- A search that never commits stops as `SEARCH_NOT_SUBMITTED` without opening or saving an employee, even when the unfiltered table contains an exact username.

Both failure modes were reproduced against the previous implementation. The new check waits for the configured `filter` URL parameter before matching results. It retries the read-only search once; employee status Saves are never retried.

Live verification of the patched CoreHR lookup completed successfully for `del.erpemployee`: `DRY_RUN_ACTIVE`, status Active, `saveAttempted: false`. Report: [verification report](output/2026-10-27T06-12-15-726Z-CoreHR-verification/report.json). This reused the previous report’s username; Procare collection and live apply were not repeated. One verification attempt timed out during login; a subsequent attempt waited for the saved session sidebar and succeeded.

The original screenshot shows an unfiltered table despite a populated search input, and its URL has no search query. The exact cause of that intermittent submission failure is not proven; subsequent live lookups succeeded even before this fix. The earlier validation record below describes the original fixture-only run.

# Validation record

Result: **17 tests passed; 0 failed**.

Environment: Node.js 22.16.0, Playwright 1.57.0, system Chromium. The container cannot fetch npm dependencies, so local tests used its existing Playwright runtime. The distributable uses the normal npm dependency declared in package.json and does not bundle the container runtime.

## Scope

The tests are offline DOM fixtures plus unit tests. Browser pages simulate the supplied CoreHR attributes and a representative Procare table, rather than reproducing unprovided application code. No company hostname is navigated to during the successful test suite; no live account or employee was changed. The staging URL guard is tested separately with mocked URL values. Authentication, real backend isolation and real Procare selectors/pagination still need on-machine staging validation.

## Passed scenarios

1. Dry run matches the exact username, not a prefix, and performs no Save.
2. Apply performs one Save, reopens the exact employee and verifies persisted Inactive.
3. Already-inactive employee is skipped without Save.
4. Native status select is supported alongside the custom option fixture.
5. Missing exact username does not change another employee.
6. Duplicate exact matches are skipped, never resolved by taking the first row.
7. Wrong detail identity halts before Save.
8. Unexpected status is left unchanged.
9. An optimistic UI change without persistence is reported as SAVE_UNVERIFIED; Save is not retried.
10. Procare configured pagination collects all pages and deduplicates usernames.
11. Missing Username column prevents collection.
12. Explicit custom row/username selectors support non-table layouts.
13. Production, lookalike and insecure frontend origins are rejected.
14. Username regular-expression matching is escaped, exact and case sensitive.
15. Username validation and CSV formula escaping work.
16. The local exclusive lock prevents a second project run.
17. Reports include already-inactive and unprocessed users as well as successful changes.

Use `npm test` after installing Playwright and its browser on your machine. Use an initial dry run and a small known staging partner before any apply run.
