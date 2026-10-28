import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
async function check(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (entry.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
for (const directory of ['src', 'tests', 'scripts']) await check(directory);
console.log('JavaScript syntax checks passed.');
