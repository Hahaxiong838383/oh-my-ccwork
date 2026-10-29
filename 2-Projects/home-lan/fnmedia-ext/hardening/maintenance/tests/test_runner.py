"""runner.py 的离线测试。

原则：不联网、不碰真 NAS、不读凭据、不改 main。
* 远端（NAS）用一个**假 ssh** 在本地目录里执行 runner 内嵌的**真实远端脚本**，
  状态文件是真实的原子写盘结果，不是 mock 出来的 JSON。
* 安装/构建/官方探测用**假可执行文件**（ssh / trim-cli / fnpack / systemctl）
  捕获真实 argv，副作用（VERSION、unit 状态）落在本地"NAS"目录，
  runner 的验证逻辑读到的是真实文件与真实 UDS 401 响应。
* 准备阶段跑**真实 update_prepare.py**（子进程 + 假 GitHub fetch 包装脚本），
  因此 git 树、候选目录、版本后缀、needs_review 都是真实产物。

运行：python3 -m unittest discover -s tests -v
或   python3 tests/test_runner.py
"""

from __future__ import annotations

import json
import os
import re
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import suppress
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(TESTS))

import runner  # noqa: E402
import update_prepare as up  # noqa: E402
from test_update_prepare import (  # noqa: E402
    commit,
    contents,
    git,
    release_payload,
    write_files,
)

STATUS_KEYS = (
    "heartbeat", "status", "message", "latest_version",
    "last_check", "next_check", "last_error", "request_id",
)
WIZARD = '[{"key":"wizard_agree_terms","value":["agree"]}]'

BASE_CHANGELOG = (
    "# 更新日志\n\n"
    "## v0.2.19 — 2026-10-28\n\n初始版本。\n"
)
UPSTREAM_CHANGELOG = (
    "# 更新日志\n\n"
    "## v0.2.20 — 2026-10-29\n\n仅文档变化。\n\n"
    "## v0.2.19 — 2026-10-28\n\n初始版本。\n"
)

BUILD_STUB = """#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "@BUILD_LOG@"
[ "$1" = "--public" ] || { echo "build: missing --public" >&2; exit 9; }
out=""
fnpack=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --fnpack) fnpack="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$fnpack" ] || { echo "build: missing --fnpack" >&2; exit 8; }
[ -d wheelhouse ] && [ -n "$(ls -A wheelhouse)" ] || { echo "build: wheelhouse missing" >&2; exit 7; }
ver="$(tr -d '[:space:]' < VERSION)"
mkdir -p "$out"
"$fnpack" build --directory . --version "$ver" > "@FNPACK_LOG@.out"
printf 'fake fpk %s\\n' "$ver" > "$out/fnmedia-ext-${ver}-public.fpk"
"""

FAKE_SSH = """#!/usr/bin/env python3
import json, os, subprocess, sys

LOG = "@SSH_LOG@"
NAS = "@NAS@"
BIN = "@BIN@"
args = sys.argv[1:]
if os.environ.get("FAKE_SSH_FAIL") == "1":
    sys.stderr.write("ssh: connect to host 192.168.1.43 port 22: Connection refused\\n")
    sys.exit(255)
_trim_command = " ".join(args)
if (os.environ.get("FAKE_SSH_FAIL_TRIM") == "1" and "trim-cli" in _trim_command
        and "--dry-run" not in _trim_command):
    _marker = os.path.join(NAS, "trim-failed-once")
    if not os.path.exists(_marker):
        open(_marker, "w").close()
        sys.stderr.write("ssh: connect to host 192.168.1.43 port 22: Connection timed out\\n")
        sys.exit(255)
target = ""
index = 0
while index < len(args):
    token = args[index]
    if token == "-o":
        index += 2
        continue
    if token.startswith("-"):
        index += 1
        continue
    target = token
    index += 1
    break
command = " ".join(args[index:])
with open(LOG, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"target": target, "command": command}, ensure_ascii=False) + "\\n")
env = dict(os.environ)
env["FNMEDIA_MAINT_TEST_ROOT"] = NAS
env["PATH"] = BIN + ":" + env.get("PATH", "/usr/bin:/bin")
proc = subprocess.run(["/bin/sh", "-c", command], env=env)
sys.exit(proc.returncode)
"""

FAKE_SYSTEMCTL = """#!/bin/bash
if [ -f "@NAS@/unit-state" ]; then cat "@NAS@/unit-state"; else echo inactive; fi
"""

FAKE_TRIM = """#!/usr/bin/env python3
import json, os, re, sys

LOG = "@TRIM_LOG@"
NAS = "@NAS@"

def write_version(version):
    if not version:
        return
    with open(os.path.join(NAS, "app", "VERSION"), "w", encoding="utf-8") as handle:
        handle.write(version + "\\n")

def set_unit(state):
    with open(os.path.join(NAS, "unit-state"), "w", encoding="utf-8") as handle:
        handle.write(state + "\\n")

def consume_mode():
    # 每种故障只影响一次真实安装，回退安装走正常路径
    with open(os.path.join(NAS, "trim-mode"), "w", encoding="utf-8") as handle:
        handle.write("ok\\n")

args = sys.argv[1:]
if os.environ.get("FAKE_SSH_FAIL_TRIM") == "1" and "--dry-run" not in args:
    marker = os.path.join(NAS, "trim-failed-once")
    if not os.path.exists(marker):
        open(marker, "w").close()
        sys.exit(255)
with open(LOG, "a", encoding="utf-8") as handle:
    handle.write(json.dumps([sys.argv[0]] + args, ensure_ascii=False) + "\\n")
mode = "ok"
try:
    with open(os.path.join(NAS, "trim-mode"), "r", encoding="utf-8") as handle:
        mode = handle.read().strip() or "ok"
except OSError:
    pass
fpk = ""
for item in args:
    if item.endswith(".fpk"):
        fpk = item
match = re.search(r"fnmedia-ext-(\\d+(?:\\.\\d+){1,3})(?:-|\\.fpk)", os.path.basename(fpk))
version = match.group(1) if match else (args[args.index("--version")+1] if "--version" in args else "")
dry_run = "--dry-run" in args
if mode == "wrong_version" and not dry_run:
    version = "9.9.9"
if dry_run:
    print(json.dumps({"dry_run": True, "version": version, "download_status": {"installedInfo": {"canUpgrade": mode != "upgrade_refused"}}}))
    sys.exit(0)
if mode == "fail_transport":
    consume_mode()
    sys.exit(255)
if mode == "fail_big":
    consume_mode()
    sys.stdout.write("BLOB-START " + "x" * 4000 + " no space left on device BLOB-END\\n")
    print(json.dumps({"code": 12, "msg": "no space left on device"}))
    write_version(version)
    sys.exit(4)
write_version(version)
if mode == "inactive":
    consume_mode()
    set_unit("inactive")
else:
    if mode == "wrong_version":
        consume_mode()
    set_unit("active")
print(json.dumps({"installed": True, "version": version}))
"""

FAKE_FNPACK = """#!/usr/bin/env python3
import json, sys
with open("@FNPACK_LOG@", "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\\n")
print("[fake fnpack] build ok")
"""

PREPARE_WRAPPER = """#!/usr/bin/env python3
import json, sys

SPEC = json.loads(@SPEC@)
sys.path.insert(0, SPEC["prepare_dir"])
import update_prepare as up

ROUTES = SPEC["routes"]

def fetch(url, etag=None, proxy=None, timeout=15.0):
    payload = ROUTES.get(url)
    if payload is None:
        raise up.HttpStatusError(404)
    return up.HttpResult(200, payload, None)

with open(SPEC["argv_log"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\\n")

parser = up.build_parser()
args = parser.parse_args(sys.argv[1:])
updater = up.Updater(
    args.tree, args.state, args.baseline,
    slug=args.repo, fetch=fetch, proxy=None,
    timeout=args.timeout, summary_limit=args.summary_limit,
    interval=args.interval, version_suffix=args.version_suffix,
    work_root=args.work_root, lock_timeout=args.lock_timeout,
)
print(json.dumps(updater.run("check" if args.check else "prepare"), ensure_ascii=False))
"""


class HttpStub:
    """真实 UDS HTTP 服务：默认返回 401，可被测试切成 200。"""

    def __init__(self, path: Path, status_file: Path) -> None:
        self.path = path
        self.status_file = status_file
        state_file = status_file

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                self.rfile.readline(4096)
                while True:
                    line = self.rfile.readline(4096)
                    if line in (b"\r\n", b"\n", b""):
                        break
                try:
                    status = state_file.read_text().strip() or "401 Unauthorized"
                except OSError:
                    status = "401 Unauthorized"
                body = b'{"code":401,"msg":"login required"}'
                self.wfile.write(("HTTP/1.1 " + status + "\r\n").encode())
                self.wfile.write(b"Content-Type: application/json\r\n")
                self.wfile.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n")
                self.wfile.write(b"Connection: close\r\n\r\n" + body)

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        with suppress(FileNotFoundError):
            path.unlink()
        self.server = Server(str(path), Handler)
        os.chmod(path, 0o666)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        with suppress(OSError):
            self.path.unlink()


class Fixture:
    def __init__(self, tmp: Path, *, code_change: bool = False,
                 nas_version: str = "0.2.19.1") -> None:
        self.tmp = tmp
        self.nas = tmp / "nas"
        self.state_dir = tmp / "state"
        self.work = tmp / "work"
        self.bin = tmp / "bin"
        self.wheelhouse = tmp / "wheelhouse"
        self.logs = tmp / "logs"
        for path in (self.nas / "app", self.nas / "official", self.bin,
                     self.wheelhouse, self.logs, self.state_dir):
            path.mkdir(parents=True, exist_ok=True)
        (self.nas / "app" / "VERSION").write_text(nas_version + "\n")
        (self.nas / "unit-state").write_text("active\n")
        (self.nas / "http-status").write_text("401 Unauthorized\n")
        (self.nas / "official" / "trim-media").write_text("official-exe\n")
        (self.nas / "official" / "manifest").write_text("official-manifest\n")
        (self.wheelhouse / "dummy-1.0-py3-none-any.whl").write_text("wheel\n")

        self.build_log = self.logs / "build.log"
        self.fnpack_log = self.logs / "fnpack.log"
        self.trim_log = self.logs / "trim.log"
        self.ssh_log = self.logs / "ssh.log"
        self.prepare_argv_log = self.logs / "prepare-argv.log"
        for path in (self.build_log, self.fnpack_log, self.trim_log,
                     self.ssh_log, self.prepare_argv_log):
            path.write_text("")

        self.repo = self._make_repo(code_change)
        self.prepare_script = self._write_prepare_wrapper()
        self._write_fakes()

        # 官方 socket（只需是 0666 的 socket 文件）
        self.upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.upstream.bind(str(self.nas / "trim_media_upstream.sock"))
        self.upstream.listen(1)
        os.chmod(self.nas / "trim_media_upstream.sock", 0o666)
        self.http = HttpStub(self.nas / "trim_media.sock", self.nas / "http-status")

    # -- 夹具 ------------------------------------------------------------- #
    def _make_repo(self, code_change: bool) -> Path:
        repo = self.tmp / "repo"
        repo.mkdir()
        git(repo, "init", "-q", "-b", "main")
        write_files(repo, {
            "VERSION": "0.2.19\n",
            "CHANGELOG.md": BASE_CHANGELOG,
            "proxy/app.py": "PROXY = 'upstream'\n",
            "README.md": "readme\n",
        })
        build = repo / "packaging" / "fpk" / "build.sh"
        build.parent.mkdir(parents=True)
        build.write_text(
            BUILD_STUB.replace("@BUILD_LOG@", str(self.build_log))
                      .replace("@FNPACK_LOG@", str(self.fnpack_log)),
            encoding="utf-8",
        )
        os.chmod(build, 0o755)
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "release 0.2.19")
        git(repo, "tag", "v0.2.19")
        self.baseline_commit = git(repo, "rev-parse", "HEAD")

        upstream_files = {"VERSION": "0.2.20\n", "CHANGELOG.md": UPSTREAM_CHANGELOG}
        if code_change:
            upstream_files["proxy/app.py"] = "PROXY = 'upstream-0.2.20'\n"
        self.upstream_commit = commit(repo, upstream_files, message="release: v0.2.20")
        git(repo, "tag", "v0.2.20")

        git(repo, "checkout", "-q", "-b", "hardened", self.baseline_commit)
        write_files(repo, {"VERSION": "0.2.19.1\n"})
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "harden")
        self.tree = repo
        return repo

    def _routes(self) -> dict:
        base = f"{up.API_ROOT}/repos/{up.DEFAULT_SLUG}"
        commit_sha = self.upstream_commit
        return {
            base + "/releases/latest": release_payload(
                "v0.2.20", body="## v0.2.20 — 2026-10-29\n\n仅文档变化。\n"),
            base + "/git/ref/tags/v0.2.20": {
                "ref": "refs/tags/v0.2.20",
                "object": {"sha": commit_sha, "type": "commit"},
            },
            base + f"/contents/VERSION?ref={commit_sha}": contents("0.2.20\n", "VERSION"),
            base + f"/contents/CHANGELOG.md?ref={commit_sha}": contents(
                UPSTREAM_CHANGELOG, "CHANGELOG.md"),
        }

    def _write_prepare_wrapper(self, routes: dict | None = None) -> Path:
        spec = {
            "prepare_dir": str(ROOT),
            "routes": routes if routes is not None else self._routes(),
            "argv_log": str(self.prepare_argv_log),
        }
        path = self.tmp / "prepare_offline.py"
        path.write_text(
            PREPARE_WRAPPER.replace("@SPEC@", repr(json.dumps(spec, ensure_ascii=False))),
            encoding="utf-8",
        )
        os.chmod(path, 0o755)
        return path

    def _write_fakes(self) -> None:
        ssh = self.bin / "ssh"
        ssh.write_text(
            FAKE_SSH.replace("@SSH_LOG@", str(self.ssh_log))
                    .replace("@NAS@", str(self.nas))
                    .replace("@BIN@", str(self.bin)),
            encoding="utf-8",
        )
        systemctl = self.bin / "systemctl"
        systemctl.write_text(FAKE_SYSTEMCTL.replace("@NAS@", str(self.nas)), encoding="utf-8")
        trim = self.bin / "trim-cli"
        trim.write_text(
            FAKE_TRIM.replace("@TRIM_LOG@", str(self.trim_log)).replace("@NAS@", str(self.nas)),
            encoding="utf-8",
        )
        helper = self.bin / "upgrade-helper.py"
        helper.write_text("import argparse,subprocess\np=argparse.ArgumentParser()\np.add_argument('--trim-cli');p.add_argument('--remote-fpk');p.add_argument('--version')\na=p.parse_args()\nraise SystemExit(subprocess.call([a.trim_cli,'--profile','fnos1','app','update','fnmedia-ext','--version',a.version,'--yes']))\n")
        fnpack = self.bin / "fnpack"
        fnpack.write_text(
            FAKE_FNPACK.replace("@FNPACK_LOG@", str(self.fnpack_log)), encoding="utf-8")
        for item in (ssh, systemctl, trim, fnpack):
            os.chmod(item, 0o755)

    # -- 运行 ------------------------------------------------------------- #
    def runner_args(self, *, last_good_fpk: Path | None = None) -> list[str]:
        args = [
            "--trusted-tree", str(self.tree),
            "--work-root", str(self.work),
            "--state-dir", str(self.state_dir),
            "--baseline", "v0.2.19",
            "--prepare-script", str(self.prepare_script),
            "--fnpack", str(self.bin / "fnpack"),
            "--wheelhouse", str(self.wheelhouse),
            "--trim-cli", str(self.bin / "trim-cli"),
            "--upgrade-helper", str(self.bin / "upgrade-helper.py"),
            "--app-dir", str(self.nas / "app"),
            "--remote-dir", str(self.nas),
            "--target-socket", str(self.nas / "trim_media.sock"),
            "--upstream-socket", str(self.nas / "trim_media_upstream.sock"),
            "--official-artifact", str(self.nas / "official" / "trim-media"),
            "--official-artifact", str(self.nas / "official" / "manifest"),
            "--ssh-bin", str(self.bin / "ssh"),
            "--check-interval", "3600",
            "--heartbeat-interval", "0",
            "--verify-poll", "1",
            "--timeout-ssh", "10",
            "--timeout-probe", "10",
            "--timeout-prepare", "60",
            "--timeout-build", "30",
            "--timeout-upload", "30",
            "--timeout-install", "60",
            "--timeout-verify", "6",
            "--timeout-rollback", "60",
            "--log-level", "ERROR",
        ]
        if last_good_fpk is not None:
            args += ["--last-good-fpk", str(last_good_fpk)]
        return args

    def run(self, *extra: str) -> int:
        return runner.main(self.runner_args() + list(extra))

    # -- 队列/状态 -------------------------------------------------------- #
    def status(self) -> dict:
        return json.loads((self.nas / "update-status.json").read_text())

    def request(self, *, request_id: str | None = None, action: str = "update",
                **extra) -> dict:
        payload = {
            "id": request_id or uuid.uuid4().hex,
            "action": action,
            "requested_at": int(time.time()),
            "current_version": "0.2.19.1",
        }
        payload.update(extra)
        (self.nas / "update-request.json").write_text(json.dumps(payload))
        return payload

    def seed_state(self, **values) -> None:
        payload = {"schema": runner.SCHEMA, "last_check_at": int(time.time())}
        payload.update(values)
        (self.state_dir / "runner-state.json").write_text(json.dumps(payload))

    def local_state(self) -> dict:
        return json.loads((self.state_dir / "runner-state.json").read_text())

    def set_nas_version(self, version: str) -> None:
        (self.nas / "app" / "VERSION").write_text(version + "\n")

    def nas_version(self) -> str:
        return (self.nas / "app" / "VERSION").read_text().strip()

    def set_trim_mode(self, mode: str) -> None:
        (self.nas / "trim-mode").write_text(mode + "\n")

    def set_http_status(self, status: str) -> None:
        (self.nas / "http-status").write_text(status + "\n")

    def make_previous_fpk(self, version: str = "0.2.19.1") -> Path:
        path = self.tmp / "prev" / f"fnmedia-ext-{version}.fpk"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"previous good {version}\n")
        return path

    def trim_calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.trim_log.read_text().splitlines() if line]

    def build_calls(self) -> list[str]:
        return [line for line in self.build_log.read_text().splitlines() if line]

    def prepare_calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.prepare_argv_log.read_text().splitlines() if line]

    def ssh_calls(self) -> list[dict]:
        return [json.loads(line) for line in self.ssh_log.read_text().splitlines() if line]

    def close(self) -> None:
        self.http.close()
        self.upstream.close()
        with suppress(OSError):
            (self.nas / "trim_media_upstream.sock").unlink()


class RunnerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="runner-test-")
        self.addCleanup(self._tmp.cleanup)

    def fixture(self, **kwargs) -> Fixture:
        fx = Fixture(Path(self._tmp.name), **kwargs)
        self.addCleanup(fx.close)
        return fx

    # -- 公共断言 --------------------------------------------------------- #
    def assertStatusContract(self, status: dict) -> None:
        for key in STATUS_KEYS:
            self.assertIn(key, status, key)
        self.assertLess(abs(time.time() - float(status["heartbeat"])), 60)
        self.assertLessEqual(len(status["message"]), 200)
        self.assertLessEqual(len(status["last_error"]), 200)

    def assertNoRawToolOutput(self, status: dict) -> None:
        blob = json.dumps(status, ensure_ascii=False)
        self.assertNotIn("BLOB-START", blob)
        self.assertNotIn("xxxxxxx", blob)
        self.assertNotIn("stdout", blob)

    def assertTrimInvocation(self, argv: list[str], fpk: Path, *, dry_run: bool,
                             trim_cli: Path, package_dir: Path) -> None:
        remote_name = f"fnmedia-ext-{runner.version_from_fpk_name(fpk.name)}-{runner.sha256_file(fpk)[:12]}.fpk"
        expected = [str(trim_cli), "--profile", "fnos1", "app", "install-fpk"]
        if dry_run:
            expected.append("--dry-run")
        expected += [str(fpk.resolve()), "--volume-id", "3", "--yes",
                     "--accept-license", "--custom-parameters", WIZARD]
        if not dry_run:
            expected = [str(trim_cli), "--profile", "fnos1", "app", "update", "fnmedia-ext",
                        "--version", runner.version_from_fpk_name(fpk.name), "--yes"]
        self.assertEqual(argv, expected)


# --------------------------------------------------------------------------- #
# 检查
# --------------------------------------------------------------------------- #
class CheckTests(RunnerTestCase):
    def test_scheduled_check_reports_update_without_candidate(self):
        fx = self.fixture()
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertStatusContract(status)
        self.assertEqual(status["status"], "update_available")
        self.assertEqual(status["latest_version"], "0.2.20")
        self.assertEqual(status["request_id"], "")
        self.assertIn("0.2.20.1", status["message"])

        calls = fx.prepare_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("--check", calls[0])
        self.assertNotIn("--prepare", calls[0])
        self.assertNotIn("--version-suffix", calls[0])
        self.assertEqual(calls[0][calls[0].index("--baseline") + 1], "v0.2.19")
        self.assertFalse((fx.work / "prepare" / "candidates").exists())
        self.assertEqual(fx.trim_calls(), [])
        self.assertEqual(fx.build_calls(), [])
        for call in fx.ssh_calls():
            self.assertEqual(call["target"], "hahaxiong83@192.168.1.43")

    def test_installed_nas_version_wins_over_trusted_tree(self):
        fx = self.fixture(nas_version="0.2.20.1")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "up_to_date")
        self.assertIn("0.2.20.1", status["message"])
        self.assertEqual(fx.trim_calls(), [])

    def test_code_change_needs_review_and_never_creates_candidate(self):
        fx = self.fixture(code_change=True)
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertStatusContract(status)
        self.assertEqual(status["status"], "needs_review")
        self.assertIn("需人工适配", status["message"])
        self.assertIn("proxy/app.py", status["message"])
        self.assertFalse((fx.work / "prepare" / "candidates").exists())
        self.assertEqual(fx.build_calls(), [])
        self.assertEqual(fx.trim_calls(), [])

    def test_up_to_date_when_upstream_equals_tree(self):
        fx = self.fixture()
        # 把上游"最新"回退成 0.2.19（与可信树 0.2.19.1 的本地修订对齐）
        routes = fx._routes()
        base = f"{up.API_ROOT}/repos/{up.DEFAULT_SLUG}"
        routes[base + "/releases/latest"] = release_payload("v0.2.19")
        routes[base + "/git/ref/tags/v0.2.19"] = {
            "ref": "refs/tags/v0.2.19",
            "object": {"sha": fx.baseline_commit, "type": "commit"},
        }
        fx.prepare_script = fx._write_prepare_wrapper(routes)
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.status()["status"], "up_to_date")
        self.assertEqual(fx.status()["latest_version"], "0.2.19")


# --------------------------------------------------------------------------- #
# 升级成功路径：argv 契约 + 真实副作用
# --------------------------------------------------------------------------- #
class UpdateTests(RunnerTestCase):
    def test_update_button_on_latest_release_is_not_needs_review(self):
        fx = self.fixture()
        routes = fx._routes()
        base = f"{up.API_ROOT}/repos/{up.DEFAULT_SLUG}"
        routes[base + "/releases/latest"] = release_payload("v0.2.19")
        routes[base + "/git/ref/tags/v0.2.19"] = {
            "ref": "refs/tags/v0.2.19", "object": {"sha": fx.baseline_commit, "type": "commit"}}
        fx.prepare_script = fx._write_prepare_wrapper(routes)
        req = fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.status()["status"], "up_to_date")
        self.assertEqual(fx.status()["request_id"], req["id"])
        self.assertEqual(fx.trim_calls(), [])

    def test_appcenter_refuses_upgrade_so_no_install_starts(self):
        fx = self.fixture()
        fx.set_trim_mode("upgrade_refused")
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.status()["status"], "failed")
        self.assertEqual(len(fx.trim_calls()), 1)
        self.assertIn("--dry-run", fx.trim_calls()[0])
        self.assertEqual(fx.nas_version(), "0.2.19.1")

    def test_unreadable_official_file_stops_before_build(self):
        fx = self.fixture()
        (fx.nas / "official" / "manifest").unlink()
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.status()["status"], "failed")
        self.assertEqual(fx.build_calls(), [])
        self.assertEqual(fx.trim_calls(), [])

    def test_update_builds_installs_and_verifies(self):
        fx = self.fixture()
        request = fx.request(action="update")
        self.assertEqual(fx.run(), 0)

        status = fx.status()
        self.assertStatusContract(status)
        self.assertNoRawToolOutput(status)
        self.assertEqual(status["status"], "success", status)
        self.assertEqual(status["request_id"], request["id"])
        self.assertIn("0.2.20.1", status["message"])
        self.assertEqual(status["installed_version"], "0.2.20.1")
        self.assertEqual(fx.nas_version(), "0.2.20.1")

        # 准备阶段：--prepare + 加固后缀 1，且候选在独立工作目录
        calls = fx.prepare_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("--prepare", calls[0])
        self.assertEqual(calls[0][calls[0].index("--version-suffix") + 1], "1")
        self.assertIn(str(fx.work / "prepare"), calls[0])

        candidate = fx.work / "prepare" / "candidates" / f"fnmedia-ext-0.2.20.1-{fx.upstream_commit[:12]}"
        self.assertTrue((candidate / "candidate.json").is_file())
        metadata = json.loads((candidate / "candidate.json").read_text())
        self.assertEqual(metadata["version"], "0.2.20.1")
        self.assertEqual(sorted(metadata["changed_files"]), ["CHANGELOG.md", "VERSION"])

        # 构建：可信 build.sh + 本地 fnpack + 本地 wheelhouse，输出到 work/dist
        builds = fx.build_calls()
        self.assertEqual(len(builds), 1)
        tokens = builds[0].split()
        self.assertEqual(tokens[0], "--public")
        self.assertIn("--fnpack", tokens)
        self.assertEqual(tokens[tokens.index("--fnpack") + 1], str(fx.bin / "fnpack"))
        self.assertEqual(tokens[tokens.index("--out") + 1], str(fx.work / "dist"))
        self.assertTrue((fx.work / "dist" / "fnmedia-ext-0.2.20.1.fpk").is_file())
        self.assertEqual(len([line for line in fx.fnpack_log.read_text().splitlines() if line]), 1)

        # 安装：先 dry-run 后正式，argv 完全白名单
        fpk = fx.work / "dist" / "fnmedia-ext-0.2.20.1.fpk"
        trims = fx.trim_calls()
        self.assertEqual(len(trims), 2)
        self.assertNotIn(str(fx.bin / "trim-cli"), fx.ssh_log.read_text())
        self.assertTrimInvocation(trims[0], fpk, dry_run=True,
                                  trim_cli=fx.bin / "trim-cli", package_dir=fx.nas / "packages")
        self.assertTrimInvocation(trims[1], fpk, dry_run=False,
                                  trim_cli=fx.bin / "trim-cli", package_dir=fx.nas / "packages")

        # 上传的文件真实落在"NAS"上（0660 + SHA 一致）
        uploaded = fx.nas / "packages" / f"fnmedia-ext-0.2.20.1-{runner.sha256_file(fpk)[:12]}.fpk"
        self.assertTrue(uploaded.is_file())
        self.assertEqual(stat.S_IMODE(uploaded.stat().st_mode), 0o660)
        self.assertEqual(uploaded.read_bytes(), fpk.read_bytes())
        self.assertEqual(stat.S_IMODE((fx.nas / "update-status.json").stat().st_mode), 0o660)

        # 本地状态：last_good 轮换到新版本，供下一次回退
        state = fx.local_state()
        self.assertEqual(state["installed_version"], "0.2.20.1")
        self.assertEqual(state["last_good_fpk"], str(fx.work / "known-good" / "fnmedia-ext-0.2.20.1.fpk"))
        self.assertTrue(Path(state["last_good_fpk"]).is_file())
        self.assertTrue((fx.work / "known-good" / "fnmedia-ext-0.2.20.1.fpk").is_file())

    def test_update_skips_install_when_nas_already_has_version(self):
        fx = self.fixture(nas_version="0.2.20.1")
        request = fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "up_to_date")
        self.assertEqual(status["request_id"], request["id"])
        self.assertEqual(fx.trim_calls(), [])
        self.assertEqual(fx.build_calls(), [])
        # prepare 仍然跑过（候选就绪），只是不重复安装
        self.assertTrue(fx.prepare_calls())
        self.assertTrue((fx.work / "prepare" / "candidates").is_dir())

    def test_queue_strings_never_reach_commands(self):
        fx = self.fixture()
        fx.request(action="update", url="http://evil.invalid/payload",
                   command="rm -rf /", path="/etc/passwd", version="9.9.9")
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.status()["status"], "success")
        haystack = "\n".join(
            [call["command"] for call in fx.ssh_calls()]
            + [" ".join(argv) for argv in fx.trim_calls()]
            + fx.build_calls()
            + [" ".join(argv) for argv in fx.prepare_calls()]
        )
        for needle in ("evil.invalid", "rm -rf", "/etc/passwd", "9.9.9"):
            self.assertNotIn(needle, haystack)


# --------------------------------------------------------------------------- #
# 失败 / 回退
# --------------------------------------------------------------------------- #
class FailureTests(RunnerTestCase):
    def test_install_failure_is_classified_and_rolled_back(self):
        fx = self.fixture()
        previous = fx.make_previous_fpk()
        fx.set_trim_mode("fail_big")
        fx.seed_state(last_good_fpk=str(previous))
        request = fx.request(action="update")

        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertStatusContract(status)
        self.assertNoRawToolOutput(status)
        self.assertEqual(status["status"], "rolled_back", status)
        self.assertEqual(status["request_id"], request["id"])
        self.assertIn("disk_space", status["message"])
        self.assertIn("已回退到 0.2.19.1", status["message"])
        self.assertEqual(fx.nas_version(), "0.2.19.1")

        trims = fx.trim_calls()
        self.assertEqual(len(trims), 3)  # dry-run + 正式 + 回退
        self.assertIn("--dry-run", trims[0])
        self.assertNotIn("--dry-run", trims[1])
        self.assertNotIn("--dry-run", trims[2])
        self.assertIn("update", trims[2])
        self.assertEqual(trims[2][trims[2].index("--version") + 1], "0.2.19.1")
        self.assertEqual(fx.local_state()["installed_version"], "0.2.19.1")

    def test_install_failure_without_previous_requires_manual(self):
        fx = self.fixture()
        fx.set_trim_mode("fail_big")
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "failed")
        self.assertIn("需人工处理", status["message"])
        self.assertEqual(len(fx.trim_calls()), 2)

    def test_verify_failure_rolls_back_previous(self):
        fx = self.fixture()
        previous = fx.make_previous_fpk()
        fx.set_trim_mode("wrong_version")
        fx.seed_state(last_good_fpk=str(previous))
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "rolled_back", status)
        self.assertIn("验证失败", status["message"])
        self.assertEqual(fx.nas_version(), "0.2.19.1")
        trims = fx.trim_calls()
        self.assertEqual(len(trims), 3)

    def test_anonymous_probe_must_return_401(self):
        fx = self.fixture()
        previous = fx.make_previous_fpk()
        fx.seed_state(last_good_fpk=str(previous))
        fx.set_http_status("200 OK")
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "failed", status)
        self.assertIn("匿名访问返回 200", status["message"])
        self.assertEqual(fx.nas_version(), "0.2.19.1")

    def test_unit_inactive_fails_verification(self):
        fx = self.fixture()
        previous = fx.make_previous_fpk()
        fx.seed_state(last_good_fpk=str(previous))
        fx.set_trim_mode("inactive")
        fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "rolled_back", status)
        self.assertIn("service=inactive", status["message"])

    def test_install_command_failure_never_claims_success(self):
        """安装命令的 SSH 通信失败 ⇒ 结果未知：按验证判定，失败则回退，不谎称成功。"""
        fx = self.fixture()
        previous = fx.make_previous_fpk()
        fx.seed_state(last_good_fpk=str(previous))
        fx.request(action="update")
        fx.set_trim_mode("fail_transport")
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "rolled_back", status)
        self.assertIn("安装失败", status["message"])
        # 回退也用 appcenter：成功回退后 VERSION 仍是上一版本
        self.assertEqual(fx.nas_version(), "0.2.19.1")


# --------------------------------------------------------------------------- #
# 队列防御
# --------------------------------------------------------------------------- #
class QueueTests(RunnerTestCase):
    def test_duplicate_and_malformed_requests_are_ignored(self):
        fx = self.fixture()
        fx.seed_state(last_check_at=int(time.time()))
        done = uuid.uuid4().hex
        (fx.nas / "update-status.json").write_text(json.dumps({
            "schema": 1, "status": "success", "message": "已升级", "request_id": done,
            "heartbeat": int(time.time()), "latest_version": "0.2.20",
            "last_check": 0, "next_check": 0, "last_error": "",
        }))

        # 1) 已经确认过的 request_id：不重复处理
        fx.request(request_id=done, action="update")
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.trim_calls(), [])
        self.assertEqual(fx.prepare_calls(), [])
        self.assertEqual(fx.build_calls(), [])

        # 2) 非 UUID / 非白名单动作：一律不执行
        fx.request(request_id="../../etc/passwd", action="update")
        fx.request(request_id=uuid.uuid4().hex, action="shell")
        fx.request(request_id="deadbeef", action="update")
        for _ in range(3):
            self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.trim_calls(), [])
        self.assertEqual(fx.prepare_calls(), [])
        self.assertEqual(fx.build_calls(), [])
        self.assertEqual(fx.status()["request_id"], done)

    def test_expired_request_is_acknowledged_without_work(self):
        fx = self.fixture()
        stale = fx.request(action="update")
        path = fx.nas / "update-request.json"
        payload = json.loads(path.read_text())
        payload["requested_at"] = int(time.time()) - 3 * 86400
        path.write_text(json.dumps(payload))
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["request_id"], stale["id"])
        self.assertIn("过期", status["message"])
        self.assertEqual(fx.trim_calls(), [])

    def test_interrupted_attempt_is_failed_once_and_acked(self):
        fx = self.fixture()
        pending = fx.request(action="update")
        fx.seed_state(attempt={"id": pending["id"], "action": "update",
                               "started_at": int(time.time()) - 120})
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertEqual(status["status"], "failed")
        self.assertIn("中断", status["message"])
        self.assertEqual(status["request_id"], pending["id"])
        self.assertEqual(fx.trim_calls(), [])
        self.assertNotIn("attempt", fx.local_state())

        # 同一个 request 已被 ack，下一分钟不再重复处理
        self.assertEqual(fx.run(), 0)
        self.assertEqual(fx.trim_calls(), [])
        self.assertEqual(fx.status()["request_id"], pending["id"])

    def test_concurrent_run_holds_flock_and_skips(self):
        fx = self.fixture()
        fd = runner.acquire_lock(fx.state_dir / "runner.lock")
        self.assertIsNotNone(fd)
        try:
            self.assertEqual(fx.run(), 0)
        finally:
            runner.release_lock(fd)
        self.assertEqual(fx.ssh_calls(), [])

    def test_unreachable_nas_exits_nonzero_without_crash(self):
        fx = self.fixture()
        os.environ["FAKE_SSH_FAIL"] = "1"
        try:
            self.assertEqual(fx.run(), 2)
        finally:
            os.environ.pop("FAKE_SSH_FAIL", None)


# --------------------------------------------------------------------------- #
# 状态契约 / 错误映射 / 时序
# --------------------------------------------------------------------------- #
class ContractTests(RunnerTestCase):
    def test_request_id_only_advances_when_processing_ends(self):
        fx = self.fixture()
        request = fx.request(action="update")
        seen: list[dict] = []
        original = runner.Remote.write_status

        def spy(self, value, timeout):  # noqa: ANN001 - 只为观测写入序列
            seen.append(dict(value))
            return original(self, value, timeout)

        runner.Remote.write_status = spy
        try:
            self.assertEqual(fx.run(), 0)
        finally:
            runner.Remote.write_status = original

        self.assertGreater(len(seen), 2)
        # 处理过程中 request_id 保持旧值（空），main 侧 pending 才会一直是 true
        for snapshot in seen[:-1]:
            self.assertEqual(snapshot.get("request_id", ""), "", snapshot.get("message"))
        self.assertEqual(seen[-1].get("request_id"), request["id"])
        self.assertEqual(seen[-1].get("status"), "success")

    def test_check_error_is_mapped_to_error_status(self):
        fx = self.fixture()
        fx.prepare_script = fx._write_prepare_wrapper({})  # 所有 API 404
        self.assertEqual(fx.run(), 0)
        status = fx.status()
        self.assertStatusContract(status)
        self.assertEqual(status["status"], "error")
        self.assertTrue(status["last_error"])

    def test_broken_prepare_output_is_reported_not_crashing(self):
        fx = self.fixture()
        broken = fx.tmp / "broken_prepare.py"
        broken.write_text("#!/usr/bin/env python3\nprint('not json')\n", encoding="utf-8")
        os.chmod(broken, 0o755)
        args = fx.runner_args()
        args[args.index("--prepare-script") + 1] = str(broken)
        self.assertEqual(runner.main(args), 0)
        status = fx.status()
        self.assertEqual(status["status"], "error")
        self.assertIn("prepare_output", status["last_error"])

    def test_main_updater_reads_the_shared_queue(self):
        proxy = Path(os.environ.get("FNMEDIA_SOURCE_TREE", str(ROOT.parent / "main"))) / "proxy"
        if not (proxy / "updater.py").is_file():
            self.skipTest("main/proxy 不在当前工作区")
        fx = self.fixture()
        request = fx.request(action="update")
        self.assertEqual(fx.run(), 0)
        sys.path.insert(0, str(proxy))
        try:
            import updater as main_updater  # noqa: PLC0415

            os.environ["FNMEDIA_MAINTENANCE_DIR"] = str(fx.nas)
            try:
                view = main_updater.status()
            finally:
                os.environ.pop("FNMEDIA_MAINTENANCE_DIR", None)
        finally:
            sys.path.remove(str(proxy))
            sys.modules.pop("updater", None)
            sys.modules.pop("maintenance_io", None)
        self.assertEqual(view["status"], "success")
        self.assertTrue(view["maintenance_online"])
        self.assertFalse(view["pending"])
        self.assertEqual(view["latest_version"], "0.2.20")
        self.assertEqual(view["progress"], fx.status()["message"])


# --------------------------------------------------------------------------- #
# 配置 / 模板
# --------------------------------------------------------------------------- #
class ConfigTests(RunnerTestCase):
    def test_timeouts_are_capped(self):
        fx = self.fixture()
        args = fx.runner_args()
        args[args.index("--timeout-install") + 1] = "999999"
        args[args.index("--timeout-ssh") + 1] = "0.1"
        cfg = runner.build_config(args)
        self.assertEqual(cfg.timeouts["install"], runner.TIMEOUT_CAPS["install"])
        self.assertEqual(cfg.timeouts["ssh"], 5.0)

    def test_work_root_inside_trusted_tree_is_rejected(self):
        fx = self.fixture()
        args = fx.runner_args()
        args[args.index("--work-root") + 1] = str(fx.tree / "work")
        with self.assertRaises(runner.ConfigError):
            runner.build_config(args)

    def test_conflicting_force_flags_rejected(self):
        fx = self.fixture()
        with self.assertRaises(runner.ConfigError):
            runner.build_config(fx.runner_args() + ["--force-check", "--force-update"])

    def test_default_artifacts_cover_official_nginx(self):
        self.assertIn("/usr/trim/nginx/conf/conf.d/trim_media.conf", runner.DEFAULT_ARTIFACTS)

    def test_service_and_timer_templates(self):
        service = (ROOT / "fnmedia-ext-maintenance.service.in").read_text(encoding="utf-8")
        timer = (ROOT / "fnmedia-ext-maintenance.timer").read_text(encoding="utf-8")
        self.assertIn("Type=oneshot", service)
        self.assertIn("ExecStart=@PYTHON@ @RUNNER@", service)
        self.assertIn("--trusted-tree @TRUSTED_TREE@", service)
        self.assertIn("TimeoutStartSec=", service)
        self.assertNotIn("User=root", service)
        self.assertIn("NoNewPrivileges=true", service)
        self.assertIn("OnUnitInactiveSec=60s", timer)
        self.assertIn("Unit=fnmedia-ext-maintenance.service", timer)
        self.assertIn("WantedBy=timers.target", timer)

    def test_request_id_normalization(self):
        plain = uuid.uuid4().hex
        self.assertEqual(runner.normalize_request_id(plain), plain)
        dashed = str(uuid.UUID(plain))
        self.assertEqual(runner.normalize_request_id(dashed), plain)
        for bad in ("", None, "xyz", "../../x", plain + "0", "0" * 31, 12345):
            self.assertIsNone(runner.normalize_request_id(bad), repr(bad))


if __name__ == "__main__":
    unittest.main(verbosity=2)
