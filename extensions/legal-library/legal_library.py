#!/usr/bin/env python3
"""Private, source-linked legal library. Build on the source Mac; query on Home.

Search and deadline checks use only Python's standard library. Extraction uses
the source machine's PyMuPDF, openpyxl, textutil, and Tesseract where needed.
No document content is executed; originals are immutable, content-addressed copies.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from zoneinfo import ZoneInfo
from urllib.parse import quote

EXTENSIONS = {'.pdf', '.docx', '.doc', '.rtf', '.odt', '.md', '.txt', '.html', '.csv', '.xlsx', '.gdoc', '.gsheet', '.pptx'}
SKIP_DIRS = {'node_modules', 'venv', '.venv', '__pycache__', 'tmp', 'previews', 'screenshots', 'evidence', '_проверка', '_источники'}
LEGAL_NAME = re.compile(r'договор|акт[ _-]|contract|agreement|соглашен|оферт|устав|решение|приказ|сч[её]т|invoice|addendum|insurance|legal|налог|аренд', re.I)
# Invalidate only extraction affected by parser fixes, not every cached PDF/OCR.
EXTRACTION_REVISIONS = {'.docx': 2, '.odt': 2, '.pptx': 2}


class BuildUnavailable(ValueError):
    """An incomplete scan must never replace the last good snapshot."""


class IntegrityError(ValueError):
    """An immutable original must not be silently repaired or overwritten."""


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def atomic_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as f:
            temporary = Path(f.name)
            json.dump(value, f, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary: temporary.unlink(missing_ok=True)


def normalize(text):
    return unicodedata.normalize('NFC', text).replace('\x00', '')


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'): self.hidden += 1
        if tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3'): self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'): self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)


def xml_text(data):
    root = ET.fromstring(data)
    # DOCX deleted revisions must not silently become operative clauses.
    def walk(node):
        tag = node.tag.rsplit('}', 1)[-1]
        if tag in ('del', 'delText', 'instrText', 'moveFrom'): return ''
        if tag in ('tab',): return '\t'
        if tag in ('br', 'line-break'): return '\n'
        # ODT paragraphs contain mixed text and spans, unlike DOCX runs.
        result = (node.text or '') + ''.join(walk(child) + (child.tail or '') for child in node)
        return result + ('\n' if tag in ('p', 'tr') else '\t' if tag == 'tc' else '')
    return walk(root)


def extract(path):
    ext = path.suffix.lower()
    if ext in ('.gdoc', '.gsheet'):
        return '', 'online_only', 'Google-native file: open the live Drive source; not a local document.'
    if ext == '.pdf':
        try: import fitz
        except ImportError as error: raise BuildUnavailable('PDF extraction requires PyMuPDF on the source machine') from error
        pages, ocr_pages, empty_pages = [], [], []
        ocr_checked = False
        with fitz.open(path) as doc:
            if doc.needs_pass: raise ValueError('Encrypted PDF requires authorized access')
            for number, page in enumerate(doc, 1):
                text = page.get_text(sort=True)
                if len(re.sub(r'\s', '', text)) < 40:
                    if not ocr_checked:
                        try:
                            languages = subprocess.run(['tesseract', '--list-langs'], check=True, capture_output=True, text=True, timeout=20).stdout.splitlines()
                        except subprocess.SubprocessError as error:
                            raise BuildUnavailable('Cannot verify the Tesseract installation') from error
                        if not {'rus', 'eng'} <= {language.strip() for language in languages}:
                            raise BuildUnavailable('OCR requires Tesseract Russian and English language data')
                        ocr_checked = True
                    with tempfile.TemporaryDirectory(prefix='legal-ocr-') as tmp:
                        image = Path(tmp) / 'page.png'
                        page.get_pixmap(dpi=170).save(str(image))
                        text = subprocess.run(['tesseract', str(image), 'stdout', '-l', 'rus+eng'], check=True,
                                              capture_output=True, text=True, timeout=120).stdout
                        ocr_pages.append(number)
                if not text.strip(): empty_pages.append(number)
                pages.append(f'## Page {number}' + (' (OCR; verify against original)' if number in ocr_pages else '') + '\n' + text)
        note = f'OCR pages: {ocr_pages}.' if ocr_pages else ''
        if empty_pages: note += f' No readable text on pages {empty_pages}; inspect original.'
        return '\n\n'.join(pages), 'needs_review' if empty_pages else 'ready', note
    if ext in ('.docx', '.odt', '.pptx'):
        with zipfile.ZipFile(path) as archive:
            if ext == '.docx':
                names = ['word/document.xml'] + sorted(n for n in archive.namelist() if re.match(r'word/(header\d+|footer\d+|footnotes|endnotes)\.xml$', n))
            elif ext == '.odt': names = ['content.xml']
            else: names = sorted((n for n in archive.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)), key=lambda n: int(re.search(r'(\d+)\.xml$', n)[1]))
            text = '\n\n'.join(f'## {name}\n{xml_text(archive.read(name))}' for name in names)
        return text, 'ready', 'DOCX text includes insertions, excludes deleted revisions; inspect original markup for negotiations.' if ext == '.docx' else ''
    if ext == '.xlsx':
        try: import openpyxl
        except ImportError as error: raise BuildUnavailable('XLSX extraction requires openpyxl on the source machine') from error
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
        try:
            text = '\n\n'.join('## Sheet: ' + sheet.title + '\n' + '\n'.join(
                f'Row {number}: ' + ' | '.join(f'{openpyxl.utils.get_column_letter(i)}={cell}' for i, cell in enumerate(row, 1) if cell is not None)
                for number, row in enumerate(sheet.iter_rows(values_only=True), 1) if any(v is not None for v in row)) for sheet in workbook)
        finally: workbook.close()
        return text, 'ready', 'Formula expressions are preserved; no recalculated amounts are asserted.'
    if ext in ('.doc', '.rtf'):
        text = subprocess.run(['textutil', '-convert', 'txt', '-stdout', str(path)], check=True, capture_output=True, text=True, timeout=60).stdout
        return text, 'ready', ''
    text = path.read_text(encoding='utf-8-sig')
    if ext == '.html':
        parser = PlainHTML(); parser.feed(text); text = ''.join(parser.parts)
    return text, 'ready', ''


def connect(root, filename='library.sqlite'):
    db = sqlite3.connect('file:' + quote(str((root / filename).resolve())) + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def candidates(config):
    sources = config['sources']
    labels = [normalize(s['label']) for s in sources]
    if not sources or len(labels) != len(set(labels)): raise ValueError('Source labels must be present and unique')
    if any(not label or any(part in ('', '.', '..') for part in label.split('/')) for label in labels):
        raise ValueError('Source labels must be stable nonempty names without dot segments')
    if any(a != b and b.startswith(a + '/') for a in labels for b in labels):
        raise ValueError('Source labels must not overlap')
    roots = []
    for source in sources:
        source['label'] = normalize(source['label'])
        root = Path(source['path']).expanduser()
        if not root.is_dir(): raise ValueError(f'Source root unavailable: {source["label"]}')
        roots.append((source, root.resolve(), root.stat()))
    found, seen = [], set()
    def scan_error(error):
        raise BuildUnavailable('Source traversal failed; keep the last good snapshot') from error
    for source, root, before in roots:
        for parent, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS and not (Path(parent) / d).is_symlink())
            for name in sorted(files):
                path = Path(parent) / name
                if name.startswith(('.', '~$')) or path.is_symlink() or path.suffix.lower() not in EXTENSIONS: continue
                if re.match(r'^(подпись|signature|stamp|печать)(?:[ _.-]|$)', normalize(name), re.I): continue
                relative = normalize(path.relative_to(root).as_posix())
                if source.get('legal_only') and not LEGAL_NAME.search(normalize(relative)): continue
                if re.search(r'(^|[/_ -])(passwords?|credentials?|secrets?|tokens?|api[_ -]?keys?)([/_. -]|$)', relative, re.I): continue
                identity = source['label'] + '/' + relative
                if identity in seen: raise ValueError('Two files normalize to the same source identity')
                seen.add(identity)
                found.append((identity, path, {'label': source['label'], 'root': str(root), 'relativePath': relative,
                                              'sourceUri': source.get('uri')}))
        after = root.stat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise BuildUnavailable('Source root changed during traversal')
    return found


def read_source(path):
    # Refuse a symlink swapped in after traversal and a file changed mid-read.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode): raise BuildUnavailable('Source is not a regular file')
        data = stream.read()
        after = os.fstat(stream.fileno())
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if identity(before) != identity(after) or len(data) != after.st_size:
        raise BuildUnavailable('Source changed while reading; retry the scan')
    return data, after


def verify_original(output, original, digest):
    target = output / original
    if target.parent != output / 'originals' or target.is_symlink() or not target.is_file():
        raise IntegrityError('An indexed original is missing or is not a regular library file')
    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise IntegrityError('An immutable original failed checksum verification')


def build(config_path, output):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (output / '.build.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error: raise BuildUnavailable('Another library build is running') from error
        return build_locked(config_path, output)


def build_locked(config_path, output):
    config = json.loads(config_path.read_text())
    files = candidates(config)  # Validate every root before touching the last good index.
    for source in config['sources']:
        root = Path(source['path']).expanduser().resolve()
        if root == output or root in output.parents: raise ValueError('Library output must be outside all source roots')
    (output / 'originals').mkdir(exist_ok=True, mode=0o700)
    if (output / 'originals').is_symlink(): raise IntegrityError('The originals directory must not be a symlink')
    previous, versions, history, extraction_revisions = {}, {}, [], {}
    if (output / 'library.sqlite').exists():
        with connect(output) as old:
            previous = {r['source']: dict(r) for r in old.execute('SELECT * FROM documents')}
            if old.execute("SELECT 1 FROM sqlite_master WHERE name='versions'").fetchone():
                versions = {(r['source'], r['sha256']): dict(r) for r in old.execute('SELECT * FROM versions')}
            if old.execute("SELECT 1 FROM sqlite_master WHERE name='history'").fetchone():
                history = [dict(r) for r in old.execute('SELECT * FROM history ORDER BY sequence')]
            revisions = old.execute('SELECT value FROM metadata WHERE key="extractionRevisions"').fetchone()
            if revisions: extraction_revisions = json.loads(revisions[0])
            old_sources = old.execute('SELECT value FROM metadata WHERE key="sources"').fetchone()
            if old_sources:
                old_policy = {s['label']: bool(s.get('legal_only')) for s in json.loads(old_sources[0])}
                new_policy = {s['label']: bool(s.get('legal_only')) for s in config['sources']}
                if any(new_policy.get(label) != policy for label, policy in old_policy.items()):
                    raise BuildUnavailable('A prior source was omitted or its filter changed; preserve its identity and scan scope')
            for row in previous.values():
                if row['sha256']:
                    versions.setdefault((row['source'], row['sha256']), dict(source=row['source'], sha256=row['sha256'], original=row['original'], firstObservedAt=row['checkedAt']))
    canonical_previous = {normalize(source): source for source in previous}
    if len(canonical_previous) != len(previous):
        raise BuildUnavailable('Existing source names collide after Unicode normalization; reconcile explicitly')
    labels = {s['label'] for s in config['sources']}
    owner = lambda source: next((label for label in labels if normalize(source).startswith(label + '/')), None)
    if any(owner(source) is None for source in previous):
        raise BuildUnavailable('A previously indexed source is outside the configured roots')
    for source in config['sources']:
        label = source['label']
        if not source.get('allow_empty', False) and any(owner(s) == label for s in previous) and not any(p['label'] == label for _, _, p in files):
            raise BuildUnavailable(f'Previously populated source is empty: {label}; verify the mount or explicitly set allow_empty')
    verified = set()
    for row in versions.values():
        if (row['original'], row['sha256']) not in verified:
            verify_original(output, row['original'], row['sha256'])
            verified.add((row['original'], row['sha256']))
        row.setdefault('provenance', None)
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    rows, current = [], set()
    for number, (source, path, provenance) in enumerate(files, 1):
        # Preserve identities from older macOS scans with decomposed filenames.
        source = canonical_previous.get(source, source)
        current.add(source)
        row = dict(id=previous[source]['id'] if source in previous else hashlib.sha256(source.encode()).hexdigest()[:20], source=source, sha256='', original='', status='error', note='', text='', checkedAt=now, provenance='')
        # Reading errors invalidate the scan rather than turning inaccessible files into deletions.
        data, facts = read_source(path)
        provenance.update(sizeBytes=facts.st_size, sourceModifiedAt=dt.datetime.fromtimestamp(facts.st_mtime, dt.timezone.utc).isoformat())
        row['provenance'] = json.dumps(provenance, ensure_ascii=False)
        digest = hashlib.sha256(data).hexdigest()
        original = 'originals/' + digest + path.suffix.lower()
        row.update(sha256=digest, original=original)
        target = output / original
        if target.exists() or target.is_symlink(): verify_original(output, original, digest)
        else:
            with tempfile.NamedTemporaryFile(dir=output / 'originals', delete=False) as copy:
                copy.write(data); temporary_original = Path(copy.name)
            try:
                # Publish a complete copy without ever replacing an existing original.
                try: os.link(temporary_original, target)
                except FileExistsError: verify_original(output, original, digest)
            finally: temporary_original.unlink(missing_ok=True)
        try:
            old = previous.get(source)
            revision_matches = extraction_revisions.get(path.suffix.lower(), 1) == EXTRACTION_REVISIONS.get(path.suffix.lower(), 1)
            if old and old['sha256'] == digest and old['status'] in ('ready', 'needs_review') and revision_matches:
                row.update(text=old['text'], status=old['status'], note=old['note'])
            else:
                text, extraction_status, note = extract(target)
                row.update(text=normalize(text), status=extraction_status, note=note)
                if extraction_status == 'ready' and len(text.strip()) < 20:
                    row.update(status='needs_review', note=note + ' Very little extracted text; inspect original.')
        except FileNotFoundError as error:
            raise BuildUnavailable('An extraction executable is unavailable on the source machine') from error
        except BuildUnavailable:
            raise
        except Exception as error:
            row.update(status='error', note=f'{type(error).__name__}: extraction failed; inspect original and sync log.')
            print(f'Cannot extract {source}: {type(error).__name__}', file=sys.stderr, flush=True)
        rows.append(row)
        if row['sha256']:
            versions.setdefault((source, row['sha256']), dict(source=source, sha256=row['sha256'], original=row['original'], firstObservedAt=now, provenance=row['provenance']))
        if number % 20 == 0: print(f'Indexed {number}/{len(files)}', file=sys.stderr, flush=True)
    for source, old in previous.items():
        if source not in current:
            missing = {**old, 'status': 'missing', 'checkedAt': now}
            missing.setdefault('provenance', None)
            rows.append(missing)
    for row in rows:
        old = previous.get(row['source'])
        changed = old is None or any(old.get(k) != row.get(k) for k in ('sha256', 'status', 'provenance'))
        if changed:
            history.append(dict(sequence=len(history) + 1, source=row['source'], sha256=row['sha256'], status=row['status'], observedAt=now, provenance=row['provenance']))
    temporary = output / f'library-{os.getpid()}.sqlite'
    if temporary.exists(): raise ValueError('An unfinished build exists; inspect it before retrying')
    db = sqlite3.connect(temporary)
    try:
        db.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE documents(id TEXT PRIMARY KEY,source TEXT,sha256 TEXT,original TEXT,status TEXT,note TEXT,text TEXT,checkedAt TEXT,provenance TEXT); CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, source, text, tokenize="unicode61 remove_diacritics 2");')
        db.execute('CREATE TABLE versions(source TEXT,sha256 TEXT,original TEXT,firstObservedAt TEXT,provenance TEXT,PRIMARY KEY(source,sha256))')
        db.execute('CREATE TABLE history(sequence INTEGER PRIMARY KEY,source TEXT,sha256 TEXT,status TEXT,observedAt TEXT,provenance TEXT)')
        db.executemany('INSERT INTO history VALUES(:sequence,:source,:sha256,:status,:observedAt,:provenance)', history)
        db.executemany('INSERT INTO versions VALUES(:source,:sha256,:original,:firstObservedAt,:provenance)', versions.values())
        db.executemany('INSERT INTO documents VALUES(:id,:source,:sha256,:original,:status,:note,:text,:checkedAt,:provenance)', rows)
        db.executemany('INSERT INTO search VALUES(:id,:source,:text)', [r for r in rows if r['status'] in ('ready', 'needs_review')])
        db.execute('INSERT INTO metadata VALUES(?,?)', ('builtAt', now))
        db.execute('INSERT INTO metadata VALUES(?,?)', ('sources', json.dumps(config['sources'], ensure_ascii=False)))
        db.execute('INSERT INTO metadata VALUES(?,?)', ('extractionRevisions', json.dumps(EXTRACTION_REVISIONS)))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('Index integrity failed')
    except BaseException:
        db.close(); temporary.unlink(missing_ok=True); raise
    finally: db.close()
    try:
        temporary.chmod(0o600)
        result = status(output, temporary.name)
        manifest = output / f'manifest-{os.getpid()}.json'
        atomic_json(manifest, {**result, 'documents': [decode_provenance({k: v for k, v in r.items() if k != 'text'}) for r in rows]})
        os.replace(temporary, output / 'library.sqlite')
        os.replace(manifest, output / 'manifest.json')
    finally: temporary.unlink(missing_ok=True)
    return {k: v for k, v in result.items() if k != 'issues'}


def status(root, filename='library.sqlite'):
    with connect(root, filename) as db:
        built = db.execute('SELECT value FROM metadata WHERE key="builtAt"').fetchone()[0]
        counts = dict(db.execute('SELECT status,count(*) FROM documents GROUP BY status').fetchall())
        issues = [dict(r) for r in db.execute('SELECT id,source,status,note FROM documents WHERE status NOT IN ("ready","missing") ORDER BY source')]
        sources = db.execute('SELECT value FROM metadata WHERE key="sources"').fetchone()
    age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(built)).total_seconds() / 3600
    return {'builtAt': built, 'ageHours': round(age, 2), 'stale': age > 48, 'counts': counts, 'issues': issues,
            'sources': json.loads(sources[0]) if sources else [], 'coverage': 'Configured local roots only; live messages, online pointers and document execution require separate verification.'}


def decode_provenance(row):
    if row.get('provenance'): row['provenance'] = json.loads(row['provenance'])
    return row


def search(root, query):
    words = [w for w in re.findall(r'[^\W_]+', normalize(query), re.UNICODE) if w.upper() not in ('AND', 'OR', 'NOT', 'NEAR')]
    if not words: return {'results': []}
    match = ' OR '.join('"' + w + '"*' for w in words[:20])
    with connect(root) as db:
        rows = db.execute('SELECT d.id,d.source,d.status,d.original,d.sha256,snippet(search,2,"[", "]","…",48) AS excerpt FROM search JOIN documents d ON d.id=search.id WHERE search MATCH ? ORDER BY bm25(search,0,5,1) LIMIT 20', (match,)).fetchall()
    return {'results': [dict(r) for r in rows]}


def show(root, doc_id):
    with connect(root) as db:
        db.create_function('normalize_source', 1, normalize)
        matches = db.execute('SELECT * FROM documents WHERE id=? OR normalize_source(source)=?', (doc_id, normalize(doc_id))).fetchall()
        if not matches: raise ValueError('Document not found; search first')
        if len(matches) > 1: raise ValueError('Ambiguous source; use its document ID')
        row = matches[0]
        result = decode_provenance(dict(row))
        result['versions'] = [decode_provenance(dict(v)) for v in db.execute('SELECT * FROM versions WHERE source=? ORDER BY firstObservedAt,sha256', (row['source'],))]
        result['history'] = [decode_provenance(dict(v)) for v in db.execute('SELECT * FROM history WHERE source=? ORDER BY sequence', (row['source'],))] if db.execute("SELECT 1 FROM sqlite_master WHERE name='history'").fetchone() else []
        if result['status'] == 'missing': result['availability'] = 'Not present in the latest complete source scan; retained only as historical evidence.'
        return result


def due(root, date):
    today = dt.date.fromisoformat(date) if date else dt.datetime.now(ZoneInfo('Europe/Moscow')).date()
    items = json.loads((root / 'obligations.json').read_text())
    result = {'on': today.isoformat(), 'timezone': 'Europe/Moscow', 'due': [], 'unresolved': [], 'held': []}
    seen = set()
    for item in items:
        if not all(item.get(k) for k in ('id', 'title', 'state', 'source', 'evidence')): raise ValueError('Every obligation requires identity, state, source and evidence')
        if item['id'] in seen: raise ValueError('Duplicate obligation identity')
        seen.add(item['id'])
        state = item['state']
        if state not in ('open', 'awaiting_trigger', 'needs_confirmation', 'on_hold', 'completed', 'cancelled'): raise ValueError('Unknown obligation state')
        if state in ('completed', 'cancelled'): continue
        if state == 'on_hold': result['held'].append(item); continue
        if state in ('awaiting_trigger', 'needs_confirmation') or not item.get('dueOn'):
            result['unresolved'].append(item); continue
        days = (dt.date.fromisoformat(item['dueOn']) - today).days
        if days <= 30: result['due'].append({**item, 'daysRemaining': days})
    result['due'].sort(key=lambda i: (i['dueOn'], i['id']))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('build'); p.add_argument('config', type=Path); p.add_argument('library', type=Path)
    for name in ('status', 'search', 'show', 'due'):
        p = sub.add_parser(name); p.add_argument('library', type=Path)
        if name in ('search', 'show'): p.add_argument('query')
        if name == 'due': p.add_argument('--on')
    args = parser.parse_args()
    if args.command == 'build': result = build(args.config, args.library)
    elif args.command == 'status': result = status(args.library)
    elif args.command == 'search': result = search(args.library, args.query)
    elif args.command == 'show': result = show(args.library, args.query)
    else: result = due(args.library, args.on)
    emit(result)


if __name__ == '__main__':
    os.umask(0o077)
    try: main()
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
