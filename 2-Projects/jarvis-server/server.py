#!/usr/bin/env python3
"""
贾维斯语音后端 v1 — 兼容小智 ESP32 WebSocket 协议

核心设计：
1. 全流式：ASR 出结果立即送 LLM，LLM 出第一句立即 TTS
2. 一次调用：MiniMax M2.7 function_call 一步完成意图+工具
3. VAD 打断：用户说话时停止当前 TTS

协议兼容：实现小智 ESP32 固件的 WebSocket hello/listen/audio 协议
"""

import asyncio
import json
import time
import logging
import opuslib
import struct
from typing import Optional

import websockets
from websockets.server import serve

from config import WS_HOST, WS_PORT
from llm import chat_stream
from ha import control_device, find_device, play_music, stop_music
from tts import tts_sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s [jarvis] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("jarvis")

# Opus 编解码
SAMPLE_RATE = 16000
CHANNELS = 1
FRAME_MS = 60
FRAME_SIZE = SAMPLE_RATE * FRAME_MS // 1000  # 960 samples


class JarvisSession:
    """一个设备连接的会话"""

    def __init__(self, ws):
        self.ws = ws
        self.device_id = "unknown"
        self.opus_decoder = opuslib.Decoder(SAMPLE_RATE, CHANNELS)
        self.opus_encoder = opuslib.Encoder(SAMPLE_RATE, CHANNELS, opuslib.APPLICATION_VOIP)
        self.pcm_buffer = bytearray()
        self.is_listening = False
        self.is_speaking = False
        self.messages = []  # 对话历史
        self.abort_flag = False

    async def handle(self):
        """主消息循环"""
        try:
            async for message in self.ws:
                if isinstance(message, str):
                    await self._handle_text(json.loads(message))
                else:
                    await self._handle_audio(message)
        except websockets.exceptions.ConnectionClosed:
            log.info(f"设备 {self.device_id} 断开")

    async def _handle_text(self, data: dict):
        msg_type = data.get("type", "")

        if msg_type == "hello":
            self.device_id = data.get("device_id", "unknown")
            log.info(f"设备连接: {self.device_id}")
            # 回复 hello
            await self.ws.send(json.dumps({
                "type": "hello",
                "version": 1,
                "transport": "websocket",
                "audio_params": {
                    "format": "opus",
                    "sample_rate": SAMPLE_RATE,
                    "channels": CHANNELS,
                    "frame_duration": FRAME_MS,
                },
            }))

        elif msg_type == "listen":
            state = data.get("state", "")
            if state == "start":
                self.is_listening = True
                self.pcm_buffer.clear()
                self.abort_flag = True  # 打断当前 TTS
                log.info("开始聆听")
            elif state == "stop":
                self.is_listening = False
                log.info("停止聆听")
                # 处理录音
                asyncio.create_task(self._process_audio())

        elif msg_type == "abort":
            self.abort_flag = True
            log.info("客户端打断")

    async def _handle_audio(self, data: bytes):
        """接收 Opus 音频帧"""
        if not self.is_listening:
            return
        try:
            pcm = self.opus_decoder.decode(data, FRAME_SIZE)
            self.pcm_buffer.extend(pcm)
        except Exception:
            pass

    async def _process_audio(self):
        """处理录音 → ASR → LLM → TTS"""
        if len(self.pcm_buffer) < FRAME_SIZE * 2:
            log.info("音频太短，忽略")
            return

        start = time.time()

        # ASR：用 Whisper/FunASR（当前用 FunASR 本地，后续可换）
        text = await self._asr(self.pcm_buffer)
        if not text:
            return
        asr_time = time.time() - start
        log.info(f"ASR ({asr_time*1000:.0f}ms): {text}")

        # 发送 STT 结果给设备
        await self.ws.send(json.dumps({"type": "stt", "text": text}))

        # LLM 流式处理
        self.messages.append({"role": "user", "content": text})
        self.is_speaking = True
        self.abort_flag = False

        reply_text = ""
        tool_executed = False

        for chunk_type, chunk_data in chat_stream(self.messages):
            if self.abort_flag:
                log.info("被打断，停止生成")
                break

            if chunk_type == "text":
                reply_text += chunk_data
                # 发送流式文本给设备显示
                await self.ws.send(json.dumps({"type": "tts", "state": "sentence_start", "text": chunk_data}))

            elif chunk_type == "tool_call":
                tool_result = await self._execute_tool(chunk_data)
                tool_executed = True
                # 工具执行结果作为回复
                if not reply_text:
                    reply_text = tool_result

        llm_time = time.time() - start - asr_time
        log.info(f"LLM ({llm_time*1000:.0f}ms): {reply_text[:50]}")

        # TTS
        if reply_text and not self.abort_flag:
            await self._speak(reply_text)

        # 保存对话
        if reply_text:
            self.messages.append({"role": "assistant", "content": reply_text})
        # 限制历史长度
        if len(self.messages) > 10:
            self.messages = self.messages[-10:]

        self.is_speaking = False
        total = time.time() - start
        log.info(f"总耗时: {total*1000:.0f}ms")

        # 通知设备 TTS 结束
        await self.ws.send(json.dumps({"type": "tts", "state": "stop"}))

    async def _asr(self, pcm_data: bytearray) -> Optional[str]:
        """语音识别 — 调用本地 FunASR 或 Whisper"""
        import tempfile, wave, subprocess

        # 保存为 WAV
        wav_path = tempfile.mktemp(suffix=".wav")
        with wave.open(wav_path, "w") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(bytes(pcm_data))

        # 调用 Whisper（Wyoming 服务在 10300 端口）
        try:
            from wyoming.client import AsyncTcpClient
            from wyoming.audio import AudioChunk, AudioStart, AudioStop
            from wyoming.asr import Transcribe, Transcript

            async with AsyncTcpClient("localhost", 10300) as client:
                await client.write_event(Transcribe(language="zh").event())
                await client.write_event(AudioStart(
                    rate=SAMPLE_RATE, width=2, channels=CHANNELS
                ).event())

                # 分块发送
                chunk_size = FRAME_SIZE * 2
                for i in range(0, len(pcm_data), chunk_size):
                    await client.write_event(AudioChunk(
                        rate=SAMPLE_RATE, width=2, channels=CHANNELS,
                        audio=bytes(pcm_data[i:i+chunk_size])
                    ).event())

                await client.write_event(AudioStop().event())

                while True:
                    event = await client.read_event()
                    if event is None:
                        break
                    if Transcript.is_type(event.type):
                        transcript = Transcript.from_event(event)
                        return transcript.text

        except Exception as e:
            log.warning(f"Wyoming ASR 失败: {e}，回退到 FunASR Docker")
            # 回退：调用小智后端的 FunASR
            return await self._asr_funasr(pcm_data)

        return None

    async def _asr_funasr(self, pcm_data: bytearray) -> Optional[str]:
        """回退 ASR：通过 HTTP 调用"""
        # 简单方案：把音频存文件，调用 whisper CLI
        import tempfile, wave, subprocess
        wav_path = tempfile.mktemp(suffix=".wav")
        with wave.open(wav_path, "w") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(bytes(pcm_data))

        try:
            result = subprocess.run(
                ["python3", "-c", f"""
import funasr
model = funasr.AutoModel(model="iic/SenseVoiceSmall", device="cpu")
res = model.generate(input="{wav_path}")
if res:
    print(res[0]["text"])
"""],
                capture_output=True, text=True, timeout=10,
            )
            return result.stdout.strip() or None
        except Exception:
            return None

    async def _execute_tool(self, tool_call: dict) -> str:
        """执行工具调用"""
        name = tool_call["name"]
        args = tool_call["arguments"]
        log.info(f"工具调用: {name}({args})")

        if name == "control_device":
            entity_id = find_device(args.get("device_name", ""))
            if entity_id:
                result = control_device(entity_id, args.get("action", "turn_on"))
                action_cn = "打开" if args.get("action") == "turn_on" else "关闭"
                return f"已{action_cn}{args.get('device_name', '')}" if "done" in result else f"操作失败"
            return "找不到该设备"

        elif name == "play_music":
            result = play_music(args.get("song", ""))
            return f"正在播放{args.get('song', '')}"

        elif name == "stop_music":
            stop_music()
            return "已停止播放"

        return "未知工具"

    async def _speak(self, text: str):
        """TTS + 发送 Opus 音频"""
        try:
            mp3_data = tts_sync(text)
            if not mp3_data:
                return

            # MP3 → PCM（用 ffmpeg）
            import subprocess, tempfile
            mp3_path = tempfile.mktemp(suffix=".mp3")
            with open(mp3_path, "wb") as f:
                f.write(mp3_data)

            result = subprocess.run(
                ["ffmpeg", "-y", "-i", mp3_path, "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
                capture_output=True, timeout=10,
            )
            pcm = result.stdout
            if not pcm:
                return

            # PCM → Opus 帧 → 发送
            frame_bytes = FRAME_SIZE * 2
            for i in range(0, len(pcm), frame_bytes):
                if self.abort_flag:
                    break
                frame = pcm[i:i + frame_bytes]
                if len(frame) < frame_bytes:
                    frame += b"\x00" * (frame_bytes - len(frame))
                encoded = self.opus_encoder.encode(frame, FRAME_SIZE)
                await self.ws.send(encoded)
                await asyncio.sleep(FRAME_MS / 1000 * 0.9)  # 略快于实时

        except Exception as e:
            log.error(f"TTS 失败: {e}")


async def handler(websocket):
    """WebSocket 连接处理"""
    session = JarvisSession(websocket)
    await session.handle()


async def main():
    log.info(f"贾维斯语音后端启动: ws://{WS_HOST}:{WS_PORT}")
    async with serve(handler, WS_HOST, WS_PORT):
        await asyncio.Future()  # 永远运行


if __name__ == "__main__":
    asyncio.run(main())
