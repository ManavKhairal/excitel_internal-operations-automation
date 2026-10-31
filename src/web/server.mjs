import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { taskCatalog } from '../task-registry.mjs';
import { ExecutionManager } from './executions.mjs';
import { dashboardToken, equalSecret, HttpError, onlyKeys, safeError } from './security.mjs';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const SESSION_MS = 12 * 60 * 60 * 1000;
const cookieValue = request => (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('automation_session='))?.slice('automation_session='.length);
function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}
async function bodyOf(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(415, 'JSON_REQUIRED', 'Use application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24000) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request exceeds 24 KB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INVALID_JSON', 'Provide valid JSON.'); }
}

export async function createDashboardServer({ root = projectRoot, token, execute, staticDir = path.join(projectRoot, 'web') } = {}) {
  root = path.resolve(root);
  token ||= await dashboardToken(root);
  if (typeof token !== 'string' || token.length < 32) throw new Error('Dashboard access requires a token of at least 32 characters.');
  const manager = new ExecutionManager({ root, execute });
  await manager.init();
  const sessions = new Map();
  let failedLogins = [], loginBlockedUntil = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(request.headers.host)) throw new HttpError(403, 'HOST_REJECTED', 'Access this dashboard through localhost.');
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not permitted.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-site requests are not permitted.');
      const url = new URL(request.url, origin);
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
        const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
        const asset = assets[pathname];
        if (!asset) throw new HttpError(404, 'NOT_FOUND', 'Page not found.');
        const content = await fs.readFile(path.join(staticDir, asset[0]));
        response.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      const mutation = !['GET', 'HEAD'].includes(request.method);
      if (mutation && request.headers.origin !== origin) throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required.');
      if (pathname === '/api/session' && request.method === 'POST') {
        const body = await bodyOf(request); onlyKeys(body, ['token']);
        if (Date.now() < loginBlockedUntil) throw new HttpError(429, 'LOGIN_RATE_LIMIT', 'Too many login attempts. Wait one minute and try again.');
        if (typeof body.token !== 'string' || !equalSecret(body.token, token)) {
          failedLogins = failedLogins.filter(time => Date.now() - time < 60000); failedLogins.push(Date.now());
          if (failedLogins.length >= 10) loginBlockedUntil = Date.now() + 60000;
          await manager.audit('session.login_failed');
          throw new HttpError(401, 'UNAUTHORIZED', 'The dashboard access token is incorrect.');
        }
        failedLogins = [];
        for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.delete(cookieValue(request));
        const id = crypto.randomBytes(32).toString('base64url'), csrfToken = crypto.randomBytes(32).toString('base64url');
        sessions.set(id, { csrfToken, expires: Date.now() + SESSION_MS });
        await manager.audit('session.login');
        return json(response, 200, { authenticated: true, csrfToken }, { 'Set-Cookie': `automation_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      const sessionId = cookieValue(request), session = sessions.get(sessionId);
      if (!session || session.expires < Date.now()) { sessions.delete(sessionId); throw new HttpError(401, 'UNAUTHORIZED', 'Sign in with the local dashboard access token.'); }
      if (mutation && !equalSecret(request.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'CSRF_REJECTED', 'Your session could not authorize this action. Reload and try again.');
      if (pathname === '/api/session' && request.method === 'GET') return json(response, 200, { authenticated: true, csrfToken: session.csrfToken });
      if (pathname === '/api/session' && request.method === 'DELETE') {
        sessions.delete(sessionId); await manager.audit('session.logout');
        return json(response, 200, { authenticated: false }, { 'Set-Cookie': 'automation_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (pathname === '/api/tasks' && request.method === 'GET') return json(response, 200, { tasks: taskCatalog });
      if (pathname === '/api/settings' && request.method === 'GET') return json(response, 200, { settings: await manager.getSettings() });
      if (pathname === '/api/settings' && request.method === 'PATCH') return json(response, 200, { settings: await manager.updateSettings(await bodyOf(request)) });
      if (pathname === '/api/executions' && request.method === 'GET') {
        const filters = Object.fromEntries(url.searchParams);
        onlyKeys(filters, ['task', 'status', 'environment', 'from', 'to']);
        for (const key of ['from', 'to']) if (filters[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(filters[key]) || Number.isNaN(Date.parse(filters[key])))) throw new HttpError(400, 'INVALID_DATE', 'Use a valid YYYY-MM-DD date.');
        if (filters.from && filters.to && filters.from > filters.to) throw new HttpError(400, 'INVALID_DATE', 'The end date must be on or after the start date.');
        return json(response, 200, { executions: await manager.list(filters) });
      }
      if (pathname === '/api/executions' && request.method === 'POST') {
        const result = await manager.create(await bodyOf(request));
        return json(response, result.replay ? 200 : 202, { execution: result.execution });
      }
      const match = pathname.match(/^\/api\/executions\/([a-zA-Z0-9-]{1,100})(?:\/(continue|artifacts)(?:\/([^/]+))?)?$/);
      if (match) {
        const [, id, operation, encodedName] = match;
        if (!operation && request.method === 'GET') return json(response, 200, { execution: await manager.detail(id) });
        if (operation === 'continue' && request.method === 'POST') {
          const body = await bodyOf(request); onlyKeys(body, ['promptId']);
          return json(response, 200, { execution: await manager.continue(id, body.promptId) });
        }
        if (operation === 'artifacts' && encodedName && request.method === 'GET') {
          let name; try { name = decodeURIComponent(encodedName); } catch { throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.'); }
          const artifact = await manager.artifact(id, name);
          const types = { json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8', image: 'image/png' };
          response.writeHead(200, { 'Content-Type': types[artifact.type], 'Content-Disposition': `${artifact.type === 'image' ? 'inline' : 'attachment'}; filename="${artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"` });
          return response.end(artifact.body);
        }
      }
      throw new HttpError(404, 'NOT_FOUND', 'API endpoint not found.');
    } catch (error) {
      if (response.headersSent) return response.end();
      const status = error instanceof HttpError ? error.status : ['ENOENT', 'ELOOP'].includes(error.code) ? 404 : 500;
      const detail = error instanceof HttpError ? safeError(error) : { code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR', message: status === 404 ? 'Resource not found.' : 'The server could not complete this request. Check local configuration and storage permissions.' };
      json(response, status, { error: detail });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const close = async () => {
    await manager.shutdown();
    if (!server.listening) return;
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  };
  return { server, manager, close };
}
