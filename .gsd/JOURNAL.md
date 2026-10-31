# Debugging journal

## 2026-10-28 — phpMyAdmin post-save query controls

Request: fix the duplicate Edit inline control that interrupted verification after an approved refundable update.

Cause: phpMyAdmin's grid-save handler appends UPDATE SQL and its tools to the existing SELECT result_query container. Selecting the whole container still returns both Edit inline links. Cached application source evidence: `.state/pma-makegrid-source.js`, lines 1310–1327.

Change: `selectQueryControls()` binds the SELECT sqlOuter block to its immediate tools sibling, with uniqueness checks. The reusable adapter and ignored local execution helpers share it. Result-status and freshness reads in the adapter use that SELECT result. Production write gates and one-Enter behavior are unchanged.

Before-fix reproduction:

```text
node --test --test-name-pattern='post-save UPDATE' tests/deposit.test.mjs
not ok 1 - post-save UPDATE tools beside SELECT tools do not interrupt verification or repeat a save
AMBIGUOUS_CONTROL: Edit inline SQL: 2 visible matches.
# tests 1
# pass 0
# fail 1
```

After-fix targeted evidence:

```text
node --test --test-name-pattern='post-save UPDATE|multiple SELECT' tests/deposit.test.mjs
ok 1 - post-save UPDATE tools beside SELECT tools do not interrupt verification or repeat a save
ok 2 - multiple SELECT query blocks remain ambiguous and stop before a deposit save
# tests 2
# pass 2
# fail 0
```

The passing workflow asserts exactly two saves for two eligible deposits, five SELECT-only editor openings, one logout and one completion entry. The ambiguous-SELECT case asserts zero edits, saves and completion entries.

Full validation:

```text
npm run check
JavaScript syntax checks passed.
npm test
# tests 77
# pass 77
# fail 0
# cancelled 0
# skipped 0
```

Full test output: `.state/deposit-selector-test-results.log`. All four ignored local helpers passed `node --check`. All tests for the code fix were offline; that fix turn performed no production database or sheet writes. The later approved live retest is recorded below.

## 2026-10-28 — approved live retest after manual reset

The user explicitly requested retry after resetting the approved user's refundable values and removing the sheet entry. Fresh source-sheet checks and database SELECTs established the reset baseline. The run used the visible browser and the same shared selector verified above.

Actual execution evidence:

```text
status: COMPLETED
depositRecords: 2
saveAttempts: 2
saveDispatches: 2
recordsVerified: 2
sheetWrites: 1
logout: SIGNED_OUT_VERIFIED
browser: CLOSED
```

For each save, the report recorded `visibleEditLinks: 2`, `statementTypes: [SELECT, UPDATE]` and `selectedStatement: SELECT`. Both persisted values were verified as 1 in the original browser session; no recovery session or repeated Enter was needed. After logout, the completion entry was written once and read back with one exact username match and a native date. Neighboring values were preserved.

Evidence: `output/2026-10-27T19-08-05-378Z-deposit-north-yogesh-selector-retest/report.json` and `sheet-verification.json` in that directory. Scope remained the single approved North username and its two pre-approved deposit IDs; this run did not enable general production CLI writes.

## 2026-10-28 — approved four-user execution

The user explicitly requested four additional usernames. Fresh exact-username searches established North-only membership for each. A scoped save allowlist bound each previously inspected deposit ID to its username and subscriber; local checks rejected the previous user's deposit IDs, unarmed saves, refundable=0, extra fields and the South origin.

One visible North browser session processed the four users. Each eligible record was freshly checked, saved once and verified through the exact username join and final complete deposit readback. The corrected SELECT control handled the post-save UPDATE tools for every save.

Actual final report validation:

```text
status: COMPLETED
usernames: 4
depositRecords: 4
saveAttempts: 4
saveDispatches: 4
recordsVerified: 4
skippedRecords: 0
sheetWrites: 4
sheetBatchCalls: 1
logout: SIGNED_OUT_VERIFIED
browser: CLOSED
lock: RELEASED
```

After verified logout, four completion rows were written to North Changes reverted A1671:C1674. Each exact username appeared once on readback; YES values and native dates were verified, and neighboring values were preserved. No task errors were recorded. Evidence: `output/2026-10-28T02-49-46-625Z-deposit-north-four-users-approved-apply/report.json` and `sheet-verification.json` in that directory. General production CLI write gates remain unchanged.

## 2026-10-31 — centralized local automation dashboard

Implemented a buildless local UI, authenticated Node API, fixed worker IPC, shared CLI/web orchestration, preview-bound approval, actual event/report monitoring, history import, safe downloads and settings. Preserved the 92-test baseline and pre-existing deposit refinements. No company applications were accessed or changed during this implementation.

Actual final verification:

```text
npm run check
JavaScript syntax checks passed.
npm test
# tests 113
# pass 113
# fail 0
# cancelled 0
# skipped 0
# duration_ms 97894.261312
TEST_EXIT_CODE=0
```

Backend tests include real offline deposit preview/apply in both directions. Three actual Chromium UI tests cover full navigation, preview/confirmation/apply, operator prompts, failures, downloads, settings and responsive layouts, including a real synthetic deposit worker launched from the UI. No unexpected browser errors or failed requests remained. Screenshots and full output are in `output/web-test-evidence/`; detailed evidence and resolved failures are recorded in `TEST_RESULTS.md`.

The real startup command `npm run web` listened at `127.0.0.1:4310`. Public static assets returned 200; unauthenticated `/api/tasks` returned 401. No live automation was launched. Live staging login/MFA and account permissions remain operator-side verification, and deposit live access stays disabled.

Final screenshot review also caught a deposit cleanup display gap: per-record verified logout existed in the report but was not shown in the cleanup card. The API now projects those actual outcomes; API and UI assertions cover it. Subsequent `npm run check` passed; `npm run test:web` reported 21 passed, 0 failed, duration 16782.818725 ms and WEB_TEST_EXIT_CODE=0. Final focused output: `output/web-test-evidence/web-test-results.log`. The token command, real local sign-in, module discovery and logout also passed without exposing secret values. The local server was gracefully restarted with the final implementation.
