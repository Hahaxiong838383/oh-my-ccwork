"""EOT sidecar UDS 往返延迟基准:对照进程内直调,拆出 IPC 净开销。

跑法: /path/to/venv/python bench_eot.py /tmp/eot.sock
输出:in-process 与 over-UDS 的 p50/p95/p99(ms)+差值。
"""

from __future__ import annotations

import socket
import statistics
import struct
import sys
import time

import numpy as np

N_ROUNDS = 200
SAMPLES = 19200  # 1.2s @ 16k(最大载荷=最保守口径)


def pct(xs: list[float], p: float) -> float:
    return statistics.quantiles(xs, n=100)[int(p) - 1]


def bench_inprocess(pcm: np.ndarray) -> list[float]:
    import livekit.local_inference as li

    li.init_eot()
    eot = li.EOT()
    eot.predict(pcm)  # warmup
    out = []
    for _ in range(N_ROUNDS):
        t0 = time.perf_counter()
        eot.predict(pcm)
        out.append((time.perf_counter() - t0) * 1000)
    return out


def bench_uds(pcm: np.ndarray, sock_path: str) -> list[float]:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(sock_path)
    payload = pcm.tobytes()
    header = struct.pack("<I", len(payload))
    # warmup
    conn.sendall(header + payload)
    _recv_exact(conn, 4)
    out = []
    for _ in range(N_ROUNDS):
        t0 = time.perf_counter()
        conn.sendall(header + payload)
        _recv_exact(conn, 4)
        out.append((time.perf_counter() - t0) * 1000)
    conn.close()
    return out


def _recv_exact(conn: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf.extend(chunk)
    return bytes(buf)


def main() -> None:
    sock_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/eot.sock"
    rng = np.random.default_rng(7)
    pcm = (rng.normal(0, 800, SAMPLES)).astype(np.int16)

    inproc = bench_inprocess(pcm)
    uds = bench_uds(pcm, sock_path)
    for label, xs in (("in-process", inproc), ("over-UDS  ", uds)):
        print(
            f"{label}: p50={pct(xs, 50):.2f}ms p95={pct(xs, 95):.2f}ms "
            f"p99={pct(xs, 99):.2f}ms mean={statistics.mean(xs):.2f}ms"
        )
    print(
        f"IPC net overhead: p50={pct(uds, 50) - pct(inproc, 50):.2f}ms "
        f"p95={pct(uds, 95) - pct(inproc, 95):.2f}ms"
    )


if __name__ == "__main__":
    main()
