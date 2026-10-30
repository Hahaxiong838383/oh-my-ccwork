#!/usr/bin/env python3
"""fnmedia-ext 维护 runner —— 每分钟 oneshot（systemd timer），与 main/proxy 共享非敏感队列。

职责与边界（硬性）
------------------
* 只读写 NAS 固定目录 ``/var/lib/fnmedia-ext-maintenance`` 下的两个 JSON：
  ``update-status.json`` / ``update-request.json``；不读用户配置、播放记录或 state/。
* 队列只当作"动作请求"：``id`` 必须是通过白名单校验的 UUID，``action`` 只接受
  ``check`` / ``update``。其它字段（URL、命令、路径、版本号……）一律丢弃，
  绝不进入任何命令行或文件路径。
* 检查 / 准备复用同目录的 ``update_prepare.py``（子进程调用，只读、不执行上游代码）。
  只有"白名单文档变化"才可能产出候选；``needs_review`` 只上报，不覆盖任何候选。
* 升级路径固定：可信候选 + 本地 wheelhouse（不在 git 里）→ 可信
  ``packaging/fpk/build.sh --public --fnpack ... --out .../dist`` → 经 SSH 用
  ``trim-cli --profile fnos1 app install-fpk``（先 dry-run 再正式，走 appcenter）。
* 每步都有上限超时；工具失败只做"分类"上报，绝不把原始 stdout 回写状态。
* 可信源树（--trusted-tree）始终保持不变：候选树没有 .git，简单推进它会让下一次
  准备失败。是否"已经装过"用 NAS 上的 VERSION 判断，候选版本不大于已安装版本时
  跳过安装 —— 后续上游文档继续累积也安全。

队列状态字段与 main/proxy/updater.py 对齐：
    heartbeat, status, message, latest_version, last_check, next_check,
    last_error, request_id
``request_id`` 只在一次请求处理**结束**时推进；处理过程中保持旧值（main 侧仍显示
pending）。异常同样先写心跳 + 错误，再推进 request_id，避免每分钟重复安装。
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

SCHEMA = 1

#: 固定目标（不接受队列/环境变量覆盖）。
SSH_TARGET = "hahaxiong83@192.168.1.43"
REMOTE_DIR = "/var/lib/fnmedia-ext-maintenance"
STATUS_NAME = "update-status.json"
REQUEST_NAME = "update-request.json"

SERVICE_UNIT = "fnmedia-ext.service"
DEFAULT_APP_DIR = "/var/apps/fnmedia-ext/target/repo"
TARGET_SOCKET = "/var/run/trim_media.sock"
UPSTREAM_SOCKET = "/var/run/trim_media_upstream.sock"

#: 官方文件（升级前后 SHA 必须一致）。nginx 路径可用 --official-artifact 覆盖；
#: 任何条目不可读都中止升级，不把两个空值当作校验通过。
DEFAULT_ARTIFACTS = (
    "/usr/local/apps/@appcenter/trim.media/trim-media",
    "/var/apps/trim.media/manifest",
    "/usr/trim/nginx/conf/conf.d/trim_media.conf",
)

HARDENING_SUFFIX = "1"
#: 与 appcenter 向导收集到的参数完全一致（安装脚本检查 wizard_agree_terms）。
WIZARD_PARAMETERS = '[{"key":"wizard_agree_terms","value":["agree"]}]'

REQUEST_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$"
)
ACTIONS = frozenset({"check", "update"})

MAX_STATE_BYTES = 262144          # 与 maintenance_io.read 的上限一致
MAX_REMOTE_OUTPUT = 4 * 1024 * 1024
MAX_TOOL_OUTPUT = 4 * 1024 * 1024
MAX_FPK_BYTES = 512 * 1024 * 1024
MAX_MESSAGE = 200
MAX_DETAIL = 200

#: 每步超时上限（配置值会被夹到 (最小值, 上限]）。
TIMEOUT_CAPS = {
    "ssh": 120.0,
    "probe": 120.0,
    "prepare": 900.0,
    "build": 1800.0,
    "upload": 1200.0,
    "install": 3600.0,
    "verify": 300.0,
    "rollback": 3600.0,
}

LOG = logging.getLogger("fnmedia-maint")


# --------------------------------------------------------------------------- #
# 错误
# --------------------------------------------------------------------------- #
class ConfigError(Exception):
    """配置/参数错误：进程以非 0 退出，让 systemd 明确报错。"""


class RemoteError(Exception):
    """SSH / 远端脚本失败。"""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(code)


class StepError(Exception):
    """单个处理阶段的失败（已分类，可安全上报）。"""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(code)


# --------------------------------------------------------------------------- #
# 小工具：净化 / 版本比较（优先复用 update_prepare 的实现）
# --------------------------------------------------------------------------- #
_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s\"'<>()\[\]]+")
_SECRET_RE = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{10,}|Basic\s+[A-Za-z0-9+/=]{16,})\b",
    re.IGNORECASE,
)
_PARAM_SECRET_RE = re.compile(
    r"(?i)\b(access_token|token|api[_-]?key|password|passwd|secret|signature|sig)=[^&\s\"']+"
)


def _local_sanitize(value: Any, limit: int = 300) -> str:
    text = "" if value is None else str(value)
    text = _URL_RE.sub("<url>", text)
    text = _SECRET_RE.sub("<redacted>", text)
    text = _PARAM_SECRET_RE.sub(r"\1=<redacted>", text)
    text = "".join(ch for ch in text if ch in "\n\t" or ch >= " ")
    text = re.sub(r"[ \t]+", " ", text).strip()
    if limit and len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return text


def sanitize(value: Any, limit: int = MAX_DETAIL) -> str:
    if _PREPARE is not None:
        try:
            return _PREPARE.sanitize(value, limit)
        except Exception:  # pragma: no cover - 纯兜底
            pass
    return _local_sanitize(value, limit)


_VERSION_RE = re.compile(
    r"^[vV]?(\d+(?:\.\d+){0,3})(?:[-+~][0-9A-Za-z][0-9A-Za-z.+~\-]{0,31})?$"
)


def _local_parse_version(text: Any) -> tuple[int, ...]:
    if not isinstance(text, str):
        raise ValueError("version_not_text")
    match = _VERSION_RE.match(text.strip())
    if not match:
        raise ValueError("version_format")
    return tuple(int(part) for part in match.group(1).split("."))


def parse_version(text: Any) -> tuple[int, ...]:
    if _PREPARE is not None:
        return _PREPARE.parse_version(text)
    return _local_parse_version(text)


def compare_versions(left: str, right: str) -> int:
    """-1/0/1：数字序列比较（0.2.9 < 0.2.17），与 update_prepare 语义一致。"""
    if _PREPARE is not None:
        return _PREPARE.compare_versions(left, right)
    a, b = _local_parse_version(left), _local_parse_version(right)
    width = max(len(a), len(b))
    pa = a + (0,) * (width - len(a))
    pb = b + (0,) * (width - len(b))
    return (pa > pb) - (pa < pb)


_PREPARE: Any = None
try:  # 直接复用同目录的受审比较/净化实现；导入失败时退回本地实现。
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import update_prepare as _PREPARE  # type: ignore  # noqa: E402
except Exception:  # pragma: no cover
    _PREPARE = None


def normalize_request_id(value: Any) -> str | None:
    """严格 UUID 白名单：只接受 32 位十六进制（可带 4 个分隔符），其余返回 None。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not REQUEST_ID_RE.match(text):
        return None
    return text.replace("-", "").lower()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_ready(value: Any) -> Any:
    """把状态值压到可 JSON 序列化且不含不可控对象。"""
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        return sanitize(value, 80)


def version_from_fpk_name(name: str) -> str:
    match = re.search(r"fnmedia-ext-(\d+(?:\.\d+){1,3})(?:-|\.)", name)
    return match.group(1) if match else ""


# --------------------------------------------------------------------------- #
# 远端固定脚本
# --------------------------------------------------------------------------- #
# 通过 ``ssh <target> python3 -c '<本脚本>'`` 执行，数据只经 stdin 的 JSON 传，
# 不插值任何队列内容；写入固定目录、临时文件 + fsync + chmod 0660 + os.replace。
REMOTE_SCRIPT = r'''
import hashlib, json, os, re, stat, subprocess, sys, tempfile

ROOT = os.path.abspath(os.environ.get("FNMEDIA_MAINT_TEST_ROOT") or "/var/lib/fnmedia-ext-maintenance")
STATE_FILES = ("update-status.json", "update-request.json", "compatibility-status.json")
MAX_STATE = 262144
MAX_HEADER = 8192
MAX_PUT = 536870912
UNIT = "fnmedia-ext.service"
HTTP_PATH = "/v/api/ext/status"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.fpk$")
SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9@._+/-]{1,300}$")

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    return 0

def fail(code, detail=""):
    return out({"ok": False, "error": str(code)[:60], "detail": str(detail)[:200]})

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path, mode=0o2770, exist_ok=True)
        try:
            os.chmod(path, 0o2770)
        except OSError:
            pass

def state_path(name):
    if name not in STATE_FILES:
        raise ValueError("name_not_allowed")
    return os.path.join(ROOT, name)

def read_state(name):
    path = state_path(name)
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None, None
    except OSError:
        return None, "stat_failed"
    if not stat.S_ISREG(info.st_mode):
        return None, "not_regular"
    if info.st_size > MAX_STATE:
        return None, "too_large"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None, "invalid_json"
    if not isinstance(value, dict):
        return None, "not_object"
    return value, None

def write_state(name, value):
    if not isinstance(value, dict):
        raise ValueError("state_not_object")
    data = json.dumps(value, ensure_ascii=False)
    if len(data.encode("utf-8")) > MAX_STATE:
        raise ValueError("state_too_large")
    ensure_dir(ROOT)
    fd, tmp = tempfile.mkstemp(prefix=".fnmedia-", dir=ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o660)
        os.replace(tmp, state_path(name))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def sha256_file(path):
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return None
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None

def safe_path(value):
    if isinstance(value, str) and SAFE_PATH_RE.match(value):
        return value
    return None

def http_probe(path):
    import http.client, socket
    result = {"status": None, "code": None, "ok": False}
    if not path:
        result["error"] = "socket_path"
        return result
    class _Conn(http.client.HTTPConnection):
        def connect(self):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(4.0)
            sock.connect(path)
            self.sock = sock
    try:
        conn = _Conn("localhost", timeout=4.0)
        conn.request("GET", HTTP_PATH, headers={"Host": "fnos.local"})
        response = conn.getresponse()
        body = response.read(4096)
        result["status"] = response.status
        conn.close()
        try:
            payload = json.loads(body)
            if isinstance(payload, dict):
                result["code"] = payload.get("code")
        except (ValueError, UnicodeDecodeError):
            pass
        result["ok"] = response.status == 401
    except Exception as exc:
        result["error"] = type(exc).__name__
    return result

def probe(request):
    result = {"version": None, "unit": None, "artifacts": {}, "sockets": {}, "http": None, "errors": []}
    app = safe_path(request.get("app_dir"))
    if app:
        try:
            with open(os.path.join(app, "VERSION"), "r", encoding="utf-8") as handle:
                raw = handle.read(64)
            result["version"] = raw.strip()[:32] or None
        except (OSError, UnicodeDecodeError):
            result["errors"].append("version_unreadable")
    try:
        proc = subprocess.run(["systemctl", "is-active", UNIT, "--no-pager"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=10)
        result["unit"] = proc.stdout.decode("utf-8", "replace").strip()[:32]
    except (OSError, subprocess.SubprocessError):
        result["errors"].append("systemctl_unavailable")
    artifacts = request.get("artifacts")
    if isinstance(artifacts, list):
        for item in artifacts[:16]:
            path = safe_path(item)
            if path:
                result["artifacts"][path] = sha256_file(path)
    if request.get("sockets"):
        for key in ("target_socket", "upstream_socket"):
            path = safe_path(request.get(key))
            info = {"exists": False, "is_socket": False, "mode": None}
            if path:
                try:
                    info_stat = os.stat(path)
                    info = {"exists": True,
                            "is_socket": stat.S_ISSOCK(info_stat.st_mode),
                            "mode": format(stat.S_IMODE(info_stat.st_mode), "03o")}
                except OSError:
                    pass
            result["sockets"][key] = info
    if request.get("http"):
        result["http"] = http_probe(safe_path(request.get("target_socket")))
    return result

def put(name, stream):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError("name_invalid")
    packages = (os.path.join(ROOT, "packages") if os.environ.get("FNMEDIA_MAINT_TEST_ROOT")
                else "/vol3/1000/软件安装/fnmedia-ext-managed-packages")
    ensure_dir(ROOT)
    ensure_dir(packages)
    fd, tmp = tempfile.mkstemp(prefix=".put-", dir=packages)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, "wb") as handle:
            while True:
                chunk = stream.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_PUT:
                    raise ValueError("too_large")
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o660)
        os.replace(tmp, os.path.join(packages, name))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"ok": True, "name": name, "size": size,
            "sha256": digest.hexdigest(), "path": os.path.join(packages, name)}

def main():
    stream = sys.stdin.buffer
    header = stream.readline(MAX_HEADER)
    if not header:
        return fail("no_input")
    try:
        request = json.loads(header.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return fail("bad_json")
    if not isinstance(request, dict):
        return fail("bad_request")
    op = request.get("op")
    try:
        if op == "read":
            status, status_error = read_state("update-status.json")
            req, request_error = read_state("update-request.json")
            return out({"ok": True, "dir": ROOT, "status": status, "request": req,
                        "errors": [e for e in (status_error, request_error) if e]})
        if op == "write":
            write_state(request.get("name"), request.get("value"))
            return out({"ok": True, "name": request.get("name")})
        if op == "probe":
            return out({"ok": True, "probe": probe(request)})
        if op == "put":
            return out(put(request.get("name"), stream))
        return fail("unknown_op")
    except ValueError as exc:
        return fail(str(exc)[:40] or "invalid")
    except Exception as exc:
        return fail("remote_error", type(exc).__name__)

sys.exit(main())
'''

#: 安装失败分类（只看关键词/短 JSON 字段，不保留原始输出）。
FAILURE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("disk_space", ("no space", "enospc", "空间不足", "磁盘空间", "disk full")),
    ("dependency", ("dependency", "依赖", "依赖应用", "trim.media")),
    ("license", ("accept-license", "license", "协议", "条款")),
    ("wizard", ("custom-parameters", "wizard", "向导参数")),
    ("busy", ("busy", "conflict", "任务冲突", "another task", "queue full")),
    ("download", ("download", "下载", "upload failed", "上传失败")),
    ("timeout", ("timeout", "timed out", "超时", "deadline")),
    ("permission", ("permission denied", "unauthorized", "权限", "403")),
    ("install_failed", ("install failed", "安装失败", "failed to install", "status: failed")),
)


def classify_failure(rc: int, stdout: bytes, stderr: bytes) -> tuple[str, str]:
    """把工具失败压成一个分类 + 极短摘要；绝不返回完整 stdout。"""
    text = (stdout or b"")[:65536].decode("utf-8", "replace")
    err = (stderr or b"")[:8192].decode("utf-8", "replace")
    haystack = (text + "\n" + err).lower()
    code = ""
    match = re.search(r'"code"\s*:\s*(-?\d+)', text)
    if match:
        code = match.group(1)
    message = ""
    match = re.search(r'"(?:msg|message|error)"\s*:\s*"([^"\\]{1,160})"', text)
    if match:
        message = match.group(1)
    category = "unknown"
    for name, needles in FAILURE_PATTERNS:
        if any(needle in haystack for needle in needles):
            category = name
            break
    parts = [f"rc={rc}"]
    if code:
        parts.append(f"code={code}")
    detail = sanitize(message, 120)
    if detail:
        parts.append(detail)
    return category, " ".join(parts)


# --------------------------------------------------------------------------- #
# 工具进程
# --------------------------------------------------------------------------- #
def run_tool(
    argv: Sequence[str],
    *,
    timeout: float,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
    stdin_bytes: bytes | None = None,
) -> tuple[int, bytes, bytes]:
    try:
        proc = subprocess.run(
            list(argv),
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            check=False,
        )
    except FileNotFoundError:
        raise StepError("tool_missing", sanitize(argv[0], 80)) from None
    except subprocess.TimeoutExpired:
        raise StepError("timeout", f"{sanitize(argv[0], 60)} 超过 {timeout:g}s") from None
    except OSError as exc:
        raise StepError("tool_failed", sanitize(exc.strerror or exc, 100)) from None
    if len(proc.stdout) > MAX_TOOL_OUTPUT or len(proc.stderr) > MAX_TOOL_OUTPUT:
        raise StepError("output_too_large", sanitize(argv[0], 60))
    return proc.returncode, proc.stdout, proc.stderr


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
_KEEP = object()


@dataclass(frozen=True)
class Config:
    ssh_bin: str
    remote_python: str
    python: str
    prepare_script: Path
    trusted_tree: Path
    work_root: Path
    state_dir: Path
    runner_state: Path
    prepare_state: Path
    lock_path: Path
    baseline: str
    fnpack: Path
    wheelhouse: Path
    wheel_rel: str
    trim_cli: str
    upgrade_helper: Path
    build_script: str
    app_dir: str
    remote_dir: str
    target_socket: str
    upstream_socket: str
    last_good_fpk: Path | None
    official_artifacts: tuple[str, ...]
    check_interval: int
    heartbeat_interval: int
    version_suffix: str
    volume_id: int
    dry_run_flag: str
    verify_poll: float
    force_check: bool
    force_update: bool
    log_level: int
    timeouts: dict[str, float]


def _clamp(value: float, low: float, high: float, name: str) -> float:
    if value < low:
        LOG.warning("%s=%s 太小，按 %s 处理", name, value, low)
        return low
    if value > high:
        LOG.warning("%s=%s 超过上限，按 %s 处理", name, value, high)
        return high
    return value


def build_config(argv: Sequence[str] | None = None) -> Config:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="fnmedia-ext 维护 runner（每分钟 oneshot；检查/升级经 NAS 固定队列）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--trusted-tree", required=True,
                        help="可信构建树（git 工作区，只读；不会被推进到候选树）")
    parser.add_argument("--work-root", required=True, help="runner 工作目录（候选/构建/发布物）")
    parser.add_argument("--state-dir", default="/var/lib/fnmedia-ext-maintenance-runner",
                        help="本地私有状态目录（flock、状态文件、update_prepare 状态）")
    parser.add_argument("--baseline", required=True,
                        help="受审基线 commit/tag（保持原受审代码值，不随候选推进）")
    parser.add_argument("--prepare-script", default=str(here / "update_prepare.py"),
                        help="update_prepare.py 路径")
    parser.add_argument("--python", default=sys.executable, help="本地 python 解释器")
    parser.add_argument("--fnpack", required=True, help="受信 fnpack 可执行文件路径")
    parser.add_argument("--wheelhouse", required=True, help="本地 wheelhouse 目录（不在 git 内）")
    parser.add_argument("--wheel-rel", default="wheelhouse",
                        help="wheelhouse 在构建树里的相对目录")
    parser.add_argument("--trim-cli", default="trim-cli",
                        help="本机 trim-cli 路径（复用本机 fnos1 OAuth profile）")
    parser.add_argument("--upgrade-helper", default=str(here / "local_upgrade.py"))
    parser.add_argument("--build-script", default="packaging/fpk/build.sh",
                        help="构建树内的 build.sh 相对路径")
    parser.add_argument("--app-dir", default=DEFAULT_APP_DIR,
                        help="NAS 上已安装应用的 repo 目录（只读 VERSION）")
    parser.add_argument("--remote-dir", default=REMOTE_DIR,
                        help="NAS 固定状态目录（本地配置，绝不采用队列/远端返回值）")
    parser.add_argument("--target-socket", default=TARGET_SOCKET,
                        help="对外 socket（匿名 401 探测 + 0666 校验）")
    parser.add_argument("--upstream-socket", default=UPSTREAM_SOCKET,
                        help="官方 socket（0666 可访问性校验）")
    parser.add_argument("--official-artifact", action="append", default=None, metavar="PATH",
                        help="官方文件路径（升级前后 SHA 必须一致，可重复；缺省用内置 3 项）")
    parser.add_argument("--last-good-fpk", default=None,
                        help="previous good FPK（初始旧包；外部父级部署新版后会更新）")
    parser.add_argument("--check-interval", type=int, default=3600,
                        help="定时检查间隔秒")
    parser.add_argument("--heartbeat-interval", type=float, default=60.0,
                        help="长任务期间心跳写入间隔秒（<=0 关闭后台心跳）")
    parser.add_argument("--version-suffix", default=HARDENING_SUFFIX,
                        help="候选版本后缀（1 → 0.2.20.1，保留加固标记）")
    parser.add_argument("--volume-id", type=int, default=3, help="appcenter 安装卷 ID")
    parser.add_argument("--dry-run-flag", default="--dry-run",
                        help="trim-cli 预检开关（按部署的 trim-cli 版本调整）")
    parser.add_argument("--verify-poll", type=float, default=5.0, help="验证轮询间隔秒")
    parser.add_argument("--ssh-bin", default="ssh", help="ssh 可执行文件")
    parser.add_argument("--remote-python", default="/usr/bin/python3",
                        help="NAS 侧 python3 路径（固定脚本经 -c 执行）")
    parser.add_argument("--timeout-ssh", type=float, default=30.0, help="单次 SSH 状态操作超时")
    parser.add_argument("--timeout-probe", type=float, default=45.0, help="验证探测超时")
    parser.add_argument("--timeout-prepare", type=float, default=300.0, help="准备阶段超时")
    parser.add_argument("--timeout-build", type=float, default=900.0, help="构建阶段超时")
    parser.add_argument("--timeout-upload", type=float, default=600.0, help="上传阶段超时")
    parser.add_argument("--timeout-install", type=float, default=1800.0,
                        help="单次 appcenter 安装超时（API 自己等待）")
    parser.add_argument("--timeout-verify", type=float, default=120.0, help="验证阶段总超时")
    parser.add_argument("--timeout-rollback", type=float, default=1800.0, help="回退安装超时")
    parser.add_argument("--force-check", action="store_true", help="本次立即检查（运维手动）")
    parser.add_argument("--force-update", action="store_true", help="本次立即尝试升级（运维手动）")
    parser.add_argument("--log-level", default="INFO",
                        choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    args = parser.parse_args(list(argv) if argv is not None else None)

    trusted_tree = Path(args.trusted_tree).expanduser().resolve()
    work_root = Path(args.work_root).expanduser().resolve()
    state_dir = Path(args.state_dir).expanduser().resolve()
    prepare_script = Path(args.prepare_script).expanduser().resolve()
    fnpack = Path(args.fnpack).expanduser().resolve()
    wheelhouse = Path(args.wheelhouse).expanduser().resolve()

    if not trusted_tree.is_dir():
        raise ConfigError(f"--trusted-tree 不存在: {trusted_tree}")
    if not (trusted_tree / "VERSION").is_file():
        raise ConfigError(f"--trusted-tree 缺少 VERSION: {trusted_tree}")
    if not prepare_script.is_file():
        raise ConfigError(f"--prepare-script 不存在: {prepare_script}")
    if not args.baseline.strip():
        raise ConfigError("--baseline 不能为空")
    if work_root == trusted_tree or _is_within(work_root, trusted_tree):
        raise ConfigError("--work-root 不能位于可信源树内")
    if not args.app_dir.startswith("/"):
        raise ConfigError("--app-dir 必须是绝对路径")
    artifacts = tuple(args.official_artifact) if args.official_artifact else DEFAULT_ARTIFACTS
    for item in artifacts:
        if not item.startswith("/"):
            raise ConfigError(f"--official-artifact 必须是绝对路径: {item}")
    if args.heartbeat_interval < 0:
        raise ConfigError("--heartbeat-interval 不能为负")

    work_root.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with _suppress_oserror():
        os.chmod(state_dir, 0o700)

    timeouts = {
        "ssh": _clamp(args.timeout_ssh, 5.0, TIMEOUT_CAPS["ssh"], "--timeout-ssh"),
        "probe": _clamp(args.timeout_probe, 5.0, TIMEOUT_CAPS["probe"], "--timeout-probe"),
        "prepare": _clamp(args.timeout_prepare, 10.0, TIMEOUT_CAPS["prepare"], "--timeout-prepare"),
        "build": _clamp(args.timeout_build, 30.0, TIMEOUT_CAPS["build"], "--timeout-build"),
        "upload": _clamp(args.timeout_upload, 30.0, TIMEOUT_CAPS["upload"], "--timeout-upload"),
        "install": _clamp(args.timeout_install, 60.0, TIMEOUT_CAPS["install"], "--timeout-install"),
        "verify": _clamp(args.timeout_verify, 5.0, TIMEOUT_CAPS["verify"], "--timeout-verify"),
        "rollback": _clamp(args.timeout_rollback, 60.0, TIMEOUT_CAPS["rollback"], "--timeout-rollback"),
    }

    if args.force_check and args.force_update:
        raise ConfigError("--force-check 与 --force-update 不能同时使用")

    return Config(
        ssh_bin=args.ssh_bin,
        remote_python=args.remote_python,
        python=args.python,
        prepare_script=prepare_script,
        trusted_tree=trusted_tree,
        work_root=work_root,
        state_dir=state_dir,
        runner_state=state_dir / "runner-state.json",
        prepare_state=state_dir / "update-prepare-state.json",
        lock_path=state_dir / "runner.lock",
        baseline=args.baseline.strip(),
        fnpack=fnpack,
        wheelhouse=wheelhouse,
        wheel_rel=args.wheel_rel.strip("/") or "wheelhouse",
        trim_cli=args.trim_cli.strip(),
        upgrade_helper=Path(args.upgrade_helper).resolve(),
        build_script=args.build_script.strip("/"),
        app_dir=args.app_dir.rstrip("/"),
        remote_dir=(args.remote_dir.rstrip("/") or REMOTE_DIR),
        target_socket=args.target_socket,
        upstream_socket=args.upstream_socket,
        last_good_fpk=Path(args.last_good_fpk).expanduser().resolve() if args.last_good_fpk else None,
        official_artifacts=artifacts,
        check_interval=max(60, int(args.check_interval)),
        heartbeat_interval=float(args.heartbeat_interval),
        version_suffix=str(args.version_suffix).strip(),
        volume_id=int(args.volume_id),
        dry_run_flag=args.dry_run_flag,
        verify_poll=max(1.0, float(args.verify_poll)),
        force_check=bool(args.force_check),
        force_update=bool(args.force_update),
        log_level=getattr(logging, args.log_level),
        timeouts=timeouts,
    )


class _suppress_oserror:
    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        return exc_type is not None and issubclass(exc_type, OSError)


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


# --------------------------------------------------------------------------- #
# 远端队列：固定 ssh 参数 + 固定 python 脚本 + stdin JSON
# --------------------------------------------------------------------------- #
class Remote:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        # 固定目录来自本地配置；远端返回值只用来核对，绝不参与路径拼接。
        self._dir = cfg.remote_dir

    # -- 传输 ------------------------------------------------------------- #
    def _ssh_argv(self, command: str) -> list[str]:
        return [
            self.cfg.ssh_bin,
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=8",
            "-o", "LogLevel=ERROR",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4",
            SSH_TARGET,
            command,
        ]

    def _state_command(self) -> str:
        return f"{shlex.quote(self.cfg.remote_python)} -c {shlex.quote(REMOTE_SCRIPT)}"

    def _run(self, argv: list[str], data: bytes, timeout: float) -> tuple[int, bytes, bytes]:
        try:
            proc = subprocess.run(
                argv,
                input=data,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError:
            raise RemoteError("ssh_missing", sanitize(self.cfg.ssh_bin, 80)) from None
        except subprocess.TimeoutExpired:
            raise RemoteError("ssh_timeout", f"{timeout:g}s") from None
        except OSError as exc:
            raise RemoteError("ssh_failed", sanitize(exc.strerror or exc, 100)) from None
        return proc.returncode, proc.stdout, proc.stderr

    def _call(self, payload: Mapping[str, Any], timeout: float,
              body: bytes | None = None) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
        if body:
            data += body
        rc, out, err = self._run(self._ssh_argv(self._state_command()), data, timeout)
        if len(out) > MAX_REMOTE_OUTPUT:
            raise RemoteError("remote_output_too_large")
        if rc != 0:
            raise RemoteError("ssh_failed", f"rc={rc} " + sanitize(err.decode("utf-8", "replace")[-160:], 120))
        try:
            reply = json.loads(out.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise RemoteError("remote_protocol", sanitize(err.decode("utf-8", "replace"), 120)) from None
        if not isinstance(reply, dict):
            raise RemoteError("remote_protocol")
        if reply.get("ok") is not True:
            raise RemoteError(str(reply.get("error") or "remote_error"),
                              sanitize(reply.get("detail"), 120))
        return reply

    # -- 队列操作 --------------------------------------------------------- #
    def read(self, timeout: float) -> dict[str, Any]:
        reply = self._call({"op": "read"}, timeout)
        status = reply.get("status")
        request = reply.get("request")
        # 远端必须承认同一个固定目录，否则拒绝使用（防止被改过的远端脚本带偏路径）。
        raw_dir = reply.get("dir")
        if isinstance(raw_dir, str) and raw_dir.rstrip("/") != self._dir:
            raise RemoteError("remote_dir", "远端状态目录与本地配置不一致")
        return {
            "status": status if isinstance(status, dict) else {},
            "request": request if isinstance(request, dict) else {},
            "errors": [str(e) for e in (reply.get("errors") or [])][:4],
        }

    def package_path(self, name: str = "") -> str:
        base = (f"{self._dir}/packages" if self._dir != REMOTE_DIR
                else "/vol3/1000/软件安装/fnmedia-ext-managed-packages")
        return f"{base}/{name}" if name else base

    def write_status(self, value: Mapping[str, Any], timeout: float) -> None:
        self._call({"op": "write", "name": STATUS_NAME, "value": dict(value)}, timeout)

    def probe(self, cfg: Config, timeout: float, *, artifacts: Iterable[str] = (),
              sockets: bool = False, http: bool = False) -> dict[str, Any]:
        payload = {
            "op": "probe",
            "app_dir": cfg.app_dir,
            "artifacts": list(artifacts),
            "sockets": bool(sockets),
            "http": bool(http),
            "target_socket": cfg.target_socket,
            "upstream_socket": cfg.upstream_socket,
        }
        reply = self._call(payload, timeout)
        probe = reply.get("probe")
        if not isinstance(probe, dict):
            raise RemoteError("probe_invalid")
        return probe

    def put(self, name: str, path: Path, timeout: float) -> dict[str, Any]:
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise RemoteError("fpk_unreadable", sanitize(exc.strerror or exc, 80)) from None
        if size <= 0 or size > MAX_FPK_BYTES:
            raise RemoteError("fpk_size", str(size))
        try:
            body = path.read_bytes()
        except OSError as exc:
            raise RemoteError("fpk_unreadable", sanitize(exc.strerror or exc, 80)) from None
        reply = self._call({"op": "put", "name": name}, timeout, body=body)
        return {
            "name": reply.get("name"),
            "size": reply.get("size"),
            "sha256": reply.get("sha256"),
            "path": reply.get("path"),
        }

    # -- 业务命令 --------------------------------------------------------- #
    def run_command(self, command: str, timeout: float) -> tuple[int, bytes, bytes]:
        """执行一条本地构造的远端命令（argv 全部来自配置 + 常量，绝不含队列内容）。

        ssh 自己用 255 报告连接/认证失败；那说明远端命令的结果未知，
        必须按 RemoteError 处理，交给验证阶段判定，而不是当作安装失败。
        """
        rc, out, err = self._run(self._ssh_argv(command), b"", timeout)
        if rc == 255:
            raise RemoteError("ssh_failed", sanitize(err.decode("utf-8", "replace")[-160:], 120))
        return rc, out, err


# --------------------------------------------------------------------------- #
# 本地私有状态（flock 串行、原子写）
# --------------------------------------------------------------------------- #
class RunnerState:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.data: dict[str, Any] = {}

    def load(self) -> None:
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            self.data = {}
            return
        except OSError:
            self.data = {}
            return
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            LOG.warning("本地状态损坏，已另存为 .corrupt 并重置")
            with _suppress_oserror():
                os.replace(self.path, self.path.with_suffix(".corrupt"))
            self.data = {}
            return
        self.data = value if isinstance(value, dict) else {}

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def put(self, key: str, value: Any) -> None:
        self.data[key] = _json_ready(value)

    def clear(self, key: str) -> None:
        self.data.pop(key, None)

    def save(self) -> None:
        payload = json.dumps(self.data, ensure_ascii=False, sort_keys=True) + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(prefix=".state-", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            with _suppress_oserror():
                os.unlink(tmp)
            raise

    # -- 语义便利 --------------------------------------------------------- #
    @property
    def attempt_id(self) -> str:
        attempt = self.data.get("attempt")
        return str(attempt.get("id") or "") if isinstance(attempt, dict) else ""

    def begin_attempt(self, request_id: str, action: str) -> None:
        self.data["attempt"] = {"id": request_id, "action": action,
                                "started_at": int(time.time())}

    def end_attempt(self) -> None:
        self.data.pop("attempt", None)


def acquire_lock(path: Path) -> int | None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def release_lock(fd: int) -> None:
    with _suppress_oserror():
        fcntl.flock(fd, fcntl.LOCK_UN)
    with _suppress_oserror():
        os.close(fd)


# --------------------------------------------------------------------------- #
# 状态写入（心跳）
# --------------------------------------------------------------------------- #
STATUS_DEFAULTS: dict[str, Any] = {
    "schema": SCHEMA,
    "status": "waiting",
    "message": "维护服务在线",
    "latest_version": "",
    "last_check": 0,
    "next_check": 0,
    "last_error": "",
    "request_id": "",
}


class StatusWriter:
    """合并式状态写入器：保留 main 侧未知字段，长任务期间后台心跳。"""

    def __init__(self, cfg: Config, remote: Remote, initial: Mapping[str, Any]) -> None:
        self.cfg = cfg
        self.remote = remote
        self._lock = threading.RLock()
        data = dict(initial) if isinstance(initial, Mapping) else {}
        for key, value in STATUS_DEFAULTS.items():
            data.setdefault(key, value)
        self.data: dict[str, Any] = data
        self.write_errors = 0
        self.last_write_error = ""
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self.data)

    def set(
        self,
        *,
        status: str | None = None,
        message: str | None = None,
        phase: str | None = None,
        request_id: Any = _KEEP,
        last_error: str | None = None,
        **extra: Any,
    ) -> None:
        with self._lock:
            if status is not None:
                self.data["status"] = status
            if message is not None:
                self.data["message"] = sanitize(message, MAX_MESSAGE)
            if phase is not None:
                self.data["phase"] = phase
            if request_id is not _KEEP:
                self.data["request_id"] = request_id
            if last_error is not None:
                self.data["last_error"] = sanitize(last_error, MAX_DETAIL)
            for key, value in extra.items():
                self.data[key] = _json_ready(value)
            self._write_locked()

    def _write_locked(self) -> None:
        payload = dict(self.data)
        payload["schema"] = SCHEMA
        payload["heartbeat"] = int(time.time())
        try:
            self.remote.write_status(payload, self.cfg.timeouts["ssh"])
            self.last_write_error = ""
        except RemoteError as exc:
            self.write_errors += 1
            self.last_write_error = exc.code
            LOG.warning("状态写入失败: %s", exc.code)

    def start(self) -> None:
        if self.cfg.heartbeat_interval <= 0:
            return

        def loop() -> None:
            while not self._stop.wait(self.cfg.heartbeat_interval):
                with self._lock:
                    self._write_locked()

        self._thread = threading.Thread(target=loop, name="heartbeat", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


# --------------------------------------------------------------------------- #
# 探测结果比较
# --------------------------------------------------------------------------- #
def compare_probe(version: str, before: Mapping[str, Any],
                  after: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []

    actual_version = str(after.get("version") or "")
    if actual_version != version:
        failures.append(f"VERSION={actual_version or '未知'}，期望 {version}")

    unit = str(after.get("unit") or "")
    if unit != "active":
        failures.append(f"service={unit or '未知'}")

    before_art = before.get("artifacts") if isinstance(before.get("artifacts"), dict) else {}
    after_art = after.get("artifacts") if isinstance(after.get("artifacts"), dict) else {}
    for path, old in before_art.items():
        new = after_art.get(path)
        name = os.path.basename(path)
        if old != new:
            failures.append(f"官方文件变化:{name}")
        elif old is None:
            failures.append(f"官方文件不可读:{name}")

    after_sock = after.get("sockets") if isinstance(after.get("sockets"), dict) else {}
    for key, label in (("target_socket", "接管socket"), ("upstream_socket", "官方socket")):
        info = after_sock.get(key) if isinstance(after_sock.get(key), dict) else {}
        if not info.get("exists") or not info.get("is_socket"):
            failures.append(f"{label}不存在")
            continue
        mode = str(info.get("mode") or "")
        try:
            allowed = int(mode or "0", 8)
        except ValueError:
            allowed = 0
        if (allowed & 0o666) != 0o666:
            failures.append(f"{label}权限{mode}")

    http = after.get("http") if isinstance(after.get("http"), dict) else {}
    if http.get("status") != 401:
        failures.append(f"匿名访问返回 {http.get('status')}")

    return failures, warnings


# --------------------------------------------------------------------------- #
# Runner 主体
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Job:
    kind: str                      # request / scheduled / forced / recover / expired
    request_id: str = ""
    action: str = ""               # check / update


class Runner:
    def __init__(self, cfg: Config, remote: Remote | None = None) -> None:
        self.cfg = cfg
        self.remote = remote or Remote(cfg)
        self.state = RunnerState(cfg.runner_state)

    # -- 入口 ------------------------------------------------------------- #
    def execute(self) -> int:
        fd = acquire_lock(self.cfg.lock_path)
        if fd is None:
            LOG.info("已有 runner 实例在运行，本轮跳过")
            return 0
        try:
            return self._execute_locked()
        finally:
            release_lock(fd)

    def _execute_locked(self) -> int:
        self.state.load()
        if self.cfg.last_good_fpk is not None and self.cfg.last_good_fpk.is_file():
            if str(self.cfg.last_good_fpk) != self.state.get("last_good_fpk"):
                self.state.put("last_good_fpk", str(self.cfg.last_good_fpk))
                self.state.save()
        elif self.cfg.last_good_fpk is not None:
            LOG.warning("--last-good-fpk 不存在: %s", self.cfg.last_good_fpk)

        try:
            snapshot = self.remote.read(self.cfg.timeouts["ssh"])
        except RemoteError as exc:
            LOG.error("无法读取 NAS 队列: %s %s", exc.code, exc.detail)
            return 2

        writer = StatusWriter(self.cfg, self.remote, snapshot["status"])
        writer.set()  # 心跳（保留上一次的 status/message/request_id）

        job = self._plan(snapshot, writer.snapshot())
        if job is None:
            LOG.info("心跳已写入，本轮无任务")
            return 0

        LOG.info("开始任务: %s%s", job.kind, f"/{job.action}" if job.action else "")
        writer.start()
        try:
            self._handle(job, writer)
        finally:
            writer.stop()
        return 0

    # -- 任务派发 --------------------------------------------------------- #
    def _plan(self, snapshot: Mapping[str, Any], status: Mapping[str, Any]) -> Job | None:
        request = snapshot.get("request") if isinstance(snapshot.get("request"), dict) else {}
        request_id = normalize_request_id(request.get("id"))
        action = request.get("action")
        acked = str(status.get("request_id") or "")

        if request_id is not None and action in ACTIONS:
            if self.state.attempt_id == request_id:
                return Job("recover", request_id, str(action))
            if request_id != acked:
                requested_at = request.get("requested_at")
                if isinstance(requested_at, (int, float)) and time.time() - float(requested_at) > 86400:
                    return Job("expired", request_id, str(action))
                return Job("request", request_id, str(action))

        if self.cfg.force_check:
            return Job("forced", "", "check")
        if self.cfg.force_update:
            return Job("forced", "", "update")
        last_check = self.state.get("last_check_at") or 0
        try:
            due = time.time() - float(last_check) >= self.cfg.check_interval
        except (TypeError, ValueError):
            due = True
        return Job("scheduled", "", "check") if due else None

    def _handle(self, job: Job, writer: StatusWriter) -> None:
        is_request = bool(job.request_id)
        if job.kind == "recover":
            self.state.end_attempt()
            self.state.save()
            writer.set(status="failed",
                       message="上次升级处理异常中断，已停止自动重试，请人工检查 NAS",
                       phase="recover", request_id=job.request_id,
                       last_error="attempt_interrupted")
            return
        if job.kind == "expired":
            writer.set(status=writer.snapshot().get("status") or "waiting",
                       message="收到过期请求，已忽略", phase="idle",
                       request_id=job.request_id)
            return

        target = "update" if job.action == "update" else "check"
        self.state.begin_attempt(job.request_id, target)
        self.state.save()
        try:
            if target == "check":
                self._do_check(job, writer)
            else:
                self._do_update(job, writer)
        except StepError as exc:
            LOG.error("任务失败: %s %s", exc.code, exc.detail)
            status = "error" if target == "check" else "failed"
            label = "检查" if target == "check" else "升级"
            writer.set(
                status=status,
                message=f"{label}失败：{exc.code}，详见 last_error",
                phase="failed",
                last_error=f"{exc.code}: {exc.detail}" if exc.detail else exc.code,
                request_id=job.request_id if is_request else _KEEP,
            )
        except RemoteError as exc:
            LOG.error("NAS 通信失败: %s %s", exc.code, exc.detail)
            writer.set(
                status="failed" if target == "update" else "error",
                message=f"NAS 通信失败（{exc.code}），本轮未完成",
                phase="failed",
                last_error=f"{exc.code}: {exc.detail}" if exc.detail else exc.code,
                request_id=job.request_id if is_request else _KEEP,
            )
        except Exception as exc:  # noqa: BLE001 - 任何异常都不能让 timer 每轮重试
            LOG.exception("runner 内部错误")
            writer.set(
                status="failed" if target == "update" else "error",
                message="维护 runner 内部错误，本轮已停止处理",
                phase="failed",
                last_error=sanitize(f"{type(exc).__name__}: {exc}", MAX_DETAIL),
                request_id=job.request_id if is_request else _KEEP,
            )
        finally:
            self.state.end_attempt()
            if target == "check":
                stamp = int(time.time())
                self.state.put("last_check_at", stamp)
                self.state.put("next_check_at", stamp + self.cfg.check_interval)
                writer.set(last_check=stamp, next_check=stamp + self.cfg.check_interval)
            self.state.save()

        if is_request:
            # 请求处理结束（无论成败）才推进 request_id，避免每分钟重复安装。
            snap = writer.snapshot()
            writer.set(status=snap.get("status"), message=snap.get("message"),
                       request_id=job.request_id)

    # -- 检查 ------------------------------------------------------------- #
    def _do_check(self, job: Job, writer: StatusWriter) -> None:
        writer.set(status="checking", message="正在检查上游发布", phase="check")
        result = self._run_prepare("check")
        installed = self._installed_version()
        if installed:
            self.state.put("installed_version", installed)
        self._publish_check(result, installed, writer)

    def _publish_check(self, result: Mapping[str, Any], installed: str,
                       writer: StatusWriter) -> None:
        if installed:
            writer.set(installed_version=installed)
        latest = str(result.get("latest") or "")
        suffix = self.cfg.version_suffix
        candidate = f"{latest}.{suffix}" if latest and suffix else latest
        code, detail = first_error(result.get("errors"))
        status = result.get("status")

        if status in (None, "error"):
            writer.set(status="error",
                       message=f"检查失败：{code or 'prepare_error'}",
                       last_error=detail or code or "prepare_error",
                       latest_version=latest)
            return

        if status == "needs_review" or result.get("needs_review"):
            blocked = result.get("changed_paths")
            blocked = blocked.get("blocked") if isinstance(blocked, dict) else None
            brief = "、".join(str(item) for item in (blocked or [])[:3])
            message = f"上游 {latest or '?'} 含需人工适配的变更"
            if brief:
                message += f"（{brief}）"
            message += "，未自动升级"
            writer.set(status="needs_review", message=message,
                       last_error=detail or code or "code_change",
                       latest_version=latest)
            return

        if status == "update_available":
            if installed and candidate and compare_versions(installed, candidate) >= 0:
                writer.set(status="up_to_date",
                           message=f"NAS 已安装 {installed}，上游 {latest} 无新增",
                           latest_version=latest, last_error="",
                           installed_version=installed)
            else:
                writer.set(status="update_available",
                           message=f"发现上游 {latest}（候选 {candidate}），等待维护升级",
                           latest_version=latest, last_error="",
                           installed_version=installed, candidate_version=candidate)
            return

        writer.set(status="up_to_date",
                   message=f"已是最新（上游 {latest or result.get('current') or '?'}，"
                           f"NAS {installed or '未知'}）",
                   latest_version=latest, last_error="", installed_version=installed)

    # -- 升级 ------------------------------------------------------------- #
    def _do_update(self, job: Job, writer: StatusWriter) -> None:
        writer.set(status="updating", message="正在准备升级候选", phase="prepare")
        result = self._run_prepare("prepare")
        latest = str(result.get("latest") or "")
        code, detail = first_error(result.get("errors"))

        if result.get("status") in (None, "error"):
            raise StepError("prepare_error", detail or code or "prepare_error")

        installed = self._installed_version()
        desired = f"{latest}.{self.cfg.version_suffix}" if latest and self.cfg.version_suffix else latest
        if result.get("status") == "up_to_date" and installed and desired and compare_versions(installed, desired) >= 0:
            writer.set(status="up_to_date", message=f"NAS 已安装 {installed}，无需更新",
                       latest_version=latest, installed_version=installed, last_error="")
            return

        if result.get("needs_review") or result.get("status") == "needs_review" or not result.get("ready"):
            blocked = result.get("changed_paths")
            blocked = blocked.get("blocked") if isinstance(blocked, dict) else None
            brief = "、".join(str(item) for item in (blocked or [])[:3])
            message = f"上游 {latest or '?'} 含需人工适配的变更"
            if brief:
                message += f"（{brief}）"
            message += "，未自动升级（未覆盖任何候选）"
            writer.set(status="needs_review", message=message,
                       last_error=detail or code or "code_change",
                       latest_version=latest)
            return

        candidate = result.get("candidate")
        if not isinstance(candidate, dict):
            raise StepError("candidate_missing", "prepare 未给出候选")
        version = str(candidate.get("version") or "")
        tree = Path(str(candidate.get("tree") or ""))
        self._check_candidate(result, candidate, version, tree, latest)

        installed = self._installed_version()
        if installed:
            self.state.put("installed_version", installed)
        if installed and compare_versions(installed, version) >= 0:
            writer.set(status="up_to_date",
                       message=f"NAS 已安装 {installed}，候选 {version} 无需重复安装",
                       latest_version=latest, installed_version=installed,
                       candidate_version=version)
            return

        before = self._probe(full=True)
        if not before.get("artifacts") or any(v is None for v in before["artifacts"].values()):
            raise StepError("official_unreadable", "官方文件校验不可用，未开始升级")

        writer.set(status="building", message=f"正在构建公开 FPK {version}",
                   phase="build", candidate_version=version)
        fpk = self._build(tree, version)

        writer.set(status="installing", message=f"正在上传 {version} 安装包", phase="upload")
        digest = sha256_file(fpk)
        remote_name = f"fnmedia-ext-{version}-{digest[:12]}.fpk"
        uploaded = self.remote.put(remote_name, fpk, self.cfg.timeouts["upload"])
        remote_path = self.remote.package_path(remote_name)
        if uploaded.get("path") != remote_path:
            raise StepError("upload_path", "远端落盘路径不符")
        if uploaded.get("sha256") != digest or uploaded.get("size") != fpk.stat().st_size:
            raise StepError("upload_verify", "远端 SHA/大小不一致")

        writer.set(status="installing", message=f"正在预检 {version}（dry-run）",
                   phase="install-dry")
        rc, out, err = self._trim_cli(str(fpk), dry_run=True)
        if rc != 0:
            category, summary = classify_failure(rc, out, err)
            raise StepError(f"dry_run_{category}", summary)
        try:
            plan = json.loads(out)
            upgrade = plan["download_status"]["installedInfo"].get("canUpgrade")
            if plan.get("version") != version or plan.get("dry_run") is not True or upgrade is not True:
                raise ValueError("upgrade not accepted")
        except (ValueError, KeyError, TypeError):
            raise StepError("upgrade_not_accepted", "应用中心未确认目标版本可升级，保留当前版本")
        after_dry = self._installed_version()
        if after_dry and installed and after_dry != installed:
            raise StepError("dry_run_changed",
                            f"dry-run 改变了安装版本（{installed} → {after_dry}）")

        writer.set(status="installing", message=f"正在安装 {version}", phase="install")
        install_error = ""
        try:
            rc, out, err = self._trim_cli(str(fpk), dry_run=False)
        except (RemoteError, StepError) as exc:
            # 安装命令的通信结果未知：绝不能在这里宣称成功或失败，
            # 交给验证阶段按 NAS 事实判定（验证失败再回退）。
            install_error = exc.code
            LOG.warning("安装命令通信失败(%s)，按验证结果判定", exc.code)
            rc, out, err = None, b"", b""
        if rc is not None and rc != 0:
            category, summary = classify_failure(rc, out, err)
            self._rollback(writer, reason=f"安装失败（{category}）：{summary}",
                           version=version, installed=installed, before=before)
            return

        writer.set(status="verifying", message=f"正在验证 {version}", phase="verify")
        ok, failures, warnings = self._verify(version, before)
        if not ok:
            reason = "验证失败：" + "；".join(failures[:3])
            if install_error:
                reason = f"安装结果未知（{install_error}），" + reason
            self._rollback(writer, reason=reason,
                           version=version, installed=installed, before=before)
            return

        self._record_success(version, fpk)
        writer.set(status="success", message=f"已升级到 {version}，验证通过",
                   latest_version=latest, last_error="",
                   installed_version=version, candidate_version=version,
                   artifacts_missing=warnings)
        LOG.info("升级成功: %s", version)

    # -- 候选校验 --------------------------------------------------------- #
    def _check_candidate(self, result: Mapping[str, Any], candidate: Mapping[str, Any],
                         version: str, tree: Path, latest: str) -> None:
        if not version:
            raise StepError("candidate_invalid", "候选缺少版本")
        try:
            parse_version(version)
        except Exception:
            raise StepError("candidate_invalid", "候选版本格式非法") from None
        expected = f"{latest}.{self.cfg.version_suffix}" if self.cfg.version_suffix else latest
        if expected and version != expected:
            raise StepError("candidate_version", f"候选 {version} != 期望 {expected}")
        if candidate.get("code_matches_trusted_tree") is not True:
            raise StepError("candidate_untrusted", "候选未标记为与可信树一致")
        if candidate.get("installed") is not False:
            raise StepError("candidate_invalid", "候选状态非法")
        prepare_root = (self.cfg.work_root / "prepare").resolve()
        try:
            resolved = tree.resolve(strict=True)
        except OSError:
            raise StepError("candidate_invalid", "候选树不存在") from None
        if not _is_within(resolved, prepare_root) or not resolved.is_dir():
            raise StepError("candidate_path", "候选树不在工作目录内")
        version_file = resolved / "VERSION"
        try:
            text = version_file.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            raise StepError("candidate_invalid", "候选 VERSION 不可读") from None
        if text != version:
            raise StepError("candidate_version", "候选 VERSION 与元数据不符")

    # -- 构建 ------------------------------------------------------------- #
    def _build(self, tree: Path, version: str) -> Path:
        wheelhouse = self.cfg.wheelhouse
        if not wheelhouse.is_dir():
            raise StepError("wheelhouse_missing", str(wheelhouse))
        fnpack = self.cfg.fnpack
        if not fnpack.is_file() or not os.access(fnpack, os.X_OK):
            raise StepError("fnpack_missing", str(fnpack))

        staging = Path(tempfile.mkdtemp(prefix=".build-", dir=str(self.cfg.work_root)))
        try:
            build_tree = staging / "tree"
            _copy_tree(tree, build_tree)
            wheel_target = build_tree / self.cfg.wheel_rel
            _copy_tree(wheelhouse, wheel_target, require_nonempty=True)

            script = build_tree / self.cfg.build_script
            if not script.is_file():
                raise StepError("build_script_missing", self.cfg.build_script)

            out_dir = self.cfg.work_root / "dist"
            out_dir.mkdir(parents=True, exist_ok=True)
            for stale in out_dir.glob("*.fpk"):
                if version in stale.name:
                    with _suppress_oserror():
                        stale.unlink()

            argv = ["bash", str(script), "--public", "--fnpack", str(fnpack),
                    "--out", str(out_dir)]
            rc, out, err = run_tool(argv, timeout=self.cfg.timeouts["build"],
                                    cwd=str(build_tree), env=self._tool_env())
            if rc != 0:
                excerpt = err.decode("utf-8", "replace")[-200:] or out.decode("utf-8", "replace")[-200:]
                raise StepError("build_failed", sanitize(excerpt, 160))

            produced = sorted(p for p in out_dir.glob("*.fpk") if version in p.name)
            if len(produced) != 1:
                raise StepError("build_output", f"产出 {len(produced)} 个 FPK")
            fpk = produced[0]
            if fpk.stat().st_size <= 0:
                raise StepError("build_output", "FPK 为空")
            target = out_dir / f"fnmedia-ext-{version}.fpk"
            if fpk != target:
                os.replace(fpk, target)
            os.chmod(target, 0o600)
            return target
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    # -- 安装 / 回退 ------------------------------------------------------ #
    def _trim_cli(self, local_path: str, *, dry_run: bool) -> tuple[int, bytes, bytes]:
        # OAuth profile 位于维护主机；CLI 自行上传本地 FPK，绝不在 NAS 上找凭据。
        package = Path(local_path).resolve()
        if not package.is_file() or package.suffix != ".fpk" or package.stat().st_size > MAX_FPK_BYTES:
            raise StepError("install_path", "本地安装包不可用")
        argv = shlex.split(self.cfg.trim_cli)
        if not argv:
            raise StepError("trim_cli_missing", "未配置本机 trim-cli")
        if not dry_run:
            version = version_from_fpk_name(package.name)
            name = f"fnmedia-ext-{version}-{sha256_file(package)[:12]}.fpk"
            return run_tool([self.cfg.python, str(self.cfg.upgrade_helper),
                "--trim-cli", self.cfg.trim_cli, "--remote-fpk", self.remote.package_path(name),
                "--version", version], timeout=self.cfg.timeouts["install"], env=self._tool_env())
        argv += ["--profile", "fnos1", "app", "install-fpk"]
        if dry_run:
            argv.append(self.cfg.dry_run_flag)
        argv += [str(package), "--volume-id", str(self.cfg.volume_id), "--yes",
                 "--accept-license", "--custom-parameters", WIZARD_PARAMETERS]
        return run_tool(argv, timeout=self.cfg.timeouts["install"], env=self._tool_env())

    def _rollback(self, writer: StatusWriter, *, reason: str, version: str,
                  installed: str, before: Mapping[str, Any]) -> None:
        writer.set(status="rolling_back", message="升级失败，正在回退上一版本",
                   phase="rollback", last_error=reason, installed_version=installed)
        last_good = self.state.get("last_good_fpk")
        previous = Path(str(last_good)) if last_good else None
        if previous is None or not previous.is_file():
            writer.set(status="failed",
                       message=f"升级失败（{reason}），无 previous good FPK，需人工处理",
                       phase="failed", last_error=reason, installed_version=installed)
            LOG.error("无可用 previous good FPK，需人工处理")
            return

        previous_version = version_from_fpk_name(previous.name) or installed
        if not previous_version or previous_version == version:
            writer.set(status="failed",
                       message=f"升级失败（{reason}），previous good FPK 不可用于回退，需人工处理",
                       phase="failed", last_error=reason, installed_version=installed)
            return

        digest = sha256_file(previous)
        remote_name = f"fnmedia-ext-{previous_version}-{digest[:12]}.fpk"
        remote_path = self.remote.package_path(remote_name)
        LOG.warning("回退到 %s（只经 appcenter）", previous_version)
        try:
            uploaded = self.remote.put(remote_name, previous, self.cfg.timeouts["upload"])
            if uploaded.get("path") != remote_path or uploaded.get("sha256") != digest:
                raise StepError("rollback_upload", "回退包上传校验失败")
            rc, out, err = self._trim_cli(str(previous), dry_run=False)
        except (RemoteError, StepError) as exc:
            detail = getattr(exc, "code", "rollback_error")
            writer.set(status="failed",
                       message=f"升级失败（{reason}），回退安装也失败（{detail}），需人工处理",
                       phase="failed", last_error=reason, installed_version=installed)
            return

        if rc != 0:
            category, summary = classify_failure(rc, out, err)
            writer.set(status="failed",
                       message=f"升级失败（{reason}），回退安装失败（{category}），需人工处理",
                       phase="failed", last_error=f"{reason} / 回退: {summary}",
                       installed_version=installed)
            LOG.error("回退安装失败: %s %s", category, summary)
            return

        ok, failures, _ = self._verify(previous_version, before)
        readback = self._installed_version()
        if not ok:
            writer.set(status="failed",
                       message=f"升级失败（{reason}），回退后检查未通过：{'；'.join(failures[:3])}，需人工处理",
                       phase="failed", last_error=reason, installed_version=readback or installed)
            LOG.error("回退验收未通过: %s", readback)
            return

        self.state.put("installed_version", previous_version)
        self.state.put("last_rollback_at", int(time.time()))
        self.state.save()
        writer.set(status="rolled_back",
                   message=f"升级失败（{reason}），已回退到 {previous_version}，需人工排查",
                   phase="rollback", last_error=reason,
                   installed_version=previous_version, rolled_back_to=previous_version)
        LOG.warning("已回退到 %s", previous_version)

    # -- 验证 ------------------------------------------------------------- #
    def _verify(self, version: str, before: Mapping[str, Any]) -> tuple[bool, list[str], list[str]]:
        deadline = time.monotonic() + self.cfg.timeouts["verify"]
        failures: list[str] = []
        warnings: list[str] = []
        while True:
            try:
                after = self.remote.probe(self.cfg, self.cfg.timeouts["probe"],
                                          artifacts=self.cfg.official_artifacts,
                                          sockets=True, http=True)
            except RemoteError as exc:
                failures = [f"无法读取验证结果（{exc.code}）"]
            else:
                failures, warnings = compare_probe(version, before, after)
                if not failures:
                    return True, [], warnings
            if time.monotonic() >= deadline:
                return False, failures, warnings
            time.sleep(self.cfg.verify_poll)

    def _wait_version(self, expected: str, timeout: float) -> tuple[bool, str]:
        deadline = time.monotonic() + timeout
        actual = ""
        while True:
            try:
                probe = self.remote.probe(self.cfg, self.cfg.timeouts["probe"])
            except RemoteError:
                probe = {}
            actual = str(probe.get("version") or "")
            if actual == expected:
                return True, actual
            if time.monotonic() >= deadline:
                return False, actual
            time.sleep(self.cfg.verify_poll)

    # -- 状态/环境辅助 ----------------------------------------------------- #
    def _installed_version(self) -> str:
        try:
            probe = self.remote.probe(self.cfg, self.cfg.timeouts["probe"])
        except RemoteError as exc:
            LOG.warning("读取 NAS VERSION 失败: %s", exc.code)
            return ""
        version = str(probe.get("version") or "")
        if version:
            try:
                parse_version(version)
            except Exception:
                LOG.warning("NAS VERSION 格式异常: %s", sanitize(version, 40))
                return ""
        return version

    def _probe(self, *, full: bool) -> dict[str, Any]:
        return self.remote.probe(
            self.cfg,
            self.cfg.timeouts["probe"],
            artifacts=self.cfg.official_artifacts if full else (),
            sockets=full,
            http=full,
        )

    def _record_success(self, version: str, fpk: Path) -> None:
        # 刻意不推进 --trusted-tree：候选树没有 .git，直接换树会让下次 prepare 失败。
        # 是否"已安装"由 NAS 上的 VERSION 判断，候选版本不大于已装版本时跳过安装，
        # 因此后续上游文档继续累积仍然安全；baseline 也始终保持原受审值。
        good_dir = self.cfg.work_root / "known-good"
        good_dir.mkdir(parents=True, exist_ok=True)
        target = good_dir / f"fnmedia-ext-{version}.fpk"
        if fpk != target:
            shutil.copyfile(fpk, target)
            os.chmod(target, 0o600)
        self.state.put("installed_version", version)
        self.state.put("last_success_version", version)
        self.state.put("last_success_at", int(time.time()))
        self.state.put("last_good_fpk", str(target))
        self.state.put("trusted_tree", str(self.cfg.trusted_tree))
        self.state.save()

    def _prepare_exec(self) -> list[str]:
        script = self.cfg.prepare_script
        if os.access(script, os.X_OK):
            return [str(script)]
        return [self.cfg.python, str(script)]

    def _run_prepare(self, mode: str) -> dict[str, Any]:
        if mode not in ("check", "prepare"):
            raise ValueError(mode)
        argv = self._prepare_exec() + [
            "--check" if mode == "check" else "--prepare",
            "--tree", str(self.cfg.trusted_tree),
            "--state", str(self.cfg.prepare_state),
            "--baseline", self.cfg.baseline,
            "--interval", str(self.cfg.check_interval),
            "--timeout", "20",
            "--lock-timeout", "30",
        ]
        if mode == "prepare":
            argv += [
                "--work-root", str(self.cfg.work_root / "prepare"),
                "--version-suffix", self.cfg.version_suffix,
            ]
        rc, out, err = run_tool(argv, timeout=self.cfg.timeouts["prepare"],
                                cwd=str(self.cfg.trusted_tree), env=self._tool_env())
        text = out.decode("utf-8", "replace").strip()
        try:
            result = json.loads(text)
        except ValueError:
            excerpt = sanitize(err.decode("utf-8", "replace")[-200:], 120)
            raise StepError("prepare_output", f"rc={rc} 输出不是 JSON" + (f" / {excerpt}" if excerpt else "")) from None
        if not isinstance(result, dict):
            raise StepError("prepare_output", "输出不是对象")
        return result

    def _tool_env(self) -> dict[str, str]:
        tmp = self.cfg.work_root / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/root"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TMPDIR": str(tmp),
            "PYTHONUNBUFFERED": "1",
            "PYTHON": self.cfg.python,
            "FNMEDIA_UPDATE_STATE": str(self.cfg.prepare_state),
        }
        for key in ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
                    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"):
            if key in os.environ:
                env[key] = os.environ[key]
        return env


def first_error(errors: Any) -> tuple[str, str]:
    if isinstance(errors, list):
        for item in errors:
            if isinstance(item, dict):
                code = str(item.get("code") or "")
                detail = sanitize(item.get("detail"), 160)
                if code or detail:
                    return code, detail
    return "", ""


def _copy_tree(src: Path, dst: Path, *, require_nonempty: bool = False) -> None:
    """安全复制（拒绝符号链接/特殊文件），用于候选树与 wheelhouse。"""
    pending = [(Path(src), Path(dst))]
    files = 0
    while pending:
        source_dir, target_dir = pending.pop()
        target_dir.mkdir(parents=True, exist_ok=True)
        with os.scandir(source_dir) as entries:
            for entry in entries:
                source = Path(entry.path)
                target = target_dir / entry.name
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise StepError("symlink_rejected", sanitize(str(source), 100))
                if stat.S_ISDIR(info.st_mode):
                    pending.append((source, target))
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise StepError("special_file_rejected", sanitize(str(source), 100))
                shutil.copyfile(source, target)
                os.chmod(target, stat.S_IMODE(info.st_mode) | stat.S_IRUSR | stat.S_IWUSR)
                files += 1
    if require_nonempty and files == 0:
        raise StepError("wheelhouse_empty", sanitize(str(src), 100))


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(stream=sys.stderr,
                        format="%(asctime)s fnmedia-maint %(levelname)s %(message)s",
                        level=logging.INFO)
    try:
        cfg = build_config(argv)
    except ConfigError as exc:
        LOG.error("配置错误: %s", exc)
        return 2
    LOG.setLevel(cfg.log_level)
    try:
        return Runner(cfg).execute()
    except ConfigError as exc:
        LOG.error("配置错误: %s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
