#!/usr/bin/env python3
"""Execute verbatim production main guard/exit methods with isolated I/O spies.

This is an integration boundary regression, not a second implementation of the
guard. Only platform reads/effects and collaborator objects are substituted;
the production pointer policy and four main methods are extracted unchanged.
No real pointer, Chrome, screen layout, event tap or preferences are touched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PROJECT = next(parent for parent in Path(__file__).resolve().parents
               if (parent / "native/Sources/NIOWarpApp/main.swift").is_file())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path,
                    default=PROJECT / "artifacts/lid-fix-v0148-20260921/regression")
parser.add_argument("--baseline", default="nio-warp-before-lid-pointer-recovery-20260921")
args = parser.parse_args()
HERE = args.output.resolve()
HERE.mkdir(parents=True, exist_ok=True)
SOURCE = PROJECT / "native/Sources/NIOWarpApp"
BASELINE = args.baseline
PREFIX = subprocess.check_output(["git", "rev-parse", "--show-prefix"], cwd=PROJECT, text=True).strip() + "native/Sources/NIOWarpApp/"


def extract(text, marker):
    start = text.index(marker)
    brace = text.index("{", start)
    # Selected methods/policy contain no brace literals. Enforce this assumption
    # by retaining the exact extracted bytes and compiling each complete fragment.
    depth = 1
    end = brace + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]


SPY_SOURCE = r'''
import Foundation
import CoreGraphics

final class IOState {
    var screens = [VisiblePointerRecoveryPolicy.Screen]()
    var point: CGPoint? = CGPoint(x: 1447.96484375, y: 349.66796875)
    var warps = [CGPoint]()
    var warpResult: CGError = .success
    var arrowSets = 0
    var activations = 0
    var panelFronts = 0
    var hidden = 0
    var diagnostics = [String]()
}
var io = IOState()
struct CGEvent {
    let location: CGPoint
    init?(source: Any?) { guard let point = io.point else { return nil }; location = point }
}
func CGWarpMouseCursorPosition(_ point: CGPoint) -> CGError {
    io.warps.append(point)
    if io.warpResult == .success { io.point = point }
    return io.warpResult
}
struct FakeCursor { func set() { io.arrowSets += 1 } }
enum NSCursor { static let arrow = FakeCursor() }
struct FakeApplication {
    func activate(ignoringOtherApps: Bool) { io.activations += 1 }
}
let NSApp = FakeApplication()
struct FakeWindow { let frame: CGRect; let screenID: CGDirectDisplayID }
final class FakePanel {
    var window: FakeWindow?
    func bringToFront() { io.panelFronts += 1 }
}
final class FakeOutput { var isWarpVisible = true }
final class FakePlayback {
    struct Runtime { var isActive = true }
    var runtime = Runtime()
    var stops = 0
    func stop(reason: String) { stops += 1; runtime.isActive = false }
}
final class FakeMapping {
    var isActive = false
    var startTask: Bool?
    var closingTask: Bool?
    // This computed property is pasted verbatim from the current production
    // MouseMappingController, so the fixture cannot silently invent ownership.
    __PRODUCTION_NATIVE_INPUT_PROPERTY__
    var stops = 0
    func stop(reason: String) { stops += 1; isActive = false; startTask = nil }
}
enum VisiblePointerRecoveryRuntime {
    static func screens() -> [VisiblePointerRecoveryPolicy.Screen] { io.screens }
    static func recoveryDestination(window: FakeWindow?, lastVisiblePoint: CGPoint?, forceWorkbench: Bool = false) -> CGPoint? {
        guard let point = io.point else { return nil }
        return VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: point, screens: io.screens,
            workbenchFrame: window?.frame, windowScreenID: window?.screenID,
            lastVisiblePoint: lastVisiblePoint, forceWorkbench: forceWorkbench)
    }
}
final class MainGuardHarness {
    var displaysAsleep = false
    var lastVisiblePointer: CGPoint?
    let mouseMapping = FakeMapping()
    let playback = FakePlayback()
    var outputController: FakeOutput? = FakeOutput()
    var controlPanel: FakePanel? = FakePanel()
    var hasControlScreen = false
    func chooseScreens() -> (source: Int?, output: Int)? { (hasControlScreen ? 1 : nil, 4) }
    func emergencyHideWarp(reason: String, userInitiated: Bool, notifyProtoPie: Bool = true) {
        io.hidden += 1; outputController?.isWarpVisible = false
    }
    func recordAutomaticPointerRecovery(from: CGPoint, to: CGPoint?,
        screens: [VisiblePointerRecoveryPolicy.Screen], outcome: String) { io.diagnostics.append(outcome) }
    func runGuard() { guardInvisiblePresentationScreen() }
    func runExplicitReturn() { showWorkbench() }
'''

TEST_SOURCE = r'''
}

typealias Screen = VisiblePointerRecoveryPolicy.Screen
func screen(_ id: UInt32, _ rect: CGRect, owned: Bool = false, builtin: Bool = false,
            active: Bool = true, asleep: Bool = false) -> Screen {
    Screen(id: id, frame: rect, visibleFrame: rect, quartzBounds: rect,
        isBuiltIn: builtin, isActive: active, isAsleep: asleep, isOwned: owned)
}
let source = screen(12, CGRect(x: 0, y: 0, width: 7680, height: 2800), owned: true)
let output = screen(4, CGRect(x: -2846, y: -936, width: 7680, height: 936))
let laptop = screen(1, CGRect(x: -1512, y: 0, width: 1512, height: 982), builtin: true)
var results = [[String: Any]]()
var totalAssertions = 0
func test(_ name: String, _ action: (MainGuardHarness, (Bool, String) -> Void) -> Void) {
    io = IOState(); io.screens = [source, output]
    let harness = MainGuardHarness()
    var failures = [String](); var assertions = 0
    action(harness, { ok, message in assertions += 1; if !ok { failures.append(message) } })
    totalAssertions += assertions
    results.append(["name": name, "assertions": assertions, "failures": failures,
        "effects": ["playbackStops": harness.playback.stops, "mappingStops": harness.mouseMapping.stops,
                    "hidden": io.hidden, "activation": io.activations, "panelFronts": io.panelFronts,
                    "warps": io.warps.map { [$0.x, $0.y] }, "arrowSets": io.arrowSets,
                    "diagnostics": io.diagnostics]])
}
func checkNoExit(_ h: MainGuardHarness, _ check: (Bool, String) -> Void) {
    check(h.playback.stops == 0, "automatic guard must not stop playback")
    check(h.playback.runtime.isActive, "playback remains active")
    check(h.mouseMapping.stops == 0, "automatic guard must not cancel mapping/start")
    check(io.hidden == 0, "automatic guard must not hide corrected output")
    check(h.outputController?.isWarpVisible == true, "corrected output stays visible")
    check(io.activations == 0 && io.panelFronts == 0, "automatic guard must not change focus")
}

test("lid_owned_main_relocates_without_exit") { h, check in
    h.runGuard(); checkNoExit(h, check)
    check(io.warps.count == 1, "one safe pointer recovery")
    check(io.warps.first.map { output.quartzBounds.contains($0) && !source.quartzBounds.contains($0) } == true,
          "recovery belongs to visible physical screen, not source")
    check(h.lastVisiblePointer == io.warps.first, "remember recovered point")
}
test("sleep_does_not_recover_or_exit") { h, check in
    h.displaysAsleep = true; h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty && h.lastVisiblePointer == nil, "asleep state has no pointer writes")
}
test("no_physical_waits_without_exit") { h, check in
    io.screens = [source]; h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty && h.lastVisiblePointer == nil, "no destination waits without pointer writes")
}
test("sleeping_physical_waits_without_exit") { h, check in
    io.screens = [source, screen(4, output.quartzBounds, asleep: true)]
    h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty, "sleeping output cannot receive pointer")
}
test("transient_owned_overlap_waits_and_does_not_remember_hidden_point") { h, check in
    io.screens = [source, screen(4, source.quartzBounds)]
    h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty, "overlap has no safe destination")
    check(h.lastVisiblePointer == nil, "do not remember an owned-screen point as visible")
}
for mode in ["active", "starting"] {
    test("native_input_\(mode)_is_not_interrupted") { h, check in
        h.mouseMapping.isActive = mode == "active"
        h.mouseMapping.startTask = mode == "starting" ? true : nil
        h.runGuard(); checkNoExit(h, check)
        check(io.warps.isEmpty && h.lastVisiblePointer == nil, "native input owns pointer while \(mode)")
        check(h.mouseMapping.protectsNativeInput, "native ownership remains intact")
    }
}
test("closing_only_does_not_block_pointer_recovery") { h, check in
    h.mouseMapping.closingTask = true
    check(!h.mouseMapping.protectsNativeInput, "CDP cleanup has no native pointer ownership")
    h.runGuard(); checkNoExit(h, check)
    check(io.warps.count == 1, "retained closing task must not disable recovery")
    check(io.warps.first.map { output.quartzBounds.contains($0) && !source.quartzBounds.contains($0) } == true,
          "closing-only pointer is recovered to visible physical screen")
    check(h.mouseMapping.closingTask != nil, "pointer recovery leaves CDP cleanup alone")
}
test("already_physical_pointer_is_untouched") { h, check in
    io.point = CGPoint(x: 100, y: -200); let before = io.point
    h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty, "visible pointer must not move")
    check(h.lastVisiblePointer == before, "visible point recorded")
}
test("recovery_is_idempotent_on_next_presentation_tick") { h, check in
    h.runGuard(); h.runGuard(); checkNoExit(h, check)
    check(io.warps.count == 1, "subsequent stable tick performs no second warp")
}
test("warp_failure_keeps_output_and_does_not_remember_unreached_point") { h, check in
    io.warpResult = .failure; h.runGuard(); checkNoExit(h, check)
    check(io.warps.count == 1, "a bounded warp is attempted")
    check(h.lastVisiblePointer == nil && io.arrowSets == 0, "failed warp cannot claim cursor recovered")
}
test("missing_event_is_noop") { h, check in
    io.point = nil; h.runGuard(); checkNoExit(h, check)
    check(io.warps.isEmpty, "unavailable event does not move pointer")
}
test("explicit_workbench_while_lid_closed_still_stops_and_hides") { h, check in
    h.mouseMapping.isActive = true; h.runExplicitReturn()
    check(h.playback.stops == 1 && !h.playback.runtime.isActive, "explicit request stops plan")
    check(h.mouseMapping.stops == 1, "explicit request releases mapping")
    check(io.hidden == 1 && h.outputController?.isWarpVisible == false, "headless explicit request hides output")
}
test("explicit_workbench_with_laptop_still_activates_and_recovers") { h, check in
    h.hasControlScreen = true; io.screens = [source, output, laptop]
    h.controlPanel?.window = FakeWindow(frame: CGRect(x: -1400, y: 200, width: 800, height: 500), screenID: 1)
    h.runExplicitReturn()
    check(h.playback.stops == 1 && h.mouseMapping.stops == 1, "explicit request releases plan and mapping")
    check(io.hidden == 0, "laptop workbench need not hide output")
    check(io.activations == 1 && io.panelFronts == 1, "explicit request activates workbench")
    check(io.warps.count == 1 && io.warps.first.map { laptop.quartzBounds.contains($0) } == true,
          "explicit return forces pointer into laptop workbench")
}
let failureCount = results.reduce(0) { $0 + ($1["failures"] as! [String]).count }
let summary: [String: Any] = ["testCount": results.count, "assertionCount": totalAssertions,
    "failureCount": failureCount, "tests": results, "result": failureCount == 0 ? "PASS" : "FAIL"]
print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
'''


def run(label, main, policy, mapping_property):
    methods = [extract(main, f"private func {name}(") for name in (
        "showWorkbench", "returnToWorkbench", "recoverVisiblePointer", "guardInvisiblePresentationScreen")]
    # Extract the genuine pure policy, not its hardware adapter.
    policy_body = extract(policy, "enum VisiblePointerRecoveryPolicy {")
    directory = HERE / ("guard-" + label)
    directory.mkdir(exist_ok=True)
    (directory / "production-methods.swift.txt").write_text("\n\n".join(methods) + "\n")
    (directory / "production-policy.swift.txt").write_text(policy_body + "\n")
    (directory / "production-input-guard-property.swift.txt").write_text(mapping_property + "\n")
    runner = SPY_SOURCE.replace("__PRODUCTION_NATIVE_INPUT_PROPERTY__", mapping_property) + "\n\n".join(methods) + TEST_SOURCE
    runner = "import Foundation\nimport CoreGraphics\n" + policy_body + "\n" + runner
    (directory / "runner.swift").write_text(runner)
    build = subprocess.run(["/usr/bin/swiftc", "-swift-version", "5", str(directory / "runner.swift"),
                            "-o", str(directory / "runner")], capture_output=True, text=True)
    (directory / "build.log").write_text(build.stdout + build.stderr)
    if build.returncode:
        raise RuntimeError(build.stderr)
    execution = subprocess.run([str(directory / "runner")], capture_output=True, text=True, timeout=15)
    (directory / "stderr.log").write_text(execution.stderr)
    if execution.returncode:
        raise RuntimeError(execution.stderr)
    result = json.loads(execution.stdout)
    result["label"] = label
    result["mainSourceSHA256"] = hashlib.sha256(main.encode()).hexdigest()
    result["policySourceSHA256"] = hashlib.sha256(policy.encode()).hexdigest()
    result["mappingPropertySHA256"] = hashlib.sha256(mapping_property.encode()).hexdigest()
    result["methodSHA256"] = [hashlib.sha256(m.encode()).hexdigest() for m in methods]
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


old_main = subprocess.check_output(["git", "show", BASELINE + ":" + PREFIX + "main.swift"], cwd=PROJECT, text=True)
old_policy = subprocess.check_output(["git", "show", BASELINE + ":" + PREFIX + "VisiblePointerRecoveryPolicy.swift"], cwd=PROJECT, text=True)
mapping_property = extract((SOURCE / "MouseMappingController.swift").read_text(), "var protectsNativeInput: Bool")
old = run("v75-red", old_main, old_policy, mapping_property)
new = run("current-green", (SOURCE / "main.swift").read_text(), (SOURCE / "VisiblePointerRecoveryPolicy.swift").read_text(), mapping_property)
red_reproduced = bool(old["tests"][0]["failures"]) and old["tests"][0]["effects"]["playbackStops"] == 1 and old["tests"][0]["effects"]["hidden"] == 1
summary = {
    "runtime": "Verbatim production main methods and pure pointer policy executed with isolated platform/collaborator spies; not formal XCTest or a hardware lid test",
    "baseline": BASELINE, "redReproducedActualStopAndHide": red_reproduced,
    "mappingPropertySHA256": hashlib.sha256(mapping_property.encode()).hexdigest(),
    "red": {key: old[key] for key in ["testCount", "assertionCount", "failureCount", "mainSourceSHA256"]},
    "green": {key: new[key] for key in ["testCount", "assertionCount", "failureCount", "mainSourceSHA256"]},
    "result": "PASS" if red_reproduced and new["failureCount"] == 0 else "FAIL",
}
(HERE / "guard-red-green-result.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["result"] == "PASS" else 1)
