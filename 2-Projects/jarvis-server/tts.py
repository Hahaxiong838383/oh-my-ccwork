"""流式 TTS — 优先 MiniMax Speech 2.8，降级 Edge-TTS"""

import asyncio
import io
import edge_tts


async def edge_tts_stream(text: str, voice: str = "zh-CN-YunxiNeural") -> bytes:
    """Edge-TTS 生成音频（mp3 bytes）"""
    communicate = edge_tts.Communicate(text, voice, rate="+10%")
    audio_data = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data.write(chunk["data"])
    return audio_data.getvalue()


def tts_sync(text: str) -> bytes:
    """同步 TTS 接口"""
    return asyncio.run(edge_tts_stream(text))
