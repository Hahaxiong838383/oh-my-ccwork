#!/usr/bin/env python3
"""Codex API Wrapper v3 - 将 ChatGPT Pro 订阅通过 Codex CLI 转为 OpenAI 兼容 API
支持同步和流式（SSE）两种输出模式。

部署位置：VPS /opt/codex-api-wrapper.py
依赖：Codex CLI（已 OAuth 登录）、Python 3.12+（零外部依赖）
端口：4001
"""
import http.server
import json
import subprocess
import time
import os

PORT = 4001
WORKSPACE = "/opt/codex-workspace"


def ts():
    return time.strftime("%H:%M:%S")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in ("/v1/chat/completions", "/v1/responses"):
            self._json_response(404, {"error": "unknown: " + self.path})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length))
        messages = body.get("messages", [])
        prompt = (
            messages[-1].get("content", "")
            if messages
            else body.get("input", body.get("prompt", ""))
        )
        model = body.get("model", "gpt-5.4")
        stream = body.get("stream", False)

        if not prompt:
            self._json_response(400, {"error": "no prompt"})
            return

        if stream:
            self._handle_stream(prompt, model)
        else:
            self._handle_sync(prompt, model)

    def _handle_stream(self, prompt, model):
        """SSE 流式输出：通过 codex exec --json 获取 JSONL 事件流"""
        try:
            cmd = ["codex", "--full-auto", "-m", model, "exec", "--json", prompt]
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=WORKSPACE,
                env={**os.environ, "NO_COLOR": "1"},
            )

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            chat_id = "codex-" + str(int(time.time()))
            full_content = ""
            start = time.time()

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type", "")

                if etype == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        text = item.get("text", "")
                        if text:
                            for char in text:
                                chunk = {
                                    "id": chat_id,
                                    "object": "chat.completion.chunk",
                                    "created": int(time.time()),
                                    "model": model,
                                    "choices": [
                                        {
                                            "index": 0,
                                            "delta": {"content": char},
                                            "finish_reason": None,
                                        }
                                    ],
                                }
                                self.wfile.write(
                                    ("data: " + json.dumps(chunk) + "\n\n").encode()
                                )
                                self.wfile.flush()
                            full_content += text

                elif etype == "turn.completed":
                    final_chunk = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "stop"}
                        ],
                    }
                    self.wfile.write(
                        ("data: " + json.dumps(final_chunk) + "\n\n").encode()
                    )
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()

            proc.wait(timeout=300)
            elapsed = time.time() - start
            log_msg = (
                "["
                + ts()
                + "] STREAM "
                + model
                + " | "
                + str(len(prompt))
                + "ch -> "
                + str(len(full_content))
                + "ch | "
                + str(round(elapsed, 1))
                + "s"
            )
            print(log_msg)

        except Exception as e:
            try:
                err = {"error": {"message": str(e), "type": "server_error"}}
                self.wfile.write(("data: " + json.dumps(err) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass

    def _handle_sync(self, prompt, model):
        """同步完整输出"""
        try:
            start = time.time()
            result = subprocess.run(
                ["codex", "--full-auto", "-m", model, "exec", prompt],
                capture_output=True,
                text=True,
                timeout=300,
                cwd=WORKSPACE,
                env={**os.environ, "NO_COLOR": "1"},
            )
            elapsed = time.time() - start
            output = result.stdout.strip() or result.stderr.strip()

            if "ERROR" in output or "not supported" in output:
                self._json_response(400, {"error": output})
                return

            lines = output.split("\n")
            cs, ce = -1, len(lines)
            for i, line in enumerate(lines):
                if line.strip() == "codex":
                    cs = i + 1
                if "tokens used" in line.lower():
                    ce = i
            content = "\n".join(lines[cs:ce]).strip() if cs >= 0 else ""

            if not content:
                skip_prefixes = [
                    "OpenAI",
                    "---",
                    "workdir",
                    "model:",
                    "provider",
                    "approval",
                    "sandbox",
                    "reasoning",
                    "session",
                    "user",
                    "tokens",
                ]
                for line in reversed(lines):
                    s = line.strip()
                    if s and not any(s.startswith(x) for x in skip_prefixes):
                        content = s
                        break

            self._json_response(
                200,
                {
                    "id": "codex-" + str(int(time.time())),
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "total_tokens": 0,
                        "elapsed_seconds": round(elapsed, 2),
                    },
                },
            )
            log_msg = (
                "["
                + ts()
                + "] SYNC "
                + model
                + " | "
                + str(len(prompt))
                + "ch -> "
                + str(len(content))
                + "ch | "
                + str(round(elapsed, 1))
                + "s"
            )
            print(log_msg)

        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "timeout 300s"})
        except Exception as e:
            self._json_response(502, {"error": str(e)})

    def do_GET(self):
        if self.path == "/health":
            try:
                r = subprocess.run(
                    ["codex", "login", "status"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                logged_in = "Logged in" in r.stdout
            except Exception:
                logged_in = False
            srv = (
                subprocess.run(
                    ["systemctl", "is-active", "codex-server"],
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                == "active"
            )
            self._json_response(
                200,
                {
                    "status": "ok",
                    "logged_in": logged_in,
                    "app_server": srv,
                    "models": ["gpt-5.4"],
                    "stream_support": True,
                },
            )
        elif self.path == "/v1/models":
            self._json_response(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": "gpt-5.4", "object": "model", "owned_by": "openai"}
                    ],
                },
            )
        else:
            self._json_response(404, {"error": "unknown: " + self.path})

    def _json_response(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    os.makedirs(WORKSPACE, exist_ok=True)
    if not os.path.exists(os.path.join(WORKSPACE, ".git")):
        subprocess.run(["git", "init"], cwd=WORKSPACE, capture_output=True)
    print("Codex API Wrapper v3 (stream support) on :" + str(PORT))
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
