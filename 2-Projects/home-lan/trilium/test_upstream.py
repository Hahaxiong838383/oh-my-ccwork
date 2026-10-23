"""Exercise the scheduled check's refusal and no-mutation paths."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("checker", Path(__file__).with_name("check-upstream.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
DIGEST = "sha256:" + "a" * 64
COMMIT = "b" * 40


class FakeGithub:
    def __init__(self):
        self.tag = "v0.106.0"
        self.commit = COMMIT
        self.desired = {"version": self.tag, "source_commit": COMMIT,
                        "image": f"triliumnext/trilium:{self.tag}@{DIGEST}"}
        self.upstream = {"repository": c.UPSTREAM, "main_commit": COMMIT,
                         "stable_version": self.tag, "stable_commit": COMMIT,
                         "release_url": f"https://github.com/{c.UPSTREAM}/releases/tag/{self.tag}"}
        self.writes = []

    def call(self, path, data=None, method=None):
        if data is not None:
            self.writes.append(path)
            raise AssertionError("Unexpected mutation")
        if path == "repos/" + c.REPO:
            return {"private": True, "default_branch": "main"}
        if path.endswith("releases/latest"):
            return {"tag_name": self.tag, "draft": False, "prerelease": False,
                    "html_url": f"https://github.com/{c.UPSTREAM}/releases/tag/{self.tag}"}
        if path.endswith("commits/main"):
            return {"sha": self.commit}
        raise AssertionError(path)

    def file(self, name, ref="main"):
        if name == "desired.json":
            return json.dumps(self.desired)
        if name == "upstream.json":
            return json.dumps(self.upstream)
        if name == "compose.yaml":
            return "image: " + self.desired["image"] + "\n"
        raise AssertionError(name)


class CheckerTests(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGithub()
        self.patches = [patch.object(c, "Github", return_value=self.gh),
                        patch.object(c, "registry_digest", return_value=DIGEST),
                        patch.object(c.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)),
                        patch.object(c.subprocess, "check_output", return_value=COMMIT + "\n")]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_current_publish_does_not_write(self):
        self.assertEqual(c.check(True)["status"], "up_to_date")
        self.assertEqual(self.gh.writes, [])

    def test_new_release_dry_run_does_not_write(self):
        self.gh.tag = "v0.107.0"
        r = c.check(False)
        self.assertTrue(r["release_change"])
        self.assertFalse(r["production_changed"])
        self.assertEqual(r["status"], "update_available")
        self.assertEqual(self.gh.writes, [])

    def test_main_only_change_keeps_image(self):
        self.gh.commit = "c" * 40
        r = c.check(False)
        self.assertFalse(r["release_change"])
        self.assertEqual(r["desired"], self.gh.desired)

    def test_older_release_is_refused(self):
        self.gh.tag = "v0.105.0"
        with self.assertRaisesRegex(RuntimeError, "regressed"):
            c.check(True)

    def test_mutated_digest_is_refused(self):
        with patch.object(c, "registry_digest", return_value="sha256:" + "d" * 64):
            with self.assertRaisesRegex(RuntimeError, "changed_review_required"):
                c.check(True)

    def test_fetch_failure_does_not_publish(self):
        with patch.object(c.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(RuntimeError, "fetch_failed"):
                c.check(True)
        self.assertEqual(self.gh.writes, [])

    def test_prerelease_version_rejected(self):
        self.gh.tag = "v0.107.0-beta"
        with self.assertRaises(ValueError):
            c.check(True)

    def test_pending_pr_is_not_overwritten(self):
        self.gh.commit = "c" * 40
        original = self.gh.call
        def call(path, data=None, method=None):
            if "pulls?state=open" in path:
                return [{"head": {"ref": c.BRANCH_PREFIX + "existing", "repo": {"full_name": c.REPO}},
                         "html_url": "https://github.com/example/pull/1"}]
            return original(path, data, method)
        self.gh.call = call
        self.assertEqual(c.check(True)["status"], "pr_pending_review")
        self.assertEqual(self.gh.writes, [])


if __name__ == "__main__":
    unittest.main()
