#!/usr/bin/env python3
"""Personal HLS reverse proxy for domestic players via HK jump host.

Player (CN) -> https://kidshub-ai.../iptv-proxy/<token>/<channel>/... -> origin
Rewrites m3u8 absolute/relative URLs so media segments also pass through HK.
Secrets/token stay on the server; never log full origin query strings.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("IPTV_ROOT", "/opt/stacks/iptv-api")
CONFIG_PATH = os.environ.get("IPTV_PROXY_CONFIG", os.path.join(ROOT, "proxy/config.json"))
LISTEN_HOST = os.environ.get("IPTV_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("IPTV_PROXY_PORT", "15181"))
USER_AGENT = os.environ.get(
    "IPTV_PROXY_UA",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
)
FETCH_TIMEOUT = float(os.environ.get("IPTV_PROXY_TIMEOUT", "12"))
CACHE_TTL = float(os.environ.get("IPTV_PROXY_CACHE_TTL", "3"))

_CONFIG_LOCK = threading.Lock()
_CONFIG = {"token": "", "public_base": "", "channels": {}}
_CONFIG_MTIME = 0.0
_CACHE = {}
_CACHE_LOCK = threading.Lock()


def b64url_encode(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> str:
    pad = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad).decode("utf-8")


def load_config(force: bool = False) -> dict:
    global _CONFIG, _CONFIG_MTIME
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        return _CONFIG
    with _CONFIG_LOCK:
        if force or mtime != _CONFIG_MTIME:
            with open(CONFIG_PATH, encoding="utf-8") as handle:
                _CONFIG = json.load(handle)
            _CONFIG_MTIME = mtime
        return _CONFIG


def cache_get(key: str):
    now = time.time()
    with _CACHE_LOCK:
        item = _CACHE.get(key)
        if not item:
            return None
        if item["expires"] < now:
            _CACHE.pop(key, None)
            return None
        return item["payload"]


def cache_set(key: str, payload: dict, ttl: float = CACHE_TTL) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = {"expires": time.time() + ttl, "payload": payload}


def fetch_url(url: str, headers: dict | None = None) -> tuple[int, dict, bytes]:
    req_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Connection": "close",
    }
    if headers:
        req_headers.update(headers)
    # Prefer Referer for some CDNs (ifeng, etc.)
    parsed = urllib.parse.urlparse(url)
    if "ifeng.com" in parsed.netloc:
        req_headers.setdefault("Referer", "https://www.ifeng.com/")
        req_headers.setdefault("Origin", "https://www.ifeng.com")
    request = urllib.request.Request(url, headers=req_headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            body = response.read()
            return response.status, dict(response.headers.items()), body
    except urllib.error.HTTPError as exc:
        body = exc.read() if hasattr(exc, "read") else b""
        return exc.code, dict(exc.headers.items()) if exc.headers else {}, body


def is_playlist(url: str, content_type: str, body: bytes) -> bool:
    lower = (content_type or "").lower()
    if "mpegurl" in lower or "m3u8" in lower or "application/vnd.apple" in lower:
        return True
    if url.split("?", 1)[0].endswith((".m3u8", ".m3u")):
        return True
    head = body[:64].lstrip()
    return head.startswith(b"#EXTM3U")


def rewrite_playlist(body: bytes, channel_id: str, token: str, public_base: str, base_url: str) -> bytes:
    text = body.decode("utf-8", errors="replace")
    lines = text.splitlines()
    out = []
    base = base_url.rsplit("/", 1)[0] + "/"
    for line in lines:
        raw = line.strip()
        if not raw or raw.startswith("#"):
            # Keep tags, but rewrite URI="..." inside tags if present
            if "URI=\"" in line:
                def repl(match: re.Match) -> str:
                    uri = match.group(1)
                    abs_url = urllib.parse.urljoin(base, uri)
                    proxied = f"{public_base.rstrip('/')}/{token}/{channel_id}/u/{b64url_encode(abs_url)}"
                    return f'URI="{proxied}"'

                line = re.sub(r'URI="([^"]+)"', repl, line)
            out.append(line)
            continue
        abs_url = urllib.parse.urljoin(base, raw)
        proxied = f"{public_base.rstrip('/')}/{token}/{channel_id}/u/{b64url_encode(abs_url)}"
        out.append(proxied)
    return ("\n".join(out) + "\n").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "iptv-hls-proxy/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # Avoid logging query strings / tokens in full
        sys_stderr = getattr(self, "log_error", None)
        msg = fmt % args
        msg = re.sub(r"/iptv-proxy/[^/]+/", "/iptv-proxy/<token>/", msg)
        msg = re.sub(r"/u/[A-Za-z0-9_\-=]+", "/u/<id>", msg)
        print(f"[hls-proxy] {self.address_string()} {msg}")

    def _send(self, status: int, headers: dict, body: bytes) -> None:
        self.send_response(status)
        for key, value in headers.items():
            if key.lower() in {"transfer-encoding", "connection", "content-length"}:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET(head_only=True)

    def do_GET(self, head_only: bool = False) -> None:  # noqa: N802
        cfg = load_config()
        token = str(cfg.get("token") or "")
        public_base = str(cfg.get("public_base") or "")
        channels = cfg.get("channels") or {}

        parsed = urllib.parse.urlparse(self.path)
        # unquote path segments (%xx for safety)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split("/") if p]
        # Expected: /{token}/{channel}/master.m3u8
        # or       /{token}/{channel}/u/{b64}
        if len(parts) < 3:
            self._send(404, {"Content-Type": "text/plain"}, b"not found\n")
            return
        req_token, channel_id, rest0 = parts[0], parts[1], parts[2]
        if not token or req_token != token:
            self._send(403, {"Content-Type": "text/plain"}, b"forbidden\n")
            return
        if channel_id not in channels:
            self._send(404, {"Content-Type": "text/plain"}, b"unknown channel\n")
            return

        if rest0 == "u" and len(parts) >= 4:
            try:
                origin = b64url_decode(parts[3])
            except Exception:
                self._send(400, {"Content-Type": "text/plain"}, b"bad url id\n")
                return
            if not origin.startswith(("http://", "https://")):
                self._send(400, {"Content-Type": "text/plain"}, b"bad scheme\n")
                return
        elif rest0 in {"master.m3u8", "index.m3u8", "playlist.m3u8"}:
            origin = channels[channel_id]
        else:
            self._send(404, {"Content-Type": "text/plain"}, b"not found\n")
            return

        cache_key = origin
        cached = cache_get(cache_key)
        if cached:
            status, headers, body = cached["status"], cached["headers"], cached["body"]
        else:
            status, headers, body = fetch_url(origin)
            # only cache successful small playlist-ish responses briefly
            if status == 200 and len(body) < 2_000_000:
                cache_set(cache_key, {"status": status, "headers": headers, "body": body})

        if status >= 400:
            self._send(status, {"Content-Type": "text/plain"}, b"upstream error\n")
            return

        content_type = headers.get("Content-Type") or headers.get("content-type") or "application/octet-stream"
        if is_playlist(origin, content_type, body):
            body = rewrite_playlist(body, channel_id, token, public_base, origin)
            content_type = "application/vnd.apple.mpegurl"
            out_headers = {
                "Content-Type": content_type,
                "X-IPTV-Proxy": "playlist",
            }
        else:
            out_headers = {
                "Content-Type": content_type,
                "X-IPTV-Proxy": "media",
            }
        if head_only:
            body = b""
        self._send(200, out_headers, body)


def main() -> None:
    load_config(force=True)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"[hls-proxy] listening on {LISTEN_HOST}:{LISTEN_PORT} config={CONFIG_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
