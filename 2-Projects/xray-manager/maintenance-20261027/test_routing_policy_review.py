"""Independent review: bounded first-match oracle, not an Xray replacement.

The optional Air snapshot test covers only inputs whose winner is provable with
explicit full/domain and CIDR fields. Opaque geosite/regexp cases are counted as
uncovered. No network calls or production writes are performed by these tests.
"""
import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import unittest

from routing_policy import PolicyError, audit_config, group_states, plan_change


def fixture(rules=None):
    return {
        "routing": {"domainStrategy": "AsIs", "rules": rules or [
            {"domain": ["domain:example.com"], "port": "443", "balancerTag": "web"},
            {"domain": ["full:second.invalid"], "inboundTag": ["socks"], "balancerTag": "web"},
            {"network": "tcp,udp", "outboundTag": "a"}],
            "balancers": [{"tag": "web", "selector": ["a"], "fallbackTag": "b"},
                          {"tag": "unused", "selector": ["a"], "fallbackTag": "b"}]},
        "outbounds": [{"tag": x, "protocol": "vless"} for x in ("a", "b", "c")],
        "inbounds": [{"tag": "socks"}, {"tag": "other"}],
    }


def _or(values):
    if any(value is True for value in values):
        return True
    return None if any(value is None for value in values) else False


def _domain(pattern, host):
    if host is None:
        return False
    if pattern.startswith("full:"):
        return host == pattern[5:]
    if pattern.startswith("domain:"):
        base = pattern[7:]
        return host == base or host.endswith("." + base)
    return None


def _ip(pattern, address):
    if address is None:
        return False
    try:
        return ipaddress.ip_address(address) in ipaddress.ip_network(pattern, strict=False)
    except ValueError:
        return None


def _port(pattern, value):
    if not isinstance(pattern, (str, int)) or isinstance(pattern, bool):
        return None
    try:
        ranges = []
        for item in str(pattern).split(","):
            ends = item.split("-")
            if len(ends) not in (1, 2):
                return None
            lo, hi = int(ends[0]), int(ends[-1])
            if not 0 < lo <= hi <= 65535:
                return None
            ranges.append(lo <= value <= hi)
        return any(ranges)
    except ValueError:
        return None


def rule_matches(rule, context):
    results = []
    for key, value in rule.items():
        if key in ("type", "tag", "ruleTag", "outboundTag", "balancerTag"):
            continue
        if key == "domain":
            results.append(_or([_domain(p, context.get("domain")) for p in value]))
        elif key in ("ip", "source"):
            results.append(_or([_ip(p, context.get(key)) for p in value]))
        elif key in ("port", "sourcePort"):
            results.append(_port(value, context.get(key, 443)))
        elif key in ("inboundTag", "protocol", "user"):
            results.append(context.get(key) in value)
        elif key == "network":
            results.append(context.get(key, "tcp") in value.split(","))
        else:
            results.append(None)
    if any(value is False for value in results):
        return False
    return None if not results or any(value is None for value in results) else True


def first_match(config, context):
    for rule in config["routing"]["rules"]:
        matched = rule_matches(rule, context)
        if matched is None:
            return None
        if matched:
            return ("balancer", rule["balancerTag"]) if rule.get("balancerTag") else ("outbound", rule["outboundTag"])
    return ("outbound", config["outbounds"][0]["tag"])


def normalize(config):
    return plan_change(config, None, {"action": "normalize"})["config"]


class FirstMatchReviewTests(unittest.TestCase):
    def compare(self, before, contexts):
        after = normalize(before)
        known = unknown = 0
        for context in contexts:
            old, new = first_match(before, context), first_match(after, context)
            if old is None or new is None:
                unknown += 1
                continue
            self.assertEqual(old, new, context)
            known += 1
        self.assertGreater(known, 0)
        return after, known, unknown

    def contexts(self, domains):
        return [{"domain": host, "ip": address, "port": port, "inboundTag": inbound, "network": network}
                for host in domains for address in (None, "192.0.2.5", "198.51.100.7")
                for port in (80, 443, 8443) for inbound in ("socks", "other") for network in ("tcp", "udp")]

    def test_domain_boundaries_and_full_match(self):
        config = fixture([
            {"domain": ["full:example.com"], "outboundTag": "a"},
            {"domain": ["domain:example.com", "full:x.example.com", "domain:notexample.com"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        self.compare(config, self.contexts(["example.com", "x.example.com", "notexample.com", "x.notexample.com", "example.com.invalid", "x.example.com."]))

    def test_domain_and_ip_both_required(self):
        config = fixture([
            {"domain": ["domain:example.com"], "ip": ["192.0.2.0/24"], "outboundTag": "a"},
            {"domain": ["full:x.example.com", "full:other.invalid"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        after, _, _ = self.compare(config, self.contexts(["x.example.com", "other.invalid", "unmatched.invalid"]))
        self.assertIn("full:x.example.com", after["routing"]["rules"][1]["domain"])

    def test_earlier_narrow_port_and_inbound_do_not_shadow(self):
        config = fixture([
            {"domain": ["domain:example.com"], "port": "443", "inboundTag": ["other"], "outboundTag": "a"},
            {"domain": ["full:x.example.com"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        after, _, _ = self.compare(config, self.contexts(["example.com", "x.example.com", "else.invalid"]))
        self.assertEqual(len(after["routing"]["rules"]), 3)

    def test_later_narrow_condition_can_be_removed_under_wider_earlier_rule(self):
        config = fixture([
            {"domain": ["domain:example.com"], "outboundTag": "a"},
            {"domain": ["full:x.example.com"], "port": "443", "inboundTag": ["other"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        after, _, _ = self.compare(config, self.contexts(["x.example.com", "else.invalid"]))
        self.assertEqual(len(after["routing"]["rules"]), 2)

    def test_cidr_boundary_and_address_families(self):
        config = fixture([
            {"ip": ["192.0.2.0/24"], "outboundTag": "a"},
            {"ip": ["192.0.2.128/25", "198.51.100.0/24", "2001:db8::/32"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        self.compare(config, [{"ip": ip} for ip in ("192.0.2.1", "192.0.2.200", "192.0.3.1", "198.51.100.1", "2001:db8::1", "2001:db9::1")])

    def test_partial_cross_target_shadow_only_removes_dead_terms(self):
        config = fixture([
            {"domain": ["domain:example.com"], "outboundTag": "a"},
            {"domain": ["full:x.example.com", "full:else.invalid"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        after, _, _ = self.compare(config, self.contexts(["x.example.com", "else.invalid", "notexample.com"]))
        self.assertEqual(after["routing"]["rules"][1]["domain"], ["full:else.invalid"])

    def test_opaque_regex_geosite_never_proves_specific_domain_coverage(self):
        for pattern in ("regexp:.*example.*", "geosite:example", "ext:custom.dat:example"):
            with self.subTest(pattern=pattern):
                config = fixture([
                    {"domain": [pattern], "outboundTag": "a"},
                    {"domain": ["full:x.example.com"], "outboundTag": "b"},
                    {"network": "tcp,udp", "outboundTag": "c"}])
                self.assertEqual(normalize(config), config)
                self.assertIsNone(first_match(config, {"domain": "x.example.com"}))

    def test_unknown_condition_prevents_widening(self):
        config = fixture([
            {"domain": ["domain:example.com"], "attrs": {":method": "GET"}, "outboundTag": "a"},
            {"domain": ["full:x.example.com"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        self.assertEqual(normalize(config), config)

    def test_sources_and_network_restrictions_are_anded(self):
        config = fixture([
            {"domain": ["domain:example.com"], "source": ["10.0.0.0/8"], "network": "udp", "outboundTag": "a"},
            {"domain": ["full:x.example.com"], "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        contexts = [{"domain": "x.example.com", "source": source, "network": network}
                    for source in ("10.9.1.1", "192.0.2.1") for network in ("tcp", "udp")]
        self.compare(config, contexts)

    def test_rule_tag_and_probe_protection_are_preserved(self):
        config = fixture([
            {"inboundTag": ["cf-probe-test"], "domain": ["domain:example.com", "domain:example.com"], "outboundTag": "a"},
            {"domain": ["domain:example.com", "full:x.example.com"], "ruleTag": "keep-id", "outboundTag": "b"},
            {"network": "tcp,udp", "outboundTag": "c"}])
        config["inbounds"].append({"tag": "cf-probe-test"})
        self.assertEqual(normalize(config), config)

    def test_optional_air_snapshot_first_match_samples(self):
        path = Path(os.environ.get("AIR_ROUTING_REVIEW_SNAPSHOT", "/tmp/air-routing-20261027/production-normalized.json"))
        if not path.is_file():
            self.skipTest("Air redacted snapshot not provided; no production sample claim")
        snapshot = json.loads(path.read_text())
        self.assertTrue(snapshot.get("all_routing_rule_fields_exported"))
        config = {"routing": {"domainStrategy": snapshot["routing"]["domainStrategy"],
                              "rules": [item["rule"] for item in snapshot["routing"]["rules"]],
                              "balancers": snapshot["routing"]["balancers"]},
                  "outbounds": snapshot["outbounds"], "inbounds": snapshot["inbounds"], "api": snapshot["api"]}
        domains, addresses = {"unmatched.review.invalid"}, {"192.0.2.1"}
        for rule in config["routing"]["rules"]:
            for term in rule.get("domain", []):
                if term.startswith(("domain:", "full:")):
                    host = term.split(":", 1)[1]
                    if re.fullmatch(r"[a-z0-9.-]+", host):
                        domains.update((host, "review." + host, "not" + host, host + ".review.invalid"))
            for term in rule.get("ip", []):
                try:
                    net = ipaddress.ip_network(term, strict=False)
                    addresses.add(str(net.network_address))
                    if net.num_addresses > 1:
                        addresses.add(str(net.network_address + 1))
                except ValueError:
                    pass
        contexts = [{"domain": host, "port": port, "network": network, "inboundTag": inbound}
                    for host in sorted(domains) for port in (80, 443) for network in ("tcp", "udp")
                    for inbound in ("socks", "cf-probe-dmit", "cf-probe-zgo", "cf-probe-home")]
        contexts += [{"ip": ip, "port": port, "network": network, "inboundTag": "socks"}
                     for ip in sorted(addresses) for port in (80, 443) for network in ("tcp", "udp")]
        _, known, unknown = self.compare(config, contexts)
        print("Air snapshot first-match sample review: total={}, proven_equal={}, opaque_uncovered={}".format(len(contexts), known, unknown))


class MetadataReviewTests(unittest.TestCase):
    def disable(self, config=None):
        return plan_change(config or fixture(), None, {"action": "toggle", "tag": "web", "enabled": False, "fallback": "b"})

    def enable(self, plan):
        return plan_change(plan["config"], plan["metadata"], {"action": "toggle", "tag": "web", "enabled": True})

    def test_multiple_rules_restore_exact_bytes_structure_and_order(self):
        original = fixture()
        plan = self.disable(original)
        self.assertEqual(fixture(), original)
        restored = self.enable(plan)
        self.assertEqual(restored["config"], original)
        self.assertEqual(restored["metadata"]["disabled"], {})

    def test_truncated_metadata_cannot_claim_enabled_without_restoring(self):
        for keep_count in (0, 1):
            with self.subTest(keep_count=keep_count):
                plan = self.disable()
                plan["metadata"]["disabled"]["web"]["rules"] = plan["metadata"]["disabled"]["web"]["rules"][:keep_count]
                with self.assertRaises(PolicyError):
                    self.enable(plan)

    def test_saved_rule_edit_is_detected(self):
        plan = self.disable()
        plan["metadata"]["disabled"]["web"]["rules"][0]["original"]["domain"] = ["domain:other.invalid"]
        with self.assertRaises(PolicyError):
            self.enable(plan)

    def test_live_rule_reordering_is_detected(self):
        plan = self.disable()
        rules = plan["config"]["routing"]["rules"]
        rules[0], rules[1] = rules[1], rules[0]
        with self.assertRaises(PolicyError):
            self.enable(plan)

    def test_group_drift_is_detected(self):
        plan = self.disable()
        plan["config"]["routing"]["balancers"][0]["selector"] = ["c"]
        with self.assertRaises(PolicyError):
            self.enable(plan)

    def test_legitimate_zero_reference_group_can_restore(self):
        config = fixture()
        plan = plan_change(config, None, {"action": "toggle", "tag": "unused", "enabled": False, "fallback": "b"})
        self.assertFalse(next(x for x in group_states(plan["config"], plan["metadata"]) if x["tag"] == "unused")["enabled"])
        restored = plan_change(plan["config"], plan["metadata"], {"action": "toggle", "tag": "unused", "enabled": True})
        self.assertEqual(restored["config"], config)
        self.assertEqual(restored["metadata"]["disabled"], {})

    def test_disable_enable_are_idempotent(self):
        plan = self.disable()
        twice = plan_change(plan["config"], plan["metadata"], {"action": "toggle", "tag": "web", "enabled": False, "fallback": "c"})
        self.assertEqual(twice["config"], plan["config"])
        self.assertEqual(twice["metadata"], plan["metadata"])
        restored = self.enable(plan)
        again = plan_change(restored["config"], restored["metadata"], {"action": "toggle", "tag": "web", "enabled": True})
        self.assertEqual(again["changes"], [])


class MalformedConfigReviewTests(unittest.TestCase):
    def test_unhashable_group_tag_produces_structured_error(self):
        config = fixture()
        config["routing"]["balancers"][0]["tag"] = []
        self.assertGreater(audit_config(config)["counts"]["error"], 0)
        with self.assertRaises(PolicyError):
            normalize(config)

    def test_null_inbounds_produces_structured_error(self):
        config = fixture()
        config["inbounds"] = None
        self.assertGreater(audit_config(config)["counts"]["error"], 0)
        with self.assertRaises(PolicyError):
            normalize(config)

    def test_unknown_matcher_and_secret_are_not_echoed(self):
        config = fixture()
        config["outbounds"][0]["settings"] = {"password": "PRIVATE_SENTINEL"}
        config["routing"]["rules"][0]["attrs"] = {"authorization": "PRIVATE_SENTINEL"}
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(audit_config(config)))


if __name__ == "__main__":
    unittest.main()
