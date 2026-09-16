"""Installer safety checks: mocked API only; no deployment or live probe."""
from __future__ import annotations

import importlib.util
import io
import fcntl
from contextlib import redirect_stderr
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("install_gate_under_test", ROOT / "install_gate.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallGateSafetyTest(unittest.TestCase):
    def setUp(self):
        self.draft = {key: None for key in installer.DRAFT_KEYS}
        self.draft.update(
            name="H daily", enabled=True, trigger_kind="manual", agent_type="codex",
            config={"config_values": {"model": "gpt-5.6-luna"},
                    "mode_id": "preserve-existing-mode", "unknown_future_setting": 123},
        )

    def test_update_success_is_read_back(self):
        with patch.object(installer, "api", side_effect=[None, self.draft]) as api:
            self.assertEqual(installer.update_confirmed(self.draft), self.draft)
        self.assertEqual([call.args[0] for call in api.call_args_list],
                         ["automation_update", "automation_get"])
        self.assertEqual(api.call_args_list[0].args[1], {"id": 4, "draft": self.draft})

    def test_lost_update_reply_is_confirmed_without_repeating_write(self):
        with patch.object(installer, "api", side_effect=[installer.InstallError("timeout"), self.draft]) as api:
            self.assertEqual(installer.update_confirmed(self.draft), self.draft)
        self.assertEqual([call.args[0] for call in api.call_args_list],
                         ["automation_update", "automation_get"])

    def test_uncertain_update_and_different_config_refuse_retry(self):
        foreign = dict(self.draft, name="someone else's edit")
        with patch.object(installer, "api", side_effect=[installer.InstallError("timeout"), foreign]) as api:
            with self.assertRaises(installer.InstallError):
                installer.update_confirmed(self.draft)
        self.assertEqual(api.call_count, 2)
        self.assertEqual([call.args[0] for call in api.call_args_list].count("automation_update"), 1)

    def test_existing_running_session_is_never_cancelled(self):
        with patch.object(installer, "api", return_value=[{"id": 99, "status": "running"}]) as api:
            with patch.object(installer, "systemctl") as systemctl:
                with self.assertRaises(installer.InstallError):
                    installer.require_idle()
        api.assert_called_once_with("automation_runs", {"automationId": 4, "limit": 100})
        systemctl.assert_not_called()

    def test_existing_queued_session_blocks_installation(self):
        self._assert_nonrunning_active_state_blocks("queued")

    def test_existing_pending_session_blocks_installation(self):
        self._assert_nonrunning_active_state_blocks("pending")

    def _assert_nonrunning_active_state_blocks(self, status):
        with patch.object(installer, "api", return_value=[{"id": 99, "status": status}]) as api:
            with patch.object(installer, "systemctl") as systemctl:
                with self.assertRaises(installer.InstallError):
                    installer.require_idle()
        api.assert_called_once_with("automation_runs", {"automationId": 4, "limit": 100})
        systemctl.assert_not_called()

    def test_lost_folder_creation_reply_is_observed_not_repeated(self):
        folder = {"id": 22, "path": str(installer.WORKSPACE)}
        with patch.object(installer, "api", side_effect=[[], installer.InstallError("timeout"), [folder]]) as api:
            self.assertEqual(installer.workspace_folder_id(), 22)
        self.assertEqual([call.args[0] for call in api.call_args_list],
                         ["list_all_folder_details", "open_folder", "list_all_folder_details"])

    def test_draft_is_deep_copy_and_preserves_extra_config(self):
        source = dict(self.draft, id=4, next_run_at=None, created_at="2026-09-01")
        copied = installer.draft_of(source)
        self.assertEqual(set(copied), set(installer.DRAFT_KEYS))
        self.assertEqual(copied["config"]["mode_id"], "preserve-existing-mode")
        copied["config"]["unknown_future_setting"] = 0
        self.assertEqual(source["config"]["unknown_future_setting"], 123)

    def test_service_budget_includes_collection_model_and_api_overhead(self):
        text = (ROOT / "systemd/h-platform-daily-gate.service").read_text(encoding="utf-8")
        self.assertIn("TimeoutStartSec=25min", text.splitlines())
        self.assertGreater(25 * 60, 330 + 600 + 8 * 60)

    def test_cli_gate_lock_blocks_apply_and_rollback_without_actions(self):
        for option in ("--apply", "--rollback"):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                with (state / "gate.lock").open("a") as runner_lock:
                    fcntl.flock(runner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with patch.object(installer, "STATE", state), \
                            patch.object(installer, "apply") as apply, \
                            patch.object(installer, "rollback") as rollback, \
                            patch.object(installer, "api") as api, \
                            patch.object(installer, "systemctl") as systemctl, \
                            redirect_stderr(io.StringIO()) as stderr:
                        self.assertEqual(installer.main([option]), 1)
                        self.assertIn("另一轮门控尚在运行", stderr.getvalue())
                    apply.assert_not_called()
                    rollback.assert_not_called()
                    api.assert_not_called()
                    systemctl.assert_not_called()

    def test_both_locks_are_held_during_apply_and_rollback_and_released_after(self):
        for option, operation in (("--apply", "apply"), ("--rollback", "rollback")):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)

                def verify_held(*args):
                    for filename in ("install.lock", "gate.lock"):
                        with (state / filename).open("a") as contender:
                            with self.assertRaises(BlockingIOError):
                                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)

                with patch.object(installer, "STATE", state), \
                        patch.object(installer, operation, side_effect=verify_held) as action:
                    self.assertEqual(installer.main([option]), 0)
                    action.assert_called_once()
                for filename in ("install.lock", "gate.lock"):
                    with (state / filename).open("a") as contender:
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_install_lock_conflict_does_not_acquire_runner_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with (state / "install.lock").open("a") as other_installer:
                fcntl.flock(other_installer, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(installer, "STATE", state), \
                        patch.object(installer, "apply") as apply, \
                        redirect_stderr(io.StringIO()):
                    self.assertEqual(installer.main(["--apply"]), 1)
                self.assertFalse((state / "gate.lock").exists())
                apply.assert_not_called()


if __name__ == "__main__":
    unittest.main()
