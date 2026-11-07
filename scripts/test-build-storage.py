#!/usr/bin/env python3
"""Safety checks for cache pruning and private rollback snapshots."""
import importlib.util
import ctypes
import errno
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

build = load('native_build', 'native-build.py')
backup = load('local_backup', 'backup-local-state.py')

class StorageSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'cache'
        self.now = time.time()

    def tearDown(self):
        self.temp.cleanup()

    def slot(self, name, age_days):
        repo = self.base / name
        slot, _ = build.paths(self.root, repo)
        build.write_marker(slot, repo)
        marker = slot / '.openstrudel-cache.json'
        meta = json.loads(marker.read_text())
        meta['last_used'] = self.now - age_days * 86400
        marker.write_text(json.dumps(meta))
        (slot / 'object.o').write_bytes(b'x' * 8192)
        return slot

    def test_stable_cache_reused_per_checkout(self):
        a = self.base / 'source'
        self.assertEqual(build.paths(self.root, a), build.paths(self.root, a / '..' / 'source'))
        self.assertNotEqual(build.paths(self.root, a), build.paths(self.root, self.base / 'worktree'))

    def test_old_cache_removed_but_unknown_and_external_preserved(self):
        old = self.slot('old', 8)
        unknown = self.root / 'derived/unknown'
        unknown.mkdir()
        (unknown / 'important').write_text('user content')
        external = self.base / 'history'
        external.mkdir()
        (external / 'session.jsonl').write_text('history')
        (self.root / 'derived/linked').symlink_to(external)
        removed = build.prune(self.root, now=self.now, opened=[])
        self.assertEqual([row['path'] for row in removed], [str(old)])
        self.assertTrue((unknown / 'important').exists())
        self.assertEqual((external / 'session.jsonl').read_text(), 'history')

    def test_locked_and_open_caches_are_retained(self):
        locked, opened = self.slot('locked', 9), self.slot('open', 9)
        with build.lock(self.root / 'locks' / (locked.name + '.lock')):
            removed = build.prune(self.root, now=self.now, opened=[str(opened / 'object.o')])
        self.assertEqual(removed, [])
        self.assertTrue(locked.exists() and opened.exists())

    def test_budget_removes_older_cache_but_keeps_recent(self):
        older, recent = self.slot('older', 2), self.slot('recent', 0.5)
        build.prune(self.root, now=self.now, budget=0, opened=[])
        self.assertFalse(older.exists())
        self.assertTrue(recent.exists())

    def test_symlink_root_is_rejected(self):
        real = self.base / 'real'
        real.mkdir()
        self.root.symlink_to(real)
        with self.assertRaises(ValueError):
            build.prune(self.root, opened=[])

    def test_override_and_valuable_artifacts_in_cache_are_rejected(self):
        derived, _ = build.paths(self.root, self.base)
        for arguments in (['-derivedDataPath', '/tmp/other'], ['-project', 'another'],
                          ['-archivePath', str(derived / 'release.xcarchive')],
                          ['-resultBundlePath', str(self.root / 'results.xcresult')]):
            with self.assertRaises(ValueError):
                build.build_command(self.base, derived, arguments)

    def test_same_checkout_builds_are_serialized(self):
        repo = self.base / 'repo'
        (repo / 'native/OpenStrudel/OpenStrudel.xcodeproj').mkdir(parents=True)
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        fake = bin_dir / 'xcodebuild'
        trace = self.base / 'trace'
        fake.write_text('#!/usr/bin/env python3\nimport os,time\np=os.environ["STORAGE_TEST_TRACE"]\nwith open(p,"a") as f: f.write("begin\\n")\ntime.sleep(0.2)\nwith open(p,"a") as f: f.write("end\\n")\n')
        fake.chmod(0o755)
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], STORAGE_TEST_TRACE=str(trace))
        command = ['python3', str(Path(__file__).with_name('native-build.py')), '--repo', str(repo),
                   '--cache-root', str(self.root), '--', '-scheme', 'OpenStrudel macOS', 'build']
        processes = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        for process in processes:
            output = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, output)
        self.assertEqual(trace.read_text().splitlines(), ['begin', 'end', 'begin', 'end'])

    def test_staged_product_survives_later_build_and_cannot_overwrite_data(self):
        derived = self.slot('source', 0)
        app = derived / 'Build/Products/Release/OpenStrudel.app'
        app.mkdir(parents=True)
        (app / 'binary').write_text('first build')
        staged = self.base / 'release/OpenStrudel.app'
        build.copy_product(derived, 'Build/Products/Release/OpenStrudel.app', staged)
        (app / 'binary').write_text('next build')
        self.assertEqual((staged / 'binary').read_text(), 'first build')
        with self.assertRaises(ValueError):
            build.copy_product(derived, 'Build/Products/Release/OpenStrudel.app', staged)
        with self.assertRaises(ValueError):
            build.copy_product(derived, 'Build/Products/Release/OpenStrudel.app', self.root / 'staged.app')

    def test_backup_copies_live_sqlite_and_preserves_history_without_recursive_builds(self):
        source = self.base / 'user-data'
        state = source / 'runtime/.data'
        state.mkdir(parents=True)
        (state / 'codex/sessions').mkdir(parents=True)
        (state / 'codex/sessions/session.jsonl').write_text('keep history')
        (state / 'workspace').mkdir()
        (state / 'workspace/unique.txt').write_text('keep work')
        for relative in ('deployment/backup', 'releases/old', 'runtime/node_modules/large'):
            p = source / relative
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('reproducible')
        with sqlite3.connect(state / 'openstrudel.sqlite') as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('CREATE TABLE messages(text)')
            connection.execute("INSERT INTO messages VALUES ('committed')")
            connection.commit()
            result = backup.create_backup(source, self.base / 'backups', app=None)
            copied = result / 'user-data/runtime/.data'
            with sqlite3.connect(copied / 'openstrudel.sqlite') as snapshot:
                self.assertEqual(snapshot.execute('SELECT text FROM messages').fetchall(), [('committed',)])
            self.assertFalse((copied / 'openstrudel.sqlite-wal').exists())
            self.assertEqual((copied / 'codex/sessions/session.jsonl').read_text(), 'keep history')
            self.assertTrue((copied / 'workspace/unique.txt').is_file())
            for relative in ('deployment', 'releases', 'runtime/node_modules'):
                self.assertFalse((result / 'user-data' / relative).exists())

    def test_backup_skips_only_codex_temporary_plugin_clones(self):
        source = self.base / 'source'
        homes = ['.data/codex', '.data/contexts/personal',
                 '.data/accounts/owner/codex', '.data/accounts/owner/contexts/work',
                 'runtime/.data/contexts/personal']
        skipped = []
        kept = ['.data/workspace/personal/.tmp/plugins/custom.txt',
                '.data/contexts/personal/skills/custom/SKILL.md']
        for home in homes:
            skipped.extend([home + '/.tmp/plugins/catalog.bin', home + '/.tmp/plugins-clone-ABC/catalog.bin'])
            kept.extend([home + '/sessions/history.jsonl', home + '/memories/MEMORY.md',
                         home + '/.tmp/original.txt', home + '/config.toml'])
        for relative in skipped + kept:
            p = source / relative; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(relative)
        result = backup.create_backup(source, self.base / 'backups', app=None)
        for relative in skipped:
            self.assertFalse((result / 'user-data' / relative).exists(), relative)
            self.assertTrue((source / relative).is_file(), relative)
        for relative in kept:
            self.assertEqual((result / 'user-data' / relative).read_text(), relative)

    def test_backup_leaves_operating_reserve_before_copying(self):
        source = self.base / 'source'; source.mkdir()
        (source / 'private.txt').write_text('keep original')
        usage = type('Usage', (), {'free': 1024})()
        with patch.object(backup, 'CLONE_FILE', None), patch.object(backup.shutil, 'disk_usage', return_value=usage):
            with self.assertRaisesRegex(RuntimeError, 'operating reserve'):
                backup.create_backup(source, self.base / 'backups', app=None)
        self.assertEqual((source / 'private.txt').read_text(), 'keep original')
        self.assertEqual(list((self.base / 'backups').glob('backup-*')), [])

    def test_nested_backup_destination_is_rejected(self):
        source = self.base / 'source'
        source.mkdir()
        with self.assertRaises(ValueError):
            backup.create_backup(source, source / 'backups', app=None)

    def test_backup_files_remain_independent_after_changes_on_both_sides(self):
        source = self.base / 'source'
        source.mkdir()
        original = source / 'important.txt'
        original.write_text('original content')
        original.chmod(0o600)
        result = backup.create_backup(source, self.base / 'backups', app=None)
        copied = result / 'user-data/important.txt'
        self.assertNotEqual(original.stat().st_ino, copied.stat().st_ino)
        self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
        original.write_text('live change')
        self.assertEqual(copied.read_text(), 'original content')
        copied.write_text('snapshot change')
        self.assertEqual(original.read_text(), 'live change')

    def test_backup_falls_back_on_an_unsupported_volume_but_not_storage_errors(self):
        source = self.base / 'important.txt'
        source.write_text('keep this')
        destination = self.base / 'copy.txt'
        def failure(number):
            def clone(*args):
                ctypes.set_errno(number)
                return -1
            return clone
        with patch.object(backup, 'CLONE_FILE', failure(errno.EXDEV)):
            backup.copy_regular_file(source, destination)
        self.assertEqual(destination.read_text(), source.read_text())
        destination.unlink()
        with patch.object(backup, 'CLONE_FILE', failure(errno.ENOSPC)):
            with self.assertRaises(OSError) as caught:
                backup.copy_regular_file(source, destination)
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertFalse(destination.exists())
        self.assertEqual(source.read_text(), 'keep this')

    def test_locked_database_fails_without_hanging_or_claiming_a_complete_backup(self):
        source = self.base / 'user-data'
        source.mkdir()
        with sqlite3.connect(source / 'locked.sqlite') as writer:
            writer.execute('CREATE TABLE messages(text)')
            writer.execute("INSERT INTO messages VALUES ('keep')")
            writer.commit()
            writer.execute('BEGIN EXCLUSIVE')
            started = time.monotonic()
            with patch.object(backup, 'SQLITE_LOCK_TIMEOUT', 0.1):
                with self.assertRaisesRegex(RuntimeError, 'Database remains locked: locked.sqlite'):
                    backup.create_backup(source, self.base / 'backups', app=None)
            self.assertLess(time.monotonic() - started, 5)
            writer.rollback()
            self.assertEqual(writer.execute('SELECT text FROM messages').fetchall(), [('keep',)])
        self.assertEqual(list((self.base / 'backups').glob('backup-*')), [])
        self.assertEqual(list((self.base / 'backups').rglob('backup.json')), [])

    def test_backup_skips_downloadable_dictation_model_but_preserves_unique_files(self):
        source = self.base / 'user-data'
        dictation = source / 'Dictation'
        dictation.mkdir(parents=True)
        model = dictation / 'parakeet-v3-q8.gguf'
        model.write_bytes(b'redownloadable model')
        (dictation / 'recording.wav').write_bytes(b'unique recording')
        (dictation / 'custom-model.gguf').write_bytes(b'user supplied model')

        result = backup.create_backup(source, self.base / 'backups', app=None)
        restored = result / 'user-data/Dictation'
        self.assertFalse((restored / model.name).exists())
        self.assertEqual((restored / 'recording.wav').read_bytes(), b'unique recording')
        self.assertEqual((restored / 'custom-model.gguf').read_bytes(), b'user supplied model')
        self.assertEqual(model.read_bytes(), b'redownloadable model')
        self.assertIn('Dictation/parakeet-v3-q8.gguf', json.loads((result / 'backup.json').read_text())['excluded'])

    def test_retention_only_removes_completed_healthy_managed_snapshots(self):
        root = self.base / 'backups'
        root.mkdir()
        for i in range(4):
            candidate = root / f'backup-{i}'
            candidate.mkdir()
            (candidate / 'backup.json').write_text(json.dumps({'schema': backup.SCHEMA, 'created': str(i),
                'sqlite_integrity': 'ok', 'deployment_healthy': i < 2}))
        foreign = root / 'backup-foreign'
        foreign.mkdir()
        (foreign / 'important').write_text('keep')
        deleted = backup.mark_healthy_and_prune(root, root / 'backup-3')
        self.assertEqual(deleted, [str(root / 'backup-0')])
        self.assertTrue((root / 'backup-2').exists())
        self.assertTrue((foreign / 'important').exists())

    def test_retention_uses_available_lsof_and_preserves_open_snapshots(self):
        root = self.base / 'backups'
        root.mkdir()
        for i in range(3):
            candidate = root / f'backup-{i}'
            candidate.mkdir()
            (candidate / 'backup.json').write_text(json.dumps({'schema': backup.SCHEMA, 'created': str(i),
                'sqlite_integrity': 'ok', 'deployment_healthy': True}))
        opened = root / 'backup-0/user-data'
        def inspect_files(command, **kwargs):
            if command[0] != '/usr/bin/lsof':
                raise FileNotFoundError(command[0])
            return subprocess.CompletedProcess(command, 0, stdout=f'n{opened}\n', stderr='')
        with patch.object(backup.shutil, 'which', return_value='/usr/bin/lsof'), \
                patch.object(backup.subprocess, 'run', side_effect=inspect_files):
            self.assertEqual(backup.mark_healthy_and_prune(root, root / 'backup-2'), [])
        self.assertTrue((root / 'backup-0').exists())

    def test_retention_keeps_snapshots_when_lsof_is_unavailable(self):
        root = self.base / 'backups'
        root.mkdir()
        for i in range(3):
            candidate = root / f'backup-{i}'
            candidate.mkdir()
            (candidate / 'backup.json').write_text(json.dumps({'schema': backup.SCHEMA, 'created': str(i),
                'sqlite_integrity': 'ok', 'deployment_healthy': True}))
        with patch.object(backup.shutil, 'which', return_value=None), \
                patch.object(backup.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Cannot verify open backup files'):
                backup.mark_healthy_and_prune(root, root / 'backup-2')
            run.assert_not_called()
        self.assertTrue((root / 'backup-0').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
