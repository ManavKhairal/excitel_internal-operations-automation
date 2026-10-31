#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardToken } from '../src/web/security.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
// This explicit local operator command is the only place the access token prints.
// The server does not log tokens, application credentials, cookies or profiles.
console.log(await dashboardToken(root));
