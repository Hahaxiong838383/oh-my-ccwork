from __future__ import annotations

import argparse
import contextlib
import socket
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _find_available_port(preferred_port: int) -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", preferred_port))
        except OSError:
            probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="启动外接显示器畸变校正交互 Demo")
    parser.add_argument("--port", type=int, default=8765, help="本地服务端口")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    return parser


def main() -> None:
    args = _parser().parse_args()
    web_root = Path(__file__).resolve().parents[2] / "web"
    if not web_root.exists():
        raise SystemExit(f"找不到网页资源目录：{web_root}")

    port = _find_available_port(args.port)
    handler = lambda *handler_args, **handler_kwargs: SimpleHTTPRequestHandler(  # noqa: E731
        *handler_args,
        directory=str(web_root),
        **handler_kwargs,
    )
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    control_url = f"http://127.0.0.1:{port}/control.html"
    output_url = f"http://127.0.0.1:{port}/output.html"

    print("NIO 外接屏畸变校正 Demo 已启动")
    print(f"控制台：{control_url}")
    print(f"外接屏：{output_url}")
    print("停止服务：回到此终端按 Control+C")
    if not args.no_open:
        webbrowser.open(control_url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDemo 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
