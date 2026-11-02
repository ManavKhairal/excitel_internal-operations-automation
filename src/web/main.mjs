#!/usr/bin/env node
import path from 'node:path';
import { createDashboardServer, projectRoot } from './server.mjs';

try {
  try { process.loadEnvFile(path.join(projectRoot, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.DASHBOARD_PORT || 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DASHBOARD_PORT must be an integer between 1024 and 65535.');
  const app = await createDashboardServer();
  app.server.on('error', error => { console.error(`Dashboard could not listen: ${error.code || 'SERVER_ERROR'}.`); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Automation dashboard: http://127.0.0.1:${port}`);
    console.log('Manual live deposits, staging workflows and offline demo are available. Preview and confirmation are required for dashboard apply.');
    console.log('To display your private dashboard access token in a separate terminal: npm run web:token');
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Finishing the active execution and browser cleanup before shutdown. Do not force termination during a write.');
    await app.close();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(`Dashboard startup failed: ${error.code || 'CONFIG'}: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
