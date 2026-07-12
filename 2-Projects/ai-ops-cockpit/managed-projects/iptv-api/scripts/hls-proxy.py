#!/usr/bin/env python3
"""Personal HLS reverse proxy for domestic players via HK jump host.

Optimizations for Televizo / mainland playback:
- stream media segments (pipe), do not buffer whole TS before first byte
- keep-alive connection pool per origin host
- cache usable origin per channel; cache playlists briefly
- prefer lower-bitrate variant on multi-bitrate masters (smoother on weak links)
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import socket
import ssl
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
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
)
FETCH_TIMEOUT = float(os.environ.get("IPTV_PROXY_TIMEOUT", "10"))
CACHE_TTL = float(os.environ.get("IPTV_PROXY_CACHE_TTL", "4"))
ORIGIN_TTL = float(os.environ.get("IPTV_PROXY_ORIGIN_TTL", "300"))
CHUNK = int(os.environ.get("IPTV_PROXY_CHUNK", "65536"))
PREFER_LOW = os.environ.get("IPTV_PROXY_PREFER_LOW", "1") not in {"0", "false", "False"}
SEG_CACHE_MB = int(os.environ.get("IPTV_PROXY_SEG_CACHE_MB", "96"))
SEG_TTL = float(os.environ.get("IPTV_PROXY_SEG_TTL", "20"))
PREFETCH = os.environ.get("IPTV_PROXY_PREFETCH", "1") not in {"0", "false", "False"}

_CONFIG_LOCK = threading.Lock()
_CONFIG = {"token": "", "public_base": "", "channels": {}}
_CONFIG_MTIME = 0.0
_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_ORIGIN_PICK: dict[str, tuple[float, str]] = {}
_ORIGIN_LOCK = threading.Lock()
_POOL_LOCK = threading.Lock()
_POOL: dict[tuple, list] = {}  # (scheme, host, port) -> [conn]
_SEG_CACHE: dict = {}  # url -> {expires, body}
_SEG_ORDER: list = []
_SEG_BYTES = 0
_SEG_LOCK = threading.Lock()


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
        # simple bound
        if len(_CACHE) > 2000:
            _CACHE.clear()
        _CACHE[key] = {"expires": time.time() + ttl, "payload": payload}



def seg_get(url: str):
    now = time.time()
    with _SEG_LOCK:
        item = _SEG_CACHE.get(url)
        if not item:
            return None
        if item["expires"] < now:
            body = item.get("body") or b""
            global _SEG_BYTES
            _SEG_BYTES = max(0, _SEG_BYTES - len(body))
            _SEG_CACHE.pop(url, None)
            if url in _SEG_ORDER:
                _SEG_ORDER.remove(url)
            return None
        # LRU touch
        if url in _SEG_ORDER:
            _SEG_ORDER.remove(url)
        _SEG_ORDER.append(url)
        return item["body"]


def seg_put(url: str, body: bytes, ttl: float = SEG_TTL) -> None:
    if not body or len(body) > 8 * 1024 * 1024:
        return
    global _SEG_BYTES
    max_bytes = SEG_CACHE_MB * 1024 * 1024
    with _SEG_LOCK:
        old = _SEG_CACHE.get(url)
        if old:
            _SEG_BYTES = max(0, _SEG_BYTES - len(old.get("body") or b""))
        while _SEG_BYTES + len(body) > max_bytes and _SEG_ORDER:
            victim = _SEG_ORDER.pop(0)
            v = _SEG_CACHE.pop(victim, None)
            if v:
                _SEG_BYTES = max(0, _SEG_BYTES - len(v.get("body") or b""))
        _SEG_CACHE[url] = {"expires": time.time() + ttl, "body": body}
        if url in _SEG_ORDER:
            _SEG_ORDER.remove(url)
        _SEG_ORDER.append(url)
        _SEG_BYTES += len(body)


def prefetch_urls(urls: list[str]) -> None:
    if not PREFETCH:
        return

    def _one(u: str) -> None:
        try:
            if seg_get(u) is not None:
                return
            status, _, body = fetch_url(u)
            if status == 200 and body:
                seg_put(u, body)
        except Exception:
            pass

    for u in urls[:4]:
        threading.Thread(target=_one, args=(u,), daemon=True).start()



def short_seg_id(url: str) -> str:
    import hashlib
    return hashlib.md5(url.encode("utf-8")).hexdigest()[:20]


_SID_MAP: dict[str, str] = {}
_SID_LOCK = threading.Lock()


def sid_put(url: str) -> str:
    sid = short_seg_id(url)
    with _SID_LOCK:
        _SID_MAP[sid] = url
        # bound map size
        if len(_SID_MAP) > 20000:
            # drop arbitrary half
            for i, k in enumerate(list(_SID_MAP.keys())):
                if i % 2 == 0:
                    _SID_MAP.pop(k, None)
    return sid


def sid_get(sid: str) -> str | None:
    with _SID_LOCK:
        return _SID_MAP.get(sid)


def origin_media_urls_from_playlist(origin: str, body: bytes) -> list[str]:
    text = body.decode("utf-8", errors="replace")
    base = origin.rsplit("/", 1)[0] + "/"
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(urllib.parse.urljoin(base, s))
    return out


def picked_origin_get(channel_id: str) -> str | None:
    with _ORIGIN_LOCK:
        item = _ORIGIN_PICK.get(channel_id)
        if not item:
            return None
        exp, origin = item
        if exp < time.time():
            _ORIGIN_PICK.pop(channel_id, None)
            return None
        return origin


def picked_origin_set(channel_id: str, origin: str) -> None:
    with _ORIGIN_LOCK:
        _ORIGIN_PICK[channel_id] = (time.time() + ORIGIN_TTL, origin)


def _conn_key(parsed: urllib.parse.ParseResult):
    scheme = parsed.scheme or "http"
    host = parsed.hostname or ""
    port = parsed.port or (443 if scheme == "https" else 80)
    return scheme, host, port


def _get_conn(parsed: urllib.parse.ParseResult):
    key = _conn_key(parsed)
    with _POOL_LOCK:
        bucket = _POOL.setdefault(key, [])
        while bucket:
            conn = bucket.pop()
            try:
                conn.sock.getpeername()
                return conn, key
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
    scheme, host, port = key
    timeout = FETCH_TIMEOUT
    if scheme == "https":
        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    return conn, key


def _put_conn(key, conn) -> None:
    try:
        with _POOL_LOCK:
            bucket = _POOL.setdefault(key, [])
            if len(bucket) < 8:
                bucket.append(conn)
                return
        conn.close()
    except Exception:
        pass


def build_headers(url: str, extra: dict | None = None) -> dict:
    req_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Connection": "keep-alive",
    }
    if extra:
        req_headers.update(extra)
    parsed = urllib.parse.urlparse(url)
    if "ifeng.com" in (parsed.netloc or ""):
        req_headers.setdefault("Referer", "https://www.ifeng.com/")
        req_headers.setdefault("Origin", "https://www.ifeng.com")
    return req_headers


def fetch_url(url: str, headers: dict | None = None) -> tuple[int, dict, bytes]:
    """Buffered fetch for small playlists / probes."""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    req_headers = build_headers(url, headers)
    conn = None
    key = None
    try:
        conn, key = _get_conn(parsed)
        conn.request("GET", path, headers=req_headers)
        resp = conn.getresponse()
        body = resp.read()
        status = resp.status
        hdrs = {k: v for k, v in resp.getheaders()}
        _put_conn(key, conn)
        conn = None
        return status, hdrs, body
    except Exception:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        # fallback urllib
        request = urllib.request.Request(url, headers=build_headers(url, headers), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                return response.status, dict(response.headers.items()), response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read() if hasattr(exc, "read") else b""
            return exc.code, dict(exc.headers.items()) if exc.headers else {}, body
        except Exception:
            return 502, {}, b""


def open_upstream(url: str, headers: dict | None = None):
    """Open upstream for streaming. Returns (status, headers_dict, body_file, closer)."""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    req_headers = build_headers(url, headers)
    conn, key = _get_conn(parsed)
    try:
        conn.request("GET", path, headers=req_headers)
        resp = conn.getresponse()
        hdrs = {k: v for k, v in resp.getheaders()}

        def closer(reuse: bool = True) -> None:
            try:
                # drain leftover if needed
                if reuse and resp.isclosed() is False:
                    try:
                        resp.read()
                    except Exception:
                        reuse = False
                if reuse:
                    _put_conn(key, conn)
                else:
                    conn.close()
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass

        return resp.status, hdrs, resp, closer
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        # urllib fallback fully buffered
        request = urllib.request.Request(url, headers=req_headers, method="GET")
        response = urllib.request.urlopen(request, timeout=FETCH_TIMEOUT)
        body = response.read()

        class _Buf:
            def __init__(self, data: bytes):
                self._data = data
                self._i = 0

            def read(self, n: int = -1):
                if n is None or n < 0:
                    chunk = self._data[self._i :]
                    self._i = len(self._data)
                    return chunk
                chunk = self._data[self._i : self._i + n]
                self._i += len(chunk)
                return chunk

        return response.status, dict(response.headers.items()), _Buf(body), (lambda reuse=True: None)


def is_playlist(url: str, content_type: str, body: bytes) -> bool:
    lower = (content_type or "").lower()
    if "mpegurl" in lower or "m3u8" in lower or "application/vnd.apple" in lower:
        return True
    if url.split("?", 1)[0].endswith((".m3u8", ".m3u")):
        return True
    head = body[:64].lstrip()
    return head.startswith(b"#EXTM3U")


def looks_like_media_url(url: str) -> bool:
    path = url.split("?", 1)[0].lower()
    return path.endswith((".ts", ".m4s", ".mp4", ".aac", ".vtt", ".jpg", ".jpeg", ".png"))


def channel_origins(entry) -> list[str]:
    if isinstance(entry, list):
        return [str(x) for x in entry if str(x).startswith(("http://", "https://"))]
    if isinstance(entry, dict):
        vals = entry.get("origins") or entry.get("urls") or []
        if entry.get("url"):
            vals = [entry["url"]] + list(vals)
        return [str(x) for x in vals if str(x).startswith(("http://", "https://"))]
    if isinstance(entry, str) and entry.startswith(("http://", "https://")):
        return [entry]
    return []


def master_variants_ok(origin: str, body: bytes) -> bool:
    text = body.decode("utf-8", errors="replace")
    if "#EXT-X-STREAM-INF" not in text:
        for line in text.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                return True
        return False
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        nested = urllib.parse.urljoin(origin, s)
        status, _, nested_body = fetch_url(nested)
        if status == 200 and len(nested_body) > 20:
            return True
    return False


def pick_low_bitrate_master(origin: str, body: bytes) -> bytes | None:
    """Collapse multi-bitrate master to a single lower-bandwidth variant."""
    if not PREFER_LOW:
        return None
    text = body.decode("utf-8", errors="replace")
    if "#EXT-X-STREAM-INF" not in text:
        return None
    lines = text.splitlines()
    variants = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF"):
            bw = 10**12
            m = re.search(r"BANDWIDTH=(\d+)", line)
            if m:
                bw = int(m.group(1))
            # next non-empty non-tag is URI
            j = i + 1
            uri = ""
            while j < len(lines):
                s = lines[j].strip()
                if not s:
                    j += 1
                    continue
                if s.startswith("#"):
                    break
                uri = s
                break
            if uri:
                variants.append((bw, line, uri))
            i = j + 1
            continue
        i += 1
    if len(variants) < 2:
        return None
    variants.sort(key=lambda x: x[0])
    # pick lowest that works; skip tiny/zero resolution placeholders when possible
    for bw, inf, uri in variants:
        abs_url = urllib.parse.urljoin(origin, uri)
        status, _, nested = fetch_url(abs_url)
        if status == 200 and len(nested) > 20:
            # return a media playlist redirect style: single-variant master
            out = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                inf,
                uri,
            ]
            return ("\n".join(out) + "\n").encode("utf-8")
    return None


def fetch_usable_origin(origins: list[str], channel_id: str | None = None):
    ordered = list(origins)
    if channel_id:
        pref = picked_origin_get(channel_id)
        if pref and pref in ordered:
            ordered = [pref] + [x for x in ordered if x != pref]
    last = (502, {}, b"upstream error\n")
    for origin in ordered:
        status, headers, body = fetch_url(origin)
        last = (status, headers, body)
        if status != 200 or not body:
            continue
        ctype = headers.get("Content-Type") or headers.get("content-type") or ""
        if is_playlist(origin, ctype, body):
            if not master_variants_ok(origin, body):
                continue
            low = pick_low_bitrate_master(origin, body)
            if low is not None:
                body = low
            if channel_id:
                picked_origin_set(channel_id, origin)
            return origin, status, headers, body
        if len(body) > 20:
            if channel_id:
                picked_origin_set(channel_id, origin)
            return origin, status, headers, body
    return None, last[0], last[1], last[2]


def rewrite_playlist(body: bytes, channel_id: str, token: str, public_base: str, base_url: str) -> bytes:
    text = body.decode("utf-8", errors="replace")
    # fix invalid double-hash tags from some origins (breaks Televizo etc.)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"^##+(EXT)", r"#\1", text, flags=re.M)
    lines = text.splitlines()
    out = []
    base = base_url.rsplit("/", 1)[0] + "/"
    pb = public_base.rstrip("/")
    for line in lines:
        raw = line.strip()
        if not raw:
            continue
        if raw.startswith("#"):
            if 'URI="' in line:
                def repl(match: re.Match) -> str:
                    uri = match.group(1)
                    abs_url = urllib.parse.urljoin(base, uri)
                    # nested playlist keeps .m3u8 suffix; media uses .ts
                    if abs_url.split("?", 1)[0].endswith((".m3u8", ".m3u")):
                        sid = sid_put(abs_url)
                        return f'URI="{pb}/{token}/{channel_id}/p/{sid}.m3u8"'
                    sid = sid_put(abs_url)
                    return f'URI="{pb}/{token}/{channel_id}/s/{sid}.ts"'
                line = re.sub(r'URI="([^"]+)"', repl, line)
                line = re.sub(r"^##+(EXT)", r"#\1", line)
            else:
                line = re.sub(r"^##+(EXT)", r"#\1", raw)
            out.append(line)
            continue
        abs_url = urllib.parse.urljoin(base, raw)
        sid = sid_put(abs_url)
        if abs_url.split("?", 1)[0].endswith((".m3u8", ".m3u")):
            out.append(f"{pb}/{token}/{channel_id}/p/{sid}.m3u8")
        else:
            out.append(f"{pb}/{token}/{channel_id}/s/{sid}.ts")
    return ("\n".join(out) + "\n").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "iptv-hls-proxy/1.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        msg = fmt % args
        msg = re.sub(r"/[A-Za-z0-9_\-]{16,}/", "/<token>/", msg)
        msg = re.sub(r"/u/[A-Za-z0-9_\-=]+", "/u/<id>", msg)
        print(f"[hls-proxy] {msg}")

    def _send_bytes(self, status: int, headers: dict, body: bytes) -> None:
        self.send_response(status)
        for key, value in headers.items():
            if key.lower() in {"transfer-encoding", "connection", "content-length", "content-encoding"}:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", headers.get("Cache-Control", "private, max-age=2"))
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _stream_upstream(self, status: int, headers: dict, body_file, closer) -> None:
        self.send_response(status if 100 <= status < 600 else 502)
        content_type = headers.get("Content-Type") or headers.get("content-type") or "application/octet-stream"
        content_length = headers.get("Content-Length") or headers.get("content-length")
        self.send_header("Content-Type", content_type)
        if content_length and str(content_length).isdigit():
            self.send_header("Content-Length", str(content_length))
        else:
            self.send_header("Transfer-Encoding", "chunked")
            content_length = None
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "private, max-age=3")
        self.send_header("X-IPTV-Proxy", "media-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        if self.command == "HEAD":
            closer(True)
            return
        try:
            if content_length is not None:
                remaining = int(content_length)
                while remaining > 0:
                    chunk = body_file.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            else:
                while True:
                    chunk = body_file.read(CHUNK)
                    if not chunk:
                        break
                    # chunked
                    self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            closer(True)
        except Exception:
            closer(False)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET(head_only=True)

    def do_GET(self, head_only: bool = False) -> None:  # noqa: N802
        cfg = load_config()
        token = str(cfg.get("token") or "")
        public_base = str(cfg.get("public_base") or "")
        channels = cfg.get("channels") or {}

        parsed = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split("/") if p]
        if len(parts) < 3:
            self._send_bytes(404, {"Content-Type": "text/plain"}, b"not found\n")
            return
        req_token, channel_id, rest0 = parts[0], parts[1], parts[2]
        if not token or req_token != token:
            self._send_bytes(403, {"Content-Type": "text/plain"}, b"forbidden\n")
            return
        if channel_id not in channels:
            self._send_bytes(404, {"Content-Type": "text/plain"}, b"unknown channel\n")
            return


        # short media: /{token}/{channel}/s/{sid}.ts
        if rest0 == "s" and len(parts) >= 4:
            sid = parts[3]
            if sid.endswith(".ts"):
                sid = sid[:-3]
            origin = sid_get(sid)
            if not origin:
                self._send_bytes(404, {"Content-Type": "text/plain"}, b"unknown segment\n")
                return
            cached_body = seg_get(origin)
            if cached_body is not None:
                self._send_bytes(200, {"Content-Type": "video/mp2t", "Cache-Control": "private, max-age=5", "X-IPTV-Proxy": "media-cache"}, cached_body if not head_only else b"")
                return
            status, headers, body = fetch_url(origin)
            if status != 200 or not body:
                self._send_bytes(status if status >= 400 else 502, {"Content-Type": "text/plain"}, b"upstream error\n")
                return
            seg_put(origin, body)
            ctype = headers.get("Content-Type") or headers.get("content-type") or "video/mp2t"
            self._send_bytes(200, {"Content-Type": "video/mp2t", "Cache-Control": "private, max-age=5", "X-IPTV-Proxy": "media-buffered"}, body if not head_only else b"")
            return

        # short nested playlist: /{token}/{channel}/p/{sid}.m3u8
        if rest0 == "p" and len(parts) >= 4:
            sid = parts[3]
            if sid.endswith(".m3u8"):
                sid = sid[:-5]
            origin = sid_get(sid)
            if not origin:
                self._send_bytes(404, {"Content-Type": "text/plain"}, b"unknown playlist\n")
                return
            status, headers, body = fetch_url(origin)
            if status != 200 or not body:
                self._send_bytes(status if status >= 400 else 502, {"Content-Type": "text/plain"}, b"upstream error\n")
                return
            try:
                prefetch_urls(origin_media_urls_from_playlist(origin, body))
            except Exception:
                pass
            body = rewrite_playlist(body, channel_id, token, public_base, origin)
            self._send_bytes(200, {"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "private, max-age=2", "X-IPTV-Proxy": "playlist"}, body if not head_only else b"")
            return


        # legacy base64 media path
        if rest0 == "u" and len(parts) >= 4:
            try:
                origin = b64url_decode(parts[3])
            except Exception:
                self._send_bytes(400, {"Content-Type": "text/plain"}, b"bad url id\n")
                return
            if not origin.startswith(("http://", "https://")):
                self._send_bytes(400, {"Content-Type": "text/plain"}, b"bad scheme\n")
                return

            # hot segment cache (reduces CN rebuffer stalls)
            if looks_like_media_url(origin) or origin.endswith(".ts") or "live_" in origin:
                cached_body = seg_get(origin)
                if cached_body is not None:
                    self._send_bytes(
                        200,
                        {
                            "Content-Type": "video/mp2t",
                            "Cache-Control": "private, max-age=5",
                            "X-IPTV-Proxy": "media-cache",
                        },
                        cached_body if not head_only else b"",
                    )
                    return
                # fetch full segment (typical 5s TS is small), cache, then send
                status, headers, body = fetch_url(origin)
                if status == 200 and body:
                    seg_put(origin, body)
                    ctype = headers.get("Content-Type") or headers.get("content-type") or "video/mp2t"
                    self._send_bytes(
                        200,
                        {
                            "Content-Type": ctype,
                            "Cache-Control": "private, max-age=5",
                            "X-IPTV-Proxy": "media-buffered",
                        },
                        body if not head_only else b"",
                    )
                    return

            # playlists under /u/ still small — buffer+rewrite; media stream
            if not looks_like_media_url(origin) and (
                origin.endswith(".m3u8") or origin.endswith(".m3u") or "m3u8" in origin
            ):
                status, headers, body = fetch_url(origin)
                if status >= 400 or not body:
                    self._send_bytes(status if status >= 400 else 502, {"Content-Type": "text/plain"}, b"upstream error\n")
                    return
                ctype = headers.get("Content-Type") or headers.get("content-type") or ""
                if is_playlist(origin, ctype, body):
                    body = rewrite_playlist(body, channel_id, token, public_base, origin)
                    self._send_bytes(
                        200,
                        {
                            "Content-Type": "application/vnd.apple.mpegurl",
                            "Cache-Control": "private, max-age=2",
                            "X-IPTV-Proxy": "playlist",
                        },
                        body,
                    )
                    return
                # fallthrough stream rare

            if head_only:
                status, headers, body_file, closer = open_upstream(origin)
                try:
                    self.send_response(status)
                    self.send_header(
                        "Content-Type",
                        headers.get("Content-Type") or headers.get("content-type") or "application/octet-stream",
                    )
                    if headers.get("Content-Length") or headers.get("content-length"):
                        self.send_header(
                            "Content-Length",
                            str(headers.get("Content-Length") or headers.get("content-length")),
                        )
                    self.end_headers()
                finally:
                    closer(False)
                return

            status, headers, body_file, closer = open_upstream(origin)
            if status >= 400:
                closer(False)
                self._send_bytes(status, {"Content-Type": "text/plain"}, b"upstream error\n")
                return
            self._stream_upstream(status, headers, body_file, closer)
            return

        if rest0 not in {"master.m3u8", "index.m3u8", "playlist.m3u8"}:
            self._send_bytes(404, {"Content-Type": "text/plain"}, b"not found\n")
            return

        origins = channel_origins(channels[channel_id])
        if not origins:
            self._send_bytes(404, {"Content-Type": "text/plain"}, b"no origin\n")
            return
        cache_key = "master:" + channel_id
        cached = cache_get(cache_key)
        if cached:
            origin, status, headers, body = (
                cached["origin"],
                cached["status"],
                cached["headers"],
                cached["body"],
            )
        else:
            origin, status, headers, body = fetch_usable_origin(origins, channel_id=channel_id)
            if origin and status == 200 and body:
                cache_set(
                    cache_key,
                    {"origin": origin, "status": status, "headers": headers, "body": body},
                    ttl=CACHE_TTL,
                )

        if not origin or status >= 400 or not body:
            self._send_bytes(status if status and status >= 400 else 502, {"Content-Type": "text/plain"}, b"upstream error\n")
            return

        content_type = headers.get("Content-Type") or headers.get("content-type") or "application/octet-stream"
        if is_playlist(origin, content_type, body):
            # prefetch upcoming segments into HK memory before player asks
            try:
                prefetch_urls(origin_media_urls_from_playlist(origin, body))
            except Exception:
                pass
            body = rewrite_playlist(body, channel_id, token, public_base, origin)
            self._send_bytes(
                200,
                {
                    "Content-Type": "application/vnd.apple.mpegurl",
                    "Cache-Control": "private, max-age=2",
                    "X-IPTV-Proxy": "playlist",
                    "X-IPTV-Origin-Host": urllib.parse.urlparse(origin).netloc,
                },
                body if not head_only else b"",
            )
            return
        self._send_bytes(
            200,
            {"Content-Type": content_type, "X-IPTV-Proxy": "media"},
            body if not head_only else b"",
        )


def main() -> None:
    load_config(force=True)
    socket.setdefaulttimeout(FETCH_TIMEOUT)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.daemon_threads = True
    server.allow_reuse_address = True
    print(
        f"[hls-proxy] listening on {LISTEN_HOST}:{LISTEN_PORT} "
        f"prefer_low={PREFER_LOW} chunk={CHUNK} config={CONFIG_PATH}"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
