"""Read usernames and patch only Status cells in an XLSX package (stdlib only)."""
import datetime
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
N = {'s': NS}
ET.register_namespace('', NS)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', N)]
        relationships = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        candidates = []
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', N):
            target = relationships[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
            part = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            root = ET.fromstring(z.read(part))
            def value(cell):
                if cell.find('s:f', N) is not None:
                    raise ValueError('Formula in a Username or Status cell is not supported.')
                if cell.get('t') == 'inlineStr':
                    return ''.join(cell.find('s:is', N).itertext())
                v = cell.find('s:v', N)
                text = v.text if v is not None else ''
                return strings[int(text)] if cell.get('t') == 's' else (text or '')
            rows = root.findall('s:sheetData/s:row', N)
            for row in rows[:20]:
                headers = [(c, value(c)) for c in row.findall('s:c', N) if c.find('s:f', N) is None]
                user = [c for c, v in headers if v == 'Username']
                status = [c for c, v in headers if v == 'Status']
                if len(user) == len(status) == 1:
                    uc = re.sub(r'\d', '', user[0].get('r'))
                    sc = re.sub(r'\d', '', status[0].get('r'))
                    records = []
                    for body in rows:
                        nr = int(body.get('r'))
                        if nr <= int(row.get('r')):
                            continue
                        cells = {c.get('r'): c for c in body.findall('s:c', N)}
                        u = cells.get(f'{uc}{nr}')
                        if u is None or not value(u).strip():
                            continue
                        if u.get('t') not in ('s', 'inlineStr'):
                            raise ValueError(f'Username {uc}{nr} must be text to preserve leading zeroes.')
                        status_cell = cells.get(f'{sc}{nr}')
                        records.append({'row': nr, 'username': value(u).strip(), 'status': value(status_cell) if status_cell is not None else '', 'cell': f'{sc}{nr}'})
                    candidates.append({'tab': sheet.get('name'), 'part': part, 'root': root, 'records': records, 'usernameColumn': uc, 'statusColumn': sc})
        if len(candidates) != 1:
            raise ValueError('Expected exactly one worksheet with exact Username and Status headers.')
        return candidates[0]


def main(request):
    path = os.path.realpath(request['path'])
    with open(path, 'rb') as f:
        original = f.read()
    current_hash = digest(original)
    sheet = inspect(original)
    if request['operation'] == 'read':
        return {k: v for k, v in sheet.items() if k not in ('root', 'part')} | {'path': path, 'sha256': current_hash}
    if request['operation'] != 'write' or current_hash != request['expectedHash']:
        raise ValueError('Workbook changed outside this run; stopped to avoid overwriting edits.')
    by_cell = {r['cell']: r for r in sheet['records']}
    updates = {}
    for item in request['updates']:
        if item['cell'] not in by_cell or by_cell[item['cell']]['username'] != item['username']:
            raise ValueError('Workbook row identity changed.')
        if not isinstance(item['status'], str) or len(item['status']) > 2000:
            raise ValueError('Invalid status text.')
        updates[item['cell']] = item['status']
    if not updates:
        return {'sha256': current_hash}
    # Preserve every original ZIP member byte-for-byte except targeted cell XML.
    # Even within the worksheet, patch individual cells without reserializing it.
    with zipfile.ZipFile(io.BytesIO(original)) as source:
        xml = source.read(sheet['part']).decode('utf-8')
        for address, status in updates.items():
            escaped = status.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            pattern = re.compile(r'<c\b(?=[^>]*\br="' + re.escape(address) + r'")[^>]*?(?:/>|>.*?</c>)', re.S)
            old = pattern.search(xml)
            style = re.search(r'\bs="[^"]*"', old.group(0).split('>')[0]) if old else None
            replacement = f'<c r="{address}"' + (f' {style.group(0)}' if style else '') + f' t="inlineStr"><is><t xml:space="preserve">{escaped}</t></is></c>'
            if old:
                xml, count = pattern.subn(lambda _: replacement, xml)
                if count != 1:
                    raise ValueError('Duplicate cell address.')
            else:
                row_number = re.search(r'\d+$', address).group(0)
                row_pattern = re.compile(r'(<row\b(?=[^>]*\br="' + row_number + r'")[^>]*>)(.*?)(</row>)', re.S)
                def add_cell(match):
                    body = match.group(2)
                    def col_number(ref):
                        n = 0
                        for char in re.sub(r'\d', '', ref):
                            n = n * 26 + ord(char) - 64
                        return n
                    position = next((c.start() for c in re.finditer(r'<c\b[^>]*\br="([A-Z]+\d+)"', body) if col_number(c.group(1)) > col_number(address)), len(body))
                    return match.group(1) + body[:position] + replacement + body[position:] + match.group(3)
                xml, count = row_pattern.subn(add_cell, xml)
                if count != 1:
                    raise ValueError('Workbook row is missing or ambiguous.')
        ET.fromstring(xml)  # Validate the complete patched worksheet before saving.
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as target:
            target.comment = source.comment
            for member in source.infolist():
                target.writestr(member, xml.encode('utf-8') if member.filename == sheet['part'] else source.read(member.filename))
    if digest(open(path, 'rb').read()) != current_hash:
        raise ValueError('Workbook changed while preparing status updates.')
    fd, temporary = tempfile.mkstemp(prefix='.sync-status-', suffix='.xlsx', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(output.getvalue())
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temporary, os.stat(path).st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'sha256': digest(output.getvalue())}


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
