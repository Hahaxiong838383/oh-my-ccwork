"""Bilibili 源实现（Day-1 唯一真实可用源）

搜索：使用 bilibili-api-python (import bilibili_api) 的视频搜索接口，免登录。
解析：同样用 bilibili-api 的 Video.get_download_url(html5=True)（移动端 HTML5 播放流，
库文档原话"此时获得的媒体流访问无需鉴权"），不用 yt-dlp。

2026-07-04 生产 IP 真机验证记录：yt-dlp 对 bilibili 单视频网页解析（webpage scraping）
会被现时的 B 站反爬拒绝（HTTP 412，yt-dlp 官方 issue #16962/#16565/#16584 证实是普遍现象，
不是本项目特有问题）。但 bilibili-api 走的是官方 API 签名机制（WBI 签名，与搜索用的是
同一套，已验证长期稳定可用），`get_download_url(html5=True)` 这条"移动端免鉴权流"路径
完全不触发该拦截，生产 HK IP 首次请求即成功拿到直链。这是根治而非缓解——两条路径命中
的是 B 站不同的检测逻辑，网页抓取被限，官方签名 API 没事。
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
        """用 bilibili-api 的 html5=True 免鉴权流拿直链（2026-07-04 生产验证，见类 docstring）。

        流程：先 get_info() 拿 cid（分 P 标识，单 P 视频用第一个即可），
        再 get_download_url(cid=cid, html5=True) 拿 durl（mp4 muxed 直链，
        音频由下游 ffmpeg 解码时自然提取，浏览器 <audio> 也能直接播放视频容器的音轨）。
        保留短重试应对普通网络抖动（非 412 专用，那个问题已经不存在于这条路径）。
        """
        bvid = track_id

        async def _extract() -> str:
            from bilibili_api import video  # type: ignore

            v = video.Video(bvid=bvid)
            info = await v.get_info()
            cid = info["cid"]
            result = await v.get_download_url(cid=cid, html5=True)
            durl = result.get("durl")
            if not durl:
                raise RuntimeError(f"bilibili-api 未返回 durl（响应字段: {list(result.keys())}）")
            return durl[0]["url"]

        last_err: Exception | None = None
        for attempt in range(2):
            try:
                direct_url = await _extract()
                if not direct_url:
                    raise RuntimeError("bilibili-api 未返回可用的音频直链")
                return direct_url
            except Exception as e:
                last_err = e
                if attempt == 0:
                    logger.warning(f"bilibili resolve 第一次失败，重试一次 for {bvid}: {e}")
                    await asyncio.sleep(1)
                    continue
                break
        logger.warning(f"bilibili resolve failed for {bvid}: {last_err}")
        raise last_err  # type: ignore[misc]

    def download_headers(self) -> dict[str, str]:
        """B 站 CDN 签名直链校验 Referer（2026-07-04 生产验证：resolve 成功但下载
        403，加上这个头后通过）。"""
        return {
            "Referer": "https://www.bilibili.com/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
        }
