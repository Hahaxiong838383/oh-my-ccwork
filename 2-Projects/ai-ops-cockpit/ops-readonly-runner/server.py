import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from policy import ToolPolicyGate


HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8091"))
INTERNAL_TOKEN = os.environ.get("AI_OPS_INTERNAL_TOKEN", "")
READONLY_ROOT = os.environ.get("READONLY_ROOT", "/workspace/readonly")
AUDIT_DIR = os.environ.get("AUDIT_DIR", "/var/lib/aiops-tool-runner/audit")
PROJECTS = [item.strip() for item in os.environ.get("AI_OPS_READONLY_PROJECTS", "").split(",") if item.strip()]
MAX_BODY_BYTES = 128 * 1024

GATE = ToolPolicyGate(READONLY_ROOT, PROJECTS, AUDIT_DIR)


class Handler(BaseHTTPRequestHandler):
    server_version = "AI-Ops-Readonly-Runner/1.0"

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
            self._json(200, GATE.health())
            return
        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/tool":
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
        result = GATE.execute(payload)
        self._json(200 if result.get("ok") else 403, result)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
