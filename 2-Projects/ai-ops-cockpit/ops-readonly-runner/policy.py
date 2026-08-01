import fnmatch
import hashlib
import json
import os
import re
import secrets
import stat
import time


ALLOWED_WORKFLOW = "readonly_safe"
ALLOWED_TOOLS = {"read", "grep", "find", "ls"}
MAX_REQUEST_CHARS = 8192
MAX_PATH_CHARS = 512
MAX_PATTERN_CHARS = 160
MAX_READ_LINES = 240
MAX_READ_CHARS = 40000
MAX_FILE_BYTES = 512 * 1024
MAX_GREP_FILES = 240
MAX_GREP_BYTES = 4 * 1024 * 1024
MAX_GREP_MATCHES = 160
MAX_FIND_ENTRIES = 1200
MAX_LIST_ENTRIES = 240
MAX_WALK_DEPTH = 10

SENSITIVE_NAMES = {
    ".aws",
    ".docker",
    ".env",
    ".git",
    ".gnupg",
    ".kube",
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".ssh",
    "authorized_keys",
    "credentials",
    "credential",
    "secrets",
    "secret",
    "private-key",
    "private_key",
    "id_rsa",
    "id_ed25519",
    "known_hosts",
    "kuma.db",
}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db")
SECRET_PATTERNS = (
    re.compile(r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\b\s*[:=]\s*['\"]?[^\s'\"]{10,}"),
    re.compile(r"https://open\.feishu\.cn/open-apis/bot/v2/hook/[A-Za-z0-9-]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


class PolicyDenied(Exception):
    def __init__(self, reason, code="policy_denied"):
        super().__init__(reason)
        self.reason = reason
        self.code = code


def utcish_now():
    return time.strftime("%Y-%m-%d %H:%M:%S %Z")


def _private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _atomic_json(path, payload):
    _private_dir(os.path.dirname(path))
    temp_path = f"{path}.{os.getpid()}.{secrets.token_hex(3)}.tmp"
    with open(temp_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, path)


def _safe_identifier(value, field):
    value = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", value):
        raise PolicyDenied(f"invalid {field}", "invalid_request")
    return value


def _sensitive_component(component):
    lowered = component.lower()
    if lowered in SENSITIVE_NAMES:
        return True
    if any(lowered.endswith(suffix) for suffix in SENSITIVE_SUFFIXES):
        return True
    return "secret" in lowered or "credential" in lowered or "private_key" in lowered


def _summary_hash(value):
    if not value:
        return None
    return hashlib.sha256(str(value).encode("utf-8", "replace")).hexdigest()[:12]


def _sanitize_text(value):
    text = str(value or "")
    redacted = 0
    for pattern in SECRET_PATTERNS:
        text, count = pattern.subn("[REDACTED_SECRET]", text)
        redacted += count
    return text, redacted


def _bounded_int(value, default, minimum, maximum, field):
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise PolicyDenied(f"invalid {field}", "invalid_request")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise PolicyDenied(f"invalid {field}", "invalid_request") from None
    if parsed < minimum or parsed > maximum:
        raise PolicyDenied(f"invalid {field}", "invalid_request")
    return parsed


class ToolPolicyGate:
    def __init__(self, readonly_root, projects, audit_dir):
        self.readonly_root = os.path.realpath(readonly_root)
        self.projects = set(projects)
        self.audit_dir = audit_dir

    def health(self):
        mounted = os.path.isdir(self.readonly_root)
        mount_readonly = False
        try:
            best = ("", "")
            with open("/proc/mounts", encoding="utf-8") as file:
                for line in file:
                    fields = line.split()
                    if len(fields) < 4:
                        continue
                    mountpoint = fields[1].replace("\\040", " ")
                    if self.readonly_root == mountpoint or self.readonly_root.startswith(mountpoint.rstrip("/") + "/"):
                        if len(mountpoint) > len(best[0]):
                            best = (mountpoint, fields[3])
            mount_readonly = "ro" in best[1].split(",")
        except OSError:
            pass
        return {
            "ok": mounted and mount_readonly and bool(self.projects),
            "mode": ALLOWED_WORKFLOW,
            "tools": sorted(ALLOWED_TOOLS),
            "projectCount": len(self.projects),
            "mountReadonly": mount_readonly,
            "generatedAt": utcish_now(),
        }

    def execute(self, request):
        started = time.time()
        record_id = "tpg-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        record = {
            "id": record_id,
            "taskId": None,
            "project": None,
            "workflow": None,
            "tool": None,
            "decision": "blocked",
            "reason": None,
            "paramsSummary": {},
            "createdAt": utcish_now(),
            "secretExposure": 0,
        }
        try:
            if not isinstance(request, dict):
                raise PolicyDenied("request must be an object", "invalid_request")
            if len(json.dumps(request, ensure_ascii=False)) > MAX_REQUEST_CHARS:
                raise PolicyDenied("request too large", "invalid_request")
            task_id = _safe_identifier(request.get("taskId") or "interactive", "taskId")
            project = _safe_identifier(request.get("project"), "project")
            workflow = str(request.get("workflow") or "").strip()
            tool = str(request.get("tool") or "").strip()
            params = request.get("params") or {}
            if not isinstance(params, dict):
                raise PolicyDenied("params must be an object", "invalid_request")
            record.update({"taskId": task_id, "project": project, "workflow": workflow, "tool": tool})
            record["paramsSummary"] = self._params_summary(tool, params)
            self._authorize(project, workflow, tool)
            result = getattr(self, f"_tool_{tool}")(project, params)
            record["decision"] = "allowed"
            record["resultSummary"] = self._result_summary(tool, result)
            return {"ok": True, "recordId": record_id, "data": result}
        except PolicyDenied as exc:
            record["reason"] = exc.code
            return {"ok": False, "error": exc.code, "reason": exc.reason, "recordId": record_id}
        except Exception as exc:
            record["reason"] = type(exc).__name__
            return {"ok": False, "error": "tool_failed", "reason": type(exc).__name__, "recordId": record_id}
        finally:
            record["durationMs"] = round((time.time() - started) * 1000)
            _atomic_json(os.path.join(self.audit_dir, record_id + ".json"), record)

    def _authorize(self, project, workflow, tool):
        if workflow != ALLOWED_WORKFLOW:
            raise PolicyDenied("workflow is not readonly_safe")
        if tool not in ALLOWED_TOOLS:
            raise PolicyDenied("tool is not allowed")
        if project not in self.projects:
            raise PolicyDenied("project is not registered")
        root = os.path.join(self.readonly_root, project)
        if os.path.islink(root):
            raise PolicyDenied("project snapshot symlink is blocked")
        if not os.path.isdir(root):
            raise PolicyDenied("project snapshot is not ready", "snapshot_not_ready")

    def _project_root(self, project):
        root = os.path.realpath(os.path.join(self.readonly_root, project))
        if os.path.commonpath([self.readonly_root, root]) != self.readonly_root:
            raise PolicyDenied("project root escaped readonly root")
        return root

    def _resolve(self, project, relative_path, require_exists=True):
        relative_path = str(relative_path or ".").strip() or "."
        if len(relative_path) > MAX_PATH_CHARS or "\x00" in relative_path:
            raise PolicyDenied("invalid path", "invalid_request")
        if os.path.isabs(relative_path):
            raise PolicyDenied("absolute path is blocked")
        normalized = os.path.normpath(relative_path)
        if normalized == ".." or normalized.startswith("../"):
            raise PolicyDenied("path traversal is blocked")
        parts = [part for part in normalized.split(os.sep) if part not in ("", ".")]
        if any(_sensitive_component(part) for part in parts):
            raise PolicyDenied("sensitive path is blocked")
        root = self._project_root(project)
        current = root
        for part in parts:
            current = os.path.join(current, part)
            try:
                mode = os.lstat(current).st_mode
            except FileNotFoundError:
                if require_exists:
                    raise PolicyDenied("path not found", "not_found")
                break
            if stat.S_ISLNK(mode):
                raise PolicyDenied("symlink path is blocked")
        candidate = os.path.join(root, normalized)
        real = os.path.realpath(candidate)
        if os.path.commonpath([root, real]) != root:
            raise PolicyDenied("resolved path escaped project root")
        if require_exists and not os.path.exists(candidate):
            raise PolicyDenied("path not found", "not_found")
        return candidate, normalized

    def _tool_read(self, project, params):
        path, normalized = self._resolve(project, params.get("path"))
        if not os.path.isfile(path):
            raise PolicyDenied("read only supports regular files", "invalid_request")
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            raise PolicyDenied("file exceeds readonly_safe limit", "limit_exceeded")
        start = _bounded_int(params.get("startLine"), 1, 1, 1_000_000, "startLine")
        count = _bounded_int(params.get("lineCount"), 160, 1, MAX_READ_LINES, "lineCount")
        lines = []
        redacted = 0
        with open(path, encoding="utf-8", errors="replace") as file:
            for number, line in enumerate(file, start=1):
                if number < start:
                    continue
                if len(lines) >= count:
                    break
                clean_line, redacted_count = _sanitize_text(line.rstrip())
                redacted += redacted_count
                lines.append(f"{number:>6}  {clean_line}")
        content = "\n".join(lines)[:MAX_READ_CHARS]
        return {"path": normalized, "startLine": start, "lineCount": len(lines), "content": content, "truncated": len(content) >= MAX_READ_CHARS, "redacted": redacted}

    def _tool_ls(self, project, params):
        path, normalized = self._resolve(project, params.get("path") or ".")
        if not os.path.isdir(path):
            raise PolicyDenied("ls only supports directories", "invalid_request")
        entries = []
        for entry in sorted(os.scandir(path), key=lambda item: item.name.lower()):
            if _sensitive_component(entry.name) or entry.is_symlink():
                continue
            kind = "dir" if entry.is_dir(follow_symlinks=False) else "file"
            entries.append({"name": entry.name, "type": kind})
            if len(entries) >= MAX_LIST_ENTRIES:
                break
        return {"path": normalized, "entries": entries, "truncated": len(entries) >= MAX_LIST_ENTRIES}

    def _walk_files(self, root, base_path):
        scanned = 0
        for current, dirs, files in os.walk(base_path, followlinks=False):
            relative_depth = os.path.relpath(current, base_path).count(os.sep)
            dirs[:] = [name for name in dirs if not _sensitive_component(name) and not os.path.islink(os.path.join(current, name))]
            if relative_depth >= MAX_WALK_DEPTH:
                dirs[:] = []
            for name in sorted(files):
                scanned += 1
                if scanned > MAX_FIND_ENTRIES:
                    return
                path = os.path.join(current, name)
                if _sensitive_component(name) or os.path.islink(path) or not os.path.isfile(path):
                    continue
                yield path, os.path.relpath(path, root)

    def _tool_find(self, project, params):
        base, normalized = self._resolve(project, params.get("path") or ".")
        if not os.path.isdir(base):
            raise PolicyDenied("find only supports directories", "invalid_request")
        pattern = str(params.get("pattern") or "*").strip() or "*"
        if len(pattern) > MAX_PATTERN_CHARS or os.path.isabs(pattern) or ".." in pattern.split("/"):
            raise PolicyDenied("invalid find pattern", "invalid_request")
        root = self._project_root(project)
        matches = []
        for path, relative in self._walk_files(root, base):
            if fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(os.path.basename(path), pattern):
                matches.append(relative)
            if len(matches) >= MAX_LIST_ENTRIES:
                break
        return {"path": normalized, "pattern": pattern, "matches": matches, "truncated": len(matches) >= MAX_LIST_ENTRIES}

    def _tool_grep(self, project, params):
        base, normalized = self._resolve(project, params.get("path") or ".")
        query = str(params.get("query") or "")
        if not query or len(query) > MAX_PATTERN_CHARS or "\x00" in query:
            raise PolicyDenied("invalid grep query", "invalid_request")
        case_sensitive_value = params.get("caseSensitive", False)
        if not isinstance(case_sensitive_value, bool):
            raise PolicyDenied("invalid caseSensitive", "invalid_request")
        case_sensitive = case_sensitive_value
        needle = query if case_sensitive else query.lower()
        root = self._project_root(project)
        candidates = [(base, os.path.relpath(base, root))] if os.path.isfile(base) else self._walk_files(root, base)
        matches = []
        files_scanned = 0
        bytes_scanned = 0
        redacted = 0
        for path, relative in candidates:
            files_scanned += 1
            if files_scanned > MAX_GREP_FILES:
                break
            size = os.path.getsize(path)
            if size > MAX_FILE_BYTES or bytes_scanned + size > MAX_GREP_BYTES:
                continue
            bytes_scanned += size
            try:
                with open(path, encoding="utf-8", errors="replace") as file:
                    for line_number, line in enumerate(file, start=1):
                        haystack = line if case_sensitive else line.lower()
                        if needle in haystack:
                            preview, redacted_count = _sanitize_text(line.strip()[:300])
                            redacted += redacted_count
                            matches.append({"path": relative, "line": line_number, "preview": preview})
                            if len(matches) >= MAX_GREP_MATCHES:
                                break
            except OSError:
                continue
            if len(matches) >= MAX_GREP_MATCHES:
                break
        return {
            "path": normalized,
            "queryHash": _summary_hash(query),
            "matches": matches,
            "filesScanned": files_scanned,
            "bytesScanned": bytes_scanned,
            "truncated": len(matches) >= MAX_GREP_MATCHES or files_scanned > MAX_GREP_FILES,
            "redacted": redacted,
        }

    def _params_summary(self, tool, params):
        raw_path = str(params.get("path") or ".")
        summary = {"pathHash": _summary_hash(raw_path), "pathLength": len(raw_path)}
        if tool == "grep":
            summary["queryHash"] = _summary_hash(params.get("query"))
            summary["queryLength"] = len(str(params.get("query") or ""))
        if tool == "find":
            summary["patternHash"] = _summary_hash(params.get("pattern"))
            summary["patternLength"] = len(str(params.get("pattern") or ""))
        if tool == "read":
            summary["startLine"] = params.get("startLine")
            summary["lineCount"] = params.get("lineCount")
        return summary

    def _result_summary(self, tool, result):
        raw_path = str(result.get("path") or "")
        path_summary = {"pathHash": _summary_hash(raw_path), "pathLength": len(raw_path)}
        if tool == "read":
            return {**path_summary, "lineCount": result.get("lineCount"), "truncated": result.get("truncated"), "redacted": result.get("redacted", 0)}
        key = "matches" if tool in ("grep", "find") else "entries"
        return {**path_summary, "count": len(result.get(key) or []), "truncated": result.get("truncated"), "redacted": result.get("redacted", 0)}
