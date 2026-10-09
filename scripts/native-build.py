#!/usr/bin/env python3
"""Run native builds in stable, locked caches shared by this Mac's checkouts."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

SCHEMA = 'openstrudel-derived-data-v1'
DEFAULT_ROOT = Path.home() / 'Library/Caches/OpenStrudelBuilds'
IDLE_DAYS = 7
BUDGET = 12 * 1024 ** 3

def checkout_id(repo):
    return hashlib.sha256(str(repo.resolve()).encode()).hexdigest()[:16]

def paths(root, repo):
    key = checkout_id(repo)
    return root / 'derived' / key, root / 'locks' / (key + '.lock')

def checked_directory(path):
    # Never follow a replaced cache directory into somebody else's data.
    path = path.absolute()
    if path.is_symlink() or path.resolve() != path:
        raise ValueError(f'Refusing a cache path with symlink components: {path}')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)

@contextmanager
def lock(path, blocking=True):
    checked_directory(path.parent)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield fd
    finally:
        os.close(fd)

def write_marker(slot, repo):
    checked_directory(slot)
    marker = slot / '.openstrudel-cache.json'
    temp = slot / '.openstrudel-cache.json.tmp'
    with open(temp, 'w') as out:
        json.dump({'schema': SCHEMA, 'checkout': str(repo.resolve()), 'last_used': time.time()}, out)
    os.replace(temp, marker)

def allocated_bytes(path):
    total = 0
    for current, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
        for name in files:
            try:
                total += (Path(current) / name).lstat().st_blocks * 512
            except FileNotFoundError:
                pass
    return total

def open_paths():
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fn'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Cannot verify open files; cache pruning skipped')
    return [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]

def prune(root, protected=(), budget=BUDGET, idle_days=IDLE_DAYS, now=None, opened=None):
    """Only delete marked, unlocked caches. Archives/history are outside this root."""
    now = time.time() if now is None else now
    if not root.exists():
        return []
    checked_directory(root)
    base = root / 'derived'
    if not base.exists():
        return []
    checked_directory(base)
    rows = []
    deleted = []
    with lock(root / 'locks' / 'prune.lock', blocking=False):
        for slot in base.iterdir():
            if slot.is_symlink() or not slot.is_dir():
                continue
            try:
                marker_path = slot / '.openstrudel-cache.json'
                if marker_path.is_symlink():
                    continue
                meta = json.loads(marker_path.read_text())
                if meta['schema'] != SCHEMA or checkout_id(Path(meta['checkout'])) != slot.name:
                    continue
                rows.append((float(meta['last_used']), slot, allocated_bytes(slot)))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        total = sum(row[2] for row in rows)
        opened = open_paths() if opened is None else opened
        for last_used, slot, size in sorted(rows):
            # Keep recent caches for incremental work, even if the soft budget is exceeded.
            age = now - last_used
            if age < 86400 or (age < idle_days * 86400 and total <= budget):
                continue
            if slot in protected or any(p == str(slot) or p.startswith(str(slot) + '/') for p in opened):
                continue
            try:
                with lock(root / 'locks' / (slot.name + '.lock'), blocking=False):
                    # A build may have refreshed the cache since enumeration.
                    if slot.is_symlink():
                        continue
                    current = json.loads((slot / '.openstrudel-cache.json').read_text())
                    if current.get('last_used') != last_used or current.get('schema') != SCHEMA:
                        continue
                    shutil.rmtree(slot)
                    total -= size
                    deleted.append({'path': str(slot), 'bytes': size})
            except BlockingIOError:
                continue
    return deleted

def build_command(repo, derived, arguments):
    forbidden = ('-derivedDataPath', '-clonedSourcePackagesDirPath', '-project', '-workspace')
    if any(arg == flag or arg.startswith(flag + '=') for arg in arguments for flag in forbidden):
        raise ValueError('Project and cache paths are managed by this wrapper; use --repo for another checkout')
    cache_root = derived.parents[1].resolve()
    for index, arg in enumerate(arguments):
        if arg in ('-archivePath', '-resultBundlePath'):
            if index + 1 == len(arguments):
                raise ValueError(f'Missing value for {arg}')
            output = Path(arguments[index + 1]).expanduser()
            if not output.is_absolute():
                output = repo / 'native/OpenStrudel' / output
            output = output.resolve()
            if output == cache_root or cache_root in output.parents:
                raise ValueError('Keep archives and explicit test results outside the managed cache root')
    return ['xcodebuild', '-project', str(repo / 'native/OpenStrudel/OpenStrudel.xcodeproj'),
            '-derivedDataPath', str(derived), *arguments]

def copy_product(derived, relative, destination):
    source = (derived / relative).resolve()
    destination = destination.expanduser().absolute()
    cache_root = derived.parents[1].resolve()
    if derived.resolve() not in source.parents or not source.is_dir():
        raise ValueError('Product must be an existing directory inside this DerivedData')
    if destination.exists() or destination.is_symlink():
        raise ValueError('Product staging destination must not already exist')
    if destination.resolve() == cache_root or cache_root in destination.resolve().parents:
        raise ValueError('Stage products outside the cache root')
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(['cp', '-cR', str(source), str(destination)], capture_output=True)
    if result.returncode:
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--cache-root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--print-derived-data', action='store_true')
    parser.add_argument('--prune', action='store_true', help='Prune managed caches only; no build')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--copy-product', nargs=2, metavar=('RELATIVE_PRODUCT', 'DESTINATION'),
                        help='Snapshot a product outside the cache while the build lock is held')
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    repo, root = args.repo.resolve(), args.cache_root.expanduser().absolute()
    derived, lock_path = paths(root, repo)
    if args.print_derived_data:
        print(derived)
        return 0
    if args.prune:
        print(json.dumps(prune(root), indent=2))
        return 0
    arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
    if not arguments:
        parser.error('Pass xcodebuild arguments after --, or use --prune')
    command = build_command(repo, derived, arguments)
    if args.dry_run:
        print(shlex.join(command))
        return 0
    if not (repo / 'native/OpenStrudel/OpenStrudel.xcodeproj').is_dir():
        parser.error('Generate native/OpenStrudel/OpenStrudel.xcodeproj with xcodegen first')
    checked_directory(root)
    with lock(lock_path) as lock_fd:
        if derived.exists() and not (derived / '.openstrudel-cache.json').is_file():
            raise ValueError(f'Unmanaged cache already exists: {derived}')
        write_marker(derived, repo)
        print(f'OpenStrudel DerivedData: {derived}', flush=True)
        try:
            code = subprocess.call(command, cwd=repo / 'native/OpenStrudel', pass_fds=(lock_fd,))
            if code == 0 and args.copy_product:
                copy_product(derived, args.copy_product[0], Path(args.copy_product[1]))
        finally:
            write_marker(derived, repo)
    try:
        for entry in prune(root, protected=(derived,)):
            print(f"Pruned {entry['path']} ({entry['bytes'] / 1024 ** 3:.2f} GiB)", file=sys.stderr)
    except (OSError, RuntimeError, ValueError) as error:
        print(f'Cache maintenance skipped: {error}', file=sys.stderr)
    return code

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        sys.exit(str(error))
