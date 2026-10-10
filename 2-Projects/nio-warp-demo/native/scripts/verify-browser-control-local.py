#!/usr/bin/env python3
"""Run real XCTest legacy WebSocket checks against a loopback-only fixture.

Uses the already available Python websockets module; never installs dependencies.
Arguments: native-directory log-file [XCTest-selector]. Each run has a 20s bound.
"""
import asyncio
import json
import os
import pathlib
import sys

try:
    from websockets.asyncio.server import serve
except ImportError:
    sys.exit(f'{sys.executable}: this optional fixture needs an existing Python websockets module; no dependencies were installed.')


async def main():
    if len(sys.argv) not in (3, 4):
        sys.exit('Usage: verify-browser-control-local.py native-directory log-file [XCTest-selector]')
    native_dir = pathlib.Path(sys.argv[1]).resolve()
    log = pathlib.Path(sys.argv[2]).resolve()
    log.parent.mkdir(parents=True, exist_ok=True)
    marker = pathlib.Path(str(log) + '.cancel-seen')
    marker.unlink(missing_ok=True)
    ordinal = 0

    async def handle(connection):
        nonlocal ordinal
        ordinal += 1
        current = ordinal
        try:
            async for message in connection:
                request = json.loads(message)
                if request['method'] == 'Fixture.awaitCancellation':
                    marker.write_text('received', encoding='utf-8')
                    # Intentionally do not complete the command. The real client's
                    # cancellation must stop its pending receive and close this peer.
                    await connection.wait_closed()
                    break
                result = {
                    'requestPath': connection.request.path,
                    'echoMethod': request['method'],
                    'requestId': request['id'],
                    'connectionOrdinal': current,
                    'hasSessionID': 'sessionId' in request,
                }
                await connection.send(json.dumps({'id': request['id'], 'result': result}))
        except Exception as error:
            print(f'Fixture peer ended: {type(error).__name__}', flush=True)

    xcode = pathlib.Path(os.environ.get('NIO_NATIVE_TEST_XCODE_APP', '/Applications/Xcode.app'))
    library = xcode / 'Contents/Developer/Platforms/MacOSX.platform/Developer'
    async with serve(handle, '127.0.0.1', 0, max_size=65536) as server:
        port = server.sockets[0].getsockname()[1]
        environment = os.environ.copy()
        environment.update(
            DYLD_FRAMEWORK_PATH=f'{library}/Library/Frameworks:{xcode}/Contents/SharedFrameworks',
            DYLD_LIBRARY_PATH=f'{library}/usr/lib',
            NIO_WARP_CONTROL_TEST_SOCKET=f'ws://127.0.0.1:{port}/devtools/browser/control-fixture',
            NIO_WARP_CONTROL_TEST_CANCEL_SEEN=str(marker),
        )
        selector = sys.argv[3] if len(sys.argv) == 4 else 'NIOWarpAppTests.ProtoPieBrowserControlTests'
        with log.open('wb') as output:
            process = await asyncio.create_subprocess_exec(
                str(xcode / 'Contents/Developer/usr/bin/xctest'), '-XCTest', selector,
                str(native_dir / '.build/arm64-apple-macosx/debug/NIOWarpAppPackageTests.xctest'),
                cwd=native_dir, env=environment, stdout=output, stderr=asyncio.subprocess.STDOUT,
            )
            try:
                code = await asyncio.wait_for(process.wait(), 20)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                code = 124
                print('XCTest exceeded 20s; terminated. This is not a passing result.', flush=True)
        print(f'XCTest exit: {code}; log: {log}; connections: {ordinal}', flush=True)
        return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
