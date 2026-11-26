#!/usr/bin/env python3
"""小可夜航 (night) OTA + 设备诊断后端。

单进程、纯标准库。两个职责：
  1. 静态 artifact：GET /mobile/night/latest.json 与 /mobile/night/xiaoke-night-<versionCode>.apk
  2. 技术事件：    POST /mobile/night/diagnostics（Bearer 设备凭据 → SHA256 允许表）

设计红线（与部署文档一致）：
  * 只收白名单 13 类技术事件，字段严格三件套 (id, kind, ts) + versionCode，多余字段直接拒。
  * 不存密钥、不存原话、不存 Authorization、不存请求体原文。
  * 幂等键 (device, id)：同一批次重放不会多记一行。
  * latest.json 一律由磁盘上真实存在的 APK 字节算出（sha256/size/versionCode），
    磁盘上没有匹配的 APK 就是 404，不存在“手写 manifest”。
"""

from __future__ import annotations

import errno
import hashlib
import hmac
import json
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

SCHEMA_VERSION = 1
CHANNEL = "night"
KINDS = (
    "call_start",
    "connected",
    "mic_on",
    "mic_off",
    "rx_audio",
    "rx_caption",
    "tx_caption",
    "spoken_interrupt",
    "cancel_ack",
    "transport_error",
    "call_end",
    "paired",
    "ota_check",
)
KIND_SET = frozenset(KINDS)

BASE_PATH = "/mobile/night"
MANIFEST_NAME = "latest.json"
APK_RE = re.compile(r"^xiaoke-night-(?P<vc>[1-9][0-9]{0,9})\.apk$")
DEVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
EVENT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

MAX_BODY_BYTES = 64 * 1024
MAX_EVENTS = 200
CLOCK_SKEW_FUTURE = 300          # 允许客户端时钟快 5 分钟
MAX_EVENT_AGE = 45 * 24 * 3600   # 超过 45 天的事件视为异常时间戳
RATE_LIMIT_PER_MIN = 60
RATE_BURST = 20
APK_CHUNK = 256 * 1024

APK_MIME = "application/vnd.android.package-archive"


def log(msg: str, **kv) -> None:
    parts = [time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg]
    for k, v in kv.items():
        parts.append(f"{k}={v}")
    sys.stdout.write(" ".join(parts) + "\n")
    sys.stdout.flush()


def env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


class Config:
    def __init__(self) -> None:
        self.listen = env_str("NIGHT_LISTEN", "127.0.0.1:18786")
        self.publish_dir = os.path.realpath(env_str("NIGHT_PUBLISH_DIR", "/srv/night/publish"))
        self.data_dir = os.path.realpath(env_str("NIGHT_DATA_DIR", "/srv/night/data"))
        self.db_path = env_str("NIGHT_DB", os.path.join(self.data_dir, "diagnostics.sqlite3"))
        self.allowlist_path = os.path.realpath(
            env_str("NIGHT_ALLOWLIST", "/srv/night/private/allowlist.json")
        )
        self.retention_days = env_int("NIGHT_RETENTION_DAYS", 45)
        self.max_rows = env_int("NIGHT_MAX_ROWS", 500_000)
        self.prune_interval = env_int("NIGHT_PRUNE_INTERVAL", 600)
        self.access_log = env_str("NIGHT_ACCESS_LOG", "1") == "1"
        self.rate_per_min = env_int("NIGHT_RATE_LIMIT_PER_MIN", RATE_LIMIT_PER_MIN)
        self.rate_burst = env_int("NIGHT_RATE_BURST", RATE_BURST)
        host, _, port = self.listen.rpartition(":")
        self.host = host or "127.0.0.1"
        self.port = int(port)


# ---------------------------------------------------------------- allowlist


class Allowlist:
    """SHA256(设备凭据) → device 标识。文件 0600，变更后按 mtime 热加载。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._entries: list[tuple[bytes, str]] = []
        self._mtime = 0.0
        self._broken = False
        self.reload(force=True)

    def reload(self, force: bool = False) -> None:
        try:
            st = os.stat(self.path)
        except OSError:
            if force or self._entries:
                log("allowlist_missing", path=self.path)
            with self._lock:
                self._entries, self._mtime, self._broken = [], 0.0, True
            return
        if not force and st.st_mtime == self._mtime:
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            entries: list[tuple[bytes, str]] = []
            for item in raw.get("entries") or []:
                digest = str(item.get("sha256", "")).lower()
                device = str(item.get("device", ""))
                if not SHA256_RE.match(digest):
                    log("allowlist_bad_digest", device=device)
                    continue
                if not DEVICE_RE.match(device):
                    log("allowlist_bad_device", device=device[:32])
                    continue
                entries.append((digest.encode(), device))
        except Exception as exc:  # 坏文件 → 全部拒绝，绝不放行
            log("allowlist_load_failed", error=str(exc)[:200])
            entries = []
        with self._lock:
            self._entries = entries
            self._mtime = st.st_mtime
            self._broken = False
        log("allowlist_loaded", entries=len(entries))

    def identify(self, token: str) -> str | None:
        """常量时间比较整张表：不提前短路，不暴露命中下标。"""
        self.reload()
        digest = hashlib.sha256(token.encode("utf-8", "surrogateescape")).hexdigest().encode()
        found: str | None = None
        with self._lock:
            entries = list(self._entries)
        for stored, device in entries:
            if hmac.compare_digest(stored, digest) and found is None:
                found = device
        return found


# ----------------------------------------------------------------- storage


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    device       TEXT    NOT NULL,
    id           TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    version_code INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    PRIMARY KEY (device, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE TABLE IF NOT EXISTS ingest (
    batch_id     TEXT PRIMARY KEY,
    device       TEXT NOT NULL,
    events       INTEGER NOT NULL,
    inserted     INTEGER NOT NULL,
    repeats      INTEGER NOT NULL DEFAULT 1,
    received_at  INTEGER NOT NULL
);
"""


class Store:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(cfg.db_path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(cfg.db_path, check_same_thread=False, timeout=10.0)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=8000")
        self.conn.executescript(SCHEMA_SQL)
        self.conn.commit()
        try:
            os.chmod(cfg.db_path, 0o600)
        except OSError:
            pass
        self._stop = threading.Event()

    def insert_events(self, device: str, events: list[dict]) -> tuple[list[str], int]:
        """幂等写入；返回 (acked_ids, 实际新增行数)。"""
        now = int(time.time())
        acked: list[str] = []
        inserted = 0
        with self._lock:
            cur = self.conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                for ev in events:
                    cur.execute(
                        "INSERT OR IGNORE INTO events"
                        "(device,id,kind,ts,version_code,received_at) VALUES(?,?,?,?,?,?)",
                        (device, ev["id"], ev["kind"], ev["ts"], ev["versionCode"], now),
                    )
                    inserted += cur.rowcount if cur.rowcount > 0 else 0
                    acked.append(ev["id"])
                batch_id = hashlib.sha256(
                    (device + "\x00" + ",".join(acked)).encode()
                ).hexdigest()[:32]
                cur.execute(
                    "INSERT INTO ingest(batch_id,device,events,inserted,received_at)"
                    " VALUES(?,?,?,?,?)"
                    " ON CONFLICT(batch_id) DO UPDATE SET repeats = repeats + 1",
                    (batch_id, device, len(events), inserted, now),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return acked, inserted

    def prune(self) -> None:
        now = int(time.time())
        cutoff = now - self.cfg.retention_days * 86400
        with self._lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM events WHERE received_at < ?", (cutoff,))
            removed_age = cur.rowcount
            cur.execute("SELECT COUNT(*) FROM events")
            total = cur.fetchone()[0]
            removed_cap = 0
            if total > self.cfg.max_rows:
                excess = total - self.cfg.max_rows
                # WITHOUT ROWID 表按最老 received_at 批次裁剪
                cur.execute(
                    "DELETE FROM events WHERE (device,id) IN ("
                    "SELECT device,id FROM events ORDER BY received_at ASC LIMIT ?)",
                    (excess,),
                )
                removed_cap = cur.rowcount
            cur.execute("DELETE FROM ingest WHERE received_at < ?", (cutoff,))
            self.conn.commit()
        if removed_age or removed_cap:
            log("prune", by_age=removed_age, by_cap=removed_cap, total=total)

    def start_pruner(self) -> None:
        def loop() -> None:
            while not self._stop.wait(self.cfg.prune_interval):
                try:
                    self.prune()
                except Exception as exc:
                    log("prune_failed", error=str(exc)[:200])

        t = threading.Thread(target=loop, name="pruner", daemon=True)
        t.start()


# ------------------------------------------------------------- rate limit


class RateLimiter:
    def __init__(self, per_min: int = RATE_LIMIT_PER_MIN, burst: int = RATE_BURST) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, tuple[float, float]] = {}
        self.per_min = max(1, per_min)
        self.burst = max(1, burst)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._state.get(key, (float(self.burst), now))
            tokens = min(float(self.burst), tokens + (now - last) * (self.per_min / 60.0))
            if tokens < 1.0:
                self._state[key] = (tokens, now)
                return False
            self._state[key] = (tokens - 1.0, now)
            return True


# ------------------------------------------------------------- publication


class Publication:
    """把发布目录里的真实 APK 变成 artifact；没有 APK 就没有 manifest。"""

    def __init__(self, cfg: Config) -> None:
        self.dir = cfg.publish_dir
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[int, int, str]] = {}

    def scan(self) -> dict[int, str]:
        try:
            names = os.listdir(self.dir)
        except FileNotFoundError:
            return {}
        found: dict[int, str] = {}
        for name in names:
            m = APK_RE.match(name)
            if not m:
                continue
            path = os.path.join(self.dir, name)
            if os.path.isfile(path):
                found[int(m.group("vc"))] = path
        return found

    def digest(self, path: str) -> tuple[int, str]:
        st = os.stat(path)
        with self._lock:
            hit = self._cache.get(path)
            if hit and hit[0] == st.st_size and hit[1] == int(st.st_mtime):
                return st.st_size, hit[2]
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        hexd = h.hexdigest()
        with self._lock:
            self._cache[path] = (st.st_size, int(st.st_mtime), hexd)
        return st.st_size, hexd

    def notes(self) -> str:
        """可选发布说明，来自 release.json 的 notes；不影响任何校验字段。"""
        try:
            with open(os.path.join(self.dir, "release.json"), "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError):
            return ""
        if not isinstance(raw, dict):
            return ""
        notes = raw.get("notes")
        if not isinstance(notes, str):
            return ""
        return notes.strip()[:2000]

    def manifest(self) -> dict | None:
        apks = self.scan()
        if not apks:
            return None
        version_code = max(apks)
        path = apks[version_code]
        size, sha = self.digest(path)
        mtime = int(os.stat(path).st_mtime)
        version_name = str(version_code)
        try:
            with open(os.path.join(self.dir, "release.json"), "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict):
                cand = raw.get("versionName")
                if isinstance(cand, str) and re.match(r"^[0-9A-Za-z._-]{1,32}$", cand):
                    version_name = cand
        except (OSError, ValueError):
            pass
        manifest = {
            "schema": SCHEMA_VERSION,
            "channel": CHANNEL,
            "versionCode": version_code,
            "versionName": version_name,
            "apkUrl": f"{BASE_PATH}/xiaoke-night-{version_code}.apk",
            "packageName": "cc.hahaxiong.xiaoke.night",
            "size": size,
            "sha256": sha,
            "url": f"https://pa.hahaxiong.cc:8666{BASE_PATH}/xiaoke-night-{version_code}.apk",
            "apkBytes": size,
            "apkSha256": sha,
            "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
        }
        notes = self.notes()
        if notes:
            manifest["notes"] = notes
        return manifest


# ------------------------------------------------------------------ server


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "night-ota/1"
    sys_version = ""

    cfg: Config
    allowlist: Allowlist
    store: Store
    publication: Publication
    limiter: RateLimiter

    # -------------------------------------------------------- small helpers
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if self.cfg.access_log:
            log("http", client=self.client_address[0], line=fmt % args)

    def _send_json(self, status: int, payload: dict, extra_headers: list[tuple[str, str]] = ()) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra_headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, code: str, detail: str = "", extra_headers: list[tuple[str, str]] = ()) -> None:
        payload = {"error": code}
        if detail:
            payload["detail"] = detail[:200]
        self._send_json(status, payload, extra_headers)

    def _path(self) -> str:
        """返回后端看到的规范路径。

        Lucky 的前端路径（Domains 里写的 pa.hahaxiong.cc/mobile/night）会在转发前被剥掉，
        直连容器时却带着前缀，所以两种形态都接受：
            /mobile/night/latest.json  →  /latest.json
            /latest.json               →  /latest.json
        其它路径一律 404，不放开目录与任意文件。
        """
        raw = urlsplit(self.path).path
        if "%" in raw or "\\" in raw:
            return ""
        while "//" in raw:
            raw = raw.replace("//", "/")
        if raw == BASE_PATH:
            raw = "/"
        elif raw.startswith(BASE_PATH + "/"):
            raw = raw[len(BASE_PATH):]
        if not raw.startswith("/"):
            return ""
        if raw in ("/", ""):
            return "/"
        return raw

    # ------------------------------------------------------------- routing
    def do_HEAD(self) -> None:  # noqa: N802
        self._route(head_only=True)

    def do_GET(self) -> None:  # noqa: N802
        self._route()

    def do_POST(self) -> None:  # noqa: N802
        path = self._path()
        if not path:
            return self._error(404, "not_found")
        if path == "/diagnostics":
            return self._diagnostics()
        return self._error(405, "method_not_allowed", extra_headers=[("Allow", "GET")])

    def _route(self, head_only: bool = False) -> None:
        path = self._path()
        if not path:
            return self._error(404, "not_found")
        if path == "/healthz":
            return self._send_json(200, {"ok": True, "channel": CHANNEL})
        if path == "/" + MANIFEST_NAME:
            return self._manifest()
        if path == "/diagnostics":
            return self._error(405, "method_not_allowed", extra_headers=[("Allow", "POST")])
        if path.startswith("/"):
            name = path[1:]
            m = APK_RE.match(name)
            if m:
                return self._apk(int(m.group("vc")), name, head_only=head_only)
        return self._error(404, "not_found")

    def _manifest(self) -> None:
        manifest = self.publication.manifest()
        if manifest is None:
            return self._error(404, "no_release")
        return self._send_json(200, manifest)

    def _apk(self, version_code: int, name: str, head_only: bool = False) -> None:
        apks = self.publication.scan()
        path = apks.get(version_code)
        if not path or os.path.basename(path) != name:
            return self._error(404, "no_such_apk")
        st = os.stat(path)
        size = st.st_size
        etag = '"%x-%x"' % (size, int(st.st_mtime))
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"^bytes=(\d*)-(\d*)$", rng.strip())
            if not m:
                return self._error(416, "bad_range", extra_headers=[("Content-Range", f"bytes */{size}")])
            s, e = m.group(1), m.group(2)
            if s == "" and e == "":
                return self._error(416, "bad_range", extra_headers=[("Content-Range", f"bytes */{size}")])
            if s == "":
                start = max(0, size - int(e))
                end = size - 1
            else:
                start = int(s)
                end = int(e) if e else size - 1
            if start > end or start >= size:
                return self._error(416, "bad_range", extra_headers=[("Content-Range", f"bytes */{size}")])
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header("Content-Type", APK_MIME)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header(
            "Last-Modified", time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(st.st_mtime))
        )
        self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(APK_CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    # -------------------------------------------------------- diagnostics
    def _diagnostics(self) -> None:
        device = self._authenticate()
        if device is None:
            return self._error(401, "unauthorized")
        if not self.limiter.allow(device):
            return self._error(429, "rate_limited", extra_headers=[("Retry-After", "60")])
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype not in ("application/json", "text/plain", ""):
            return self._error(415, "unsupported_media_type")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._error(400, "bad_length")
        if length <= 0:
            return self._error(400, "empty_body")
        if length > MAX_BODY_BYTES:
            return self._error(413, "body_too_large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._error(400, "bad_json")
        ok, reason, events = self._validate(payload)
        if not ok:
            log("diagnostics_rejected", device=device, reason=reason)
            return self._error(400, "invalid_payload", reason)
        try:
            acked, inserted = self.store.insert_events(device, events)
        except Exception as exc:
            log("diagnostics_store_failed", device=device, error=str(exc)[:200])
            return self._error(500, "store_failed")
        log("diagnostics_ok", device=device, events=len(events), inserted=inserted)
        return self._send_json(200, {"acked": acked})

    def _authenticate(self) -> str | None:
        header = self.headers.get("Authorization") or ""
        if not header.lower().startswith("bearer "):
            return None
        token = header[7:].strip()
        if not token or len(token) > 512:
            return None
        return self.allowlist.identify(token)

    def _validate(self, payload) -> tuple[bool, str, list[dict]]:
        if not isinstance(payload, dict):
            return False, "root_not_object", []
        extra = set(payload) - {"schema", "events"}
        if extra:
            return False, "unexpected_root_fields", []
        if payload.get("schema") != SCHEMA_VERSION or isinstance(payload.get("schema"), bool):
            return False, "bad_schema", []
        events = payload.get("events")
        if not isinstance(events, list):
            return False, "events_not_array", []
        if not 1 <= len(events) <= MAX_EVENTS:
            return False, "events_count_out_of_range", []
        now = int(time.time())
        cleaned: list[dict] = []
        seen: set[str] = set()
        for idx, ev in enumerate(events):
            if not isinstance(ev, dict):
                return False, f"event_{idx}_not_object", []
            if set(ev) != {"id", "kind", "ts", "versionCode"}:
                return False, f"event_{idx}_fields", []
            eid, kind = ev["id"], ev["kind"]
            ts, vc = ev["ts"], ev["versionCode"]
            if not isinstance(eid, str) or not EVENT_ID_RE.match(eid):
                return False, f"event_{idx}_id", []
            if not isinstance(kind, str) or kind not in KIND_SET:
                return False, f"event_{idx}_kind", []
            if isinstance(ts, bool) or not isinstance(ts, int):
                return False, f"event_{idx}_ts_type", []
            # The Android journal records Unix milliseconds. Store seconds for SQL reports.
            if ts >= 1_000_000_000_000:
                ts //= 1000
            if ts > now + CLOCK_SKEW_FUTURE or ts < now - MAX_EVENT_AGE:
                return False, f"event_{idx}_ts_range", []
            if isinstance(vc, bool) or not isinstance(vc, int) or not 1 <= vc <= 2_100_000_000:
                return False, f"event_{idx}_version", []
            if eid in seen:
                continue
            seen.add(eid)
            cleaned.append({"id": eid, "kind": kind, "ts": ts, "versionCode": vc})
        return True, "", cleaned


def build_server(cfg: Config) -> ThreadingHTTPServer:
    store = Store(cfg)
    store.start_pruner()
    Handler.cfg = cfg
    Handler.allowlist = Allowlist(cfg.allowlist_path)
    Handler.store = store
    Handler.publication = Publication(cfg)
    Handler.limiter = RateLimiter(cfg.rate_per_min, cfg.rate_burst)
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
    httpd.daemon_threads = True
    return httpd


def main() -> int:
    cfg = Config()
    os.makedirs(cfg.data_dir, exist_ok=True)
    try:
        httpd = build_server(cfg)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            log("bind_failed", addr=cfg.listen, error="address in use")
            return 2
        raise
    log(
        "night_ota_started",
        listen=cfg.listen,
        publish=cfg.publish_dir,
        db=cfg.db_path,
        allowlist=cfg.allowlist_path,
        retention_days=cfg.retention_days,
    )
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log("night_ota_stopping")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log("fatal", error=traceback.format_exc().replace("\n", " | ")[:1000])
        raise
