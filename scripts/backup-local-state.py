#!/usr/bin/env python3
"""Create a private rollback snapshot without copying deployments into backups."""
import argparse
from contextlib import closing
import datetime
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import uuid

SCHEMA = 'openstrudel-local-backup-v1'
DEFAULT_SOURCE = Path.home() / 'Library/Application Support/OpenStrudel'
DEFAULT_DEST = Path.home() / 'Library/Application Support/OpenStrudelBackups'
EXCLUDED = {('deployment',), ('releases',), ('runtime', 'node_modules'),
            ('runtime', 'dist'), ('runtime', 'public'), ('runtime', 'bin'), ('runtime', 'scripts')}

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
            with closing(sqlite3.connect(src.as_uri() + '?mode=ro', uri=True)) as original:
                with closing(sqlite3.connect(dest)) as snapshot:
                    original.backup(snapshot)
                    snapshot.execute('PRAGMA journal_mode=DELETE')
                    if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise RuntimeError('Snapshot database failed integrity_check')
            shutil.copystat(src, dest)
            databases.append(str(src.relative_to(source)))
        else:
            shutil.copy2(src, dest)
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
    opened = []
    if candidates:
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fn'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Cannot verify open backup files; retention skipped')
        opened = [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]
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
