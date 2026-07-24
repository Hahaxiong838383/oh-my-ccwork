#!/usr/bin/env python3
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("AI_OPS_OMP_BRIDGE_PORT", "18777"))
MODEL = os.environ.get("AI_OPS_OMP_MODEL", "volcengine-coding/deepseek-v4-pro")
TIMEOUT = int(os.environ.get("AI_OPS_OMP_TIMEOUT", "90"))


def cors(handler):
    handler.send_header("Access-Control-Allow-Origin", "https://ops.hahaxiong.top")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "content-type")


def json_response(handler, code, payload):
    body = json.dumps(payload, ensure_ascii=False).encode()
    handler.send_response(code)
    cors(handler)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def run_omp(prompt, question):
    prompt = (prompt or "").strip()
    question = (question or "").strip()
    if not prompt:
        raise ValueError("prompt is empty; page must send /ai/prompt content")
    full_prompt = prompt
    if question:
        full_prompt += "\n\n川哥当前追加问题：\n" + question + "\n"
    cmd = ["/Users/rayman.chen/.bun/bin/omp", "--model", MODEL, "-p", full_prompt]
    result = subprocess.run(
        cmd,
        cwd="/tmp",
        text=True,
        capture_output=True,
        timeout=TIMEOUT,
        env={**os.environ, "NO_COLOR": "1"},
    )
    return {
        "ok": result.returncode == 0,
        "model": MODEL,
        "returncode": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip()[-4000:],
    }


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            json_response(self, 200, {"ok": True, "model": MODEL, "mode": "prompt-from-page"})
        else:
            json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/ask"):
            json_response(self, 404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(body or "{}")
            result = run_omp(str(payload.get("prompt", "")), str(payload.get("question", "")))
            json_response(self, 200 if result["ok"] else 502, result)
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
