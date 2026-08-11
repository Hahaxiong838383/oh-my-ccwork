"""EOT 判停 sidecar 原型(选项 A 配套件)。

背景:v1-mini 判停在 livekit-local-inference(闭源 CPython .so,驻留 ~290M)里,
Rust worker 无法直接链接。本 sidecar 以独立小进程加载它,经 UDS 提供
`predict(pcm) -> P(turn ended)`,全机共享一份模型内存。

协议(length-prefixed 二进制,单连接串行):
  请求: u32le 字节数 N + N 字节 i16le PCM(16kHz mono,≤19200 样本=1.2s)
  响应: f32le 概率
EOT 每个话轮调用一次(非帧级热路径),单线程串行足够;predict 在 native 侧释放 GIL。

用法: /path/to/venv/python eot_sidecar.py /tmp/eot.sock
"""

from __future__ import annotations

import os
import socket
import struct
import sys

import numpy as np

MAX_SAMPLES = 19200  # EOT_MAX_SAMPLES(1.2s @ 16k)


def serve(sock_path: str) -> None:
    import livekit.local_inference as li

    li.init_eot()
    eot = li.EOT()
    print(f"[eot-sidecar] ready pid={os.getpid()} sock={sock_path}", flush=True)

    if os.path.exists(sock_path):
        os.unlink(sock_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    os.chmod(sock_path, 0o600)
    srv.listen(4)

    while True:
        conn, _ = srv.accept()
        try:
            _handle(conn, eot)
        except (ConnectionError, struct.error):
            pass
        finally:
            conn.close()


def _recv_exact(conn: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf.extend(chunk)
    return bytes(buf)


def _handle(conn: socket.socket, eot) -> None:  # noqa: ANN001 - EOT 类型在闭源 .so 内
    while True:
        header = _recv_exact(conn, 4)
        (nbytes,) = struct.unpack("<I", header)
        if nbytes == 0 or nbytes > MAX_SAMPLES * 2:
            raise ConnectionError(f"invalid payload size {nbytes}")
        payload = _recv_exact(conn, nbytes)
        pcm = np.frombuffer(payload, dtype=np.int16)
        prob = float(eot.predict(pcm))
        conn.sendall(struct.pack("<f", prob))


if __name__ == "__main__":
    serve(sys.argv[1] if len(sys.argv) > 1 else "/tmp/eot.sock")
