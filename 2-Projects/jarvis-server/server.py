#!/usr/bin/env python3
"""
贾维斯语音后端 v2.1 — 服务端唤醒词检测

架构：
  ESP32 持续 stream 音频 → NAS 服务端两层检测：
  1. idle 状态：openWakeWord 检测"贾维斯" → 激活
  2. active 状态：Silero VAD → 静默触发 ASR → LLM → TTS → 回到 idle
"""

import asyncio
import json
import os
import re
import struct
import time
import uuid
import logging
import numpy as np
import onnxruntime
import opuslib
from typing import Optional

import websockets
from websockets import serve

from config import WS_HOST, WS_PORT
from llm import chat_stream
from ha import control_device, find_device, play_music, stop_music
from tts import TTSPipeline
from rate_controller import AudioRateController

logging.basicConfig(level=logging.INFO, format="%(asctime)s [jarvis] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("jarvis")

# ── 全局模型加载 ──

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# FunASR
log.info("加载 FunASR SenseVoice 模型...")
import sys
sys.path.insert(0, os.path.join(BASE_DIR, "venv/lib/python3.11/site-packages"))
from funasr import AutoModel
_funasr_model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", disable_update=True)
log.info("FunASR 模型加载完成")

# Silero VAD
log.info("加载 Silero VAD 模型...")
_vad_opts = onnxruntime.SessionOptions()
_vad_opts.inter_op_num_threads = 1
_vad_opts.intra_op_num_threads = 1
_vad_session = onnxruntime.InferenceSession(
    os.path.join(BASE_DIR, "silero_vad.onnx"),
    providers=["CPUExecutionProvider"],
    sess_options=_vad_opts,
)
log.info("Silero VAD 模型加载完成")

# Porcupine 唤醒词检测（Picovoice 训练的"贾维斯"中文模型）
log.info("加载 Porcupine 唤醒词模型...")
import pvporcupine
PORCUPINE_ACCESS_KEY = "0NgHE/XRblus7MeH1ICRzeUKAqsEifMNLII8AdPvYI4L7WQaFsvjyg=="
_porcupine = pvporcupine.create(
    access_key=PORCUPINE_ACCESS_KEY,
    model_path=os.path.join(BASE_DIR, "porcupine_params_zh.pv"),
    keyword_paths=[os.path.join(BASE_DIR, "jarvis_zh.ppn")],
    sensitivities=[0.6],
)
PORCUPINE_FRAME_LENGTH = _porcupine.frame_length  # 512 samples
log.info(f"Porcupine 加载完成 (帧={PORCUPINE_FRAME_LENGTH} samples, {PORCUPINE_FRAME_LENGTH/16000*1000:.0f}ms)")

# ── 常量 ──

SAMPLE_RATE = 16000
CHANNELS = 1
FRAME_MS = 60
FRAME_SIZE = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SIZE * 2

# Silero VAD 参数
VAD_THRESHOLD_HIGH = 0.5
VAD_THRESHOLD_LOW = 0.2
VAD_WINDOW_SIZE = 5
VAD_WINDOW_MIN = 3
SILENCE_DURATION_MS = 800

# 唤醒词检测参数
WAKEWORD_COOLDOWN_S = 3   # 唤醒后冷却时间（避免重复触发）

# 文本清理
EMOJI_PATTERN = re.compile(
    "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U00002600-\U000026FF"
    "\U0000FE00-\U0000FE0F\U0000200D]+",
    flags=re.UNICODE,
)
MARKDOWN_PATTERNS = [
    (re.compile(r"```.*?```", re.DOTALL), ""),
    (re.compile(r"^#+\s*", re.MULTILINE), ""),
    (re.compile(r"(\*\*|__)(.*?)\1"), r"\2"),
    (re.compile(r"(\*|_)(?=\S)(.*?)(?<=\S)\1"), r"\2"),
    (re.compile(r"!\[.*?\]\(.*?\)"), ""),
    (re.compile(r"\[(.*?)\]\(.*?\)"), r"\1"),
    (re.compile(r"^\s*>+\s*", re.MULTILINE), ""),
    (re.compile(r"^\s*[*+-]\s*", re.MULTILINE), ""),
    (re.compile(r"\n{2,}"), "\n"),
]
SENTENCE_DELIMITERS = re.compile(r"[。！？；\n]|[.!?;]\s")
COMMA_DELIMITERS = re.compile(r"[，,]")
MAX_BUFFER_LEN = 30


def clean_for_tts(text: str) -> str:
    for pattern, replacement in MARKDOWN_PATTERNS:
        text = pattern.sub(replacement, text)
    text = EMOJI_PATTERN.sub("", text)
    return text.strip()


class JarvisSession:
    def __init__(self, ws):
        self.ws = ws
        self.device_id = "unknown"
        self.session_id = str(uuid.uuid4())
        self.protocol_version = 1
        self.opus_decoder = opuslib.Decoder(SAMPLE_RATE, CHANNELS)
        self.opus_encoder = opuslib.Encoder(SAMPLE_RATE, CHANNELS, opuslib.APPLICATION_VOIP)
        self.pcm_buffer = bytearray()
        self.is_listening = False
        self.is_speaking = False
        self.listen_mode = "auto"
        self.messages = []
        self.abort_event = asyncio.Event()
        self.tts_pipe = TTSPipeline()

        # 状态机：idle（等唤醒词） / active（对话中）
        self._state = "idle"
        self._last_wakeword_time = 0

        # Porcupine 唤醒词检测缓冲
        self._porcupine_buffer = bytearray()

        # Silero VAD 状态
        self._vad_state = np.zeros((2, 1, 128), dtype=np.float32)
        self._vad_context = np.zeros((1, 64), dtype=np.float32)
        self._vad_audio_buffer = bytearray()
        self._voice_window = []
        self._have_voice = False
        self._last_voice_time = 0
        self._speech_detected = False
        self._vad_task: Optional[asyncio.Task] = None

    async def handle(self):
        try:
            async for message in self.ws:
                if isinstance(message, str):
                    await self._handle_text(json.loads(message))
                else:
                    await self._handle_binary(message)
        except websockets.exceptions.ConnectionClosed:
            log.info(f"设备 {self.device_id} 断开")
        finally:
            if self._vad_task:
                self._vad_task.cancel()
            await self.tts_pipe.close()

    async def _handle_text(self, data: dict):
        msg_type = data.get("type", "")

        if msg_type == "hello":
            self.device_id = data.get("device_id", data.get("mac_addr", "unknown"))
            self.protocol_version = data.get("version", 1)
            client_audio = data.get("audio_params", {})
            log.info(f"设备连接: {self.device_id}, 协议v{self.protocol_version}, "
                     f"音频: {client_audio.get('sample_rate', '?')}Hz/{client_audio.get('frame_duration', '?')}ms")
            await self.ws.send(json.dumps({
                "type": "hello",
                "version": 1,
                "transport": "websocket",
                "session_id": self.session_id,
                "audio_params": {
                    "format": "opus",
                    "sample_rate": SAMPLE_RATE,
                    "channels": CHANNELS,
                    "frame_duration": FRAME_MS,
                },
            }))

        elif msg_type == "listen":
            state = data.get("state", "")
            mode = data.get("mode", "auto")

            if state == "start":
                self.is_listening = True
                self.listen_mode = mode
                log.info(f"开始聆听 (mode={mode}, state={self._state})")
                if self._state == "active":
                    # 对话模式：清空缓冲，启动 VAD
                    self.pcm_buffer.clear()
                    self._vad_audio_buffer.clear()
                    self._voice_window.clear()
                    self._have_voice = False
                    self._speech_detected = False
                    self._abort_speaking()
                    if mode == "auto":
                        self._start_vad_timer()

            elif state == "stop":
                self.is_listening = False
                if self._vad_task:
                    self._vad_task.cancel()
                if self._state == "active":
                    log.info("停止聆听 (手动)")
                    asyncio.create_task(self._process_audio())

            elif state == "detect":
                # 设备端唤醒词（如果仍有的话）
                wake_text = data.get("text", "")
                log.info(f"设备端唤醒词: {wake_text}")
                self._activate()

        elif msg_type == "abort":
            self._abort_speaking()
            log.info(f"客户端打断: {data.get('reason', '')}")

        elif msg_type == "ping":
            await self.ws.send(json.dumps({
                "type": "pong",
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            }))

    async def _handle_binary(self, data: bytes):
        opus_data = self._extract_opus(data)
        if not opus_data:
            return

        if not self.is_listening:
            # 不在聆听但在说话中收到音频 = 打断
            if self.is_speaking:
                self._abort_speaking()
            return

        try:
            pcm = self.opus_decoder.decode(opus_data, FRAME_SIZE)
        except Exception:
            return

        if self._state == "idle":
            # idle 状态：送 openWakeWord 检测唤醒词
            self._check_wakeword(pcm)

        elif self._state == "active":
            # active 状态：积累音频 + Silero VAD
            self.pcm_buffer.extend(pcm)
            self._vad_audio_buffer.extend(pcm)
            self._run_silero_vad()

    # ── 唤醒词检测 ──

    def _check_wakeword(self, pcm: bytes):
        """用 Porcupine 检测唤醒词"""
        if time.time() - self._last_wakeword_time < WAKEWORD_COOLDOWN_S:
            return

        self._porcupine_buffer.extend(pcm)
        frame_bytes = PORCUPINE_FRAME_LENGTH * 2  # 512 samples * 2 bytes

        while len(self._porcupine_buffer) >= frame_bytes:
            frame = self._porcupine_buffer[:frame_bytes]
            self._porcupine_buffer = self._porcupine_buffer[frame_bytes:]
            audio_frame = np.frombuffer(frame, dtype=np.int16)
            result = _porcupine.process(audio_frame)
            if result >= 0:
                log.info("唤醒词 '贾维斯' 检测到! (Porcupine)")
                self._activate()
                return

    def _activate(self):
        """进入对话模式"""
        self._state = "active"
        self._last_wakeword_time = time.time()
        self.pcm_buffer.clear()
        self._vad_audio_buffer.clear()
        self._voice_window.clear()
        self._have_voice = False
        self._speech_detected = False
        log.info("进入对话模式")

        # 启动 VAD 检测
        if self.listen_mode == "auto":
            self._start_vad_timer()

    def _deactivate(self):
        """回到 idle 模式"""
        self._state = "idle"
        self._porcupine_buffer.clear()
        log.info("回到待命模式")

    # ── Silero VAD ──

    def _run_silero_vad(self):
        while len(self._vad_audio_buffer) >= 512 * 2:
            chunk = self._vad_audio_buffer[:512 * 2]
            self._vad_audio_buffer = self._vad_audio_buffer[512 * 2:]

            audio_int16 = np.frombuffer(chunk, dtype=np.int16)
            audio_float32 = audio_int16.astype(np.float32) / 32768.0
            audio_input = np.concatenate(
                [self._vad_context, audio_float32.reshape(1, -1)], axis=1
            ).astype(np.float32)

            out, state = _vad_session.run(None, {
                "input": audio_input,
                "state": self._vad_state,
                "sr": np.array(16000, dtype=np.int64),
            })
            self._vad_state = state
            self._vad_context = audio_input[:, -64:]
            speech_prob = out.item()

            if speech_prob >= VAD_THRESHOLD_HIGH:
                is_voice = True
            elif speech_prob <= VAD_THRESHOLD_LOW:
                is_voice = False
            else:
                is_voice = self._have_voice

            self._voice_window.append(is_voice)
            if len(self._voice_window) > VAD_WINDOW_SIZE:
                self._voice_window.pop(0)
            have_voice = self._voice_window.count(True) >= VAD_WINDOW_MIN

            if have_voice:
                self._have_voice = True
                self._speech_detected = True
                self._last_voice_time = time.time()
            else:
                self._have_voice = have_voice

    def _extract_opus(self, data: bytes) -> Optional[bytes]:
        if len(data) < 2:
            return None
        if self.protocol_version >= 3 and len(data) >= 4:
            ptype = data[0]
            payload_size = struct.unpack("!H", data[2:4])[0]
            if ptype == 0 and len(data) >= 4 + payload_size:
                return data[4:4 + payload_size]
            elif ptype == 1:
                try:
                    asyncio.create_task(self._handle_text(
                        json.loads(data[4:4 + payload_size].decode("utf-8"))))
                except Exception:
                    pass
                return None
        elif self.protocol_version == 2 and len(data) >= 16:
            ptype = struct.unpack("!H", data[2:4])[0]
            payload_size = struct.unpack("!I", data[12:16])[0]
            if ptype == 0 and len(data) >= 16 + payload_size:
                return data[16:16 + payload_size]
            elif ptype == 1:
                try:
                    asyncio.create_task(self._handle_text(
                        json.loads(data[16:16 + payload_size].decode("utf-8"))))
                except Exception:
                    pass
                return None
        return data

    def _start_vad_timer(self):
        if self._vad_task:
            self._vad_task.cancel()
        self._vad_task = asyncio.create_task(self._vad_loop())

    async def _vad_loop(self):
        try:
            while self.is_listening and self._state == "active":
                await asyncio.sleep(0.1)
                if not self._speech_detected:
                    continue
                silence_ms = (time.time() - self._last_voice_time) * 1000
                if silence_ms >= SILENCE_DURATION_MS:
                    log.info(f"VAD 静默 ({silence_ms:.0f}ms)，触发 ASR")
                    asyncio.create_task(self._process_audio())
                    return
        except asyncio.CancelledError:
            pass

    def _abort_speaking(self):
        if self.is_speaking:
            self.abort_event.set()
            log.info("打断 TTS")

    # ── 核心管线 ──

    async def _process_audio(self):
        if len(self.pcm_buffer) < FRAME_SIZE * 2:
            self._deactivate()
            return
        if not self._speech_detected:
            self._deactivate()
            return

        start = time.time()

        asr_task = asyncio.create_task(self._asr(self.pcm_buffer))
        warmup_task = asyncio.create_task(self.tts_pipe.warmup())
        text = await asr_task
        await warmup_task

        if not text:
            log.info("ASR 无结果")
            self._deactivate()
            return
        log.info(f"ASR ({(time.time()-start)*1000:.0f}ms): {text}")

        await self.ws.send(json.dumps({
            "type": "stt", "text": text, "session_id": self.session_id,
        }))

        self.messages.append({"role": "user", "content": text})
        self.is_speaking = True
        self.abort_event.clear()

        await self.ws.send(json.dumps({
            "type": "tts", "state": "start", "session_id": self.session_id,
        }))

        reply_text = ""
        sentence_buffer = ""
        first_audio_sent = False

        async for chunk_type, chunk_data in chat_stream(self.messages):
            if self.abort_event.is_set():
                log.info("LLM 被打断")
                break

            if chunk_type == "text":
                reply_text += chunk_data
                sentence_buffer += chunk_data
                sentences = self._split_sentences(sentence_buffer)
                if len(sentences) > 1:
                    for sent in sentences[:-1]:
                        if sent.strip():
                            if not first_audio_sent:
                                log.info(f"首句 ({(time.time()-start)*1000:.0f}ms): {sent}")
                                first_audio_sent = True
                            await self.ws.send(json.dumps({
                                "type": "tts", "state": "sentence_start",
                                "text": sent, "session_id": self.session_id,
                            }))
                            await self._speak_sentence(sent)
                            if self.abort_event.is_set():
                                break
                    sentence_buffer = sentences[-1]

            elif chunk_type == "tool_call":
                tool_result = await self._execute_tool(chunk_data)
                log.info(f"工具结果: {tool_result}")
                reply_text += tool_result
                sentence_buffer += tool_result

        if sentence_buffer.strip() and not self.abort_event.is_set():
            await self.ws.send(json.dumps({
                "type": "tts", "state": "sentence_start",
                "text": sentence_buffer, "session_id": self.session_id,
            }))
            await self._speak_sentence(sentence_buffer)

        if reply_text:
            self.messages.append({"role": "assistant", "content": reply_text})
        if len(self.messages) > 10:
            self.messages = self.messages[-10:]

        self.is_speaking = False
        await self.tts_pipe.close()

        log.info(f"总耗时: {(time.time()-start)*1000:.0f}ms | 回复: {reply_text[:60]}")

        await self.ws.send(json.dumps({
            "type": "tts", "state": "stop", "session_id": self.session_id,
        }))

        # 对话结束，回到 idle
        self._deactivate()

    def _split_sentences(self, text: str) -> list[str]:
        parts = SENTENCE_DELIMITERS.split(text)
        if len(parts) > 1:
            result, pos = [], 0
            for part in parts[:-1]:
                m = SENTENCE_DELIMITERS.search(text, pos + len(part))
                if m:
                    result.append(text[pos:m.end()])
                    pos = m.end()
                else:
                    result.append(part)
                    pos += len(part)
            result.append(text[pos:])
            return [r for r in result if r]
        if len(text) > MAX_BUFFER_LEN:
            parts = COMMA_DELIMITERS.split(text)
            if len(parts) > 1:
                result, pos = [], 0
                for part in parts[:-1]:
                    m = COMMA_DELIMITERS.search(text, pos + len(part))
                    if m:
                        result.append(text[pos:m.end()])
                        pos = m.end()
                    else:
                        result.append(part)
                        pos += len(part)
                result.append(text[pos:])
                return [r for r in result if r]
        return [text]

    async def _speak_sentence(self, text: str):
        text = clean_for_tts(text)
        if not text:
            return
        rc = AudioRateController(FRAME_MS)
        pcm_remainder = bytearray()

        async def send_opus(encoded):
            if not self.abort_event.is_set():
                await self.ws.send(encoded)

        await rc.start(send_opus)
        try:
            async for pcm_chunk in self.tts_pipe.speak(text):
                if self.abort_event.is_set():
                    break
                pcm_remainder.extend(pcm_chunk)
                while len(pcm_remainder) >= FRAME_BYTES:
                    if self.abort_event.is_set():
                        break
                    frame = bytes(pcm_remainder[:FRAME_BYTES])
                    pcm_remainder = pcm_remainder[FRAME_BYTES:]
                    encoded = self.opus_encoder.encode(frame, FRAME_SIZE)
                    if rc.is_prebuffer:
                        await rc.send_immediate(send_opus, encoded)
                    else:
                        rc.add(encoded)
            if pcm_remainder and not self.abort_event.is_set():
                frame = bytes(pcm_remainder) + b"\x00" * (FRAME_BYTES - len(pcm_remainder))
                encoded = self.opus_encoder.encode(frame, FRAME_SIZE)
                if rc.is_prebuffer:
                    await rc.send_immediate(send_opus, encoded)
                else:
                    rc.add(encoded)
            await rc.wait_empty()
        except Exception as e:
            log.error(f"TTS 发送失败: {e}")
        finally:
            rc.stop()

    # ── ASR ──

    async def _asr(self, pcm_data: bytearray) -> Optional[str]:
        try:
            return await asyncio.to_thread(self._asr_sync, bytes(pcm_data))
        except Exception as e:
            log.warning(f"ASR 失败: {e}")
            return None

    def _asr_sync(self, pcm_data: bytes) -> Optional[str]:
        res = _funasr_model.generate(
            input=pcm_data, language="auto", use_itn=True, batch_size_s=60,
        )
        if res and len(res) > 0:
            text = res[0].get("text", "")
            text = re.sub(r"<\|[^|]+\|>", "", text).strip()
            return text if text else None
        return None

    # ── 工具执行 ──

    async def _execute_tool(self, tool_call: dict) -> str:
        name = tool_call["name"]
        args = tool_call["arguments"]
        log.info(f"工具调用: {name}({args})")
        if name == "control_device":
            entity_id = find_device(args.get("device_name", ""))
            if entity_id:
                result = await asyncio.to_thread(
                    control_device, entity_id, args.get("action", "turn_on"))
                action_cn = "打开" if args.get("action") == "turn_on" else "关闭"
                return f"已{action_cn}{args.get('device_name', '')}" if "done" in result else "操作失败"
            return "找不到该设备"
        elif name == "play_music":
            await asyncio.to_thread(play_music, args.get("song", ""))
            return f"正在播放{args.get('song', '')}"
        elif name == "stop_music":
            await asyncio.to_thread(stop_music)
            return "已停止播放"
        return "未知工具"


async def handler(websocket):
    session = JarvisSession(websocket)
    await session.handle()


async def main():
    log.info(f"贾维斯语音后端 v2.1 启动: ws://{WS_HOST}:{WS_PORT}")
    log.info("唤醒词: 贾维斯 (Porcupine 服务端检测)")
    async with serve(handler, WS_HOST, WS_PORT, ping_interval=None, ping_timeout=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
