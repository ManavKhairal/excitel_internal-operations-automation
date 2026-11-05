import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { saveReport, acquireLock, writeJson } from '../src/utils.mjs';
import { taskCatalog } from '../src/task-registry.mjs';
import { progressOf } from '../src/web/reports.mjs';
import { testBrowser } from './fixtures.mjs';
import { workforceWebExecutor } from './workforce-web-fixtures.mjs';
import { procareSyncWebExecutor } from './procare-web-fixtures.mjs';
import { manualDepositFixture } from './deposit-web-fixtures.mjs';
import { TEST_TOKEN, deferred, fixtureExecutor, makeRoot, pause, requestBody, startDashboard } from './web-fixtures.mjs';

test('dashboard requires a local authenticated session, protects mutations and never serves private files', async t => {
  const app = await startDashboard({ login: false }); t.after(() => app.dispose());
  assert.equal((await app.request('/api/tasks')).status, 401);
  assert.equal((await app.request('/api/session', { method: 'POST', body: { token: 'wrong' } })).status, 401);
  assert.equal((await app.request('/api/session', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: { token: TEST_TOKEN } })).status, 403);
  // Node fetch rewrites Host; use HTTP directly to actually send a hostile Host.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.base}/api/tasks`, { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  const login = await app.signIn();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok(login.data.csrfToken.length >= 32);
  assert.equal((await app.request('/api/session')).data.authenticated, true);
  for (const headers of [{ 'X-CSRF-Token': 'incorrect' }, { Origin: '' }, { Origin: 'https://untrusted.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody(), headers })).status, 403);
  }
  for (const route of ['/.env', '/.state/dashboard-token', '/config/staging.json', '/output/report.json', '/api/../.state/run.lock']) {
    assert.equal((await app.request(route)).status, 404);
  }
  assert.equal((await app.request('/api/session', { method: 'DELETE' })).status, 200);
  assert.equal((await app.request('/api/tasks')).status, 401);
});

test('task discovery is registry-driven, settings expose safe supported values and empty history is real', async t => {
  const app = await startDashboard(); t.after(() => app.dispose());
  const tasks = await app.request('/api/tasks');
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.data.tasks, taskCatalog);
  assert.deepEqual(tasks.data.tasks.map(task => task.id).sort(), ['deposit-refundability', 'erp-deactivation', 'procare-subscriber-synchronization', 'workforce-access']);
  // Only the North Procare synchronization task is exposed against production.
  assert.deepEqual(tasks.data.tasks.filter(task => task.environments.includes('production')).map(task => task.id), ['procare-subscriber-synchronization']);
  assert.deepEqual((await app.request('/api/executions')).data.executions, []);
  const settings = (await app.request('/api/settings')).data.settings;
  assert.equal(settings.productionEnabled, true); assert.equal(settings.depositManualEnabled, true); assert.equal(settings.concurrency, 1); assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.applications.find(app => app.name === 'Workforce').session, 'fresh_per_run');
  assert.doesNotMatch(JSON.stringify(settings), /PASSWORD|access_token|storageState|cookie|\.env/);
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { screenshots: false, demoHeadless: true } })).status, 200);
  assert.equal((await app.request('/api/settings')).data.settings.demoHeadless, true);
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { productionEnabled: true } })).status, 400);
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { screenshots: 'yes' } })).status, 400);
});

test('input validation rejects arbitrary tasks, environments, URLs, commands and unsupported task inputs before dispatch', async t => {
  let dispatched = 0;
  const app = await startDashboard({ execute: async (...args) => { dispatched++; return fixtureExecutor(...args); } }); t.after(() => app.dispose());
  const cases = [
    { taskId: 'shell' }, { environment: 'production' }, { mode: 'execute' }, { idempotencyKey: 'short' },
    { input: { partner: '' } }, { input: { partner: '<script>' } }, { input: { partner: 'fixture', pagination: 'guided' } },
    { input: { partner: 'fixture', url: 'https://production.invalid' } }, { command: 'echo bad' }, { input: [] },
    { taskId: 'deposit-refundability', environment: 'offline-demo', input: { usernames: [] } },
    { taskId: 'deposit-refundability', environment: 'staging', input: { usernames: ['demo.north'] } },
    { taskId: 'deposit-refundability', environment: 'offline-demo', input: { usernames: ['bad username'] } },
    { taskId: 'deposit-refundability', environment: 'offline-demo', input: { usernames: ['demo.north'], refundable: 2 } },
    { taskId: 'deposit-refundability', environment: 'offline-demo', input: { usernames: ['demo.north'], tenant: 'untrusted' } },
    { mode: 'apply' }, { mode: 'preview', confirmed: true },
    { taskId: 'workforce-access', input: { usernames: ['new.agent1'], tenant: '', action: 'grant' } },
    { taskId: 'workforce-access', input: { usernames: ['new.agent1'], tenant: 'both', action: 'delete-account' } },
    { taskId: 'workforce-access', input: { usernames: ['new.agent1'], tenant: 'both', action: 'remove', url: 'https://production.invalid' } },
    { taskId: 'workforce-access', environment: 'production', input: { usernames: ['new.agent1'], tenant: 'both', action: 'grant' } },
  ];
  for (const overrides of cases) {
    const response = await app.request('/api/executions', { method: 'POST', body: requestBody(overrides) });
    assert.equal(response.status, 400, `${JSON.stringify(overrides)}: ${response.text}`);
    assert.ok(response.data.error.code);
  }
  assert.equal(dispatched, 0);
  assert.deepEqual((await app.request('/api/executions')).data.executions, []);
});

test('HTTP bodies are bounded JSON objects and malformed filters fail without a server error', async t => {
  const app = await startDashboard(); t.after(() => app.dispose());
  for (const [body, status, headers] of [['{', 400], ['null', 400], ['[]', 400], ['x'.repeat(25000), 413], ['{}', 415, { 'Content-Type': 'text/plain' }]]) {
    const response = await app.request('/api/executions', { method: 'POST', body, headers }); assert.equal(response.status, status, response.text);
  }
  for (const filter of ['from=invalid', 'from=2026-10-31&to=2026-01-01', 'unexpected=value']) assert.equal((await app.request(`/api/executions?${filter}`)).status, 400);
  assert.equal((await app.request('/api/executions/missing')).status, 404);
});

test('execution creation dispatches normalized task input and provides measured progress, records and reports', async t => {
  let job;
  const app = await startDashboard({ execute: async (value, callbacks) => { job = value; return fixtureExecutor(value, callbacks); } }); t.after(() => app.dispose());
  const response = await app.request('/api/executions', { method: 'POST', body: requestBody({ input: { partner: '  Fixture   Partner  ' } }) });
  assert.equal(response.status, 202);
  const detail = await app.finish(response.data.execution.id);
  assert.equal(job.taskId, 'erp-deactivation'); assert.equal(job.input.partner, 'Fixture Partner'); assert.equal(job.input.apply, false);
  assert.equal(detail.status, 'succeeded'); assert.equal(detail.canApply, true); assert.equal(detail.records.length, 2);
  assert.deepEqual(detail.progress, { completed: 2, total: 2, successful: 1, skipped: 1, failed: 0, pending: 0 });
  assert.ok(detail.events.some(event => event.currentRecord === 'fixture.alpha'));
  assert.ok(detail.startedAt && detail.finishedAt);
  for (const name of ['report.json', 'report.csv']) {
    const artifact = detail.artifacts.find(item => item.name === name); assert.ok(artifact);
    const download = await app.request(artifact.url); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.match(download.text, /fixture.alpha/);
  }
  assert.equal((await app.request('/api/executions?task=erp-deactivation&status=succeeded&environment=staging')).data.executions.length, 1);
  assert.equal((await app.request('/api/executions?task=deposit-refundability')).data.executions.length, 0);
  assert.equal((await app.request('/api/executions?from=2000-01-01&to=2001-01-01')).data.executions.length, 0);
  await assert.rejects(fs.access(path.join(app.root, '.state/run.lock')));
});

test('one active execution, idempotent request replay and shared CLI lock prevent duplicate dispatch', async t => {
  const gate = deferred(); let dispatched = 0;
  const app = await startDashboard({ execute: async (...args) => { dispatched++; await gate.promise; return fixtureExecutor(...args); } });
  t.after(async () => { gate.resolve(); await app.dispose(); });
  const body = requestBody();
  const [first, second] = await Promise.all([app.request('/api/executions', { method: 'POST', body }), app.request('/api/executions', { method: 'POST', body })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 202]);
  assert.equal(first.data.execution.id, second.data.execution.id); assert.equal(dispatched, 1);
  assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody() })).status, 409);
  assert.equal((await app.request('/api/executions', { method: 'POST', body: { ...body, input: { partner: 'Different Partner' } } })).status, 409);
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { screenshots: false } })).status, 409);
  const running = (await app.request(`/api/executions/${first.data.execution.id}`)).data.execution;
  assert.equal(running.status, 'running'); assert.equal(running.progress, null);
  gate.resolve(); await app.finish(first.data.execution.id);
  assert.equal((await app.request('/api/executions', { method: 'POST', body })).status, 200); assert.equal(dispatched, 1);
  const release = await acquireLock(path.join(app.root, '.state'));
  try { assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody() })).status, 409); }
  finally { await release(); }
});

test('apply needs an exact successful recent preview, explicit confirmation and a single-use approval', async t => {
  const inputs = [];
  const app = await startDashboard({ execute: async (job, callbacks) => { inputs.push(job.input); return fixtureExecutor(job, callbacks); } }); t.after(() => app.dispose());
  const preview = await app.request('/api/executions', { method: 'POST', body: requestBody() });
  const id = preview.data.execution.id; await app.finish(id);
  for (const overrides of [{ confirmed: false }, { input: { partner: 'Other Partner' } }, { previewId: 'missing' }]) {
    const response = await app.request('/api/executions', { method: 'POST', body: requestBody({ mode: 'apply', previewId: id, confirmed: true, ...overrides }) });
    assert.ok([400, 404, 409].includes(response.status), response.text);
  }
  const body = requestBody({ mode: 'apply', previewId: id, confirmed: true });
  const apply = await app.request('/api/executions', { method: 'POST', body }); assert.equal(apply.status, 202);
  const final = await app.finish(apply.data.execution.id); assert.equal(final.status, 'succeeded'); assert.equal(final.records[0].saveAttempted, true);
  assert.deepEqual(inputs.map(input => input.apply), [false, true]);
  assert.equal((await app.request(`/api/executions/${id}`)).data.execution.canApply, false);
  assert.equal((await app.request('/api/executions', { method: 'POST', body })).status, 200);
  assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody({ mode: 'apply', previewId: id, confirmed: true }) })).status, 409);
  const next = await app.request('/api/executions', { method: 'POST', body: requestBody() }); await app.finish(next.data.execution.id);
  const expired = app.manager.executions.get(next.data.execution.id); expired.finishedAt = new Date(Date.now() - 3601000).toISOString(); await app.manager.persist(expired);
  assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody({ mode: 'apply', previewId: expired.id, confirmed: true }) })).status, 409);
});

test('manual login is explicit, survives dashboard logout, and can be continued only for its current prompt', async t => {
  const app = await startDashboard({ execute: async (job, callbacks) => { await callbacks.ask('Complete the synthetic MFA screen, then continue.'); return fixtureExecutor(job, callbacks); } }); t.after(() => app.dispose());
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody() }); const id = created.data.execution.id;
  let detail;
  for (let i = 0; i < 100; i++) { detail = (await app.request(`/api/executions/${id}`)).data.execution; if (detail.prompt) break; await pause(10); }
  assert.equal(detail.status, 'waiting_for_operator'); assert.ok(detail.prompt.id);
  assert.equal((await app.request(`/api/executions/${id}/continue`, { method: 'POST', body: { promptId: 'stale' } })).status, 409);
  await app.request('/api/session', { method: 'DELETE' }); await app.signIn();
  assert.equal((await app.request(`/api/executions/${id}`)).data.execution.status, 'waiting_for_operator');
  assert.equal((await app.request(`/api/executions/${id}/continue`, { method: 'POST', body: { promptId: detail.prompt.id } })).status, 200);
  assert.equal((await app.finish(id)).status, 'succeeded');
  assert.equal((await app.request(`/api/executions/${id}/continue`, { method: 'POST', body: { promptId: detail.prompt.id } })).status, 409);
});

test('handled failures are recorded with safe errors and uncertain saves retain record-level evidence', async t => {
  let partial = false;
  const app = await startDashboard({ execute: async job => {
    if (partial) await saveReport(job.outputDir, { environment: 'staging', mode: 'apply', status: 'HALTED_FOR_REVIEW', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results: [
      { username: 'fixture.alpha', outcome: 'SAVE_UNVERIFIED', saveAttempted: true }, { username: 'fixture.beta', outcome: 'NOT_PROCESSED' }
    ] });
    throw Object.assign(new Error('Login unavailable: password=hidden-test-password Bearer private-token https://example.invalid/path?token=hidden'), { code: 'LOGIN_REQUIRED' });
  } }); t.after(() => app.dispose());
  const first = await app.request('/api/executions', { method: 'POST', body: requestBody() }); const failed = await app.finish(first.data.execution.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'LOGIN_REQUIRED'); assert.equal(failed.canApply, false);
  assert.doesNotMatch(JSON.stringify(failed), /hidden-test-password|private-token|token=hidden/);
  partial = true;
  const second = await app.request('/api/executions', { method: 'POST', body: requestBody() }); const result = await app.finish(second.data.execution.id);
  assert.equal(result.status, 'partial'); assert.equal(result.progress.failed, 1); assert.equal(result.progress.pending, 1);
  assert.equal(result.records[0].saveAttempted, true); assert.equal(result.canApply, false);
});

test('Workforce login failure in a completed report is shown as a failed execution with a safe error', async t => {
  const app = await startDashboard({ execute: async job => {
    await writeJson(path.join(job.outputDir, 'report.json'), {
      task: 'workforce-access', environment: 'staging', mode: 'dry-run', action: 'grant',
      status: 'COMPLETED_WITH_EXCEPTIONS', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      error: { code: 'LOGIN_REQUIRED', message: 'Staging SSO or MFA is required.' },
      results: [{ username: 'new.agent1', tenant: 'north', outcome: 'NOT_PROCESSED', saveAttempted: false }],
      cleanup: { logout: 'NOT_REQUIRED', browser: 'NOT_OPENED' }
    });
    return { exitCode: 2 };
  } }); t.after(() => app.dispose());
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'workforce-access', environment: 'staging', input: { usernames: ['new.agent1'], tenant: 'north', action: 'grant' } }) });
  const detail = await app.finish(created.data.execution.id);
  assert.equal(detail.status, 'failed'); assert.equal(detail.error.code, 'LOGIN_REQUIRED');
  assert.equal(detail.canApply, false); assert.equal(detail.cleanup.status, 'NOT_REQUIRED');
});

test('unexpected worker interruption remains interrupted and preserves the shared lock for manual review', async t => {
  const app = await startDashboard({ execute: async () => { throw Object.assign(new Error('Fixture worker disappeared'), { code: 'WORKER_INTERRUPTED' }); } }); t.after(() => app.dispose());
  const first = await app.request('/api/executions', { method: 'POST', body: requestBody() });
  const result = await app.finish(first.data.execution.id); assert.equal(result.status, 'interrupted'); assert.equal(result.canApply, false);
  await fs.access(path.join(app.root, '.state/run.lock'));
  assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody() })).status, 409);
});

test('missing final report cannot silently release the execution lock', async t => {
  const app = await startDashboard({ execute: async () => ({ exitCode: 0 }) }); t.after(() => app.dispose());
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody() });
  const detail = await app.finish(created.data.execution.id);
  assert.equal(detail.status, 'interrupted'); assert.equal(detail.error.code, 'REPORT_MISSING');
  await fs.access(path.join(app.root, '.state/run.lock'));
});

test('a worker error after a Save stage with no final report retains the lock for reconciliation', async t => {
  const app = await startDashboard({ execute: async (_job, callbacks) => {
    await callbacks.onEvent({ type: 'stage', stage: 'saving', message: 'A save was attempted.' });
    throw Object.assign(new Error('The browser closed before report persistence.'), { code: 'BROWSER_ERROR' });
  } }); t.after(() => app.dispose());
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody() });
  const detail = await app.finish(created.data.execution.id);
  assert.equal(detail.status, 'interrupted');
  await fs.access(path.join(app.root, '.state/run.lock'));
});

test('apply progress counts unattempted eligible deposit rows as pending until verification', () => {
  const report = { mode: 'apply', results: [{ username: 'fixture', rows: [
    { outcome: 'WOULD_SET_REFUNDABLE' }, { outcome: 'SAVE_STARTED_UNVERIFIED' },
    { outcome: 'REFUNDABLE_VERIFIED' }, { outcome: 'SKIPPED_COVERED_OR_BUNDLED' }
  ] }] };
  assert.deepEqual(progressOf(report), { completed: 2, total: 4, successful: 1, skipped: 1, failed: 0, pending: 2 });
  report.mode = 'dry-run';
  assert.deepEqual(progressOf(report), { completed: 3, total: 4, successful: 2, skipped: 1, failed: 0, pending: 1 });
});

test('graceful shutdown drains work and ends a pending login through normal error cleanup', async t => {
  let cleaned = false;
  const app = await startDashboard({ execute: async (_job, callbacks) => {
    try { await callbacks.ask('Fixture login required.'); }
    finally { cleaned = true; }
  } });
  t.after(() => app.dispose());
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody() });
  for (let i = 0; i < 100 && !app.manager.pendingPrompt; i++) await pause(10);
  assert.ok(app.manager.pendingPrompt);
  await app.close();
  assert.equal(cleaned, true);
  const execution = app.manager.executions.get(created.data.execution.id);
  assert.equal(execution.status, 'failed'); assert.equal(execution.error.code, 'LOGIN_REQUIRED');
  await assert.rejects(fs.access(path.join(app.root, '.state/run.lock')));
});

test('report downloads redact secrets, exclude diagnostic/session files and reject traversal or symlinks', async t => {
  let directory;
  const app = await startDashboard({ execute: async (job, callbacks) => {
    directory = job.outputDir;
    await fixtureExecutor(job, callbacks);
    const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
    report.password = 'private-password'; report.cookies = [{ value: 'private-cookie' }];
    report.results[0].message = 'access_token=private-token https://example.invalid/path?session=private-session';
    report.results[0].evidence = 'fixture-before.png';
    await saveReport(directory, report);
    await fs.writeFile(path.join(directory, 'fixture-before.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Zt8AAAAASUVORK5CYII=', 'base64'));
    await fs.writeFile(path.join(directory, 'unreferenced.png'), 'not visible');
    await fs.writeFile(path.join(directory, 'error.json'), JSON.stringify({ password: 'private-password' }));
    return { exitCode: 0 };
  } }); t.after(() => app.dispose());
  await app.request('/api/settings', { method: 'PATCH', body: { screenshots: true } });
  const created = await app.request('/api/executions', { method: 'POST', body: requestBody() }); const id = created.data.execution.id;
  const detail = await app.finish(id);
  assert.doesNotMatch(JSON.stringify(detail), /private-password|private-cookie|private-token|private-session/);
  assert.ok(detail.artifacts.some(item => item.name === 'fixture-before.png'));
  for (const name of ['report.json', 'report.csv']) assert.doesNotMatch((await app.request(`/api/executions/${id}/artifacts/${name}`)).text, /private-password|private-cookie|private-token|private-session/);
  for (const name of ['error.json', 'unreferenced.png', 'execution.json', '..%2F..%2F.env', '%2e%2e%5c.env']) assert.equal((await app.request(`/api/executions/${id}/artifacts/${name}`)).status, 404);
  await fs.unlink(path.join(directory, 'report.csv')); await fs.symlink(path.join(app.root, 'config/staging.json'), path.join(directory, 'report.csv'));
  assert.equal((await app.request(`/api/executions/${id}/artifacts/report.csv`)).status, 404);
  await app.request('/api/settings', { method: 'PATCH', body: { screenshots: false } });
  assert.equal((await app.request(`/api/executions/${id}/artifacts/fixture-before.png`)).status, 404);
});

test('restart preserves history, request idempotency and imported CLI reports without enabling apply', async t => {
  const root = await makeRoot(); let app;
  t.after(async () => { await app?.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  app = await startDashboard({ root });
  const body = requestBody(); const created = await app.request('/api/executions', { method: 'POST', body }); await app.finish(created.data.execution.id);
  await app.dispose();
  const legacy = path.join(root, 'output', 'legacy-fixture'); await fs.mkdir(legacy);
  await saveReport(legacy, { environment: 'staging', mode: 'dry-run', partner: { name: 'Old Fixture Partner' }, status: 'COMPLETED', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', results: [{ username: 'fixture.old', outcome: 'ALREADY_INACTIVE' }] });
  app = await startDashboard({ root });
  const history = (await app.request('/api/executions')).data.executions; assert.equal(history.length, 2);
  const imported = history.find(item => item.source === 'cli'); assert.equal(imported.status, 'skipped');
  assert.equal((await app.request(`/api/executions/${imported.id}`)).data.execution.canApply, false);
  const replay = await app.request('/api/executions', { method: 'POST', body }); assert.equal(replay.status, 200); assert.equal(replay.data.execution.id, created.data.execution.id);
  assert.equal((await app.request('/api/executions?from=2026-01-01&to=2026-01-01')).data.executions.length, 1);
});

test('restart marks an unfinished web execution interrupted without deleting a surviving worker lock', async t => {
  const root = await makeRoot();
  const directory = path.join(root, 'output', 'interrupted-fixture'); await fs.mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, 'execution.json'), { id: 'fixture-interrupted', source: 'web', taskId: 'erp-deactivation', environment: 'staging', input: { partner: 'Fixture Partner' }, mode: 'apply', status: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), events: [] });
  const release = await acquireLock(path.join(root, '.state'));
  const app = await startDashboard({ root }); t.after(async () => { await app.dispose(); await release(); await fs.rm(root, { recursive: true, force: true }); });
  const detail = (await app.request('/api/executions/fixture-interrupted')).data.execution;
  assert.equal(detail.status, 'interrupted'); assert.equal(detail.error.code, 'SERVER_INTERRUPTED'); assert.equal(detail.canApply, false);
  await fs.access(path.join(root, '.state/run.lock'));
  assert.equal((await app.request('/api/executions', { method: 'POST', body: requestBody() })).status, 409);
});

test('audit records important actions without authentication tokens or report secrets', async t => {
  const app = await startDashboard(); t.after(() => app.dispose());
  const preview = await app.request('/api/executions', { method: 'POST', body: requestBody() }); await app.finish(preview.data.execution.id);
  await app.request(`/api/executions/${preview.data.execution.id}/artifacts/report.json`);
  await app.request('/api/settings', { method: 'PATCH', body: { screenshots: false } });
  await app.request('/api/session', { method: 'DELETE' });
  const audit = await fs.readFile(path.join(app.root, '.state/dashboard-audit.jsonl'), 'utf8');
  const actions = audit.trim().split('\n').map(line => JSON.parse(line).action);
  for (const action of ['session.login', 'execution.preview_created', 'execution.finished', 'report.downloaded', 'settings.updated', 'session.logout']) assert.ok(actions.includes(action), action);
  assert.ok(!audit.includes(TEST_TOKEN)); assert.doesNotMatch(audit, /csrfToken|automation_session=/);
});

test('real offline deposit worker runs through API, shared runner, browser fixtures and reports in both directions', { timeout: 30000 }, async t => {
  const app = await startDashboard({ execute: null }); t.after(() => app.dispose());
  assert.equal((await app.request('/api/settings', { method: 'PATCH', body: { demoHeadless: true } })).status, 200);
  for (const refundable of [1, 0]) {
    const input = { usernames: ['demo.north'], refundable };
    const preview = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'deposit-refundability', environment: 'offline-demo', input }) }); assert.equal(preview.status, 202, preview.text);
    const checked = await app.finish(preview.data.execution.id, { timeout: 10000 }); assert.equal(checked.status, 'succeeded', JSON.stringify(checked.error));
    assert.equal(checked.report.environment, 'offline-demo'); assert.ok(checked.records.every(row => !row.saveAttempted));
    const apply = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'deposit-refundability', environment: 'offline-demo', mode: 'apply', input, confirmed: true, previewId: checked.id }) }); assert.equal(apply.status, 202, apply.text);
    const result = await app.finish(apply.data.execution.id, { timeout: 10000 }); assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(result.cleanup.status, 'COMPLETED'); assert.equal(result.cleanup.results[0].outcome, 'SIGNED_OUT_VERIFIED');
    assert.ok(result.records.some(row => row.outcome === (refundable ? 'REFUNDABLE_VERIFIED' : 'NON_REFUNDABLE_VERIFIED')));
    assert.ok(result.records.some(row => row.outcome === 'SKIPPED_COVERED_OR_BUNDLED'));
    const artifact = result.artifacts.find(item => item.name === 'report.csv'); assert.equal((await app.request(artifact.url)).status, 200);
  }
});

test('Workforce grant and removal run through validated web dispatch, shared runner and offline browser fixture', { timeout: 45000 }, async t => {
  const browser = await testBrowser(); t.after(() => browser.close());
  const app = await startDashboard({ execute: (job, callbacks) => workforceWebExecutor(browser, job, callbacks) }); t.after(() => app.dispose());
  for (const action of ['grant', 'remove']) {
    const input = { usernames: ['new.agent1'], tenant: 'both', action };
    const preview = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'workforce-access', environment: 'staging', input }) });
    assert.equal(preview.status, 202, preview.text);
    const reviewed = await app.finish(preview.data.execution.id, { timeout: 12000 });
    assert.equal(reviewed.status, 'succeeded', JSON.stringify(reviewed.error));
    assert.equal(reviewed.canApply, true);
    assert.equal(reviewed.report.action, action);
    assert.deepEqual(reviewed.records.map(row => row.outcome), [action === 'grant' ? 'WOULD_GRANT_ACCESS' : 'WOULD_REMOVE_ACCESS', action === 'grant' ? 'WOULD_GRANT_ACCESS' : 'WOULD_REMOVE_ACCESS']);
    assert.equal(reviewed.report.writeRequests.length, 0);
    assert.equal(reviewed.cleanup.results[0].outcome, 'SIGNED_OUT_VERIFIED');
    const apply = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'workforce-access', environment: 'staging', mode: 'apply', input, previewId: reviewed.id, confirmed: true }) });
    assert.equal(apply.status, 202, apply.text);
    const done = await app.finish(apply.data.execution.id, { timeout: 12000 });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.deepEqual(done.records.map(row => row.outcome), [action === 'grant' ? 'ACCESS_GRANTED_VERIFIED' : 'ACCESS_REMOVED_VERIFIED', action === 'grant' ? 'ACCESS_GRANTED_VERIFIED' : 'ACCESS_REMOVED_VERIFIED']);
    assert.equal(done.report.writeRequests.length, 2);
    assert.equal(done.progress.completed, 2); assert.equal(done.progress.failed, 0);
    assert.equal(done.cleanup.results[0].outcome, 'SIGNED_OUT_VERIFIED');
    assert.ok(done.events.some(event => event.stage === 'saving' && event.currentRecord === 'new.agent1'));
    assert.equal((await app.request(done.artifacts.find(item => item.name === 'report.csv').url)).status, 200);
  }
  assert.equal((await app.request('/api/executions?task=workforce-access')).data.executions.length, 4);
});


test('manual live deposit API requires tenant and matching preview, binds dispatch to reviewed records and blocks changed deposits', { timeout: 30000 }, async t => {
  const browser = await testBrowser(); t.after(() => browser.close());
  const fixture = manualDepositFixture(browser);
  const dispatched = [];
  const app = await startDashboard({ execute: (job, callbacks) => { dispatched.push(job); return fixture.execute(job, callbacks); } }); t.after(() => app.dispose());
  const request = overrides => requestBody({ taskId: 'deposit-refundability', environment: 'production-manual', input: { usernames: ['manual.First'], tenant: 'north', refundable: 1 }, ...overrides });
  for (const tenant of [undefined, '', 'auto']) {
    const invalid = await app.request('/api/executions', { method: 'POST', body: request({ input: { usernames: ['manual.First'], tenant } }) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'TENANT_REQUIRED');
  }
  assert.equal((await app.request('/api/executions', { method: 'POST', body: request({ mode: 'apply' }) })).status, 400);
  const preview = await app.request('/api/executions', { method: 'POST', body: request() });
  const checked = await app.finish(preview.data.execution.id, { timeout: 12000 });
  assert.equal(checked.status, 'succeeded', JSON.stringify(checked.error));
  assert.equal(dispatched[0].input.manual, true); assert.equal(dispatched[0].input.demo, undefined);
  const changedTenant = await app.request('/api/executions', { method: 'POST', body: request({ mode: 'apply', previewId: checked.id, confirmed: true, input: { usernames: ['manual.First'], tenant: 'south', refundable: 1 } }) });
  assert.equal(changedTenant.status, 409);
  fixture.state.deposits.push({ username: 'manual.First', key: '999', subscriberId: '10', isCovered: 0, isBundled: 0, refundable: 0 });
  const apply = await app.request('/api/executions', { method: 'POST', body: request({ mode: 'apply', previewId: checked.id, confirmed: true }) });
  const final = await app.finish(apply.data.execution.id, { timeout: 12000 });
  assert.equal(final.status, 'partial');
  assert.equal(final.report.results[0].error.code, 'PREVIEW_CHANGED');
  assert.equal(dispatched[1].approvedDeposits[0].rows.length, 4);
  assert.equal(fixture.state.events.filter(event => event.action === 'save').length, 0);
  assert.equal(fixture.state.events.filter(event => event.action.startsWith('sheet-')).length, 0);
});

test('Procare subscriber synchronization validates dashboard input, previews without syncing and applies once per subscriber', { timeout: 45000 }, async t => {
  const browser = await testBrowser(); t.after(() => browser.close());
  const syncEvents = [];
  const app = await startDashboard({ execute: async (job, callbacks) => { const result = await procareSyncWebExecutor(browser, job, callbacks); syncEvents.push(...result.events); return { exitCode: result.exitCode }; } });
  t.after(() => app.dispose());
  for (const [body, code] of [
    [{ taskId: 'procare-subscriber-synchronization', environment: 'staging', input: { usernames: ['sync.one'] } }, 'ENVIRONMENT_DISABLED'],
    [{ taskId: 'procare-subscriber-synchronization', environment: 'production', input: { usernames: [] } }, 'INVALID_USERNAMES'],
    [{ taskId: 'procare-subscriber-synchronization', environment: 'production', input: { usernames: Array.from({ length: 101 }, (_, i) => `user${i}`) } }, 'INVALID_USERNAMES'],
    [{ taskId: 'procare-subscriber-synchronization', environment: 'production', input: { usernames: ['sync.one'], workbook: '/etc/passwd' } }, null],
    [{ taskId: 'procare-subscriber-synchronization', environment: 'production', input: { usernames: [42] } }, 'INVALID_USERNAMES']
  ]) {
    const response = await app.request('/api/executions', { method: 'POST', body: requestBody(body) });
    assert.equal(response.status, 400, response.text);
    if (code) assert.equal(response.data.error.code, code);
  }
  const input = { usernames: ['sync.one', '000123', 'sync.one'] };
  const preview = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'procare-subscriber-synchronization', environment: 'production', input }) });
  assert.equal(preview.status, 202, preview.text);
  assert.deepEqual(preview.data.execution.input.usernames, ['sync.one', '000123']);
  const reviewed = await app.finish(preview.data.execution.id, { timeout: 15000 });
  assert.equal(reviewed.status, 'succeeded', JSON.stringify(reviewed.error));
  assert.equal(reviewed.canApply, true);
  assert.deepEqual(reviewed.records.map(row => row.outcome), ['WOULD_SYNCHRONIZE', 'WOULD_SYNCHRONIZE']);
  assert.equal(syncEvents.filter(event => event.action === 'synchronize').length, 0);
  assert.equal(reviewed.cleanup.results[0].outcome, 'SIGNED_OUT_VERIFIED');
  const apply = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'procare-subscriber-synchronization', environment: 'production', mode: 'apply', input: { usernames: ['sync.one', '000123'] }, previewId: reviewed.id, confirmed: true }) });
  assert.equal(apply.status, 202, apply.text);
  const done = await app.finish(apply.data.execution.id, { timeout: 15000 });
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(done.records.map(row => row.outcome), ['SYNC_RESPONSE_VERIFIED', 'SYNC_RESPONSE_VERIFIED']);
  assert.ok(done.records.every(row => row.saveAttempted));
  assert.deepEqual(syncEvents.filter(event => event.action === 'synchronize').map(event => event.username), ['sync.one', '000123']);
  assert.equal(done.progress.completed, 2); assert.equal(done.progress.failed, 0);
  assert.ok(done.events.some(event => event.stage === 'saving' && event.currentRecord === '000123'));
  assert.equal((await app.request(done.artifacts.find(item => item.name === 'report.csv').url)).status, 200);
  const reused = await app.request('/api/executions', { method: 'POST', body: requestBody({ taskId: 'procare-subscriber-synchronization', environment: 'production', mode: 'apply', input: { usernames: ['sync.one', '000123'] }, previewId: reviewed.id, confirmed: true }) });
  assert.equal(reused.status, 409);
});
