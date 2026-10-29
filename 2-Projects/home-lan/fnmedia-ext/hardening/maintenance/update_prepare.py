#!/usr/bin/env python3
"""update_prepare.py — fnmedia-ext 上游跟踪 / 升级候选准备器（保守、只读、不执行上游代码）。

用途
----
定时任务（每小时）或管理页按需调用，回答两个问题：

  1. ``--check``   上游 yujian0815/fnmedia-ext 是否发布了新的稳定 release，
                   该 release 的 commit 相对"受审基线 commit"是否只改了文档。
  2. ``--prepare`` 若只改文档且版本前进，把**当前可信的加固构建树**复制到独立临时目录，
                   仅更新 VERSION / CHANGELOG.md（及白名单内其它文档），生成候选并校验。

安全边界（硬性）
----------------
* 绝不执行上游代码：不 clone、不 fetch、不 pip、不 shell。网络侧只读 GitHub REST
  （release / git ref / contents / compare）；本地只用 git 只读管道命令
  （rev-parse / cat-file / ls-files / diff），并以 --no-ext-diff --no-textconv、
  关闭 hooks 与 fsmonitor、GIT_ALLOW_PROTOCOL=none、GIT_TERMINAL_PROMPT=0 运行。
* 对可信构建树只读；所有写入落在独立临时目录，目标已存在则拒绝（原子 rename）。
* flock 串行；同一 tag 指向不同 commit（tag 重指）一律拒绝。
* 版本用数字序列比较（0.2.9 < 0.2.17），上游版本"降低"不采信。
* 除 VERSION / CHANGELOG.md / 文档.md 之外的任何变更（py/sh/manifest/deps/目录内 .md）
  → needs_review，绝不自动合并。
* 输出中的错误与摘要统一 sanitize：不含 URL、凭据、token。
* 候选**未安装**：status/candidate 里 installed 恒为 false，"current" 保持部署态版本。

输出
----
stdout 单个 JSON：current / latest / latest_tag / upstream_commit / baseline_commit /
changelog / changelog_truncated / needs_review / ready / status / action / changed_paths /
candidate / errors / nextcheck / installed。

退出码：0 = 已产出状态（无论是否需要复核）；1 = 无法产出状态（参数/锁/内部错误）。
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, NamedTuple

SCHEMA = 1
API_ROOT = "https://api.github.com"
DEFAULT_SLUG = "yujian0815/fnmedia-ext"
USER_AGENT = "fnmedia-ext-update-prepare/1"

#: 唯一允许自动合并的路径（仓库根目录下的精确文件名，不接受任何子目录/相对路径）。
DOC_WHITELIST = frozenset({"VERSION", "CHANGELOG.md", "文档.md"})

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_CONTENT_BYTES = 1024 * 1024
MAX_COMPARE_FILES = 300
GIT_BIN = shutil.which("git") or "/usr/bin/git"
DEFAULT_STATE_ENV = "FNMEDIA_UPDATE_STATE"


# --------------------------------------------------------------------------- #
# 错误
# --------------------------------------------------------------------------- #
class UpdateError(Exception):
    """所有可预期失败的基类：code 稳定给 UI，detail 必须可安全展示。"""

    code = "error"
    hard = False  # True = 运行失败（error），False = 需要人工复核（needs_review）

    def __init__(self, code: str | None = None, detail: str = "") -> None:
        self.code = code or type(self).code
        self.detail = detail
        super().__init__(self.code)


class VersionError(UpdateError):
    code = "version_invalid"


class PolicyError(UpdateError):
    code = "policy_violation"
    hard = True


class PayloadError(UpdateError):
    code = "payload_invalid"


class NetworkError(UpdateError):
    code = "network_error"
    hard = True


class HttpStatusError(UpdateError):
    code = "http_error"
    hard = True

    def __init__(self, status: int, detail: str = "") -> None:
        self.status = int(status)
        super().__init__(f"http_{self.status}", detail or f"HTTP {self.status}")


class GitError(UpdateError):
    code = "git_failed"
    hard = True


class TreeError(UpdateError):
    code = "tree_invalid"
    hard = True


class LockTimeout(UpdateError):
    code = "lock_timeout"
    hard = True


class StateCorrupt(UpdateError):
    code = "state_corrupt"
    hard = True


# --------------------------------------------------------------------------- #
# 文本净化
# --------------------------------------------------------------------------- #
_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s\"'<>()\[\]]+")
_USERINFO_RE = re.compile(r"//[^/\s@]+:[^/\s@]+@")
_SECRET_RE = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{10,}|Basic\s+[A-Za-z0-9+/=]{16,})\b",
    re.IGNORECASE,
)
_PARAM_SECRET_RE = re.compile(
    r"(?i)\b(access_token|token|api[_-]?key|password|passwd|secret|signature|sig)=[^&\s\"']+"
)


def sanitize(value: Any, limit: int = 300) -> str:
    """去掉 URL（含 userinfo/query 里的凭据）、token、控制字符，并限长。"""
    text = "" if value is None else str(value)
    text = _URL_RE.sub("<url>", text)  # 先整段吞掉 URL：凭据常在 userinfo/query 里
    text = _USERINFO_RE.sub("//<redacted>@", text)
    text = _SECRET_RE.sub("<redacted>", text)
    text = _PARAM_SECRET_RE.sub(r"\1=<redacted>", text)
    text = "".join(ch for ch in text if ch in "\n\t" or ch >= " ")
    text = re.sub(r"[ \t]+", " ", text).strip()
    if limit and len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return text


# --------------------------------------------------------------------------- #
# 版本：数字序列比较（绝不做字典序比较）
# --------------------------------------------------------------------------- #
_VERSION_RE = re.compile(
    r"^[vV]?(\d+(?:\.\d+){0,3})(?:[-+~][0-9A-Za-z][0-9A-Za-z.+~\-]{0,31})?$"
)


def parse_version(text: Any) -> tuple[int, ...]:
    if not isinstance(text, str):
        raise VersionError("version_not_text")
    match = _VERSION_RE.match(text.strip())
    if not match:
        raise VersionError("version_format", sanitize(text, 40))
    return tuple(int(part) for part in match.group(1).split("."))


def version_key(text: str) -> tuple[int, ...]:
    core = parse_version(text)
    return core + (0,) * (4 - len(core))


def compare_versions(left: str, right: str) -> int:
    """-1/0/1。0.2.17 < 0.2.17.1；0.2.9 < 0.2.17；'0.2.9' > '0.2.17' 的字典序不成立。"""
    a, b = parse_version(left), parse_version(right)
    width = max(len(a), len(b))
    pa = a + (0,) * (width - len(a))
    pb = b + (0,) * (width - len(b))
    return (pa > pb) - (pa < pb)


def is_local_revision_of(current: str, latest: str) -> bool:
    """current 是否是 latest 之上的本地修订（0.2.19.1 相对 0.2.19）＝加固版领先，不是回退。"""
    cur, up = parse_version(current), parse_version(latest)
    return len(cur) > len(up) and cur[: len(up)] == up


# --------------------------------------------------------------------------- #
# 路径白名单
# --------------------------------------------------------------------------- #
def normalize_repo_path(raw: Any) -> str | None:
    """把 git/GitHub 给出的仓库内路径规范成安全的根相对路径，非法返回 None。

    拒绝：绝对路径、反斜杠、空段、"."、".."、控制字符、结尾斜杠。
    因此 "docs/x.md"、"sub/VERSION"、"./VERSION"、"../VERSION" 都不是合法白名单成员。
    """
    if not isinstance(raw, str):
        return None
    path = raw
    if not path or path != path.strip() or path.startswith("/") or "\\" in path:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in path):
        return None
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return "/".join(parts)


def is_whitelisted_path(raw: Any) -> bool:
    path = normalize_repo_path(raw)
    return path is not None and path in DOC_WHITELIST


class Change(NamedTuple):
    status: str
    path: str
    old_path: str | None = None


def classify_changes(changes: Iterable[Change]) -> tuple[list[Change], list[Change]]:
    """返回 (allowed, blocked)。rename 的旧路径同样必须命中白名单。"""
    allowed: list[Change] = []
    blocked: list[Change] = []
    for change in changes:
        ok = is_whitelisted_path(change.path) and (
            change.old_path is None or is_whitelisted_path(change.old_path)
        )
        (allowed if ok else blocked).append(change)
    return allowed, blocked


def describe_changes(changes: Iterable[Change]) -> list[str]:
    out = []
    for change in changes:
        label = normalize_repo_path(change.path) or sanitize(change.path, 80)
        if change.old_path:
            old = normalize_repo_path(change.old_path) or sanitize(change.old_path, 80)
            out.append(f"{change.status}:{old}->{label}")
        else:
            out.append(f"{change.status}:{label}")
    return sorted(out)


# --------------------------------------------------------------------------- #
# 本地 git（只读、硬化环境）
# --------------------------------------------------------------------------- #
def _git_command(repo: Path, args: list[str], git_bin: str) -> list[str]:
    return [
        git_bin,
        "-C",
        str(repo),
        "--no-pager",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "core.quotepath=false",
        *args,
    ]


def _git_environment(home: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "LC_ALL": "C",
        "LANG": "C",
        "TZ": "UTC",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/bin/false",
        "GIT_SSH_COMMAND": "/bin/false",
        "GIT_ALLOW_PROTOCOL": "none",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
    }


def run_git(
    repo: Path,
    args: list[str],
    home: Path,
    *,
    git_bin: str = GIT_BIN,
    timeout: float = 30.0,
) -> bytes:
    """只读执行 git 管道命令。不联网、不跑 hook、不跑外部 diff。"""
    try:
        proc = subprocess.run(
            _git_command(repo, args, git_bin),
            env=_git_environment(home),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitError("git_unavailable", sanitize(exc)) from exc
    if proc.returncode != 0:
        raise GitError("git_failed", sanitize(proc.stderr.decode("utf-8", "replace")))
    return proc.stdout


_SHA_RE = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")


def rev_parse_commit(repo: Path, ref: Any, home: Path, git_bin: str = GIT_BIN) -> str:
    """把 ref/tag/短 SHA 解析成完整 commit SHA（只读）。"""
    if not isinstance(ref, str):
        raise GitError("ref_invalid", "ref 必须是字符串")
    ref = ref.strip()
    if not ref or len(ref) > 200 or ref.startswith("-") or re.search(r"[\s\0]", ref):
        raise GitError("ref_invalid", sanitize(ref, 80))
    out = run_git(
        repo,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}"],
        home,
        git_bin=git_bin,
    )
    sha = out.decode("ascii", "replace").strip()
    if not _SHA_RE.match(sha):
        raise GitError("ref_not_commit", sanitize(ref, 80))
    return sha


def commit_exists(repo: Path, sha: str, home: Path, git_bin: str = GIT_BIN) -> bool:
    if not _SHA_RE.match(sha or ""):
        return False
    try:
        run_git(repo, ["cat-file", "-e", f"{sha}^{{commit}}"], home, git_bin=git_bin)
    except GitError:
        return False
    return True


def git_changes(
    repo: Path, base: str, head: str, home: Path, git_bin: str = GIT_BIN
) -> list[Change]:
    """真实 git diff（--no-renames：改名表现为 D+A，两侧都要过白名单）。"""
    for rev in (base, head):
        if not _SHA_RE.match(rev or ""):
            raise GitError("sha_invalid", sanitize(rev, 80))
    raw = run_git(
        repo,
        [
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--no-color",
            base,
            head,
            "--",
        ],
        home,
        git_bin=git_bin,
    )
    tokens = raw.split(b"\0")
    changes: list[Change] = []
    index = 0
    while index < len(tokens):
        status = tokens[index].decode("ascii", "replace").strip()
        if not status:
            index += 1
            continue
        if status[0] in ("R", "C"):
            if index + 2 >= len(tokens):
                raise GitError("diff_parse", "rename 条目不完整")
            old = tokens[index + 1].decode("utf-8", "surrogateescape")
            new = tokens[index + 2].decode("utf-8", "surrogateescape")
            changes.append(Change(status, new, old))
            index += 3
        elif status[0] in ("A", "M", "D", "T", "U", "X", "B"):
            if index + 1 >= len(tokens):
                raise GitError("diff_parse", "条目不完整")
            path = tokens[index + 1].decode("utf-8", "surrogateescape")
            changes.append(Change(status, path))
            index += 2
        else:
            raise GitError("diff_parse", sanitize(status, 20))
    return changes


def git_blob_text(repo: Path, commit: str, path: str, home: Path, git_bin: str = GIT_BIN) -> str:
    if not _SHA_RE.match(commit or ""):
        raise GitError("sha_invalid", sanitize(commit, 80))
    if normalize_repo_path(path) != path:
        raise GitError("path_invalid", sanitize(path, 80))
    raw = run_git(repo, ["cat-file", "blob", f"{commit}:{path}"], home, git_bin=git_bin)
    if len(raw) > MAX_CONTENT_BYTES:
        raise PayloadError("content_too_large", path)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PayloadError("content_not_utf8", path) from exc


def git_status(
    repo: Path, home: Path, git_bin: str = GIT_BIN
) -> tuple[bool, list[str]]:
    """(工作区是否有已跟踪改动, 未跟踪且未被 .gitignore 忽略的路径)。"""
    raw = run_git(
        repo,
        ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=normal",
         "--ignore-submodules=all"],
        home,
        git_bin=git_bin,
    )
    dirty = False
    untracked: list[str] = []
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        text = entry.decode("utf-8", "surrogateescape")
        code = text[:2]
        path = text[3:] if len(text) > 3 else ""
        if code == "??":
            untracked.append(path)
        else:
            dirty = True
    return dirty, untracked


def list_tracked_files(repo: Path, home: Path, git_bin: str = GIT_BIN) -> list[tuple[str, str]]:
    """索引里的 (mode, path)。符号链接/子模块/特殊文件一律拒绝。"""
    raw = run_git(repo, ["ls-files", "-s", "-z"], home, git_bin=git_bin)
    entries: list[tuple[str, str]] = []
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        meta, _, raw_path = entry.partition(b"\t")
        fields = meta.split(b" ")
        if len(fields) < 3:
            raise TreeError("tree_index_invalid", sanitize(meta, 60))
        mode = fields[0].decode("ascii", "replace")
        stage = fields[2].decode("ascii", "replace")
        path = os.fsdecode(raw_path)
        if stage != "0":
            raise TreeError("tree_index_conflict", sanitize(path, 80))
        if mode == "120000":
            raise TreeError("tree_symlink", sanitize(path, 80))
        if mode == "160000":
            raise TreeError("tree_submodule", sanitize(path, 80))
        if mode not in ("100644", "100755"):
            raise TreeError("tree_special_file", sanitize(path, 80))
        normalized = normalize_repo_path(path)
        if normalized != path:
            raise TreeError("tree_path_invalid", sanitize(path, 80))
        entries.append((mode, path))
    return entries


# --------------------------------------------------------------------------- #
# 文件树 / 清单 / 摘要
# --------------------------------------------------------------------------- #
def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_of_dir(root: Path) -> dict[str, str]:
    manifest: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        for name in dirnames:
            candidate = base / name
            if candidate.is_symlink():
                raise TreeError("tree_symlink", str(candidate.relative_to(root)))
        for name in filenames:
            candidate = base / name
            rel = candidate.relative_to(root).as_posix()
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise TreeError("tree_symlink", rel)
            if not stat.S_ISREG(info.st_mode):
                raise TreeError("tree_special_file", rel)
            manifest[rel] = _sha256_file(candidate)
    return manifest


def manifest_digest(manifest: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(manifest):
        digest.update(rel.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
        digest.update(manifest[rel].encode("ascii"))
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def copy_tracked_tree(src: Path, dst: Path, entries: list[tuple[str, str]]) -> dict[str, str]:
    """按索引拷贝工作区内容到 dst，返回 {rel: sha256}。不覆盖已有文件。"""
    manifest: dict[str, str] = {}
    for mode, rel in entries:
        source = src / rel
        try:
            before = source.lstat()
            data = source.read_bytes()
            after = source.lstat()
        except OSError as exc:
            raise TreeError("tree_file_unreadable", f"{sanitize(rel, 80)}: {sanitize(exc.strerror or exc, 60)}")
        # 构建树可能正被别的进程刷新：读到的内容必须是一次完整的快照。
        if (
            not stat.S_ISREG(after.st_mode)
            or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
            or len(data) != after.st_size
        ):
            raise TreeError("tree_unstable", sanitize(rel, 80))
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(target, "xb") as handle:
                handle.write(data)
        except FileExistsError as exc:
            raise TreeError("candidate_conflict", rel) from exc
        except OSError as exc:
            raise TreeError("candidate_write", f"{sanitize(rel, 80)}: {sanitize(exc.strerror or exc, 60)}")
        os.chmod(target, 0o755 if mode == "100755" else 0o644)
        manifest[rel] = hashlib.sha256(data).hexdigest()
    return manifest


_SECTION_RE = re.compile(r"^##\s+v?(\d+(?:\.\d+){0,3})\b")


def _split_changelog(text: str) -> tuple[str, list[dict[str, Any]]]:
    preamble: list[str] = []
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in text.splitlines(keepends=True):
        match = _SECTION_RE.match(line)
        if match:
            if current is not None:
                sections.append(current)
            current = {"version": match.group(1), "lines": [line]}
        elif current is not None:
            current["lines"].append(line)
        else:
            preamble.append(line)
    if current is not None:
        sections.append(current)
    return "".join(preamble), sections


def _emit_sections(sections: list[dict[str, Any]]) -> str:
    chunks = []
    for section in sections:
        body = "".join(section["lines"]).strip("\n")
        if body:
            chunks.append(body)
    return "\n\n".join(chunks)


def merge_changelog(local_text: str, upstream_text: str, current_version: str) -> str | None:
    """把上游 CHANGELOG 中"比当前版本新"的段落插到本地文件最前，保留本地专有段落。

    返回 None 表示无需改动（没有新段落）——此时绝不重写候选文件。
    """
    new_sections = [
        section
        for section in _split_changelog(upstream_text)[1]
        if compare_versions(section["version"], current_version) > 0
    ]
    if not new_sections:
        return None
    new_versions = {section["version"] for section in new_sections}
    if not local_text.strip():
        preamble = "# 更新日志\n"
        kept: list[dict[str, Any]] = []
    else:
        preamble, local_sections = _split_changelog(local_text)
        preamble = preamble.rstrip("\n")
        kept = [section for section in local_sections if section["version"] not in new_versions]
    body = _emit_sections(new_sections + kept)
    return (preamble + "\n\n" if preamble else "") + body + "\n"


def summarize_markdown(text: Any, limit: int) -> tuple[str, bool]:
    cleaned = sanitize(text or "", limit=0)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return "", False
    if limit and len(cleaned) > limit:
        cut = cleaned[:limit].rstrip()
        newline = cut.rfind("\n")
        if newline > limit * 0.6:
            cut = cut[:newline]
        return cut.rstrip() + "…", True
    return cleaned, False


# --------------------------------------------------------------------------- #
# HTTP（只读 GitHub API）
# --------------------------------------------------------------------------- #
class HttpResult(NamedTuple):
    status: int
    payload: Any = None
    etag: str | None = None


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """只允许 api.github.com 之间的重定向，防止被引导到别的主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.hostname != "api.github.com":
            raise PolicyError("redirect_rejected", sanitize(newurl, 80))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get_json(
    url: str,
    etag: str | None = None,
    proxy: str | None = None,
    timeout: float = 15.0,
) -> HttpResult:
    parts = urllib.parse.urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.hostname != "api.github.com"
        or parts.username
        or parts.password
        or parts.port not in (None, 443)
    ):
        raise PolicyError("url_rejected")
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    }
    if etag:
        headers["If-None-Match"] = etag
    request = urllib.request.Request(url, headers=headers, method="GET")
    handlers: list[Any] = [_SameHostRedirects()]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise PayloadError("response_too_large")
            if not raw:
                raise PayloadError("response_empty")
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise PayloadError("response_not_json") from exc
            return HttpResult(200, payload, response.headers.get("ETag"))
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        remaining = None
        with contextlib.suppress(Exception):
            remaining = (exc.headers or {}).get("X-RateLimit-Remaining")
        with contextlib.suppress(Exception):
            exc.close()
        if status == 304:
            return HttpResult(304, None, etag)
        if status == 403 and str(remaining) == "0":
            raise UpdateError("github_rate_limited", "未认证配额用尽，等重置窗口再试") from None
        raise HttpStatusError(status) from None
    except urllib.error.URLError as exc:
        raise NetworkError("network_unreachable", sanitize(getattr(exc, "reason", exc), 160)) from None
    except TimeoutError:
        raise NetworkError("network_timeout", "请求超时") from None


def _json_size(payload: Any) -> int:
    try:
        return len(json.dumps(payload, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return MAX_RESPONSE_BYTES


class GitHub:
    """极小的只读客户端：只允许 api.github.com，发送 ETag 以节省速率配额。"""

    def __init__(
        self,
        slug: str,
        *,
        fetch: Callable[..., HttpResult] = http_get_json,
        proxy: str | None = None,
        timeout: float = 15.0,
        cache: dict[str, Any] | None = None,
    ) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+", slug):
            raise PolicyError("slug_rejected", sanitize(slug, 60))
        owner, repo = slug.split("/", 1)
        self.slug = slug
        self.prefix = f"{API_ROOT}/repos/{owner}/{repo}"
        self.fetch = fetch
        self.proxy = proxy
        self.timeout = timeout
        self._cache = dict(cache or {})
        self._updated: dict[str, Any] = {}

    def get(self, path: str) -> Any:
        url = self.prefix + path
        cached = self._cache.get(url)
        etag = cached.get("etag") if isinstance(cached, dict) else None
        result = self.fetch(url, etag=etag, proxy=self.proxy, timeout=self.timeout)
        if result.status == 304:
            if not isinstance(cached, dict):
                raise HttpStatusError(304)
            return cached.get("data")
        if result.status != 200:
            raise HttpStatusError(result.status)
        if result.etag and _json_size(result.payload) < 200_000:
            self._updated[url] = {"etag": result.etag, "data": result.payload}
        return result.payload

    def export_cache(self) -> dict[str, Any]:
        merged = dict(self._cache)
        merged.update(self._updated)
        if len(merged) > 32:
            merged = dict(self._updated)
        return merged


def latest_release(gh: GitHub) -> tuple[str, dict[str, Any]]:
    data = gh.get("/releases/latest")
    if not isinstance(data, dict):
        raise PayloadError("release_not_object")
    tag = data.get("tag_name")
    if not isinstance(tag, str) or not tag.strip():
        raise PayloadError("release_tag_missing")
    tag = tag.strip()
    if data.get("draft") or data.get("prerelease"):
        raise PayloadError("release_not_stable", sanitize(tag, 40))
    if not _VERSION_RE.match(tag):
        raise PayloadError("release_tag_not_version", sanitize(tag, 40))
    return tag, data


def tag_commit(gh: GitHub, tag: str) -> str:
    quoted = urllib.parse.quote(tag, safe="")
    try:
        ref = gh.get(f"/git/ref/tags/{quoted}")
    except HttpStatusError:
        ref = None
    if isinstance(ref, dict):
        obj = ref.get("object") if isinstance(ref.get("object"), dict) else {}
        sha, kind = obj.get("sha"), obj.get("type")
        if kind == "tag" and isinstance(sha, str):
            annotated = gh.get(f"/git/tags/{urllib.parse.quote(sha, safe='')}")
            inner = annotated.get("object") if isinstance(annotated, dict) else None
            if isinstance(inner, dict):
                sha, kind = inner.get("sha"), inner.get("type")
        if kind == "commit" and isinstance(sha, str) and _SHA_RE.match(sha.lower()):
            return sha.lower()
    commit = gh.get(f"/commits/{quoted}")
    sha = commit.get("sha") if isinstance(commit, dict) else None
    if isinstance(sha, str) and _SHA_RE.match(sha.lower()):
        return sha.lower()
    raise PayloadError("tag_commit_unresolved", sanitize(tag, 40))


def file_text(gh: GitHub, ref: str, path: str) -> str:
    if normalize_repo_path(path) != path:
        raise PolicyError("path_rejected", sanitize(path, 80))
    quoted = urllib.parse.quote(path, safe="")
    query = urllib.parse.quote(ref, safe="")
    data = gh.get(f"/contents/{quoted}?ref={query}")
    if not isinstance(data, dict):
        raise PayloadError("content_not_object", path)
    if data.get("type") != "file":
        raise PayloadError("content_not_file", path)
    if data.get("encoding") != "base64":
        raise PayloadError("content_encoding", path)
    size = data.get("size")
    if isinstance(size, int) and size > MAX_CONTENT_BYTES:
        raise PayloadError("content_too_large", path)
    body = data.get("content")
    if not isinstance(body, str):
        raise PayloadError("content_missing", path)
    try:
        raw = base64.b64decode(body, validate=False)
    except (ValueError, TypeError) as exc:
        raise PayloadError("content_not_base64", path) from exc
    if isinstance(size, int) and len(raw) != size:
        raise PayloadError("content_size_mismatch", path)
    if len(raw) > MAX_CONTENT_BYTES:
        raise PayloadError("content_too_large", path)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PayloadError("content_not_utf8", path) from exc


def compare_changes(gh: GitHub, base: str, head: str) -> tuple[list[Change], bool]:
    """GitHub compare（base...head）。返回 (changes, truncated)。"""
    data = gh.get(f"/compare/{base}...{head}")
    if not isinstance(data, dict):
        raise PayloadError("compare_not_object")
    status = data.get("status")
    if status == "diverged":
        raise PayloadError("compare_diverged", f"{base[:12]}...{head[:12]}")
    if status == "identical" or data.get("total_commits") == 0:
        return [], False
    files = data.get("files")
    if not isinstance(files, list):
        raise PayloadError("compare_files_missing")
    changes: list[Change] = []
    for item in files:
        if not isinstance(item, dict):
            raise PayloadError("compare_file_invalid")
        name = item.get("filename")
        previous = item.get("previous_filename")
        if not isinstance(name, str) or not name:
            raise PayloadError("compare_file_invalid")
        changes.append(
            Change(str(item.get("status") or "?"), name, previous if isinstance(previous, str) else None)
        )
    truncated = len(files) >= MAX_COMPARE_FILES or not files
    return changes, truncated


# --------------------------------------------------------------------------- #
# 状态文件（flock 串行 + 原子写）
# --------------------------------------------------------------------------- #
class StateStore:
    def __init__(self, path: Path, timeout: float = 20.0) -> None:
        self.path = Path(path)
        self.lock_path = self.path.parent / (self.path.name + ".lock")
        self.timeout = float(timeout)
        self.data: dict[str, Any] = {}
        self._fd: int | None = None

    def __enter__(self) -> "StateStore":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise LockTimeout("lock_timeout", self.lock_path.name) from None
                time.sleep(0.05)
        self._fd = fd
        self.data = self._load()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        if self._fd is not None:
            with contextlib.suppress(OSError):
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            with contextlib.suppress(OSError):
                os.close(self._fd)
            self._fd = None

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise StateCorrupt("state_corrupt", sanitize(exc, 120)) from None
        if not isinstance(data, dict):
            raise StateCorrupt("state_corrupt", "根节点不是对象")
        return data

    def save(self) -> None:
        payload = json.dumps(self.data, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
        fd, tmp = tempfile.mkstemp(prefix=".state-", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


class Updater:
    def __init__(
        self,
        tree: str | os.PathLike[str],
        state_path: str | os.PathLike[str],
        baseline: str | None = None,
        *,
        slug: str = DEFAULT_SLUG,
        fetch: Callable[..., HttpResult] = http_get_json,
        proxy: str | None = None,
        timeout: float = 15.0,
        summary_limit: int = 800,
        interval: int = 3600,
        version_suffix: str = "",
        work_root: str | os.PathLike[str] | None = None,
        lock_timeout: float = 20.0,
        now: Callable[[], datetime] = _utc_now,
        git_bin: str = GIT_BIN,
    ) -> None:
        self.tree = Path(tree).expanduser().resolve()
        self.state_path = Path(state_path).expanduser()
        self.baseline_ref = baseline
        self.slug = slug
        self.fetch = fetch
        self.proxy = proxy
        self.timeout = timeout
        self.summary_limit = int(summary_limit)
        self.interval = int(interval)
        self.version_suffix = version_suffix or ""
        self.work_root = Path(work_root).expanduser().resolve() if work_root else None
        self.lock_timeout = lock_timeout
        self.now = now
        self.git_bin = git_bin

        self._git_home: Path | None = None
        self.state: StateStore | None = None
        self.gh: GitHub | None = None
        self.current_version = ""
        self.latest_version = ""
        self.latest_tag = ""
        self.upstream_commit = ""
        self.release: dict[str, Any] = {}
        self.changes: list[Change] = []
        self.source_dirty = False
        self.source_untracked: list[str] = []

    # -- 对外 ------------------------------------------------------------- #
    def run(self, mode: str) -> dict[str, Any]:
        if mode not in ("check", "prepare"):
            raise ValueError(mode)
        status = self._status_template(mode)
        try:
            self._setup_workdir()
            with StateStore(self.state_path, timeout=self.lock_timeout) as state:
                self.state = state
                status["lock"] = "acquired"
                self._evaluate(status)
                if mode == "prepare" and status["ready"]:
                    self._prepare(status)
                self._finalize(status)
                state.save()
        except UpdateError as exc:
            self._fail(status, exc)
        except (OSError, ValueError) as exc:  # 兜底：绝不泄漏内部细节或 URL
            self._fail(status, UpdateError("internal_error", sanitize(f"{type(exc).__name__}: {exc}")))
        except Exception as exc:  # noqa: BLE001
            self._fail(status, UpdateError("internal_error", sanitize(f"{type(exc).__name__}: {exc}")))
        finally:
            # 自建的临时工作目录只在"检查"模式清理；prepare 的候选必须保留给父级。
            if getattr(self, "_ephemeral_workdir", False) and mode == "check":
                shutil.rmtree(self.work_root, ignore_errors=True)
        return status

    # -- 基础 ------------------------------------------------------------- #
    def _status_template(self, mode: str) -> dict[str, Any]:
        moment = self.now()
        return {
            "schema": SCHEMA,
            "mode": mode,
            "generated_at": iso(moment),
            "status": None,
            "action": "none",
            "current": None,
            "latest": None,
            "latest_tag": None,
            "upstream_commit": None,
            "baseline_commit": None,
            "baseline_ref": None,
            "upstream_code_identical_to_baseline": None,
            "upstream_source_identical": None,
            "upstream_matches_baseline": None,
            "local_ahead": False,
            "source": None,
            "changed_paths": {"allowed": [], "blocked": []},
            "diff_source": None,
            "needs_review": False,
            "ready": False,
            "changelog": "",
            "changelog_truncated": False,
            "candidate": None,
            "installed": False,
            "errors": [],
            "nextcheck": iso(moment + timedelta(seconds=self.interval)),
            "lock": "pending",
            "repo": self.slug,
            "tree": str(self.tree),
        }

    def _setup_workdir(self) -> None:
        if not self.tree.is_dir():
            raise TreeError("tree_missing")
        if self.work_root is None:
            self.work_root = Path(tempfile.mkdtemp(prefix="fnmedia-update-")).resolve()
            self._ephemeral_workdir = True
        self.work_root.mkdir(parents=True, exist_ok=True)
        if self.work_root == self.tree or _is_within(self.work_root, self.tree):
            raise PolicyError("work_root_inside_tree")
        self._git_home = Path(tempfile.mkdtemp(prefix="githome-", dir=self.work_root))

    def _fail(self, status: dict[str, Any], exc: UpdateError) -> None:
        status["errors"].append({"code": exc.code, "detail": sanitize(exc.detail, 200)})
        status["ready"] = False
        status["needs_review"] = not exc.hard
        if exc.hard:
            status["status"] = "error"
            status["action"] = "retry"
        elif status["status"] != "prepared":
            status["status"] = "needs_review"
            status["action"] = "review"

    # -- 评估 ------------------------------------------------------------- #
    def _evaluate(self, status: dict[str, Any]) -> None:
        assert self._git_home is not None and self.state is not None
        version_path = self.tree / "VERSION"
        if not version_path.is_file():
            raise TreeError("version_missing")
        try:
            current = version_path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as exc:
            raise TreeError("version_unreadable", sanitize(exc, 80))
        parse_version(current)
        self.current_version = current
        status["current"] = current

        baseline_ref = self.baseline_ref
        if not baseline_ref:
            recorded = self.state.data.get("baseline")
            baseline_ref = recorded.get("commit") if isinstance(recorded, dict) else None
        if not baseline_ref:
            raise UpdateError("baseline_missing", "未提供 --baseline，历史状态中也无记录")
        status["baseline_ref"] = sanitize(baseline_ref, 60)
        try:
            baseline = rev_parse_commit(self.tree, baseline_ref, self._git_home, self.git_bin)
        except GitError as exc:
            if "not a git repository" in (exc.detail or "").lower():
                raise TreeError("tree_not_git") from None
            raise UpdateError("baseline_unresolved", sanitize(baseline_ref, 60)) from None
        status["baseline_commit"] = baseline

        # 只拷贝已跟踪文件：未跟踪文件（构建产物/未提交的新代码）不会进候选，必须如实报告。
        try:
            self.source_dirty, self.source_untracked = git_status(
                self.tree, self._git_home, self.git_bin
            )
        except GitError:
            self.source_dirty, self.source_untracked = False, []
        status["source"] = {
            "dirty": self.source_dirty,
            "untracked_count": len(self.source_untracked),
            "untracked_sample": [sanitize(path, 80) for path in self.source_untracked[:5]],
        }

        cache = self.state.data.get("http_cache")
        self.gh = GitHub(
            self.slug,
            fetch=self.fetch,
            proxy=self.proxy,
            timeout=self.timeout,
            cache=cache if isinstance(cache, dict) else None,
        )
        try:
            self._track(status, baseline)
        finally:
            self.state.data["http_cache"] = self.gh.export_cache()

    def _track(self, status: dict[str, Any], baseline: str) -> None:
        assert self.gh is not None and self.state is not None
        tag, release = latest_release(self.gh)
        latest = tag.lstrip("vV")
        parse_version(latest)
        self.latest_tag = tag
        self.latest_version = latest
        self.release = release
        status["latest_tag"] = tag
        status["latest"] = latest

        commit = tag_commit(self.gh, tag)
        self.upstream_commit = commit
        status["upstream_commit"] = commit

        pinned = (self.state.data.get("tags") or {}).get(tag)
        if isinstance(pinned, str) and pinned != commit:
            raise UpdateError("tag_moved", f"{tag}: {pinned} -> {commit}")

        summary, truncated = summarize_markdown(release.get("body"), self.summary_limit)
        status["changelog"] = summary
        status["changelog_truncated"] = truncated

        if compare_versions(latest, self.current_version) < 0 and not is_local_revision_of(
            self.current_version, latest
        ):
            raise UpdateError(
                "version_regression", f"上游 {latest} 低于当前 {self.current_version}"
            )

        self.changes = self._collect_changes(status, baseline, commit)

        if commit == baseline:
            status["upstream_code_identical_to_baseline"] = True
            status["upstream_source_identical"] = True
        status["upstream_matches_baseline"] = commit == baseline

        order = compare_versions(latest, self.current_version)
        if order == 0:
            if commit != baseline:
                raise UpdateError("release_republished", f"{tag} 版本未变但 commit 变化")
            status["status"] = "up_to_date"
            status["action"] = "none"
            return
        if order < 0:
            # 本地加固修订版领先于上游（0.2.19.1 vs 0.2.19）：无需动作，也不是回退。
            status["local_ahead"] = True
            status["status"] = "up_to_date"
            status["action"] = "none"
            return

        # 版本前进：核对上游 VERSION 文件与 tag 一致（坏 payload 早发现）
        upstream_version = file_text(self.gh, commit, "VERSION")
        if compare_versions(upstream_version, latest) != 0:
            raise PayloadError(
                "upstream_version_mismatch",
                f"tag={latest} VERSION={sanitize(upstream_version, 20)}",
            )
        self._cross_check_local(status, commit, "VERSION", upstream_version)

        status["status"] = "update_available"
        status["ready"] = True
        status["action"] = "prepare"

    def _collect_changes(self, status: dict[str, Any], baseline: str, commit: str) -> list[Change]:
        assert self.gh is not None and self._git_home is not None
        if commit == baseline:
            status["diff_source"] = "identical"
            status["changed_paths"] = {"allowed": [], "blocked": []}
            return []
        if commit_exists(self.tree, commit, self._git_home, self.git_bin):
            changes = git_changes(self.tree, baseline, commit, self._git_home, self.git_bin)
            status["diff_source"] = "local-git"
            truncated = False
        else:
            changes, truncated = compare_changes(self.gh, baseline, commit)
            status["diff_source"] = "github-compare"
        if truncated:
            raise UpdateError("compare_truncated", "变更清单被截断，无法证明只动文档")
        allowed, blocked = classify_changes(changes)
        status["changed_paths"] = {
            "allowed": describe_changes(allowed),
            "blocked": describe_changes(blocked),
        }
        status["upstream_code_identical_to_baseline"] = not blocked
        status["upstream_source_identical"] = not blocked
        if blocked:
            raise UpdateError(
                "code_change",
                "非白名单变更: " + ", ".join(describe_changes(blocked)[:6]),
            )
        for change in allowed:
            if change.status.split(":")[0] not in ("A", "M", "D", "T"):
                raise PayloadError("change_status_unknown", sanitize(change.status, 10))
        return allowed

    def _cross_check_local(
        self, status: dict[str, Any], commit: str, path: str, upstream_text: str
    ) -> None:
        """本地恰好有该 commit 时，用 git blob 复核 GitHub 返回的内容（防投毒/串改）。"""
        assert self._git_home is not None
        if not commit_exists(self.tree, commit, self._git_home, self.git_bin):
            return
        try:
            local = git_blob_text(self.tree, commit, path, self._git_home, self.git_bin)
        except GitError:
            return
        if local != upstream_text:
            raise PayloadError("content_mismatch", path)

    # -- 候选 ------------------------------------------------------------- #
    def _reuse_candidate(self, destination: Path, version: str, commit: str) -> dict[str, Any]:
        """同一 tag+版本重复 prepare：复用已存在候选，但绝不覆盖、绝不信任被改过的目录。"""
        assert self._git_home is not None
        metadata_path = destination / "candidate.json"
        tree_dir = destination / "tree"
        if not (metadata_path.is_file() and tree_dir.is_dir()):
            raise UpdateError("candidate_exists", destination.name)
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise UpdateError("candidate_exists", destination.name) from None
        if not isinstance(metadata, dict) or metadata.get("kind") != "fnmedia-ext-candidate":
            raise UpdateError("candidate_exists", destination.name)
        upstream = metadata.get("upstream") if isinstance(metadata.get("upstream"), dict) else {}
        if metadata.get("version") != version or upstream.get("commit") != commit:
            raise UpdateError("candidate_exists", destination.name)

        manifest = manifest_of_dir(tree_dir)
        if manifest_digest(manifest) != metadata.get("tree_digest"):
            raise UpdateError("candidate_tampered", destination.name)

        entries = list_tracked_files(self.tree, self._git_home, self.git_bin)
        source = {rel: _sha256_file(self.tree / rel) for _mode, rel in entries}
        changed = set(metadata.get("changed_files") or [])
        drift = sorted(
            rel for rel in source if rel not in changed and manifest.get(rel) != source[rel]
        )
        extra = sorted(set(manifest) - set(source) - changed)
        if drift or extra:
            raise UpdateError(
                "candidate_tampered",
                destination.name + ": " + ", ".join((drift + extra)[:5]),
            )
        return {
            "dir": str(destination),
            "tree": str(tree_dir),
            "metadata": str(metadata_path),
            "version": version,
            "upstream_commit": commit,
            "latest_tag": self.latest_tag,
            "tree_digest": metadata.get("tree_digest"),
            "source_digest": metadata.get("source_digest"),
            "file_count": metadata.get("file_count"),
            "changed_files": sorted(changed),
            "code_matches_trusted_tree": True,
            "reused": True,
            "installed": False,
        }

    def _prepare(self, status: dict[str, Any]) -> None:
        assert self.work_root is not None and self._git_home is not None and self.gh is not None
        version = self.latest_version
        if self.version_suffix:
            version += self.version_suffix if self.version_suffix.startswith(".") else "." + self.version_suffix
        parse_version(version)
        if compare_versions(version, self.current_version) <= 0:
            raise PolicyError("candidate_version_not_newer", version)

        commit = self.upstream_commit
        destination = self.work_root / "candidates" / f"fnmedia-ext-{version}-{commit[:12]}"
        if destination.exists():
            status["candidate"] = self._reuse_candidate(destination, version, commit)
            status["status"] = "prepared"
            status["ready"] = True
            status["action"] = "install"
            return
        destination.parent.mkdir(parents=True, exist_ok=True)

        staging = Path(tempfile.mkdtemp(prefix=".building-", dir=destination.parent))
        try:
            tree_dir = staging / "tree"
            tree_dir.mkdir()
            entries = list_tracked_files(self.tree, self._git_home, self.git_bin)
            source_manifest = copy_tracked_tree(self.tree, tree_dir, entries)

            upstream_version = file_text(self.gh, commit, "VERSION")
            if compare_versions(upstream_version, self.latest_version) != 0:
                raise PayloadError("upstream_version_mismatch", sanitize(upstream_version, 20))
            self._cross_check_local(status, commit, "VERSION", upstream_version)

            upstream_changelog = file_text(self.gh, commit, "CHANGELOG.md")
            self._cross_check_local(status, commit, "CHANGELOG.md", upstream_changelog)

            (tree_dir / "VERSION").write_text(version + "\n", encoding="utf-8")
            local_changelog = ""
            if (self.tree / "CHANGELOG.md").is_file():
                local_changelog = (self.tree / "CHANGELOG.md").read_text(encoding="utf-8")
            merged = merge_changelog(local_changelog, upstream_changelog, self.current_version)
            touched = {"VERSION"}
            if merged is not None:
                (tree_dir / "CHANGELOG.md").write_text(merged, encoding="utf-8")
                touched.add("CHANGELOG.md")

            for change in self.changes:
                path = normalize_repo_path(change.path)
                if path is None or path in ("VERSION", "CHANGELOG.md"):
                    continue
                touched.add(path)
                target = tree_dir / path
                if change.status.split(":")[0] == "D":
                    if target.exists():
                        target.unlink()
                    continue
                text = file_text(self.gh, commit, path)
                self._cross_check_local(status, commit, path, text)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")

            candidate_manifest = manifest_of_dir(tree_dir)
            source_paths = set(source_manifest)
            candidate_paths = set(candidate_manifest)
            illegal = sorted(
                path
                for path in source_paths | candidate_paths
                if path not in touched
                and source_manifest.get(path) != candidate_manifest.get(path)
            )
            if illegal:
                raise UpdateError(
                    "candidate_mismatch", "候选出现非文档改动: " + ", ".join(illegal[:5])
                )
            removed = sorted(source_paths - candidate_paths - touched)
            if removed:
                raise UpdateError("candidate_mismatch", "候选缺失文件: " + ", ".join(removed[:5]))

            metadata = {
                "schema": SCHEMA,
                "kind": "fnmedia-ext-candidate",
                "prepared_at": iso(self.now()),
                "repo": self.slug,
                "version": version,
                "trusted_version": self.current_version,
                "upstream": {
                    "tag": self.latest_tag,
                    "commit": commit,
                    "published_at": self.release.get("published_at"),
                },
                "baseline_commit": status.get("baseline_commit"),
                "upstream_code_identical_to_baseline": status.get(
                    "upstream_code_identical_to_baseline"
                ),
                "changed_files": sorted(touched),
                "source_tree": str(self.tree),
                "source": {
                    "dirty": self.source_dirty,
                    "tracked_files": len(entries),
                    "untracked_excluded": [sanitize(p, 120) for p in self.source_untracked[:20]],
                    "untracked_excluded_count": len(self.source_untracked),
                },
                "source_digest": manifest_digest(source_manifest),
                "tree_digest": manifest_digest(candidate_manifest),
                "file_count": len(candidate_manifest),
                "installed": False,
                "verified": {
                    "code_matches_trusted_tree": True,
                    "only_documents_changed": True,
                    "upstream_code_executed": False,
                },
            }
            (staging / "candidate.json").write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            if destination.exists():
                raise UpdateError("candidate_exists", destination.name)
            try:
                os.rename(staging, destination)
            except OSError as exc:
                raise UpdateError("candidate_write", sanitize(exc.strerror or exc, 80)) from None

            status["candidate"] = {
                "dir": str(destination),
                "tree": str(destination / "tree"),
                "metadata": str(destination / "candidate.json"),
                "version": version,
                "upstream_commit": commit,
                "latest_tag": self.latest_tag,
                "tree_digest": metadata["tree_digest"],
                "source_digest": metadata["source_digest"],
                "file_count": metadata["file_count"],
                "changed_files": metadata["changed_files"],
                "code_matches_trusted_tree": True,
                "installed": False,
            }
            status["status"] = "prepared"
            status["ready"] = True
            status["action"] = "install"
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    # -- 收尾 ------------------------------------------------------------- #
    def _finalize(self, status: dict[str, Any]) -> None:
        status["installed"] = False
        if status["status"] is None:
            status["status"] = "error"
        if self.state is not None:
            data = self.state.data
            data["schema"] = SCHEMA
            if status.get("baseline_commit"):
                previous = data.get("baseline") if isinstance(data.get("baseline"), dict) else {}
                record = {
                    "ref": status.get("baseline_ref"),
                    "commit": status["baseline_commit"],
                    "recorded_at": iso(self.now()),
                }
                old_commit = previous.get("commit")
                if old_commit and old_commit != status["baseline_commit"]:
                    record["previous_commit"] = old_commit  # 基线被人为移动时留下审计痕迹
                data["baseline"] = record
            tags = data.get("tags")
            if not isinstance(tags, dict):
                tags = {}
            if status.get("latest_tag") and status.get("upstream_commit"):
                # setdefault：tag 被重指时保留首次观测值，让下一次检查继续报 tag_moved
                tags.setdefault(status["latest_tag"], status["upstream_commit"])
            data["tags"] = tags
            data["last"] = {
                "checked_at": status["generated_at"],
                "mode": status["mode"],
                "status": status["status"],
                "current": status["current"],
                "latest": status["latest"],
                "candidate": (status.get("candidate") or {}).get("dir"),
                "needs_review": status["needs_review"],
            }
        status["nextcheck"] = iso(self.now() + timedelta(seconds=self.interval))


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="fnmedia-ext 上游跟踪与升级候选准备（只读、不执行上游代码）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="只检查，不落盘候选")
    mode.add_argument("--prepare", action="store_true", help="检查并生成候选构建树")
    parser.add_argument("--tree", required=True, help="已存在的可信构建树（只读）")
    parser.add_argument("--state", default=os.environ.get(DEFAULT_STATE_ENV),
                        help=f"状态文件路径（默认取 ${DEFAULT_STATE_ENV}）")
    parser.add_argument("--baseline", default=None,
                        help="受审基线 commit/tag（如 93a781b 或 v0.2.19），缺省用状态里的记录")
    parser.add_argument("--repo", default=DEFAULT_SLUG, help="owner/repo")
    parser.add_argument("--proxy", default=None, help="HTTP(S) 代理，缺省沿用环境变量")
    parser.add_argument("--work-root", default=None, help="独立工作目录（默认系统临时目录）")
    parser.add_argument("--timeout", type=float, default=15.0, help="网络超时秒")
    parser.add_argument("--lock-timeout", type=float, default=20.0, help="flock 等待秒")
    parser.add_argument("--interval", type=int, default=3600, help="nextcheck 间隔秒")
    parser.add_argument("--summary-limit", type=int, default=800, help="changelog 摘要字符上限")
    parser.add_argument("--version-suffix", default="", help="候选版本后缀，如 1 → 0.2.19.1")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.state:
        parser.error(f"缺少 --state 或环境变量 {DEFAULT_STATE_ENV}")

    updater = Updater(
        args.tree,
        args.state,
        args.baseline,
        slug=args.repo,
        proxy=args.proxy,
        timeout=args.timeout,
        summary_limit=args.summary_limit,
        interval=args.interval,
        version_suffix=args.version_suffix,
        work_root=args.work_root,
        lock_timeout=args.lock_timeout,
    )
    try:
        status = updater.run("check" if args.check else "prepare")
    except (UpdateError, OSError) as exc:
        code = getattr(exc, "code", "error")
        detail = sanitize(getattr(exc, "detail", ""), 200)
        status = {
            "schema": SCHEMA,
            "mode": "check" if args.check else "prepare",
            "status": "error",
            "action": "retry",
            "current": None,
            "latest": None,
            "needs_review": True,
            "ready": False,
            "installed": False,
            "errors": [{"code": code, "detail": detail}],
            "nextcheck": iso(_utc_now() + timedelta(seconds=args.interval)),
        }
        print(json.dumps(status, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
