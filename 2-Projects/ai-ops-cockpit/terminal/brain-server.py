import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8090"))
INTERNAL_TOKEN = os.environ.get("AI_OPS_INTERNAL_TOKEN", "")
MODEL = os.environ.get("AI_OPS_OMP_MODEL", "volcengine-coding/deepseek-v4-pro")
OMP = os.environ.get("AI_OPS_OMP_BIN", "/usr/local/bin/omp-aiops")
EXTENSION = os.environ.get("AI_OPS_READONLY_EXTENSION", "/opt/aiops/extensions/readonly-safe.ts")
WORKDIR = os.environ.get("AI_OPS_BRAIN_CWD", "/workspace/brain/session")
AGENT_DIR = os.environ.get("AI_OPS_BRAIN_AGENT_DIR", "/home/ops/.omp/brain-agent")
MODEL_CONFIG_SOURCE = os.environ.get("AI_OPS_MODEL_CONFIG_SOURCE", "/etc/aiops-models.yml")
MAX_BODY_BYTES = 900 * 1024
MAX_PROMPT_CHARS = 720000
MAX_OUTPUT_CHARS = 120000
WORKFLOW = "readonly_safe"
TASK_LOCK = threading.Lock()
SECRET_PATTERNS = (
    re.compile(r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\b\s*[:=]\s*['\"]?[^\s'\"]{10,}"),
    re.compile(r"https://open\.feishu\.cn/open-apis/bot/v2/hook/[A-Za-z0-9-]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


def sanitize_output(value):
    text = str(value or "")
    if INTERNAL_TOKEN:
        text = text.replace(INTERNAL_TOKEN, "[REDACTED_INTERNAL_TOKEN]")
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED_SECRET]", text)
    return text


def ensure_model_config():
    target = os.path.join(AGENT_DIR, "models.yml")
    os.makedirs(AGENT_DIR, mode=0o700, exist_ok=True)
    os.chmod(AGENT_DIR, 0o700)
    if not os.path.exists(target):
        shutil.copyfile(MODEL_CONFIG_SOURCE, target)
        os.chmod(target, 0o600)


def ensure_workdir():
    os.makedirs(WORKDIR, mode=0o700, exist_ok=True)
    os.chmod(WORKDIR, 0o700)
    stat_result = os.stat(WORKDIR, follow_symlinks=False)
    if stat_result.st_uid != os.geteuid() or stat_result.st_gid != os.getegid():
        raise PermissionError("brain workdir owner mismatch")


def ambient_extension_count():
    count = 0
    for directory in (os.path.join(AGENT_DIR, "extensions"), os.path.join(WORKDIR, ".omp", "extensions")):
        if not os.path.isdir(directory):
            continue
        for _, _, names in os.walk(directory):
            count += sum(name.endswith((".js", ".mjs", ".ts")) for name in names)
    return count


def build_omp_command(prompt_path):
    return [
        OMP,
        "--model", MODEL,
        "--cwd", WORKDIR,
        "--no-session",
        "--no-tools",
        "--no-rules",
        "--no-skills",
        "--no-lsp",
        "--no-pty",
        "--no-title",
        "--extension", EXTENSION,
        "--approval-mode", "yolo",
        "--append-system-prompt", prompt_path,
        "-p", "严格执行追加系统提示中的当前任务；需要核对源码时只使用 aiops_read、aiops_grep、aiops_find、aiops_ls；只输出任务结果。",
    ]


def health_payload():
    direct_workspace = any(os.path.exists(path) for path in (
        "/workspace/readonly",
        "/workspace/projects",
        "/workspace/stacks",
        "/opt/ai-ops-workspaces",
    ))
    docker_socket = os.path.exists("/var/run/docker.sock")
    production_ssh = os.path.exists("/home/ops/.ssh") or any(
        os.path.exists(path)
        for path in (
            "/run/secrets/chenchuan-maintenance",
            "/run/secrets/cpa-jp-maintenance",
            "/run/secrets/iptv-maintenance",
            "/run/secrets/qihang-hk-maintenance",
        )
    )
    extension_count = ambient_extension_count()
    try:
        ensure_workdir()
        workdir_ready = os.access(WORKDIR, os.R_OK | os.W_OK | os.X_OK)
    except OSError:
        workdir_ready = False
    dependencies_ready = bool(INTERNAL_TOKEN) and os.path.isfile(EXTENSION) and os.access(OMP, os.X_OK) and os.path.isfile("/run/secrets/volcengine_coding_api_key")
    return {
        "ok": dependencies_ready and workdir_ready and extension_count == 0 and not direct_workspace and not docker_socket and not production_ssh,
        "component": "ops-brain",
        "model": MODEL,
        "toolMode": "readonly_safe",
        "agentDir": AGENT_DIR,
        "ambientExtensions": extension_count,
        "explicitExtension": EXTENSION,
        "workdir": WORKDIR,
        "workdirReady": workdir_ready,
        "directWorkspace": direct_workspace,
        "dockerSocket": docker_socket,
        "productionSsh": production_ssh,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def run_task(payload):
    if not isinstance(payload, dict):
        return {"ok": False, "error": "invalid_request"}
    prompt = str(payload.get("prompt") or "")
    project = str(payload.get("project") or "").strip()
    task_id = str(payload.get("taskId") or "interactive").strip()
    workflow = str(payload.get("workflow") or "").strip()
    if not prompt or len(prompt) > MAX_PROMPT_CHARS:
        return {"ok": False, "error": "invalid_prompt"}
    if workflow != WORKFLOW:
        return {"ok": False, "error": "invalid_workflow"}
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", project):
        return {"ok": False, "error": "invalid_project"}
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", task_id):
        return {"ok": False, "error": "invalid_task_id"}
    if not TASK_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "brain_busy"}
    started = time.time()
    prompt_path = None
    try:
        ensure_model_config()
        ensure_workdir()
        if ambient_extension_count() != 0:
            return {"ok": False, "error": "ambient_extensions_blocked"}
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", prefix="aiops-brain-prompt-", suffix=".md", dir="/tmp", delete=False) as file:
            file.write(prompt)
            prompt_path = file.name
        os.chmod(prompt_path, 0o600)
        env = os.environ.copy()
        env["HOME"] = "/home/ops"
        env["PI_CODING_AGENT_DIR"] = AGENT_DIR
        env["AI_OPS_BRAIN_TASK_ID"] = task_id
        env["AI_OPS_BRAIN_PROJECT"] = project
        command = build_omp_command(prompt_path)
        result = subprocess.run(command, cwd=WORKDIR, env=env, text=True, capture_output=True, timeout=190, check=False)
        output = sanitize_output((result.stdout or result.stderr or "")[-MAX_OUTPUT_CHARS:])
        return {
            "ok": result.returncode == 0,
            "output": output,
            "exitCode": result.returncode,
            "durationMs": round((time.time() - started) * 1000),
            "toolMode": "readonly_safe",
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "brain_timeout", "durationMs": round((time.time() - started) * 1000)}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "durationMs": round((time.time() - started) * 1000)}
    finally:
        if prompt_path:
            try:
                os.remove(prompt_path)
            except OSError:
                pass
        TASK_LOCK.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "AI-Ops-Brain/1.0"

    def log_message(self, format, *args):
        return

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        supplied = self.headers.get("x-aiops-internal-token", "")
        return bool(INTERNAL_TOKEN) and hmac.compare_digest(supplied, INTERNAL_TOKEN)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, health_payload())
            return
        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/run":
            self._json(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            self._json(403, {"ok": False, "error": "internal_auth_required"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(400, {"ok": False, "error": "invalid_request"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "invalid_json"})
            return
        result = run_task(payload)
        self._json(200 if result.get("ok") else 502, result)


if __name__ == "__main__":
    ensure_model_config()
    ensure_workdir()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
