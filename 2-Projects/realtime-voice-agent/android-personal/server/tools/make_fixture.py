#!/usr/bin/env python3
"""生成合成诊断库，用来验证 CLI/分析口径（不连真库、不污染生产数据）。

    python3 tools/make_fixture.py --db /tmp/fixture.sqlite3
"""

from __future__ import annotations

import argparse
import os
import random
import sqlite3
import sys
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    device TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    ts INTEGER NOT NULL, version_code INTEGER NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (device, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE TABLE IF NOT EXISTS ingest (
    batch_id TEXT PRIMARY KEY, device TEXT NOT NULL, events INTEGER NOT NULL,
    inserted INTEGER NOT NULL, repeats INTEGER NOT NULL DEFAULT 1, received_at INTEGER NOT NULL
);
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--calls-per-device", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1126)
    args = ap.parse_args()
    random.seed(args.seed)

    if os.path.exists(args.db):
        os.unlink(args.db)
    con = sqlite3.connect(args.db)
    con.executescript(SCHEMA)
    now = int(time.time())
    devices = ["phone-01", "phone-02", "phone-03"]
    rows = []
    for dev in devices:
        vc = random.choice([36, 37, 38])
        for n in range(args.calls_per_device):
            start = now - random.randint(600, 6 * 86400)
            seq = [
                ("call_start", start),
                ("connected", start + random.randint(1, 3)),
                ("mic_on", start + random.randint(2, 5)),
            ]
            # 20% 通话拿不到音频（媒体失败）
            ok_audio = random.random() > 0.2
            if ok_audio:
                seq.append(("rx_audio", start + random.randint(3, 9)))
                seq.append(("rx_caption", start + random.randint(5, 12)))
            else:
                seq.append(("transport_error", start + random.randint(4, 10)))
            seq.append(("tx_caption", start + random.randint(8, 20)))
            for _ in range(random.randint(0, 2)):
                seq.append(("spoken_interrupt", start + random.randint(10, 25)))
                if random.random() > 0.3:
                    seq.append(("cancel_ack", start + random.randint(11, 26)))
            # 10% 没收尾
            if random.random() > 0.1:
                seq.append(("call_end", start + random.randint(30, 120)))
            for kind, ts in seq:
                rows.append((dev, f"{dev}-{n}-{kind}-{uuid.uuid4().hex[:8]}", kind, ts, vc, now))
        rows.append((dev, f"{dev}-pair-{uuid.uuid4().hex[:8]}", "paired", now - 86400 * 3, vc, now))
        rows.append((dev, f"{dev}-ota-{uuid.uuid4().hex[:8]}", "ota_check", now - 3600, vc, now))
    con.executemany("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)", rows)
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    con.close()
    print(f"{args.db}: {total} 条去重事件 / {len(devices)} 台设备")
    return 0


if __name__ == "__main__":
    sys.exit(main())
