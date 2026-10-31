import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../src/web/server.mjs';
import { saveReport } from '../src/utils.mjs';

export const TEST_TOKEN = 'offline-dashboard-fixture-token-32-characters-minimum';
export const repository = fileURLToPath(new URL('../', import.meta.url));
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export function requestBody(overrides = {}) {
  return { taskId: 'erp-deactivation', environment: 'staging', mode: 'preview',
    input: { partner: 'Fixture Partner', pagination: 'auto' }, idempotencyKey: crypto.randomUUID(), ...overrides };
}
export async function fixtureExecutor(job, { onEvent }) {
  await onEvent({ type: 'stage', stage: 'processing', message: 'Checking synthetic records', currentRecord: 'fixture.alpha' });
  const report = { task: job.taskId, environment: job.input.environment, mode: job.input.apply ? 'apply' : 'dry-run',
    partner: { id: 'fixture-42', name: job.input.partner || 'Fixture Partner' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'COMPLETED',
    results: [{ username: 'fixture.alpha', outcome: job.input.apply ? 'DEACTIVATED_VERIFIED' : 'DRY_RUN_ACTIVE', before: 'Active', after: job.input.apply ? 'Inactive' : 'Active', saveAttempted: job.input.apply, message: 'Offline fixture only.' },
      { username: 'fixture.beta', outcome: 'ALREADY_INACTIVE', before: 'Inactive', after: 'Inactive', saveAttempted: false }],
    cleanup: { status: 'COMPLETED', results: [{ application: 'fixture', outcome: 'SIGNED_OUT_VERIFIED' }] } };
  await saveReport(job.outputDir, report);
  await onEvent({ type: 'checkpoint' });
  return { exitCode: 0 };
}
export async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-dashboard-test-'));
  await fs.cp(path.join(repository, 'config'), path.join(root, 'config'), { recursive: true });
  return root;
}
export async function startDashboard({ root, execute = fixtureExecutor, login = true } = {}) {
  const ownsRoot = !root;
  root ||= await makeRoot();
  const app = await createDashboardServer({ root, token: TEST_TOKEN, ...(execute === null ? {} : { execute }), staticDir: path.join(repository, 'web') });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrfToken = '';
  const request = async (pathname, { method = 'GET', body, headers = {}, authenticated = true } = {}) => {
    const mutation = !['GET', 'HEAD'].includes(method);
    const response = await fetch(`${base}${pathname}`, { method, headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(mutation ? { Origin: base, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' } : {}), ...headers
    }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data, text };
  };
  const signIn = async () => {
    const result = await request('/api/session', { method: 'POST', authenticated: false, body: { token: TEST_TOKEN } });
    if (result.status !== 200) throw new Error(`Fixture login failed: ${result.text}`);
    cookie = result.headers.get('set-cookie').split(';')[0]; csrfToken = result.data.csrfToken;
    return result;
  };
  if (login) await signIn();
  return { ...app, root, base, request, signIn,
    async finish(id, { timeout = 5000 } = {}) {
      const deadline = Date.now() + timeout;
      let detail;
      do {
        const response = await request(`/api/executions/${id}`);
        if (response.status !== 200) throw new Error(response.text);
        detail = response.data.execution;
        if (!['queued', 'running', 'waiting_for_operator'].includes(detail.status)) {
          await app.manager.activePromise;
          return (await request(`/api/executions/${id}`)).data.execution;
        }
        await pause(20);
      } while (Date.now() < deadline);
      throw new Error(`Execution did not finish: ${JSON.stringify(detail)}`);
    },
    async dispose() {
      await app.close();
      if (ownsRoot) await fs.rm(root, { recursive: true, force: true });
    }
  };
}
