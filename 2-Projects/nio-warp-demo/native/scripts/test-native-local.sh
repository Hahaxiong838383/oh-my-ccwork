#!/bin/zsh
set -euo pipefail

# This machine's CLT compiles Swift, while the existing Xcode supplies XCTest.
# No xcode-select, installation, production defaults, or app launch is involved.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="${NIO_NATIVE_TEST_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
XCODE_APP="${NIO_NATIVE_TEST_XCODE_APP:-/Applications/Xcode.app}"
TEST_FRAMEWORKS="$XCODE_APP/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks"
TEST_LIBRARIES="$XCODE_APP/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib"
TEST_EXECUTABLE="$XCODE_APP/Contents/Developer/usr/bin/xctest"
LOG_DIR="${NIO_NATIVE_TEST_LOG_DIR:-$(mktemp -d /tmp/nio-native-tests.XXXXXX)}"
export DEVELOPER_DIR="${NIO_NATIVE_TEST_DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
mkdir -p "$LOG_DIR"
cd "$NATIVE_DIR"
[[ -x "$TEST_EXECUTABLE" && -d "$TEST_FRAMEWORKS/XCTest.framework" && -f "$TEST_LIBRARIES/libXCTestSwiftSupport.dylib" ]] || {
  print -u2 "Existing Xcode XCTest runtime is incomplete: $XCODE_APP"
  exit 2
}
/usr/bin/swift --version > "$LOG_DIR/toolchain.log" 2>&1
if [[ "${NIO_NATIVE_TEST_SKIP_BUILD:-0}" != 1 ]]; then
  if /usr/bin/swift test \
    -Xswiftc -F -Xswiftc "$TEST_FRAMEWORKS" \
    -Xswiftc -I -Xswiftc "$TEST_LIBRARIES" \
    -Xlinker -L -Xlinker "$TEST_LIBRARIES" \
    -Xlinker -rpath -Xlinker "$TEST_FRAMEWORKS" \
    -Xlinker -rpath -Xlinker "$TEST_LIBRARIES" \
    > "$LOG_DIR/build.log" 2>&1; then
    print "Test bundle compiled; executing XCTest explicitly. Logs: $LOG_DIR"
  else
    result=$?
    tail -n 40 "$LOG_DIR/build.log"
    exit "$result"
  fi
else
  print "Using existing test bundle without rebuilding. Logs: $LOG_DIR"
fi
export DYLD_FRAMEWORK_PATH="$TEST_FRAMEWORKS:$XCODE_APP/Contents/SharedFrameworks"
export DYLD_LIBRARY_PATH="$TEST_LIBRARIES"
python3 - "$TEST_EXECUTABLE" "$NATIVE_DIR/.build/arm64-apple-macosx/debug/NIOWarpAppPackageTests.xctest" "$LOG_DIR" <<'PY'
import os, pathlib, re, subprocess, sys
executable, bundle, directory = sys.argv[1:]
log = pathlib.Path(directory) / 'xctest.log'
command = [executable]
selected = os.environ.get('NIO_NATIVE_TEST_FILTER', '')
if selected:
    command.extend(['-XCTest', selected])
command.append(bundle)
timeout = float(os.environ.get('NIO_NATIVE_TEST_TIMEOUT_SECONDS', '300'))
with log.open('wb') as output:
    try:
        code = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        code = 124
        print(f'XCTest exceeded {timeout:g}s; terminated. This is not a passing result.')
contents = log.read_text(errors='replace')
for state in ('passed', 'failed', 'skipped'):
    count = len(re.findall(r'^Test Case .* ' + state + r' \(', contents, re.M))
    print(f'{state} test methods: {count}')
summaries = re.findall(r'^\s*Executed .*$', contents, re.M)
if summaries:
    print(summaries[-1].strip())
print(f'XCTest exit: {code}; runtime log: {log}')
if code < 0:
    code = 128 - code
sys.exit(code)
PY
