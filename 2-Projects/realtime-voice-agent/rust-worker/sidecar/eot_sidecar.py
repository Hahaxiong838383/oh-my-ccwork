"""推理 sidecar(选项 A 配套件):EOT 判停 + 声纹 embedding 共进程。

背景:v1-mini EOT 在 livekit-local-inference(闭源 CPython .so)里、声纹走
sherpa-onnx SpeakerEmbeddingExtractor——Rust worker 都无法直接链接。本 sidecar
以独立小进程加载,经 UDS 提供推理;全机共享一份模型内存。声纹**必须**与注册
脚本同一条 sherpa 管线(fbank 参数逐位一致),否则与 registry.json 里的向量不可比
——这是不在 Rust 侧重写 fbank 的原因。

协议 v2(length-prefixed 二进制,每连接串行、多连接并行):
  请求: u8 op + u32le 字节数 N + N 字节 payload
    op=1 EOT 判停: payload=i16le PCM(16k mono,≤19200 样本) → 响应 f32le 概率
    op=2 声纹嵌入: payload=i16le PCM(16k mono)           → 响应 u32le dim + dim×f32le
                    (embedding 已 L2 归一,与 speaker_id.compute_embedding 同口径)
  多连接:EOT(热路径,每话轮一次)与声纹(旁路,数百 ms)各持一条连接互不阻塞;
  每连接一线程,native 推理释放 GIL。

env:
  SPEAKER_ID_MODEL  CAM++ onnx 路径(op=2 首次调用时懒加载;缺省则 op=2 报错关连接)

用法: /path/to/venv/python eot_sidecar.py /tmp/eot.sock
"""

from __future__ import annotations

import os
import socket
import struct
import sys
import threading

import numpy as np

MAX_SAMPLES = 19200  # EOT_MAX_SAMPLES(1.2s @ 16k)
MAX_SPEAKER_BYTES = 16000 * 2 * 20  # 声纹上限 20s(识别只需 5-12s)

OP_EOT = 1
OP_SPEAKER_EMBED = 2

_speaker_lock = threading.Lock()
_speaker_extractor = None


def _get_speaker_extractor():
    """懒加载 sherpa-onnx extractor(线程安全,单例;compute 时持内部锁串行)。"""
    global _speaker_extractor
    with _speaker_lock:
        if _speaker_extractor is None:
            import sherpa_onnx

            model = os.environ.get("SPEAKER_ID_MODEL", "")
            if not model or not os.path.isfile(model):
                raise RuntimeError(f"SPEAKER_ID_MODEL 未配置或不存在: {model!r}")
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=model, num_threads=1, debug=False, provider="cpu"
            )
            if not config.validate():
                raise RuntimeError(f"speaker 模型配置无效 {model}")
            _speaker_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
            print(f"[eot-sidecar] speaker extractor loaded dim={_speaker_extractor.dim}", flush=True)
        return _speaker_extractor


def _speaker_embed(pcm: np.ndarray) -> np.ndarray:
    """i16 PCM → L2 归一 embedding(与 speaker_id.compute_embedding 逐行同口径)。"""
    extractor = _get_speaker_extractor()
    samples = (pcm.astype(np.float32) / 32768.0).copy()
    with _speaker_lock:  # extractor 非线程安全,比对串行(旁路可容)
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        stream.input_finished()
        emb = np.array(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(emb))
    if norm > 0.0:
        emb = emb / norm
    return emb.astype(np.float32)


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
    srv.listen(8)

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_conn_loop, args=(conn, eot), daemon=True).start()


def _conn_loop(conn: socket.socket, eot) -> None:  # noqa: ANN001 - EOT 类型在闭源 .so 内
    try:
        _handle(conn, eot)
    except (ConnectionError, struct.error):
        pass
    except Exception as exc:  # 单连接异常只关该连接,不拖垮进程
        print(f"[eot-sidecar] conn error: {exc!r}", flush=True)
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


def _handle(conn: socket.socket, eot) -> None:  # noqa: ANN001
    while True:
        header = _recv_exact(conn, 5)
        op = header[0]
        (nbytes,) = struct.unpack("<I", header[1:5])
        if op == OP_EOT:
            if nbytes == 0 or nbytes > MAX_SAMPLES * 2:
                raise ConnectionError(f"invalid eot payload size {nbytes}")
            payload = _recv_exact(conn, nbytes)
            pcm = np.frombuffer(payload, dtype=np.int16)
            prob = float(eot.predict(pcm))
            conn.sendall(struct.pack("<f", prob))
        elif op == OP_SPEAKER_EMBED:
            if nbytes == 0 or nbytes > MAX_SPEAKER_BYTES:
                raise ConnectionError(f"invalid speaker payload size {nbytes}")
            payload = _recv_exact(conn, nbytes)
            pcm = np.frombuffer(payload, dtype=np.int16)
            emb = _speaker_embed(pcm)
            conn.sendall(struct.pack("<I", emb.shape[0]) + emb.tobytes())
        else:
            raise ConnectionError(f"unknown op {op}")


if __name__ == "__main__":
    serve(sys.argv[1] if len(sys.argv) > 1 else "/tmp/eot.sock")
