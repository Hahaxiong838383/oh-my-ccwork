from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CHECKER = ROOT / "h-platform-daily-ops.py"
WRAPPER = ROOT / "daily-readonly-check"
PROMPT = ROOT / "codeg-automation-prompt.txt"
README = ROOT / "README.md"
SERVICE = ROOT / "systemd/h-platform-daily-ops.service"
TIMER = ROOT / "systemd/h-platform-daily-ops.timer"

MEMORY_REFS = [
    "project_feishu_grok_h_byos",
    "feedback_tenant_capability_drift_mechanism",
    "feedback_identifier_shape_is_not_identity",
    "feedback_concurrent_sessions_shared_checkout",
]


def load_checker():
    spec = importlib.util.spec_from_file_location("h_platform_daily_ops", CHECKER)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ContractTest(unittest.TestCase):
    def test_checker_accepts_in_sync_release_with_zero_mismatches(self) -> None:
        checker = load_checker()
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        control = {
            "ok": True,
            "tokenManager": {
                "lastSweepAt": now,
                "lastSweep": {"errors": 0, "revoked": 0},
            },
            "tunnel": {"ok": True, "down": False},
            "release": {"state": "in_sync", "mismatchCount": 0},
        }

        self.assertEqual(checker.evaluate(control, None, []), [])

    def test_checker_classifies_control_and_tenant_drift(self) -> None:
        checker = load_checker()
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        control = {
            "ok": True,
            "tokenManager": {
                "lastSweepAt": now,
                "lastSweep": {"errors": 0, "revoked": 0},
            },
            "tunnel": {"ok": True, "down": False},
            "release": {"state": "drifted", "mismatchCount": 2},
        }
        health = {
            "ok": True,
            "apps": 17,
            "connected": 17,
            "errors": 0,
            "contracts": ["v1"],
            "topContract": "v1",
            "outboxPending": 0,
            "outboxRetrying": 0,
            "runnerConnected": True,
            "runnerApps": 17,
            "rpcOrphaned": 0,
            "durableEnabled": True,
            "deployDirty": False,
        }
        execution = {
            "services": {"bridge": "active", "runner": "active", "xray": "active"},
            "timers": {"tenantParity": "active", "sqliteMaintenance": "active"},
            "healthRc": 0,
            "health": health,
            "tenantParity": {"rc": 1, "userLag": 5, "platformLag": 0},
            "memory": {"rc": 0, "bad": 0, "checked": 16},
            "refresh": {"result": "success", "status": "0"},
            "failedPlatformUnits": [],
            "diskUsedPercent": 50,
            "journalErrorLines24h": 0,
        }

        issues = checker.evaluate(control, execution, [])
        self.assertEqual(
            [item["code"] for item in issues],
            ["control_release_drift", "tenant_parity_lag"],
        )
        self.assertEqual(checker.status_for(issues), "WARNING")

    def test_wrapper_emits_sanitized_issues_and_all_memory_refs(self) -> None:
        report = {
            "checkedAt": "2026-08-30T08:00:00Z",
            "status": "WARNING",
            "issues": [
                {
                    "code": "control_release_drift",
                    "level": "warning",
                    "message": "控制面发布态 drifted，差异 2 项",
                    "privateDetail": "must-not-leak",
                },
                "ignored-non-object",
            ],
            "summary": {"apps": 17, "connected": 17},
        }
        with tempfile.TemporaryDirectory() as directory:
            report_path = pathlib.Path(directory) / "latest.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            env = os.environ.copy()
            env.update({
                "H_PLATFORM_DAILY_REPORT": str(report_path),
                "H_PLATFORM_DAILY_SKIP_RUN": "1",
                "H_PLATFORM_DAILY_SERVICE_RC": "0",
            })
            completed = subprocess.run(
                ["bash", str(WRAPPER)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(completed.stdout.splitlines()), 1)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["issueCount"], 1)
        self.assertEqual(
            payload["issues"],
            [{
                "code": "control_release_drift",
                "level": "warning",
                "message": "控制面发布态 drifted，差异 2 项",
            }],
        )
        self.assertNotIn("privateDetail", completed.stdout)
        self.assertEqual(payload["memoryRefs"], MEMORY_REFS)

    def test_prompt_and_readme_pin_memory_routes_and_placement(self) -> None:
        prompt = PROMPT.read_text(encoding="utf-8")
        readme = README.read_text(encoding="utf-8")
        for key in MEMORY_REFS:
            self.assertIn(key, prompt)
            self.assertIn(key, readme)
        self.assertIn("control_release_drift → project_feishu_grok_h_byos", prompt)
        self.assertIn(
            "tenant_parity_lag → feedback_tenant_capability_drift_mechanism",
            prompt,
        )
        self.assertIn("禁止修改任何文件、数据库或任务", prompt)
        self.assertIn("Mini 不在 dev198 tenant parity 的覆盖范围内", readme)
        self.assertIn("智能助手_产品专家", readme)
        self.assertIn("AI 专家", readme)

    def test_systemd_timer_is_static_and_checker_has_no_remote_mutators(self) -> None:
        timer = TIMER.read_text(encoding="utf-8")
        service = SERVICE.read_text(encoding="utf-8")
        checker = CHECKER.read_text(encoding="utf-8")
        self.assertNotIn("[Install]", timer)
        self.assertNotIn("WantedBy=", timer)
        self.assertIn("Codeg automation ID 4", timer)
        self.assertIn("Type=oneshot", service)
        self.assertIn("--systemd", service)
        for forbidden in (
            "systemctl --user restart",
            "systemctl --user stop",
            "systemctl --user disable",
            "git commit",
            "git push",
            "--fix",
        ):
            self.assertNotIn(forbidden, checker)


if __name__ == "__main__":
    unittest.main()
