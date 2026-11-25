#!/usr/bin/env python3
"""对已部署的本地语音服务做真实音频验收。只使用标准库，录音不出这台机器。"""

from __future__ import annotations

import array
import base64
import json
import os
import socket
import sys
import urllib.request
import wave


def request_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode())


def post_tts(base: str, text: str) -> tuple[bytes, dict]:
    body = json.dumps({"text": text}).encode()
    request = urllib.request.Request(
        f"{base}/v1/tts",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        return response.read(), headers


def rms(pcm: bytes) -> float:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if not samples:
        return 0.0
    total = sum(sample * sample for sample in samples)
    return (total / len(samples)) ** 0.5


def downsample(pcm: bytes, source: int, target: int) -> bytes:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if not samples:
        return b""
    count = int(len(samples) * target / source)
    output = array.array("h")
    for index in range(count):
        position = int(index * source / target)
        output.append(samples[min(position, len(samples) - 1)])
    return output.tobytes()


def wav_pcm(path: str) -> bytes:
    with wave.open(path) as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2 or handle.getframerate() != 16000:
            raise SystemExit(f"需要 16k 单声道 s16 wav，实际 {path}")
        return handle.readframes(handle.getnframes())


class SocketWs:
    def __init__(self, host: str, port: int, path: str):
        self.sock = socket.create_connection((host, port), 10)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SystemExit("websocket 握手中断")
            data += chunk
        head, rest = data.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise SystemExit(head.decode(errors="replace"))
        self.buf = bytearray(rest)

    def send(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(0x80 | 127)
            header.extend(length.to_bytes(8, "big"))
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + masked)

    def recv(self) -> tuple[int, bytes]:
        while True:
            header = self._exact(2)
            opcode = header[0] & 0x0F
            masked = bool(header[1] & 0x80)
            length = header[1] & 0x7F
            if length == 126:
                length = int.from_bytes(self._exact(2), "big")
            elif length == 127:
                length = int.from_bytes(self._exact(8), "big")
            mask = self._exact(4) if masked else b""
            payload = bytearray(self._exact(length))
            if masked:
                for index, value in enumerate(payload):
                    payload[index] = value ^ mask[index % 4]
            if opcode == 0x9:
                self.send(0xA, bytes(payload))
                continue
            return opcode, bytes(payload)

    def _exact(self, size: int) -> bytes:
        while len(self.buf) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("websocket 提前关闭")
            self.buf.extend(chunk)
        data = bytes(self.buf[:size])
        del self.buf[:size]
        return data


def recognize(host: str, port: int, pcm: bytes) -> str:
    socket_ws = SocketWs(host, port, "/v1/asr")
    step = 3200
    for offset in range(0, len(pcm), step):
        socket_ws.send(2, pcm[offset : offset + step])
    socket_ws.send(1, b'{"event":"end"}')
    finals: list[str] = []
    while True:
        opcode, payload = socket_ws.recv()
        if opcode == 0x8:
            break
        if opcode != 0x1:
            continue
        event = json.loads(payload.decode())
        if event.get("type") == "error":
            raise SystemExit(f"asr error: {event.get('error')}")
        if event.get("type") == "final":
            text = str(event.get("text") or "").strip()
            if text:
                finals.append(text)
    socket_ws.sock.close()
    return "".join(finals)


def main() -> None:
    base = sys.argv[1]
    wav = sys.argv[2]
    host_port = base.split("://", 1)[1]
    host, port_text = host_port.rsplit(":", 1)
    port = int(port_text)
    health = request_json(f"{base}/health")
    question = "今天天气怎么样"
    pcm, headers = post_tts(base, question)
    rate = int(headers.get("x-sample-rate", "0"))
    elapsed = int(headers.get("x-elapsed-ms", "0"))
    duration = (len(pcm) / 2 / rate) if rate else 0
    level = rms(pcm)
    reference_pcm = wav_pcm(wav)
    reference = recognize(host, port, reference_pcm)
    after_silence = recognize(host, port, bytes(2 * 16000 * 32) + reference_pcm)
    if not reference or after_silence != reference:
        raise SystemExit("32 秒静默后的同一连接未能识别后续人声")
    heard = recognize(host, port, downsample(pcm, rate, 16000))
    report = {
        "health_label": health.get("label"),
        "original_xiaoke_voice": health.get("original_xiaoke_voice"),
        "voice": health.get("voice"),
        "speaker_code": health.get("speaker_code"),
        "tts_question": question,
        "tts_elapsed_ms": elapsed,
        "tts_duration_s": round(duration, 3),
        "tts_rms": round(level, 1),
        "tts_bytes": len(pcm),
        "asr_reference": reference,
        "asr_after_32s_silence": after_silence,
        "asr_roundtrip": heard,
    }
    print(json.dumps(report, ensure_ascii=False))
    if health.get("original_xiaoke_voice") is not False:
        raise SystemExit("健康检查没有标明这不是原音色")
    if rate != 24000 or duration < 0.4 or level < 100 or reference != "价格太高的原因" or heard != question:
        raise SystemExit("TTS 时长、能量或公开样音识别未通过")


if __name__ == "__main__":
    main()
