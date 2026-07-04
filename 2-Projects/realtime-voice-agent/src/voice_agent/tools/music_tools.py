"""用 LiveKit @function_tool 注册的音乐工具。

工具描述写明使用场景，方便 LLM 判断何时调用。
所有网络通过 MusicClient，不阻塞。
session_id 严格取自 ctx.session.room_io.room.name （真实 LiveKit room）。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from livekit.agents import RunContext, function_tool

from .music_client import MusicClient
from .music_playback import start_music_playback, stop_music_playback

logger = logging.getLogger("voice_agent.music.tools")


def _fmt_track(t: Any) -> str:
    if not isinstance(t, dict):
        return str(t)
    title = t.get("title") or t.get("name") or ""
    artist = t.get("artist") or ""
    dur = t.get("duration_sec") or t.get("duration")
    if dur:
        return f"{title} - {artist} ({dur}s)" if artist else f"{title} ({dur}s)"
    return f"{title} - {artist}" if artist else title or str(t)


def _safe_json(obj: Any) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:
        return str(obj)


def create_music_tools(client: MusicClient) -> list[Any]:
    """返回可直接传给 Agent(tools=...) 的 FunctionTool 列表。"""

    @function_tool
    async def music_search(ctx: RunContext[Any], query: str, limit: int = 5) -> str:
        """搜索音乐曲库。

        用户说"搜一下XXX"、"有没有XX的歌"、"找找周杰伦的歌"时调用。
        返回结果列表（id, title, artist, duration 等）。
        """
        sid = _get_session_id(ctx)
        res = await client.music_search(query, limit=limit, session_id=sid)
        if res.get("status") == "error":
            return f"搜索出错：{res.get('message', res)}"
        results = res.get("results") or res.get("data") or []
        if not results:
            return f"未搜索到与“{query}”相关的音乐。"
        lines = []
        for r in results[:limit]:
            lines.append(_fmt_track(r))
        return "搜索结果：\n" + "\n".join(lines) + "\n（可直接说“放第一首”或指定标题）"

    @function_tool
    async def music_play(ctx: RunContext[Any], query: str, mode: str = "track") -> str:
        """播放音乐。

        用户明确说“放一首XX”、“来一首XXX”、“播放晴天”、“点播周杰伦的歌”时调用此工具。
        不要先 search 再 play，直接用用户原始描述当 query 调 play 即可。
        mode 一般传 "track"。
        """
        sid = _get_session_id(ctx)
        res = await client.music_play(query, mode=mode, session_id=sid)
        status = res.get("status")

        if status == "playing":
            track = res.get("track") or {}
            url = res.get("stream_url")
            if url:
                base = client.base_url
                full = base.rstrip("/") + "/" + str(url).lstrip("/")
                # 后台拉流播放，不阻塞 tool 返回
                asyncio.create_task(
                    start_music_playback(ctx.session.room_io.room, full, client.api_key)
                )
            title = _fmt_track(track)
            alts = res.get("alternatives") or []
            if alts:
                alt_str = "；备选：" + "，".join(_fmt_track(a) for a in alts[:2])
            else:
                alt_str = ""
            return f"开始播放：{title}{alt_str}"
        if status == "ambiguous":
            cands = res.get("candidates") or []
            if not cands:
                return f"有多个匹配“{query}”，但未返回候选列表，请换个更具体的名字再说。"
            cand_lines = "、".join(_fmt_track(c) for c in cands[:4])
            return f"找到多首匹配“{query}”：{cand_lines}。请问你要哪一首？"
        if status == "not_found":
            return f"没有找到“{query}”相关的音乐。"
        if status == "error":
            return f"播放请求失败：{res.get('message', res)}"
        # 其他状态直接透传
        return _safe_json(res)

    @function_tool
    async def music_control(ctx: RunContext[Any], action: str, value: Any | None = None) -> str:
        """控制当前播放（暂停/继续/停止/调音量/切歌等）。

        用户说“暂停音乐”、“继续放”、“停止”、“下一首”、“调大点声音”、“静音”时调用。
        action 示例: pause, resume, stop, next, volume, seek。
        value 依 action 而定（如音量 0.8）。
        """
        sid = _get_session_id(ctx)
        res = await client.music_control(action, value=value, session_id=sid)
        # 客户端侧同步停止
        if action in {"stop", "pause"}:
            stop_music_playback(sid)
        if action == "resume":
            # resume 由 orchestrator 决定是否返回新 stream_url，这里不自动重启拉流
            pass
        st = res.get("status") or res.get("current_state") or res
        return f"控制结果：{st}"

    @function_tool
    async def music_queue(ctx: RunContext[Any], action: str, item: Any | None = None) -> str:
        """队列操作：add / remove / list / clear。

        用户说“把这首歌加到队列”、“清空播放列表”、“队列里有什么”时调用。
        """
        sid = _get_session_id(ctx)
        res = await client.music_queue(action, item=item, session_id=sid)
        q = res.get("queue") or res.get("data") or []
        if action == "list" or not action:
            if not q:
                return "当前队列为空。"
            return "队列：" + " -> ".join(_fmt_track(x) for x in q[:5])
        return f"队列操作({action})结果：{_safe_json(res)}"

    @function_tool
    async def music_status(ctx: RunContext[Any]) -> str:
        """查询当前播放状态（正在放哪首、队列、进度）。"""
        sid = _get_session_id(ctx)
        res = await client.music_status(session_id=sid)
        if res.get("status") == "error":
            return f"查询状态失败：{res.get('message')}"
        playing = res.get("playing")
        cur = res.get("current_track")
        q = res.get("queue") or []
        pos = res.get("position_sec")
        parts = []
        if playing and cur:
            parts.append(f"正在播放：{_fmt_track(cur)}")
        elif cur:
            parts.append(f"当前曲目：{_fmt_track(cur)}")
        else:
            parts.append("当前没有播放。")
        if pos is not None:
            parts.append(f"进度约 {pos}s")
        if q:
            parts.append("队列长度 " + str(len(q)))
        return "；".join(parts)

    return [music_search, music_play, music_control, music_queue, music_status]


def _get_session_id(ctx: RunContext[Any]) -> str:
    try:
        room = ctx.session.room_io.room
        name = getattr(room, "name", None)
        if name:
            return str(name)
    except Exception:
        logger.debug("无法从 room_io 取 room.name，回退空 session_id")
    return ""
