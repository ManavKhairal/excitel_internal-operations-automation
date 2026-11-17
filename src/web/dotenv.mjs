import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// The dashboard reads .env once at startup, but operators edit credentials while it
// runs. Values that came from .env are therefore NOT passed to automation workers:
// each worker reads .env itself, so a run always uses the file's current values.
// Variables set in the real shell environment are still inherited and take precedence.
const fromFile = new Set();
const defaultFile = fileURLToPath(new URL('../../.env', import.meta.url));

function readEnvFile(file) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function loadDashboardEnv(file = defaultFile) {
  for (const [key, value] of Object.entries(readEnvFile(file))) {
    if (process.env[key] === undefined) { process.env[key] = value; fromFile.add(key); }
  }
}

export function workerEnvironment() {
  const env = { ...process.env };
  for (const key of fromFile) delete env[key];
  return env;
}

// Current secret values from .env, re-read only when the file changes, so redaction
// also covers passwords added after the dashboard started.
let cache = { file: null, mtimeMs: -1, values: [] };
export function currentFileSecrets(file = defaultFile) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return []; }
  if (cache.file !== file || cache.mtimeMs !== mtimeMs) {
    let parsed = {};
    try { parsed = readEnvFile(file); } catch {}
    cache = { file, mtimeMs, values: Object.entries(parsed).filter(([key, value]) => /PASSWORD|TOKEN|SECRET|API_KEY|COOKIE/i.test(key) && value).map(([, value]) => value) };
  }
  return cache.values;
}
