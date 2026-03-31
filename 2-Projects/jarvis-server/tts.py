"""流式 TTS — Edge-TTS + ffmpeg 管道，支持预热"""

import asyncio
import logging
import edge_tts
from typing import AsyncGenerator

log = logging.getLogger("jarvis")

SAMPLE_RATE = 16000
CHANNELS = 1


async def _start_ffmpeg():
    """启动 ffmpeg MP3→PCM 转码管道"""
    return await asyncio.create_subprocess_exec(
        "ffmpeg", "-y",
        "-f", "mp3", "-i", "pipe:0",
        "-ar", str(SAMPLE_RATE),
        "-ac", str(CHANNELS),
        "-f", "s16le",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )


class TTSPipeline:
    """
    TTS 管道，支持预热。

    预热：在 ASR 阶段预启动 ffmpeg 进程（~50ms），
    这样 LLM 出首句时 ffmpeg 已就绪，直接灌 MP3 数据。

    每次 speak() 用一个独立的 ffmpeg 进程。
    warmup() 预先创建下一个要用的进程。
    """

    def __init__(self, voice: str = "zh-CN-YunxiNeural"):
        self.voice = voice
        self._next_proc = None  # 预热好的进程

    async def warmup(self):
        """预启动 ffmpeg 进程，下次 speak() 直接使用"""
        if self._next_proc and self._next_proc.returncode is None:
            return
        self._next_proc = await _start_ffmpeg()
        log.info("TTS 管道预热完成")

    async def speak(self, text: str) -> AsyncGenerator[bytes, None]:
        """
        流式 TTS 一句话 → yield PCM chunks。
        如果有预热好的进程就复用，否则现场启动。
        """
        # 取预热好的进程，或现场启动
        if self._next_proc and self._next_proc.returncode is None:
            proc = self._next_proc
            self._next_proc = None
        else:
            proc = await _start_ffmpeg()

        async def feed_mp3():
            """Edge-TTS MP3 流 → ffmpeg stdin"""
            try:
                communicate = edge_tts.Communicate(text, self.voice, rate="+10%")
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio" and proc.stdin and not proc.stdin.is_closing():
                        proc.stdin.write(chunk["data"])
                        await proc.stdin.drain()
            except Exception as e:
                log.debug(f"TTS feed 异常: {e}")
            finally:
                if proc.stdin and not proc.stdin.is_closing():
                    proc.stdin.close()

        feeder = asyncio.create_task(feed_mp3())

        try:
            while True:
                data = await asyncio.wait_for(proc.stdout.read(4096), timeout=10)
                if not data:
                    break
                yield data
        except asyncio.TimeoutError:
            log.warning("TTS 读取超时")
        finally:
            feeder.cancel()
            try:
                await feeder
            except asyncio.CancelledError:
                pass
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    async def close(self):
        """清理预热的进程"""
        if self._next_proc and self._next_proc.returncode is None:
            self._next_proc.kill()
            await self._next_proc.wait()
        self._next_proc = None
