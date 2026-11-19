"""Exercise boot fault branches and real temporary-file installation rollback."""
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import install
import plymouth_guard as guard


class Machine:
    def __init__(self):
        self.wait = {"ActiveState": "activating", "SubState": "start", "Result": "success", "ExecMainStatus": "0"}
        self.gdm = {"ActiveState": "active", "SubState": "running", "MainPID": "1357", "ActiveEnterTimestampMonotonic": "17000000"}
        self.ports = {"DP-1": "disconnected", "DP-2": "disconnected", "HDMI-A-1": "disconnected", "HDMI-A-2": "disconnected"}
        self.t = 90
        self.alive = True
        self.calls = []
        self.quit_effect = "success"

    def unit(self, name):
        return copy.deepcopy(self.wait if name == guard.WAIT else self.gdm)

    def displays(self):
        return self.ports.copy()

    def daemon(self):
        return 335, self.identity(335)

    def identity(self, pid):
        return "12" if self.alive else None

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds

    def quit(self):
        self.calls.append("quit")
        if self.quit_effect == "timeout":
            raise subprocess.TimeoutExpired("plymouth", 10)
        if self.quit_effect == "stuck":
            return 0
        self.alive = False
        self.wait.update(ActiveState="active", SubState="exited")
        if self.quit_effect == "wait_failed":
            self.wait.update(ActiveState="failed", Result="timeout", ExecMainStatus="15")
        if self.quit_effect == "gdm_restarted":
            self.gdm["MainPID"] = "2000"
        return 0


class GuardTests(unittest.TestCase):
    def test_known_headless_hang_finishes_once_and_then_noops(self):
        m = Machine()
        self.assertEqual(guard.finish(m)["result"], "completed")
        self.assertFalse(m.alive)
        self.assertEqual(m.gdm["MainPID"], "1357")
        self.assertEqual(guard.finish(m)["action"], "noop")
        self.assertEqual(m.calls, ["quit"])

    def test_unsafe_states_never_quit(self):
        mutations = [
            lambda m: m.ports.clear(),
            lambda m: m.ports.update({"DP-1": "connected"}),
            lambda m: m.ports.update({"DP-1": "unknown"}),
            lambda m: m.gdm.update(ActiveState="failed"),
            lambda m: m.gdm.update(MainPID="0"),
            lambda m: m.gdm.update(ActiveEnterTimestampMonotonic="0"),
            lambda m: m.wait.update(ActiveState="failed", Result="timeout"),
            lambda m: m.wait.update(ActiveState="inactive"),
            lambda m: m.wait.update(ActiveState="active", SubState="exited", ExecMainStatus="1"),
            lambda m: setattr(m, "alive", False),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                m = Machine()
                mutate(m)
                with self.assertRaises(RuntimeError):
                    guard.finish(m)
                self.assertEqual(m.calls, [])

    def test_slow_gdm_gets_one_bounded_grace_period(self):
        m = Machine()
        m.gdm["ActiveEnterTimestampMonotonic"] = "85000000"
        self.assertEqual(guard.finish(m)["result"], "completed")
        self.assertEqual(m.t, 100)
        self.assertEqual(m.calls, ["quit"])

    def test_gdm_failing_during_grace_is_not_touched(self):
        m = Machine()
        m.gdm["ActiveEnterTimestampMonotonic"] = "85000000"
        def failing_sleep(seconds):
            m.t += seconds
            m.gdm["ActiveState"] = "failed"
        m.sleep = failing_sleep
        with self.assertRaises(RuntimeError):
            guard.finish(m)
        self.assertEqual(m.calls, [])

    def test_unreadable_drm_and_bad_pid_never_quit(self):
        for method in ("displays", "daemon"):
            m = Machine()
            with patch.object(m, method, side_effect=OSError("unreadable")):
                with self.assertRaises(OSError):
                    guard.finish(m)
            self.assertEqual(m.calls, [])

    def test_hotplug_between_checks_never_quits(self):
        m = Machine()
        with patch.object(m, "displays", side_effect=[m.ports, {"DP-1": "connected"}]):
            with self.assertRaises(RuntimeError):
                guard.finish(m)
        self.assertEqual(m.calls, [])

    def test_successful_command_without_recovery_is_failure(self):
        for effect in ("stuck", "wait_failed", "gdm_restarted"):
            with self.subTest(effect=effect):
                m = Machine()
                m.quit_effect = effect
                with self.assertRaises(RuntimeError):
                    guard.finish(m)
                self.assertEqual(m.calls, ["quit"])

    def test_quit_timeout_surfaces(self):
        m = Machine()
        m.quit_effect = "timeout"
        with self.assertRaises(subprocess.TimeoutExpired):
            guard.finish(m)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="home-studio-boot-test-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.files = {src: str(root / "system" / Path(dest).name) for src, dest in install.FILES.items()}
        self.manifest = root / "state" / "manifest.json"
        for name, value in (("FILES", self.files), ("STATE", self.manifest.parent), ("MANIFEST", self.manifest)):
            p = patch.object(install, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(install, "trusted_parent", side_effect=lambda path: path.parent.mkdir(parents=True, exist_ok=True))
        p.start()
        self.addCleanup(p.stop)
        self.commands = []

    def command(self, *args):
        self.commands.append(args)
        if args[0] == "/usr/bin/python3":
            self.assertFalse(Path(self.files["90-home-studio-bounded-wait.conf"]).exists())

    def test_install_then_real_file_rollback(self):
        with patch.object(install, "run", side_effect=self.command), patch.object(install.os, "sync"):
            install.install()
            for name in self.files.values():
                self.assertTrue(Path(name).is_file())
            install.uninstall()
        self.assertFalse(self.manifest.exists())
        self.assertTrue(all(not Path(name).exists() for name in self.files.values()))
        self.assertTrue(all("gdm.service" not in c and "plymouth-quit.service" not in c for c in self.commands))

    def test_failed_live_repair_removes_new_files(self):
        with patch.object(install, "run", side_effect=[RuntimeError("quit failed"), None]), patch.object(install.subprocess, "run"):
            with self.assertRaises(RuntimeError):
                install.install()
        self.assertFalse(self.manifest.exists())
        self.assertTrue(all(not Path(name).exists() for name in self.files.values()))

    def test_preexisting_file_is_never_overwritten(self):
        target = Path(next(iter(self.files.values())))
        target.parent.mkdir(parents=True)
        target.write_text("other administrator content")
        with patch.object(install, "run") as command:
            with self.assertRaises(RuntimeError):
                install.install()
            command.assert_not_called()
        self.assertEqual(target.read_text(), "other administrator content")

    def test_rollback_refuses_concurrent_edit(self):
        with patch.object(install, "run", side_effect=self.command), patch.object(install.os, "sync"):
            install.install()
        target = Path(next(iter(self.files.values())))
        target.write_text("changed after install")
        with patch.object(install, "run") as command:
            with self.assertRaises(RuntimeError):
                install.uninstall()
            command.assert_not_called()
        self.assertEqual(target.read_text(), "changed after install")


if __name__ == "__main__":
    unittest.main()
