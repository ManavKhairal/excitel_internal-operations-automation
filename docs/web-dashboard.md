# Local automation dashboard

The dashboard is a local, authenticated interface to this repository's automation engine. ERP operations remain staging-only. Deposit refundability remains an **offline demo**, including both refundable targets (`0` and `1`). No production access, Zendesk, AI, or global Joget step is added.

## Install and start

Use Node.js 22 or newer and run these commands in this development copy:

```bash
npm install
npx playwright install chromium
npm run web
```

Open **http://127.0.0.1:4310**. In a second terminal in the same folder:

```bash
npm run web:token
```

Paste the displayed local access token into the dashboard sign-in form. This explicit command prints the dashboard token; normal server logs do not. The generated token is stored with private permissions at `.state/dashboard-token`. Treat it as a password. Credentials for Procare/CoreHR stay in the existing local `.env` and are never entered into dashboard forms. Do not share tokens or `.state` files.

Optional `.env` values are `DASHBOARD_PORT` (default `4310`, range `1024`–`65535`) and `DASHBOARD_TOKEN` (at least 32 characters). Binding stays `127.0.0.1`; there is no public-host setting. To rotate a generated token, stop the server, remove only `.state/dashboard-token`, then restart and use `npm run web:token`. If a token is configured in `.env`, replace that value instead. Restarting invalidates existing dashboard sessions.

No frontend build, database service, npm dev server, or cloud deployment is required. The server serves the UI and API together. `npm start`, `npm run login`, and existing task flags retain their CLI meanings.

## Operating a task

1. Open **Automations**, select a task, and fill its schema-driven form.
2. Run a preview. ERP recollects the exact partner and reads current CoreHR statuses. Deposit demo uses synthetic browser pages and an in-memory sheet.
3. Open the execution detail, inspect record outcomes, errors, and cleanup. Download reports as needed.
4. For a successful preview, choose apply and confirm the displayed task, environment, and inputs. Preview approval expires after one hour and can be used only once. A failed/partial preview cannot authorize apply. CLI historical runs cannot authorize dashboard apply.
5. Monitor the new execution. Apply runs the workflow afresh and rechecks current identities, statuses, and eligible records; preview is not a guarantee of apply success.

Deposit demo data starts fresh for every execution. It is useful for testing the entire interface without company credentials. Try `demo.north` or `demo.south`; these records never reach a real database or Google Sheet. **Settings → Headless demo browser** makes this demo usable without a display. ERP keeps a visible browser because SSO/MFA can require an operator.

Only automatic ERP pagination is exposed in the dashboard. Guided/single-page collection and dedicated session preparation remain available through their existing CLI commands.

## Authentication, sessions and operator actions

Dashboard authentication is separate from company authentication. Dashboard sessions use an HttpOnly, SameSite=Strict cookie, expire after 12 hours, and require a CSRF token plus same-origin checks for changes. The listener is local HTTP, so this is intended for one trusted local operator, not shared hosting.

Each ERP run opens the engine's dedicated persistent browser profiles, checks for an authenticated application, and uses locally configured login credentials when supported. If SSO or MFA needs intervention, the execution changes to **waiting for operator**. Complete login in the opened automation browser, then use the dashboard's continue control. This sends only an acknowledgement, never a password, cookie, or arbitrary browser command. The engine verifies the actual staging page and ready state after continuation. The prompt expires after 10 minutes and then the engine attempts normal cleanup and records the failure.

A saved profile shown in Settings means local profile storage exists; it does **not** prove the application session is currently valid. Expired sessions and unavailable applications surface as execution errors, with any available record outcomes and cleanup preserved.

## Execution control and recovery

- One execution at a time, using the same `.state/run.lock` as the CLI. There is no queue that silently starts writes later.
- Request keys prevent duplicate dispatch after a retry; reuse with different inputs is rejected. Apply also consumes its preview once.
- Closing a tab, signing out, or losing the UI connection does not cancel the worker. Reopen the execution to inspect it. Sign-in expiry does not authorize or start additional work.
- There is deliberately no browser kill/cancel button. Ctrl+C on the server stops new work, ends pending operator prompts, and waits for the current worker and cleanup to finish. The worker is in a separate process group so the same Ctrl+C does not interrupt a Save.
- An unexpected worker exit retains the run lock. A server restart marks unfinished dashboard executions **interrupted** and retains the existing lock. A worker from the old server may still be running. Never assume an interrupted change did not happen.
- Before removing a stale `.state/run.lock`, inspect the execution's existing report/checkpoints and dedicated browser processes, ensure no CLI or worker is still active, and manually verify any `SAVE_STARTED_UNVERIFIED`, `SAVE_UNVERIFIED`, or sheet append uncertainty. There is no dashboard endpoint that removes the lock or retries a write.

The UI distinguishes task status from record counts and logout/cleanup. Pending records and uncertain saves are visible. Percentages are not invented before record totals are known. Deposit totals can increase as actual deposit rows are discovered.

## Reports, history and settings

The engine still writes `output/<run>/report.json`, `report.csv`, ERP manifests and logout results. Dashboard runs add `execution.json` to the same folder for input metadata, audit linkage, lifecycle, and up to 1,000 recent structured stage events. The original report remains the record-level source of truth. Older CLI folders with reports/errors are discovered automatically; unsupported/unknown history is labeled rather than treated as an approved preview.

History filters support task, status, environment and inclusive ISO date bounds using the stored UTC timestamps. Dashboard timestamps are displayed in the browser's local timezone. History dates therefore refer to UTC calendar dates.

Authenticated downloads allow only report CSV/JSON, employee manifests, logout reports, and report-referenced PNG evidence when screenshots are enabled. JSON is restricted to known report fields; text and CSV responses redact configured secrets and URL queries. Auth files, profiles, arbitrary files, diagnostic UI dumps, demo-state files and error screenshots are not downloadable. Existing private local files remain untouched. Do not treat screenshots/reports as public data: they can contain business records and employee information.

Settings expose only screenshot capture/access and the offline demo's headless option. Selectors, URLs, browser executables, accounts, environment allowlists and secrets remain server-side in the existing configuration. Settings cannot be changed during an active dashboard run. Settings persist to `.state/dashboard-settings.json`; important access/execution/download/settings actions append to private `.state/dashboard-audit.jsonl`.

## Adding an automation

The system stays one application. A future task needs these explicit backend registrations, with no new frontend screens:

1. Add or reuse a workflow module that accepts validated input and checkpoints reports. Keep browser/domain business rules in that module.
2. Add dispatch to `runTask()` in `src/task-runner.mjs`, including normal cleanup, report output, staging/offline restrictions, and structured `onEvent` notifications. `ask()` is for operator acknowledgement only.
3. Add CLI selection in `src/task-registry.mjs` and metadata to its `taskCatalog`: task ID, description, applications, environments, modes, and input field definitions. The library/forms render this metadata automatically.
4. Register strict normalization/validation in `src/web/validation.mjs`. Reject unknown fields; never accept executable paths, shell commands, arbitrary URLs or production overrides.
5. Use the existing report schema where possible. If introducing outcomes or fields, extend `src/web/reports.mjs` deliberately so record counts, cleanup and permitted downloads remain accurate. New schemas must not expose session/credential material.
6. Add safe offline tests for dispatch, validation, preview/apply rules, checkpoints, cleanup and browser UI flow. Keep the shared lock and idempotency controls in the manager rather than duplicating them per task.

The `ExecutionManager` is independent of HTTP: a future reviewed Zendesk adapter can submit normalized requests to the same dispatch boundary, with its own authenticated identity and explicit authorization policy. Neither Zendesk nor AI is implemented here.

## Verification

```bash
npm run check
npm test
npm run test:web
```

The full suite includes existing regressions and the web tests; `test:web` is the focused subset. Tests use temporary roots and fixtures, and browser tests use installed Playwright Chromium. They do not call company applications. See `TEST_RESULTS.md` for actual final commands/results and `output/web-test-evidence/` for generated screenshots when browser verification has run.

## Current limits

This is a local single-operator modular monolith. It has no multi-user roles, remote hosting, production execution, forced cancellation, live deposit integration, or workflow scheduler. The event tail is bounded; the full record-level report remains durable. Very large histories are scanned from disk rather than indexed. Downloads are capped at 20 MB. Application authentication and selectors still require separately authorized staging verification on the operator's machine; offline tests do not prove live connectivity, MFA completion, or account permissions.

## Implementation files

| Change | Files |
| --- | --- |
| Added frontend | `web/index.html`, `web/app.mjs`, `web/styles.css` |
| Added backend | `src/web/server.mjs`, `main.mjs`, `executions.mjs`, `worker.mjs`, `validation.mjs`, `reports.mjs`, `security.mjs` |
| Added shared entry point and token command | `src/task-runner.mjs`, `scripts/dashboard-token.mjs` |
| Added tests | `tests/web-fixtures.mjs`, `tests/web.test.mjs`, `tests/web-ui.test.mjs` |
| Updated integration | `src/erp-cli.mjs`, `src/deposit-cli.mjs`, `src/task-registry.mjs`, `src/utils.mjs`, `package.json`, `scripts/check.mjs`, `.env.example` |
| Added/updated documentation | `ARCHITECTURE.md`, `STACK.md`, this guide, `README.md`, `TEST_RESULTS.md` |

The existing Procare/CoreHR browser adapters, deposit business rules and integrations, task configuration, lockfile, original tests, credentials and saved profiles were preserved. Pre-existing uncommitted deposit refinements were retained. The CLI wrappers were reduced to argument handling around the extracted shared orchestration; its original report formats and cleanup behavior remain in use. No commit or push was performed.
