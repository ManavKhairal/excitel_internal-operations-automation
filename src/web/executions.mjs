import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, hash, privateDir, writeJson, timestamp } from '../utils.mjs';
import { taskCatalog } from '../task-registry.mjs';
import { validateRequest } from './validation.mjs';
import { HttpError, onlyKeys, privateStorage, redact, safeError } from './security.mjs';
import { workerEnvironment } from './dotenv.mjs';
import { artifactsOf, cleanupOf, progressOf, readArtifact, readJson, recordsOf, sanitizeReport, statusOf } from './reports.mjs';

const ACTIVE = new Set(['queued', 'running', 'waiting_for_operator']);
const now = () => new Date().toISOString();
const taskName = id => taskCatalog.find(task => task.id === id)?.name || id || 'Legacy execution';

export function runWorker(job, { onEvent, ask, onSpawn }) {
  return new Promise((resolve, reject) => {
    // A fixed JS entry point, never a shell or user-selected executable. A separate
    // process group lets the server drain on Ctrl+C without interrupting a Save.
    const worker = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], { detached: true, execArgv: [], env: workerEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result, failure, events = Promise.resolve();
    worker.on('message', message => {
      if (message.type === 'event') events = events.then(() => onEvent(message.event)).catch(error => { failure ||= error; });
      if (message.type === 'prompt') {
        events.then(() => ask(message.message)).then(() => {
          if (worker.connected) worker.send({ type: 'answer', id: message.id });
        }, error => {
          if (worker.connected) worker.send({ type: 'answer', id: message.id, error: safeError(error) });
        });
      }
      if (message.type === 'done') result = { exitCode: message.exitCode ?? 0 };
      if (message.type === 'failed') failure = Object.assign(new Error(message.message || 'Automation failed.'), { code: message.code || 'EXECUTION_FAILED' });
    });
    worker.once('error', reject);
    worker.once('exit', async (code, signal) => {
      await events;
      if (failure) reject(failure);
      else if (result && !signal) resolve(result);
      else reject(Object.assign(new Error('The worker stopped unexpectedly. Review checkpoints and verify any attempted changes before retrying.'), { code: 'WORKER_INTERRUPTED' }));
    });
    Promise.resolve(onSpawn?.(worker.pid)).catch(() => {});
    worker.send({ type: 'start', ...job });
  });
}

export class ExecutionManager {
  constructor({ root, execute = runWorker }) {
    this.root = root; this.execute = execute; this.executions = new Map(); this.activeId = null;
    this.creation = Promise.resolve(); this.writes = new Map(); this.pendingPrompt = null; this.activePromise = null; this.closing = false;
  }
  async init() {
    this.stateDir = await privateStorage(this.root, '.state');
    this.outputDir = await privateStorage(this.root, 'output');
    const staging = await readJson(path.join(this.root, 'config'), 'staging.json');
    const deposit = await readJson(path.join(this.root, 'config'), 'deposit-refundability.json');
    this.maxUsers = deposit?.maxUsers || 20;
    const saved = await readJson(this.stateDir, 'dashboard-settings.json');
    this.settings = { screenshots: saved?.screenshots ?? staging?.screenshots ?? true, demoHeadless: saved?.demoHeadless ?? deposit?.headless ?? false };
    await this.scan(true);
  }
  async audit(action, detail = {}) {
    await fs.appendFile(path.join(this.stateDir, 'dashboard-audit.jsonl'), JSON.stringify({ time: now(), actor: 'local-operator', action, ...detail }) + '\n', { mode: 0o600 });
  }
  async persist(execution) {
    const { directory, ...data } = execution;
    const snapshot = structuredClone(data);
    const pending = (this.writes.get(execution.id) || Promise.resolve()).then(() => writeJson(path.join(directory, 'execution.json'), snapshot));
    this.writes.set(execution.id, pending.catch(() => {}));
    await pending;
  }
  async scan(recover = false) {
    for (const entry of await fs.readdir(this.outputDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.outputDir, entry.name);
      const metadata = await readJson(directory, 'execution.json');
      if (metadata?.source === 'web' && typeof metadata.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(metadata.id)) {
        if (this.executions.has(metadata.id)) continue;
        const execution = { ...metadata, directory, events: metadata.events || [] };
        if (recover && ACTIVE.has(execution.status)) {
          execution.status = 'interrupted'; execution.stage = 'Operator review required'; execution.prompt = null; execution.finishedAt = now();
          execution.error = { code: 'SERVER_INTERRUPTED', message: 'The server restarted while this execution was active. The worker may still be running. Review its report before retrying. If no automation process remains, the next run clears the old lock automatically.' };
          await this.persist(execution);
          await this.audit('execution.recovery_required', { executionId: execution.id });
        }
        this.executions.set(execution.id, execution);
        continue;
      }
      const report = await readJson(directory, 'report.json');
      const error = await readJson(directory, 'error.json');
      if (!report && !error) continue;
      const id = `legacy-${hash(entry.name).slice(0, 20)}`;
      const stat = await fs.stat(directory);
      const taskId = report?.task || (report?.partner ? 'erp-deactivation' : entry.name.includes('deposit') ? 'deposit-refundability' : entry.name.includes('procare-sync') ? 'procare-subscriber-synchronization' : 'unknown');
      const input = taskId === 'erp-deactivation' ? { partner: report?.partner?.name || '', pagination: 'auto' }
        : taskId === 'workforce-access' ? {
          usernames: [...new Set(report?.results?.map(row => row.username).filter(Boolean) || [])],
          tenant: [...new Set(report?.results?.map(row => row.tenant).filter(Boolean) || [])].length === 2 ? 'both' : report?.results?.[0]?.tenant || '',
          action: report?.action || 'grant'
        } : taskId === 'procare-subscriber-synchronization' ? { usernames: report?.results?.map(row => row.username).filter(Boolean) || [], tenant: report?.tenant || 'north' }
        : { usernames: report?.results?.map(row => row.username).filter(Boolean) || [], refundable: report?.targetRefundable ?? 1 };
      this.executions.set(id, { id, directory, taskId, taskName: taskName(taskId), input, environment: report?.environment || 'unknown',
        mode: report?.mode === 'apply' ? 'apply' : 'preview', status: report ? statusOf(report) : 'failed', source: 'cli',
        createdAt: report?.startedAt || stat.birthtime.toISOString(), startedAt: report?.startedAt || null, finishedAt: report?.finishedAt || null,
        stage: report?.status || 'Stopped before report creation', events: [], error: error ? safeError(error) : null, prompt: null });
    }
  }
  async summary(execution) {
    const report = await readJson(execution.directory, 'report.json');
    return { id: execution.id, taskId: execution.taskId, taskName: taskName(execution.taskId), environment: execution.environment, mode: execution.mode,
      status: execution.status, createdAt: execution.createdAt, startedAt: execution.startedAt, finishedAt: execution.finishedAt, stage: redact(execution.stage),
      input: execution.input, progress: progressOf(report), error: execution.error ? safeError(execution.error) : null, source: execution.source, direct: execution.direct === true };
  }
  async list(filters = {}) {
    await this.scan();
    const executions = [...this.executions.values()].filter(execution =>
      (!filters.task || execution.taskId === filters.task) && (!filters.status || execution.status === filters.status) &&
      (!filters.environment || execution.environment === filters.environment) &&
      (!filters.from || execution.createdAt.slice(0, 10) >= filters.from) && (!filters.to || execution.createdAt.slice(0, 10) <= filters.to))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(executions.map(execution => this.summary(execution)));
  }
  async find(id) {
    if (!this.executions.has(id)) await this.scan();
    const execution = this.executions.get(id);
    if (!execution) throw new HttpError(404, 'NOT_FOUND', 'Execution not found.');
    return execution;
  }
  eligiblePreview(execution) {
    return execution.source === 'web' && execution.mode === 'preview' && ['succeeded', 'skipped'].includes(execution.status) &&
      Date.now() - Date.parse(execution.finishedAt) < 60 * 60 * 1000 && ![...this.executions.values()].some(item => item.previewId === execution.id);
  }
  async detail(id) {
    const execution = await this.find(id);
    const report = sanitizeReport(await readJson(execution.directory, 'report.json'));
    return { ...await this.summary(execution), events: execution.events || [], prompt: execution.prompt || null,
      report, records: recordsOf(report), artifacts: await artifactsOf(execution.directory, id, this.settings.screenshots),
      cleanup: cleanupOf(report, sanitizeReport(await readJson(execution.directory, 'logout.json'))),
      canApply: this.eligiblePreview(execution) && !this.activeId && !this.closing };
  }
  async serialize(operation) {
    const previous = this.creation;
    let release;
    this.creation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  async create(body) {
    return this.serialize(() => this.createLocked(body));
  }
  async createLocked(body) {
    if (this.closing) throw new HttpError(503, 'SHUTTING_DOWN', 'The server is finishing its current execution and shutting down.');
    const request = validateRequest(body, this.maxUsers);
    await this.scan();
    const keyHash = hash(request.idempotencyKey);
    const requestHash = hash({ taskId: request.taskId, input: request.input, mode: request.mode, environment: request.environment, previewId: request.previewId, direct: request.direct });
    const previous = [...this.executions.values()].find(execution => execution.keyHash === keyHash);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'This request key was already used for different inputs.');
      return { execution: await this.detail(previous.id), replay: true };
    }
    if (this.activeId) throw new HttpError(409, 'LOCKED', 'An execution is already active. Wait for its report before starting another.');
    if (request.mode === 'apply' && !request.direct) {
      const preview = await this.find(request.previewId);
      if (!this.eligiblePreview(preview) || preview.taskId !== request.taskId || preview.environment !== request.environment || hash(preview.input) !== hash(request.input)) {
        throw new HttpError(409, 'PREVIEW_REQUIRED', 'Use a successful, unused preview with exactly these inputs from the last hour. Apply rechecks current application state.');
      }
    }
    let releaseLock;
    try { releaseLock = await acquireLock(this.stateDir, { onStaleCleared: previous => this.audit('lock.stale_cleared', { previousPid: previous.pid, previousWorkerPid: previous.workerPid, previousStartedAt: previous.startedAt }) }); }
    catch (error) { if (error.code === 'LOCKED') throw new HttpError(409, 'LOCKED', error.message); throw error; }
    const id = crypto.randomUUID();
    const execution = { id, taskId: request.taskId, taskName: request.task.name, environment: request.environment, mode: request.mode, input: request.input,
      keyHash, requestHash, previewId: request.previewId, ...(request.direct ? { direct: true } : {}), source: 'web', status: 'queued', stage: 'Queued', createdAt: now(), startedAt: null, finishedAt: null,
      error: null, events: [], prompt: null, directory: path.join(this.outputDir, `${timestamp()}-web-${id}`) };
    try {
      await privateDir(execution.directory);
      await this.persist(execution);
      await this.audit(request.direct ? 'execution.direct_apply_confirmed' : request.mode === 'apply' ? 'execution.apply_confirmed' : 'execution.preview_created', { executionId: id, taskId: request.taskId, environment: request.environment, previewId: request.previewId });
      this.executions.set(id, execution); this.activeId = id;
    } catch (error) { await releaseLock(); throw error; }
    this.activePromise = this.run(execution, releaseLock).catch(async error => {
      // A storage failure is visible and does not silently turn uncertainty into success.
      execution.status = 'interrupted'; execution.error = safeError(error); execution.stage = 'Storage error — operator review required';
    });
    return { execution: await this.detail(id), replay: false };
  }
  async event(execution, event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'stage') {
      execution.stage = redact(event.stage || 'Running').slice(0, 120);
      execution.events.push({ time: now(), type: 'stage', stage: execution.stage, message: redact(event.message || '').slice(0, 1000), ...(event.currentRecord ? { currentRecord: redact(event.currentRecord).slice(0, 200) } : {}) });
      execution.events = execution.events.slice(-1000);
    }
    await this.persist(execution);
  }
  async ask(execution, message) {
    if (this.closing) throw Object.assign(new Error('The server is shutting down; operator login was not continued.'), { code: 'LOGIN_REQUIRED' });
    const id = crypto.randomUUID();
    execution.prompt = { id, message: redact(message).slice(0, 1000) };
    execution.status = 'waiting_for_operator'; execution.stage = 'Waiting for manual login / MFA';
    await this.persist(execution);
    await this.audit('execution.operator_required', { executionId: execution.id });
    try {
      if (this.closing) throw Object.assign(new Error('The server is shutting down; operator login was not continued.'), { code: 'LOGIN_REQUIRED' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('Operator login confirmation timed out after 10 minutes.'), { code: 'LOGIN_REQUIRED' })), 10 * 60 * 1000);
        this.pendingPrompt = { executionId: execution.id, id, resolve, reject, timer };
      });
      return '';
    } finally {
      clearTimeout(this.pendingPrompt?.timer); this.pendingPrompt = null;
      execution.prompt = null; execution.status = 'running'; execution.stage = 'Revalidating application session';
      await this.persist(execution);
    }
  }
  async continue(id, promptId) {
    const prompt = this.pendingPrompt;
    if (!prompt || prompt.executionId !== id || prompt.id !== promptId) throw new HttpError(409, 'NO_PENDING_PROMPT', 'This login request has expired or was already continued.');
    await this.audit('execution.operator_continued', { executionId: id });
    prompt.resolve();
    return this.detail(id);
  }
  async run(execution, releaseLock) {
    try {
      execution.status = 'running'; execution.startedAt = now(); execution.stage = 'Starting automation';
      await this.persist(execution);
      const input = { ...execution.input, apply: execution.mode === 'apply', environment: execution.environment, ...(execution.taskId === 'deposit-refundability' ? execution.environment === 'offline-demo' ? { demo: true } : { manual: true } : {}) };
      let approvedDeposits;
      if (execution.environment === 'production-manual' && input.apply) {
        const preview = await this.find(execution.previewId);
        const report = await readJson(preview.directory, 'report.json');
        if (!Array.isArray(report?.results) || report.inputSource !== 'manual' || report.results.length !== input.usernames.length) throw new HttpError(409, 'PREVIEW_REQUIRED', 'The approved deposit preview is unavailable. Run a fresh preview.');
        approvedDeposits = report.results.map(({ username, tenant, rows }) => ({ username, tenant, rows }));
      }
      const result = await this.execute({ taskId: execution.taskId, input, root: this.root, outputDir: execution.directory, settings: { ...this.settings }, ...(approvedDeposits ? { approvedDeposits } : {}) },
        { onEvent: event => this.event(execution, event), ask: message => this.ask(execution, message), onSpawn: pid => releaseLock.setWorker?.(pid) });
      const report = await readJson(execution.directory, 'report.json');
      execution.status = report ? statusOf(report, result?.exitCode || 0) : 'interrupted';
      if (report?.error) execution.error = safeError(report.error);
      if (!report) execution.error = { code: 'REPORT_MISSING', message: 'The worker exited without a readable report. The run lock is retained. Review local diagnostics and attempted changes before retrying.' };
    } catch (error) {
      const report = await readJson(execution.directory, 'report.json');
      const progress = progressOf(report);
      const uncertain = error.code === 'WORKER_INTERRUPTED' || ['IN_PROGRESS', 'RUNNING'].includes(report?.status) ||
        (!report && execution.events.some(event => event.stage === 'saving'));
      execution.status = uncertain ? 'interrupted' : report && (progress?.successful || recordsOf(report).some(row => row.saveAttempted)) ? 'partial' : 'failed';
      execution.error = safeError(error);
    } finally {
      execution.finishedAt = now(); execution.prompt = null;
      execution.stage = ['partial', 'interrupted'].includes(execution.status) ? 'Completed with issues — review required' : execution.status === 'failed' ? 'Execution failed' : 'Execution complete';
      let recorded = false;
      try {
        await this.persist(execution);
        await this.audit('execution.finished', { executionId: execution.id, status: execution.status });
        recorded = true;
      } finally {
        // The normal worker promise resolves only after the child has exited and
        // its browser cleanup has finished. Never cancel it by killing a process.
        if (recorded && execution.status !== 'interrupted') await releaseLock();
        else await releaseLock.preserve();
        this.activeId = null;
      }
    }
  }
  async artifact(id, name) {
    const execution = await this.find(id);
    const artifacts = await artifactsOf(execution.directory, id, this.settings.screenshots);
    const artifact = artifacts.find(item => item.name === name);
    if (!artifact) throw new HttpError(404, 'NOT_FOUND', 'Artifact not found or not permitted.');
    const bytes = await readArtifact(execution.directory, name);
    await this.audit('report.downloaded', { executionId: id, artifact: name });
    const body = artifact.type === 'json' ? JSON.stringify(sanitizeReport(JSON.parse(bytes.toString('utf8'))), null, 2) + '\n' : artifact.type === 'csv' ? redact(bytes.toString('utf8')) : bytes;
    return { body, type: artifact.type, name };
  }
  async getSettings() {
    const applications = [];
    const production = await readJson(path.join(this.root, 'config'), 'production.json');
    const filled = value => typeof value === 'string' && value.trim() !== '';
    for (const [name, label, profile, ready] of [
      ['procare', 'Procare (ERP)', 'procare', true], ['corehr', 'CoreHR (ERP)', 'corehr', true],
      ['procare', 'Procare North (ERP)', 'production-procare-north', filled(production?.origins?.procare?.north)],
      ['procare', 'Procare South (ERP)', 'production-procare-south', filled(production?.origins?.procare?.south)],
      ['corehr', 'CoreHR (ERP)', 'production-corehr', filled(production?.origins?.corehr)]
    ]) {
      const prepared = await fs.stat(path.join(this.stateDir, 'profiles', profile)).then(stat => stat.isDirectory(), () => false);
      applications.push({ name: label, environment: profile.startsWith('production-') ? 'production' : 'staging', available: ready, session: prepared ? 'saved' : 'not_prepared' });
    }
    applications.push({ name: 'Deposit database & Google Sheets', environment: 'offline-demo', available: true, session: 'not_prepared' });
    applications.push({ name: 'Deposit database (manual usernames, no Sheets)', environment: 'production-manual', available: true, session: 'fresh_per_run' });
    applications.push({ name: 'Workforce', environment: 'staging', available: true, session: 'fresh_per_run' });
    applications.push({ name: 'Procare subscriber sync (North)', environment: 'production', available: true, session: 'fresh_per_run' });
    return { ...this.settings, environment: 'staging', productionEnabled: true, depositManualEnabled: true, concurrency: 1, host: '127.0.0.1', operatorTimeoutMinutes: 10, applications };
  }
  async updateSettings(input) {
    return this.serialize(() => this.updateSettingsLocked(input));
  }
  async updateSettingsLocked(input) {
    onlyKeys(input, ['screenshots', 'demoHeadless']);
    if (!Object.keys(input).length || Object.values(input).some(value => typeof value !== 'boolean')) throw new HttpError(400, 'INVALID_SETTINGS', 'Settings must be boolean values.');
    if (this.activeId) throw new HttpError(409, 'LOCKED', 'Wait for the active execution before changing settings.');
    this.settings = { ...this.settings, ...input };
    await writeJson(path.join(this.stateDir, 'dashboard-settings.json'), this.settings);
    await this.audit('settings.updated', { settings: this.settings });
    return this.getSettings();
  }
  async shutdown() {
    this.closing = true;
    await this.creation;
    if (this.pendingPrompt) this.pendingPrompt.reject(Object.assign(new Error('Operator confirmation ended because the server is shutting down.'), { code: 'LOGIN_REQUIRED' }));
    await this.activePromise;
    await Promise.all(this.writes.values());
  }
}
