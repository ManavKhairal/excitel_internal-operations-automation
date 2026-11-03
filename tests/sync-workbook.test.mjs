import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSyncWorkbook } from '../src/integrations/sync-workbook.mjs';
import { validateSyncInput } from '../src/tasks/procare-subscriber-synchronization.mjs';

async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-workbook-'));
  const file = path.join(directory, 'users.xlsx');
  execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Users" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Username</t></is></c><c r="B1" t="inlineStr"><is><t>status</t></is></c><c r="C1" t="inlineStr"><is><t>Status</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>000123</t></is></c><c r="B2" t="inlineStr"><is><t>Churn</t></is></c><c r="D2"><f>1+1</f><v>2</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>000123</t></is></c><c r="C3" s="1"/></row><row r="4"><c r="A4" t="inlineStr"><is><t>OtherUser</t></is></c></row></sheetData></worksheet>')
 z.writestr('xl/untouched.bin', b'original bytes')
`, file]);
  try { await fn(file, directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('workbook deduplicates text usernames, updates only exact Status cells, and preserves other package parts', async () => fixture(async (file, directory) => {
  const original = await fs.readFile(file);
  const book = await loadSyncWorkbook(file);
  assert.deepEqual(validateSyncInput(book.snapshot).usernames, ['000123', 'OtherUser']);
  assert.equal(book.book.statusColumn, 'C');
  const backup = await book.backup(directory);
  assert.deepEqual(await fs.readFile(backup), original);
  await book.checkpoint({ results: [{ username: '000123', outcome: 'WOULD_SYNCHRONIZE' }] });
  assert.deepEqual(await fs.readFile(file), original);
  await book.checkpoint({ results: [{ username: '000123', outcome: 'SYNC_RESPONSE_VERIFIED', finishedAt: '2026-10-30T12:00:00Z' }] });
  const reloaded = await loadSyncWorkbook(file);
  assert.deepEqual(reloaded.snapshot.usernames, ['OtherUser']);
  assert.equal(reloaded.book.records.filter(r => r.status.startsWith('SYNCHRONIZED')).length, 2);
  execFileSync('python3', ['-c', `import zipfile,sys,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as a, zipfile.ZipFile(sys.argv[2]) as b:
 for name in a.namelist():
  if name != 'xl/worksheets/sheet1.xml': assert a.read(name) == b.read(name)
 root=E.fromstring(b.read('xl/worksheets/sheet1.xml')); n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 assert root.find('.//s:c[@r="B2"]/s:is/s:t',n).text == 'Churn'
 assert root.find('.//s:c[@r="D2"]/s:f',n).text == '1+1'
 assert root.find('.//s:c[@r="C3"]',n).get('s') == '1'
 assert [c.get('r') for c in root.find('.//s:row[@r="2"]',n)] == ['A2','B2','C2','D2']
`, backup, file]);
}));

test('workbook refuses to overwrite external edits and blocks uncertain attempts on restart', async () => fixture(async file => {
  const book = await loadSyncWorkbook(file);
  await book.checkpoint({ results: [{ username: '000123', outcome: 'SYNC_STARTED_UNVERIFIED' }] });
  await assert.rejects(loadSyncWorkbook(file), { code: 'WORKBOOK_REVIEW_REQUIRED' });
  await fs.appendFile(file, 'external edit');
  await assert.rejects(book.checkpoint({ results: [{ username: '000123', outcome: 'SYNC_RESPONSE_VERIFIED', finishedAt: 'now' }] }), /changed outside this run/);
}));

test('workbook respects positive limit option and slices pending users', async () => fixture(async file => {
  const limited = await loadSyncWorkbook(file, { limit: 1 });
  assert.deepEqual(limited.snapshot.usernames, ['000123']);
  await assert.rejects(loadSyncWorkbook(file, { limit: 0 }), { code: 'LIMIT' });
  await assert.rejects(loadSyncWorkbook(file, { limit: 'abc' }), { code: 'LIMIT' });
}));
