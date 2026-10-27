# Current validation: apply without an extra prompt

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
