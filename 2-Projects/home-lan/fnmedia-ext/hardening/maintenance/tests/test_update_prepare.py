"""update_prepare 的离线测试：假 GitHub API + 真实本地 git 夹具，不触网、不碰其它仓。

运行：python3 -m unittest discover -s tests    （在 maintenance/ 目录下）
或   python3 -m pytest tests/test_update_prepare.py
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import update_prepare as up  # noqa: E402

BASE_URL = f"{up.API_ROOT}/repos/{up.DEFAULT_SLUG}"


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
_GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_NAME": "fixture",
    "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_NAME": "fixture",
    "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    "GIT_AUTHOR_DATE": "2026-10-27T00:00:00+0000",
    "GIT_COMMITTER_DATE": "2026-10-27T00:00:00+0000",
    "LC_ALL": "C",
}


def git(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        env={**os.environ, **_GIT_ENV},
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} 失败: {proc.stderr}")
    return proc.stdout.strip()


def init_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    write_files(path, files)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "base")
    return path


def write_files(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def commit(repo: Path, files: dict[str, str] | None = None, *, delete: tuple[str, ...] = (),
           message: str = "change") -> str:
    write_files(repo, files or {})
    for rel in delete:
        (repo / rel).unlink()
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def contents(text: str, path: str = "file", declared_size: int | None = None) -> dict:
    raw = text.encode("utf-8")
    return {
        "type": "file",
        "path": path,
        "encoding": "base64",
        "size": len(raw) if declared_size is None else declared_size,
        "content": base64.encodebytes(raw).decode("ascii"),
    }


class FakeAPI:
    """极简 GitHub 替身：按 URL 路由返回固定 payload，支持 ETag/304。"""

    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, object, str | None]] = {}
        self.seen: list[str] = []

    def route(self, path: str, payload: object = None, *, status: int = 200,
              etag: str | None = None) -> "FakeAPI":
        self.routes[BASE_URL + path] = (status, payload, etag)
        return self

    def __call__(self, url: str, etag: str | None = None, proxy: str | None = None,
                 timeout: float = 15.0) -> up.HttpResult:
        self.seen.append(url)
        if url not in self.routes:
            raise up.HttpStatusError(404)
        status, payload, stored_etag = self.routes[url]
        if status == 304 or (etag and stored_etag and etag == stored_etag):
            return up.HttpResult(304, None, stored_etag)
        if status != 200:
            raise up.HttpStatusError(status)
        return up.HttpResult(200, payload, stored_etag)


def release_payload(tag: str = "v0.2.19", **overrides) -> dict:
    payload = {
        "tag_name": tag,
        "name": f"release {tag}",
        "draft": False,
        "prerelease": False,
        "published_at": "2026-10-28T14:24:57Z",
        "body": f"## {tag} — 2026-10-28\n\n仅文档变化。\n",
    }
    payload.update(overrides)
    return payload


class Harness:
    """搭一个"上游仓库 + 加固分支"的夹具，并生成对应的假 API。"""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.repo = init_repo(
            tmp / "upstream",
            {
                "VERSION": "0.2.17\n",
                "CHANGELOG.md": "# 更新日志\n\n## v0.2.17 — 2026-10-27\n\n初始。\n",
                "proxy/app.py": "PROXY = 'upstream-0.2.17'\n",
                "proxy/util.py": "UTIL = 1\n",
                "README.md": "readme\n",
            },
        )
        git(self.repo, "tag", "v0.2.17")
        self.base_commit = git(self.repo, "rev-parse", "HEAD")
        # 加固分支：只改 VERSION 与 proxy/app.py（本地加固，不属于上游）
        git(self.repo, "checkout", "-q", "-b", "hardened", self.base_commit)
        write_files(self.repo, {"VERSION": "0.2.17.1\n", "proxy/app.py": "PROXY = 'hardened-0.2.17.1'\n"})
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "harden")
        self.tree = self.repo
        # 上游 v0.2.19：只改 VERSION / CHANGELOG.md
        self.upstream_changelog = (
            "# 更新日志\n\n"
            "## v0.2.19 — 2026-10-28\n\n资源加载改进。\n\n"
            "## v0.2.18 — 2026-10-28\n\n兼容性修复。\n\n"
            "## v0.2.17 — 2026-10-27\n\n初始。\n"
        )
        git(self.repo, "checkout", "-q", "main")
        self.latest_commit = commit(
            self.repo,
            {"VERSION": "0.2.19\n", "CHANGELOG.md": self.upstream_changelog},
            message="release: v0.2.19",
        )
        git(self.repo, "tag", "v0.2.19")
        git(self.repo, "checkout", "-q", "hardened")
        self.api = FakeAPI()
        self.state = tmp / "state" / "state.json"
        self.work = tmp / "work"

    def default_routes(self) -> FakeAPI:
        self.api.route("/releases/latest", release_payload())
        self.api.route("/git/ref/tags/v0.2.19", {
            "ref": "refs/tags/v0.2.19",
            "object": {"sha": self.latest_commit, "type": "commit"},
        })
        self.api.route("/contents/VERSION?ref=" + self.latest_commit,
                       contents("0.2.19\n", "VERSION"))
        self.api.route("/contents/CHANGELOG.md?ref=" + self.latest_commit,
                       contents(self.upstream_changelog, "CHANGELOG.md"))
        return self.api

    def updater(self, **kwargs) -> up.Updater:
        params = dict(
            tree=self.tree,
            state_path=self.state,
            baseline="v0.2.17",
            fetch=self.api,
            work_root=self.work,
            lock_timeout=2.0,
        )
        params.update(kwargs)
        return up.Updater(**params)


def codes(status: dict) -> list[str]:
    return [error["code"] for error in status["errors"]]


# --------------------------------------------------------------------------- #
# 版本比较：数字序列，不是字典序
# --------------------------------------------------------------------------- #
class VersionTests(unittest.TestCase):
    def test_numeric_order_beats_lexicographic(self):
        self.assertEqual(up.compare_versions("0.2.9", "0.2.17"), -1)
        self.assertEqual(up.compare_versions("0.2.17", "0.2.9"), 1)
        self.assertEqual(up.compare_versions("0.2.17", "0.2.17"), 0)
        self.assertEqual(up.compare_versions("0.2.17", "0.2.17.1"), -1)
        self.assertEqual(up.compare_versions("0.2.17.1", "0.2.18"), -1)
        self.assertEqual(up.compare_versions("v0.2.19", "0.2.19"), 0)

    def test_sorting_is_numeric(self):
        versions = ["0.2.9", "0.2.17", "0.2.10", "0.2.17.1", "0.2.19"]
        self.assertEqual(
            sorted(versions, key=up.version_key),
            ["0.2.9", "0.2.10", "0.2.17", "0.2.17.1", "0.2.19"],
        )

    def test_invalid_versions_rejected(self):
        for bad in ("", "abc", "0.2..1", "1.2.3.4.5", "0.2.x", "-1.0"):
            with self.assertRaises(up.VersionError, msg=bad):
                up.parse_version(bad)
        self.assertEqual(up.parse_version("0.2.19\n"), (0, 2, 19))

    def test_local_revision_is_not_regression(self):
        self.assertTrue(up.is_local_revision_of("0.2.19.1", "0.2.19"))
        self.assertFalse(up.is_local_revision_of("0.3.0", "0.2.19"))
        self.assertFalse(up.is_local_revision_of("0.2.19", "0.2.19"))


# --------------------------------------------------------------------------- #
# 白名单路径
# --------------------------------------------------------------------------- #
class WhitelistTests(unittest.TestCase):
    def test_only_root_documents_allowed(self):
        for good in ("VERSION", "CHANGELOG.md", "文档.md"):
            self.assertTrue(up.is_whitelisted_path(good), good)
        for bad in (
            "docs/guide.md",          # 非白名单的 .md
            "docs/CHANGELOG.md",      # 同名但在子目录
            "proxy/x.md",             # 代码目录里的 .md
            "CHANGELOG.md.bak",
            "VERSION.md",
            "sub/VERSION",
            "./VERSION",
            "../VERSION",
            "/VERSION",
            "VERSION/",
            "a\\b.md",
            "VERSION\n",
            "",
            None,
        ):
            self.assertFalse(up.is_whitelisted_path(bad), repr(bad))

    def test_classify_blocks_code_and_rename_bypass(self):
        changes = [
            up.Change("M", "VERSION"),
            up.Change("M", "CHANGELOG.md"),
            up.Change("A", "文档.md"),
            up.Change("M", "proxy/app.py"),
            up.Change("A", "deploy/install.sh"),
            up.Change("A", "docs/guide.md"),
            up.Change("R100", "CHANGELOG.md", "proxy/app.py"),
            up.Change("R100", "docs/CHANGELOG.md", "CHANGELOG.md"),
        ]
        allowed, blocked = up.classify_changes(changes)
        self.assertEqual([c.path for c in allowed], ["VERSION", "CHANGELOG.md", "文档.md"])
        self.assertEqual(len(blocked), 5)


# --------------------------------------------------------------------------- #
# 本地 git 真实 diff
# --------------------------------------------------------------------------- #
class GitDiffTests(unittest.TestCase):
    def test_real_diff_statuses_and_classification(self):
        with self.subTest("fixture"):
            import tempfile

            with tempfile.TemporaryDirectory() as tmp:
                repo = init_repo(
                    Path(tmp) / "r",
                    {
                        "VERSION": "0.2.17\n",
                        "CHANGELOG.md": "# 更新日志\n",
                        "proxy/a.py": "A = 1\n",
                        "proxy/old.py": "OLD = 1\n",
                        "README.md": "readme\n",
                    },
                )
                base = git(repo, "rev-parse", "HEAD")
                head = commit(
                    repo,
                    {
                        "VERSION": "0.2.18\n",
                        "proxy/a.py": "A = 2\n",
                        "docs/guide.md": "# guide\n",
                    },
                    delete=("README.md", "proxy/old.py"),
                    message="mixed",
                )
                home = Path(tmp) / "home"
                home.mkdir()
                changes = up.git_changes(repo, base, head, home, git_bin="git")
                pairs = {(change.status, change.path) for change in changes}
                self.assertIn(("M", "VERSION"), pairs)
                self.assertIn(("M", "proxy/a.py"), pairs)
                self.assertIn(("A", "docs/guide.md"), pairs)
                self.assertIn(("D", "README.md"), pairs)
                self.assertIn(("D", "proxy/old.py"), pairs)

                allowed, blocked = up.classify_changes(changes)
                self.assertEqual([c.path for c in allowed], ["VERSION"])
                self.assertEqual(
                    sorted(c.path for c in blocked),
                    ["README.md", "docs/guide.md", "proxy/a.py", "proxy/old.py"],
                )

    def test_rename_is_not_a_doc_laundering_path(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(Path(tmp) / "r", {"VERSION": "0.2.17\n", "CHANGELOG.md": "# 日志\n",
                                               "proxy/x.py": "X = 1\n"})
            base = git(repo, "rev-parse", "HEAD")
            (repo / "proxy" / "x.py").unlink()
            (repo / "CHANGELOG.md").unlink()
            write_files(repo, {"CHANGELOG.md": "X = 1\n"})
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "rename")
            head = git(repo, "rev-parse", "HEAD")
            home = Path(tmp) / "home"
            home.mkdir()
            # --no-renames：改名退化为 D+A，删除侧不在白名单 → 必须 blocked
            changes = up.git_changes(repo, base, head, home, git_bin="git")
            _, blocked = up.classify_changes(changes)
            self.assertTrue(any(c.path == "proxy/x.py" for c in blocked))


# --------------------------------------------------------------------------- #
# 需要人工复核 / 拒绝的情况
# --------------------------------------------------------------------------- #
class RejectionTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.harness = Harness(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_code_change_requires_review_and_never_prepares(self):
        repo = self.harness.repo
        git(repo, "checkout", "-q", "main")
        commit(repo, {"VERSION": "0.2.19\n", "proxy/app.py": "PROXY = 'upstream-0.2.19'\n"},
               message="release: v0.2.19 with code")
        latest = git(repo, "rev-parse", "HEAD")
        git(repo, "checkout", "-q", "hardened")
        api = self.harness.api
        api.route("/releases/latest", release_payload())
        api.route("/git/ref/tags/v0.2.19", {"object": {"sha": latest, "type": "commit"}})
        api.route("/contents/VERSION?ref=" + latest, contents("0.2.19\n", "VERSION"))

        status = self.harness.updater().run("check")
        self.assertEqual(status["status"], "needs_review")
        self.assertTrue(status["needs_review"])
        self.assertFalse(status["ready"])
        self.assertEqual(status["action"], "review")
        self.assertIn("code_change", codes(status))
        self.assertFalse(status["upstream_code_identical_to_baseline"])
        self.assertTrue(any("proxy/app.py" in item for item in status["changed_paths"]["blocked"]))
        self.assertEqual(status["diff_source"], "local-git")

        prepared = self.harness.updater().run("prepare")
        self.assertIsNone(prepared["candidate"])
        self.assertFalse(prepared["ready"])
        self.assertFalse((self.harness.work / "candidates").exists())

    def test_tag_repointing_is_rejected(self):
        api = self.harness.default_routes()
        first = self.harness.updater().run("check")
        self.assertEqual(first["status"], "update_available")
        self.assertEqual(first["upstream_commit"], self.harness.latest_commit)

        # 同名 tag 换到另一个 commit（内容同样只动文档也不行）
        moved = self.harness.latest_commit
        api.route("/git/ref/tags/v0.2.19",
                  {"object": {"sha": "0" * 39 + "1", "type": "commit"}})
        second = self.harness.updater().run("check")
        self.assertEqual(second["status"], "needs_review")
        self.assertIn("tag_moved", codes(second))
        self.assertFalse(second["ready"])
        state = json.loads(self.harness.state.read_text())
        self.assertEqual(state["tags"]["v0.2.19"], moved)  # 固定首次观测值

    def test_bad_payloads_are_refused(self):
        cases = [
            ("/releases/latest", [], "release_not_object"),
            ("/releases/latest", release_payload(tag=""), "release_tag_missing"),
            ("/releases/latest", release_payload(tag="nightly"), "release_tag_not_version"),
            ("/releases/latest", release_payload(prerelease=True), "release_not_stable"),
            ("/releases/latest", release_payload(draft=True), "release_not_stable"),
            ("/releases/latest", {"tag_name": "v0.2.19"}, "http_404"),
        ]
        for path, payload, expected in cases:
            with self.subTest(payload=payload):
                api = FakeAPI()
                api.route(path, payload)
                status = self.harness.updater(fetch=api).run("check")
                self.assertIn(expected, codes(status))
                self.assertFalse(status["ready"])

    def test_unresolvable_tag_and_missing_contents(self):
        api = self.harness.default_routes()
        api.route("/git/ref/tags/v0.2.19", {"object": {"sha": "abc", "type": "blob"}})
        api.route("/commits/v0.2.19", {"sha": "not-a-sha"})
        status = self.harness.updater(fetch=api).run("check")
        self.assertIn("tag_commit_unresolved", codes(status))
        self.assertFalse(status["ready"])

        api = self.harness.default_routes()
        api.route("/contents/VERSION?ref=" + self.harness.latest_commit,
                  contents("0.2.18\n", "VERSION"))
        status = self.harness.updater(fetch=api).run("check")
        self.assertIn("upstream_version_mismatch", codes(status))
        self.assertIsNone(status["candidate"])

    def test_truncated_compare_is_not_trusted(self):
        # 让本地缺少上游 commit，从而走 GitHub compare 分支
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp) / "clone"
            subprocess.run(["git", "clone", "-q", "--no-local", str(self.harness.repo), str(clone)],
                           check=True, capture_output=True)
            # 只保留 v0.2.17，删掉 v0.2.19 的对象：用 shallow 之外的简单办法——重置到主干历史
            git(clone, "checkout", "-q", "hardened")
            api = self.harness.api
            api.route("/releases/latest", release_payload(tag="v0.3.0"))
            api.route("/git/ref/tags/v0.3.0",
                      {"object": {"sha": "a" * 40, "type": "commit"}})
            api.route("/compare/" + self.harness.base_commit + "..." + "a" * 40,
                      {"status": "ahead", "total_commits": 1, "files": [
                          {"status": "modified", "filename": f"f{i}.py"} for i in range(300)
                      ]})
            status = self.harness.updater(tree=clone, fetch=api).run("check")
            self.assertIn("compare_truncated", codes(status))
            self.assertEqual(status["status"], "needs_review")
            self.assertFalse(status["ready"])

    def test_errors_never_carry_url_or_credentials(self):
        def boom(url, etag=None, proxy=None, timeout=15.0):
            raise up.NetworkError(
                "network_unreachable",
                "failed https://user:secret@api.github.com/repos?access_token=abc123",
            )

        status = self.harness.updater(fetch=boom).run("check")
        serialized = json.dumps(status, ensure_ascii=False)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("access_token", serialized)
        self.assertNotIn("https://", serialized)
        self.assertEqual(status["status"], "error")


# --------------------------------------------------------------------------- #
# 候选准备
# --------------------------------------------------------------------------- #
class PrepareTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.harness = Harness(Path(self._tmp.name))
        self.harness.default_routes()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_doc_only_update_prepares_candidate(self):
        before = {
            rel: (self.harness.tree / rel).read_bytes()
            for rel in ("VERSION", "CHANGELOG.md", "proxy/app.py", "proxy/util.py")
        }
        status = self.harness.updater().run("prepare")

        self.assertEqual(status["status"], "prepared")
        self.assertTrue(status["ready"])
        self.assertTrue(status["upstream_code_identical_to_baseline"])
        self.assertEqual(status["action"], "install")
        self.assertEqual(status["current"], "0.2.17.1")
        self.assertEqual(status["latest"], "0.2.19")
        self.assertEqual(status["upstream_commit"], self.harness.latest_commit)
        self.assertFalse(status["installed"])

        candidate = status["candidate"]
        self.assertIsNotNone(candidate)
        self.assertFalse(candidate["installed"])
        self.assertTrue(candidate["code_matches_trusted_tree"])
        tree = Path(candidate["tree"])
        self.assertTrue(tree.is_dir())
        self.assertFalse((tree / ".git").exists())
        self.assertEqual((tree / "VERSION").read_text(), "0.2.19\n")

        changelog = (tree / "CHANGELOG.md").read_text()
        self.assertIn("## v0.2.19", changelog)
        self.assertIn("## v0.2.18", changelog)
        self.assertIn("## v0.2.17", changelog)
        self.assertLess(changelog.index("v0.2.19"), changelog.index("v0.2.18"))
        self.assertEqual(changelog.count("## v0.2.17"), 1)

        # 代码逐字节相同；源树一字未改
        self.assertEqual((tree / "proxy/app.py").read_bytes(), before["proxy/app.py"])
        self.assertEqual((tree / "proxy/util.py").read_bytes(), before["proxy/util.py"])
        for rel, data in before.items():
            self.assertEqual((self.harness.tree / rel).read_bytes(), data, rel)

        meta = json.loads(Path(candidate["metadata"]).read_text())
        self.assertFalse(meta["installed"])
        self.assertEqual(meta["upstream"]["commit"], self.harness.latest_commit)
        self.assertEqual(meta["baseline_commit"], self.harness.base_commit)
        self.assertTrue(meta["verified"]["code_matches_trusted_tree"])
        self.assertTrue(meta["verified"]["only_documents_changed"])
        self.assertFalse(meta["verified"]["upstream_code_executed"])
        self.assertEqual(
            meta["tree_digest"], up.manifest_digest(up.manifest_of_dir(tree))
        )

    def test_version_suffix_and_repeat_prepare_reuses_candidate(self):
        status = self.harness.updater(version_suffix="1").run("prepare")
        self.assertEqual(status["status"], "prepared")
        tree = Path(status["candidate"]["tree"])
        self.assertEqual((tree / "VERSION").read_text(), "0.2.19.1\n")
        first_dir = status["candidate"]["dir"]

        # 同一版本重复 prepare：复用同一个候选，不新建、不覆盖
        again = self.harness.updater(version_suffix="1").run("prepare")
        self.assertEqual(again["status"], "prepared")
        self.assertTrue(again["candidate"]["reused"])
        self.assertEqual(again["candidate"]["dir"], first_dir)
        self.assertEqual(len(list((self.harness.work / "candidates").iterdir())), 1)

    def test_tampered_candidate_is_not_reused(self):
        status = self.harness.updater(version_suffix="1").run("prepare")
        tree = Path(status["candidate"]["tree"])
        (tree / "proxy" / "app.py").write_text("KEEP-ME\n", encoding="utf-8")
        again = self.harness.updater(version_suffix="1").run("prepare")
        self.assertIn("candidate_tampered", codes(again))
        self.assertFalse(again["ready"])
        self.assertIsNone(again["candidate"])
        self.assertEqual((tree / "proxy" / "app.py").read_text(), "KEEP-ME\n")  # 绝不覆盖

    def test_foreign_directory_is_never_overwritten(self):
        dest = (
            self.harness.work
            / "candidates"
            / f"fnmedia-ext-0.2.19-{self.harness.latest_commit[:12]}"
        )
        dest.mkdir(parents=True)
        (dest / "keep.txt").write_text("keep\n", encoding="utf-8")
        status = self.harness.updater().run("prepare")
        self.assertIn("candidate_exists", codes(status))
        self.assertFalse(status["ready"])
        self.assertIsNone(status["candidate"])
        self.assertEqual((dest / "keep.txt").read_text(), "keep\n")
        self.assertFalse((dest / "tree").exists())

    def test_no_update_when_trusted_tree_is_ahead(self):
        write_files(self.harness.tree, {"VERSION": "0.2.19.1\n"})
        status = self.harness.updater().run("prepare")
        self.assertEqual(status["status"], "up_to_date")
        self.assertTrue(status["local_ahead"])
        self.assertFalse(status["ready"])
        self.assertIsNone(status["candidate"])
        self.assertEqual(status["errors"], [])

    def test_genuine_regression_is_flagged(self):
        write_files(self.harness.tree, {"VERSION": "0.3.0\n"})
        status = self.harness.updater().run("check")
        self.assertIn("version_regression", codes(status))
        self.assertTrue(status["needs_review"])
        self.assertFalse(status["ready"])

    def test_baseline_equals_release_is_doc_only_ready(self):
        # 受审基线恰好就是最新 release 的 commit：变更集为空，代码天然相同，可准备文档升级
        status = self.harness.updater(baseline="v0.2.19").run("check")
        self.assertEqual(status["status"], "update_available")
        self.assertTrue(status["ready"])
        self.assertEqual(status["errors"], [])
        self.assertEqual(status["baseline_commit"], self.harness.latest_commit)
        self.assertEqual(status["diff_source"], "identical")
        self.assertTrue(status["upstream_code_identical_to_baseline"])
        self.assertEqual(status["changed_paths"], {"allowed": [], "blocked": []})


# --------------------------------------------------------------------------- #
# 串行 / 目录护栏
# --------------------------------------------------------------------------- #
class GuardTests(unittest.TestCase):
    def test_flock_is_serial(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "s.json"
            with up.StateStore(state, timeout=1.0):
                with self.assertRaises(up.LockTimeout):
                    with up.StateStore(state, timeout=0.2):
                        pass
            with up.StateStore(state, timeout=0.2) as store:
                store.data["probe"] = True
                store.save()
            self.assertTrue(json.loads(state.read_text())["probe"])

    def test_corrupt_state_is_not_silently_reset(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "s.json"
            state.write_text("{not json")
            with self.assertRaises(up.StateCorrupt):
                with up.StateStore(state, timeout=0.2):
                    pass

    def test_work_root_inside_tree_is_refused(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(Path(tmp) / "r", {"VERSION": "0.2.17\n", "CHANGELOG.md": "# 日志\n"})
            updater = up.Updater(
                tree=repo,
                state_path=Path(tmp) / "state.json",
                baseline="HEAD",
                fetch=FakeAPI(),
                work_root=repo / "work",
            )
            status = updater.run("check")
            self.assertEqual(status["status"], "error")
            self.assertIn("work_root_inside_tree", codes(status))

    def test_non_git_tree_and_unknown_baseline_are_reported(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / "plain"
            plain.mkdir()
            (plain / "VERSION").write_text("0.2.17\n", encoding="utf-8")
            updater = up.Updater(
                tree=plain,
                state_path=Path(tmp) / "state.json",
                baseline="v0.2.19",
                fetch=FakeAPI(),
                work_root=Path(tmp) / "work",
            )
            status = updater.run("check")
            self.assertEqual(status["status"], "error")
            self.assertIn("tree_not_git", codes(status))

        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(Path(tmp) / "r", {"VERSION": "0.2.17\n", "CHANGELOG.md": "# 日志\n"})
            updater = up.Updater(
                tree=repo,
                state_path=Path(tmp) / "state.json",
                baseline="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                fetch=FakeAPI(),
                work_root=Path(tmp) / "work",
            )
            status = updater.run("check")
            self.assertEqual(status["status"], "needs_review")
            self.assertIn("baseline_unresolved", codes(status))

    def test_cross_host_redirect_is_rejected(self):
        handler = up._SameHostRedirects()
        for target in (
            "https://evil.example.com/repos",
            "http://api.github.com/repos",
            "https://api.github.com.evil.example/repos",
        ):
            with self.assertRaises(up.PolicyError, msg=target):
                handler.redirect_request(None, None, 302, "Found", None, target)

    def test_symlinked_file_blocks_prepare(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(Path(tmp) / "r", {"VERSION": "0.2.17\n", "CHANGELOG.md": "# 日志\n"})
            (repo / "link.py").symlink_to("/etc/hostname")
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "symlink")
            home = Path(tmp) / "home"
            home.mkdir()
            with self.assertRaises(up.TreeError) as ctx:
                up.list_tracked_files(repo, home, git_bin="git")
            self.assertEqual(ctx.exception.code, "tree_symlink")


if __name__ == "__main__":
    unittest.main()
