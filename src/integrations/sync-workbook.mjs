import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StopError } from '../utils.mjs';

const script = fileURLToPath(new URL('../../scripts/sync-workbook.py', import.meta.url));
function workbookCommand(request) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [script], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new StopError('WORKBOOK', stderr.trim() || error.message));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function loadSyncWorkbook(filename, { limit } = {}) {
  const book = await workbookCommand({ operation: 'read', path: path.resolve(filename) });
  const uncertain = book.records.filter(row => /^(SYNC_STARTED_UNVERIFIED|SYNC_UNVERIFIED)\b/.test(row.status));
  if (uncertain.length) throw new StopError('WORKBOOK_REVIEW_REQUIRED', 'The workbook contains uncertain earlier synchronization attempts. Review their reports before clearing those Status cells for another run.');
  let pending = book.records.filter(row => !/^(SYNCHRONIZED|USER_NOT_FOUND)\b/.test(row.status));
  if (!pending.length) throw new StopError('WORKBOOK_COMPLETE', 'No pending usernames remain in this workbook.');
  if (limit !== undefined) {
    const max = parseInt(limit, 10);
    if (!Number.isInteger(max) || max < 1) throw new StopError('LIMIT', 'Limit must be a positive integer.');
    const selectedUsers = new Set();
    const limitedPending = [];
    for (const row of pending) {
      if (!selectedUsers.has(row.username)) {
        if (selectedUsers.size >= max) break;
        selectedUsers.add(row.username);
      }
      limitedPending.push(row);
    }
    pending = limitedPending;
  }
  const source = { kind: 'xlsx', path: book.path, sha256: book.sha256, tab: book.tab,
    range: `${book.usernameColumn}${pending[0].row}:${book.usernameColumn}${pending.at(-1).row}`, checkedAt: new Date().toISOString() };
  const snapshot = { tenant: 'north', source, usernames: [...new Set(pending.map(row => row.username))] };
  let expectedHash = book.sha256;
  const previous = new Map(book.records.map(row => [row.cell, row.status]));
  return { snapshot, book, pending,
    async backup(directory) {
      const destination = path.join(directory, 'workbook-before-run.xlsx');
      await fs.copyFile(book.path, destination, fs.constants.COPYFILE_EXCL);
      await fs.chmod(destination, 0o600);
      return destination;
    },
    async checkpoint(report) {
      const updates = [];
      for (const result of report.results) {
        if (['NOT_PROCESSED', 'WOULD_SYNCHRONIZE'].includes(result.outcome)) continue;
        const status = result.outcome === 'SYNC_RESPONSE_VERIFIED'
          ? `SYNCHRONIZED — Procare response verified — ${result.finishedAt}`
          : `${result.outcome}${result.error ? ': ' + result.error.message : ''}`;
        for (const row of pending.filter(row => row.username === result.username)) {
          if (previous.get(row.cell) !== status) updates.push({ cell: row.cell, username: row.username, status });
        }
      }
      if (!updates.length) return;
      const saved = await workbookCommand({ operation: 'write', path: book.path, expectedHash, updates });
      expectedHash = saved.sha256;
      for (const update of updates) previous.set(update.cell, update.status);
    }
  };
}
