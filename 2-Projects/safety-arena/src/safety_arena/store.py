"""SQLite trace 落库。trace 整体序列化成 JSON 存 doc 列,另抽几列做列表展示。"""

from __future__ import annotations

import json
import os
import sqlite3

from .models import Trace
from .serde import trace_from_dict, trace_to_dict


class TraceStore:
    def __init__(self, path: str = "data/traces.db") -> None:
        self.path = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._init()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._conn() as c:
            c.execute(
                """CREATE TABLE IF NOT EXISTS traces(
                    trace_id  TEXT PRIMARY KEY,
                    input_text TEXT,
                    label      TEXT,
                    n_tokens   INTEGER,
                    harmful    INTEGER,
                    doc        TEXT
                )"""
            )

    def save(self, t: Trace) -> None:
        doc = json.dumps(trace_to_dict(t), ensure_ascii=False)
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO traces VALUES (?,?,?,?,?,?)",
                (
                    t.trace_id,
                    t.input.text,
                    t.input.label.value if t.input.label else None,
                    len(t.tokens()),
                    int(t.is_harmful()),
                    doc,
                ),
            )

    def get(self, trace_id: str) -> Trace | None:
        with self._conn() as c:
            row = c.execute("SELECT doc FROM traces WHERE trace_id=?", (trace_id,)).fetchone()
        return trace_from_dict(json.loads(row["doc"])) if row else None

    def list(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT trace_id, input_text, label, n_tokens, harmful FROM traces ORDER BY trace_id"
            ).fetchall()
        return [
            {
                "trace_id": r["trace_id"],
                "input_text": r["input_text"],
                "label": r["label"],
                "n_tokens": r["n_tokens"],
                "harmful": bool(r["harmful"]),
            }
            for r in rows
        ]
