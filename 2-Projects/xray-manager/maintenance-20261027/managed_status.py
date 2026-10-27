"""Read-only, redacted observations of the local managed Xray installation.

This module never changes routing or confirms that on-disk assets were loaded.
Only a live ``api bi`` override is reported as an effective route. Persisted
health observations require a recent timestamp and a running controller.
"""

import ipaddress
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time


ROUTES = ("dmit", "zgo", "home")
TAGS = {name: "cf-" + name for name in ROUTES + ("block",)}
STATE_STATUSES = frozenset(("OK", "DEGRADED", "ALL_DOWN", "PIN_UNAVAILABLE", "CONTROL_ERROR"))
CONTROL_ERRORS = frozenset((
    "production_config_drift_stop", "production_config_parse_failed",
    "foreign_override_stop", "unknown_bi_format", "routing_override_readback_failed",
    "routing_api_bi_failed", "routing_api_bo_failed", "routing_api_bi_timeout",
    "routing_api_bo_timeout", "unexpected_error",
))
FRESH_SECONDS = 45
COMMAND_TIMEOUT = 1.5
MAX_JSON_BYTES = 256 * 1024


def _number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("invalid_number")


def _read_json(path):
    """Return a dict or a fixed error classification; never export file content."""
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            return None, "invalid"
        data = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
        return (data, None) if isinstance(data, dict) else (None, "invalid")
    except FileNotFoundError:
        return None, "missing"
    except (ValueError, UnicodeError, RecursionError):
        return None, "invalid"
    except OSError:
        return None, "unreadable"


def _run(runner, argv):
    try:
        result = runner(argv, capture_output=True, text=True, timeout=COMMAND_TIMEOUT)
        return result, None
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except Exception:
        # Exceptions and command output can contain local paths or credentials.
        return None, "failed"


def _controller_process(runner):
    result, error = _run(runner, ["/bin/launchctl", "print",
                                "gui/{}/com.company.lisa-failover".format(os.getuid())])
    if error:
        return "unknown"
    if result.returncode == 113:
        return "stopped"
    output = result.stdout if isinstance(result.stdout, str) else ""
    if (result.returncode == 0 and re.search(r"(?m)^\s*state = running\s*$", output)
            and re.search(r"(?m)^\s*pid = [1-9][0-9]*\s*$", output)):
        return "running"
    return "unknown"


def _api_address(config):
    if not config or config.get("balancer") != "cf-lisa" or config.get("tags") != TAGS:
        return None
    address = config.get("api")
    if not isinstance(address, str):
        return None
    try:
        host, port = address.rsplit(":", 1)
        if not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
            return None
        if not ipaddress.ip_address(host.strip("[]")).is_loopback:
            return None
    except ValueError:
        return None
    return address


def _static_default(home):
    config, error = _read_json(home / "config.json")
    if error:
        return "unknown"
    routing = config.get("routing")
    balancers = routing.get("balancers") if isinstance(routing, dict) else None
    outbounds = config.get("outbounds")
    if not isinstance(balancers, list) or not isinstance(outbounds, list):
        return "unknown"
    selected = [item for item in balancers if isinstance(item, dict) and item.get("tag") == "cf-lisa"]
    # Xray selectors match prefixes, so cf-block-extra would also participate.
    blocked = [item for item in outbounds if isinstance(item, dict)
               and isinstance(item.get("tag"), str) and item["tag"].startswith("cf-block")]
    if (len(selected) == len(blocked) == 1 and selected[0].get("selector") == ["cf-block"]
            and selected[0].get("fallbackTag") == "cf-block" and blocked[0].get("tag") == "cf-block"
            and blocked[0].get("protocol") == "blackhole"):
        return "block"
    return "unknown"


def _routing(home, config, runner):
    route = {"available": False, "override": "unknown", "effective_route": "unknown",
             "source": "unknown", "static_default": _static_default(home), "error_code": None}
    address = _api_address(config)
    if address is None:
        route["error_code"] = "controller_config_invalid"
        return route
    result, error = _run(runner, [str(home / "xray"), "api", "bi", "--server=" + address, "cf-lisa"])
    if error or result.returncode:
        route["error_code"] = "routing_api_bi_timeout" if error == "timeout" else "routing_api_bi_failed"
        return route
    output = result.stdout if isinstance(result.stdout, str) else ""
    # Xray prints indented '- Selecting Override:' and a separate '- Selects:'
    # section. Only the former is runtime override evidence. Count headings
    # before parsing a row so malformed or mixed-format duplicates fail closed.
    lines = output.replace("\r\n", "\n").split("\n")
    headings = [index for index, line in enumerate(lines) if "Selecting Override:" in line]
    if (len(headings) != 1
            or not re.fullmatch(r"[ \t]*(?:-[ \t]+)?Selecting Override:[ \t]*", lines[headings[0]])
            or headings[0] + 1 >= len(lines)):
        route["error_code"] = "unknown_bi_format"
        return route
    index = headings[0] + 1
    row = re.fullmatch(r"[ \t]*1(?:[ \t]+([^\r\n]*))?", lines[index])
    # A second row or unexpected text in this section is ambiguous. Stop at
    # the next section header; its selected default must never fill an empty
    # override or be mistaken for a second override row.
    following = next((line for line in lines[index + 1:] if line.strip()), None)
    if row is None or (following is not None and not re.fullmatch(
            r"[ \t]*(?:-[ \t]+)?[A-Za-z][A-Za-z ]*:[ \t]*", following)):
        route["error_code"] = "unknown_bi_format"
        return route
    tag = (row.group(1) or "").strip()
    if not tag:
        route.update(available=True, override="none", error_code="default_route_unverified")
    elif tag in TAGS.values():
        name = next(name for name, value in TAGS.items() if tag == value)
        route.update(available=True, override=name, effective_route=name, source="override")
    else:
        route["error_code"] = "foreign_override"
    return route


def _probe(value, name, fresh):
    empty = {"ok": None, "http": None, "exit": None, "kind": "stale" if not fresh else "unknown"}
    if not fresh or not isinstance(value, dict):
        return empty
    code = value.get("http")
    code = code if isinstance(code, str) and re.fullmatch(r"[0-9]{3}", code) else None
    exit_code = value.get("exit")
    exit_code = exit_code if type(exit_code) is int and -1 <= exit_code <= 255 else None
    if code is None or exit_code is None or type(value.get("ok")) is not bool:
        return empty
    accepted = ("204",) if name == "https" else ("200", "401")
    ok = value["ok"] and exit_code == 0 and code in accepted
    kind = ("ok" if ok else "timeout" if value.get("kind") == "timeout"
            else "transport" if exit_code != 0 else "target_rejected")
    return {"ok": ok, "http": code, "exit": exit_code, "kind": kind}


def _routes(state, fresh):
    stored = state.get("probes", {})
    stored = stored if isinstance(stored, dict) else {}
    routes = []
    for name in ROUTES:
        data = stored.get(name, {})
        data = data if isinstance(data, dict) else {}
        probes = {target: _probe(data.get(target), target, fresh) for target in ("https", "codex")}
        values = [probe["ok"] for probe in probes.values()]
        service = False if False in values else True if all(value is True for value in values) else None
        reachable = True if True in values else False if all(value is False for value in values) else None
        routes.append({"id": name, "fresh": fresh, "service_ok": service,
                       "reachable": reachable, "probes": probes})
    return routes


def _pin(runtime, now):
    result = {"active": False, "route": "auto", "remaining_seconds": None, "error_code": None}
    data, error = _read_json(runtime / "pin.json")
    if error == "missing":
        return result
    if (error or data.get("route") not in ROUTES + ("block", "auto")
            or not _number(data.get("expires"))):
        result.update(route="unknown", error_code="pin_unreadable" if error == "unreadable" else "pin_invalid")
        return result
    remaining = max(0.0, float(data["expires"]) - now)
    result.update(active=data["route"] != "auto" and remaining > 0,
                  route=data["route"], remaining_seconds=remaining)
    return result


def _updater(home):
    result = {"pending": None, "status": "unknown", "applied": None, "assets": [], "error_code": None}
    data, error = _read_json(home / "rule-updater.pending.json")
    if error == "missing":
        result.update(pending=False, status="no_pending_record")
        return result
    if error:
        result["error_code"] = "pending_marker_" + error
        return result
    hashes = data.get("asset_sha256")
    if (type(data.get("version")) is not int or data["version"] != 1
            or data.get("status") != "pending_until_verified" or not isinstance(hashes, dict)
            or any(name not in ("geoip.dat", "geosite.dat") or not isinstance(value, str)
                   or not re.fullmatch(r"[a-fA-F0-9]{64}", value) for name, value in hashes.items())):
        result["error_code"] = "pending_marker_invalid"
        return result
    result.update(pending=True, status="pending_until_verified", assets=sorted(hashes))
    return result


def _overall(result):
    controller, routing, pin = result["controller"], result["routing"], result["pin"]
    if not result["managed"]:
        return "unavailable", "not_managed"
    if controller["process"] != "running":
        return "unavailable", "controller_" + controller["process"]
    if not controller["fresh"]:
        error = controller["error_code"]
        return ("stale" if error in ("state_stale", "state_clock_skew") else "unavailable"), error
    if controller["state_status"] == "CONTROL_ERROR":
        return "error", controller["error_code"]
    if routing["error_code"]:
        return ("error" if routing["error_code"] in ("foreign_override", "controller_config_invalid") else "unavailable"), routing["error_code"]
    if pin["error_code"]:
        return "error", pin["error_code"]
    actual = routing["effective_route"]
    if pin["active"] and actual != pin["route"]:
        # A failing pinned route is allowed to fail closed to block.
        if actual == "block":
            return "blocked", "pin_unavailable"
        return "error", "pin_route_mismatch"
    if actual == "block":
        return "blocked", "explicit_block"
    if actual != controller["selected"]:
        return "degraded", "route_state_mismatch"
    selected = next((route for route in result["routes"] if route["id"] == actual), None)
    if controller["state_status"] == "OK" and selected and selected["service_ok"] is True:
        return "healthy", "observations_healthy"
    if controller["state_status"] in ("DEGRADED", "ALL_DOWN", "PIN_UNAVAILABLE") or (selected and selected["service_ok"] is False):
        return "degraded", "service_degraded"
    return "unavailable", "health_unknown"


def collect_managed_status(xray_home=None, *, now=None, runner=None):
    """Collect bounded local observations; ``runner`` follows subprocess.run's API."""
    home = Path(xray_home) if xray_home is not None else Path.home() / "xray"
    runtime = home / "company-lisa-failover"
    now = time.time() if now is None else now
    if not _number(now):
        raise ValueError("invalid_clock")
    runner = subprocess.run if runner is None else runner
    managed = ((runtime / "controller.json").exists()
               or (home.parent / "Library/LaunchAgents/com.company.lisa-failover.plist").exists())
    state, state_error = _read_json(runtime / "state.json") if managed else (None, "missing")
    state = state or {}
    updated = state.get("updated_at")
    age = max(0.0, now - updated) if _number(updated) else None
    fresh = state_error is None and age is not None and updated <= now + 5 and age <= FRESH_SECONDS
    error_code = None
    if state_error:
        error_code = "state_" + state_error
    elif not _number(updated):
        error_code = "state_invalid"
    elif updated > now + 5:
        error_code = "state_clock_skew"
    elif not fresh:
        error_code = "state_stale"
    state_status = state.get("status")
    state_status = state_status if isinstance(state_status, str) and state_status in STATE_STATUSES else "unknown"
    if fresh and state_status == "CONTROL_ERROR":
        code = state.get("error_code")
        error_code = code if isinstance(code, str) and code in CONTROL_ERRORS else "unexpected_error"
    last_good = state.get("last_good_at")
    process = _controller_process(runner) if managed else "unknown"
    controller = {"process": process, "state_status": state_status, "fresh": fresh,
                  "age_seconds": age, "error_code": error_code,
                  "selected": state.get("selected") if state.get("selected") in ROUTES + ("block",) else "unknown",
                  "last_good_route": state.get("last_good_route") if state.get("last_good_route") in ROUTES else "unknown",
                  "last_good_age_seconds": max(0.0, now - last_good) if _number(last_good) and last_good <= now + 5 else None}
    config, _ = _read_json(runtime / "controller.json") if managed else (None, "missing")
    routing = _routing(home, config, runner) if managed else {
        "available": False, "override": "unknown", "effective_route": "unknown", "source": "unknown",
        "static_default": "unknown", "error_code": "not_managed"}
    result = {"schema_version": 1, "managed": managed, "controller": controller, "routing": routing,
              "routes": _routes(state, fresh and process == "running" and state_status != "CONTROL_ERROR"),
              "pin": _pin(runtime, now), "updater": _updater(home)}
    overall_status, reason = _overall(result)
    result["overall"] = {"status": overall_status, "reason_code": reason}
    return result
