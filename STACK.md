# Technology stack

| Component | Technology | Purpose |
| --- | --- | --- |
| Runtime | Node.js >=22, ES modules | CLI, local HTTP server, worker processes and filesystem persistence |
| Automation | Playwright (existing dependency; lockfile preserved) | Chromium task execution and offline browser tests |
| Frontend | HTML, CSS, browser JavaScript modules | Responsive dashboard with no build step or new dependency |
| API | Node `http` | Same-origin authenticated local JSON API and report downloads |
| Tests | Node `node:test` + Playwright | Existing business regressions, API/security and UI integration |
| Storage | Existing private `output/` and `.state/` folders | Reports, lifecycle metadata, profiles, shared lock, audit/settings/token |

There is no added runtime dependency, database service, microservice, external UI asset, cloud deployment, Zendesk client or AI SDK. No package-lock dependency update is needed.

Application origins and approved authentication origins remain in `src/browser.mjs` and `config/staging.json`. Deposit's live access gates remain disabled in the existing implementation. Credentials are local `.env`/process values and never frontend settings. Dashboard configuration adds optional `DASHBOARD_PORT` and `DASHBOARD_TOKEN`; supported non-sensitive settings persist separately from existing engine configuration.

See [the dashboard guide](docs/web-dashboard.md) for installation, operation, safety/recovery and task extension.
