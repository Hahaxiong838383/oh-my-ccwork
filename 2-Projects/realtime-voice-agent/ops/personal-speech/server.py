#!/usr/bin/env python3
"""飞牛本地中文语音试点。只在容器内用已挂载的 Sherpa 模型做识别和合成。

不写录音，不访问外网，也不冒充原小可音色。
"""

from __future__ import annotations

import array
import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

import sherpa_onnx
from aiohttp import web

ASR_DIR = Path(os.environ.get("ASR_MODEL_DIR", "/models/asr"))
TTS_DIR = Path(os.environ.get("TTS_MODEL_DIR", "/models/tts"))
TTS_SID = int(os.environ.get("TTS_SID", "21"))
BIND = os.environ.get("BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8091"))
MAX_CHARS = 200
MAX_AUDIO_SAMPLES = 16000 * 30
PILOT = "personal-local-pilot"
VOICE = os.environ.get("TTS_VOICE", "piper-zh-huayan-medium")
ASR_MODEL_ID = "sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13"

ASR_LOCK = threading.Lock()
TTS_LOCK = threading.Lock()
RECOGNIZER = None
TTS = None
SPEAKER_CODE = ""


def one(root: Path, pattern: str) -> str:
    matches = sorted(path for path in root.glob(pattern) if path.is_file())
    if len(matches) != 1:
        raise SystemExit(f"{root}/{pattern} 需要正好 1 个文件，实际 {len(matches)}")
    return str(matches[0])


TTS_MODEL_NAME = ""


def tts_config():
    global SPEAKER_CODE, TTS_MODEL_NAME
    lexicon = TTS_DIR / "lexicon.txt"
    data_dir = TTS_DIR / "espeak-ng-data"
    if lexicon.is_file():
        fsts = [TTS_DIR / "phone.fst", TTS_DIR / "date.fst", TTS_DIR / "number.fst"]
        missing = [str(path) for path in fsts if not path.is_file()]
        if missing:
            raise SystemExit(f"缺少 TTS 规则文件: {missing}")
        lines = [
            line.strip()
            for line in (TTS_DIR / "speakers.txt").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if TTS_SID < 0 or TTS_SID >= len(lines):
            raise SystemExit(f"TTS_SID={TTS_SID} 超出 speakers.txt（共 {len(lines)}）")
        SPEAKER_CODE = lines[TTS_SID]
        TTS_MODEL_NAME = "vits-icefall-zh-aishell3"
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(TTS_DIR / "model.onnx"),
            lexicon=str(lexicon),
            tokens=str(TTS_DIR / "tokens.txt"),
        )
        rule_fsts = ",".join(str(path) for path in fsts)
    elif data_dir.is_dir():
        SPEAKER_CODE = "huayan"
        TTS_MODEL_NAME = "vits-piper-zh_CN-huayan-medium"
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=one(TTS_DIR, "*.onnx"),
            lexicon="",
            tokens=one(TTS_DIR, "tokens.txt"),
            data_dir=str(data_dir),
        )
        rule_fsts = ""
    else:
        raise SystemExit(f"{TTS_DIR} 没有可用的中文 TTS")
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=vits,
            provider="cpu",
            debug=False,
            num_threads=2,
        ),
        rule_fsts=rule_fsts,
        max_num_sentences=1,
    )
    if not config.validate():
        raise SystemExit("TTS 配置无效")
    return config


def load_models() -> None:
    global RECOGNIZER, TTS
    TTS = sherpa_onnx.OfflineTts(tts_config())
    RECOGNIZER = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=one(ASR_DIR, "tokens.txt"),
        encoder=one(ASR_DIR, "encoder*.int8.onnx"),
        decoder=one(ASR_DIR, "decoder*.onnx"),
        joiner=one(ASR_DIR, "joiner*.int8.onnx"),
        num_threads=2,
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        provider="cpu",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=0.8,
        rule3_min_utterance_length=20,
    )
    print(
        f"ready pilot={PILOT} voice={VOICE} speaker={SPEAKER_CODE} "
        f"tts_rate={TTS.sample_rate} asr={ASR_DIR.name}",
        flush=True,
    )


def new_stream():
    with ASR_LOCK:
        return RECOGNIZER.create_stream()


def result_text(stream) -> str:
    result = RECOGNIZER.get_result(stream)
    if isinstance(result, str):
        return result.strip()
    return str(getattr(result, "text", "")).strip()


def pcm16_to_float(raw: bytes) -> list[float]:
    if len(raw) % 2:
        raw = raw[:-1]
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return [sample / 32768.0 for sample in samples]


def feed(stream, samples: list[float]) -> tuple[str, bool]:
    with ASR_LOCK:
        stream.accept_waveform(16000, samples)
        while RECOGNIZER.is_ready(stream):
            RECOGNIZER.decode_stream(stream)
        text = result_text(stream)
        ended = bool(RECOGNIZER.is_endpoint(stream))
        if ended:
            RECOGNIZER.reset(stream)
        return text, ended


def finish(stream) -> str:
    with ASR_LOCK:
        stream.input_finished()
        while RECOGNIZER.is_ready(stream):
            RECOGNIZER.decode_stream(stream)
        text = result_text(stream)
        RECOGNIZER.reset(stream)
        return text


def to_pcm24(samples, source_rate: int) -> bytes:
    native = array.array("h")
    for sample in samples:
        value = int(max(-1.0, min(1.0, float(sample))) * 32767.0)
        native.append(value)
    if source_rate == 24000:
        return native.tobytes()
    if source_rate <= 0 or not native:
        return b""
    count = int(len(native) * 24000 / source_rate)
    output = array.array("h")
    last = len(native) - 1
    for index in range(count):
        position = index * source_rate / 24000
        left = int(position)
        if left >= last:
            output.append(native[last])
            continue
        fraction = position - left
        output.append(int(native[left] + (native[left + 1] - native[left]) * fraction))
    return output.tobytes()


def synthesize(text: str) -> tuple[bytes, int, int]:
    with TTS_LOCK:
        started = time.perf_counter()
        config = sherpa_onnx.GenerationConfig()
        config.sid = TTS_SID
        config.speed = 1.0
        config.silence_scale = 0.2
        audio = TTS.generate(text, config)
        elapsed = int((time.perf_counter() - started) * 1000)
        rate = int(audio.sample_rate)
        return to_pcm24(audio.samples, rate), rate, elapsed


def health_body() -> dict:
    return {
        "ok": True,
        "pilot": True,
        "label": "飞牛本地中文语音试点",
        "original_xiaoke_voice": False,
        "provider": PILOT,
        "voice": VOICE,
        "speaker_code": SPEAKER_CODE,
        "asr_model": ASR_MODEL_ID,
        "tts_model": TTS_MODEL_NAME,
        "tts_native_rate": int(TTS.sample_rate),
        "output_rate": 24000,
    }


async def health(_request: web.Request) -> web.Response:
    return web.json_response(health_body())


async def tts(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid json"}, status=400)
    text = str(payload.get("text", "")).strip()
    if not text:
        return web.json_response({"error": "empty text"}, status=400)
    if len(text) > MAX_CHARS:
        return web.json_response({"error": "text too long"}, status=413)
    pcm, native_rate, elapsed = await asyncio.to_thread(synthesize, text)
    if not pcm:
        return web.json_response({"error": "empty audio"}, status=500)
    print(
        f"tts chars={len(text)} native_rate={native_rate} bytes={len(pcm)} elapsed_ms={elapsed}",
        flush=True,
    )
    return web.Response(
        body=pcm,
        content_type="application/octet-stream",
        headers={
            "X-Sample-Rate": "24000",
            "X-Native-Sample-Rate": str(native_rate),
            "X-Elapsed-Ms": str(elapsed),
            "X-Speech-Label": PILOT,
            "X-Voice": VOICE,
            "X-Audio-Bytes": str(len(pcm)),
        },
    )


async def asr(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(max_msg_size=1024 * 1024)
    await socket.prepare(request)
    stream = await asyncio.to_thread(new_stream)
    pending = bytearray()
    total = 0
    try:
        async for message in socket:
            if message.type == web.WSMsgType.BINARY:
                pending.extend(message.data)
                usable = len(pending) - (len(pending) % 2)
                if usable <= 0:
                    continue
                raw = bytes(pending[:usable])
                del pending[:usable]
                samples = pcm16_to_float(raw)
                total += len(samples)
                if total > MAX_AUDIO_SAMPLES:
                    await socket.send_json({"type": "error", "error": "audio too long"})
                    break
                text, ended = await asyncio.to_thread(feed, stream, samples)
                if ended and text:
                    await socket.send_json({"type": "final", "text": text})
                elif text:
                    await socket.send_json({"type": "interim", "text": text})
            elif message.type == web.WSMsgType.TEXT:
                try:
                    event = json.loads(message.data).get("event")
                except json.JSONDecodeError:
                    await socket.send_json({"type": "error", "error": "invalid json"})
                    break
                if event == "end":
                    text = await asyncio.to_thread(finish, stream)
                    await socket.send_json({"type": "final", "text": text})
                    print(f"asr samples={total} chars={len(text)}", flush=True)
                    break
            elif message.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                break
    finally:
        await socket.close()
    return socket


def main() -> None:
    load_models()
    app = web.Application(client_max_size=8192)
    app.add_routes(
        [
            web.get("/health", health),
            web.post("/v1/tts", tts),
            web.get("/v1/asr", asr),
        ]
    )
    web.run_app(app, host=BIND, port=PORT, print=None)


if __name__ == "__main__":
    main()
