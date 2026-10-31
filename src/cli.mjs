#!/usr/bin/env node
import { taskRegistry, selectTask } from './task-registry.mjs';
try {
  const { task, args } = selectTask(process.argv.slice(2));
  process.argv = [...process.argv.slice(0, 2), ...args];
  await taskRegistry[task]();
} catch (error) {
  console.error(`STOPPED: ${error.code || error.name}: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
