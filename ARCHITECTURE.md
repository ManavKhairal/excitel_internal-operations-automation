# Architecture

The repository is a Node.js ES-module modular monolith. A buildless local dashboard and the existing CLI share the same orchestration and browser task implementation.

```text
Browser dashboard (web/)
       |
Local authenticated HTTP API (src/web/server.mjs)
       |
ExecutionManager — validation, approval, lock, lifecycle, audit
       |
Fixed worker process -> runTask (src/task-runner.mjs)
                         /                    \
               ERP staging                Deposit offline demo
             Procare + CoreHR            task + sheet/DB adapters
                         \                    /
                   existing output/<run>/ reports

CLI (src/cli.mjs -> registry -> CLI wrappers) -> same runTask
```

`src/task-registry.mjs` defines task selection and UI metadata. `src/erp-cli.mjs` and `src/deposit-cli.mjs` retain CLI parsing and help. `src/task-runner.mjs` handles config loading, shared locking, session lifecycle, orchestration and report output without importing executable CLI side effects. ERP uses `src/procare.mjs`, `src/corehr.mjs` and `src/browser.mjs`. Deposit retains `src/tasks/deposit-refundability.mjs`, `src/integrations/` and `src/demo/`.

`src/web/validation.mjs` is the strict HTTP input boundary. `executions.mjs` serializes creation, binds single-use apply approval to normalized previews, supervises one worker, imports CLI history and persists lifecycle metadata. `reports.mjs` supplies record classifications, reliable counts, safe report projection and artifact allowlisting. `security.mjs` handles local tokens, redaction and request errors. `worker.mjs` bridges structured engine events and manual-login acknowledgements over IPC. No client can supply a shell command, executable, URL or arbitrary filesystem path.

`web/app.mjs` renders dashboard, task library/forms, execution details, history, reports and settings. Polling reads actual engine checkpoints without changing task execution. A disconnected UI does not own or kill the worker. The Node server uses same-origin cookies, CSRF checks and loopback binding. Static serving is an exact allowlist, never the repository root.

Both entry points use `.state/run.lock`. Existing business safeguards remain in the adapters: exact identities, staging origin checks, one Save attempt, checkpoints before writes, revalidation and verified logout. Existing configuration stays in `config/`; credentials and browser profiles remain private. Joget is not implemented and is not a global workflow step.

All tests use Node's test runner and offline Playwright fixtures. Browser UI and backend tests exercise the actual HTTP interface, plus the real offline deposit worker. There is no live company-system testing in the dashboard implementation effort.

Known tradeoffs: file scanning rather than a history database; one trusted local operator; no unsafe cancellation/retry convenience; report-tail events bounded to 1,000; guided pagination stays CLI-only; schema registrations require explicit backend validation. These keep the existing execution safety model intact while allowing more tasks.
