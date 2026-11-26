#!/usr/bin/env python3
"""night_server 自测：正例 / 负例 / 幂等 / 404 / Range。

不依赖 pytest：

    python3 tests/test_service.py
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

CRED = "test-credential-phone-01-do-not-reuse-1234567890"
CRED2 = "test-credential-phone-02-abcdefghijklmnop"
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILS.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, tmp: str, **overrides) -> None:
        self.tmp = tmp
        self.port = free_port()
        self.publish = os.path.join(tmp, "publish")
        self.data = os.path.join(tmp, "data")
        self.private = os.path.join(tmp, "private")
        for d in (self.publish, self.data, self.private):
            os.makedirs(d, exist_ok=True)
        allow = os.path.join(self.private, "allowlist.json")
        with open(allow, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "schema": 1,
                    "entries": [
                        {"device": "phone-01", "sha256": hashlib.sha256(CRED.encode()).hexdigest()},
                        {"device": "phone-02", "sha256": hashlib.sha256(CRED2.encode()).hexdigest()},
                    ],
                },
                fh,
            )
        os.chmod(allow, 0o600)
        self.env = dict(
            os.environ,
            NIGHT_LISTEN=f"127.0.0.1:{self.port}",
            NIGHT_PUBLISH_DIR=self.publish,
            NIGHT_DATA_DIR=self.data,
            NIGHT_DB=os.path.join(self.data, "diagnostics.sqlite3"),
            NIGHT_ALLOWLIST=allow,
            NIGHT_RETENTION_DAYS="45",
            NIGHT_PRUNE_INTERVAL="3600",
            PYTHONUNBUFFERED="1",
            NIGHT_RATE_LIMIT_PER_MIN="100000",
            NIGHT_RATE_BURST="100000",
        )
        self.env.update({k: str(v) for k, v in overrides.items()})
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "night_server.py")],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self._wait()

    def _wait(self) -> None:
        for _ in range(100):
            try:
                status = self.request("GET", "/mobile/night/healthz")[0]
                if status == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("server 未起来")

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if body is not None:
            h.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        hdrs = dict(resp.getheaders())
        conn.close()
        return status, data, hdrs

    def close(self) -> None:
        self.proc.terminate()
        try:
            out = self.proc.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            self.proc.kill()
            out = ""
        self.log = out or ""


def post_events(srv: Server, events, cred=CRED, **kw):
    body = json.dumps({"schema": 1, "events": events}).encode()
    return srv.request(
        "POST", "/mobile/night/diagnostics", body, {"Authorization": f"Bearer {cred}"}, **kw
    )


def ev(eid: str, kind: str = "call_start", ts: int | None = None, vc: int = 42) -> dict:
    return {"id": eid, "kind": kind, "ts": int(ts if ts is not None else time.time()), "versionCode": vc}


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="night-test-")
    srv = Server(tmp)
    now = int(time.time())
    try:
        print("\n[1] 认证与路由负例")
        status, body, _ = srv.request("POST", "/mobile/night/diagnostics", b'{"schema":1,"events":[]}')
        check("无 Authorization → 401", status == 401, str(status))
        status, _, _ = post_events(srv, [ev("a1")], cred="wrong-credential")
        check("错凭据 → 401", status == 401, str(status))
        status, _, _ = srv.request("GET", "/mobile/night/diagnostics")
        check("GET diagnostics → 405", status == 405, str(status))
        status, _, _ = srv.request("POST", "/mobile/night/latest.json", b"{}")
        check("POST manifest → 405", status == 405, str(status))
        status, _, _ = srv.request("GET", "/mobile/night/../etc/passwd")
        check("路径穿越 → 404", status == 404, str(status))
        status, _, _ = srv.request("GET", "/mobile/night/%2e%2e/x")
        check("编码穿越 → 404", status == 404, str(status))
        status, _, _ = srv.request("GET", "/mobile/other/latest.json")
        check("路径前缀不符 → 404", status == 404, str(status))

        print("\n[1b] 前缀形态：Lucky 会剥掉 /mobile/night，两种形态都要能应答")
        for path, want in [
            ("/mobile/night/healthz", 200),
            ("/healthz", 200),
            ("/mobile/night/latest.json", 404),
            ("/latest.json", 404),
            ("/", 404),
            ("/mobile/night/", 404),
        ]:
            status, _, _ = srv.request("GET", path)
            check(f"GET {path} → {want}", status == want, str(status))

        print("\n[2] manifest：没有 APK 时必须 404")
        status, body, _ = srv.request("GET", "/mobile/night/latest.json")
        check("无 APK → 404", status == 404, str(status))
        check("404 是 JSON 错误体", b"no_release" in body, body[:120])

        print("\n[3] schema / 长度 / 时间 / version 严格校验")
        cases = [
            ("schema=2", {"schema": 2, "events": [ev("b1")]}),
            ("schema=true", {"schema": True, "events": [ev("b2")]}),
            ("schema 缺失", {"events": [ev("b3")]}),
            ("多余根字段", {"schema": 1, "events": [ev("b4")], "note": "x"}),
            ("events 非数组", {"schema": 1, "events": {"a": 1}}),
            ("events 空", {"schema": 1, "events": []}),
            ("events 超 200", {"schema": 1, "events": [ev(f"c{i}") for i in range(201)]}),
            ("事件缺字段", {"schema": 1, "events": [{"id": "d1", "kind": "call_start", "ts": now}]}),
            ("事件多字段", {"schema": 1, "events": [dict(ev("d2"), text="你好")]}),
            ("未知 kind", {"schema": 1, "events": [ev("d3", kind="spoken_text")]}),
            ("id 含非法字符", {"schema": 1, "events": [ev("d 4")]}),
            ("id 超长", {"schema": 1, "events": [ev("e" * 65)]}),
            ("ts 太旧", {"schema": 1, "events": [ev("d5", ts=now - 46 * 86400)]}),
            ("ts 未来 1 小时", {"schema": 1, "events": [ev("d6", ts=now + 3600)]}),
            ("ts 是字符串", {"schema": 1, "events": [{"id": "d7", "kind": "call_start", "ts": str(now), "versionCode": 42}]}),
            ("ts 是布尔", {"schema": 1, "events": [{"id": "d8", "kind": "call_start", "ts": True, "versionCode": 42}]}),
            ("versionCode=0", {"schema": 1, "events": [ev("d9", vc=0)]}),
            ("versionCode 负数", {"schema": 1, "events": [ev("d10", vc=-3)]}),
            ("versionCode 字符串", {"schema": 1, "events": [{"id": "d11", "kind": "call_start", "ts": now, "versionCode": "42"}]}),
            ("versionCode 超范围", {"schema": 1, "events": [ev("d12", vc=9_999_999_999)]}),
        ]
        for name, payload in cases:
            raw = json.dumps(payload).encode()
            status, body, _ = srv.request(
                "POST", "/mobile/night/diagnostics", raw, {"Authorization": f"Bearer {CRED}"}
            )
            check(f"{name} → 400", status == 400, f"{status} {body[:120]}")

        status, body, _ = srv.request(
            "POST",
            "/mobile/night/diagnostics",
            b'{"schema":1,"events":[',
            {"Authorization": f"Bearer {CRED}"},
        )
        check("坏 JSON → 400", status == 400, str(status))

        big = json.dumps(
            {"schema": 1, "events": [ev(f"f{i}") for i in range(190)]}
        ).encode() + b" " * (70 * 1024)
        status, _, _ = srv.request(
            "POST", "/mobile/night/diagnostics", big, {"Authorization": f"Bearer {CRED}"}
        )
        check("body 超 64KB → 413", status == 413, str(status))

        db = os.path.join(srv.data, "diagnostics.sqlite3")
        con = sqlite3.connect(db)
        n = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        con.close()
        check("所有负例都没落库", n == 0, f"rows={n}")

        print("\n[4] 幂等：同一合成批次发两次只记 1 次")
        batch = [
            ev("idem-1", "call_start", now - 120),
            ev("idem-2", "connected", now - 110),
            ev("idem-3", "mic_on", now - 100),
            ev("idem-4", "rx_audio", now - 90),
            ev("idem-5", "call_end", now - 30),
        ]
        s1, b1, _ = post_events(srv, batch)
        s2, b2, _ = post_events(srv, batch)
        check("首次 200", s1 == 200, str(s1))
        check("重放 200", s2 == 200, str(s2))
        check("acked 一致", json.loads(b1)["acked"] == json.loads(b2)["acked"], f"{b1} {b2}")
        con = sqlite3.connect(db)
        n = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        ingest = con.execute("SELECT events, inserted, repeats FROM ingest ORDER BY received_at").fetchall()
        con.close()
        check("重放后仍是 5 行", n == 5, f"rows={n}")
        check("批次留痕：首 5/5 且 repeats=2", ingest == [(5, 5, 2)], str(ingest))

        print("\n[5] 批内重复 id 只算一次")
        dup = [ev("dup-1", "paired", now - 50), ev("dup-1", "paired", now - 50)]
        s, b, _ = post_events(srv, dup)
        con = sqlite3.connect(db)
        n = con.execute("SELECT COUNT(*) FROM events WHERE id='dup-1'").fetchone()[0]
        con.close()
        check("批内同 id → 1 行", s == 200 and n == 1, f"{s} rows={n}")
        check("acked 只回一个", len(json.loads(b)["acked"]) == 1, b[:120])

        print("\n[6] 第二台设备隔离与白名单外设备")
        s, _, _ = post_events(srv, [ev("p2-1")], cred=CRED2)
        check("phone-02 也能写", s == 200, str(s))
        s, _, _ = post_events(srv, [ev("p2-1")], cred=CRED)
        check("同 id 跨设备不冲突", s == 200, str(s))
        con = sqlite3.connect(db)
        rows = con.execute("SELECT device, COUNT(*) FROM events WHERE id='p2-1' GROUP BY device").fetchall()
        con.close()
        check("两设备各 1 行", sorted(rows) == [("phone-01", 1), ("phone-02", 1)], str(rows))

        print("\n[7] 真实 APK → manifest 由字节算出，Range 可续传")
        apk = os.path.join(srv.publish, "xiaoke-night-77.apk")
        payload = os.urandom(300_000)
        with open(apk, "wb") as fh:
            fh.write(payload)
        status, body, hdrs = srv.request("GET", "/mobile/night/latest.json")
        man = json.loads(body) if status == 200 else {}
        check("有 APK → 200", status == 200, str(status))
        check("versionCode 取自文件名", man.get("versionCode") == 77, str(man.get("versionCode")))
        check("Android OTA 六字段", (man["packageName"], man["versionCode"], man["versionName"], man["size"], man["sha256"], man["url"]) ==
              ("cc.hahaxiong.xiaoke.night", 77, man["versionName"], len(payload), hashlib.sha256(payload).hexdigest(), "https://pa.hahaxiong.cc:8666/mobile/night/xiaoke-night-77.apk"))
        check("sha256 == 文件 sha256", man.get("apkSha256") == hashlib.sha256(payload).hexdigest())
        check("apkBytes == 文件大小", man.get("apkBytes") == len(payload), str(man.get("apkBytes")))
        check("apkUrl 指向真实文件名", man.get("apkUrl") == "/mobile/night/xiaoke-night-77.apk", str(man.get("apkUrl")))
        check("manifest 不缓存", hdrs.get("Cache-Control") == "no-store", str(hdrs.get("Cache-Control")))

        status, body, hdrs = srv.request("GET", "/mobile/night/xiaoke-night-77.apk")
        check("APK 下载 200", status == 200 and len(body) == len(payload), f"{status} {len(body)}")
        check("APK MIME 正确", hdrs.get("Content-Type") == "application/vnd.android.package-archive", str(hdrs.get("Content-Type")))
        status, part, hdrs = srv.request(
            "GET", "/mobile/night/xiaoke-night-77.apk", headers={"Range": "bytes=100-199"}
        )
        check("Range 206", status == 206, str(status))
        check("Range 内容正确", part == payload[100:200], f"len={len(part)}")
        check("Content-Range 正确", hdrs.get("Content-Range") == f"bytes 100-199/{len(payload)}", str(hdrs.get("Content-Range")))
        status, _, _ = srv.request("GET", "/mobile/night/xiaoke-night-78.apk")
        check("不存在的版本 → 404", status == 404, str(status))
        status, _, _ = srv.request("GET", "/xiaoke-night-77.apk")
        check("剥前缀形态也能下 APK", status == 200, str(status))
        status, _, _ = srv.request("GET", "/xiaoke-night-77.apk.bak")
        check("非 apk 名 → 404", status == 404, str(status))

        print("\n[8] 更老/更新版本按 versionCode 取最新")
        apk2 = os.path.join(srv.publish, "xiaoke-night-88.apk")
        with open(apk2, "wb") as fh:
            fh.write(b"newer")
        status, body, _ = srv.request("GET", "/mobile/night/latest.json")
        man = json.loads(body)
        check("取 88", man.get("versionCode") == 88, str(man.get("versionCode")))
        status, _, _ = srv.request("GET", "/mobile/night/xiaoke-night-77.apk")
        check("旧版本仍可下载", status == 200, str(status))
        os.unlink(apk2)
        os.unlink(apk)
        status, _, _ = srv.request("GET", "/mobile/night/latest.json")
        check("删空后回到 404", status == 404, str(status))

        print("\n[9] 限流：小额度下会出现 429 且带 Retry-After")
        low = Server(tempfile.mkdtemp(prefix="night-rl-"), NIGHT_RATE_LIMIT_PER_MIN=1, NIGHT_RATE_BURST=1)
        try:
            codes = []
            for i in range(3):
                st, _, hd = low.request(
                    "POST",
                    "/mobile/night/diagnostics",
                    json.dumps({"schema": 1, "events": [ev(f"rl-{i}")]}).encode(),
                    {"Authorization": f"Bearer {CRED}"},
                )
                codes.append(st)
                if st == 429:
                    last_headers = hd
            check("小额度先 200 后 429", codes[0] == 200 and 429 in codes[1:], str(codes))
            check("429 带 Retry-After", last_headers.get("Retry-After") == "60", str(last_headers.get("Retry-After")))
        finally:
            low.close()

        print("\n[10] 日志与库里不出现凭据")
        srv.close()
        log_text = getattr(srv, "log", "")
        check("stdout 不含凭据明文", CRED not in log_text, "leak!" if CRED in log_text else "")
        check("stdout 不含 Authorization", "Bearer " not in log_text)
        con = sqlite3.connect(db)
        dump = "\n".join(con.iterdump())
        con.close()
        check("库导出不含凭据", CRED not in dump and CRED2 not in dump)
    finally:
        try:
            srv.close()
        except Exception:
            pass

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
