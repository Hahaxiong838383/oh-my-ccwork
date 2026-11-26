#!/usr/bin/env python3
"""诊断库分析 CLI（只读）。

数据已经是按 (device, id) 去重的，所以这里所有计数都是"去重后"的真实次数。

  python3 cli.py devices   --days 7
  python3 cli.py calls     --days 7
  python3 cli.py media     --days 7      # 媒体失败面：有 call_start 但没收到 rx_audio
  python3 cli.py interrupts --days 7     # 打断
  python3 cli.py pending   --days 7      # 待分析：没收尾 / 没接通 / 传输错
  python3 cli.py sql "SELECT kind, COUNT(*) c FROM events GROUP BY kind ORDER BY c DESC"

默认库路径来自环境变量 NIGHT_DB 或 /srv/night/data/diagnostics.sqlite3。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict

DEFAULT_DB = os.environ.get("NIGHT_DB", "/srv/night/data/diagnostics.sqlite3")
GAP_SECONDS = 30 * 60  # 同一设备超 30 分钟视为新一通


def connect(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        raise SystemExit(f"库不存在：{path}")
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def fmt_ts(ts: int | None) -> str:
    if not ts:
        return "-"
    return time.strftime("%m-%d %H:%M", time.localtime(ts))


def table(headers: list[str], rows: list[list]) -> str:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    out = [line, "  ".join("-" * w for w in widths)]
    for row in rows:
        out.append("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
    return "\n".join(out)


def fetch(conn: sqlite3.Connection, days: int) -> list[sqlite3.Row]:
    cutoff = int(time.time()) - days * 86400
    return conn.execute(
        "SELECT device, id, kind, ts, version_code, received_at "
        "FROM events WHERE ts >= ? ORDER BY device, ts, id",
        (cutoff,),
    ).fetchall()


def sessionize(rows: list[sqlite3.Row]) -> list[dict]:
    """按设备把事件切成通话会话。"""
    by_device: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_device[r["device"]].append(r)
    sessions: list[dict] = []
    for device, evs in by_device.items():
        current: dict | None = None
        for ev in evs:
            kind = ev["kind"]
            if kind == "call_start":
                if current:
                    sessions.append(current)
                current = {
                    "device": device,
                    "start": ev["ts"],
                    "end": None,
                    "version": ev["version_code"],
                    "kinds": defaultdict(int),
                    "first_rx_audio": None,
                    "last_ts": ev["ts"],
                }
            if current is None:
                if kind in ("paired", "ota_check"):
                    continue
                current = {
                    "device": device,
                    "start": ev["ts"],
                    "end": None,
                    "version": ev["version_code"],
                    "kinds": defaultdict(int),
                    "first_rx_audio": None,
                    "last_ts": ev["ts"],
                    "synthetic": True,
                }
            if ev["ts"] - current["last_ts"] > GAP_SECONDS:
                sessions.append(current)
                current = {
                    "device": device,
                    "start": ev["ts"],
                    "end": None,
                    "version": ev["version_code"],
                    "kinds": defaultdict(int),
                    "first_rx_audio": None,
                    "last_ts": ev["ts"],
                }
            current["kinds"][kind] += 1
            current["last_ts"] = ev["ts"]
            if kind == "rx_audio" and current["first_rx_audio"] is None:
                current["first_rx_audio"] = ev["ts"]
            if kind == "call_end":
                current["end"] = ev["ts"]
                sessions.append(current)
                current = None
        if current:
            sessions.append(current)
    return sessions


def cmd_devices(conn, days, as_json) -> None:
    rows = fetch(conn, days)
    agg: dict[str, dict] = {}
    for r in rows:
        d = agg.setdefault(
            r["device"],
            {"events": 0, "first": r["ts"], "last": r["ts"], "versions": defaultdict(int), "kinds": defaultdict(int)},
        )
        d["events"] += 1
        d["first"] = min(d["first"], r["ts"])
        d["last"] = max(d["last"], r["ts"])
        d["versions"][r["version_code"]] += 1
        d["kinds"][r["kind"]] += 1
    if as_json:
        print(json.dumps({k: {**v, "versions": dict(v["versions"]), "kinds": dict(v["kinds"])} for k, v in agg.items()}, ensure_ascii=False, indent=2))
        return
    out = []
    for dev, d in sorted(agg.items()):
        vers = ",".join(f"v{k}:{v}" for k, v in sorted(d["versions"].items()))
        out.append([dev, d["events"], fmt_ts(d["first"]), fmt_ts(d["last"]), vers])
    print(table(["设备", "去重事件", "最早", "最近", "版本分布"], out))


def cmd_calls(conn, days, as_json) -> None:
    rows = fetch(conn, days)
    sessions = sessionize(rows)
    stats: dict[str, dict] = {}
    for s in sessions:
        if s.get("synthetic"):
            continue
        d = stats.setdefault(
            s["device"],
            {"calls": 0, "connected": 0, "ended": 0, "dur": 0, "dur_n": 0, "err": 0, "no_audio": 0},
        )
        d["calls"] += 1
        if s["kinds"].get("connected"):
            d["connected"] += 1
        if s["end"]:
            d["ended"] += 1
            d["dur"] += s["end"] - s["start"]
            d["dur_n"] += 1
        if s["kinds"].get("transport_error"):
            d["err"] += 1
        if s["kinds"].get("connected") and not s["kinds"].get("rx_audio"):
            d["no_audio"] += 1
    if as_json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return
    out = []
    for dev, d in sorted(stats.items()):
        avg = f"{d['dur']/d['dur_n']:.0f}s" if d["dur_n"] else "-"
        rate = f"{d['connected']*100/d['calls']:.0f}%" if d["calls"] else "-"
        out.append([dev, d["calls"], f"{d['connected']} ({rate})", d["ended"], avg, d["err"], d["no_audio"]])
    print(table(["设备", "通话", "已接通", "已收尾", "平均时长", "传输错", "接通但无音频"], out))


def cmd_media(conn, days, as_json) -> None:
    rows = fetch(conn, days)
    sessions = [s for s in sessionize(rows) if not s.get("synthetic")]
    agg: dict[str, dict] = {}
    for s in sessions:
        d = agg.setdefault(
            s["device"],
            {"calls": 0, "no_audio": 0, "no_caption": 0, "err": 0, "mic_on": 0, "first_audio_delay": []},
        )
        d["calls"] += 1
        k = s["kinds"]
        if not k.get("rx_audio"):
            d["no_audio"] += 1
        elif s["first_rx_audio"]:
            d["first_audio_delay"].append(s["first_rx_audio"] - s["start"])
        if not k.get("rx_caption"):
            d["no_caption"] += 1
        if k.get("transport_error"):
            d["err"] += 1
        if k.get("mic_on"):
            d["mic_on"] += 1
    if as_json:
        print(json.dumps(agg, ensure_ascii=False, indent=2))
        return
    out = []
    for dev, d in sorted(agg.items()):
        delays = d.pop("first_audio_delay", [])
        avg = f"{sum(delays)/len(delays):.1f}s" if delays else "-"
        out.append([
            dev, d["calls"], d["no_audio"], d["no_caption"], d["err"], d["mic_on"], avg,
        ])
    print(table(["设备", "通话", "无 rx_audio", "无字幕", "传输错", "mic_on", "首音频延迟"], out))


def cmd_interrupts(conn, days, as_json) -> None:
    rows = fetch(conn, days)
    sessions = [s for s in sessionize(rows) if not s.get("synthetic")]
    agg: dict[str, dict] = {}
    for s in sessions:
        d = agg.setdefault(s["device"], {"calls": 0, "int": 0, "ack": 0, "tx": 0})
        if s["kinds"].get("call_start"):
            d["calls"] += 1
        d["int"] += s["kinds"].get("spoken_interrupt", 0)
        d["ack"] += s["kinds"].get("cancel_ack", 0)
        d["tx"] += s["kinds"].get("tx_caption", 0)
    if as_json:
        print(json.dumps(agg, ensure_ascii=False, indent=2))
        return
    out = []
    for dev, d in sorted(agg.items()):
        per = f"{d['int']/d['calls']:.2f}" if d["calls"] else "-"
        ratio = f"{d['ack']*100/d['int']:.0f}%" if d["int"] else "-"
        out.append([dev, d["calls"], d["int"], per, d["ack"], ratio, d["tx"]])
    print(table(["设备", "通话", "打断", "每通", "cancel_ack", "ack 覆盖", "tx_caption"], out))


def cmd_pending(conn, days, as_json) -> None:
    rows = fetch(conn, days)
    sessions = sessionize(rows)
    now = int(time.time())
    items = []
    for s in sessions:
        k = s["kinds"]
        reasons = []
        if k.get("call_start") and not s["end"]:
            reasons.append("未收尾(no call_end)")
        if k.get("call_start") and not k.get("connected"):
            reasons.append("未接通(no connected)")
        if k.get("connected") and not k.get("rx_audio"):
            reasons.append("接通无音频")
        if k.get("transport_error") and not s["end"]:
            reasons.append("传输错后中断")
        if not reasons:
            continue
        items.append({
            "device": s["device"],
            "start": s["start"],
            "last": s["last_ts"],
            "age_min": (now - s["last_ts"]) // 60,
            "version": s["version"],
            "reasons": reasons,
        })
    if as_json:
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return
    items.sort(key=lambda x: x["start"], reverse=True)
    out = [[
        i["device"], fmt_ts(i["start"]), i["age_min"], f"v{i['version']}", " / ".join(i["reasons"]),
    ] for i in items]
    print(table(["设备", "开始", "静默(分)", "版本", "待分析原因"], out))
    print(f"\n共 {len(items)} 条待分析")


def cmd_sql(conn, statement: str) -> None:
    lowered = statement.strip().lower()
    if not (lowered.startswith("select") or lowered.startswith("with")):
        raise SystemExit("只允许 SELECT / WITH 只读查询")
    if ";" in statement.strip().rstrip(";"):
        raise SystemExit("一次只允许一条语句")
    cur = conn.execute(statement)
    cols = [d[0] for d in cur.description or []]
    rows = cur.fetchall()
    print(table(cols, [[r[c] for c in cols] for r in rows]))
    print(f"\n{len(rows)} 行")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["devices", "calls", "media", "interrupts", "pending", "sql"])
    ap.add_argument("statement", nargs="?")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    conn = connect(args.db)
    if args.command == "devices":
        cmd_devices(conn, args.days, args.json)
    elif args.command == "calls":
        cmd_calls(conn, args.days, args.json)
    elif args.command == "media":
        cmd_media(conn, args.days, args.json)
    elif args.command == "interrupts":
        cmd_interrupts(conn, args.days, args.json)
    elif args.command == "pending":
        cmd_pending(conn, args.days, args.json)
    elif args.command == "sql":
        if not args.statement:
            raise SystemExit("需要一条 SQL")
        cmd_sql(conn, args.statement)
    return 0


if __name__ == "__main__":
    sys.exit(main())
