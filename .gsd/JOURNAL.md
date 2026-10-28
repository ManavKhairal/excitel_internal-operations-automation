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

## 2026-10-28 — Workforce access implementation and approved staging test

The user supplied the Portal/Workforce/Sales/User Groups flow and approved testing the provided account in both tenants, continuing the other tenant if it is missing in one. Work was performed on local `feature/workforce-access`; no commit or push was requested. Independent Workforce credential fields were initialized once in ignored `.env`, with placeholders in `.env.example`.

Read-only staging inspection verified the actual User Groups menu, distinct first groups per tenant, stable group IDs, username search and full-group PUT schema. A schema-inspection PUT was intercepted and aborted before transmission. Runtime request guards permit exactly one requested candidate addition while retaining every existing member and original group property. Navigation remains staging-only.

Live findings and corrections:

- Regional Auth0 client scripts require their reviewed CDN origin. Optional third-party avatars remain blocked without invalidating a task.
- HTTP redirects in the first offline fixture could bypass later route interception. The fixture now uses new document navigations and fulfills all application responses locally.
- A successful North PUT retained the Save footer. The old wait stopped the run without another save. Completion now depends on fresh persisted-group readback, with a regression for a retained footer.
- Available-user search can omit already-assigned users. Existing access is now checked from persisted membership first, with a regression for exclusion from search.

Actual final verification:

```text
npm run check
JavaScript syntax checks passed.
npm test
# tests 96
# pass 96
# fail 0
```

Live preview reconciled North as ALREADY_MEMBER and South as WOULD_GRANT_ACCESS. The final apply skipped North and saved South once, returning COMPLETED with SIGNED_OUT_VERIFIED and CLOSED. Combined write audits prove one dispatched save per tenant and no repeated North save. Existing group members and other properties were protected by the outgoing request guard, and South readback verified preservation explicitly.

Evidence: `output/2026-10-28T04-52-50-986Z-workforce-new.agent1/completion-report.json`, its `report.json`, the North reconciliation preview `output/2026-10-28T04-51-57-278Z-workforce-new.agent1/report.json`, and `.state/workforce-full-test-results.log`. Current code, credential separation, commands and missing-tenant behavior are documented in `docs/workforce-access.md` and `PROJECT_HANDOFF.md`.

## 2026-10-28 — Workforce grant/remove support

The user requested keeping both giving and removing access in the Workforce task. Added explicit `--action grant|remove`, retaining grant as the compatible default. Removal unchecks only the exact persisted member of the selected first Sales group, saves once and verifies absence plus preservation after reload. Already-absent members skip; missing-user continuation remains per tenant. Default-user removal is blocked until a separate reassignment is supplied. Action is recorded in reports, summaries and the one-use outgoing-request scope.

Actual validation:

```text
node --test --test-concurrency=1 tests/workforce.test.mjs
# tests 30
# pass 30
# fail 0
npm run check
JavaScript syntax checks passed.
npm test
# tests 107
# pass 107
# fail 0
```

The live staging command used `--action remove` without `--apply`. Both tenants returned WOULD_REMOVE_ACCESS with before/after membership true, zero Save attempts and zero dispatched writes. Cleanup: SIGNED_OUT_VERIFIED / CLOSED. No live access was revoked. Offline tests exercised actual checked-checkbox removal and PUT guards in both tenants, preservation, preview, missing/absent users, default-user blocking and uncertain save behavior without a repeated PUT.

Evidence: `.state/workforce-removal-test-results.log`, `.state/workforce-grant-remove-full-tests.log`, and `output/2026-10-28T05-04-51-729Z-workforce-new.agent1/report.json`. Documentation and handoff were updated. Changes remain local on the Workforce branch.
