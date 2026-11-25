import hashlib
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("packages", Path(__file__).with_name("packages.py"))
packages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packages)

class PackageTests(unittest.TestCase):
    def test_only_a_regular_file_from_the_build_is_published(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "downloads"
            public.mkdir()
            source = root / "artifact"
            source.write_bytes(b"apk")
            name, digest, size = packages.save_artifact(source, public, "Guide-qa.apk")
            self.assertEqual((public/name).read_bytes(), b"apk")
            self.assertEqual(digest, hashlib.sha256(b"apk").hexdigest())
            self.assertEqual(size, 3)
            source.unlink()
            source.symlink_to(root / "private")
            (root/"private").write_text("private")
            with self.assertRaises(OSError): packages.save_artifact(source, public, "Guide-qa.apk")
            self.assertEqual(len(list(public.iterdir())),1)

if __name__ == "__main__": unittest.main()
