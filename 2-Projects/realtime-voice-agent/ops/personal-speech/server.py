#!/usr/bin/env python3
"""飞牛本地中文语音。只在容器内用已挂载的 Sherpa 模型做识别和合成。

不写录音，不访问外网，也不冒充原小可音色。
音色必须来自不同模型或同一多说话人模型的不同说话人，速度固定为 1.0。
"""

from __future__ import annotations

import array
import asyncio
import hashlib
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
VOICES_DIR = Path(os.environ.get("VOICES_DIR", "/models/voices"))
STATE_PATH = Path(os.environ.get("VOICE_STATE_PATH", "/state/active.json"))
BIND = os.environ.get("BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8091"))
MAX_CHARS = 200
MAX_AUDIO_SAMPLES = 16000 * 30
PILOT = "personal-local-pilot"
DEFAULT_VOICE = "piper-zh-huayan-medium"
PREVIEW_TEXT = "今天天气怎么样"
ASR_MODEL_ID = "sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13"
OUTPUT_RATE = 24000

ASR_LOCK = threading.Lock()
TTS_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
RECOGNIZER = None
VOICES: dict[str, "Voice"] = {}
ORDER: list[str] = []
ACTIVE = ""


class Voice:
    def __init__(self, spec: dict, engine, onnx_sha256: str, native_rate: int) -> None:
        self.id = spec["id"]
        self.name = spec["name"]
        self.description = spec["description"]
        self.model_name = spec["model_name"]
        self.speaker_code = spec["speaker_code"]
        self.sid = int(spec["sid"])
        self.engine = engine
        self.onnx_sha256 = onnx_sha256
        self.native_rate = native_rate

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description}


def one(root: Path, pattern: str) -> str:
    matches = sorted(path for path in root.glob(pattern) if path.is_file())
    if len(matches) != 1:
        raise RuntimeError(f"{root}/{pattern} 需要正好 1 个文件，实际 {len(matches)}")
    return str(matches[0])


def onnx_model(root: Path) -> str:
    matches = [
        path
        for path in root.glob("*.onnx")
        if path.is_file() and path.stat().st_size > 1_000_000
    ]
    full = [path for path in matches if "int8" not in path.name.lower()]
    chosen = full or matches
    if len(chosen) != 1:
        raise RuntimeError(f"{root} 需要正好 1 个可用 onnx，实际 {len(chosen)}")
    return str(chosen[0])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def optional_voices() -> list[dict]:
    return [
        {
            "id": "melo-zh-en",
            "name": "Melo",
            "description": "MeloTTS 中文单说话人，独立于华燕的模型，原生 44100 Hz。",
            "dirname": "melo-zh-en",
            "model_name": "vits-melo-tts-zh_en",
            "speaker_code": "melo",
            "sid": 0,
        },
        {
            "id": "fanchen-wnj",
            "name": "WNJ",
            "description": "vits-zh-hf-fanchen-wnj，公开说明为一名男声，独立模型，原生 16000 Hz。",
            "dirname": "fanchen-wnj",
            "model_name": "vits-zh-hf-fanchen-wnj",
            "speaker_code": "wnj",
            "sid": 0,
        },
        {
            "id": "piper-zh-chaowen",
            "name": "超文",
            "description": "Piper zh_CN-chaowen-medium，独立说话人，原生 22050 Hz。",
            "dirname": "piper-zh-chaowen",
            "model_name": "vits-piper-zh_CN-chaowen-medium",
            "speaker_code": "chaowen",
            "sid": 0,
        },
        {
            "id": "piper-zh-xiao-ya",
            "name": "小雅",
            "description": "Piper zh_CN-xiao_ya-medium，独立说话人，原生 22050 Hz。",
            "dirname": "piper-zh-xiao-ya",
            "model_name": "vits-piper-zh_CN-xiao_ya-medium",
            "speaker_code": "xiao_ya",
            "sid": 0,
        },
    ]


def huayan_spec() -> dict:
    return {
        "id": DEFAULT_VOICE,
        "name": "华燕",
        "description": "Piper zh_CN-huayan-medium 女声，22050 Hz。默认音色，不是原小可音色。",
        "root": TTS_DIR,
        "model_name": "vits-piper-zh_CN-huayan-medium",
        "speaker_code": "huayan",
        "sid": 0,
        "required": True,
    }


def load_engine(root: Path):
    lexicon = root / "lexicon.txt"
    data_dir = root / "espeak-ng-data"
    onnx = Path(onnx_model(root))
    tokens = one(root, "tokens.txt")
    if lexicon.is_file():
        fsts = [
            root / name
            for name in ("phone.fst", "date.fst", "number.fst")
            if (root / name).is_file()
        ]
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(onnx),
            lexicon=str(lexicon),
            tokens=tokens,
        )
        rule_fsts = ",".join(str(path) for path in fsts)
    elif data_dir.is_dir():
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(onnx),
            lexicon="",
            tokens=tokens,
            data_dir=str(data_dir),
        )
        rule_fsts = ""
    else:
        raise RuntimeError(f"{root} 没有可用的中文 TTS")
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
        raise RuntimeError(f"{root} TTS 配置无效")
    return sherpa_onnx.OfflineTts(config), onnx


def add_voice(spec: dict, cache: dict[str, tuple]) -> None:
    root = Path(spec["root"])
    required = bool(spec.get("required"))
    if not root.is_dir():
        message = f"voice_load outcome=missing id={spec['id']}"
        if required:
            raise SystemExit(message)
        print(message, flush=True)
        return
    try:
        key = str(root.resolve())
        if key not in cache:
            cache[key] = load_engine(root)
        engine, onnx = cache[key]
        voice = Voice(spec, engine, sha256_file(onnx), int(engine.sample_rate))
        if voice.sid < 0:
            raise RuntimeError("sid < 0")
        VOICES[voice.id] = voice
        ORDER.append(voice.id)
        print(
            f"voice_ready id={voice.id} model={voice.model_name} sid={voice.sid} "
            f"native_rate={voice.native_rate} onnx_sha256={voice.onnx_sha256}",
            flush=True,
        )
    except Exception as error:
        print(f"voice_load outcome=failed id={spec['id']} error={type(error).__name__}", flush=True)
        if required:
            raise SystemExit(f"默认音色不可用: {type(error).__name__}") from error


def read_state() -> str | None:
    if not STATE_PATH.is_file():
        return None
    try:
        payload = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("voice_state outcome=invalid", flush=True)
        return None
    voice_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(voice_id, str) or not voice_id:
        print("voice_state outcome=invalid", flush=True)
        return None
    return voice_id


def persist_active(voice_id: str) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    data = json.dumps({"id": voice_id}, ensure_ascii=False).encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, STATE_PATH)
    dirfd = os.open(STATE_PATH.parent, os.O_RDONLY)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)


def load_models() -> None:
    global RECOGNIZER, ACTIVE
    cache: dict[str, tuple] = {}
    add_voice(huayan_spec(), cache)
    for spec in optional_voices():
        item = dict(spec)
        item["root"] = VOICES_DIR / spec["dirname"]
        add_voice(item, cache)
    if DEFAULT_VOICE not in VOICES:
        raise SystemExit("默认音色华燕不可用")
    saved = read_state()
    if saved == DEFAULT_VOICE or (saved in VOICES):
        ACTIVE = saved
    elif saved:
        print(f"voice_state outcome=unavailable id={saved}", flush=True)
        ACTIVE = DEFAULT_VOICE
    else:
        ACTIVE = DEFAULT_VOICE
    if ACTIVE not in VOICES:
        print(f"voice_state outcome=unavailable id={ACTIVE}", flush=True)
        raise SystemExit("没有可用音色")
    try:
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
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
    except Exception as error:
        print(f"asr_load outcome=failed error={type(error).__name__}", flush=True)
        raise SystemExit("ASR 不可用") from error
    RECOGNIZER = recognizer
    rss = 0
    status = Path("/proc/self/status")
    if status.is_file():
        for line in status.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1]) // 1024
    print(
        f"ready pilot={PILOT} active={ACTIVE} voices={','.join(ORDER)} "
        f"count={len(ORDER)} rss_mb={rss} asr={ASR_DIR.name}",
        flush=True,
    )
    if len(ORDER) < 2:
        print(f"voices outcome=insufficient count={len(ORDER)}", flush=True)


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
        # Flush the right-context window when a sender ends without trailing silence.
        stream.accept_waveform(16000, [0.0] * 12000)
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
    if source_rate == OUTPUT_RATE:
        return native.tobytes()
    if source_rate <= 0 or not native:
        return b""
    count = int(len(native) * OUTPUT_RATE / source_rate)
    output = array.array("h")
    last = len(native) - 1
    for index in range(count):
        position = index * source_rate / OUTPUT_RATE
        left = int(position)
        if left >= last:
            output.append(native[last])
            continue
        fraction = position - left
        output.append(int(native[left] + (native[left + 1] - native[left]) * fraction))
    return output.tobytes()


def pcm_to_wav(pcm: bytes, rate: int = OUTPUT_RATE) -> bytes:
    import struct

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


def synthesize(voice: Voice, text: str) -> tuple[bytes, int, int]:
    with TTS_LOCK:
        started = time.perf_counter()
        config = sherpa_onnx.GenerationConfig()
        config.sid = voice.sid
        config.speed = 1.0
        config.silence_scale = 0.2
        audio = voice.engine.generate(text, config)
        elapsed = int((time.perf_counter() - started) * 1000)
        rate = int(audio.sample_rate)
        return to_pcm24(audio.samples, rate), rate, elapsed


def active_voice() -> Voice | None:
    with STATE_LOCK:
        return VOICES.get(ACTIVE)


def voices_body() -> dict:
    with STATE_LOCK:
        return {
            "voices": [VOICES[voice_id].public() for voice_id in ORDER if voice_id in VOICES],
            "active": ACTIVE if ACTIVE in VOICES else "",
        }


def audio_headers(voice: Voice, native_rate: int, elapsed: int, size: int) -> dict:
    return {
        "X-Sample-Rate": str(OUTPUT_RATE),
        "X-Native-Sample-Rate": str(native_rate),
        "X-Elapsed-Ms": str(elapsed),
        "X-Speech-Label": PILOT,
        "X-Voice": voice.id,
        "X-TTS-Voice": voice.id,
        "X-TTS-Model": voice.model_name,
        "X-TTS-Sid": str(voice.sid),
        "X-TTS-Onnx-Sha256": voice.onnx_sha256,
        "X-Audio-Bytes": str(size),
    }


def health_body() -> dict | None:
    voice = active_voice()
    if voice is None:
        return None
    return {
        "ok": True,
        "pilot": True,
        "label": "飞牛本地中文语音试点",
        "original_xiaoke_voice": False,
        "provider": PILOT,
        "voice": voice.id,
        "speaker_code": voice.speaker_code,
        "asr_model": ASR_MODEL_ID,
        "tts_model": voice.model_name,
        "tts_native_rate": voice.native_rate,
        "output_rate": OUTPUT_RATE,
    }


async def health(_request: web.Request) -> web.Response:
    body = health_body()
    if body is None:
        print("health outcome=unavailable", flush=True)
        return web.json_response({"ok": False, "error": "voice unavailable"}, status=503)
    return web.json_response(body)


async def list_voices(_request: web.Request) -> web.Response:
    body = voices_body()
    if not body["voices"] or body["active"] not in {item["id"] for item in body["voices"]}:
        print("voices outcome=unavailable", flush=True)
        return web.json_response({"error": "voice unavailable"}, status=503)
    return web.json_response(body)


async def set_active(request: web.Request) -> web.Response:
    global ACTIVE
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "invalid json"}, status=400)
    new_id = payload.get("id")
    previous = payload.get("previous")
    if not isinstance(new_id, str) or not isinstance(previous, str) or not new_id or not previous:
        return web.json_response({"error": "id and previous required"}, status=400)
    with STATE_LOCK:
        current = ACTIVE if ACTIVE in VOICES else ""
        if previous != current or not current:
            print(f"voice_switch outcome=conflict active={current}", flush=True)
            return web.json_response(
                {"error": "previous mismatch", "active": current},
                status=409,
            )
        if new_id not in VOICES:
            print(f"voice_switch outcome=unavailable id={new_id}", flush=True)
            return web.json_response(
                {"error": "voice unavailable", "active": current},
                status=404,
            )
        if new_id != current:
            try:
                persist_active(new_id)
            except OSError as error:
                print(
                    f"voice_switch outcome=persist_failed id={new_id} error={type(error).__name__}",
                    flush=True,
                )
                return web.json_response({"error": "persist failed", "active": current}, status=500)
            ACTIVE = new_id
        print(f"voice_switch outcome=ok id={ACTIVE} previous={previous}", flush=True)
        body = {
            "voices": [VOICES[voice_id].public() for voice_id in ORDER],
            "active": ACTIVE,
        }
    return web.json_response(body)


async def preview(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "invalid json"}, status=400)
    voice_id = payload.get("id")
    if not isinstance(voice_id, str) or not voice_id:
        return web.json_response({"error": "id required"}, status=400)
    voice = VOICES.get(voice_id)
    if voice is None:
        print(f"preview outcome=unavailable id={voice_id}", flush=True)
        return web.json_response({"error": "voice unavailable"}, status=404)
    pcm, native_rate, elapsed = await asyncio.to_thread(synthesize, voice, PREVIEW_TEXT)
    if not pcm:
        print(
            f"preview outcome=empty voice={voice.id} chars={len(PREVIEW_TEXT)} elapsed_ms={elapsed}",
            flush=True,
        )
        return web.json_response({"error": "empty audio"}, status=500)
    wav = pcm_to_wav(pcm)
    print(
        f"preview outcome=ok voice={voice.id} model={voice.model_name} sid={voice.sid} "
        f"chars={len(PREVIEW_TEXT)} native_rate={native_rate} bytes={len(wav)} elapsed_ms={elapsed}",
        flush=True,
    )
    return web.Response(
        body=wav,
        content_type="audio/wav",
        headers=audio_headers(voice, native_rate, elapsed, len(wav)),
    )


async def tts(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "invalid json"}, status=400)
    text = str(payload.get("text", "")).strip()
    if not text:
        return web.json_response({"error": "empty text"}, status=400)
    if len(text) > MAX_CHARS:
        return web.json_response({"error": "text too long"}, status=413)
    voice = active_voice()
    if voice is None:
        print(f"tts outcome=unavailable chars={len(text)}", flush=True)
        return web.json_response({"error": "voice unavailable"}, status=503)
    pcm, native_rate, elapsed = await asyncio.to_thread(synthesize, voice, text)
    if not pcm:
        print(
            f"tts outcome=empty voice={voice.id} chars={len(text)} native_rate={native_rate} elapsed_ms={elapsed}",
            flush=True,
        )
        return web.json_response({"error": "empty audio"}, status=500)
    print(
        f"tts outcome=ok voice={voice.id} model={voice.model_name} sid={voice.sid} "
        f"chars={len(text)} native_rate={native_rate} bytes={len(pcm)} elapsed_ms={elapsed}",
        flush=True,
    )
    return web.Response(
        body=pcm,
        content_type="application/octet-stream",
        headers=audio_headers(voice, native_rate, elapsed, len(pcm)),
    )


async def asr(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(max_msg_size=1024 * 1024)
    await socket.prepare(request)
    stream = await asyncio.to_thread(new_stream)
    pending = bytearray()
    total = 0
    segment_samples = 0
    waiting_for_speech = True
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
                if waiting_for_speech:
                    # Keep an idle socket open without feeding an unbounded silence
                    # prefix to the transducer. Four PCM counts are below -78 dBFS.
                    if not any(abs(sample) > 4 / 32768 for sample in samples):
                        continue
                    waiting_for_speech = False
                segment_samples += len(samples)
                text, ended = await asyncio.to_thread(feed, stream, samples)
                if not ended and segment_samples >= MAX_AUDIO_SAMPLES:
                    text = await asyncio.to_thread(finish, stream)
                    ended = True
                if ended:
                    segment_samples = 0
                    waiting_for_speech = True
                    stream = await asyncio.to_thread(new_stream)
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
            web.get("/v1/voices", list_voices),
            web.put("/v1/voices/active", set_active),
            web.post("/v1/voices/preview", preview),
            web.post("/v1/tts", tts),
            web.get("/v1/asr", asr),
        ]
    )
    web.run_app(app, host=BIND, port=PORT, print=None)


if __name__ == "__main__":
    main()
