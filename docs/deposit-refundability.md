# Deposit refundability

The dashboard and CLI accept **manual usernames for live security-deposit changes without Google Sheets**. The selected refundable target is `1` (refundable, default) or `0` (non-refundable). The offline demo and its simulated Sheets workflow remain available. ERP and Workforce keep their staging restrictions.

## Use real usernames in the dashboard

1. Start the dashboard with `npm run web`; open http://127.0.0.1:4310 and sign in with the local token (`npm run web:token`). Restart an older running server after this update, then reload and sign in again.
2. Select **Run task → Deposit refundability** and environment **Live deposits — manual input**.
3. Paste up to 20 exact usernames in **Usernames**, one per line. Case and leading zeroes are preserved; repeated usernames are processed once.
4. Select **North / Delhi** or **South / Hyderabad**. This is required: manual mode does not infer a tenant from Sheets or try the other tenant. Use a separate run for each tenant.
5. Choose **1 — Refundable** or **0 — Non-refundable**, then **Run preview**.
6. Review every record, proposed change, skipped row and cleanup result. Preview does not save deposits.
7. Choose **Review & apply**, review the live-deposit confirmation, check the acknowledgement and choose **Confirm live deposit apply**.
8. Review verified outcomes and download `report.json` or `report.csv`.

Manual input is the source of authorization for these users; Sheets membership is not required. **No Google Sheets reads or writes occur**, and no Google access token is needed. Reports mark sheet status `NOT_REQUESTED_MANUAL`; this means Sheets recording was intentionally skipped, not that a completion entry exists.

The manual environment uses the fixed hosts:

| Tenant | Database origin | Database |
| --- | --- | --- |
| North / Delhi | `https://del-procare-mariadb.excitel.in` | `excitel_ticketing_system` |
| South / Hyderabad | `https://hyd-procare-mariadb.excitel.in` | `excitel_ticketing_system_hyd` |

Store credentials in the local, untracked `.env`:

```dotenv
PMA_NORTH_USERNAME=your-database-username
PMA_NORTH_PASSWORD=your-database-password
PMA_SOUTH_USERNAME=your-database-username
PMA_SOUTH_PASSWORD=your-database-password
```

Only the selected tenant credentials are used. If they are missing, the dashboard opens its database browser and asks you to log in there, then continue in the execution view. The CLI requires configured credentials. Passwords are never task inputs or report fields. Live manual sessions always use a fresh visible browser; the headless-demo preference applies only to offline demos.

## CLI

Read-only live preview:

```bash
npm start -- --task deposit-refundability --manual --tenant north --username FIRST_USER --username SECOND_USER
```

Save eligible deposits as refundable:

```bash
npm start -- --task deposit-refundability --manual --tenant north --username FIRST_USER --username SECOND_USER --refundable 1 --apply
```

Use `--refundable 0` for non-refundable. Without `--apply`, the CLI only previews. The CLI's explicit `--apply` authorizes the listed inputs; the dashboard additionally requires a successful, matching, single-use preview from the last hour. A demo preview cannot authorize a live apply. `--demo` and `--manual` cannot be combined.

The older sheet-based live path, invoked without `--manual` or `--demo`, remains disabled. `config.livePreview` and `GOOGLE_SHEETS_ACCESS_TOKEN` are unrelated to manual mode and do not need enabling.

## Validation and saves

- Query the selected tenant database’s `subscriber_deposit` joined to `subscriber`, using an encoded literal and binary comparison for the exact username. Arbitrary SQL is never accepted as input.
- Require numeric unique `deposit_id`, one subscriber ID per username, exact username identity and known `0`/`1` flags. Missing records, ambiguous identities and partial result pages stop that user. The limit is 200 deposits per user.
- Skip every deposit where `is_covered = 1` or `is_bundled = 1`. Skip eligible deposits already at the requested target.
- In dashboard apply, compare current deposits against the approved preview before editing. Changed record sets, subscriber IDs, eligibility flags or refundable values stop with `PREVIEW_CHANGED` and require a fresh preview.
- Recheck each record immediately before editing. The joined lookup disables grid editing in the inspected phpMyAdmin installation, so open a bounded single-table SELECT restricted to the verified subscriber ID and deposit IDs. Require identical records and flags in that view and verify the row's primary-key controls.
- Double-click the exact refundable cell, fill the external `input.edit_box`, checkpoint `SAVE_STARTED_UNVERIFIED`, then press Enter exactly once. Permit only one scoped POST to `/pma/tbl_replace.php` for that deposit and target value. Reject arbitrary SQL, additional fields/rows, different tenants and duplicate saves.
- Require a successful save acknowledgement and fresh joined-query readback of the same identity, eligibility flags and target value. An optimistic cell display does not count as verification.
- Reuse one session for the selected tenant, log out, reopen to verify login is required, and close the browser. Google Sheets is never accessed in manual mode.

North's `deposit_id` primary key, `table.table_results`, action-heading colspan, external editor and Enter payload were established by earlier local read-only inspections and explicitly scoped live runs. The shared manual adapter uses these controls and validates their presence at runtime. Both tenant flows are covered by offline browser fixtures. Read-only readiness checks exercise live navigation, required columns, an exact synthetic-username SELECT and logout; no real deposit saves are performed by those checks.

The adapter waits for phpMyAdmin AJAX navigation to finish before clicking query controls. It handles CodeMirror and a native inline SQL textarea. Background software-version checks and favorite-table synchronization are answered locally instead of sending unrelated requests.

The post-save phpMyAdmin markup can contain both SELECT and UPDATE tools inside one `.result_query`. `selectQueryControls()` selects the SELECT block and only its adjacent Edit inline tools. A generic AJAX SQL acknowledgement is excluded using the actual result’s row-count/empty-result status. Multiple SELECT blocks in the counted result still stop execution.

## Reports and recovery

Runs save private JSON/CSV reports under `output/`. Reports contain the environment (`production-manual`), `inputSource: manual`, requested target, per-user and per-deposit outcomes, before/after values, save attempts, verification times, logout results and explicit skipped-Sheets status.

`PREVIEW_COMPLETED` means no deposit change was requested. `REFUNDABLE_VERIFIED` / `NON_REFUNDABLE_VERIFIED` mean a change was re-read successfully. An uncertain save becomes `SAVE_UNVERIFIED`; the batch stops and never retries Enter automatically. Already verified rows remain in the report. Review the database and report before running another apply after uncertainty.

The CLI and dashboard share one filesystem lock. Closing the dashboard tab does not stop an execution. Keep the server running until cleanup finishes. A browser workflow cannot provide a transaction across several deposits; coordinate concurrent human edits.

Exit codes: 0 for a completed run, 2 for workflow exceptions, 1 for invalid input or startup failures.

## Offline demonstration and Sheets workflow

```bash
npm start -- --task deposit-refundability --demo --username demo.north
npm start -- --task deposit-refundability --demo --username demo.north --username demo.south --apply
npm start -- --task deposit-refundability --demo --username demo.north --refundable 0 --apply
```

In the dashboard, explicitly choose **Offline demo**. It uses `https://deposit-fixture.invalid`, intercepted entirely inside Playwright, and an in-memory spreadsheet. Every run starts fresh. Real usernames passed to demo mode are never looked up in company systems. `demo.north` has eligible, covered, bundled and already-refundable rows; `demo.south` has one eligible row.

Only the demo's sheet-based workflow checks both source tabs for exact tenant membership, rejects missing/ambiguous users and records verified completion after logout. Target 1 uses Changes reverted (Username/YES/India date); target 0 uses Managed users (Username only). It deduplicates and verifies simulated entries. `recordCompletion()` remains a sheet-only recovery helper for that workflow; it never replays a database save. Live Google writes remain disabled.
