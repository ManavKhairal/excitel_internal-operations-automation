import { StopError, clean } from '../utils.mjs';

const headerKey = value => clean(value).toLowerCase().replace(/[\s_]+/g, '');
export function columnName(index) {
  let value = index + 1, name = '';
  while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
  return name;
}
const quoteTab = name => `'${name.replaceAll("'", "''")}'`;
function findHeaders(rows, expected) {
  const matches = [];
  rows.forEach((row, rowIndex) => {
    const columns = expected.map(aliases => row.map((value, index) => aliases.includes(headerKey(value)) ? index : -1).filter(index => index >= 0));
    if (columns.every(indices => indices.length === 1)) matches.push({ row: rowIndex + 1, columns: columns.map(indices => indices[0]) });
  });
  if (matches.length !== 1) throw new StopError('SHEET_HEADERS', 'Could not uniquely identify the required sheet header row and columns.');
  return matches[0];
}

export class DepositSheets {
  constructor(transport, config) { this.transport = transport; this.config = config; this.members = null; }
  async sheet(name) {
    const metadata = await this.transport.metadata();
    const matches = metadata.sheets.map(sheet => sheet.properties).filter(sheet => sheet.title === name && !sheet.hidden);
    if (matches.length !== 1) throw new StopError('SHEET_TAB', `Required visible tab missing or ambiguous: ${name}.`);
    const sheet = matches[0];
    if (!sheet.gridProperties || sheet.gridProperties.rowCount > 100000 || sheet.gridProperties.columnCount > 100) throw new StopError('SHEET_SIZE', 'Sheet dimensions exceed the reviewed read limits.');
    return sheet;
  }
  async sourceMembers(name) {
    const sheet = await this.sheet(name);
    const { row, columns: [column] } = findHeaders(await this.transport.read(name, `A1:${columnName(sheet.gridProperties.columnCount - 1)}${Math.min(10, sheet.gridProperties.rowCount)}`), [['username', 'userid']]);
    const members = new Set();
    // Read only the identified username column. Do not scan reverted tabs for eligibility.
    for (let first = row + 1; first <= sheet.gridProperties.rowCount; first += 2000) {
      const values = await this.transport.read(name, `${columnName(column)}${first}:${columnName(column)}${Math.min(first + 1999, sheet.gridProperties.rowCount)}`);
      for (const cells of values) if (cells[0] != null) members.add(String(cells[0]).trim());
    }
    return members;
  }
  async membership(username) {
    if (!this.members) {
      const north = await this.sourceMembers(this.config.sheets.north.source);
      const south = await this.sourceMembers(this.config.sheets.south.source);
      this.members = { north, south };
    }
    return { north: this.members.north.has(username), south: this.members.south.has(username) };
  }
  async recordCompletion(tenant, username, date) {
    const name = this.config.sheets[tenant]?.completion;
    if (!name) throw new StopError('INVALID_TENANT', 'Unknown completion tenant.');
    const sheet = await this.sheet(name);
    const header = findHeaders(await this.transport.read(name, `A1:${columnName(sheet.gridProperties.columnCount - 1)}${Math.min(10, sheet.gridProperties.rowCount)}`), [['username', 'userid'], ['refundable'], ['date']]);
    const [userColumn, refundableColumn, dateColumn] = header.columns;
    // Do not guess how append should interact with extra columns or non-adjacent fields.
    if (userColumn !== 0 || refundableColumn !== 1 || dateColumn !== 2) throw new StopError('COMPLETION_LAYOUT', 'Completion append requires reviewed Username/Refundable/Date columns A/B/C.');
    const find = async () => {
      const fresh = await this.sheet(name);
      const matches = [];
      for (let first = header.row + 1; first <= fresh.gridProperties.rowCount; first += 2000) {
        const values = await this.transport.read(name, `A${first}:C${Math.min(first + 1999, fresh.gridProperties.rowCount)}`);
        for (const cells of values) if (String(cells[0] ?? '').trim() === username && cells[1] === 'YES' && cells[2] === date) matches.push(cells);
      }
      if (matches.length > 1) throw new StopError('DUPLICATE_COMPLETION', 'Multiple completion entries already exist for this username and date.');
      return matches.length === 1;
    };
    if (await find()) return 'ALREADY_RECORDED';
    // RAW values are required by transports so usernames cannot become formulas.
    // Never retry append after a timeout. A reviewed recovery first re-reads entries.
    await this.transport.append(name, header.row, [username, 'YES', date]);
    if (!await find()) throw new StopError('SHEET_UNVERIFIED', 'The appended completion entry was not found on readback.');
    return 'RECORDED_VERIFIED';
  }
}

// Live transport is read-only in this phase, independent of caller flags.
export function googleSheetsTransport(config, { accessToken, fetchImpl = fetch } = {}) {
  if (!accessToken) throw new StopError('SHEETS_AUTH_REQUIRED', 'Set GOOGLE_SHEETS_ACCESS_TOKEN locally for a later authorized read-only preview. ChatGPT connector credentials are not available to this script.');
  if (!/^[A-Za-z0-9_-]+$/.test(config.spreadsheetId)) throw new StopError('SHEETS_CONFIG', 'Invalid spreadsheet ID.');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}`;
  const get = async url => {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) }); }
    catch { throw new StopError('SHEETS_NETWORK', 'Google Sheets read failed or timed out. No writes were attempted.'); }
    if (!response.ok) throw new StopError(response.status === 401 || response.status === 403 ? 'SHEETS_ACCESS_DENIED' : 'SHEETS_READ_FAILED', `Google Sheets returned HTTP ${response.status}. Check authorization and file access.`);
    return response.json();
  };
  return {
    metadata: () => get(base + '?fields=sheets.properties'),
    read: async (name, range) => (await get(base + '/values/' + encodeURIComponent(quoteTab(name) + '!' + range) + '?valueRenderOption=FORMATTED_VALUE')).values || [],
    append: async () => { throw new StopError('LIVE_WRITES_DISABLED', 'Live Google Sheets writes are disabled until production execution is explicitly authorized and reviewed.'); }
  };
}
