from __future__ import annotations

import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("codex-account-guard.py")
SPEC = importlib.util.spec_from_file_location("codex_account_guard", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load codex-account-guard.py")
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class GuardWorkloadTests(unittest.TestCase):
    def test_parse_elapsed_seconds(self) -> None:
        self.assertEqual(GUARD.parse_elapsed_seconds("01-02:03:04"), 93784)
        self.assertEqual(GUARD.parse_elapsed_seconds("02:03:04"), 7384)
        self.assertEqual(GUARD.parse_elapsed_seconds("03:04"), 184)
        self.assertIsNone(GUARD.parse_elapsed_seconds("bad"))

    def test_stale_turn_filter_preserves_recovered_activity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "turns.sqlite"
            with sqlite3.connect(database_path) as database:
                database.executescript(
                    """
                    CREATE TABLE thread_turns (
                        thread_id TEXT NOT NULL,
                        turn_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        started_at INTEGER,
                        PRIMARY KEY (thread_id, turn_id)
                    );
                    CREATE TABLE thread_items (
                        thread_id TEXT NOT NULL,
                        turn_id TEXT NOT NULL,
                        created_at_ms INTEGER NOT NULL
                    );
                    """
                )
                database.executemany(
                    "INSERT INTO thread_turns VALUES (?, ?, ?, ?)",
                    [
                        ("old-stale", "1", "inProgress", 100),
                        ("old-resumed", "2", "inProgress", 100),
                        ("new-live", "3", "inProgress", 250),
                        ("done", "4", "completed", 250),
                    ],
                )
                database.execute(
                    "INSERT INTO thread_items VALUES (?, ?, ?)",
                    ("old-resumed", "2", 250000),
                )

            self.assertEqual(GUARD.turn_counts(database_path, 200000), (2, 1))
            self.assertEqual(GUARD.turn_counts(database_path, None), (3, 0))


if __name__ == "__main__":
    unittest.main()
