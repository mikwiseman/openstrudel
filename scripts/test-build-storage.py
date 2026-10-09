#!/usr/bin/env python3
"""Safety checks for cache pruning and private rollback snapshots."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

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

    def test_nested_backup_destination_is_rejected(self):
        source = self.base / 'source'
        source.mkdir()
        with self.assertRaises(ValueError):
            backup.create_backup(source, source / 'backups', app=None)

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

if __name__ == '__main__':
    unittest.main(verbosity=2)
