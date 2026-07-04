"""Bilibili 源实现（Day-1 唯一真实可用源）

搜索：使用 bilibili-api-python (import bilibili_api) 的视频搜索接口，免登录。
解析：使用 yt-dlp 对 https://www.bilibili.com/video/{bvid} 提取 bestaudio 直链。
"""

import asyncio
import logging
from typing import Any

from app.sources.base import SearchResult, Source

logger = logging.getLogger(__name__)


class BilibiliSource:
    name = "bilibili"

    def __init__(self):
        # 延迟 import，避免未安装时整个服务启动失败
        self._search_func = None
        self._sync_search = None

    async def _ensure_imports(self):
        if self._search_func is not None:
            return
        # bilibili_api.search 提供 search_by_type 等接口
        from bilibili_api import search  # type: ignore

        self._search_func = search.search_by_type

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        await self._ensure_imports()

        try:
            # bilibili-api-python 的 search_by_type 是 async 的
            # search_type=SearchObjectType.VIDEO
            from bilibili_api.search import SearchObjectType  # type: ignore

            result = await self._search_func(  # type: ignore
                keyword=query,
                search_type=SearchObjectType.VIDEO,
                page=1,
            )
        except Exception as e:
            logger.warning(f"bilibili search failed for query={query}: {e}")
            raise

        items = result.get("result", []) if isinstance(result, dict) else []
        results: list[SearchResult] = []

        for item in items:
            if len(results) >= limit:
                break
            # 常见字段：bvid, title, author, duration, play
            bvid = item.get("bvid") or item.get("id")
            if not bvid:
                continue
            title = item.get("title", "").replace("<em class=\"keyword\">", "").replace("</em>", "")
            owner = item.get("owner")
            owner_name = owner.get("name", "") if isinstance(owner, dict) else ""
            artist = item.get("author") or owner_name or ""
            # duration 可能是 "03:45" 或秒数
            dur_raw = item.get("duration", 0)
            duration_sec = self._parse_duration(dur_raw)
            popularity = float(item.get("play", 0) or 0)

            results.append(
                SearchResult(
                    id=str(bvid),
                    source=self.name,
                    title=title,
                    artist=artist,
                    duration_sec=duration_sec,
                    popularity=popularity,
                )
            )

        return results

    def _parse_duration(self, dur: Any) -> float:
        if isinstance(dur, (int, float)):
            return float(dur)
        if isinstance(dur, str):
            parts = dur.split(":")
            try:
                if len(parts) == 2:
                    return int(parts[0]) * 60 + int(parts[1])
                if len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                return float(dur)
            except Exception:
                return 0.0
        return 0.0

    async def resolve(self, track_id: str) -> str:
        """使用 yt-dlp 提取 bilibili 音频直链。

        ⚠️ 已知风险（2026-07-04 真机验证发现，非本地代码 bug）：B 站近期收紧反爬，
        yt-dlp 对 bilibili 单视频解析会随机遇到 HTTP 412（"Request is blocked by
        server"），yt-dlp 官方 issue #16962/#16565/#16584（近1-2月新开）证实这是
        当前 B 站侧的普遍限制，非本项目特有问题；官方错误信息本身建议"加 cookies、
        等一下再试"。这里做两件事缓解（不能保证根治）：
        1. 配置 BILIBILI_SESSDATA 时带上 cookie（降低触发概率，非 100% 免疫）；
        2. 显式请求头 + 411/412 命中时短退避重试 2 次（该错误具有间歇性，issue
           原文描述"被封通常几分钟到几小时后自行恢复"）。
        重试耗尽仍失败会向上抛异常，交给 ranking 层的多源降级处理（这也是"三源
        分层不押注单源"这个架构决策在本次真机验证中被进一步印证的地方）。
        """
        bvid = track_id
        url = f"https://www.bilibili.com/video/{bvid}"

        def _extract() -> str:
            import yt_dlp  # type: ignore

            from app.config import config

            http_headers = {
                "Referer": "https://www.bilibili.com/",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
            }
            ydl_opts: dict = {
                "format": "bestaudio/best",
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "http_headers": http_headers,
            }
            if config.bilibili_sessdata:
                ydl_opts["http_headers"]["Cookie"] = f"SESSDATA={config.bilibili_sessdata}"
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                # 取最佳音频格式的 url
                if "url" in info:
                    return info["url"]
                formats = info.get("formats", [])
                # 优先选有 audio 且没有 video 的
                audio_formats = [
                    f for f in formats
                    if f.get("acodec") != "none" and (f.get("vcodec") in (None, "none") or f.get("vcodec") == "none")
                ]
                if not audio_formats:
                    # 退化到 bestaudio
                    audio_formats = [f for f in formats if f.get("acodec") != "none"]
                if not audio_formats:
                    # 最后退化
                    audio_formats = formats
                best = max(audio_formats, key=lambda f: f.get("abr") or f.get("tbr") or 0)
                return best["url"]

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                direct_url = await asyncio.to_thread(_extract)
                if not direct_url:
                    raise RuntimeError("yt-dlp 未返回可用的音频直链")
                return direct_url
            except Exception as e:
                last_err = e
                is_blocked = "412" in str(e) or "blocked" in str(e).lower()
                if is_blocked and attempt < 2:
                    wait_sec = 2 * (attempt + 1)
                    logger.warning(f"bilibili resolve 412/blocked for {bvid}, retry in {wait_sec}s (attempt {attempt + 1}/3)")
                    await asyncio.sleep(wait_sec)
                    continue
                break
        logger.warning(f"bilibili resolve failed for {bvid}: {last_err}")
        raise last_err  # type: ignore[misc]
