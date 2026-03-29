#!/usr/bin/env python3
"""Codex API Wrapper v4 - WebSocket 连接 app-server，零冷启动
通过常驻的 codex app-server (ws://127.0.0.1:4002) 发送请求，
跳过 codex exec 的冷启动开销。

部署位置：VPS /opt/codex-api-wrapper.py
依赖：websockets、Codex CLI app-server 常驻运行
端口：4001
"""
import asyncio
import json
import os
import time
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import threading

PORT = 4001
WS_URL = "ws://127.0.0.1:4002"
WORKSPACE = "/opt/codex-workspace"

# 全局事件循环（在单独线程中运行）
_loop = None
_loop_thread = None


def get_loop():
    global _loop, _loop_thread
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
        _loop_thread = threading.Thread(target=_loop.run_forever, daemon=True)
        _loop_thread.start()
    return _loop


def ts():
    return time.strftime("%H:%M:%S")


async def ask_codex_ws(prompt, model="gpt-5.4", timeout=30):
    """通过 WebSocket 向 app-server 发送请求并获取回复"""
    import websockets

    async with websockets.connect(WS_URL) as ws:
        req_id = 0

        # 1. Initialize
        req_id += 1
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "codex-api-wrapper", "version": "4.0"},
                "capabilities": None,
            },
        }))
        # 等 initialize 响应
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == req_id:
                break

        # 2. Start thread
        req_id += 1
        thread_id = str(uuid.uuid4())
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "thread/start",
            "params": {
                "approvalPolicy": "never",
                "cwd": WORKSPACE,
                "baseInstructions": "You are a helpful AI assistant. Reply directly with text. Do NOT run shell commands unless explicitly asked.",
            },
        }))
        # 等 thread/start 响应，拿到真正的 threadId
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == req_id:
                result = msg.get("result", {})
                thread_id = result.get("thread", {}).get("id", thread_id)
                break

        # 3. Start turn（发送用户消息）
        req_id += 1
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
                "approvalPolicy": "never",
            },
        }))

        # 4. 收集回复
        content_parts = []
        start = time.time()
        deadline = start + timeout

        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                msg = json.loads(raw)
            except asyncio.TimeoutError:
                break

            method = msg.get("method", "")
            params = msg.get("params", {})

            # 完成的 agent_message
            if "item/completed" in method:
                item = params.get("item", {})
                if item.get("type") in ("agent_message", "agentMessage"):
                    text = item.get("text", "")
                    if text:
                        content_parts.append(text)

            # turn 结束
            if "turn/completed" in method:
                break

            # 处理 approval 请求（自动批准）
            if msg.get("method", "").endswith("Approval"):
                await ws.send(json.dumps({
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "result": {"approved": True},
                }))

        elapsed = time.time() - start
        content = "\n".join(content_parts).strip()
        return content, elapsed


async def ask_codex_ws_stream(prompt, model="gpt-5.4", timeout=30):
    """流式版：yield (type, data) 元组"""
    import websockets

    async with websockets.connect(WS_URL) as ws:
        req_id = 0

        # Initialize
        req_id += 1
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": req_id,
            "method": "initialize",
            "params": {"clientInfo": {"name": "codex-api-wrapper", "version": "4.0"}, "capabilities": None},
        }))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == req_id:
                break

        # Start thread
        req_id += 1
        thread_id = str(uuid.uuid4())
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": req_id,
            "method": "thread/start",
            "params": {
                "approvalPolicy": "never",
                "cwd": WORKSPACE,
                "baseInstructions": "You are a helpful AI assistant. Reply directly with text. Do NOT run shell commands unless explicitly asked.",
            },
        }))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == req_id:
                thread_id = msg.get("result", {}).get("threadId", thread_id)
                break

        # Start turn
        req_id += 1
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": req_id,
            "method": "turn/start",
            "params": {"threadId": thread_id, "input": [{"type": "text", "text": prompt}], "approvalPolicy": "never"},
        }))

        # Stream responses
        start = time.time()
        deadline = start + timeout

        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                msg = json.loads(raw)
            except asyncio.TimeoutError:
                break

            method = msg.get("method", "")
            params = msg.get("params", {})

            if "item/completed" in method:
                item = params.get("item", {})
                if item.get("type") in ("agent_message", "agentMessage"):
                    text = item.get("text", "")
                    if text:
                        yield ("content", text)

            if "turn/completed" in method:
                yield ("done", None)
                break

            if msg.get("method", "").endswith("Approval"):
                await ws.send(json.dumps({
                    "jsonrpc": "2.0", "id": msg.get("id"),
                    "result": {"approved": True},
                }))


def run_async(coro):
    """在全局事件循环中运行协程"""
    loop = get_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)


class Handler(BaseHTTPRequestHandler):
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

    def _handle_sync(self, prompt, model):
        try:
            content, elapsed = run_async(ask_codex_ws(prompt, model))
            self._json_response(200, {
                "id": "codex-" + str(int(time.time())),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"total_tokens": 0, "elapsed_seconds": round(elapsed, 2)},
            })
            print("[" + ts() + "] WS-SYNC " + model + " | " + str(len(prompt)) + "ch -> " + str(len(content)) + "ch | " + str(round(elapsed, 1)) + "s")
        except Exception as e:
            print("[" + ts() + "] WS-ERROR: " + str(e))
            # fallback 到 exec 模式
            self._handle_sync_exec(prompt, model)

    def _handle_sync_exec(self, prompt, model):
        """Fallback: 用 codex exec"""
        import subprocess
        try:
            start = time.time()
            wrapped = "You are a helpful AI assistant. Reply directly with text only. Do NOT run any shell commands. Do NOT execute any code. Just answer the question directly.\n\nUser: " + prompt
            result = subprocess.run(
                ["codex", "--full-auto", "-m", model, "exec", wrapped],
                capture_output=True, text=True, timeout=30,
                cwd=WORKSPACE, env={**os.environ, "NO_COLOR": "1"},
            )
            elapsed = time.time() - start
            output = result.stdout.strip() or result.stderr.strip()
            lines = output.split("\n")
            cs, ce = -1, len(lines)
            for i, line in enumerate(lines):
                if line.strip() == "codex":
                    cs = i + 1
                if "tokens used" in line.lower():
                    ce = i
            content = "\n".join(lines[cs:ce]).strip() if cs >= 0 else output
            self._json_response(200, {
                "id": "codex-" + str(int(time.time())),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"total_tokens": 0, "elapsed_seconds": round(elapsed, 2)},
            })
            print("[" + ts() + "] EXEC-FALLBACK " + model + " | " + str(round(elapsed, 1)) + "s")
        except Exception as e:
            self._json_response(502, {"error": str(e)})

    def _handle_stream(self, prompt, model):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            chat_id = "codex-" + str(int(time.time()))
            full_content = ""
            start = time.time()

            async def _stream():
                nonlocal full_content
                async for etype, data in ask_codex_ws_stream(prompt, model):
                    if etype == "content":
                        for char in data:
                            chunk = {
                                "id": chat_id,
                                "object": "chat.completion.chunk",
                                "created": int(time.time()),
                                "model": model,
                                "choices": [{"index": 0, "delta": {"content": char}, "finish_reason": None}],
                            }
                            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                            self.wfile.flush()
                        full_content += data
                    elif etype == "done":
                        final = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        }
                        self.wfile.write(("data: " + json.dumps(final) + "\n\n").encode())
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()

            run_async(_stream())
            elapsed = time.time() - start
            print("[" + ts() + "] WS-STREAM " + model + " | " + str(len(prompt)) + "ch -> " + str(len(full_content)) + "ch | " + str(round(elapsed, 1)) + "s")
        except Exception as e:
            try:
                err = {"error": {"message": str(e), "type": "server_error"}}
                self.wfile.write(("data: " + json.dumps(err) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass

    def do_GET(self):
        if self.path == "/health":
            logged_in = os.path.exists(os.path.expanduser("~/.codex/auth.json"))
            srv = os.path.exists("/etc/systemd/system/codex-server.service")
            self._json_response(200, {
                "status": "ok",
                "logged_in": logged_in,
                "app_server": srv,
                "mode": "websocket",
                "models": ["gpt-5.4"],
                "stream_support": True,
            })
        elif self.path == "/v1/models":
            self._json_response(200, {
                "object": "list",
                "data": [{"id": "gpt-5.4", "object": "model", "owned_by": "openai"}],
            })
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
        import subprocess
        subprocess.run(["git", "init"], cwd=WORKSPACE, capture_output=True)
    get_loop()  # 启动全局事件循环
    print("Codex API Wrapper v4 (WebSocket mode) on :" + str(PORT))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
