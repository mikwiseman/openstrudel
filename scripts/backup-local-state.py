#!/usr/bin/env python3
"""Create a private rollback snapshot without copying deployments into backups."""
import argparse
from contextlib import closing
import ctypes
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid

SCHEMA = 'openstrudel-local-backup-v1'
SQLITE_LOCK_TIMEOUT = 10
PROC = Path('/proc')
DEFAULT_SOURCE = Path.home() / 'Library/Application Support/OpenStrudel'
DEFAULT_DEST = Path.home() / 'Library/Application Support/OpenStrudelBackups'
EXCLUDED = {('deployment',), ('releases',), ('runtime', 'node_modules'),
            ('runtime', 'dist'), ('runtime', 'public'), ('runtime', 'bin'), ('runtime', 'scripts'),
            ('Dictation', 'parakeet-v3-q8.gguf')}

# APFS clones are independent files. Subsequent writes allocate their own blocks,
# unlike hard links, so large workspaces need not be duplicated before an update.
CLONE_FILE = None
if sys.platform == 'darwin':
    CLONE_FILE = getattr(ctypes.CDLL(None, use_errno=True), 'clonefile', None)
    if CLONE_FILE is not None:
        CLONE_FILE.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        CLONE_FILE.restype = ctypes.c_int

def copy_regular_file(source, destination):
    if CLONE_FILE is not None:
        if CLONE_FILE(os.fsencode(source), os.fsencode(destination), 0) == 0:
            shutil.copystat(source, destination)
            return str(destination)
        error = ctypes.get_errno()
        if error not in (errno.EXDEV, errno.ENOTSUP, errno.ENOSYS):
            raise OSError(error, os.strerror(error), str(source))
    return shutil.copy2(source, destination)

def is_sqlite(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open('rb') as source:
        return source.read(16) == b'SQLite format 3\x00'

def copy_state(source, destination):
    databases = []
    def ignore(directory, names):
        relative = Path(directory).relative_to(source)
        skipped = []
        for name in names:
            components = (relative / name).parts
            if components in EXCLUDED:
                skipped.append(name)
            elif name.endswith(('-wal', '-shm', '-journal')):
                base = Path(directory) / name.rsplit('-', 1)[0]
                if is_sqlite(base):
                    skipped.append(name)
        return skipped
    def copy_file(src, dest):
        src, dest = Path(src), Path(dest)
        if is_sqlite(src):
            blocked_since = None
            def progress(status, remaining, total):
                nonlocal blocked_since
                if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                    blocked_since = blocked_since or time.monotonic()
                    if time.monotonic() - blocked_since >= SQLITE_LOCK_TIMEOUT:
                        raise RuntimeError(f'Database remains locked: {src.relative_to(source)}. '
                                           'Quiesce its writer and retry; this snapshot is incomplete.')
                else:
                    blocked_since = None
            with closing(sqlite3.connect(src.as_uri() + '?mode=ro', uri=True, timeout=1)) as original:
                with closing(sqlite3.connect(dest)) as snapshot:
                    original.backup(snapshot, pages=256, progress=progress, sleep=0.1)
                    snapshot.execute('PRAGMA journal_mode=DELETE')
                    if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise RuntimeError('Snapshot database failed integrity_check')
            shutil.copystat(src, dest)
            databases.append(str(src.relative_to(source)))
        else:
            copy_regular_file(src, dest)
        return str(dest)
    shutil.copytree(source, destination, symlinks=True, ignore=ignore, copy_function=copy_file)
    return databases

def check_root(root):
    if root.is_symlink() or root.resolve() != root.absolute():
        raise ValueError('Backup root must not contain symlink components')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)

def create_backup(source, root, app, extras=()):
    source = source.resolve()
    if root == source or source in root.parents:
        raise ValueError('Backups must be outside the live user-data directory')
    check_root(root)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = 'backup-' + stamp + '-' + uuid.uuid4().hex[:8]
    stage, final = root / ('.partial-' + name), root / name
    stage.mkdir(mode=0o700)
    # Keep a failed partial snapshot for inspection; never report it as complete.
    databases = copy_state(source, stage / 'user-data')
    build = None
    if app:
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != 'is.openstrudel.mac':
            raise ValueError('Expected the production OpenStrudel app')
        build = info.get('CFBundleVersion')
        target = stage / 'OpenStrudel.app'
        result = subprocess.run(['cp', '-cR', str(app), str(target)], capture_output=True)
        if result.returncode:
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(app, target, symlinks=True)
    for extra in extras:
        if extra.is_file() and not extra.is_symlink():
            shutil.copy2(extra, stage / extra.name)
    meta = {'schema': SCHEMA, 'created': stamp, 'source': str(source), 'build': build,
            'sqlite_integrity': 'ok', 'databases': databases, 'deployment_healthy': False,
            'excluded': ['/'.join(p) for p in sorted(EXCLUDED)]}
    (stage / 'backup.json').write_text(json.dumps(meta, indent=2) + '\n')
    stage.rename(final)
    return final

def open_paths():
    """Paths that running processes hold open or use as their working directory."""
    lsof = shutil.which('lsof')
    if lsof:
        result = subprocess.run([lsof, '-nP', '-Fn'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Cannot verify open backup files; retention skipped')
        return [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]
    if not PROC.is_dir():
        raise RuntimeError('Cannot verify open backup files; retention skipped')
    # Linux without lsof: read the same descriptors and working directories from /proc.
    opened = []
    for pid in filter(str.isdigit, os.listdir(PROC)):
        links = [PROC / pid / 'cwd']
        try:
            links += [PROC / pid / 'fd' / fd for fd in os.listdir(PROC / pid / 'fd')]
        except OSError:
            pass  # It exited, or is another user's process, which lsof run by this user cannot see either.
        for link in links:
            try:
                opened.append(os.readlink(link))
            except OSError:
                pass
    return opened

def mark_healthy_and_prune(root, selected, keep=2):
    check_root(root)
    if selected.parent != root or selected.is_symlink() or not selected.name.startswith('backup-'):
        raise ValueError('Expected a completed backup directly in the managed backup root')
    marker = selected / 'backup.json'
    if marker.is_symlink():
        raise ValueError('Backup metadata must not be a symlink')
    meta = json.loads(marker.read_text())
    if meta.get('schema') != SCHEMA or meta.get('sqlite_integrity') != 'ok':
        raise ValueError('Unrecognised or incomplete backup')
    meta['deployment_healthy'] = True
    temp = selected / 'backup.json.tmp'
    temp.write_text(json.dumps(meta, indent=2) + '\n')
    temp.replace(marker)
    healthy = []
    for candidate in root.glob('backup-*'):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        try:
            marker = candidate / 'backup.json'
            if marker.is_symlink():
                continue
            record = json.loads(marker.read_text())
            if record.get('schema') == SCHEMA and record.get('deployment_healthy') is True:
                healthy.append((record['created'], candidate))
        except (OSError, ValueError, KeyError):
            continue
    deleted = []
    candidates = sorted(healthy, reverse=True)[keep:]
    opened = open_paths() if candidates else []
    for _, candidate in candidates:
        if candidate == selected:
            continue
        if any(p == str(candidate) or p.startswith(str(candidate) + '/') for p in opened):
            continue
        shutil.rmtree(candidate)
        deleted.append(str(candidate))
    return deleted

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--destination', type=Path, default=DEFAULT_DEST)
    parser.add_argument('--app', type=Path, default=Path('/Applications/OpenStrudel.app'))
    parser.add_argument('--mark-healthy', type=Path, help='After deployment health checks: retain the latest two healthy rollback snapshots')
    args = parser.parse_args()
    root = args.destination.expanduser().absolute()
    check_root(root)
    fd = os.open(root / '.backup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if args.mark_healthy:
            print(json.dumps({'deleted': mark_healthy_and_prune(root, args.mark_healthy.absolute())}, indent=2))
        else:
            extras = [Path.home() / 'Library/LaunchAgents/is.openstrudel.home.plist',
                      Path.home() / 'Library/Preferences/is.openstrudel.mac.plist']
            print(create_backup(args.source, root, args.app, extras))
    finally:
        os.close(fd)

if __name__ == '__main__':
    main()
