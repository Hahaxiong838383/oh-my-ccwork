#!/usr/bin/env python3
"""Run original Swift test methods when CLT has no XCTest. NOT formal XCTest.

Creates a private source snapshot and bridge build in --output, never native/.build.
Pass the actual password only through NIO_WARP_TEST_DEBUG_PASSWORD when verifying
the production digest; neither this runner nor its reports record the variable.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

PROJECT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = PROJECT / "native/Sources/NIOWarpApp"
TESTS = PROJECT / "native/Tests/NIOWarpAppTests"

SHIM = r'''
// Runs original methods with assertions, without linking the XCTest framework.
@MainActor class XCTestCase { func tearDown() async throws {} }
struct AssertionFailure: Error {}
struct XCTSkip: Error { let message: String; init(_ message: String) { self.message = message } }
var assertionCount = 0
var assertionFailures = [[String: Any]]()
func recordAssertion(_ passed: Bool, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
    assertionCount += 1
    if !passed { assertionFailures.append(["message": message, "file": String(describing: file), "line": Int(line)]) }
}
func XCTFail(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
    recordAssertion(false, message, file: file, line: line)
}
func XCTAssertEqual<T: Equatable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { let left = try lhs(), right = try rhs(); recordAssertion(left == right, "XCTAssertEqual: \(left) != \(right). \(message())", file: file, line: line) }
    catch { recordAssertion(false, "Thrown assertion: \(error)", file: file, line: line) }
}
func XCTAssertNotEqual<T: Equatable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { recordAssertion(try lhs() != rhs(), "XCTAssertNotEqual: \(message())", file: file, line: line) }
    catch { recordAssertion(false, "Thrown assertion: \(error)", file: file, line: line) }
}
func XCTAssertEqual<T: BinaryFloatingPoint>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, accuracy: T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { recordAssertion(abs(try lhs() - rhs()) <= accuracy, "accuracy: \(message())", file:file,line:line) }
    catch { recordAssertion(false,"comparison error",file:file,line:line) }
}
func XCTAssertTrue(_ expression: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { recordAssertion(try expression(), "XCTAssertTrue: \(message())", file: file, line: line) }
    catch { recordAssertion(false, "Thrown assertion: \(error)", file: file, line: line) }
}
func XCTAssertFalse(_ expression: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { recordAssertion(try !expression(), "XCTAssertFalse: \(message())", file: file, line: line) }
    catch { recordAssertion(false, "Thrown assertion: \(error)", file: file, line: line) }
}
func XCTAssertNil<T>(_ value: T?, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) { recordAssertion(value == nil, "XCTAssertNil: \(message())", file: file, line: line) }
func XCTAssertNotNil<T>(_ value: T?, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) { recordAssertion(value != nil, "XCTAssertNotNil: \(message())", file: file, line: line) }
func XCTUnwrap<T>(_ optional: @autoclosure () throws -> T?, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) throws -> T {
    let value = try optional()
    recordAssertion(value != nil, "XCTUnwrap: \(message())", file: file, line: line)
    guard let value else { throw AssertionFailure() }; return value
}
func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { _ = try expression(); recordAssertion(false, "XCTAssertThrowsError: \(message())", file: file, line: line) }
    catch { recordAssertion(true, "", file: file, line: line) }
}
'''
for comparison, operator in [("GreaterThan", ">"), ("GreaterThanOrEqual", ">="), ("LessThan", "<"), ("LessThanOrEqual", "<=")]:
    SHIM += f'''func XCTAssert{comparison}<T: Comparable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {{
        do {{ recordAssertion(try lhs() {operator} rhs(), "comparison failed: \\(message())", file: file, line: line) }}
        catch {{ recordAssertion(false,"comparison error",file:file,line:line) }}
    }}
'''


def digest(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    # Fixed acceptance selection: 85 methods as introduced with V1 mode locking.
    parser.add_argument("--suites", default="WorkbenchAccessSessionTests,WorkbenchModeUITests,WorkbenchModeInputTests,TabLayoutTests,CanvasGrowthConfirmationTests,MouseMappingReminderUITests,ProtoPiePlaybackUITests,NativeKeyboardOwnershipTests,MouseAutomationHandoffTests")
    parser.add_argument("--filter", default="", help="Optional regex matched against Class.testMethod")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot = output / "source-snapshot"
    snapshot.mkdir(exist_ok=True)
    source_hashes = {}
    for source in sorted(SOURCE.glob("*.swift")):
        payload = source.read_bytes()
        (snapshot / source.name).write_bytes(payload)
        source_hashes[source.name] = digest(payload)
    original_main = (snapshot / "main.swift").read_text()
    marker = "\nMainActor.assumeIsolated {"
    if original_main.count(marker) != 1:
        raise RuntimeError("App entrypoint boundary changed; refusing to run the real app")
    combined = original_main.rsplit(marker, 1)[0] + "\n" + SHIM
    cases, test_hashes = [], {}
    paths = [TESTS / "WorkbenchTestAccess.swift"] + [TESTS / (name + ".swift") for name in args.suites.split(",")]
    for path in paths:
        original = path.read_text()
        test_hashes[path.name] = digest(original.encode())
        (output / path.name).write_text(original)
        body = "\n".join("" if line in ["import XCTest", "@testable import NIOWarpApp"] else line for line in original.splitlines())
        combined += "\n#sourceLocation(file: " + json.dumps(str(path)) + ", line: 1)\n" + body + "\n#sourceLocation()\n"
        current = None
        for line in original.splitlines():
            match = re.search(r"final class (\w+Tests): XCTestCase", line)
            if match:
                current = match.group(1)
            method = re.search(r"^    func (test\w+)\(\)([^\{]*)\{", line)
            if method:
                name = current + "." + method.group(1)
                if not args.filter or re.search(args.filter, name):
                    cases.append((current, method.group(1), "async" in method.group(2), "throws" in method.group(2)))
    if not cases:
        raise RuntimeError("No test methods selected")
    combined += "\n@main struct StandaloneRegressionRunner { @MainActor static func main() async throws {\n"
    combined += "let tests: [(String, @MainActor () async throws -> Void)] = [\n"
    closures = []
    for cls, name, asynchronous, throwing in cases:
        invocation = ("try " if throwing else "") + ("await " if asynchronous else "") + "test." + name + "()"
        closures.append("(" + json.dumps(cls + "." + name) + ", { let test = " + cls + "(); do { " + invocation + "; try await test.tearDown() } catch { try? await test.tearDown(); throw error } })")
    combined += ",\n".join(closures) + r'''
]
var results = [[String: Any]]()
var skipped = 0
for (name, method) in tests {
    let countBefore = assertionCount, failuresBefore = assertionFailures.count, started = Date()
    var skipReason: String?
    FileHandle.standardError.write(Data(("RUN " + name + "\n").utf8))
    do { try await method() }
    catch let skip as XCTSkip { skipped += 1; skipReason = skip.message }
    catch { assertionFailures.append(["test":name,"message":"Thrown test error: \(error)"]) }
    var item: [String: Any] = ["name":name,"assertions":assertionCount-countBefore,"failures":assertionFailures.count-failuresBefore,"durationSeconds":Date().timeIntervalSince(started)]
    if let skipReason { item["skipped"] = skipReason }
    results.append(item)
}
let result: [String: Any] = ["runtime":"Original production sources and original test methods with assertion shim; NOT formal XCTest", "testCount":results.count,"assertionCount":assertionCount,"failureCount":assertionFailures.count,"skippedCount":skipped,"tests":results,"failures":assertionFailures,"result":assertionFailures.isEmpty ? "PASS" : "FAIL"]
print(String(data:try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
exit(assertionFailures.isEmpty ? 0 : 1)
} }
'''
    (output / "runner.swift").write_text(combined)
    bridge_source = PROJECT / "native/Sources/NIOVirtualDisplay"
    bridge = output / "bridge"
    bridge.mkdir(exist_ok=True)
    modulemap = 'module NIOVirtualDisplay { header ' + json.dumps(str(bridge_source / "include/NIOVirtualDisplay.h")) + ' export * }\n'
    (bridge / "module.modulemap").write_text(modulemap)
    obj = bridge / "NIOVirtualDisplay.o"
    bridge_result = subprocess.run(["/usr/bin/clang", "-fobjc-arc", "-I", str(bridge_source / "include"), "-c", str(bridge_source / "NIOVirtualDisplay.m"), "-o", str(obj)], capture_output=True, text=True, timeout=60)
    (output / "bridge-build.log").write_text(bridge_result.stdout + bridge_result.stderr)
    if bridge_result.returncode:
        raise RuntimeError(bridge_result.stderr)
    command = ["/usr/bin/swiftc", "-swift-version", "5", "-parse-as-library", "-Xcc", "-fmodule-map-file=" + str(bridge / "module.modulemap"), str(obj), "-o", str(output / "runner")]
    command += [str(p) for p in sorted(snapshot.glob("*.swift")) if p.name != "main.swift"] + [str(output / "runner.swift")]
    build = subprocess.run(command, capture_output=True, text=True, timeout=240)
    (output / "build.log").write_text(build.stdout + build.stderr)
    if build.returncode:
        print(build.stderr)
        return build.returncode
    result = subprocess.run([str(output / "runner")], capture_output=True, text=True, timeout=300)
    (output / "stderr.log").write_text(result.stderr)
    (output / "stdout.json").write_text(result.stdout)
    if not result.stdout.strip():
        print(result.stderr)
        return result.returncode or 1
    record = json.loads(result.stdout)
    record.update({"productionSourceSHA256": source_hashes, "testSourceSHA256": test_hashes, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "exitCode": result.returncode})
    (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({key: record[key] for key in ["result", "testCount", "assertionCount", "failureCount", "skippedCount", "failures"]}, indent=2))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
