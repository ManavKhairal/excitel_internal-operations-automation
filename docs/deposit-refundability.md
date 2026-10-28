# Deposit refundability task

This module is implemented for local development and offline testing on `feature/deposit-refundability`. The existing ERP task is selected by default. Production deposit and Google Sheets writes are disabled in code. Production preview is disabled in configuration until the remaining UI and schema details are inspected.

## Run the offline demonstration

Task runs open a visible browser by default: `"headless": false` in `config/deposit-refundability.json`. This applies to the demo and future configured live previews. Automated fixture tests explicitly use headless mode. The existing ERP command already opens a visible browser.

Preview the synthetic North user:

```bash
npm start -- --task deposit-refundability --demo --username demo.north
```

Simulate the complete change, verification, logout, and sheet entry:

```bash
npm start -- --task deposit-refundability --demo --username demo.north --apply
```

Process synthetic North and South users in the same run:

```bash
npm start -- --task deposit-refundability --demo --username demo.north --username demo.south --apply
```

The demo uses `https://deposit-fixture.invalid`, intercepted entirely inside Playwright, and an in-memory spreadsheet. No Google or company requests are made. Every run starts with fresh synthetic data. `demo.north` has four deposit rows: one eligible, one covered, one bundled, and one already refundable. `demo.south` has one eligible row. A real username passed to the demo is not looked up in company systems.

## Business rules

1. Read only `North Tenant` and `South Tenant` for eligibility. Locate the Username/User ID column by its header; support a header below the first row. Read that column in bounded chunks. Preserve username case and leading zeroes.
2. An exact username absent from both sheets is `USER_NOT_LISTED`. A username in both is `AMBIGUOUS_TENANT`. An explicitly supplied tenant must match its sheet. Failed sheet access blocks database access; it is never treated as an empty sheet.
3. North/Delhi/DEL maps to the Delhi host; South/Hyderabad/HYD maps to the Hyderabad host. Both source sheets are checked to detect conflicting membership. Inputs are deduplicated; a run accepts up to 20 usernames.
4. Look up deposits with a fixed SELECT joining `subscriber_deposit` to `subscriber`. Include `s.username AS automation_username` so each result remains tied to the exact requested username. SQL uses an encoded literal and binary username comparison. Arbitrary SQL is not an input option.
5. Every row needs a reviewed unique deposit key, subscriber ID, exact username, and 0/1 flag values. Duplicate keys, multiple subscriber IDs for one username, unknown flags, missing records, or incomplete result pages stop processing that username before changes.
6. Skip each row where `is_covered = 1` or `is_bundled = 1`. Continue with its other eligible rows. Skip eligible rows already at `refundable = 1`, reporting `ALREADY_REFUNDABLE`.
7. In apply simulation, re-read each eligible record before editing. Double-click its refundable cell, fill `1`, persist a checkpoint, then press Enter exactly once. Re-query and require the same deposit key, subscriber ID, username and eligible flags, with persisted refundable `1`. An optimistic UI value alone does not pass verification.
8. Reuse one session per tenant. After database processing, log out once from each opened tenant, verify that reopening requires login, and close the browsers.
9. Only then record users whose changed rows were fully verified. North uses `North Changes reverted`; South uses `South Changes reverted`. Values are Username, `YES`, and the completion date in Asia/Kolkata (`YYYY-MM-DD`). All-already-refundable or all-ineligible users get a report but no new sheet entry.
10. Completion recording checks for an existing exact Username/YES/Date entry and reads back a new entry. A duplicate for the same day is not appended. Historical entries on other dates are preserved. The current completion adapter requires reviewed A/B/C column order; it stops if layout differs.

The requested database value is **1**, as clarified in the supplied manual steps. Earlier discussion of setting 0 is superseded.

## Reports and failure handling

Each run creates `output/<timestamp>-deposit-demo-<username>/`:

- `report.json`: task/execution ID, mode, environment, times, per-user status, per-deposit outcomes, flags, before/after values, save attempts, verification times, logout results and sheet recording status.
- `report.csv`: one row per deposit, including skipped/already-refundable rows. A blocked username without deposits still has a row.
- `demo-state.json`: synthetic final records, completion tabs and event sequence for review.
- `error.json`: startup or other errors outside the workflow, when an output directory was created.

`PREVIEW_COMPLETED` explicitly means no deposit change was requested. `REFUNDABLE_VERIFIED` means the simulated change was re-read successfully. `SAVE_STARTED_UNVERIFIED` is persisted before Enter. An uncertain save becomes `SAVE_UNVERIFIED`; the batch stops and does not repeat the write.

If some rows changed and another failed, the report retains those individual outcomes and withholds the user's completion entry (`BLOCKED_PARTIAL_RESULT`). Previously completed users can still be recorded after verified logout. Logout or browser-close failures preserve verified deposit results but defer sheet recording.

A sheet failure is separate from database verification. `recordCompletion()` supports a reviewed sheet-only recovery using the saved user result; it never opens a database or retries Enter. A lost append response is resolved by rereading existing entries before another append. There is no automatic production recovery command in this phase.

Exit codes: 0 for a completed preview/demo; 2 for workflow exceptions; 1 for invalid input, disabled live operations or startup failures. The existing project lock prevents concurrent CLI runs. File-based duplicate checks do not coordinate multiple independent machines.

## Verification after a grid save

phpMyAdmin 4.4 appends the saved UPDATE statement and its tools inside the same `.result_query` container as the original SELECT. The shared `selectQueryControls()` helper selects the visible SELECT `.sqlOuter` block and only its immediately following `.tools` controls. Both the reusable adapter and local inspection/apply helpers use this selector. Multiple visible SELECT blocks still stop the run; the code never guesses by taking the first link.

The offline browser fixture reproduces this post-save markup. The regression verifies two eligible deposits, one Enter per deposit, successful readback after each save, one logout and one completion entry. Existing non-persistence and uncertain-save tests still prevent repeated writes.

## Next: configure authorized production preview

The initial module was built and tested offline. A subsequent authorized North inspection checked source membership through the connected Google account, read the live schema and selected deposit records, and verified logout. Its [private preview report](../output/2026-10-27T18-11-11-080Z-deposit-north-readonly-inspection/report.json) records zero saves and zero sheet writes. Standalone Google authentication remains pending.

The North inspection confirmed `deposit_id` is a non-null bigint primary key and results use `table.table_results`. phpMyAdmin 4.4.15.10 removes the submitted SQL's final semicolon from displayed results and groups four action cells under a `colspan="4"` heading. The adapter handles these display details, with offline regressions.

The joined lookup including `automation_username` disables grid editing in this installation. A separate single-table SELECT restricted to the previously verified subscriber ID and exact deposit IDs exposes the grid controls. Any future production write implementation must bind that view back to the verified lookup records before editing. A later, separately approved one-user North execution confirmed the external `input.edit_box` overlay, Enter submission to `tbl_replace.php`, persisted changes and logout. That execution used a scoped local helper and the connected Google Sheets tools; it did not enable general production CLI writes. South has not been inspected. Live configuration and write gates remain disabled.

These are the remaining setup steps, not instructions to turn on live changes now:

1. Authorize the standalone application for Google Sheets reads, independently of the ChatGPT Drive connection. The initial adapter accepts a short-lived OAuth access token through local `GOOGLE_SHEETS_ACCESS_TOKEN`. Use the read-only Sheets scope and an account allowed to read this workbook. API errors do not print tokens or raw response bodies. Refreshable organization-approved authentication can replace the token provider later.
2. Confirm the exact live source headers and completion column/date layouts. A Google connection in this chat does not automatically authenticate a local Node.js process.
3. Inspect phpMyAdmin without editing deposit data. Confirm the true deposit primary key, rendered results table, inline-editor element, login/logout behavior, returned SQL markup, and how result counts/pagination are shown. The user-supplied column headings alone do not establish the deposit key.
4. Review the phpMyAdmin read-request allowlist. The preview permits only the fixed tenant origin, login requests, known read pages, and generated SELECT queries. UI variants may require further reviewed read endpoints. Unexpected requests and dialogs stop the preview.
5. Fill the reviewed selector fields in `config/deposit-refundability.json`. They currently remain null and `livePreview.enabled` is false. The runtime refuses to launch a production preview while this setup is incomplete.
6. Store credentials locally as `PMA_NORTH_USERNAME`, `PMA_NORTH_PASSWORD`, `PMA_SOUTH_USERNAME`, and `PMA_SOUTH_PASSWORD`. Never put passwords or phpMyAdmin session tokens in the task input or repository. Sessions use ephemeral browser contexts; URL tokens are obtained through normal UI navigation.
7. Supply one username for an explicitly authorized read-only preview. Review its exact deposit keys, flags and proposed row actions before the later production-write phase.

Both production write adapters independently reject writes, including if `--apply` is supplied. Enabling live preview does not enable production saves or sheet appends. The production save and append paths will be completed and reviewed only after the preview details are confirmed and actual updates are authorized.

Current limitations: the initial parser rejects partial/paginated result sets rather than guessing remaining rows; the reusable row editor remains limited to the offline fixture while the approved North execution used a separate scoped helper; one username is processed at a time; the default row limit is 200 deposits per username. A browser UI cannot provide a database transaction across multiple rows, so concurrent human edits still need operational coordination during future approved changes.

## Code layout

- `src/task-registry.mjs`: static task selection.
- `src/erp-cli.mjs`: existing ERP command, with the same defaults.
- `src/deposit-cli.mjs`: deposit arguments, lock, reports and service wiring.
- `src/tasks/deposit-refundability.mjs`: reusable business workflow.
- `src/integrations/deposit-sheets.mjs`: source membership and completion validation; Google read transport.
- `src/integrations/phpmyadmin.mjs`: fixed lookup, DOM parsing, row editor and logout; disabled live-write boundary.
- `src/demo/deposit-demo.mjs`: offline browser and spreadsheet fixtures.

Official API references: [reading values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get) and [appending values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append). Future live appends must use RAW input and verify readback; they are currently disabled.
