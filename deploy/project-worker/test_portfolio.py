import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("portfolio", Path(__file__).with_name("portfolio.py"))
portfolio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portfolio)


class PortfolioTests(unittest.TestCase):
    def test_publication_requires_the_registered_branch_workflow_and_exact_candidate(self):
        receipt = {"repository": "example/team", "base": "1" * 40, "revision": "a" * 40, "changed": True}
        portfolio.authorize_publication({"delivery": "branch"}, receipt, "example/team", "a" * 40)
        for policy, repo, sha in [
            ({}, "example/team", "a" * 40),
            ({"delivery": "branch"}, "example/other", "a" * 40),
            ({"delivery": "branch"}, "example/team", "b" * 40),
        ]:
            with self.assertRaises(ValueError):
                portfolio.authorize_publication(policy, receipt, repo, sha)
        with self.assertRaises(ValueError):
            portfolio.authorize_publication({"delivery": "branch"}, dict(receipt, changed=False), "example/team", "a" * 40)

    def test_candidate_is_saved_without_touching_a_personal_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "file").write_text("base\n")
            def git(*args):
                return subprocess.check_output(["git","-C",str(repo),*args],text=True).strip()
            git("add","file")
            git("-c","user.name=Test","-c","user.email=test@example.org","commit","-qm","base")
            base = git("rev-parse","HEAD")
            (repo / "file").write_text("candidate\n")
            patch = subprocess.check_output(["git","-C",str(repo),"diff","--binary"])
            (repo / "file").write_text("personal unfinished edit\n")
            ref = "refs/heads/wolf/project-5e5b1891-90f0-467b-bba9-bd47b88acfd0"
            revision = portfolio.record_candidate(repo / ".git", root / "index", base, ref, patch, "Change file")
            self.assertEqual(git("show",revision+":file"),"candidate")
            self.assertEqual(git("rev-parse","HEAD"),base)
            self.assertEqual(git("rev-parse",ref),revision)
            self.assertEqual((repo / "file").read_text(),"personal unfinished edit\n")

if __name__ == "__main__":
    unittest.main()
