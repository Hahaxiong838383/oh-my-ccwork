#!/usr/bin/env python3
"""
贾维斯语音后端 v1 — 兼容小智 ESP32 全协议

关键修复：
1. 服务端 VAD — 设备用 auto 模式，服务端检测静默触发 ASR
2. 二进制协议头 — 支持 v1(纯Opus)/v2(14字节头)/v3(4字节头)
3. hello 带 session_id
"""

import asyncio
import json
import re
import struct
import time
import uuid
import logging
import math
import opuslib
from typing import Optional

import websockets
from websockets import serve

from config import WS_HOST, WS_PORT
from llm import chat_stream
from ha import control_device, find_device, play_music, stop_music
from tts import TTSPipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [jarvis] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("jarvis")

# FunASR 模型全局加载（启动时加载一次，~5s）
log.info("加载 FunASR SenseVoice 模型...")
import sys
sys.path.insert(0, "/home/hahaxiong83/mycc/2-Projects/jarvis-server/venv/lib/python3.11/site-packages")
from funasr import AutoModel
_funasr_model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", disable_update=True)
log.info("FunASR 模型加载完成")

# Opus 编解码参数
SAMPLE_RATE = 16000
CHANNELS = 1
FRAME_MS = 60
FRAME_SIZE = SAMPLE_RATE * FRAME_MS // 1000  # 960 samples
FRAME_BYTES = FRAME_SIZE * 2  # 16bit = 2 bytes/sample

# 服务端 VAD 参数
SILENCE_THRESHOLD = 200       # PCM 能量阈值（低于此视为静默）
SPEECH_MIN_FRAMES = 3         # 至少连续 3 帧有声音才算开始说话
SILENCE_DURATION_MS = 800     # 说话后静默超过此时间 → 自动停止

# emoji 过滤
EMOJI_PATTERN = re.compile(
    "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U00002600-\U000026FF"
    "\U0000FE00-\U0000FE0F\U0000200D]+",
    flags=re.UNICODE,
)

# 句子切分
SENTENCE_DELIMITERS = re.compile(r"[。！？；\n]|[.!?;]\s")
COMMA_DELIMITERS = re.compile(r"[，,]")
MAX_BUFFER_LEN = 30


def pcm_rms(pcm_bytes: bytes) -> float:
    """计算 PCM 数据的 RMS 能量"""
    if len(pcm_bytes) < 2:
        return 0
    n = len(pcm_bytes) // 2
    total = 0
    for i in range(n):
        sample = struct.unpack_from("<h", pcm_bytes, i * 2)[0]
        total += sample * sample
    return math.sqrt(total / n)


class JarvisSession:
    """一个设备连接的会话"""

    def __init__(self, ws):
        self.ws = ws
        self.device_id = "unknown"
        self.session_id = str(uuid.uuid4())
        self.protocol_version = 1  # 从 hello 协商
        self.opus_decoder = opuslib.Decoder(SAMPLE_RATE, CHANNELS)
        self.opus_encoder = opuslib.Encoder(SAMPLE_RATE, CHANNELS, opuslib.APPLICATION_VOIP)
        self.pcm_buffer = bytearray()
        self.is_listening = False
        self.is_speaking = False
        self.listen_mode = "auto"  # auto / manual / realtime
        self.messages = []
        self.abort_event = asyncio.Event()
        self.tts_pipe = TTSPipeline()

        # VAD 状态
        self._speech_detected = False
        self._speech_frames = 0
        self._last_speech_time = 0
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
            # 解析设备 hello
            self.device_id = data.get("device_id", data.get("mac_addr", "unknown"))
            self.protocol_version = data.get("version", 1)
            client_audio = data.get("audio_params", {})
            log.info(f"设备连接: {self.device_id}, 协议v{self.protocol_version}, "
                     f"音频: {client_audio.get('sample_rate', '?')}Hz/{client_audio.get('frame_duration', '?')}ms")

            # 回复 hello（带 session_id）
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
                self.pcm_buffer.clear()
                self._speech_detected = False
                self._speech_frames = 0
                self._abort_speaking()
                log.info(f"开始聆听 (mode={mode})")

                # auto 模式：启动 VAD 定时器
                if mode == "auto":
                    self._start_vad_timer()

            elif state == "stop":
                # 手动停止
                self.is_listening = False
                if self._vad_task:
                    self._vad_task.cancel()
                log.info("停止聆听 (手动)")
                asyncio.create_task(self._process_audio())

            elif state == "detect":
                # 唤醒词检测到
                wake_text = data.get("text", "")
                log.info(f"唤醒词: {wake_text}")

        elif msg_type == "abort":
            reason = data.get("reason", "")
            self._abort_speaking()
            log.info(f"客户端打断: {reason}")

    async def _handle_binary(self, data: bytes):
        """处理二进制消息：根据协议版本解析音频"""
        opus_data = self._extract_opus(data)
        if not opus_data:
            return

        if not self.is_listening:
            if self.is_speaking:
                self._abort_speaking()
            return

        try:
            pcm = self.opus_decoder.decode(opus_data, FRAME_SIZE)
            self.pcm_buffer.extend(pcm)

            # VAD：检测语音能量
            if self.listen_mode == "auto":
                rms = pcm_rms(pcm)
                if rms > SILENCE_THRESHOLD:
                    self._speech_frames += 1
                    if self._speech_frames >= SPEECH_MIN_FRAMES:
                        self._speech_detected = True
                    self._last_speech_time = time.time()
                else:
                    self._speech_frames = max(0, self._speech_frames - 1)

        except Exception as e:
            log.debug(f"Opus 解码异常: {e}, 数据长度={len(opus_data)}")

    def _extract_opus(self, data: bytes) -> Optional[bytes]:
        """根据协议版本提取 Opus 数据"""
        if len(data) < 2:
            return None

        if self.protocol_version >= 3 and len(data) >= 4:
            # v3: 4 字节头 [type(1) | reserved(1) | payload_size(2)] + payload
            ptype = data[0]
            payload_size = struct.unpack("!H", data[2:4])[0]
            if ptype == 0 and len(data) >= 4 + payload_size:
                return data[4:4 + payload_size]
            elif ptype == 1:
                # JSON 消息通过二进制通道
                try:
                    text = data[4:4 + payload_size].decode("utf-8")
                    asyncio.create_task(self._handle_text(json.loads(text)))
                except Exception:
                    pass
                return None

        elif self.protocol_version == 2 and len(data) >= 16:
            # v2: 16 字节头 [version(2) | type(2) | reserved(4) | timestamp(4) | payload_size(4)] + payload
            ptype = struct.unpack("!H", data[2:4])[0]
            payload_size = struct.unpack("!I", data[12:16])[0]
            if ptype == 0 and len(data) >= 16 + payload_size:
                return data[16:16 + payload_size]
            elif ptype == 1:
                try:
                    text = data[16:16 + payload_size].decode("utf-8")
                    asyncio.create_task(self._handle_text(json.loads(text)))
                except Exception:
                    pass
                return None

        # v1 或回退：纯 Opus 数据
        return data

    def _start_vad_timer(self):
        """启动 VAD 轮询定时器"""
        if self._vad_task:
            self._vad_task.cancel()
        self._vad_task = asyncio.create_task(self._vad_loop())

    async def _vad_loop(self):
        """VAD 轮询：检测到语音后，静默超时则触发处理"""
        try:
            while self.is_listening:
                await asyncio.sleep(0.1)  # 100ms 轮询

                if not self._speech_detected:
                    continue

                # 说话后，检查静默时长
                silence_ms = (time.time() - self._last_speech_time) * 1000
                if silence_ms >= SILENCE_DURATION_MS:
                    self.is_listening = False
                    log.info(f"VAD 检测到静默 ({silence_ms:.0f}ms)，停止聆听")
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
        """录音 → ASR（+TTS预热） → LLM流式 → 句子切分 → 流式TTS"""
        if len(self.pcm_buffer) < FRAME_SIZE * 2:
            log.info("音频太短，忽略")
            return

        # 未检测到有效语音 → 跳过（防止 Whisper 幻听）
        if not self._speech_detected:
            log.info("未检测到语音，跳过 ASR")
            return

        start = time.time()

        # 1. ASR + TTS 预热并行
        asr_task = asyncio.create_task(self._asr(self.pcm_buffer))
        warmup_task = asyncio.create_task(self.tts_pipe.warmup())
        text = await asr_task
        await warmup_task

        if not text:
            log.info("ASR 无结果")
            return
        asr_ms = (time.time() - start) * 1000
        log.info(f"ASR ({asr_ms:.0f}ms): {text}")

        await self.ws.send(json.dumps({
            "type": "stt", "text": text, "session_id": self.session_id,
        }))

        # 2. LLM 流式 + 句子切分 + 流式 TTS
        self.messages.append({"role": "user", "content": text})
        self.is_speaking = True
        self.abort_event.clear()

        # 通知设备 TTS 开始
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
                                llm_ms = (time.time() - start) * 1000
                                log.info(f"首句 ({llm_ms:.0f}ms): {sent}")
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

        # 处理剩余 buffer
        if sentence_buffer.strip() and not self.abort_event.is_set():
            await self.ws.send(json.dumps({
                "type": "tts", "state": "sentence_start",
                "text": sentence_buffer, "session_id": self.session_id,
            }))
            await self._speak_sentence(sentence_buffer)

        # 保存对话
        if reply_text:
            self.messages.append({"role": "assistant", "content": reply_text})
        if len(self.messages) > 10:
            self.messages = self.messages[-10:]

        self.is_speaking = False
        await self.tts_pipe.close()

        total_ms = (time.time() - start) * 1000
        log.info(f"总耗时: {total_ms:.0f}ms | 回复: {reply_text[:60]}")

        await self.ws.send(json.dumps({
            "type": "tts", "state": "stop", "session_id": self.session_id,
        }))

    def _split_sentences(self, text: str) -> list[str]:
        parts = SENTENCE_DELIMITERS.split(text)
        if len(parts) > 1:
            result = []
            pos = 0
            for part in parts[:-1]:
                end = pos + len(part)
                m = SENTENCE_DELIMITERS.search(text, end)
                if m:
                    result.append(text[pos:m.end()])
                    pos = m.end()
                else:
                    result.append(part)
                    pos = end
            result.append(text[pos:])
            return [r for r in result if r]

        if len(text) > MAX_BUFFER_LEN:
            parts = COMMA_DELIMITERS.split(text)
            if len(parts) > 1:
                result = []
                pos = 0
                for part in parts[:-1]:
                    end = pos + len(part)
                    m = COMMA_DELIMITERS.search(text, end)
                    if m:
                        result.append(text[pos:m.end()])
                        pos = m.end()
                    else:
                        result.append(part)
                        pos = end
                result.append(text[pos:])
                return [r for r in result if r]

        return [text]

    async def _speak_sentence(self, text: str):
        """流式 TTS 一句话"""
        text = EMOJI_PATTERN.sub("", text).strip()
        if not text:
            return
        pcm_remainder = bytearray()

        try:
            async for pcm_chunk in self.tts_pipe.speak(text):
                if self.abort_event.is_set():
                    break

                pcm_remainder.extend(pcm_chunk)

                while len(pcm_remainder) >= FRAME_BYTES:
                    if self.abort_event.is_set():
                        return
                    frame = bytes(pcm_remainder[:FRAME_BYTES])
                    pcm_remainder = pcm_remainder[FRAME_BYTES:]
                    encoded = self.opus_encoder.encode(frame, FRAME_SIZE)
                    await self.ws.send(encoded)
                    await asyncio.sleep(FRAME_MS / 1000 * 0.8)

            if pcm_remainder and not self.abort_event.is_set():
                frame = bytes(pcm_remainder) + b"\x00" * (FRAME_BYTES - len(pcm_remainder))
                encoded = self.opus_encoder.encode(frame, FRAME_SIZE)
                await self.ws.send(encoded)

        except Exception as e:
            log.error(f"TTS 发送失败: {e}")

    # ── ASR ──

    async def _asr(self, pcm_data: bytearray) -> Optional[str]:
        """语音识别 — FunASR SenseVoice（在线程池中运行避免阻塞）"""
        try:
            result = await asyncio.to_thread(self._asr_sync, bytes(pcm_data))
            return result
        except Exception as e:
            log.warning(f"ASR 失败: {e}")
            return None

    def _asr_sync(self, pcm_data: bytes) -> Optional[str]:
        """FunASR 同步识别"""
        import tempfile
        import wave

        wav_path = tempfile.mktemp(suffix=".wav")
        with wave.open(wav_path, "w") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm_data)

        res = _funasr_model.generate(input=wav_path, language="zh")
        if res and len(res) > 0:
            text = res[0].get("text", "")
            # SenseVoice 输出带语言标签，去掉
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
                    control_device, entity_id, args.get("action", "turn_on")
                )
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
    log.info(f"贾维斯语音后端启动: ws://{WS_HOST}:{WS_PORT}")
    async with serve(handler, WS_HOST, WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
