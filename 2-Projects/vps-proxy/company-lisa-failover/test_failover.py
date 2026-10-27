"""B-lane offline acceptance/regression tests; no real subprocesses or secrets.

Run: python3 -B -m unittest -v test_failover.py
Safety assertions remain ordinary failures (never expectedFailure) until fixed.
All configurations and API output below are synthetic fixtures, not live evidence.
"""
import copy
import itertools
import json
import subprocess
import unittest
from unittest.mock import patch

import build_config as builder
import controller


def health(*up):
    return {name: name in up for name in controller.NAMES}


def base_config():
    return {
        "log": {"loglevel": "warning"},
        "inbounds": [{"tag": "business", "port": 19080, "protocol": "socks"}],
        "outbounds": [
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "legacy-lisa", "protocol": "blackhole"},
            {"tag": "other", "protocol": "blackhole"},
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "balancers": [{"tag": "main-balancer", "selector": ["other"]}],
            "rules": [
                {"type": "field", "domain": ["domain:private.invalid"], "outboundTag": "direct"},
                {"type": "field", "domain": ["domain:lisa.invalid"],
                 "network": "tcp", "outboundTag": "legacy-lisa"},
                {"type": "field", "domain": ["domain:other.invalid"], "balancerTag": "main-balancer"},
                {"type": "field", "network": "tcp,udp", "outboundTag": "direct"},
            ],
        },
        "policy": {"system": {"statsOutboundUplink": True}},
    }


def nodes():
    # Transform-only placeholders: never usable proxy endpoints/credentials.
    return {name: {"tag": "fixture-" + name, "protocol": "blackhole"}
            for name in controller.NAMES}


class OfflineTest(unittest.TestCase):
    def setUp(self):
        guard = patch.object(controller.subprocess, "run",
                             side_effect=AssertionError("real subprocess forbidden in offline tests"))
        guard.start()
        self.addCleanup(guard.stop)


class PolicyTests(OfflineTest):
    def step(self, policy, when, up, pin=None):
        choice = policy.decide(health(*up), when, pin)
        policy.applied(choice, when)
        return choice

    def test_startup_priority_all_health_combinations(self):
        for bits in itertools.product((False, True), repeat=3):
            up = [n for n, ok in zip(controller.NAMES, bits) if ok]
            with self.subTest(up=up):
                self.assertEqual(self.step(controller.Policy(), 0, up), next(iter(up), "block"))

    def test_two_consecutive_failures_required(self):
        p = controller.Policy()
        self.assertEqual(self.step(p, 0, ("dmit", "zgo", "home")), "dmit")
        self.assertEqual(self.step(p, 15, ("zgo", "home")), "dmit")
        self.assertEqual(self.step(p, 30, ("zgo", "home")), "zgo")

    def test_success_resets_failure_streak(self):
        p = controller.Policy()
        for t, up in [(0, ("dmit",)), (15, ("zgo",)), (30, ("dmit",)), (45, ("zgo",))]:
            self.assertEqual(self.step(p, t, up), "dmit")
        self.assertEqual(self.step(p, 60, ("zgo",)), "zgo")

    def test_candidate_must_be_healthy_this_round(self):
        p = controller.Policy()
        self.step(p, 0, ("dmit", "zgo", "home"))
        self.step(p, 15, ("zgo", "home"))
        self.assertEqual(self.step(p, 30, ("home",)), "home")

    def test_all_down_blocks_after_three_fully_down_rounds_and_stays_blocked(self):
        p = controller.Policy()
        self.step(p, 0, ("dmit",))
        self.assertEqual(self.step(p, 15, ()), "dmit")
        self.assertEqual(self.step(p, 30, ()), "dmit")
        for t in (45, 60):
            self.assertEqual(self.step(p, t, ()), "block")
        self.assertEqual(self.step(p, 75, ("home",)), "home")

    def test_recovery_does_not_bypass_300_second_hold(self):
        p = controller.Policy()
        self.step(p, 0, ("home",))
        for t in range(15, 300, 15):
            self.assertEqual(self.step(p, t, controller.NAMES), "home")
        self.assertEqual(self.step(p, 299, controller.NAMES), "home")
        self.assertEqual(self.step(p, 300, controller.NAMES), "dmit")

    def test_hold_does_not_bypass_120_second_continuous_recovery(self):
        p = controller.Policy()
        for t in range(0, 301, 15):
            self.step(p, t, ("home",))
        for t in range(315, 435, 15):
            self.assertEqual(self.step(p, t, ("dmit", "home")), "home")
        self.assertEqual(self.step(p, 434, ("dmit", "home")), "home")
        self.assertEqual(self.step(p, 435, ("dmit", "home")), "dmit")

    def test_recovery_failure_restarts_120_second_window(self):
        p = controller.Policy()
        for t in range(0, 301, 15):
            self.step(p, t, ("home",))
        for t in range(315, 420, 15):
            self.step(p, t, ("dmit", "home"))
        self.step(p, 420, ("home",))
        for t in range(435, 555, 15):
            self.assertEqual(self.step(p, t, ("dmit", "home")), "home")
        self.assertEqual(self.step(p, 555, ("dmit", "home")), "dmit")

    def test_best_recovered_candidate_not_merely_first_priority(self):
        p = controller.Policy()
        self.step(p, 0, ("home",))
        for t in range(15, 300, 15):
            self.step(p, t, ("zgo", "home"))
        self.assertEqual(self.step(p, 300, controller.NAMES), "zgo")

    def test_emergency_bypasses_both_hold_and_recovery(self):
        p = controller.Policy()
        self.step(p, 0, ("home",))
        self.assertEqual(self.step(p, 15, ("dmit",)), "home")
        self.assertEqual(self.step(p, 30, ("dmit",)), "dmit")
        self.assertEqual(p.since, 30)

    def test_decision_is_not_committed_until_applied(self):
        p = controller.Policy()
        self.assertEqual(p.decide(health("dmit"), 0), "dmit")
        self.assertEqual(p.selected, "block")
        p.applied("dmit", 0)
        p.applied("dmit", 100)
        self.assertEqual(p.since, 0)

    def test_sampling_gap_over_45_resets_recovery(self):
        p = controller.Policy()
        self.step(p, 0, ("home",))
        for t in range(15, 300, 15):
            self.step(p, t, controller.NAMES)
        self.assertEqual(self.step(p, 331, controller.NAMES), "home")
        for t in range(346, 451, 15):
            self.assertEqual(self.step(p, t, controller.NAMES), "home")
        self.assertEqual(self.step(p, 451, controller.NAMES), "dmit")

    def test_sampling_gap_exactly_45_keeps_recovery(self):
        p = controller.Policy()
        self.step(p, 0, ("home",))
        for t in range(15, 271, 15):
            self.step(p, t, controller.NAMES)
        self.assertEqual(self.step(p, 315, controller.NAMES), "dmit")

    def test_sampling_gap_resets_failure_streak(self):
        p = controller.Policy()
        self.step(p, 0, ("dmit",))
        self.step(p, 15, ("zgo",))
        self.assertEqual(self.step(p, 61, ("zgo",)), "dmit")
        self.assertEqual(self.step(p, 76, ("zgo",)), "zgo")

    def test_backward_time_resets_health_evidence(self):
        p = controller.Policy()
        self.step(p, 1000, ("home",))
        for t in range(1015, 1256, 15):
            self.step(p, t, controller.NAMES)
        self.assertEqual(self.step(p, 0, controller.NAMES), "home")
        self.assertEqual(p.health["dmit"]["ok_since"], 0)

    def test_backward_time_rebases_hold_to_new_clock(self):
        p = controller.Policy()
        self.step(p, 1000, ("home",))
        self.step(p, 0, controller.NAMES)
        for t in range(15, 300, 15):
            self.assertEqual(self.step(p, t, controller.NAMES), "home")
        self.assertEqual(self.step(p, 300, controller.NAMES), "dmit",
                         "old future since must not extend hold after clock reset")

    def test_pin_overrides_priority_and_unavailable_pin_blocks_immediately(self):
        p = controller.Policy()
        self.assertEqual(self.step(p, 0, controller.NAMES, "home"), "home")
        self.assertEqual(self.step(p, 15, ("dmit", "zgo"), "home"), "block")
        self.assertEqual(self.step(p, 30, controller.NAMES, "block"), "block")
        self.assertEqual(self.step(p, 45, controller.NAMES, "unknown"), "block")
        self.assertEqual(self.step(p, 60, controller.NAMES), "dmit")

    def test_pin_release_respects_recovery_and_hold(self):
        p = controller.Policy()
        self.step(p, 0, controller.NAMES, "home")
        for t in range(15, 300, 15):
            self.assertEqual(self.step(p, t, controller.NAMES), "home")
        self.assertEqual(self.step(p, 300, controller.NAMES), "dmit")


class PinFileTests(OfflineTest):
    def test_pin_expiry_and_auto(self):
        for route, expires, expected in [("zgo", 1001, "zgo"), ("zgo", 1000, None),
                                         ("zgo", 999, None), ("auto", 1001, None),
                                         ("block", 1001, "block")]:
            with self.subTest(route=route, expires=expires), \
                 patch.object(controller.Path, "read_text", return_value=json.dumps(
                     {"route": route, "expires": expires})), \
                 patch.object(controller.time, "time", return_value=1000):
                self.assertEqual(controller.read_pin("/not-read/pin.json"), expected)

    def test_missing_pin_is_auto(self):
        with patch.object(controller.Path, "read_text", side_effect=FileNotFoundError):
            self.assertIsNone(controller.read_pin("/not-read/pin.json"))


class ConfigTests(OfflineTest):
    def transform(self, base):
        return builder.client_config(base, nodes(), ["legacy-lisa"])

    def test_only_target_rule_changes_and_inputs_remain_unmodified(self):
        base, ns = base_config(), nodes()
        original, original_nodes = copy.deepcopy(base), copy.deepcopy(ns)
        out, count = builder.client_config(base, ns, ["legacy-lisa"])
        self.assertEqual(count, 1)
        self.assertEqual(base, original)
        self.assertEqual(ns, original_nodes)
        expected_rules = copy.deepcopy(base["routing"]["rules"])
        expected_rules[1].pop("outboundTag")
        expected_rules[1]["balancerTag"] = "cf-lisa"
        self.assertEqual(out["routing"]["rules"][3:], expected_rules)
        self.assertEqual(out["outbounds"][:3], base["outbounds"])
        self.assertEqual(out["inbounds"][:1], base["inbounds"])
        self.assertEqual(out["routing"]["balancers"][:-1], base["routing"]["balancers"])
        self.assertEqual(out["policy"], base["policy"])
        self.assertEqual(out["log"], base["log"])
        self.assertEqual(out["routing"]["domainStrategy"], "AsIs")

    def test_no_target_rule_rejects_scope_expansion(self):
        base = base_config()
        base["routing"]["rules"].pop(1)
        original = copy.deepcopy(base)
        with self.assertRaises(ValueError):
            self.transform(base)
        self.assertEqual(base, original)

    def test_balancer_only_scope_is_not_replaced_implicitly(self):
        base = base_config()
        base["routing"]["rules"] = [{"type": "field", "network": "tcp", "balancerTag": "main-balancer"}]
        with self.assertRaises(ValueError):
            builder.client_config(base, nodes(), ["main-balancer"])

    def test_default_selection_and_probe_routes_are_scoped(self):
        out, _ = self.transform(base_config())
        balancer = out["routing"]["balancers"][-1]
        self.assertEqual(balancer["selector"], ["cf-block"])
        self.assertEqual(balancer["fallbackTag"], "cf-block")
        self.assertEqual(out["outbounds"][-1]["protocol"], "blackhole")
        for n, inbound, rule in zip(controller.NAMES, out["inbounds"][1:], out["routing"]["rules"][:3]):
            self.assertEqual(inbound["listen"], "127.0.0.1")
            self.assertEqual(rule["inboundTag"], [inbound["tag"]])
            self.assertEqual(rule["outboundTag"], builder.TAGS[n])
        self.assertTrue(out["api"]["listen"].startswith("127.0.0.1:"))

    def test_existing_observatories_preserved(self):
        for key in ("observatory", "burstObservatory"):
            base = base_config()
            base[key] = {"subjectSelector": ["other"], "probeInterval": "17s"}
            out, _ = self.transform(base)
            self.assertEqual(out[key], base[key])
            self.assertNotIn("burstObservatory" if key == "observatory" else "observatory", out)

    def test_api_and_outbound_tag_conflicts_rejected(self):
        for extra in ({"api": {"tag": "existing-api"}},
                      {"outbounds": [{"tag": "cf-dmit", "protocol": "blackhole"}]}):
            base = base_config()
            base.update(extra)
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.transform(base)

    def test_existing_numeric_ports_rejected(self):
        for port in (*builder.PORTS.values(), 14991):
            base = base_config()
            base["inbounds"][0]["port"] = port
            with self.subTest(port=port), self.assertRaises(ValueError):
                self.transform(base)

    def test_existing_probe_inbound_tag_rejected_to_prevent_scope_expansion(self):
        base = base_config()
        base["inbounds"][0]["tag"] = "cf-probe-dmit"
        with self.assertRaises(ValueError, msg="prepended probe rule would capture existing business inbound"):
            self.transform(base)

    def test_existing_failover_balancer_tag_rejected(self):
        base = base_config()
        base["routing"]["balancers"][0]["tag"] = "cf-lisa"
        base["routing"]["rules"][2]["balancerTag"] = "cf-lisa"
        with self.assertRaises(ValueError, msg="duplicate balancer tag affects unrelated existing rule"):
            self.transform(base)


class ProbeTests(OfflineTest):
    def cfg(self):
        return builder.controller_config("/never-executed/xray", "/not-read")

    def test_both_targets_required_per_candidate(self):
        cfg = self.cfg()
        for missing_name in ("https", "codex"):
            def result(curl, port, target):
                return {"ok": not (port == builder.PORTS["dmit"] and target["name"] == missing_name)}
            with self.subTest(failed_target=missing_name), patch.object(controller, "probe", side_effect=result) as mock:
                results, reachable, detail = controller.probe_all(cfg)
                self.assertEqual(results, health("zgo", "home"))
                self.assertEqual(reachable, health("dmit", "zgo", "home"))
                self.assertEqual(mock.call_count, 6)
                self.assertEqual(set(detail["dmit"]), {"https", "codex"})

    def test_empty_targets_never_mark_all_paths_healthy(self):
        cfg = self.cfg()
        cfg["targets"] = []
        try:
            results, reachable, _ = controller.probe_all(cfg)
        except ValueError:
            return  # Rejecting invalid configuration is also safe.
        self.assertFalse(any(results.values()), "zero probes cannot be healthy evidence")

    def test_probe_http_acceptance_and_transport_errors(self):
        target = {"url": "https://probe.invalid/", "accept": ["401"]}
        for code, rc, ok, kind in [("401", 0, True, "ok"), ("403", 0, False, "target_rejected"),
                                    ("429", 0, False, "target_rejected"), ("401", 7, False, "transport")]:
            with self.subTest(code=code, rc=rc), patch.object(controller.subprocess, "run",
                    return_value=subprocess.CompletedProcess([], rc, stdout=code)) as mock:
                result = controller.probe("/not-run/curl", 12345, target)
                self.assertEqual((result["ok"], result["kind"]), (ok, kind))
                args = mock.call_args.args[0]
                self.assertEqual(args[args.index("--proxy") + 1], "socks5h://127.0.0.1:12345")
                self.assertEqual(args[args.index("--noproxy") + 1], "")

    def test_probe_timeout_is_failure(self):
        with patch.object(controller.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 8)):
            result = controller.probe("/not-run/curl", 12345, {"url": "https://probe.invalid/", "accept": ["204"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "timeout")


class ApiTests(OfflineTest):
    def cfg(self):
        return builder.controller_config("/not-run/xray", "/not-read")

    def test_override_parser_known_tags_lf_crlf_and_blank_default(self):
        for line_end in ("\n", "\r\n"):
            for choice, tag in list(builder.TAGS.items()) + [("block", "")]:
                output = line_end.join(["Balancer: cf-lisa", "Selecting Override:", "  1\t" + tag,
                                        "Selecting Principals:", "  1\tcf-block", ""])
                with self.subTest(choice=choice, line_end=repr(line_end), tag=tag), \
                     patch.object(controller, "api", return_value=output) as mock:
                    self.assertEqual(controller.read_override(self.cfg()), choice)
                    mock.assert_called_once_with(self.cfg(), "bi", "cf-lisa")

    def test_override_parser_rejects_unknown_format_or_foreign_route(self):
        for output in ("", "Selecting Principals:\n  1 cf-dmit\n", "Selecting Override:\n  1 direct\n"):
            with self.subTest(output=output), patch.object(controller, "api", return_value=output):
                with self.assertRaises(RuntimeError):
                    controller.read_override(self.cfg())

    def test_set_choice_checks_readback(self):
        cfg = self.cfg()
        with patch.object(controller, "api", return_value="" ) as mock, \
             patch.object(controller, "read_override", return_value="zgo") as read:
            controller.set_choice(cfg, "zgo")
            mock.assert_called_once_with(cfg, "bo", "-b", "cf-lisa", "cf-zgo")
            read.assert_called_once_with(cfg)

    def test_set_choice_mismatch_raises(self):
        with patch.object(controller, "api", return_value=""), \
             patch.object(controller, "read_override", return_value="block"):
            with self.assertRaisesRegex(RuntimeError, "routing_override_readback_failed"):
                controller.set_choice(self.cfg(), "dmit")

    def test_api_failure_does_not_leak_subprocess_output(self):
        with patch.object(controller.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, stdout="synthetic-private-output", stderr="synthetic-private-error")):
            with self.assertRaises(RuntimeError) as exc:
                controller.api(self.cfg(), "bo", "fixture")
        self.assertEqual(str(exc.exception), "routing_api_bo_failed")


class InstallerTests(OfflineTest):
    """In-memory fault injection. No real files, DBs, sockets or commands.

    Defaults model successful operations; hooks inject races/failures at exact
    boundaries. All fixture data is synthetic, including the home account list.
    """
    def setUp(self):
        super().setUp()
        from contextlib import ExitStack
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        import install_studio
        import rollback_studio
        import install_home_relay
        self.install = install_studio
        self.rollback = rollback_studio
        self.home = install_home_relay
        self.Path = Path
        self.fs, self.dirs, self.commands, self.writes = {}, set(), [], []
        self.command_hook = lambda args: None
        self.mkdir_hook = lambda path: None
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

        def patched(target, attr, **kw):
            return self.stack.enter_context(patch.object(target, attr, **kw))

        def read(path):
            if path not in self.fs:
                raise FileNotFoundError(str(path))
            return self.fs[path]

        def mkdir(path, *args, **kw):
            self.mkdir_hook(path)
            if path in self.dirs:
                raise FileExistsError(str(path))
            self.dirs.add(path)

        def put(path, data, *args, **kw):
            self.writes.append(path)
            self.fs[path] = data.encode() if isinstance(data, str) else data

        def opened(path, *args, **kw):
            self.opened_path = Path(path)
            self.fs[self.opened_path] = b""
            return 999

        def fdopen(*args, **kw):
            file = MagicMock()
            path = self.opened_path
            file.__enter__.return_value = file
            file.fileno.return_value = 999
            file.write.side_effect = lambda data: put(path, self.fs[path] + (
                data.encode() if isinstance(data, str) else data))
            return file

        def replace(src, dst):
            self.writes.append(dst)
            self.fs[dst] = self.fs.pop(src)

        def command(args, **kw):
            args = list(args)
            self.commands.append(args)
            result = self.command_hook(args)
            if result is not None:
                return result
            return subprocess.CompletedProcess(args, 0, stdout="401" if args[0].endswith("curl") else "")

        patched(Path, "read_bytes", autospec=True, side_effect=read)
        patched(Path, "read_text", autospec=True, side_effect=lambda path, *a, **kw: read(path).decode())
        patched(Path, "exists", autospec=True, side_effect=lambda path: path in self.fs or path in self.dirs)
        patched(Path, "mkdir", autospec=True, side_effect=mkdir)
        patched(Path, "unlink", autospec=True, side_effect=lambda path: self.fs.pop(path, None))
        patched(Path, "rmdir", autospec=True, side_effect=lambda path: self.dirs.discard(path))
        patched(Path, "write_text", autospec=True, side_effect=put)
        patched(install_studio, "write_owned", side_effect=put)
        patched(install_studio.os, "geteuid", return_value=0)
        patched(install_studio.os, "open", side_effect=opened)
        patched(install_studio.os, "fdopen", side_effect=fdopen)
        patched(install_studio.os, "replace", side_effect=replace)
        for attr in ("chown", "chmod", "fsync"):
            patched(install_studio.os, attr)
        patched(install_studio.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=501, pw_gid=20))
        patched(install_studio.socket, "socket")
        patched(install_studio.time, "sleep")
        patched(install_studio.subprocess, "run", side_effect=command)
        self.db = MagicMock()
        self.db.execute.return_value = []
        patched(install_studio.sqlite3, "connect", return_value=self.db)
        self.stack.enter_context(patch("builtins.print"))
        self.stage = Path("/synthetic-stage")
        self.baseline, self.candidate = b'{"fixture":"baseline"}', b'{"fixture":"candidate"}'
        self.manifest = {
            "baseline_sha256": install_studio.digest(self.baseline),
            "candidate_sha256": install_studio.digest(self.candidate),
            "code_sha256": {},
        }
        self.fs[install_studio.CONFIG] = self.baseline
        self.fs[self.stage / "candidate.json"] = self.candidate
        for name in ("controller.py", "controller.json", "rollback_studio.py"):
            data = b"synthetic staged artifact: " + name.encode()
            self.fs[self.stage / name] = data
            self.manifest["code_sha256"][name] = install_studio.digest(data)
        self.fs[self.stage / "manifest.json"] = json.dumps(self.manifest).encode()
        self.fs[install_studio.RUNTIME / "state.json"] = b'{"status":"OK","selected":"dmit"}'

    def prepare_rollback(self):
        m = self.rollback
        self.fs[m.CONFIG] = self.candidate
        self.fs[m.ROOT / "manifest.json"] = json.dumps(self.manifest).encode()
        self.fs[m.ROOT / "backup-config.json"] = self.baseline
        self.fs[m.PLIST] = b"synthetic plist"

    def test_studio_success_only_restarts_target_xray_and_starts_controller(self):
        self.install.main(self.stage)
        self.assertEqual(self.fs[self.install.CONFIG], self.candidate)
        self.assertEqual(self.fs[self.install.RUNTIME / "backup-config.json"], self.baseline)
        lifecycle = [cmd for cmd in self.commands if cmd[0].endswith("launchctl")]
        self.assertEqual(lifecycle, [
            ["/bin/launchctl", "kickstart", "-k", self.install.XRAY],
            ["/bin/launchctl", "bootstrap", "system", str(self.install.PLIST)],
        ])
        self.assertEqual(self.db.execute.call_count, 2)

    def test_studio_active_codeg_turn_blocks_before_any_write(self):
        self.db.execute.return_value = [("synthetic-active-turn",)]
        with self.assertRaisesRegex(RuntimeError, "ACTIVE_CODEG_TURNS"):
            self.install.main(self.stage)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.commands, [])

    def test_studio_late_active_turn_never_restarts_production(self):
        self.db.execute.side_effect = [[], [("synthetic-late-turn",)]]
        with self.assertRaisesRegex(RuntimeError, "ACTIVE_CODEG_TURNS"):
            self.install.main(self.stage)
        self.assertEqual(self.fs[self.install.CONFIG], self.baseline)
        self.assertFalse(any("kickstart" in cmd for cmd in self.commands))

    def test_studio_initial_config_drift_refuses_all_side_effects(self):
        self.fs[self.install.CONFIG] = b"concurrent production edit"
        with self.assertRaisesRegex(RuntimeError, "production_config_drift"):
            self.install.main(self.stage)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.commands, [])

    def test_studio_copied_code_must_match_verified_digest(self):
        def mutate_after_verification(args):
            if "-test" in args:
                self.fs[self.stage / "controller.py"] = b"concurrent staged edit"
        self.command_hook = mutate_after_verification
        try:
            self.install.main(self.stage)
        except RuntimeError:
            pass
        copied = self.fs.get(self.install.RUNTIME / "controller.py")
        self.assertTrue(copied is None or self.install.digest(copied) ==
                        self.manifest["code_sha256"]["controller.py"],
                        "code re-read after verification must not silently bypass manifest")

    def test_studio_rollback_conflict_must_not_first_stop_controller(self):
        def conflict(args):
            # Controller bootstrap has succeeded; later entry acceptance fails
            # while a concurrent writer changes the production config.
            if args[0].endswith("curl"):
                self.fs[self.install.CONFIG] = b"concurrent production edit"
                return subprocess.CompletedProcess(args, 1, stdout="")
        self.command_hook = conflict
        with self.assertRaisesRegex(RuntimeError, "rollback_config_conflict_stop"):
            self.install.main(self.stage)
        self.assertEqual(self.fs[self.install.CONFIG], b"concurrent production edit")
        self.assertFalse(any("bootout" in cmd for cmd in self.commands),
                         "conflict detection must precede disabling the live controller")

    def test_rollback_active_codeg_turn_blocks_production_restart(self):
        self.prepare_rollback()
        self.db.execute.return_value = [("synthetic-active-turn",)]
        try:
            self.rollback.main()
        except RuntimeError:
            pass
        self.assertFalse(any("kickstart" in cmd for cmd in self.commands),
                         "explicit rollback has no emergency bypass authorization")
        self.assertEqual(self.fs[self.rollback.CONFIG], self.candidate)

    def test_rollback_rechecks_drift_after_bootout(self):
        self.prepare_rollback()
        def drift(args):
            if "bootout" in args:
                self.fs[self.rollback.CONFIG] = b"concurrent production edit"
        self.command_hook = drift
        try:
            self.rollback.main()
        except RuntimeError:
            pass
        self.assertEqual(self.fs[self.rollback.CONFIG], b"concurrent production edit",
                         "rollback must not overwrite a newer production edit")

    def test_rollback_failed_bootout_must_abort_before_replace(self):
        self.prepare_rollback()
        self.command_hook = lambda args: subprocess.CompletedProcess(args, 1, stdout="") if "bootout" in args else None
        try:
            self.rollback.main()
        except (RuntimeError, subprocess.CalledProcessError):
            pass
        self.assertEqual(self.fs[self.rollback.CONFIG], self.candidate,
                         "controller stop failure must not proceed into production mutation")
        self.assertFalse(any("kickstart" in cmd for cmd in self.commands))

    def test_home_existing_install_is_untouched(self):
        self.dirs.add(self.home.ROOT)
        with self.assertRaisesRegex(RuntimeError, "existing_installation"):
            self.home.main()
        self.assertEqual(self.commands, [])
        self.assertEqual(self.writes, [])

    def test_home_mkdir_race_must_not_delete_or_stop_other_install(self):
        import io
        from unittest.mock import patch
        m = self.home
        # Pure synthetic route/accounts, never read a real main config or stdin.
        node = {"tag": "新美宅-Claude-GPT", "protocol": "blackhole",
                "settings": {"vnext": [{"address": "2605:52c0:2:c1a:e896:25ff:fe53:fea7", "port": 7443}]}}
        self.fs[self.Path("/usr/local/etc/xray/config.json")] = json.dumps({"outbounds": [node]}).encode()
        accounts = [{"user": name, "pass": "synthetic-fixture-only-" * 2} for name in m.SOURCE]
        self.stack.enter_context(patch.object(m.sys, "stdin", io.StringIO(json.dumps(accounts))))
        def race(path):
            if path == m.ROOT:
                self.dirs.add(m.ROOT)
                self.fs[m.UNIT] = b"other installer unit"
                self.fs[m.ROOT / "config.json"] = b"other installer config"
                raise FileExistsError("concurrent installation won mkdir")
        self.mkdir_hook = race
        with self.assertRaises(FileExistsError):
            m.main()
        self.assertFalse(any("disable" in cmd for cmd in self.commands),
                         "failed mkdir gives no ownership of an existing service")
        self.assertEqual(self.fs.get(m.UNIT), b"other installer unit")
        self.assertEqual(self.fs.get(m.ROOT / "config.json"), b"other installer config")


    def test_manual_rollback_abort_after_stop_restores_controller(self):
        for reason in ("late_active_turn", "config_drift"):
            with self.subTest(reason=reason):
                self.commands.clear()
                self.writes.clear()
                self.prepare_rollback()
                expected_config = self.candidate
                if reason == "late_active_turn":
                    self.db.execute.side_effect = [[], [("synthetic-new-turn",)]]
                    self.command_hook = lambda args: None
                    expected_error = "ACTIVE_CODEG_TURNS"
                else:
                    self.db.execute.side_effect = None
                    self.db.execute.return_value = []
                    expected_config = b"concurrent production edit"
                    def drift(args):
                        if "bootout" in args:
                            self.fs[self.rollback.CONFIG] = b"concurrent production edit"
                    self.command_hook = drift
                    expected_error = "config_changed_after_controller_stop"
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    self.rollback.main()
                self.assertEqual(self.commands, [
                    ["/bin/launchctl", "bootout", "system/com.company.lisa-failover"],
                    ["/bin/launchctl", "bootstrap", "system", str(self.rollback.PLIST)],
                ])
                self.assertEqual(self.fs[self.rollback.CONFIG], expected_config)
                self.assertEqual(self.fs[self.rollback.PLIST], b"synthetic plist")
                self.assertEqual(self.fs[self.rollback.ROOT / "backup-config.json"], self.baseline)
                self.assertEqual(self.writes, [], "aborted rollback must not replace production files")

    def test_auto_rollback_post_stop_drift_restores_controller(self):
        def acceptance_failure_then_drift(args):
            if args[0].endswith("curl"):
                return subprocess.CompletedProcess(args, 1, stdout="")
            if "bootout" in args:
                self.fs[self.install.CONFIG] = b"concurrent production edit"
        self.command_hook = acceptance_failure_then_drift
        with self.assertRaisesRegex(RuntimeError, "rollback_config_conflict_stop"):
            self.install.main(self.stage)
        lifecycle = [cmd for cmd in self.commands if cmd[0].endswith("launchctl")]
        self.assertEqual(lifecycle, [
            ["/bin/launchctl", "kickstart", "-k", self.install.XRAY],
            ["/bin/launchctl", "bootstrap", "system", str(self.install.PLIST)],
            ["/bin/launchctl", "bootout", self.install.LABEL],
            ["/bin/launchctl", "bootstrap", "system", str(self.install.PLIST)],
        ])
        self.assertEqual(self.fs[self.install.CONFIG], b"concurrent production edit")
        self.assertIn(self.install.PLIST, self.fs)
        self.assertEqual(self.fs[self.install.RUNTIME / "backup-config.json"], self.baseline)
        self.assertEqual(self.writes.count(self.install.CONFIG), 1,
                         "initial install only: no rollback overwrite after drift")

    def test_controller_guard_blocks_api_on_initial_and_later_drift(self):
        class StopLoop(BaseException):
            pass

        for initially_matching in (False, True):
            with self.subTest(initially_matching=initially_matching):
                cfg = builder.controller_config("/not-run/xray", "/synthetic-guard-" + str(initially_matching))
                cfg.update(guard_config_path=str(self.install.CONFIG),
                           guard_config_sha256=self.install.digest(self.candidate))
                self.fs[self.install.CONFIG] = self.candidate if initially_matching else b"foreign config"
                snapshots = []
                sleeps = 0

                def between_rounds(_delay):
                    nonlocal sleeps
                    sleeps += 1
                    if sleeps == 1:
                        self.fs[self.install.CONFIG] = b"foreign config"
                    else:
                        raise StopLoop()

                with patch.object(self.Path, "open") as opened, \
                     patch.object(controller.fcntl, "flock"), \
                     patch.object(controller, "RotatingFileHandler"), \
                     patch.object(controller.logging, "getLogger"), \
                     patch.object(controller, "atomic_json", side_effect=lambda path, data: snapshots.append(copy.deepcopy(data))), \
                     patch.object(controller, "api", return_value="Selecting Override:\n  1 cf-dmit\n") as api, \
                     patch.object(controller, "probe_all", return_value=(health("dmit"), health("dmit"), {})) as probes, \
                     patch.object(controller, "read_pin", return_value=None) as pin, \
                     patch.object(controller, "set_choice") as choose, \
                     patch.object(controller.time, "sleep", side_effect=between_rounds):
                    opened.return_value.__enter__.return_value.fileno.return_value = 999
                    with self.assertRaises(StopLoop):
                        controller.run(cfg)
                    self.assertEqual([s["status"] for s in snapshots],
                                     ["OK", "CONTROL_ERROR"] if initially_matching else
                                     ["CONTROL_ERROR", "CONTROL_ERROR"])
                    self.assertEqual(api.call_count, 2 * int(initially_matching),
                                     "no RoutingService call may occur in a drifted round")
                    if initially_matching:
                        self.assertEqual(api.call_args_list, [unittest.mock.call(cfg, "bi", cfg["balancer"])] * 2,
                                         "read override both before and after probes; no write")
                    self.assertEqual(probes.call_count, int(initially_matching))
                    self.assertEqual(pin.call_count, int(initially_matching))
                    choose.assert_not_called()
                self.assertEqual(self.fs[self.install.CONFIG], b"foreign config")


if __name__ == "__main__":
    unittest.main()
