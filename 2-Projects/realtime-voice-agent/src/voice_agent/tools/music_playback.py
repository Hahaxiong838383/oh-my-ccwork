"""音乐流播放：拉取 stream_url 并发布为房间独立音频 track。

复用 fillers.py 中创建 rtc.AudioFrame 的模式 + LiveKit rtc publish 机制。
使用 ffmpeg 子进程把任意容器（mp3/aac/ogg 等）解码为 48kHz 单声道 PCM16 喂 AudioSource。
若无 ffmpeg，播放失败并记录，不炸主循环。

实现说明：
- 现有 "发布机制" 主要是 fillers 经 session.say(audio=) 走 agent 输出路径，或 TTS AudioEmitter。
- 这里为独立音乐 track（不走 agent 语音打断模型），用 publish_track + AudioSource 发布一路新 track。
- 采样率 48k 与 LiveKit 房间典型输出匹配；若将来需要精确对齐可调整。
- ffmpeg 作为系统级解码器（非 python 包依赖），常见于容器/服务器环境；缺失时优雅降级。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from livekit import rtc

logger = logging.getLogger("voice_agent.music.playback")

# 进程内活跃播放任务（按 room.name 即 session_id 索引）
_playback_tasks: dict[str, asyncio.Task[None]] = {}


def stop_music_playback(session_id: str) -> None:
    """停止指定 session 的音乐播放（取消任务 + 清理）。"""
    task = _playback_tasks.pop(session_id, None)
    if task and not task.done():
        task.cancel()


def stop_all_playback() -> None:
    """取消所有在跑的音乐播放任务。会话关闭（用户断开）时必须调，否则播放任务（流一首
    4 分钟的歌）不退出 → LiveKit "entrypoint did not exit in time" → 房间删不干净 →
    用户第二次连接进不去（2026-07-04 川哥实测复发根因）。"""
    for sid in list(_playback_tasks.keys()):
        task = _playback_tasks.pop(sid, None)
        if task and not task.done():
            task.cancel()


async def start_music_playback(
    room: Any,
    stream_url: str,
    api_key: str = "",
    *,
    http_timeout: float | None = None,
) -> None:
    """启动后台任务拉流并发布 track。立即返回，不阻塞 tool。"""
    sid = getattr(room, "name", None) or "unknown"
    # 停掉同一房间的前一个播放
    stop_music_playback(sid)

    task = asyncio.create_task(
        _run_playback(room, stream_url, api_key, sid, http_timeout=http_timeout),
        name=f"music-play-{sid}",
    )
    _playback_tasks[sid] = task

    # 后台跑，异常自己吞日志
    def _done(t: asyncio.Task[None]) -> None:
        _playback_tasks.pop(sid, None)
        if t.cancelled():
            return
        exc = t.exception()
        if exc:
            logger.warning("music playback task error: %s", exc)

    task.add_done_callback(_done)


async def _run_playback(
    room: Any,
    stream_url: str,
    api_key: str,
    sid: str,
    *,
    http_timeout: float | None = None,
) -> None:
    """实际执行：建 track、拉流、解码、推帧。"""
    source = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("music", source)
    pub = None
    try:
        pub = await room.local_participant.publish_track(track)
        logger.info("music track published: sid=%s url=%s", sid, stream_url[:64])
    except Exception:
        logger.exception("music publish_track 失败")
        return

    headers: dict[str, str] = {}
    if api_key:
        headers["X-Music-Key"] = api_key

    client_timeout = httpx.Timeout(http_timeout) if http_timeout else None
    try:
        async with httpx.AsyncClient(timeout=client_timeout) as http:
            async with http.stream("GET", stream_url, headers=headers or None) as resp:
                resp.raise_for_status()
                await _decode_stream_to_source(resp.aiter_bytes(), source)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("music stream playback failed (sid=%s): %s", sid, exc)
    finally:
        # 尝试 unpublish（失败静默）
        if pub is not None:
            with contextlib.suppress(Exception):
                await room.local_participant.unpublish_track(pub.sid)
        logger.info("music playback ended: sid=%s", sid)


async def _decode_stream_to_source(
    byte_iter: AsyncIterator[bytes], source: rtc.AudioSource
) -> None:
    """用 ffmpeg 把输入字节流解码为 s16le 48k mono，喂给 AudioSource。"""
    # 启动 ffmpeg 管道
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        logger.warning("ffmpeg 未找到，音乐播放不可用（请安装 ffmpeg）")
        # 耗尽输入避免客户端挂
        async for _ in byte_iter:
            pass
        return
    except Exception:
        logger.exception("启动 ffmpeg 失败")
        async for _ in byte_iter:
            pass
        return

    async def _feed_stdin() -> None:
        try:
            async for chunk in byte_iter:
                if proc.stdin and not proc.stdin.is_closing():
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
            if proc.stdin:
                proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    feeder = asyncio.create_task(_feed_stdin())

    # 20ms 帧粒度（常见 WebRTC 节奏）
    frame_bytes = int(48000 * 0.020) * 2  # 样本数 * 2bytes
    buf = bytearray()

    try:
        stdout = proc.stdout
        while True:
            if stdout is None:
                break
            chunk = await stdout.read(4096)
            if not chunk:
                # 刷尾
                if buf:
                    # 丢弃不足一帧的尾巴
                    pass
                break
            buf.extend(chunk)
            while len(buf) >= frame_bytes:
                data = bytes(buf[:frame_bytes])
                del buf[:frame_bytes]
                frame = rtc.AudioFrame(
                    data=data,
                    sample_rate=48000,
                    num_channels=1,
                    samples_per_channel=frame_bytes // 2,
                )
                await source.capture_frame(frame)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.debug("decode loop exit: %s", exc)
    finally:
        feeder.cancel()
        with contextlib.suppress(Exception):
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
        with contextlib.suppress(Exception):
            proc.kill()
        await proc.wait()
