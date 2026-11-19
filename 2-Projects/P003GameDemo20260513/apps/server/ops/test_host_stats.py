"""Bounded collector regressions; external journalctl is a real fixture process."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("host-stats.py")


class CollectorTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("host_stats", SCRIPT)
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.fixture = self.root / "fixture.json"
        self.calls = self.root / "calls.jsonl"
        executable = self.root / "journalctl"
        executable.write_text("#!" + sys.executable + "\n" + '''
import json, os, re, sys, time
from pathlib import Path
data=json.loads(Path(os.environ['JOURNAL_FIXTURE']).read_text())
with open(os.environ['JOURNAL_CALLS'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
time.sleep(data.get('sleep',0))
rows=data.get('rows',[])
if '-g' in sys.argv:
    pattern=sys.argv[sys.argv.index('-g')+1]
    rows=[r for r in rows if re.search(pattern,r)]
if '--reverse' in sys.argv: rows=list(reversed(rows))
for arg in sys.argv:
    if arg.startswith('--lines='): rows=rows[:int(arg.split('=')[1])]
sys.stdout.write('\\n'.join(rows)+('\\n' if rows else ''))
sys.stderr.write(data.get('stderr',''))
sys.exit(data.get('rc',0))
''')
        executable.chmod(0o755)
        self.addCleanup(mock.patch.stopall)
        mock.patch.dict(os.environ, {
            "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", ""),
            "JOURNAL_FIXTURE": str(self.fixture), "JOURNAL_CALLS": str(self.calls),
        }).start()
        # Fixture Python startup on a busy Mac is unrelated to journald's production budget.
        mock.patch.object(self.mod, "JOURNAL_TIMEOUT_S", 5).start()
        self.now = time.time()
        self.service = {"name": "voice-worker-rust", "main_pid": 44,
                        "active_state": "active", "active_since_ms": int((self.now-7200)*1000),
                        "mem_bytes": 1000, "mem_high_bytes": 2000}
        self.write_fixture()

    def write_cache(self, **changes):
        path = self.root / "cache.json"
        mock.patch.object(self.mod, "JOURNAL_CACHE_PATH", str(path), create=True).start()
        cache = {"schema": "host-journal-cache/1", "ok": True,
                 "collected_at_ms": int(time.time()*1000), "errors": [],
                 "units": {"voice-worker-rust": {
                     "main_pid": 44, "active_since_ms": self.service["active_since_ms"],
                     "worker_link": {"unit": "voice-worker-rust", "state": "registered", "journal_ok": True},
                     "sidecar": {"journal_ok": True, "unavailable_1h": 0, "last_connected_ms": 123,
                                 "last_connected_mode": "spawned"}, "device_cmd": None}}}
        cache.update(changes)
        path.write_text(json.dumps(cache))
        return path

    def write_fixture(self, **data):
        self.fixture.write_text(json.dumps(data))

    def sidecar_fixture(self):
        mock.patch.object(self.mod, "sidecar_processes", return_value=[{
            "pid": 45, "ppid": 44, "rss_bytes": 80, "age_s": 120,
            "sock": "/tmp/eot.sock", "unit": "voice-worker-rust"}]).start()
        mock.patch.object(self.mod, "listening_unix_socks", return_value={"/tmp/eot.sock"}).start()
        mock.patch.object(self.mod, "proc_env_value", return_value="/tmp/eot.sock").start()

    def test_journal_no_matches_is_valid_but_command_error_is_unknown(self):
        self.write_fixture(rc=1)
        self.assertEqual(list(self.mod.journal_lines("empty", grep="event")), [])
        self.write_fixture(rc=1, stderr="Failed to open journal: Permission denied")
        rows = self.mod.journal_lines("denied", grep="event")
        self.assertFalse(getattr(rows, "ok", True), "permission error must not become successful zero events")
        self.assertTrue(any("Permission denied" in e for e in self.mod.errors))

    def test_other_nonzero_exit_is_not_silently_successful(self):
        with self.assertRaises(RuntimeError):
            self.mod.run([sys.executable, "-c", "import sys;sys.stderr.write('failed');sys.exit(2)"])

    def test_link_and_sidecar_share_filtered_ansi_aware_journal(self):
        self.sidecar_fixture()
        self.write_fixture(rows=[
            f"{self.now-100} host worker: connected to livekit \u001b[3magent_name\u001b[0m=rust-worker",
            f"{self.now-99} host worker: registered worker",
            f"{self.now-98} host worker: EOT sidecar connected (spawned)",
            f"{self.now-10} host worker: audio packet unrelated",
        ])
        link = self.mod.worker_link_block("voice-worker-rust", self.service["active_since_ms"])
        sidecar = self.mod.sidecars_block([self.service])[0]
        self.assertEqual(link["state"], "registered")
        self.assertEqual(link["agent_name"], "rust-worker")
        self.assertEqual(sidecar["last_connected_mode"], "spawned")
        self.assertEqual(sidecar["state"], "ok")
        self.assertEqual(link["journal_lines_window"], 3, "unrelated high-volume logs must be filtered")
        self.assertEqual(len(self.calls.read_text().splitlines()), 1, "same-generation evidence must be read once")

    def test_truncated_journal_does_not_report_exact_counts_or_registered(self):
        mock.patch.object(self.mod, "JOURNAL_MAX_LINES", 2, create=True).start()
        self.write_fixture(rows=[
            f"{self.now-100} h w: registered worker",
            f"{self.now-30} h w: worker connection failed error=temporary",
            f"{self.now-20} h w: registered worker",
        ])
        result = self.mod.worker_link_block("voice-worker-rust", self.service["active_since_ms"])
        self.assertFalse(result.get("journal_ok", True))
        self.assertTrue(result.get("journal_truncated", False))
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["failures_24h"])
        self.assertIsNone(result["registrations_window"])

    def test_reverse_journal_keeps_latest_registration_as_current_state(self):
        self.write_fixture(rows=[
            f"{self.now-30} h w: registered worker",
            f"{self.now-20} h w: worker connection failed error=temporary",
            f"{self.now-10} h w: registered worker",
        ])
        result = self.mod.worker_link_block("voice-worker-rust", self.service["active_since_ms"])
        self.assertEqual(result["state"], "registered")
        self.assertEqual(result["consecutive_failures_since_register"], 0)
        self.assertEqual(result["failures_24h"], 1)

    def test_failed_shared_journal_is_cached_for_sidecar_too(self):
        self.sidecar_fixture()
        self.write_fixture(rc=2, stderr="cannot read journal")
        link = self.mod.worker_link_block("voice-worker-rust", self.service["active_since_ms"])
        sidecar = self.mod.sidecars_block([self.service])[0]
        self.assertEqual(link["state"], "unknown")
        self.assertEqual(sidecar["state"], "unknown")
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)

    def test_sidecar_log_failure_keeps_process_evidence_without_fake_healthy(self):
        self.sidecar_fixture()
        self.write_fixture(rc=2, stderr="journal unavailable")
        result = self.mod.sidecars_block([self.service])[0]
        self.assertEqual(result["pid"], 45)
        self.assertTrue(result["listening"])
        self.assertEqual(result["state"], "unknown")
        self.assertFalse(result.get("journal_ok", True))
        self.assertIsNone(result["unavailable_1h"])

    def test_device_stats_do_not_turn_failed_collection_into_zero_commands(self):
        self.write_fixture(rc=2, stderr="journal unavailable")
        result = self.mod.device_cmd_block([self.service])
        self.assertEqual(result, [])
        self.assertTrue(self.mod.errors)

    def test_slow_journal_still_returns_basic_host_services_within_total_budget(self):
        self.sidecar_fixture()
        self.write_fixture(sleep=1)
        mock.patch.object(self.mod, "COLLECTION_BUDGET_S", 0.35, create=True).start()
        mock.patch.object(self.mod, "JOURNAL_TIMEOUT_S", 0.8).start()
        mock.patch.object(self.mod, "host_block", return_value={"mem_total_mb": 8000, "mem_avail_mb": 6000}).start()
        mock.patch.object(self.mod, "services_block", return_value=[self.service]).start()
        mock.patch.object(self.mod, "read_livekit_host", return_value=None).start()
        mock.patch.object(sys, "argv", ["host-stats.py", "--role", "worker"]).start()
        stream = io.StringIO()
        started = time.monotonic()
        with contextlib.redirect_stdout(stream):
            self.mod.main()
        elapsed = time.monotonic() - started
        result = json.loads(stream.getvalue())
        self.assertLess(elapsed, 0.8)
        self.assertEqual(result["host"]["mem_avail_mb"], 6000)
        self.assertEqual(result["services"][0]["active_state"], "active")
        self.assertEqual(result["rust_active"], "active")
        self.assertTrue(result["errors"])
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        self.assertLessEqual(len(calls), 2, "global budget must stop later optional queries")

    def test_timeout_terminates_process_group(self):
        marker = self.root / "orphan.txt"
        child_code = "import pathlib,time;time.sleep(.6);pathlib.Path(" + repr(str(marker)) + ").write_text('orphan')"
        parent_code = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "]);time.sleep(5)"
        with self.assertRaises(subprocess.TimeoutExpired):
            self.mod.run([sys.executable, "-c", parent_code], timeout=0.3)
        time.sleep(0.7)
        self.assertFalse(marker.exists(), "timed-out collector must not leave journal/helper descendants alive")

    def test_global_deadline_keeps_services_already_collected(self):
        mock.patch.object(self.mod, "COLLECTION_BUDGET_S", 0.08).start()
        mock.patch.object(self.mod, "host_block", return_value={"mem_avail_mb": 6000}).start()
        mock.patch.object(self.mod, "unit_exists", return_value=True).start()
        def service(unit):
            if unit == "voice-worker-rust":
                return self.service
            time.sleep(1)
            return {"name": unit}
        mock.patch.object(self.mod, "service_block", side_effect=service).start()
        result = self.mod.collect_snapshot("worker")
        self.assertEqual(result["services"], [self.service])
        self.assertEqual(result["rust_active"], "active")
        self.assertTrue(result["partial"])
        self.assertIsNone(self.mod._deadline)

    def test_exhausted_budget_does_not_spawn_more_commands(self):
        marker = self.root / "should-not-start.txt"
        self.mod._deadline = time.monotonic() - 1
        code = "from pathlib import Path;Path(" + repr(str(marker)) + ").touch()"
        with self.assertRaises(self.mod.CollectionDeadline):
            self.mod.run([sys.executable, "-c", code])
        self.assertFalse(marker.exists())

    def test_normal_snapshot_uses_fresh_generation_cache_without_journal_process(self):
        self.sidecar_fixture()
        self.write_cache()
        self.write_fixture(sleep=1)
        mock.patch.object(self.mod, "host_block", return_value={"mem_avail_mb": 6000}).start()
        mock.patch.object(self.mod, "services_block", return_value=[self.service]).start()
        mock.patch.object(self.mod, "read_livekit_host", return_value=None).start()
        result = self.mod.collect_snapshot("worker")
        self.assertEqual(result.get("journal_cache", {}).get("state"), "fresh")
        self.assertEqual(result["connections"]["worker_links"][0]["state"], "registered")
        self.assertEqual(result["sidecars"][0]["state"], "ok")
        self.assertFalse(self.calls.exists(), "regular status must never launch journalctl")

    def test_invalid_cache_cannot_report_old_registration_or_zero_errors(self):
        self.sidecar_fixture()
        mock.patch.object(self.mod, "host_block", return_value={"mem_avail_mb": 6000}).start()
        mock.patch.object(self.mod, "services_block", return_value=[self.service]).start()
        mock.patch.object(self.mod, "read_livekit_host", return_value=None).start()
        for mode in ("missing", "stale", "generation_mismatch", "error"):
            with self.subTest(mode=mode):
                path = self.write_cache()
                data = json.loads(path.read_text())
                if mode == "missing":
                    path.unlink()
                else:
                    if mode == "stale": data["collected_at_ms"] -= 181000
                    if mode == "generation_mismatch": data["units"]["voice-worker-rust"]["main_pid"] = 99
                    if mode == "error": data.update(ok=False, errors=["refresh failed"])
                    path.write_text(json.dumps(data))
                result = self.mod.collect_snapshot("worker")
                self.assertEqual(result.get("journal_cache", {}).get("state"), mode)
                link = result["connections"]["worker_links"][0]
                self.assertEqual(link["state"], "unknown")
                self.assertIsNone(link["failures_24h"])
                self.assertEqual(result["sidecars"][0]["state"], "unknown")
                self.assertIsNone(result["sidecars"][0]["unavailable_1h"])
                self.assertTrue(result["errors"])
                self.assertFalse(self.calls.exists())

    def test_refresh_cache_is_atomic_private_and_does_not_store_child_text(self):
        path = self.write_cache()
        mock.patch.object(self.mod, "services_block", return_value=[self.service]).start()
        self.write_fixture(rows=[
            f"{self.now-30} h w: registered worker",
            f"{self.now-29} h w: EOT sidecar connected (spawned)",
            f"{self.now-20} h w: device command proposed: '请帮我调亮灯光' room=sn-BJP00326070803800006-123 semantic_label=1 lane=L2",
        ])
        self.assertTrue(self.mod.refresh_journal_cache())
        data = json.loads(path.read_text())
        self.assertTrue(data["ok"])
        self.assertEqual(data["units"]["voice-worker-rust"]["main_pid"], 44)
        self.assertEqual(data["units"]["voice-worker-rust"]["worker_link"]["state"], "registered")
        self.assertNotIn("请帮我调亮灯光", path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_failed_refresh_invalidates_previous_successful_cache(self):
        path = self.write_cache()
        mock.patch.object(self.mod, "services_block", return_value=[self.service]).start()
        self.write_fixture(rc=2, stderr="journal unavailable")
        self.assertFalse(self.mod.refresh_journal_cache())
        data = json.loads(path.read_text())
        self.assertFalse(data["ok"])
        self.assertTrue(data["errors"])

    def test_failed_systemd_stop_marks_cache_invalid_but_success_preserves_it(self):
        path = self.write_cache()
        before = path.read_bytes()
        with mock.patch.dict(os.environ, {"SERVICE_RESULT": "success"}):
            self.mod.invalidate_failed_refresh()
        self.assertEqual(path.read_bytes(), before)
        with mock.patch.dict(os.environ, {"SERVICE_RESULT": "timeout"}):
            self.mod.invalidate_failed_refresh()
        self.assertFalse(json.loads(path.read_text())["ok"])

    def test_refresh_cli_cache_write_failure_exits_nonzero_for_systemd(self):
        code = '''
import runpy,sys
from unittest import mock
sys.argv=[sys.argv[1], '--refresh-journal-cache']
with mock.patch('pathlib.Path.mkdir'), mock.patch('tempfile.NamedTemporaryFile',side_effect=OSError('cache write failed')):
    runpy.run_path(sys.argv[0],run_name='__main__')
'''
        result = subprocess.run([sys.executable, "-c", code, str(SCRIPT)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, "systemd must see the refresh failure and run invalidation")
        self.assertIn("cache write failed", json.loads(result.stdout)["errors"][0])

    def test_failed_stop_preserves_specific_refresh_diagnostic(self):
        path = self.write_cache(ok=False, errors=["journal voice-worker-rust: timed out after 15s"])
        with mock.patch.dict(os.environ, {"SERVICE_RESULT": "exit-code"}):
            self.mod.invalidate_failed_refresh()
        data = json.loads(path.read_text())
        self.assertFalse(data["ok"])
        self.assertIn("journal voice-worker-rust: timed out after 15s", data["errors"])
        self.assertIn("refresh service failed: exit-code", data["errors"])

    def test_failed_invalidation_write_removes_only_old_cache_and_raises(self):
        path = self.write_cache()
        neighbor = self.root / "keep.txt"
        neighbor.write_text("keep")
        with mock.patch.dict(os.environ, {"SERVICE_RESULT": "timeout"}), \
                mock.patch.object(self.mod, "atomic_cache_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.mod.invalidate_failed_refresh()
        self.assertFalse(path.exists(), "failed invalidation must not leave a successful cache visible")
        self.assertEqual(neighbor.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
