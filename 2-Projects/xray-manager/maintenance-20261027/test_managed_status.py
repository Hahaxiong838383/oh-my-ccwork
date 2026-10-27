import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import managed_status as status


class ManagedStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "xray"
        self.runtime = self.home / "company-lisa-failover"
        self.runtime.mkdir(parents=True)
        self.now = 1000.0
        self.calls = []
        self.override = "cf-dmit"
        self.launch_returncode = 0
        self.launch_stdout = "state = running\n pid = 123\n"
        self.api_returncode = 0
        self.api_stdout = None
        self.exception = None
        self.config = {"balancer": "cf-lisa", "api": "127.0.0.1:14991",
                       "tags": {"dmit": "cf-dmit", "zgo": "cf-zgo",
                                "home": "cf-home", "block": "cf-block"},
                       "secret": "credential-not-for-output"}
        self.state = {"updated_at": 995.0, "selected": "dmit", "status": "OK",
                      "last_good_at": 994.0, "last_good_route": "dmit",
                      "probes": {name: {"https": {"ok": True, "http": "204", "exit": 0, "kind": "ok"},
                                        "codex": {"ok": True, "http": "401", "exit": 0, "kind": "ok"}}
                                 for name in ("dmit", "zgo", "home")}}
        self.write("controller.json", self.config)
        self.write("state.json", self.state)

    def write(self, name, value):
        (self.runtime / name).write_text(json.dumps(value), encoding="utf-8")

    def run_command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if self.exception:
            raise self.exception
        if args[0] == "/bin/launchctl":
            return subprocess.CompletedProcess(args, self.launch_returncode, self.launch_stdout, "secret-stderr")
        if "api" in args and "bi" in args:
            output = self.api_stdout if self.api_stdout is not None else "Selecting Override:\n  1 " + self.override + "\n"
            return subprocess.CompletedProcess(args, self.api_returncode, output, "secret-stderr")
        self.fail("unexpected command")

    def collect(self):
        return status.collect_managed_status(self.home, now=self.now, runner=self.run_command)

    def test_healthy_requires_fresh_process_probes_and_actual_override(self):
        result = self.collect()
        self.assertEqual(result.get("overall", {}).get("status"), "healthy")
        self.assertEqual(result["routing"]["effective_route"], "dmit")
        self.assertEqual(result["controller"]["age_seconds"], 5.0)
        self.assertIsNone(result["updater"]["applied"])

    def test_commands_are_bounded_and_read_only(self):
        self.collect()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][0][:2], ["/bin/launchctl", "print"])
        self.assertEqual(self.calls[1][0], [str(self.home / "xray"), "api", "bi", "--server=127.0.0.1:14991", "cf-lisa"])
        for _, kwargs in self.calls:
            self.assertLessEqual(kwargs["timeout"], 1.5)
            self.assertNotIn("shell", kwargs)

    def test_missing_state_is_not_healthy(self):
        (self.runtime / "state.json").unlink()
        result = self.collect()
        self.assertFalse(result["controller"]["fresh"])
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_corrupt_state_does_not_expose_contents(self):
        (self.runtime / "state.json").write_text("private-credential-content")
        result = self.collect()
        self.assertNotEqual(result["overall"]["status"], "healthy")
        self.assertNotIn("private-credential-content", json.dumps(result))

    def test_stale_probe_results_cannot_appear_healthy(self):
        self.state["updated_at"] = 900
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["overall"]["status"], "stale")
        self.assertFalse(result["controller"]["fresh"])
        for route in result["routes"]:
            self.assertFalse(route["fresh"])
            self.assertIsNone(route["service_ok"])
            self.assertIsNone(route["probes"]["codex"]["ok"])

    def test_future_timestamp_is_not_fresh(self):
        self.state["updated_at"] = 1100
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["overall"]["status"], "stale")
        self.assertEqual(result["controller"]["error_code"], "state_clock_skew")

    def test_stopped_controller_does_not_inherit_green_state(self):
        self.launch_returncode = 113
        result = self.collect()
        self.assertEqual(result["controller"]["process"], "stopped")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_unknown_controller_process_is_not_healthy(self):
        self.launch_stdout = "state = waiting\n"
        result = self.collect()
        self.assertEqual(result["controller"]["process"], "unknown")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_controller_error_code_is_whitelisted(self):
        self.state.update(status="CONTROL_ERROR", error_code="production_config_drift_stop")
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["overall"]["status"], "error")
        self.assertEqual(result["controller"]["error_code"], "production_config_drift_stop")
        self.state["error_code"] = "Bearer private-token"
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["controller"]["error_code"], "unexpected_error")
        self.assertNotIn("private-token", json.dumps(result))

    def test_subprocess_timeout_does_not_leak_command_or_output(self):
        self.exception = subprocess.TimeoutExpired("private-command", 1, output="private-output")
        result = self.collect()
        self.assertNotEqual(result["overall"]["status"], "healthy")
        self.assertNotIn("private-", json.dumps(result))

    def test_foreign_override_is_not_echoed_or_trusted(self):
        self.override = "secret-foreign-tag"
        result = self.collect()
        self.assertEqual(result["routing"]["error_code"], "foreign_override")
        self.assertEqual(result["routing"]["effective_route"], "unknown")
        self.assertNotIn("secret-foreign-tag", json.dumps(result))

    def test_empty_override_does_not_claim_disk_default_is_active(self):
        self.override = ""
        (self.home / "config.json").write_text('{"routing":{"balancers":[{"tag":"cf-lisa","fallbackTag":"cf-block"}]}}')
        result = self.collect()
        self.assertEqual(result["routing"]["override"], "none")
        self.assertEqual(result["routing"]["effective_route"], "unknown")
        self.assertEqual(result["routing"]["error_code"], "default_route_unverified")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_actual_explicit_block_is_reported(self):
        self.override = "cf-block"
        self.state.update(selected="block", status="ALL_DOWN")
        self.write("state.json", self.state)
        self.assertEqual(self.collect()["overall"]["status"], "blocked")

    def test_state_and_actual_route_mismatch_is_not_green(self):
        self.override = "cf-zgo"
        result = self.collect()
        self.assertEqual(result["overall"]["reason_code"], "route_state_mismatch")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_partial_reachability_is_degraded(self):
        self.state["status"] = "DEGRADED"
        self.state["probes"]["dmit"]["codex"] = dict(ok=False, http="000", exit=28, kind="transport")
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["overall"]["status"], "degraded")
        self.assertTrue(result["routes"][0]["reachable"])
        self.assertFalse(result["routes"][0]["service_ok"])

    def test_http_rejection_cannot_be_green_even_with_stored_ok_flag(self):
        self.state["probes"]["dmit"]["codex"]["http"] = "403"
        self.write("state.json", self.state)
        result = self.collect()
        self.assertFalse(result["routes"][0]["service_ok"])
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_valid_pin_reports_remaining_ttl(self):
        self.write("pin.json", dict(route="dmit", expires=1050))
        result = self.collect()
        self.assertEqual(result["pin"], dict(active=True, route="dmit", remaining_seconds=50.0, error_code=None))
        self.assertEqual(result["overall"]["status"], "healthy")

    def test_expired_pin_does_not_claim_current_enforcement(self):
        self.write("pin.json", dict(route="block", expires=999))
        result = self.collect()
        self.assertFalse(result["pin"]["active"])
        self.assertEqual(result["pin"]["remaining_seconds"], 0)
        self.assertEqual(result["overall"]["status"], "healthy")

    def test_active_block_pin_mismatch_is_visible(self):
        self.write("pin.json", dict(route="block", expires=1050))
        result = self.collect()
        self.assertEqual(result["overall"]["reason_code"], "pin_route_mismatch")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_unreadable_pin_is_not_silently_auto(self):
        (self.runtime / "pin.json").write_text("private-pin-data")
        result = self.collect()
        self.assertEqual(result["pin"]["route"], "unknown")
        self.assertEqual(result["overall"]["status"], "error")
        self.assertNotIn("private-pin-data", json.dumps(result))

    def test_pending_marker_outweighs_updater_status_or_pid(self):
        (self.home / "rule-updater.pending.json").write_text(json.dumps(dict(version=1, status="pending_until_verified", asset_sha256={"geoip.dat": "a" * 64})))
        (self.home / "rule-updater.status").write_text(json.dumps(dict(status="ok", applied=True, xray_pid_after=999)))
        result = self.collect()
        self.assertTrue(result["updater"]["pending"])
        self.assertEqual(result["updater"]["status"], "pending_until_verified")
        self.assertEqual(result["updater"]["assets"], ["geoip.dat"])
        self.assertIsNone(result["updater"]["applied"])

    def test_no_marker_does_not_claim_updates_are_applied(self):
        (self.home / "rule-updater.status").write_text('{"status":"ok","applied":true}')
        result = self.collect()
        self.assertFalse(result["updater"]["pending"])
        self.assertEqual(result["updater"]["status"], "no_pending_record")
        self.assertIsNone(result["updater"]["applied"])

    def test_corrupt_pending_marker_is_unknown_not_clear(self):
        (self.home / "rule-updater.pending.json").write_text("private-marker-value")
        result = self.collect()
        self.assertIsNone(result["updater"]["pending"])
        self.assertEqual(result["updater"]["status"], "unknown")
        self.assertNotIn("private-marker-value", json.dumps(result))

    def test_no_managed_marker_does_not_probe_other_installation(self):
        (self.runtime / "controller.json").unlink()
        result = self.collect()
        self.assertFalse(result["managed"])
        self.assertEqual(self.calls, [])

    def test_config_cannot_redirect_status_command_to_remote_or_other_binary(self):
        self.config.update(api="remote.example:1234", xray="/private/secret-binary")
        self.write("controller.json", self.config)
        result = self.collect()
        self.assertEqual(result["routing"]["error_code"], "controller_config_invalid")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("remote.example", json.dumps(result))

    def test_extra_state_and_probe_values_are_never_exported(self):
        self.state.update(password="private-password", privateKey="private-key")
        self.state["probes"]["dmit"]["codex"]["authorization"] = "private-auth"
        self.state["probes"]["private-route"] = {"secret": "private-route-data"}
        self.write("state.json", self.state)
        result = self.collect()
        self.assertNotIn("private-", json.dumps(result))
        self.assertNotIn("credential-not-for-output", json.dumps(result))

    def test_oversized_state_is_rejected(self):
        (self.runtime / "state.json").write_text("private-overflow" * 40000)
        result = self.collect()
        self.assertNotEqual(result["overall"]["status"], "healthy")
        self.assertNotIn("private-overflow", json.dumps(result))

    def static_config(self):
        return {"routing": {"balancers": [{"tag": "cf-lisa", "selector": ["cf-block"],
                                            "fallbackTag": "cf-block"}]},
                "outbounds": [{"tag": "cf-block", "protocol": "blackhole"}]}

    def write_static(self, value):
        (self.home / "config.json").write_text(json.dumps(value))

    def test_static_blackhole_is_independent_of_live_override(self):
        self.write_static(self.static_config())
        self.override = ""
        result = self.collect()
        self.assertEqual(result["routing"]["static_default"], "block")
        self.assertEqual(result["routing"]["effective_route"], "unknown")
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_incomplete_or_ambiguous_static_config_is_unknown(self):
        for change in ("missing_fallback", "duplicate_balancer", "non_blackhole", "extra_selector", "prefix_collision"):
            with self.subTest(change=change):
                config = self.static_config()
                balancer = config["routing"]["balancers"][0]
                if change == "missing_fallback":
                    del balancer["fallbackTag"]
                elif change == "duplicate_balancer":
                    config["routing"]["balancers"].append(dict(balancer))
                elif change == "non_blackhole":
                    config["outbounds"][0]["protocol"] = "freedom"
                elif change == "extra_selector":
                    balancer["selector"].append("cf-dmit")
                else:
                    config["outbounds"].append({"tag": "cf-block-extra", "protocol": "freedom"})
                self.write_static(config)
                self.assertEqual(self.collect()["routing"]["static_default"], "unknown")

    def test_empty_probe_is_unknown_not_healthy(self):
        del self.state["probes"]["dmit"]["codex"]
        self.write("state.json", self.state)
        result = self.collect()
        self.assertIsNone(result["routes"][0]["service_ok"])
        self.assertNotEqual(result["overall"]["status"], "healthy")

    def test_stopped_controller_probe_cards_are_not_green(self):
        self.launch_returncode = 113
        self.assertTrue(all(route["service_ok"] is None for route in self.collect()["routes"]))

    def test_pinned_failed_route_can_fail_closed(self):
        self.write("pin.json", dict(route="dmit", expires=1050))
        self.override = "cf-block"
        self.state.update(status="PIN_UNAVAILABLE", selected="block")
        self.write("state.json", self.state)
        result = self.collect()
        self.assertEqual(result["overall"], dict(status="blocked", reason_code="pin_unavailable"))

    def test_failed_api_cannot_inherit_selected_route(self):
        self.api_returncode = 1
        result = self.collect()
        self.assertEqual(result["routing"]["effective_route"], "unknown")
        self.assertEqual(result["routing"]["error_code"], "routing_api_bi_failed")
        self.assertNotIn("secret-stderr", json.dumps(result))

    def test_ambiguous_api_format_is_unknown(self):
        self.api_stdout = "Selecting Override:\n  1 cf-dmit\nSelecting Override:\n  1 cf-zgo\n"
        self.assertEqual(self.collect()["routing"]["error_code"], "unknown_bi_format")

    def test_real_xray_dashed_output_is_supported(self):
        self.api_stdout = "  - Selecting Override:\n    1   cf-dmit       \n  - Selects:\n    1   cf-block      \n"
        result = self.collect()
        self.assertEqual(result["routing"]["effective_route"], "dmit")
        self.assertEqual(result["overall"]["status"], "healthy")

    def test_real_xray_crlf_output_is_supported(self):
        self.api_stdout = "  - Selecting Override:\r\n    1   cf-dmit       \r\n  - Selects:\r\n    1   cf-block      \r\n"
        self.assertEqual(self.collect()["routing"]["effective_route"], "dmit")

    def test_real_xray_empty_override_does_not_use_selects(self):
        for ending in ("\n", "\r\n"):
            with self.subTest(ending=repr(ending)):
                self.api_stdout = ending.join(("  - Selecting Override:", "    1          ",
                                               "  - Selects:", "    1   cf-block      ", ""))
                result = self.collect()
                self.assertEqual(result["routing"]["override"], "none")
                self.assertEqual(result["routing"]["effective_route"], "unknown")
                self.assertEqual(result["routing"]["error_code"], "default_route_unverified")

    def test_repeated_real_override_section_is_rejected(self):
        for suffix in ("  - Selecting Override:\n    1   cf-zgo\n",
                       "  - Selecting Override:\n", "Selecting Override:\n  1 cf-zgo\n"):
            with self.subTest(suffix_type=suffix[:10]):
                self.api_stdout = "  - Selecting Override:\n    1   cf-dmit\n  - Selects:\n    1   cf-block\n" + suffix
                self.assertEqual(self.collect()["routing"]["error_code"], "unknown_bi_format")

    def test_multiple_override_rows_are_rejected(self):
        self.api_stdout = "  - Selecting Override:\n    1   cf-dmit\n    2   private-tag\n  - Selects:\n    1   cf-block\n"
        result = self.collect()
        self.assertEqual(result["routing"]["error_code"], "unknown_bi_format")
        self.assertNotIn("private-tag", json.dumps(result))

    def test_plist_marker_keeps_corrupt_config_in_managed_mode(self):
        (self.runtime / "controller.json").unlink()
        plist = self.home.parent / "Library/LaunchAgents/com.company.lisa-failover.plist"
        plist.parent.mkdir(parents=True)
        plist.write_text("irrelevant-content")
        result = self.collect()
        self.assertTrue(result["managed"])
        self.assertEqual(result["routing"]["error_code"], "controller_config_invalid")

    def test_duplicate_json_key_is_rejected(self):
        (self.runtime / "state.json").write_text('{"updated_at":0,"updated_at":995,"status":"OK"}')
        self.assertEqual(self.collect()["controller"]["error_code"], "state_invalid")

    def test_invalid_timestamp_types_are_safe(self):
        for value in (True, "995", {}, [], 10 ** 400, float("nan"), float("inf")):
            with self.subTest(value_type=type(value).__name__):
                self.state["updated_at"] = value
                self.write("state.json", self.state)
                result = self.collect()
                self.assertFalse(result["controller"]["fresh"])
                json.dumps(result, allow_nan=False)

    def test_invalid_pin_route_is_not_echoed(self):
        self.write("pin.json", dict(route="secret-pin", expires=1050))
        result = self.collect()
        self.assertEqual(result["pin"]["route"], "unknown")
        self.assertNotIn("secret-pin", json.dumps(result))

    def test_unknown_pending_assets_are_not_echoed(self):
        (self.home / "rule-updater.pending.json").write_text(json.dumps(dict(
            version=1, status="pending_until_verified", asset_sha256={"private-file": "a" * 64})))
        result = self.collect()
        self.assertIsNone(result["updater"]["pending"])
        self.assertNotIn("private-file", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
